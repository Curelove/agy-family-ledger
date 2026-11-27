/**
 * Antigravity 家庭组共享额度看板 · 核心纯函数计算引擎 (v1.3.0)
 *
 * 设计原则：
 * 1. 所有金额使用整数「分」（100 分 = 1.00 元），避免浮点精度误差。
 * 2. Gemini 池与 Claude / 第三方 3P 池分开核算与定价。
 * 3. 多人并发使用时，按「模型倍率 × 缓存折算等效单位」分摊当次官方总池下降量，
 *    并对单人可解释上限设置合理边界，防止未装插件设备的消耗转嫁给在线成员。
 * 4. 自动识别官方配额重置（含离线跨重置周期后的新周期首段消耗），绝不产生负数扣费。
 * 5. 未统计消耗预警采用滚动累计窗口，既能捕捉 90 秒心跳下的持续慢速偷跑，又避免单次小抖动误报。
 * 6. 全组使用约定（总池保留底线、单人周期参考上限、适用范围与补充说明）纳入同一套规则版本锁定机制，防暗改、防双标。
 */

export const SLICE_MS = 5 * 60 * 1000; // 5 分钟统计切片

export const DEFAULT_SETTINGS = {
  family_name: "家庭组共享额度看板",
  ledger_mode: "board_only", // 'board_only'（纯看板）| 'prepaid'（按量记账）
  rule_version: 1, // 规则版本号：每次修改记账方式、单价或全组使用约定自动 +1，成员端据此核对
  pricing_mode: "weekly_pct", // 'weekly_pct'（按周池百分比折算）| 'weighted_units'（按等效百万单位折算）
  gemini_fen_per_weekly_pct: 100, // Gemini 周池每消耗 1% = 1.00 元（仅 prepaid 模式生效）
  third_party_fen_per_weekly_pct: 180, // Claude 3P 周池每消耗 1% = 1.80 元
  gemini_fen_per_million_units: 80,
  third_party_fen_per_million_units: 200,
  default_low_balance_fen: 200,
  expected_units_per_pct_gemini: 400_000,
  expected_units_per_pct_3p: 250_000,
  // 全组共享使用约定（0 或空字符串表示不启用，不额外占用界面）
  pool_reserve_floor_pct: 0, // 总池保留底线（周剩余 %，例如 20 表示剩余降至 20% 时提醒暂停重任务）
  member_weekly_cap_pct: 0, // 单人本周期参考上限（%，例如双人组 50、三人组 30）
  apply_cap_to_owner: true, // 单人上限是否对组长本人同样生效（默认开启，成员侧边栏如实公示适用范围）
  restrict_3p_for_members: false, // 是否禁止普通成员使用 Claude 3P 池（开启后产生 3P 消耗即触发红框强警示与组长异常记录）
  usage_rule_note: "", // 可选补充文字约定（最多 180 字）
  // 未统计掉量滚动滤波阈值（0.5% 以上进入累计窗口，累计达到提醒线才告警）
  blackhole_min_single_drop_pct: 0.5,
  blackhole_window_minutes: 15,
  blackhole_warn_missing_pct: 5.0,
  blackhole_critical_missing_pct: 15.0,
  broadcast_blackhole_to_members: true, // 检测到未统计掉量异常时同步在全体组员侧边栏顶部公示提醒（组长标为已读后撤下）
  offline_grace_minutes: 12,
  calibration_dry_run: true, // 与 ledger_mode 保持同步，兼容旧数据
  quota_snapshot_authority: "owner_only", // 'owner_only' | 'all_members'
  show_peer_shares_to_members: true, // 允许成员看到组内各人的本周期与近 5 小时用量（不含余额与凭证）
};

/**
 * 归一化模型名称所属池子：'gemini' | '3p'
 */
export function classifyModelPool(modelName = "") {
  const s = String(modelName || "").trim().toLowerCase();
  if (!s) return "gemini";
  if (/gemini|gemma|\bneon\b|\bcarbon\b|\bhydrogen\b|\bargon\b|\bflash\b/.test(s)) {
    return "gemini";
  }
  if (
    /claude|opus|sonnet|haiku|anthropic|gpt|openai|\bo1\b|\bo3\b|\bo4\b|deepseek|qwen|llama|mistral|^3p/.test(
      s
    )
  ) {
    return "3p";
  }
  // 未知的非 Gemini 命名模型默认归入第三方 3P 池，避免新第三方模型漏归类
  return "3p";
}

/**
 * 获取模型消耗倍率（对齐 Antigravity 倍率：Carbon 3x、Opus 2x、Argon 1.5x、Sonnet 1.2x、Neon 1x、Hydrogen/Flash 0.7x）
 */
export function getModelMultiplier(modelName = "") {
  const s = String(modelName || "").toLowerCase();
  if (s.includes("carbon")) return 3.0;
  if (s.includes("opus")) return 2.0;
  if (s.includes("argon")) return 1.5;
  if (s.includes("sonnet")) return 1.2;
  if (s.includes("hydrogen") || s.includes("flash")) return 0.7;
  return 1.0;
}

/**
 * 计算单条请求的加权等效单位（输出权重更高，缓存命中权重较低）
 */
export function computeWeightedUnits({
  modelName = "",
  uncachedInputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  outputTokens = 0,
} = {}) {
  const uncached = Math.max(0, Number(uncachedInputTokens) || 0);
  const cacheRead = Math.max(0, Number(cacheReadTokens) || 0);
  const cacheWrite = Math.max(0, Number(cacheWriteTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  const base = uncached * 1.0 + cacheWrite * 1.25 + cacheRead * 0.1 + output * 4.0;
  return Math.round(base * getModelMultiplier(modelName) * 100) / 100;
}

/**
 * 把任意 UTC 毫秒时间戳对齐到 5 分钟切片起点
 */
export function alignSliceStartMs(tsMs = Date.now()) {
  const n = Number(tsMs);
  const safe = Number.isFinite(n) && n > 0 ? n : Date.now();
  return Math.floor(safe / SLICE_MS) * SLICE_MS;
}

/**
 * 根据 resetAt 推导稳定的周周期标识（reset:YYYY-MM-DD 或 ISO 周）
 */
export function deriveWeekBucket(resetAt = "", nowMs = Date.now()) {
  if (typeof resetAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(resetAt)) {
    return `reset:${resetAt.slice(0, 10)}`;
  }
  const d = new Date(nowMs);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + yearStart.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * 归一化百分比上限/底线值（0 表示不启用，最多保留 1 位小数）
 */
export function normalizePctLimit(val, max = 100) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const clamped = Math.min(max, Math.max(0, n));
  return Math.round(clamped * 10) / 10;
}

/**
 * 清洗全组补充约定文字（单行、最多 180 字）
 */
export function sanitizeUsageRuleNote(note = "") {
  return String(note ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 180);
}

/**
 * 纯标准 JS 同步短指纹（零 Node 专有依赖，Worker 与成员端算法完全一致，用于绑定码防暗改校验）
 */
export function computeRuleNoteHash(note = "") {
  const clean = sanitizeUsageRuleNote(note);
  if (!clean) return "";
  const bytes = new TextEncoder().encode(clean);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= bytes[i] ^ ((i * 31) & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0").slice(0, 4) + (h2 >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}

function fmtPctLabel(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? `${v}%` : `${v.toFixed(1)}%`;
}

/**
 * 格式化全组使用约定摘要（空表示未配置任何使用约定）
 */
export function formatUsageConventionSummary(settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const floor = normalizePctLimit(s.pool_reserve_floor_pct, 95);
  const cap = normalizePctLimit(s.member_weekly_cap_pct, 100);
  const applyOwner = s.apply_cap_to_owner !== false;
  const restrict3p = Boolean(s.restrict_3p_for_members);
  const note = sanitizeUsageRuleNote(s.usage_rule_note);

  const parts = [];
  if (floor > 0) {
    parts.push(`总池剩余 ${fmtPctLabel(floor)} 时暂停非紧急任务`);
  }
  if (cap > 0) {
    parts.push(`单人每周期上限 ${fmtPctLabel(cap)}（${applyOwner ? "全员同等适用" : "适用于普通成员"}）`);
  }
  if (restrict3p) {
    parts.push("普通成员仅限 Gemini 池（禁用 Claude 3P）");
  }
  if (note) {
    parts.push(`补充说明：${note.length > 40 ? note.slice(0, 40) + "…" : note}`);
  }
  return parts.join("；");
}

/**
 * 计算全组使用约定在当前水位与个人用量下的实时提醒状态
 */
export function evaluateUsageRulesStatus({
  settings = DEFAULT_SETTINGS,
  pools = {},
  weekSummary = {},
  role = "member",
  recent3pRequests = 0,
} = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const poolReserveFloorPct = normalizePctLimit(s.pool_reserve_floor_pct, 95);
  const memberWeeklyCapPct = normalizePctLimit(s.member_weekly_cap_pct, 100);
  const applyCapToOwner = s.apply_cap_to_owner !== false;
  const restrict3pForMembers = Boolean(s.restrict_3p_for_members);
  const usageRuleNote = sanitizeUsageRuleNote(s.usage_rule_note);
  const usageRuleNoteHash = computeRuleNoteHash(usageRuleNote);
  const hasUsageRules =
    poolReserveFloorPct > 0 || memberWeeklyCapPct > 0 || restrict3pForMembers || Boolean(usageRuleNote);

  const gemRemRaw = pools?.gemini?.weekly?.remainingPct;
  const p3RemRaw = pools?.["3p"]?.weekly?.remainingPct;
  const geminiRemainingPct = typeof gemRemRaw === "number" && Number.isFinite(gemRemRaw) ? gemRemRaw : null;
  const thirdPartyRemainingPct = typeof p3RemRaw === "number" && Number.isFinite(p3RemRaw) ? p3RemRaw : null;

  const geminiFloorReached =
    poolReserveFloorPct > 0 && geminiRemainingPct !== null && geminiRemainingPct <= poolReserveFloorPct;
  const thirdPartyFloorReached =
    poolReserveFloorPct > 0 && thirdPartyRemainingPct !== null && thirdPartyRemainingPct <= poolReserveFloorPct;

  const capApplies = memberWeeklyCapPct > 0 && (role !== "owner" || applyCapToOwner);
  const gUsed = Math.max(0, Number(weekSummary?.geminiPct || 0));
  const pUsed = Math.max(0, Number(weekSummary?.thirdPartyPct || 0));
  const nearThreshold = memberWeeklyCapPct * 0.85;

  const geminiReached = capApplies && gUsed >= memberWeeklyCapPct;
  const thirdPartyReached = capApplies && pUsed >= memberWeeklyCapPct;
  const geminiApproaching = capApplies && !geminiReached && gUsed >= nearThreshold;
  const thirdPartyApproaching = capApplies && !thirdPartyReached && pUsed >= nearThreshold;

  const p3ReqCount = Math.max(0, Math.round(Number(recent3pRequests) || 0));
  const restrictionApplies = restrict3pForMembers && role !== "owner";
  const thirdPartyViolated = restrictionApplies && (pUsed > 0 || p3ReqCount > 0);

  return {
    poolReserveFloorPct,
    memberWeeklyCapPct,
    applyCapToOwner,
    restrict3pForMembers,
    usageRuleNote,
    usageRuleNoteHash,
    hasUsageRules,
    summaryText: formatUsageConventionSummary(s),
    poolFloor: {
      geminiReached: geminiFloorReached,
      thirdPartyReached: thirdPartyFloorReached,
      anyReached: geminiFloorReached || thirdPartyFloorReached,
      geminiRemainingPct,
      thirdPartyRemainingPct,
    },
    memberCap: {
      capPct: memberWeeklyCapPct,
      applies: capApplies,
      geminiPct: gUsed,
      thirdPartyPct: pUsed,
      geminiReached,
      thirdPartyReached,
      geminiApproaching,
      thirdPartyApproaching,
      anyReached: geminiReached || thirdPartyReached,
      anyApproaching: geminiApproaching || thirdPartyApproaching,
    },
    poolRestriction: {
      restrict3pForMembers,
      applies: restrictionApplies,
      thirdPartyViolated,
      thirdPartyPct: pUsed,
      recent3pRequests: p3ReqCount,
    },
  };
}

/**
 * 格式化可读规则摘要（用于审计日志、邀请说明与成员端变更对比）
 */
export function formatPricingRuleSummary(settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const convSummary = formatUsageConventionSummary(s);
  let base = "";
  if (s.ledger_mode !== "prepaid") {
    base = convSummary ? "纯看板模式" : "纯看板模式（仅统计用量占比，不计费用）";
  } else if (s.pricing_mode === "weighted_units") {
    const gm = ((Number(s.gemini_fen_per_million_units) || 80) / 100).toFixed(2);
    const pm = ((Number(s.third_party_fen_per_million_units) || 200) / 100).toFixed(2);
    base = `按量记账模式（按等效单位：Gemini ¥${gm}/百万，3P ¥${pm}/百万）`;
  } else {
    const gYuan = ((Number(s.gemini_fen_per_weekly_pct) || 100) / 100).toFixed(2);
    const pYuan = ((Number(s.third_party_fen_per_weekly_pct) || 180) / 100).toFixed(2);
    base = `按量记账模式（Gemini ¥${gYuan}/1%，Claude 3P ¥${pYuan}/1%）`;
  }
  return convSummary ? `${base}｜约定：${convSummary}` : base;
}

/**
 * 判断两次配额水位快照之间是「正常消耗下降」还是「官方配额重置回升」
 * 返回：{ dropPct, isReset, resetJumpPct, postResetDropPct }
 * - 当检测到跨周期重置且新周期已经从 100% 消耗至 clampedNext（例如 82%）时，
 *   postResetDropPct 返回 18.0，便于把离线跨重置后的新周期真实消耗入账，不再蒸发。
 */
export function evaluateQuotaDelta(prevPct, nextPct, prevResetAt = "", nextResetAt = "") {
  const p = Number(prevPct);
  const n = Number(nextPct);
  if (!Number.isFinite(p) || !Number.isFinite(n)) {
    return { dropPct: 0, isReset: false, resetJumpPct: 0, postResetDropPct: 0 };
  }
  const clampedPrev = Math.max(0, Math.min(100, p));
  const clampedNext = Math.max(0, Math.min(100, n));

  const prevResetMs = prevResetAt ? Date.parse(prevResetAt) : NaN;
  const nextResetMs = nextResetAt ? Date.parse(nextResetAt) : NaN;
  const resetTimeShifted =
    Number.isFinite(prevResetMs) &&
    Number.isFinite(nextResetMs) &&
    nextResetMs - prevResetMs > 3600 * 1000;

  if (resetTimeShifted || clampedNext - clampedPrev > 2.0) {
    const postResetDropPct =
      clampedNext < 99.95 ? Math.round((100 - clampedNext) * 1000) / 1000 : 0;
    return {
      dropPct: 0,
      isReset: true,
      resetJumpPct: Math.round((clampedNext - clampedPrev) * 100) / 100,
      postResetDropPct,
    };
  }

  const rawDrop = clampedPrev - clampedNext;
  return {
    dropPct: rawDrop > 0 ? Math.round(rawDrop * 1000) / 1000 : 0,
    isReset: false,
    resetJumpPct: 0,
    postResetDropPct: 0,
  };
}

/**
 * 给定某次官方总池掉落百分比 `poolDropPct` 与当期未结算成员的 `weightedUnits` 列表，
 * 计算每个成员应分摊的百分比、费用（分）以及未解释的消耗差值百分比。
 *
 * memberUsages: Array<{ memberId, role, weightedUnits, acceptedRuleVersion? }>
 */
export function allocateSliceUsage({
  poolKey = "gemini",
  poolDropPct = 0,
  memberUsages = [],
  settings = DEFAULT_SETTINGS,
} = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const currentRuleVersion = Math.max(1, Number(cfg.rule_version) || 1);
  const drop = Math.max(0, Number(poolDropPct) || 0);
  const active = (Array.isArray(memberUsages) ? memberUsages : [])
    .map((m) => ({
      memberId: String(m.memberId || ""),
      role: m.role === "owner" ? "owner" : "member",
      weightedUnits: Math.max(0, Number(m.weightedUnits) || 0),
      acceptedRuleVersion:
        m.acceptedRuleVersion !== undefined ? Number(m.acceptedRuleVersion) : currentRuleVersion,
    }))
    .filter((m) => m.memberId && m.weightedUnits > 0);

  const totalUnits = active.reduce((sum, m) => sum + m.weightedUnits, 0);
  const unitPricePct =
    poolKey === "3p"
      ? Number(cfg.third_party_fen_per_weekly_pct) || 180
      : Number(cfg.gemini_fen_per_weekly_pct) || 100;
  const unitPriceMillion =
    poolKey === "3p"
      ? Number(cfg.third_party_fen_per_million_units) || 200
      : Number(cfg.gemini_fen_per_million_units) || 80;
  const expectedUnitsPerPct =
    poolKey === "3p"
      ? Number(cfg.expected_units_per_pct_3p) || 250_000
      : Number(cfg.expected_units_per_pct_gemini) || 400_000;

  if (drop > 0 && totalUnits <= 0) {
    return {
      allocations: [],
      unexplainedDropPct: Math.round(drop * 1000) / 1000,
      totalWeightedUnits: 0,
    };
  }

  // 防背锅上限：按上报等效单位推算合理可解释百分比（3.5x 弹性覆盖多模态/思考波动 + 0.8% 整数取整容差），
  // 杜绝某位成员只发了极少请求却替未装插件设备扛下 4%~9% 的异常掉量。
  const maxExplainablePct =
    totalUnits > 0 ? (totalUnits / Math.max(10_000, expectedUnitsPerPct)) * 3.5 + 0.8 : 0;
  const explainableDropPct = drop > 0 ? Math.min(drop, maxExplainablePct) : 0;
  const unexplainedDropPct =
    drop > explainableDropPct
      ? Math.round((drop - explainableDropPct) * 1000) / 1000
      : 0;

  const isPrepaidBilling =
    cfg.ledger_mode === "prepaid" || (cfg.ledger_mode === undefined && !cfg.calibration_dry_run);

  const allocations = active.map((m) => {
    const ratio = totalUnits > 0 ? m.weightedUnits / totalUnits : 0;
    const attributedPct = Math.round(explainableDropPct * ratio * 1000) / 1000;
    const ruleUnconfirmed = m.role !== "owner" && m.acceptedRuleVersion < currentRuleVersion;

    let chargeFen = 0;
    if (m.role !== "owner" && isPrepaidBilling && !cfg.calibration_dry_run && !ruleUnconfirmed) {
      if (cfg.pricing_mode === "weighted_units") {
        chargeFen = Math.round((m.weightedUnits / 1_000_000) * unitPriceMillion);
      } else {
        chargeFen = Math.round(attributedPct * unitPricePct);
      }
    }

    return {
      memberId: m.memberId,
      role: m.role,
      poolDropPct: Math.round(explainableDropPct * 1000) / 1000,
      shareRatio: Math.round(ratio * 10000) / 10000,
      attributedPct,
      weightedUnits: Math.round(m.weightedUnits * 100) / 100,
      unitPriceFenPerPct: unitPricePct,
      chargeFen,
      ruleUnconfirmed,
    };
  });

  return {
    allocations,
    unexplainedDropPct,
    totalWeightedUnits: Math.round(totalUnits * 100) / 100,
  };
}

/**
 * 滚动累计未统计消耗预警判定器
 * - 允许 0.5%+ 的 90 秒分片未解释缺口进入滚动缓冲，解决匀速慢速偷跑被单次 3% 门槛过滤的漏报问题；
 * - 仍要求累计缺口达到 warnPct（默认 5%）且满足持续性（>=2 次采样、跨度达标或单次突增 >= critPct），避免单次小抖动误报。
 */
export function evaluateBlackholeAlert({
  poolKey = "gemini",
  recentUnexplainedDrops = [],
  membersStatus = [],
  nowMs = Date.now(),
  settings = DEFAULT_SETTINGS,
} = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const winMs = Math.max(5, Number(cfg.blackhole_window_minutes) || 15) * 60 * 1000;
  const minSingle = Math.max(0.2, Number(cfg.blackhole_min_single_drop_pct) || 0.5);
  const warnPct = Math.max(2, Number(cfg.blackhole_warn_missing_pct) || 5.0);
  const critPct = Math.max(warnPct + 3, Number(cfg.blackhole_critical_missing_pct) || 15.0);
  const offlineGraceMs = Math.max(3, Number(cfg.offline_grace_minutes) || 12) * 60 * 1000;

  const validDrops = (Array.isArray(recentUnexplainedDrops) ? recentUnexplainedDrops : []).filter(
    (d) =>
      d &&
      Number.isFinite(d.capturedAtMs) &&
      nowMs - d.capturedAtMs <= winMs * 4 &&
      Number(d.missingPct) >= minSingle
  );
  if (validDrops.length === 0) return null;

  const totalMissingPct =
    Math.round(validDrops.reduce((s, d) => s + Number(d.missingPct || 0), 0) * 100) / 100;
  if (totalMissingPct < warnPct) return null;

  const earliestMs = Math.min(...validDrops.map((d) => d.capturedAtMs));
  const latestMs = Math.max(...validDrops.map((d) => d.capturedAtMs));
  const spanMs = latestMs - earliestMs;
  const sustained = spanMs >= winMs * 0.5 || validDrops.length >= 2 || totalMissingPct >= critPct;
  if (!sustained) return null;

  const list = Array.isArray(membersStatus) ? membersStatus : [];
  const offlineMembers = list.filter(
    (m) => !m.lastSeenAtMs || nowMs - m.lastSeenAtMs > offlineGraceMs
  );
  const allOnline = list.length > 0 && offlineMembers.length === 0;
  const poolLabel = poolKey === "3p" ? "Claude 3P 池" : "Gemini 池";

  if (allOnline && totalMissingPct >= critPct) {
    return {
      kind: "blackhole_critical",
      severity: "critical",
      poolKey,
      missingPct: totalMissingPct,
      title: `${poolLabel}出现较多未统计消耗（约 ${totalMissingPct}%）`,
      detail: `最近 ${Math.round(Math.max(spanMs, 60000) / 60000)} 分钟内，全组 ${list.length} 位活跃成员的插件均在线且本地上报消耗很低，但官方${poolLabel}总剩余额度下降了 ${totalMissingPct}%。可在群内确认是否有人在未安装插件的设备、命令行工具或第三方转发服务中使用了账号。`,
    };
  }

  const offlineNames = offlineMembers.map((m) => m.name).slice(0, 4).join("、");
  return {
    kind: "blackhole_warn",
    severity: "warning",
    poolKey,
    missingPct: totalMissingPct,
    title: `${poolLabel}存在未统计的额度消耗（约 ${totalMissingPct}%）`,
    detail: offlineNames
      ? `最近出现约 ${totalMissingPct}% 的额度下降未匹配到本地记录，当前有 ${offlineMembers.length} 位成员的插件未在线（${offlineNames}），可能是在未安装插件的设备上使用了账号。`
      : `最近出现约 ${totalMissingPct}% 的额度下降未匹配到本地记录，可能是官方配额刷新延迟，或某台设备尚未开启插件。`,
  };
}
