/**
 * Antigravity 熟人家庭组透明用量账本 · 核心纯函数计算引擎
 *
 * 设计原则：
 * 1. 所有金额使用整数「分」（100 分 = 1.00 元），杜绝浮点精度漂移。
 * 2. Gemini 池与 3P（Claude / GPT）池完全分开核算与定价。
 * 3. 多人并发使用同一 5 分钟切片时，按「模型倍率 × 缓存折算等效 Token」公平拆账。
 * 4. 自动识别官方配额重置（剩余百分比突增），绝不产生负数扣费。
 * 5. 黑洞预警采用三层防误报滤波：单次小波动过滤 + 15 分钟持续缺口校验 + 在线/离线分级定性。
 */

export const SLICE_MS = 5 * 60 * 1000; // 5 分钟统计切片

export const DEFAULT_SETTINGS = {
  family_name: "Ultra 20x 熟人家庭组",
  pricing_mode: "weekly_pct", // 'weekly_pct'（按每周总池%折算，推荐） | 'weighted_units'（按等效百万点折算）
  gemini_fen_per_weekly_pct: 100, // Gemini 周池每消耗 1% = 1.00 元（默认友情价，可随时在控制台调整）
  third_party_fen_per_weekly_pct: 180, // Claude 3P 周池每消耗 1% = 1.80 元
  gemini_fen_per_million_units: 80, // 备用按等效点计价：每 100 万加权点 = 0.80 元
  third_party_fen_per_million_units: 200,
  default_low_balance_fen: 200, // 默认低于 2.00 元提醒续充
  // 校准：大约多少加权 Token 约等于 1% 周池（用于无并发或黑洞核对参考；可通过试跑校准）
  expected_units_per_pct_gemini: 1_500_000,
  expected_units_per_pct_3p: 600_000,
  // 三层防误报黑洞阈值
  blackhole_min_single_drop_pct: 3.0, // 单次波动小于 3% 忽略（过滤延迟与缓存抖动）
  blackhole_window_minutes: 15, // 持续观察窗口（分钟）
  blackhole_warn_missing_pct: 5.0, // 15 分钟内累计未上报缺口 >= 5% 发黄色提醒
  blackhole_critical_missing_pct: 15.0, // 全员在线但半小时内凭空掉 >= 15% 发红色疑似反代警报
  offline_grace_minutes: 12, // 超过 12 分钟未上报心跳视为离线
  calibration_dry_run: true, // 默认开启「7天试跑校准期（只记账不扣余额）」，确认精准后一键切正式扣费
  quota_snapshot_authority: "owner_only", // 'owner_only'（仅组长设备可上报官方总池水位，防成员伪造水位）| 'all_members'
};

/**
 * 归一化模型名称所属池子：'gemini' | '3p'
 */
export function classifyModelPool(modelName = "") {
  const s = String(modelName || "").toLowerCase();
  if (!s) return "gemini";
  if (
    /claude|opus|sonnet|haiku|anthropic|gpt|openai|o1|o3|o4|^3p/.test(s)
  ) {
    return "3p";
  }
  return "gemini";
}

/**
 * 获取模型消耗倍率（对齐 Antigravity 官方倍率：Carbon 3x、Neon/Hydrogen/Flash 1x、Opus 2x）
 */
export function getModelMultiplier(modelName = "") {
  const s = String(modelName || "").toLowerCase();
  if (s.includes("carbon")) return 3.0;
  if (s.includes("opus")) return 2.0;
  if (s.includes("sonnet")) return 1.2;
  if (s.includes("argon")) return 1.5;
  if (s.includes("hydrogen") || s.includes("flash")) return 0.7;
  return 1.0; // neon 等默认 1x
}

/**
 * 计算单条请求的加权等效单位（与价格比例同构：输出更贵、缓存读取极便宜）
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
 * 根据 resetAt 推导稳定的周周期标识（YYYY-Wxx 或 reset ISO 日期）
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
 * 判断两次配额水位快照之间是「正常消耗下降」还是「官方配额重置回升」
 * 返回：{ dropPct, isReset, resetJumpPct }
 */
export function evaluateQuotaDelta(prevPct, nextPct, prevResetAt = "", nextResetAt = "") {
  const p = Number(prevPct);
  const n = Number(nextPct);
  if (!Number.isFinite(p) || !Number.isFinite(n)) {
    return { dropPct: 0, isReset: false, resetJumpPct: 0 };
  }
  const clampedPrev = Math.max(0, Math.min(100, p));
  const clampedNext = Math.max(0, Math.min(100, n));

  // 如果重置时间戳向后跳变，或剩余百分比明显反弹（> +2%），判定为官方重置事件
  const prevResetMs = prevResetAt ? Date.parse(prevResetAt) : NaN;
  const nextResetMs = nextResetAt ? Date.parse(nextResetAt) : NaN;
  const resetTimeShifted =
    Number.isFinite(prevResetMs) &&
    Number.isFinite(nextResetMs) &&
    nextResetMs - prevResetMs > 3600 * 1000;

  if (resetTimeShifted || clampedNext - clampedPrev > 2.0) {
    return {
      dropPct: 0,
      isReset: true,
      resetJumpPct: Math.round((clampedNext - clampedPrev) * 100) / 100,
    };
  }

  const rawDrop = clampedPrev - clampedNext;
  return {
    dropPct: rawDrop > 0 ? Math.round(rawDrop * 1000) / 1000 : 0,
    isReset: false,
    resetJumpPct: 0,
  };
}

/**
 * 给定某切片全组总池掉落百分比 `poolDropPct` 与各成员上报的 `weightedUnits` 列表，
 * 计算每个成员应分摊的百分比、费用（分）以及未解释的「黑洞缺口」百分比。
 *
 * memberUsages: Array<{ memberId, role, weightedUnits }>
 */
export function allocateSliceUsage({
  poolKey = "gemini",
  poolDropPct = 0,
  memberUsages = [],
  settings = DEFAULT_SETTINGS,
} = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const drop = Math.max(0, Number(poolDropPct) || 0);
  const active = (Array.isArray(memberUsages) ? memberUsages : [])
    .map((m) => ({
      memberId: String(m.memberId || ""),
      role: m.role === "owner" ? "owner" : "member",
      weightedUnits: Math.max(0, Number(m.weightedUnits) || 0),
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
      ? Number(cfg.expected_units_per_pct_3p) || 600_000
      : Number(cfg.expected_units_per_pct_gemini) || 1_500_000;

  // 若全组总池有明显掉落，但无人上报任何 Token（totalUnits === 0），则全部掉落归为未上报黑洞
  if (drop > 0 && totalUnits <= 0) {
    return {
      allocations: [],
      unexplainedDropPct: Math.round(drop * 1000) / 1000,
      totalWeightedUnits: 0,
    };
  }

  // 计算上报的 Token 最多能合理解释掉多少百分比：
  // 留足 10x 宽容系数 + 4% 缓冲，覆盖多模态读图、高强度思考与偶发缓存掉 0 场景，避免正常账目被误切出零头；
  // 仅当总池暴跌远超合理上限（如上报极少 Token 却凭空暴跌 15%+）时，溢出部分才记入未解释黑洞。
  const maxExplainablePct =
    totalUnits > 0 ? (totalUnits / Math.max(10_000, expectedUnitsPerPct)) * 10.0 + 4.0 : 0;
  const explainableDropPct = drop > 0 ? Math.min(drop, maxExplainablePct) : 0;
  const unexplainedDropPct =
    drop > explainableDropPct
      ? Math.round((drop - explainableDropPct) * 1000) / 1000
      : 0;

  const allocations = active.map((m) => {
    const ratio = totalUnits > 0 ? m.weightedUnits / totalUnits : 0;
    const attributedPct = Math.round(explainableDropPct * ratio * 1000) / 1000;

    let chargeFen = 0;
    if (m.role !== "owner" && !cfg.calibration_dry_run) {
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
    };
  });

  return {
    allocations,
    unexplainedDropPct,
    totalWeightedUnits: Math.round(totalUnits * 100) / 100,
  };
}

/**
 * 三层防误报黑洞预警判定器
 *
 * recentUnexplainedDrops: Array<{ capturedAtMs, missingPct }>
 * membersStatus: Array<{ id, name, role, lastSeenAtMs }>
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
  const minSingle = Math.max(0.5, Number(cfg.blackhole_min_single_drop_pct) || 3.0);
  const warnPct = Math.max(2, Number(cfg.blackhole_warn_missing_pct) || 5.0);
  const critPct = Math.max(warnPct + 3, Number(cfg.blackhole_critical_missing_pct) || 15.0);
  const offlineGraceMs = Math.max(3, Number(cfg.offline_grace_minutes) || 12) * 60 * 1000;

  // 第一层滤波：剔除过期记录和低于单次毛刺阈值的微小波动
  const validDrops = (Array.isArray(recentUnexplainedDrops) ? recentUnexplainedDrops : []).filter(
    (d) =>
      d &&
      Number.isFinite(d.capturedAtMs) &&
      nowMs - d.capturedAtMs <= winMs * 2 &&
      Number(d.missingPct) >= minSingle
  );
  if (validDrops.length === 0) return null;

  const totalMissingPct =
    Math.round(validDrops.reduce((s, d) => s + Number(d.missingPct || 0), 0) * 100) / 100;
  if (totalMissingPct < warnPct) return null;

  // 第二层滤波：确认并非单帧瞬时抖动（跨度达到窗口要求，或累计缺口已非常显著 >= critPct）
  const earliestMs = Math.min(...validDrops.map((d) => d.capturedAtMs));
  const latestMs = Math.max(...validDrops.map((d) => d.capturedAtMs));
  const spanMs = latestMs - earliestMs;
  const sustained = spanMs >= winMs * 0.5 || validDrops.length >= 2 || totalMissingPct >= critPct;
  if (!sustained) return null;

  // 第三层滤波：按「成员在线状态」区分“可能换设备忘开插件（黄警）”与“全员在线却凭空暴跌（红警疑似反代）”
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
      title: `${poolLabel}出现高危未上报消耗（约 ${totalMissingPct}%）`,
      detail: `最近 ${Math.round(Math.max(spanMs, 60000) / 60000)} 分钟内，全组 ${list.length} 位成员的记账插件均在线且本地上报消耗极低，但官方${poolLabel}总水位凭空下降了 ${totalMissingPct}%。建议先在熟人群核对是否有人在未装插件的设备、CLI 或第三方反代工具上使用了账号；确认违规后再由你本人手动处理，系统不会自动踢人。`,
    };
  }

  const offlineNames = offlineMembers.map((m) => m.name).slice(0, 4).join("、");
  return {
    kind: "blackhole_warn",
    severity: "warning",
    poolKey,
    missingPct: totalMissingPct,
    title: `${poolLabel}存在未归账缺口（约 ${totalMissingPct}%）`,
    detail: offlineNames
      ? `最近出现约 ${totalMissingPct}% 未上报消耗，当前有 ${offlineMembers.length} 位成员插件离线（${offlineNames}）。大概率是有人在未装插件的设备或临时退出了插件，建议群里顺口核对一下，不必紧张。`
      : `最近出现约 ${totalMissingPct}% 未上报消耗，低于红警阈值（${critPct}%），可能是官方结算延迟或某台未装插件的终端正在使用，建议留意观察。`,
  };
}

export function formatYuan(fen = 0) {
  const n = Number(fen) || 0;
  return (n / 100).toFixed(2);
}
