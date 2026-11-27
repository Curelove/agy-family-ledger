/**
 * 成员端零隐私侵入数据采集器 (v1.6.0 · Windows / macOS / Linux 全平台零依赖)
 *
 * 严格隐私与安全边界：
 * 1. 读取本机 Antigravity 会话日志 transcript.jsonl 时，仅读取顶层纯数字 Token 计数、模型名、步数索引与时间戳，
 *    绝不读取、存储或上传任何对话正文、思考过程或工具调用参数；会话 ID 经 SHA-256 短哈希脱敏。
 * 2. 多账号识别仅调用宿主 Sidecar 注入的 127.0.0.1 本地接口（GetUserStatus），在内存中即时计算域隔离
 *    SHA-256 短指纹（20 位 hex）与本地脱敏展示串（如 ali***@example.com），明文完整邮箱绝不落盘、绝不上传。
 * 3. 读取官方配额水位时，仅调用宿主 127.0.0.1 本地接口（RetrieveUserQuotaSummary），且仅在账号校验通过时上报。
 * 4. 零外部子进程调用，永不扫描本机进程、端口、注册表、凭据库、代理配置或任何工作区文件。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import tls from "node:tls";
import crypto from "node:crypto";

export const CLIENT_VERSION = "1.6.0";
const MAX_PENDING_QUEUE = 1500;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES_PER_POLL = 8 * 1024 * 1024;
const MAX_TRACKED_FILES = 2000;
const DISABLED_GAP_MS = 45_000;
const BOOT_GRACE_MS = 15_000;
const LS_SELF_HEAL_COOLDOWN_MS = 10 * 60 * 1000;

export const COLLECTION_STATES = {
  UNBOUND: "UNBOUND",
  ACTIVE_MATCH: "ACTIVE_MATCH",
  PAUSED_ACCOUNT_MISMATCH: "PAUSED_ACCOUNT_MISMATCH",
  PAUSED_MANUAL: "PAUSED_MANUAL",
  PAUSED_IDENTITY_UNAVAILABLE: "PAUSED_IDENTITY_UNAVAILABLE",
  BLOCKED_BY_SERVER: "BLOCKED_BY_SERVER",
};

function isLoopbackHost(hostname = "") {
  const h = String(hostname || "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

function isPrivateLanHost(hostname = "") {
  const h = String(hostname || "").toLowerCase();
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^0\.0\.0\.0$/.test(h)) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  return false;
}

function normalizePctLimit(val, max = 100) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const clamped = Math.min(max, Math.max(0, n));
  return Math.round(clamped * 10) / 10;
}

function sanitizeUsageRuleNote(note = "") {
  return String(note ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 180);
}

/**
 * 账号域隔离短指纹：sha256("agy-family-ledger:acct:v1:" + email.trim().toLowerCase()).slice(0, 20)
 */
export function computeAccountFingerprint(rawEmail = "") {
  const clean = String(rawEmail || "").trim().toLowerCase();
  if (!clean || !clean.includes("@")) return "";
  return crypto
    .createHash("sha256")
    .update(`agy-family-ledger:acct:v1:${clean}`, "utf8")
    .digest("hex")
    .slice(0, 20);
}

export function normalizeAccountHash(raw = "") {
  const clean = String(raw || "").trim().toLowerCase();
  return /^[0-9a-f]{20}$/.test(clean) ? clean : "";
}

/**
 * 本地界面脱敏邮箱显示（如 alice.demo@example.com -> ali***@example.com），严禁上传云端
 */
export function maskEmailForLocalDisplay(rawEmail = "") {
  const clean = String(rawEmail || "").trim().toLowerCase();
  const atIdx = clean.lastIndexOf("@");
  if (atIdx <= 0 || atIdx >= clean.length - 1) return "";
  const localPart = clean.slice(0, atIdx);
  const domain = clean.slice(atIdx + 1);
  const prefix = localPart.length <= 2 ? localPart.slice(0, 1) : localPart.slice(0, 3);
  return `${prefix}***@${domain}`;
}

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

export function formatAgreedRuleSummary(rules) {
  if (!rules || typeof rules !== "object") return "未记录初始约定";
  const floor = normalizePctLimit(rules.poolReserveFloorPct, 95);
  const cap = normalizePctLimit(rules.memberWeeklyCapPct, 100);
  const applyOwner = rules.applyCapToOwner !== false;
  const restrict3p = Boolean(rules.restrict3pForMembers);
  const note = sanitizeUsageRuleNote(rules.usageRuleNote);
  const noteHash = String(rules.usageRuleNoteHash || "").trim();

  const convParts = [];
  if (floor > 0) convParts.push(`总池剩余 ${fmtPctLabel(floor)} 时暂停非紧急任务`);
  if (cap > 0) convParts.push(`单人每周期上限 ${fmtPctLabel(cap)}（${applyOwner ? "全员同等适用" : "适用于普通成员"}）`);
  if (restrict3p) convParts.push("普通成员仅限 Gemini 池（禁用 Claude 3P）");
  if (note) convParts.push(`补充说明：${note.length > 40 ? note.slice(0, 40) + "…" : note}`);
  else if (noteHash) convParts.push("含文字补充约定");
  const convSummary = convParts.join("；");

  let base = "";
  if (rules.ledgerMode !== "prepaid") {
    base = convSummary ? "纯看板模式" : "纯看板模式（仅统计用量占比，不计费用）";
  } else {
    const g = ((Number(rules.geminiFenPerWeeklyPct) || 100) / 100).toFixed(2);
    const p = ((Number(rules.thirdPartyFenPerWeeklyPct) || 180) / 100).toFixed(2);
    base = `按量记账模式（Gemini ¥${g}/1%，Claude 3P ¥${p}/1%）`;
  }
  return convSummary ? `${base}｜约定：${convSummary}` : base;
}

/**
 * 构造含初始规则、全组使用约定与可选账号锁指纹的纯文本绑定码：
 * https://<domain>#<token>&v=<ruleVersion>&m=<board|prepaid>&g=<gemFen>&p=<3pFen>[&rf=<floor>&mc=<cap>&ao=<1|0>&r3p=<1>&nh=<hash>][&ah=<20hex>]
 */
export function buildInviteCode({
  serverUrl = "",
  memberToken = "",
  ruleVersion = 1,
  ledgerMode = "board_only",
  geminiFenPerWeeklyPct = 100,
  thirdPartyFenPerWeeklyPct = 180,
  poolReserveFloorPct = 0,
  memberWeeklyCapPct = 0,
  applyCapToOwner = true,
  restrict3pForMembers = false,
  usageRuleNote = "",
  targetAccountHash = "",
} = {}) {
  const cleanUrl = String(serverUrl || "").trim().replace(/\/+$/, "");
  const cleanToken = String(memberToken || "").trim();
  const modeShort = ledgerMode === "prepaid" ? "prepaid" : "board";
  const v = Math.max(1, Math.round(Number(ruleVersion) || 1));
  const g = Math.max(0, Math.round(Number(geminiFenPerWeeklyPct) || 100));
  const p = Math.max(0, Math.round(Number(thirdPartyFenPerWeeklyPct) || 180));
  const rf = normalizePctLimit(poolReserveFloorPct, 95);
  const mc = normalizePctLimit(memberWeeklyCapPct, 100);
  const ao = applyCapToOwner === false ? 0 : 1;
  const r3p = restrict3pForMembers ? 1 : 0;
  const nh = computeRuleNoteHash(usageRuleNote);
  const ah = normalizeAccountHash(targetAccountHash);

  let frag = `${cleanToken}&v=${v}&m=${modeShort}&g=${g}&p=${p}`;
  if (rf > 0 || mc > 0 || ao === 0 || r3p === 1 || nh) {
    frag += `&rf=${rf}&mc=${mc}&ao=${ao}`;
    if (r3p === 1) frag += `&r3p=1`;
    if (nh) frag += `&nh=${nh}`;
  }
  if (ah) {
    frag += `&ah=${ah}`;
  }
  return `${cleanUrl}#${frag}`;
}

/**
 * 解析单行纯文本绑定码（兼容旧版 https://域名#agf_xxxx、v1.2~v1.5 规则锁定与 v1.6 &ah= 账号指纹锁）
 * 安全约束：公网地址强制要求 https://，拦截私网 LAN 与非 loopback 的明文 http://
 */
export function parseInviteCode(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "请先粘贴绑定码" };
  const match = text.match(/(https?:\/\/[^\s#"'<>]+)#(agf_[A-Za-z0-9_]+)([^\s"'<>]*)/i);
  if (!match) {
    return {
      ok: false,
      error: "未识别到有效绑定码，完整格式应类似 https://域名#agf_xxxx",
    };
  }

  const rawServerUrl = match[1].replace(/\/+$/, "");
  const memberToken = match[2];
  const extraFrag = match[3] || "";

  let parsedUrl;
  try {
    parsedUrl = new URL(rawServerUrl);
  } catch {
    return { ok: false, error: "绑定码中的服务端网址格式不正确" };
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (isPrivateLanHost(host)) {
    return { ok: false, error: "出于安全限制，不允许绑定到内网或保留 IP 地址" };
  }
  if (parsedUrl.protocol === "http:" && !isLoopbackHost(host)) {
    return { ok: false, error: "出于安全限制，公网服务端地址必须使用 https:// 加密连接" };
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return { ok: false, error: "仅支持 https://（或本机调试 127.0.0.1）地址" };
  }

  let agreedRules = null;
  let targetAccountHash = "";
  if (extraFrag && extraFrag.includes("=")) {
    const params = new URLSearchParams(extraFrag.replace(/^[&?]+/, ""));
    const rawAh = params.get("ah");
    if (rawAh) {
      targetAccountHash = normalizeAccountHash(rawAh);
    }
    const rawV = Number(params.get("v"));
    const rawM = params.get("m");
    const rawG = Number(params.get("g"));
    const rawP = Number(params.get("p"));
    const rawRf = params.get("rf");
    const rawMc = params.get("mc");
    const rawAo = params.get("ao");
    const rawR3p = params.get("r3p");
    const rawNh = String(params.get("nh") || "").trim().toLowerCase();
    if (Number.isFinite(rawV) && rawV >= 1 && (rawM === "board" || rawM === "prepaid")) {
      agreedRules = {
        ruleVersion: Math.round(rawV),
        ledgerMode: rawM === "prepaid" ? "prepaid" : "board_only",
        geminiFenPerWeeklyPct: Number.isFinite(rawG) && rawG >= 0 ? Math.round(rawG) : 100,
        thirdPartyFenPerWeeklyPct: Number.isFinite(rawP) && rawP >= 0 ? Math.round(rawP) : 180,
        poolReserveFloorPct: rawRf !== null ? normalizePctLimit(rawRf, 95) : 0,
        memberWeeklyCapPct: rawMc !== null ? normalizePctLimit(rawMc, 100) : 0,
        applyCapToOwner: rawAo === "0" ? false : true,
        restrict3pForMembers: rawR3p === "1",
        usageRuleNote: "",
        usageRuleNoteHash: /^[0-9a-f]{8}$/.test(rawNh) ? rawNh : "",
        agreedAt: new Date().toISOString(),
        source: "invite_code",
      };
    }
  }

  return {
    ok: true,
    serverUrl: rawServerUrl,
    memberToken,
    agreedRules,
    targetAccountHash,
  };
}

export function evaluateRuleMismatch(agreedRules, memberView) {
  if (!memberView || !memberView.pricing || memberView.role === "owner") {
    return { mismatch: false };
  }
  const serverPricing = memberView.pricing;
  const serverVersion = Math.max(1, Number(serverPricing.ruleVersion) || 1);
  const serverNeedsConfirm = Boolean(memberView.needsRuleConfirm);
  const isBoardOnlyChange =
    serverPricing.ledgerMode !== "prepaid" && (!agreedRules || agreedRules.ledgerMode !== "prepaid");

  if (!agreedRules) {
    if (serverNeedsConfirm) {
      return {
        mismatch: true,
        isBoardOnlyChange,
        agreedRuleVersion: Number(memberView.acceptedRuleVersion || 1),
        serverRuleVersion: serverVersion,
        agreedSummary: "入组初始规则",
        currentSummary: serverPricing.summaryText || formatAgreedRuleSummary(serverPricing),
      };
    }
    return { mismatch: false };
  }

  const localVer = Math.max(1, Number(agreedRules.ruleVersion) || 1);
  const modeDiff = agreedRules.ledgerMode !== serverPricing.ledgerMode;
  const priceDiff =
    serverPricing.ledgerMode === "prepaid" &&
    (Number(agreedRules.geminiFenPerWeeklyPct) !== Number(serverPricing.geminiFenPerWeeklyPct) ||
      Number(agreedRules.thirdPartyFenPerWeeklyPct) !== Number(serverPricing.thirdPartyFenPerWeeklyPct));

  const localFloor = normalizePctLimit(agreedRules.poolReserveFloorPct, 95);
  const serverFloor = normalizePctLimit(serverPricing.poolReserveFloorPct, 95);
  const localCap = normalizePctLimit(agreedRules.memberWeeklyCapPct, 100);
  const serverCap = normalizePctLimit(serverPricing.memberWeeklyCapPct, 100);
  const localApplyOwner = agreedRules.applyCapToOwner !== false;
  const serverApplyOwner = serverPricing.applyCapToOwner !== false;
  const localRestrict3p = Boolean(agreedRules.restrict3pForMembers);
  const serverRestrict3p = Boolean(serverPricing.restrict3pForMembers);
  const localNoteHash =
    String(agreedRules.usageRuleNoteHash || "").trim() || computeRuleNoteHash(agreedRules.usageRuleNote || "");
  const serverNoteHash =
    String(serverPricing.usageRuleNoteHash || "").trim() || computeRuleNoteHash(serverPricing.usageRuleNote || "");

  const conventionDiff =
    localFloor !== serverFloor ||
    localCap !== serverCap ||
    (serverCap > 0 && localApplyOwner !== serverApplyOwner) ||
    localRestrict3p !== serverRestrict3p ||
    localNoteHash !== serverNoteHash;

  if (serverNeedsConfirm || modeDiff || priceDiff || conventionDiff || serverVersion > localVer) {
    return {
      mismatch: true,
      isBoardOnlyChange: !modeDiff && serverPricing.ledgerMode !== "prepaid",
      agreedRuleVersion: localVer,
      serverRuleVersion: serverVersion,
      agreedSummary: formatAgreedRuleSummary(agreedRules),
      currentSummary: serverPricing.summaryText || formatAgreedRuleSummary(serverPricing),
    };
  }
  return { mismatch: false };
}

export function getDefaultStatePath(env = process.env) {
  const geminiDir = String(env?.ANTIGRAVITY_GEMINI_DIR || "").trim() || path.join(os.homedir(), ".gemini");
  return path.join(geminiDir, "agy-family-ledger-member-state.json");
}

function normalizeRootKey(p) {
  const resolved = path.resolve(String(p || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 默认会话日志根目录：覆盖 antigravity/brain、antigravity-ide/brain 与 antigravity-cli/brain
 * 优先尊重 ANTIGRAVITY_GEMINI_DIR 与 ANTIGRAVITY_APP_DATA_DIR，支持隔离目录运行。
 */
export function getDefaultTranscriptRoots(env = process.env) {
  const home = os.homedir();
  const geminiDir = String(env?.ANTIGRAVITY_GEMINI_DIR || "").trim() || path.join(home, ".gemini");
  const appDataDir = String(env?.ANTIGRAVITY_APP_DATA_DIR || "").trim();
  const candidates = [];
  if (appDataDir) {
    candidates.push(path.join(appDataDir, "brain"));
  }
  candidates.push(
    path.join(geminiDir, "antigravity", "brain"),
    path.join(geminiDir, "antigravity-ide", "brain"),
    path.join(geminiDir, "antigravity-cli", "brain")
  );
  const seen = new Set();
  const out = [];
  for (const p of candidates) {
    const resolved = path.resolve(p);
    const key = normalizeRootKey(resolved);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

export function classifyModelPool(modelName = "") {
  const s = String(modelName || "").trim().toLowerCase();
  if (!s) return "gemini";
  if (/gemini|gemma|(?:^|[^a-z0-9])(neon|carbon|hydrogen|argon|flash|orchestrator)(?:$|[^a-z0-9])/.test(s)) {
    return "gemini";
  }
  if (
    /claude|opus|sonnet|haiku|anthropic|gpt[-_]?oss|gpt|openai|(?:^|[^a-z0-9])(o1|o3|o4)(?:$|[^a-z0-9])|deepseek|qwen|llama|mistral|^3p/.test(
      s
    )
  ) {
    return "3p";
  }
  return "3p";
}

function hashConvId(convId = "") {
  return crypto.createHash("sha256").update(String(convId || "local")).digest("hex").slice(0, 10);
}

/**
 * 提取单行 PLANNER_RESPONSE 的纯数值计量字段（严格只读取顶层数字、模型名、步数与时间戳）
 * - 精确区分合法 step_index（含 0）与缺失 undefined，结合零正文特征摘要 sig8（及缺失步数时的 lineOffset）生成幂等唯一 ID，
 *   彻底解决同会话回退重试产生重复 step_index 丢步与缺失 step_index 全部退化为 :s0 碰撞的问题。
 */
export function extractNumericUsageFromLine(line = "", convId = "", { lineOffset = 0 } = {}) {
  if (!line || !line.includes('"PLANNER_RESPONSE"')) return null;

  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || obj.type !== "PLANNER_RESPONSE") return null;

  const status = String(obj.status || "").toUpperCase();
  if (status !== "DONE" && status !== "CANCELLED" && status !== "ERROR") return null;

  const meta = obj.usage && typeof obj.usage === "object" ? obj.usage : obj;
  const numVal = (k) => {
    const v = Number(obj[k] ?? meta[k]);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  };

  const rawIdx = obj.step_index !== undefined ? obj.step_index : meta.step_index;
  const hasStepIdx =
    (typeof rawIdx === "number" || (typeof rawIdx === "string" && /^\d+$/.test(rawIdx))) &&
    Number.isSafeInteger(Number(rawIdx)) &&
    Number(rawIdx) >= 0;
  const stepIndex = hasStepIdx ? Number(rawIdx) : null;

  const modelName = String(obj.model || meta.model || "").trim().slice(0, 80);
  const createdAt = typeof obj.created_at === "string" ? obj.created_at : "";
  const inputTokens = numVal("input_tokens");
  const cacheReadTokens = numVal("cache_read_tokens");
  const cacheWriteTokens = numVal("cache_write_tokens");
  const thinkingTokens = numVal("thinking_tokens");
  const outputTokens = numVal("output_tokens") + thinkingTokens;

  // 对中断/报错步骤，仅当实际产生了非零 Token 消耗才计入
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) {
    return null;
  }
  const tsMs = createdAt ? Date.parse(createdAt) : Date.now();
  const shortHash = hashConvId(convId);
  const safeOffset = Number.isFinite(Number(lineOffset)) && Number(lineOffset) >= 0 ? Math.floor(Number(lineOffset)) : 0;
  const sigInput = `${createdAt}|${inputTokens}|${cacheReadTokens}|${cacheWriteTokens}|${outputTokens}|${modelName}|${hasStepIdx ? "" : safeOffset}`;
  const sig8 = crypto.createHash("sha256").update(sigInput, "utf8").digest("hex").slice(0, 8);
  const id = hasStepIdx ? `${shortHash}:s${stepIndex}:${sig8}` : `${shortHash}:ns:${sig8}`;

  return {
    id,
    poolKey: classifyModelPool(modelName),
    modelName,
    requestCount: 1,
    uncachedInputTokens: inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    timestampMs: Number.isFinite(tsMs) ? tsMs : Date.now(),
  };
}

/**
 * 读取 transcript 文件首行时间戳（用于区分「游标之前历史老对话」与「恢复后新建对话/子代理」）
 */
function peekConversationStartMs(logPath, stat) {
  let fd = null;
  try {
    fd = fs.openSync(logPath, "r");
    const head = Buffer.allocUnsafe(Math.min(1024, stat.size));
    const n = fs.readSync(fd, head, 0, head.length, 0);
    const firstStr = head.subarray(0, n).toString("utf8");
    const m = firstStr.match(/"created_at"\s*:\s*"([^"]{10,40})"/);
    if (m) {
      const parsed = Date.parse(m[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch {
    // 忽略读取异常
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) {
    return stat.birthtimeMs;
  }
  return stat.mtimeMs;
}

function inferKnownRootsFromOffsets(fileOffsets = {}) {
  const roots = new Set();
  for (const key of Object.keys(fileOffsets || {})) {
    const idx = key.indexOf(`${path.sep}.system_generated${path.sep}`);
    const altIdx = idx >= 0 ? idx : key.indexOf("/.system_generated/");
    if (altIdx > 0) {
      const convDir = key.slice(0, altIdx);
      const rootDir = path.dirname(convDir);
      if (rootDir) roots.add(normalizeRootKey(rootDir));
    }
  }
  return Array.from(roots);
}

function trimTrackedFileOffsets(stateObj) {
  const keys = Object.keys(stateObj.fileOffsets || {});
  if (keys.length > MAX_TRACKED_FILES) {
    for (const k of keys.slice(0, keys.length - Math.floor(MAX_TRACKED_FILES * 0.8))) {
      delete stateObj.fileOffsets[k];
    }
  }
}

/**
 * 静默快进所有活跃 transcript.jsonl 游标至当前文件末尾（st.size），绝不产生任何入队事件。
 * 用于非 ACTIVE_MATCH 暂停态持续快进、切回激活态前清尾、停摆窗口锚定与升级新增目录锚定。
 */
export function fastForwardTranscriptOffsets(
  stateObj = {},
  transcriptRoots = null,
  { nowMs = Date.now(), anchorBeforeMs = null, onlyUntracked = false, env = process.env } = {}
) {
  const dirs = Array.isArray(transcriptRoots) ? transcriptRoots : getDefaultTranscriptRoots(env);
  if (!stateObj.fileOffsets || typeof stateObj.fileOffsets !== "object") {
    stateObj.fileOffsets = {};
  }
  if (!Array.isArray(stateObj.knownRoots)) {
    stateObj.knownRoots = inferKnownRootsFromOffsets(stateObj.fileOffsets);
  }
  const knownSet = new Set(stateObj.knownRoots.map(normalizeRootKey));
  const cutoffMs = nowMs - 48 * 3600 * 1000;
  let anchoredCount = 0;

  for (const root of dirs) {
    const rootKey = normalizeRootKey(root);
    if (!knownSet.has(rootKey)) {
      knownSet.add(rootKey);
      stateObj.knownRoots.push(rootKey);
    }
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const logPath = path.join(root, ent.name, ".system_generated", "logs", "transcript.jsonl");
      let st;
      try {
        st = fs.statSync(logPath);
      } catch {
        continue;
      }
      if (!st.isFile() || st.mtimeMs < cutoffMs) continue;
      const key = logPath.toLowerCase();
      if (onlyUntracked && key in stateObj.fileOffsets) continue;
      if (anchorBeforeMs !== null) {
        const effectiveActivityMs =
          st.mtimeMs <= nowMs + 60_000 ? st.mtimeMs : peekConversationStartMs(logPath, st);
        if (effectiveActivityMs >= anchorBeforeMs) continue;
      }
      stateObj.fileOffsets[key] = st.size;
      anchoredCount++;
    }
  }

  trimTrackedFileOffsets(stateObj);
  return anchoredCount;
}

/**
 * 增量扫描本机 Antigravity 的 transcript.jsonl：
 * - 首次建档记录 installedAtMs / collectionCursorMs，旧对话锚定末尾不翻旧账；
 * - 升级后首次新增挂载的目录（不在 state.knownRoots 内），其下已有历史文件自动锚定至 st.size 不翻旧账；
 * - 新建对话与子代理（首行时间 >= cursorMs - 5s）从 offset=0 完整读取首轮与后续步骤；
 * - 流式扫描 0x0A 换行字节并精确记录每行起始字节偏移 lineStartPos，遇超 4MB 单行自动跳过不卡死。
 */
export function scanIncrementalTranscriptUsage(
  stateObj = {},
  transcriptRoots = null,
  { nowMs = Date.now(), env = process.env } = {}
) {
  const dirs = Array.isArray(transcriptRoots) ? transcriptRoots : getDefaultTranscriptRoots(env);

  if (!stateObj.fileOffsets || typeof stateObj.fileOffsets !== "object") {
    stateObj.fileOffsets = {};
  }
  if (!Number.isFinite(Number(stateObj.installedAtMs)) || Number(stateObj.installedAtMs) <= 0) {
    stateObj.installedAtMs = nowMs;
  }

  const hasExistingOffsets = Object.keys(stateObj.fileOffsets).length > 0;
  if (!Array.isArray(stateObj.knownRoots)) {
    if (hasExistingOffsets) {
      stateObj.knownRoots = inferKnownRootsFromOffsets(stateObj.fileOffsets);
    } else {
      stateObj.knownRoots = dirs.map(normalizeRootKey);
    }
  }
  const knownSet = new Set(stateObj.knownRoots.map(normalizeRootKey));

  const cursorMs = Math.max(
    Number(stateObj.installedAtMs) || 0,
    Number(stateObj.collectionCursorMs) || 0
  );
  const cutoffMs = nowMs - 48 * 3600 * 1000;
  const freshEvents = [];

  for (const root of dirs) {
    const rootKey = normalizeRootKey(root);
    const isNewlyMountedRoot = !knownSet.has(rootKey);
    if (isNewlyMountedRoot) {
      knownSet.add(rootKey);
      stateObj.knownRoots.push(rootKey);
    }

    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const convId = ent.name;
      const logPath = path.join(root, convId, ".system_generated", "logs", "transcript.jsonl");
      let st;
      try {
        st = fs.statSync(logPath);
      } catch {
        continue;
      }
      if (!st.isFile() || st.mtimeMs < cutoffMs) continue;

      const key = logPath.toLowerCase();
      let offset;
      if (!(key in stateObj.fileOffsets)) {
        if (isNewlyMountedRoot) {
          // 升级后首次挂载的新目录（如 antigravity-cli/brain）：已有历史文件统一锚定末尾不翻旧账
          stateObj.fileOffsets[key] = st.size;
          continue;
        }
        const startMs = peekConversationStartMs(logPath, st);
        if (startMs >= cursorMs - 5000) {
          offset = 0;
          stateObj.fileOffsets[key] = 0;
        } else {
          stateObj.fileOffsets[key] = st.size;
          continue;
        }
      } else {
        offset = Number(stateObj.fileOffsets[key] || 0);
        delete stateObj.fileOffsets[key];
        stateObj.fileOffsets[key] = offset;
      }

      if (st.size < offset) offset = 0;
      if (st.size === offset) continue;

      let fd = null;
      try {
        fd = fs.openSync(logPath, "r");
        let curPos = offset;
        let lineStartPos = offset;
        let scannedBytes = 0;
        const chunkBuf = Buffer.allocUnsafe(256 * 1024);
        let carryChunks = [];
        let carryLen = 0;
        let skippingOversized = false;

        while (curPos < st.size && scannedBytes < MAX_SCAN_BYTES_PER_POLL) {
          const toRead = Math.min(chunkBuf.length, st.size - curPos, MAX_SCAN_BYTES_PER_POLL - scannedBytes);
          const bytesRead = fs.readSync(fd, chunkBuf, 0, toRead, curPos);
          if (bytesRead <= 0) break;

          let sliceStart = 0;
          for (let i = 0; i < bytesRead; i++) {
            if (chunkBuf[i] === 0x0a) {
              const segLen = i - sliceStart;
              const lineEndPos = curPos + i + 1;
              if (skippingOversized) {
                skippingOversized = false;
                carryChunks = [];
                carryLen = 0;
              } else if (carryLen + segLen <= MAX_LINE_BYTES) {
                const segBuf = Buffer.from(chunkBuf.subarray(sliceStart, i));
                const fullBuf = carryChunks.length ? Buffer.concat([...carryChunks, segBuf]) : segBuf;
                const lineStr = fullBuf.toString("utf8").replace(/\r$/, "");
                const ev = extractNumericUsageFromLine(lineStr, convId, { lineOffset: lineStartPos });
                if (ev) freshEvents.push(ev);
                carryChunks = [];
                carryLen = 0;
              } else {
                carryChunks = [];
                carryLen = 0;
              }
              stateObj.fileOffsets[key] = lineEndPos;
              lineStartPos = lineEndPos;
              sliceStart = i + 1;
            }
          }

          if (sliceStart < bytesRead) {
            const remLen = bytesRead - sliceStart;
            if (!skippingOversized) {
              if (carryLen + remLen > MAX_LINE_BYTES) {
                skippingOversized = true;
                carryChunks = [];
                carryLen = 0;
              } else {
                carryChunks.push(Buffer.from(chunkBuf.subarray(sliceStart, bytesRead)));
                carryLen += remLen;
              }
            }
          }

          curPos += bytesRead;
          scannedBytes += bytesRead;
          if (skippingOversized && curPos < st.size) {
            stateObj.fileOffsets[key] = curPos;
          }
        }
      } catch {
        // 忽略并发写读取抖动，下一轮重试
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {}
        }
      }
    }
  }

  trimTrackedFileOffsets(stateObj);
  return freshEvents;
}

/**
 * 归一化官方 RetrieveUserQuotaSummary 响应：
 * 返回 { snapshots: Array<{ poolKey, windowKey, remainingPct, resetAt, capturedAtMs }>, hasSeparateArgonPool: boolean }
 */
export function parseQuotaSummaryResponse(resp, nowMs = Date.now()) {
  const root = resp?.response && typeof resp.response === "object" ? resp.response : resp || {};
  const buckets = [];

  if (Array.isArray(root.groups)) {
    for (const g of root.groups) {
      if (!g || !Array.isArray(g.buckets)) continue;
      for (const b of g.buckets) {
        if (b && typeof b === "object") buckets.push({ ...b, _groupName: g.displayName || "" });
      }
    }
  } else if (Array.isArray(root.buckets)) {
    for (const b of root.buckets) {
      if (b && typeof b === "object") buckets.push(b);
    }
  }

  const snapshots = [];
  const seen = new Set();
  let hasSeparateArgonPool = false;

  for (const b of buckets) {
    if (b.disabled === true) continue;
    const rawId = String(b.bucketId || "").toLowerCase();
    const gName = String(b._groupName || b.displayName || "").toLowerCase();
    if (rawId.includes("argon")) {
      hasSeparateArgonPool = true;
      continue;
    }

    const windowKey =
      b.window === "5h" || b.window === "weekly"
        ? b.window
        : rawId.endsWith("-5h")
        ? "5h"
        : rawId.endsWith("-weekly")
        ? "weekly"
        : "";
    if (!windowKey) continue;

    const poolKey = /claude|3p|third|anthropic|openai|gpt/.test(`${rawId} ${gName}`) ? "3p" : "gemini";
    const fracRaw =
      b.remainingFraction !== undefined
        ? b.remainingFraction
        : b.remaining?.remainingFraction;
    const frac = Number(fracRaw);
    if (!Number.isFinite(frac) || frac < 0 || frac > 1) continue;

    const dedupKey = `${poolKey}:${windowKey}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    snapshots.push({
      poolKey,
      windowKey,
      remainingPct: Math.round(frac * 10000) / 100,
      resetAt: typeof b.resetTime === "string" ? b.resetTime : null,
      capturedAtMs: nowMs,
    });
  }
  return { snapshots, hasSeparateArgonPool };
}

function parseLoopbackLsEndpoint(env = process.env) {
  const rawAddr = String(env?.ANTIGRAVITY_LS_ADDRESS || "").trim();
  const csrf = String(env?.ANTIGRAVITY_CSRF_TOKEN || "").trim();
  if (!rawAddr || !csrf) {
    return { ok: false, reason: "sidecar_env_unavailable" };
  }
  let port = 0;
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(rawAddr) ? rawAddr : `http://${rawAddr}`);
    if (!isLoopbackHost(parsed.hostname)) {
      return { ok: false, reason: "non_loopback_blocked" };
    }
    port = Number(parsed.port);
  } catch {
    return { ok: false, reason: "invalid_ls_address" };
  }
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, reason: "invalid_ls_port" };
  }
  return { ok: true, host: "127.0.0.1", port, csrf };
}

function postLocalLsRpc(endpoint, rpcPath, { timeoutMs = 5500 } = {}) {
  const body = JSON.stringify({});
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: endpoint.host,
        port: endpoint.port,
        method: "POST",
        path: rpcPath,
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": endpoint.csrf,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, statusCode: res.statusCode || 0, code: "", reason: `http_${res.statusCode}`, data: null });
            return;
          }
          try {
            const parsed = JSON.parse(chunks || "{}");
            resolve({ ok: true, statusCode: 200, code: "", reason: "", data: parsed });
          } catch {
            resolve({ ok: false, statusCode: 200, code: "", reason: "parse_error", data: null });
          }
        });
      }
    );
    req.on("error", (err) =>
      resolve({ ok: false, statusCode: 0, code: String(err?.code || ""), reason: err?.code || err?.message || "rpc_error", data: null })
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, code: "ETIMEDOUT", reason: "timeout", data: null });
    });
    req.end(body);
  });
}

function extractAccountTierFromUserStatus(us = {}) {
  const tierObj = us?.userTier && typeof us.userTier === "object" ? us.userTier : {};
  const tierStr = `${tierObj.id || ""} ${tierObj.name || ""} ${typeof us?.userTier === "string" ? us.userTier : ""}`.toLowerCase();
  if (tierStr.includes("ultra")) return "ultra";
  if (tierStr.includes("pro")) return "pro";
  if (tierStr.includes("free") || tierStr.includes("individual") || tierStr.includes("standard")) return "free";

  const planStr = `${us?.planStatus?.planInfo?.planName || ""} ${us?.planStatus?.planInfo?.teamsTier || ""}`.toLowerCase();
  if (planStr.includes("ultra")) return "ultra";
  if (planStr.includes("pro")) return "pro";
  if (planStr.includes("free")) return "free";
  return "";
}

/**
 * 通过官方 Sidecar 注入的 127.0.0.1 本地接口读取当前登录账号身份（纯内存即时哈希与脱敏，绝不返回明文邮箱）
 */
export async function fetchLocalUserStatus(env = process.env) {
  const ep = parseLoopbackLsEndpoint(env);
  if (!ep.ok) {
    return {
      ok: false,
      statusCode: 0,
      code: "",
      reason: ep.reason,
      loggedIn: false,
      accountHash: "",
      accountMasked: "",
      accountTier: "",
    };
  }
  const rpc = await postLocalLsRpc(ep, "/exa.language_server_pb.LanguageServerService/GetUserStatus", {
    timeoutMs: 5000,
  });
  if (!rpc.ok) {
    return {
      ok: false,
      statusCode: rpc.statusCode,
      code: rpc.code,
      reason: rpc.reason,
      loggedIn: false,
      accountHash: "",
      accountMasked: "",
      accountTier: "",
    };
  }

  const root = rpc.data && typeof rpc.data === "object" ? rpc.data : {};
  const us = root.userStatus || root.response?.userStatus || root || {};
  const rawEmail = String(us.email || us.userEmail || "").trim();
  const accountHash = computeAccountFingerprint(rawEmail);
  const accountMasked = maskEmailForLocalDisplay(rawEmail);
  const accountTier = extractAccountTierFromUserStatus(us);

  return {
    ok: true,
    statusCode: 200,
    code: "",
    reason: "",
    loggedIn: Boolean(accountHash),
    accountHash,
    accountMasked,
    accountTier,
  };
}

/**
 * 通过官方 Sidecar 注入的 127.0.0.1 环境变量只读拉取当前配额水位（零进程扫描、跨平台兼容）
 */
export async function fetchLocalQuotaSnapshots(env = process.env) {
  const ep = parseLoopbackLsEndpoint(env);
  if (!ep.ok) {
    return { ok: false, statusCode: 0, code: "", reason: ep.reason, snapshots: [], hasSeparateArgonPool: false };
  }
  const rpc = await postLocalLsRpc(ep, "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary", {
    timeoutMs: 6000,
  });
  if (!rpc.ok) {
    return {
      ok: false,
      statusCode: rpc.statusCode,
      code: rpc.code,
      reason: rpc.reason,
      snapshots: [],
      hasSeparateArgonPool: false,
    };
  }
  const parsed = parseQuotaSummaryResponse(rpc.data, Date.now());
  return {
    ok: true,
    statusCode: 200,
    code: "",
    reason: "",
    snapshots: parsed.snapshots,
    hasSeparateArgonPool: parsed.hasSeparateArgonPool,
  };
}

/**
 * 纯文件系统单实例租约锁（零子进程、零强杀外部进程）：
 * 新 Sidecar 启动声明所有权后，旧残留实例通过 fs.watch 或定时复核发现失锁后立即自行停表退出。
 */
export class SidecarLease {
  constructor({ leasePath = "", dataDir = "", env = process.env, pollIntervalMs = 5000 } = {}) {
    const baseDir =
      dataDir ||
      String(env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR || "").trim() ||
      path.join(os.homedir(), ".gemini", "antigravity", "sidecar_data", "agy-family-ledger", "ledger", "data");
    this.leasePath = leasePath || path.join(baseDir, "active-sidecar.json");
    this.pollIntervalMs = Math.max(500, Number(pollIntervalMs) || 5000);
    this.token = "";
    this._lost = false;
    this._lostNotified = false;
    this._watcher = null;
    this._timer = null;
    this._onLostCallbacks = [];
  }

  acquire() {
    this.token = crypto.randomBytes(12).toString("hex");
    this._lost = false;
    this._lostNotified = false;
    writeJsonAtomic(this.leasePath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: this.token,
    });
    return this.token;
  }

  _emitLostOnce() {
    if (this._lostNotified) return;
    this._lost = true;
    this._lostNotified = true;
    const cbs = this._onLostCallbacks.splice(0);
    this.stop();
    for (const fn of cbs) {
      try {
        fn();
      } catch {}
    }
  }

  isOwner() {
    if (!this.token) return false;
    if (this._lost) {
      if (!this._lostNotified && this._onLostCallbacks.length > 0) this._emitLostOnce();
      return false;
    }
    try {
      if (!fs.existsSync(this.leasePath)) {
        this._emitLostOnce();
        return false;
      }
      const raw = fs.readFileSync(this.leasePath, "utf8").replace(/^\uFEFF/, "");
      if (!raw.trim()) return true;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === "string" && parsed.token !== this.token) {
        this._emitLostOnce();
        return false;
      }
      return parsed?.token === this.token;
    } catch {
      // 短暂文件重命名抖动时不误杀，下一轮复核
      return !this._lost;
    }
  }

  _notifyLostIfNeeded() {
    if (!this.token || this._lostNotified) return;
    if (this._lost || !this.isOwner()) {
      this._emitLostOnce();
    }
  }

  watchOwnership(onLost) {
    if (typeof onLost === "function") {
      this._onLostCallbacks.push(onLost);
    }
    if (this._lost) {
      this._emitLostOnce();
      return;
    }
    if (!this._watcher) {
      try {
        fs.mkdirSync(path.dirname(this.leasePath), { recursive: true });
        this._watcher = fs.watch(path.dirname(this.leasePath), (_evt, filename) => {
          if (!filename || String(filename).includes(path.basename(this.leasePath))) {
            this._notifyLostIfNeeded();
          }
        });
        if (typeof this._watcher.unref === "function") this._watcher.unref();
        this._watcher.on("error", () => {});
      } catch {
        this._watcher = null;
      }
    }
    if (!this._timer) {
      this._timer = setInterval(() => this._notifyLostIfNeeded(), this.pollIntervalMs);
      if (typeof this._timer.unref === "function") this._timer.unref();
    }
  }

  stop() {
    if (this._watcher) {
      try {
        this._watcher.close();
      } catch {}
      this._watcher = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

/**
 * 零依赖 HTTPS POST（支持自动识别 HTTPS_PROXY / HTTP_PROXY 或配置项 proxyUrl 通过 HTTP CONNECT 隧道出网）
 */
async function postJsonRequest(endpoint, headers = {}, bodyObj = {}, { proxyUrl = "", timeoutMs = 12000 } = {}) {
  const target = new URL(endpoint);
  const rawBody = JSON.stringify(bodyObj);
  const envProxy =
    proxyUrl ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    "";

  if (!envProxy || isLoopbackHost(target.hostname) || target.protocol !== "https:") {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  }

  let proxy;
  try {
    proxy = new URL(envProxy);
  } catch {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  }

  const targetPort = Number(target.port || 443);
  const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  const proxyAuth =
    proxy.username || proxy.password
      ? "Basic " + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")
      : "";

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { connectReq.destroy(); } catch {}
      reject(new Error("经代理连接云端超时"));
    }, timeoutMs);

    const connectReq = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: {
        Host: `${target.hostname}:${targetPort}`,
        ...(proxyAuth ? { "Proxy-Authorization": proxyAuth } : {}),
      },
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败 (HTTP ${res.statusCode})`));
        return;
      }
      const tlsSock = tls.connect({ socket, servername: target.hostname }, () => {
        const reqLines = [
          `POST ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.host}`,
          `Connection: close`,
          `Content-Length: ${Buffer.byteLength(rawBody)}`,
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          "",
          "",
        ].join("\r\n");
        tlsSock.write(reqLines + rawBody);
      });

      const chunks = [];
      tlsSock.on("data", (d) => chunks.push(d));
      tlsSock.on("end", () => {
        clearTimeout(timer);
        try {
          const full = Buffer.concat(chunks).toString("utf8");
          const sepIdx = full.indexOf("\r\n\r\n");
          const headPart = sepIdx >= 0 ? full.slice(0, sepIdx) : full;
          let bodyPart = sepIdx >= 0 ? full.slice(sepIdx + 4) : "";
          const statusMatch = headPart.match(/^HTTP\/\d\.\d\s+(\d+)/);
          const statusCode = statusMatch ? Number(statusMatch[1]) : 500;
          if (/transfer-encoding:\s*chunked/i.test(headPart)) {
            let decoded = "";
            let pos = 0;
            while (pos < bodyPart.length) {
              const rn = bodyPart.indexOf("\r\n", pos);
              if (rn < 0) break;
              const size = parseInt(bodyPart.slice(pos, rn).trim(), 16);
              if (!Number.isFinite(size) || size <= 0) break;
              decoded += bodyPart.slice(rn + 2, rn + 2 + size);
              pos = rn + 2 + size + 2;
            }
            bodyPart = decoded;
          }
          const data = bodyPart.trim() ? JSON.parse(bodyPart) : {};
          resolve({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, data });
        } catch (err) {
          reject(err);
        }
      });
      tlsSock.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    connectReq.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    connectReq.end();
  });
}

function summarizeEventForUi(ev = {}) {
  return {
    poolKey: ev.poolKey === "3p" ? "3p" : "gemini",
    modelName: String(ev.modelName || "").slice(0, 80),
    requestCount: Math.max(1, Math.round(Number(ev.requestCount) || 1)),
    timestampMs: Number.isFinite(Number(ev.timestampMs)) ? Number(ev.timestampMs) : 0,
  };
}

function isLsHardDisconnect(res = {}) {
  if (!res || res.ok) return false;
  if (Number(res.statusCode) === 401) return true;
  if (String(res.code || "").toUpperCase() === "ECONNREFUSED") return true;
  return /ECONNREFUSED|http_401/i.test(String(res.reason || ""));
}

function stateToClientStatus(collectionState) {
  if (collectionState === COLLECTION_STATES.PAUSED_ACCOUNT_MISMATCH) return "paused_account_mismatch";
  if (collectionState === COLLECTION_STATES.PAUSED_MANUAL) return "paused_manual";
  if (collectionState === COLLECTION_STATES.PAUSED_IDENTITY_UNAVAILABLE) return "paused_identity_unavailable";
  return "active";
}

export class MemberLedgerCollector {
  constructor({
    configPath,
    defaultConfigPath,
    statePath = null,
    transcriptRoots = null,
    env = process.env,
    nowFn = () => Date.now(),
    fetchUserStatusImpl = null,
    fetchQuotaSnapshotsImpl = null,
    onSelfHealRequested = null,
    leaseCheckFn = null,
  }) {
    this.configPath = configPath;
    this.defaultConfigPath = defaultConfigPath;
    this.env = env || process.env;
    this.nowFn = typeof nowFn === "function" ? nowFn : () => Date.now();
    this.statePath = statePath || getDefaultStatePath(this.env);
    this.transcriptRoots = transcriptRoots;
    this.fetchUserStatusImpl = fetchUserStatusImpl;
    this.fetchQuotaSnapshotsImpl = fetchQuotaSnapshotsImpl;
    this.onSelfHealRequested = typeof onSelfHealRequested === "function" ? onSelfHealRequested : null;
    this.leaseCheckFn = typeof leaseCheckFn === "function" ? leaseCheckFn : () => true;

    this._bootStartMs = this.nowFn();
    this._configMtimeMs = 0;
    this._syncInFlight = null;
    this._guardInFlight = null;
    this._isSyncing = false;
    this._consecutiveIdentityFailures = 0;
    this._consecutiveLsHardFailures = 0;
    this._pendingRebindFlag = false;
    this._lsSelfHealTriggeredThisSession = false;
    this._currentIdentity = {
      ok: false,
      loggedIn: false,
      accountHash: "",
      accountMasked: "",
      accountTier: "",
      reason: "",
    };

    this.config = this.loadConfig();
    const nowMs = this.nowFn();
    const stateExisted = fs.existsSync(this.statePath);
    this.state = readJsonSafe(this.statePath, {
      installedAtMs: nowMs,
      collectionCursorMs: nowMs,
      lastWatchdogAtMs: 0,
      lastLsSelfHealAtMs: 0,
      deviceId: `dev_${crypto.randomBytes(6).toString("hex")}`,
      knownRoots: null,
      collectionState: this._isConfigured()
        ? this.config.manualPaused
          ? COLLECTION_STATES.PAUSED_MANUAL
          : COLLECTION_STATES.ACTIVE_MATCH
        : COLLECTION_STATES.UNBOUND,
      fileOffsets: {},
      pendingEvents: [],
      lastSyncedBatch: null,
      lastSyncAt: null,
      lastError: "",
      accountBlocked: null,
      lsConnectionIssue: null,
      lastMemberView: null,
      lastLocalSnapshots: [],
    });

    if (!Number.isFinite(Number(this.state.installedAtMs)) || Number(this.state.installedAtMs) <= 0) {
      this.state.installedAtMs = nowMs;
    }
    if (!Number.isFinite(Number(this.state.collectionCursorMs)) || Number(this.state.collectionCursorMs) <= 0) {
      this.state.collectionCursorMs = Number(this.state.installedAtMs);
    }
    if (!this.state.deviceId || !/^dev_[0-9a-f]{6,24}$/i.test(String(this.state.deviceId))) {
      this.state.deviceId = `dev_${crypto.randomBytes(6).toString("hex")}`;
    }
    if (!Array.isArray(this.state.pendingEvents)) {
      this.state.pendingEvents = [];
    }
    if (!this.state.collectionState) {
      this.state.collectionState = this._isConfigured()
        ? this.config.manualPaused
          ? COLLECTION_STATES.PAUSED_MANUAL
          : COLLECTION_STATES.ACTIVE_MATCH
        : COLLECTION_STATES.UNBOUND;
    }

    // 首次建档只锚定安装前历史文件，绝不在构造阶段向 pendingEvents 采集事件
    if (!stateExisted) {
      fastForwardTranscriptOffsets(this.state, this._resolveRoots(), {
        nowMs,
        anchorBeforeMs: nowMs - 5000,
        env: this.env,
      });
    }
    this.saveState();
  }

  _isConfigured() {
    return Boolean(this.config?.serverUrl && this.config?.memberToken);
  }

  _resolveRoots() {
    return Array.isArray(this.transcriptRoots)
      ? this.transcriptRoots
      : getDefaultTranscriptRoots(this.env);
  }

  _computeScopeKey(activeAccountHash = "") {
    return `${this.config.serverUrl || ""}|${this.config.memberToken || ""}|${normalizeAccountHash(activeAccountHash)}`;
  }

  _getEffectiveTargetAccountHash() {
    const mvLock = this.state.lastMemberView?.accountLock || null;
    if (mvLock?.isolationMode === "shared_owner_account" && normalizeAccountHash(mvLock.sharedAccountHash)) {
      return normalizeAccountHash(mvLock.sharedAccountHash);
    }
    const cfgTarget = normalizeAccountHash(this.config.targetAccountHash || "");
    if (cfgTarget) return cfgTarget;
    if (mvLock?.lockedByAdmin && normalizeAccountHash(mvLock.boundAccountHash)) {
      return normalizeAccountHash(mvLock.boundAccountHash);
    }
    const cfgBound = normalizeAccountHash(this.config.boundAccountHash || "");
    if (cfgBound) return cfgBound;
    if (normalizeAccountHash(mvLock?.boundAccountHash || "")) {
      return normalizeAccountHash(mvLock.boundAccountHash);
    }
    return "";
  }

  _isAccountLockedByPolicy() {
    const mvLock = this.state.lastMemberView?.accountLock || null;
    if (mvLock?.isolationMode === "shared_owner_account" && normalizeAccountHash(mvLock.sharedAccountHash)) {
      return true;
    }
    if (mvLock?.lockedByAdmin) return true;
    return false;
  }

  loadConfig() {
    const def = readJsonSafe(this.defaultConfigPath, {
      serverUrl: "",
      memberToken: "",
      memberName: "",
      proxyUrl: "",
      syncIntervalSec: 90,
      agreedRules: null,
      boundAccountHash: "",
      boundAccountMasked: "",
      targetAccountHash: "",
      manualPaused: false,
      autoCheckUpdates: true,
      ignoredUpdateVersion: "",
    });
    const user = readJsonSafe(this.configPath, {});
    try {
      this._configMtimeMs = fs.existsSync(this.configPath) ? fs.statSync(this.configPath).mtimeMs : 0;
    } catch {
      this._configMtimeMs = 0;
    }
    const merged = { ...def, ...user };
    merged.boundAccountHash = normalizeAccountHash(merged.boundAccountHash || "");
    merged.boundAccountMasked = String(merged.boundAccountMasked || "").trim().slice(0, 80);
    merged.targetAccountHash = normalizeAccountHash(merged.targetAccountHash || "");
    merged.manualPaused = Boolean(merged.manualPaused);
    merged.autoCheckUpdates = merged.autoCheckUpdates !== false;
    merged.ignoredUpdateVersion = String(merged.ignoredUpdateVersion || "").trim().replace(/^v/i, "");
    return merged;
  }

  maybeReloadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) return false;
      const mtime = fs.statSync(this.configPath).mtimeMs;
      if (mtime && mtime !== this._configMtimeMs) {
        const prevUrl = this.config?.serverUrl || "";
        const prevToken = this.config?.memberToken || "";
        this.config = this.loadConfig();
        if (this.config.serverUrl !== prevUrl || this.config.memberToken !== prevToken) {
          this._purgeLocalQueueAndAnchor("config_reloaded");
        }
        return true;
      }
    } catch {}
    return false;
  }

  _purgeLocalQueueAndAnchor(nextState = COLLECTION_STATES.UNBOUND) {
    const nowMs = this.nowFn();
    this.state.pendingEvents = [];
    this.state.lastLocalSnapshots = [];
    this.state.collectionCursorMs = nowMs;
    if (Object.values(COLLECTION_STATES).includes(nextState)) {
      this.state.collectionState = nextState;
    }
    fastForwardTranscriptOffsets(this.state, this._resolveRoots(), { nowMs, env: this.env });
    this.saveState();
  }

  saveConfig(patch = {}) {
    let nextUrl = patch.serverUrl;
    let nextToken = patch.memberToken;
    let nextAgreed = patch.agreedRules !== undefined ? patch.agreedRules : this.config.agreedRules;
    let parsedTargetHash = undefined;

    if (patch.inviteCode !== undefined && String(patch.inviteCode).trim() !== "") {
      const parsed = parseInviteCode(patch.inviteCode);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      nextUrl = parsed.serverUrl;
      nextToken = parsed.memberToken;
      nextAgreed = parsed.agreedRules || null;
      parsedTargetHash = parsed.targetAccountHash || "";
    } else if (typeof nextUrl === "string" && nextUrl.includes("#agf_")) {
      const parsed = parseInviteCode(nextUrl);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      nextUrl = parsed.serverUrl;
      nextToken = parsed.memberToken;
      if (parsed.agreedRules) nextAgreed = parsed.agreedRules;
      parsedTargetHash = parsed.targetAccountHash || "";
    } else if (typeof nextUrl === "string" && nextUrl.trim()) {
      const check = parseInviteCode(`${nextUrl.trim().replace(/\/+$/, "")}#agf_check_only`);
      if (!check.ok) {
        throw new Error(check.error);
      }
      nextUrl = check.serverUrl;
    }

    const nextProxy =
      patch.proxyUrl !== undefined ? String(patch.proxyUrl || "").trim() : String(this.config.proxyUrl || "").trim();
    if (nextProxy && !/^https?:\/\//i.test(nextProxy)) {
      throw new Error("代理地址需以 http:// 或 https:// 开头（例如 http://127.0.0.1:7897）");
    }

    const finalUrl = String(nextUrl ?? this.config.serverUrl ?? "").trim().replace(/\/+$/, "");
    const finalToken = String(nextToken ?? this.config.memberToken ?? "").trim();
    const endpointChanged = finalUrl !== (this.config.serverUrl || "") || finalToken !== (this.config.memberToken || "");

    const nextAutoCheck =
      patch.autoCheckUpdates !== undefined ? Boolean(patch.autoCheckUpdates) : this.config.autoCheckUpdates !== false;
    const nextIgnoredUpdate =
      patch.ignoredUpdateVersion !== undefined
        ? String(patch.ignoredUpdateVersion || "").trim().replace(/^v/i, "")
        : String(this.config.ignoredUpdateVersion || "").trim().replace(/^v/i, "");

    let nextTargetHash =
      parsedTargetHash !== undefined
        ? normalizeAccountHash(parsedTargetHash)
        : patch.targetAccountHash !== undefined
        ? normalizeAccountHash(patch.targetAccountHash)
        : endpointChanged
        ? ""
        : normalizeAccountHash(this.config.targetAccountHash || "");

    let nextBoundHash =
      patch.boundAccountHash !== undefined
        ? normalizeAccountHash(patch.boundAccountHash)
        : endpointChanged
        ? ""
        : normalizeAccountHash(this.config.boundAccountHash || "");

    let nextBoundMasked =
      patch.boundAccountMasked !== undefined
        ? String(patch.boundAccountMasked || "").trim().slice(0, 80)
        : endpointChanged
        ? ""
        : String(this.config.boundAccountMasked || "").trim().slice(0, 80);

    if (nextTargetHash && nextBoundHash && nextTargetHash !== nextBoundHash) {
      nextBoundHash = "";
      nextBoundMasked = "";
    }

    const nextManualPaused =
      patch.manualPaused !== undefined ? Boolean(patch.manualPaused) : Boolean(this.config.manualPaused);

    this.config = {
      ...this.config,
      serverUrl: finalUrl,
      memberToken: finalToken,
      memberName: String(patch.memberName ?? this.config.memberName ?? "").trim(),
      proxyUrl: nextProxy,
      agreedRules: nextAgreed || null,
      boundAccountHash: nextBoundHash,
      boundAccountMasked: nextBoundMasked,
      targetAccountHash: nextTargetHash,
      manualPaused: nextManualPaused,
      syncIntervalSec: Math.max(30, Math.min(600, Number(patch.syncIntervalSec ?? this.config.syncIntervalSec) || 90)),
      autoCheckUpdates: nextAutoCheck,
      ignoredUpdateVersion: nextIgnoredUpdate,
    };
    writeJsonAtomic(this.configPath, this.config);
    try {
      this._configMtimeMs = fs.statSync(this.configPath).mtimeMs;
    } catch {}

    if (endpointChanged) {
      this.state.lastMemberView = null;
      this.state.lastError = "";
      this.state.accountBlocked = null;
      this.state.lastSyncedBatch = null;
      this._pendingRebindFlag = false;
      this._purgeLocalQueueAndAnchor(COLLECTION_STATES.UNBOUND);
    }

    return this.config;
  }

  setManualPaused(paused) {
    const nextPaused = Boolean(paused);
    const nowMs = this.nowFn();
    this.saveConfig({ manualPaused: nextPaused });
    fastForwardTranscriptOffsets(this.state, this._resolveRoots(), { nowMs, env: this.env });
    this.state.collectionCursorMs = nowMs;
    if (nextPaused) {
      this.state.collectionState = COLLECTION_STATES.PAUSED_MANUAL;
    } else if (!this._isConfigured()) {
      this.state.collectionState = COLLECTION_STATES.UNBOUND;
    } else {
      // 恢复时先保持非 ACTIVE 状态，让紧接其后的 tickAccountGuard 执行「先锚定 EOF、再切入 ACTIVE_MATCH」
      this.state.collectionState = COLLECTION_STATES.PAUSED_MANUAL;
    }
    this.saveState();
    return this.getPublicState();
  }

  async rebindToCurrentAccount() {
    this.maybeReloadConfig();
    if (!this._isConfigured()) {
      throw new Error("尚未连接看板");
    }
    if (this._isAccountLockedByPolicy()) {
      throw new Error("当前家庭组账号归属由组长后台锁定，无法自行换绑");
    }
    const ls = await this._queryLocalUserStatus();
    if (!ls.ok || !ls.loggedIn || !ls.accountHash) {
      throw new Error("暂未检测到当前已登录的 Antigravity 账号，请稍后重试");
    }
    this._currentIdentity = ls;
    const nowMs = this.nowFn();
    this.saveConfig({
      boundAccountHash: ls.accountHash,
      boundAccountMasked: ls.accountMasked,
      targetAccountHash: "",
    });
    this.state.pendingEvents = [];
    this.state.lastLocalSnapshots = [];
    this.state.collectionCursorMs = nowMs;
    this.state.collectionState = this.config.manualPaused
      ? COLLECTION_STATES.PAUSED_MANUAL
      : COLLECTION_STATES.ACTIVE_MATCH;
    fastForwardTranscriptOffsets(this.state, this._resolveRoots(), { nowMs, env: this.env });
    this._pendingRebindFlag = true;
    this.saveState();
    return { ok: true, state: this.getPublicState() };
  }

  async retryIdentityCheck() {
    this._consecutiveIdentityFailures = 0;
    this._consecutiveLsHardFailures = 0;
    this.state.lsConnectionIssue = null;
    await this.tickAccountGuard();
    return await this.syncOnce();
  }

  unbind() {
    this.config = {
      ...this.config,
      serverUrl: "",
      memberToken: "",
      memberName: "",
      agreedRules: null,
      boundAccountHash: "",
      boundAccountMasked: "",
      targetAccountHash: "",
      manualPaused: false,
    };
    writeJsonAtomic(this.configPath, this.config);
    try {
      this._configMtimeMs = fs.statSync(this.configPath).mtimeMs;
    } catch {}
    this.state.lastMemberView = null;
    this.state.lastError = "";
    this.state.accountBlocked = null;
    this.state.lastSyncedBatch = null;
    this.state.lsConnectionIssue = null;
    this._pendingRebindFlag = false;
    this._purgeLocalQueueAndAnchor(COLLECTION_STATES.UNBOUND);
    return this.getPublicState();
  }

  saveState() {
    try {
      writeJsonAtomic(this.statePath, this.state);
    } catch {}
  }

  async _queryLocalUserStatus() {
    if (typeof this.fetchUserStatusImpl === "function") {
      return await this.fetchUserStatusImpl(this.env);
    }
    return await fetchLocalUserStatus(this.env);
  }

  async _queryLocalQuotaSnapshots() {
    if (typeof this.fetchQuotaSnapshotsImpl === "function") {
      return await this.fetchQuotaSnapshotsImpl(this.env);
    }
    return await fetchLocalQuotaSnapshots(this.env);
  }

  /**
   * 12 秒本地零流量账号守卫（6 态采集状态机核心）：
   * - 任何非 ACTIVE_MATCH 状态下绝不向 pendingEvents 入队，且持续快进所有活跃日志至 EOF；
   * - 切回 ACTIVE_MATCH 或跨越 >45s 停摆间隙时先锚定 EOF 再采集，彻底根除翻旧账；
   * - 宿主托管模式下连续 3 次本地接口 401/ECONNREFUSED 且满 10 分钟冷却时触发受控自愈回调。
   */
  async tickAccountGuard() {
    if (this._guardInFlight) {
      return await this._guardInFlight;
    }
    this._guardInFlight = this._runAccountGuard().finally(() => {
      this._guardInFlight = null;
    });
    return await this._guardInFlight;
  }

  async _runAccountGuard() {
    if (!this.leaseCheckFn()) {
      return { ok: false, reason: "lease_lost", state: this.state.collectionState, identityVerified: false };
    }
    this.maybeReloadConfig();
    const nowMs = this.nowFn();
    const roots = this._resolveRoots();
    const prevState = this.state.collectionState || COLLECTION_STATES.UNBOUND;
    const prevWatchdogAtMs = Number(this.state.lastWatchdogAtMs || 0);
    const hadDisabledGap = prevWatchdogAtMs > 0 && nowMs - prevWatchdogAtMs > DISABLED_GAP_MS;

    // 1. 未绑定状态：绝不入队，持续快进 EOF
    if (!this._isConfigured()) {
      this.state.collectionState = COLLECTION_STATES.UNBOUND;
      this.state.pendingEvents = [];
      this.state.lastLocalSnapshots = [];
      this.state.lastWatchdogAtMs = nowMs;
      fastForwardTranscriptOffsets(this.state, roots, { nowMs, env: this.env });
      this.saveState();
      return { ok: true, state: COLLECTION_STATES.UNBOUND, identityVerified: false, accountHash: "", accountTier: "" };
    }

    // 2. 查询本地 GetUserStatus（只读回环，耗时 < 8ms）
    const ls = await this._queryLocalUserStatus();
    this._currentIdentity = ls;

    if (ls.ok) {
      this._consecutiveIdentityFailures = 0;
      this._consecutiveLsHardFailures = 0;
      this.state.lsConnectionIssue = null;
    } else if (ls.reason !== "sidecar_env_unavailable") {
      this._consecutiveIdentityFailures += 1;
      if (isLsHardDisconnect(ls)) {
        this._consecutiveLsHardFailures += 1;
      }
    } else {
      this._consecutiveIdentityFailures += 1;
    }

    // 检查连续 3 次本地接口 401 / ECONNREFUSED 限频自愈
    let selfHealTriggered = false;
    if (this._consecutiveLsHardFailures >= 3) {
      const lastHealMs = Number(this.state.lastLsSelfHealAtMs || 0);
      const cooldownOk = !lastHealMs || nowMs - lastHealMs >= LS_SELF_HEAL_COOLDOWN_MS;
      const isHosted = Boolean(this.env?.ANTIGRAVITY_SIDECAR_WEB_PORT);
      this.state.lsConnectionIssue = {
        atMs: nowMs,
        reason: String(ls.reason || "ls_disconnected"),
        failures: this._consecutiveLsHardFailures,
        coolingDown: !cooldownOk,
      };
      if (isHosted && cooldownOk && !this._lsSelfHealTriggeredThisSession) {
        this.state.lastLsSelfHealAtMs = nowMs;
        this._lsSelfHealTriggeredThisSession = true;
        selfHealTriggered = true;
        this.saveState();
        if (this.onSelfHealRequested) {
          this.onSelfHealRequested({ reason: ls.reason, failures: this._consecutiveLsHardFailures, nowMs });
        }
      }
    }

    // 3. 手动暂停优先：持续快进 EOF，绝不入队
    if (this.config.manualPaused) {
      this.state.collectionState = COLLECTION_STATES.PAUSED_MANUAL;
      this.state.lastWatchdogAtMs = nowMs;
      fastForwardTranscriptOffsets(this.state, roots, { nowMs, env: this.env });
      this.saveState();
      return {
        ok: true,
        state: COLLECTION_STATES.PAUSED_MANUAL,
        identityVerified: Boolean(ls.ok && ls.loggedIn),
        accountHash: ls.ok ? ls.accountHash : "",
        accountTier: ls.ok ? ls.accountTier : "",
        selfHealTriggered,
      };
    }

    // 4. 计算目标归属指纹并判定 6 态
    let targetHash = this._getEffectiveTargetAccountHash();
    let nextState = COLLECTION_STATES.ACTIVE_MATCH;
    let identityVerified = false;
    let activeHash = "";
    let activeTier = "";

    if (ls.ok) {
      activeTier = ls.accountTier || "";
      if (ls.loggedIn && ls.accountHash) {
        if (!targetHash) {
          // per_member_lock 且尚未锁号 -> 首次识别到有效账号自动锁定
          this.config.boundAccountHash = ls.accountHash;
          this.config.boundAccountMasked = ls.accountMasked;
          writeJsonAtomic(this.configPath, this.config);
          try {
            this._configMtimeMs = fs.statSync(this.configPath).mtimeMs;
          } catch {}
          targetHash = ls.accountHash;
        }
        if (ls.accountHash === targetHash) {
          nextState = COLLECTION_STATES.ACTIVE_MATCH;
          identityVerified = true;
          activeHash = ls.accountHash;
          // 同步补齐本地脱敏显示串（如通过 &ah= 或组长预锁首次匹配成功）
          if (!this.config.boundAccountMasked || this.config.boundAccountHash !== ls.accountHash) {
            this.config.boundAccountHash = ls.accountHash;
            this.config.boundAccountMasked = ls.accountMasked;
            writeJsonAtomic(this.configPath, this.config);
            try {
              this._configMtimeMs = fs.statSync(this.configPath).mtimeMs;
            } catch {}
          }
        } else {
          nextState = COLLECTION_STATES.PAUSED_ACCOUNT_MISMATCH;
          activeHash = ls.accountHash;
        }
      } else {
        // GetUserStatus 成功但未登录账号
        nextState = targetHash ? COLLECTION_STATES.PAUSED_ACCOUNT_MISMATCH : COLLECTION_STATES.ACTIVE_MATCH;
      }
    } else {
      // GetUserStatus 读取失败
      if (this._consecutiveLsHardFailures >= 3) {
        nextState = COLLECTION_STATES.PAUSED_IDENTITY_UNAVAILABLE;
      } else if (targetHash) {
        // 已设置账号锁：单次失败期间绝不盲采；累计 >=3 次或明确无宿主环境时进入 PAUSED_IDENTITY_UNAVAILABLE
        if (this._consecutiveIdentityFailures >= 3 || ls.reason === "sidecar_env_unavailable") {
          nextState = COLLECTION_STATES.PAUSED_IDENTITY_UNAVAILABLE;
        } else {
          // 瞬时抖动：保持暂停采集但不改变展示态（仍防串号）
          this.state.lastWatchdogAtMs = nowMs;
          this.saveState();
          return {
            ok: true,
            state: prevState === COLLECTION_STATES.ACTIVE_MATCH ? COLLECTION_STATES.PAUSED_IDENTITY_UNAVAILABLE : prevState,
            transientHold: true,
            identityVerified: false,
            accountHash: "",
            accountTier: "",
            selfHealTriggered,
          };
        }
      } else {
        // 无账号锁且无宿主 LS 环境（兼容独立预览/精简版，兜底走手动暂停开关）
        nextState = COLLECTION_STATES.ACTIVE_MATCH;
        identityVerified = false;
      }
    }

    // 5. 若被服务端暂停/停用，保持 BLOCKED_BY_SERVER（在 syncOnce 重试解除）
    if (this.state.accountBlocked && nextState === COLLECTION_STATES.ACTIVE_MATCH) {
      nextState = COLLECTION_STATES.BLOCKED_BY_SERVER;
    }

    // 6. 非 ACTIVE_MATCH 态：绝不入队，持续快进 EOF
    if (nextState !== COLLECTION_STATES.ACTIVE_MATCH) {
      this.state.collectionState = nextState;
      this.state.lastWatchdogAtMs = nowMs;
      if (nextState !== COLLECTION_STATES.BLOCKED_BY_SERVER) {
        fastForwardTranscriptOffsets(this.state, roots, { nowMs, env: this.env });
      }
      this.saveState();
      return {
        ok: true,
        state: nextState,
        identityVerified: false,
        accountHash: activeHash,
        accountTier: activeTier,
        selfHealTriggered,
      };
    }

    // 7. 进入 ACTIVE_MATCH：若从非 ACTIVE_MATCH 切入，或检测到停摆间隔 > 45s，先锚定 EOF 再采集
    if (prevState !== COLLECTION_STATES.ACTIVE_MATCH) {
      fastForwardTranscriptOffsets(this.state, roots, { nowMs, env: this.env });
      this.state.collectionCursorMs = nowMs;
    } else if (hadDisabledGap) {
      const gapCutoffMs = Math.max(this._bootStartMs - BOOT_GRACE_MS, nowMs - BOOT_GRACE_MS);
      fastForwardTranscriptOffsets(this.state, roots, {
        nowMs,
        anchorBeforeMs: gapCutoffMs,
        env: this.env,
      });
      this.state.collectionCursorMs = Math.max(Number(this.state.collectionCursorMs) || 0, gapCutoffMs);
    }

    this.state.collectionState = COLLECTION_STATES.ACTIVE_MATCH;
    this.state.lastWatchdogAtMs = nowMs;

    // 8. 仅在 ACTIVE_MATCH 状态下扫描增量日志并打上 _scopeKey 入队
    const fresh = scanIncrementalTranscriptUsage(this.state, roots, { nowMs, env: this.env });
    if (!Array.isArray(this.state.pendingEvents)) this.state.pendingEvents = [];
    if (fresh.length > 0) {
      const scopeKey = this._computeScopeKey(activeHash);
      const seenIds = new Set(this.state.pendingEvents.map((e) => e.id));
      for (const ev of fresh) {
        if (!seenIds.has(ev.id)) {
          this.state.pendingEvents.push({ ...ev, _scopeKey: scopeKey });
          seenIds.add(ev.id);
        }
      }
      if (this.state.pendingEvents.length > MAX_PENDING_QUEUE) {
        this.state.pendingEvents = this.state.pendingEvents.slice(-MAX_PENDING_QUEUE);
      }
    }

    this.saveState();
    return {
      ok: true,
      state: COLLECTION_STATES.ACTIVE_MATCH,
      identityVerified,
      accountHash: activeHash,
      accountTier: activeTier,
      selfHealTriggered,
    };
  }

  getPublicState() {
    this.maybeReloadConfig();
    const mv = this.state.lastMemberView || null;
    const ruleMismatch = evaluateRuleMismatch(this.config.agreedRules, mv);
    const targetHash = this._getEffectiveTargetAccountHash();
    const mvLock = mv?.accountLock || null;
    const isolationMode =
      mvLock?.isolationMode === "shared_owner_account" ? "shared_owner_account" : "per_member_lock";
    const lockedByAdmin = Boolean(mvLock?.lockedByAdmin);
    const canSelfRebind =
      this._isConfigured() &&
      isolationMode === "per_member_lock" &&
      !lockedByAdmin &&
      Boolean(this._currentIdentity?.ok && this._currentIdentity?.loggedIn && this._currentIdentity?.accountHash);

    return {
      configured: this._isConfigured(),
      config: {
        serverUrl: this.config.serverUrl || "",
        memberName: this.config.memberName || "",
        proxyUrl: this.config.proxyUrl || "",
        hasToken: Boolean(this.config.memberToken),
        tokenPreview: this.config.memberToken ? `${this.config.memberToken.slice(0, 8)}••••` : "",
        syncIntervalSec: this.config.syncIntervalSec || 90,
        agreedRules: this.config.agreedRules || null,
        boundAccountHash: this.config.boundAccountHash || "",
        boundAccountMasked: this.config.boundAccountMasked || "",
        targetAccountHash: targetHash,
        manualPaused: Boolean(this.config.manualPaused),
        autoCheckUpdates: this.config.autoCheckUpdates !== false,
        ignoredUpdateVersion: String(this.config.ignoredUpdateVersion || ""),
      },
      accountGuard: {
        collectionState: this.state.collectionState || (this._isConfigured() ? COLLECTION_STATES.ACTIVE_MATCH : COLLECTION_STATES.UNBOUND),
        collectionStatus: stateToClientStatus(this.state.collectionState),
        isolationMode,
        lockedByAdmin,
        canSelfRebind,
        identityAvailable: Boolean(this._currentIdentity?.ok),
        currentLoggedIn: Boolean(this._currentIdentity?.loggedIn),
        currentAccountHash: this._currentIdentity?.accountHash || "",
        currentAccountMasked: this._currentIdentity?.accountMasked || "",
        currentAccountTier: this._currentIdentity?.accountTier || "",
        targetAccountHash: targetHash,
        boundAccountMasked: this.config.boundAccountMasked || "",
        manualPaused: Boolean(this.config.manualPaused),
        lsConnectionIssue: this.state.lsConnectionIssue || null,
        deviceId: this.state.deviceId || "",
      },
      ruleMismatch,
      syncInFlight: Boolean(this._isSyncing),
      pendingQueueCount: Array.isArray(this.state.pendingEvents) ? this.state.pendingEvents.length : 0,
      pendingQueuePreview: Array.isArray(this.state.pendingEvents)
        ? this.state.pendingEvents.slice(0, 6).map(summarizeEventForUi)
        : [],
      lastSyncedBatch: this.state.lastSyncedBatch || null,
      lastSyncAt: this.state.lastSyncAt || null,
      lastError: this.state.lastError || "",
      accountBlocked: this.state.accountBlocked || null,
      localSnapshots: this.state.lastLocalSnapshots || [],
      memberView: mv,
      clientVersion: CLIENT_VERSION,
    };
  }

  async confirmRules() {
    this.maybeReloadConfig();
    if (!this._isConfigured()) {
      throw new Error("尚未连接看板");
    }
    const endpoint = `${this.config.serverUrl.replace(/\/+$/, "")}/api/member/confirm-rules`;
    const mv = this.state.lastMemberView;
    const targetVer = mv?.pricing?.ruleVersion ?? null;

    const { ok, status, data } = await postJsonRequest(
      endpoint,
      {
        "User-Agent": `AgyFamilyLedger/${CLIENT_VERSION}`,
        "Content-Type": "application/json",
        "X-Member-Token": this.config.memberToken,
      },
      { ruleVersion: targetVer },
      { proxyUrl: this.config.proxyUrl, timeoutMs: 12000 }
    );
    if (!ok || !data?.ok) {
      throw new Error(data?.error || `确认规则失败 (HTTP ${status})`);
    }
    if (data.member) {
      this.state.lastMemberView = data.member;
      const p = data.member.pricing;
      if (p) {
        this.saveConfig({
          agreedRules: {
            ruleVersion: Number(p.ruleVersion) || 1,
            ledgerMode: p.ledgerMode === "prepaid" ? "prepaid" : "board_only",
            geminiFenPerWeeklyPct: Number(p.geminiFenPerWeeklyPct) || 100,
            thirdPartyFenPerWeeklyPct: Number(p.thirdPartyFenPerWeeklyPct) || 180,
            poolReserveFloorPct: normalizePctLimit(p.poolReserveFloorPct, 95),
            memberWeeklyCapPct: normalizePctLimit(p.memberWeeklyCapPct, 100),
            applyCapToOwner: p.applyCapToOwner !== false,
            restrict3pForMembers: Boolean(p.restrict3pForMembers),
            usageRuleNote: sanitizeUsageRuleNote(p.usageRuleNote || ""),
            usageRuleNoteHash: String(p.usageRuleNoteHash || "") || computeRuleNoteHash(p.usageRuleNote || ""),
            agreedAt: new Date().toISOString(),
            source: "member_confirmed",
          },
        });
      }
      this.saveState();
    }
    return { ok: true, state: this.getPublicState() };
  }

  async syncOnce() {
    if (this._syncInFlight) {
      return await this._syncInFlight;
    }
    this._isSyncing = true;
    this._syncInFlight = this._runSyncOnce().finally(() => {
      this._isSyncing = false;
      this._syncInFlight = null;
    });
    return await this._syncInFlight;
  }

  async _runSyncOnce() {
    if (!this.leaseCheckFn()) {
      this._isSyncing = false;
      return { ok: false, reason: "lease_lost", state: this.getPublicState() };
    }
    this.maybeReloadConfig();

    if (!this._isConfigured()) {
      await this.tickAccountGuard();
      this.state.lastError = "尚未填写绑定码";
      this.saveState();
      this._isSyncing = false;
      return { ok: false, reason: "not_configured", state: this.getPublicState() };
    }

    // 先执行账号守卫校验（若是手动重试同步且此前被服务端暂停，仍允许发心跳探活）
    const wasBlocked = Boolean(this.state.accountBlocked);
    if (wasBlocked) {
      this.state.accountBlocked = null;
    }
    const guard = await this.tickAccountGuard();
    const isActiveMatch = guard.state === COLLECTION_STATES.ACTIVE_MATCH && !guard.transientHold;
    const collectionStatus = stateToClientStatus(guard.state);

    // 水位防串号第一道防线：仅在 ACTIVE_MATCH 且身份核验通过时拉取并发送官方水位快照
    let quotaSnapshots = [];
    let hasSeparateArgonPool = undefined;
    if (isActiveMatch && guard.identityVerified) {
      const qRes = await this._queryLocalQuotaSnapshots();
      if (this.leaseCheckFn() && qRes.ok && Array.isArray(qRes.snapshots) && qRes.snapshots.length > 0) {
        quotaSnapshots = qRes.snapshots;
        hasSeparateArgonPool = Boolean(qRes.hasSeparateArgonPool);
        this.state.lastLocalSnapshots = qRes.snapshots;
      }
    }

    const endpoint = `${this.config.serverUrl.replace(/\/+$/, "")}/api/member/heartbeat`;

    try {
      let lastData = null;
      const sentEventsThisRun = [];

      if (!isActiveMatch) {
        // 暂停态（切到其他账号 / 手动暂停 / 本地接口失联）：仅发空数据状态包，刷新全组余量视图
        const { ok, status, data } = await postJsonRequest(
          endpoint,
          {
            "User-Agent": `AgyFamilyLedger/${CLIENT_VERSION}`,
            "Content-Type": "application/json",
            "X-Member-Token": this.config.memberToken,
          },
          {
            clientVersion: CLIENT_VERSION,
            deviceId: this.state.deviceId,
            accountHash: guard.accountHash || "",
            accountTier: guard.accountTier || "",
            collectionStatus,
            usageEvents: [],
            quotaSnapshots: [],
          },
          { proxyUrl: this.config.proxyUrl, timeoutMs: 18000 }
        );
        if (!ok || !data?.ok) {
          throw new Error(data?.error || `中转服务返回 HTTP ${status}`);
        }
        lastData = data;
      } else {
        // 发包前二次 _scopeKey 过滤，清除不属于当前上下文的历史残留条目
        const curScopeKey = this._computeScopeKey(guard.accountHash || "");
        this.state.pendingEvents = (this.state.pendingEvents || []).filter(
          (e) => !e._scopeKey || e._scopeKey === curScopeKey
        );

        const MAX_DRAIN_ROUNDS = 4;
        for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
          const rawBatch = this.state.pendingEvents.slice(0, 80);
          const batchIds = new Set(rawBatch.map((e) => e.id));
          const wireBatch = rawBatch.map(({ _scopeKey: _ignoredScope, ...rest }) => rest);
          const sendSnapshots = round === 0 ? quotaSnapshots : [];
          const bodyPayload = {
            clientVersion: CLIENT_VERSION,
            deviceId: this.state.deviceId,
            accountHash: guard.accountHash || "",
            accountTier: guard.accountTier || "",
            collectionStatus: "active",
            usageEvents: wireBatch,
            quotaSnapshots: sendSnapshots,
          };
          if (round === 0 && typeof hasSeparateArgonPool === "boolean") {
            bodyPayload.hasSeparateArgonPool = hasSeparateArgonPool;
          }
          if (round === 0 && this._pendingRebindFlag) {
            bodyPayload.rebindAccount = true;
          }

          const { ok, status, data } = await postJsonRequest(
            endpoint,
            {
              "User-Agent": `AgyFamilyLedger/${CLIENT_VERSION}`,
              "Content-Type": "application/json",
              "X-Member-Token": this.config.memberToken,
            },
            bodyPayload,
            { proxyUrl: this.config.proxyUrl, timeoutMs: 25000 }
          );
          if (!ok || !data?.ok) {
            throw new Error(data?.error || `中转服务返回 HTTP ${status}`);
          }
          if (round === 0 && this._pendingRebindFlag) {
            this._pendingRebindFlag = false;
          }
          if (rawBatch.length > 0) sentEventsThisRun.push(...rawBatch);
          this.state.pendingEvents = this.state.pendingEvents.filter((e) => !batchIds.has(e.id));
          lastData = data;
          if (this.state.pendingEvents.length === 0) break;
        }
      }

      const data = lastData || {};
      const syncedAtIso = new Date(this.nowFn()).toISOString();
      this.state.lastSyncAt = syncedAtIso;
      if (sentEventsThisRun.length > 0) {
        this.state.lastSyncedBatch = {
          count: sentEventsThisRun.length,
          syncedAt: syncedAtIso,
          items: sentEventsThisRun.slice(-6).reverse().map(summarizeEventForUi),
        };
      }
      this.state.lastError = "";
      this.state.accountBlocked = null;

      if (data.member) {
        this.state.lastMemberView = data.member;
        this._syncLocalAccountLockFromServer(data.member.accountLock);

        if (!this.config.agreedRules && data.member.pricing && data.member.role !== "owner") {
          const p = data.member.pricing;
          this.saveConfig({
            agreedRules: {
              ruleVersion: Number(data.member.acceptedRuleVersion || p.ruleVersion || 1),
              ledgerMode: p.ledgerMode === "prepaid" ? "prepaid" : "board_only",
              geminiFenPerWeeklyPct: Number(p.geminiFenPerWeeklyPct) || 100,
              thirdPartyFenPerWeeklyPct: Number(p.thirdPartyFenPerWeeklyPct) || 180,
              poolReserveFloorPct: normalizePctLimit(p.poolReserveFloorPct, 95),
              memberWeeklyCapPct: normalizePctLimit(p.memberWeeklyCapPct, 100),
              applyCapToOwner: p.applyCapToOwner !== false,
              restrict3pForMembers: Boolean(p.restrict3pForMembers),
              usageRuleNote: sanitizeUsageRuleNote(p.usageRuleNote || ""),
              usageRuleNoteHash: String(p.usageRuleNoteHash || "") || computeRuleNoteHash(p.usageRuleNote || ""),
              agreedAt: new Date(this.nowFn()).toISOString(),
              source: "first_sync_snapshot",
            },
          });
        } else if (
          this.config.agreedRules &&
          data.member.pricing &&
          data.member.role !== "owner"
        ) {
          const p = data.member.pricing;
          const ar = this.config.agreedRules;
          if (
            !ar.usageRuleNote &&
            ar.usageRuleNoteHash &&
            p.usageRuleNote &&
            computeRuleNoteHash(p.usageRuleNote) === ar.usageRuleNoteHash
          ) {
            this.saveConfig({
              agreedRules: {
                ...ar,
                usageRuleNote: sanitizeUsageRuleNote(p.usageRuleNote),
              },
            });
          }

          const checkWithoutServerFlag = evaluateRuleMismatch(this.config.agreedRules, {
            ...data.member,
            needsRuleConfirm: false,
          });
          if (
            ar.source === "invite_code" &&
            data.member.needsRuleConfirm &&
            !checkWithoutServerFlag.mismatch &&
            Number(ar.ruleVersion) === Number(p.ruleVersion)
          ) {
            try {
              const confRes = await postJsonRequest(
                `${this.config.serverUrl.replace(/\/+$/, "")}/api/member/confirm-rules`,
                {
                  "User-Agent": `AgyFamilyLedger/${CLIENT_VERSION}`,
                  "Content-Type": "application/json",
                  "X-Member-Token": this.config.memberToken,
                },
                { ruleVersion: Number(ar.ruleVersion) },
                { proxyUrl: this.config.proxyUrl, timeoutMs: 8000 }
              );
              if (confRes.ok && confRes.data?.ok && confRes.data.member) {
                this.state.lastMemberView = confRes.data.member;
              }
            } catch {
              // 自动对齐失败不影响主流程
            }
          }
        }
      }

      // 若服务端刚刚下发了新的强制目标账号锁与当前账号不符，立即切入暂停保护态
      const postTarget = this._getEffectiveTargetAccountHash();
      if (
        postTarget &&
        this._currentIdentity?.ok &&
        this._currentIdentity?.accountHash &&
        this._currentIdentity.accountHash !== postTarget &&
        !this.config.manualPaused
      ) {
        this.state.collectionState = COLLECTION_STATES.PAUSED_ACCOUNT_MISMATCH;
      }

      this.saveState();
      this._isSyncing = false;
      return { ok: true, state: this.getPublicState() };
    } catch (err) {
      const rawMsg = String(err?.message || err);
      if (/已被组长暂停/.test(rawMsg)) {
        this.state.accountBlocked = {
          kind: "paused",
          title: "账号同步已被组长暂停",
          detail: "你的成员同步状态当前处于暂停中，请先停止运行较重任务并联系组长恢复。",
        };
        this.state.collectionState = COLLECTION_STATES.BLOCKED_BY_SERVER;
        this.state.lastError = "";
      } else if (/凭证已停用|已停用/.test(rawMsg)) {
        this.state.accountBlocked = {
          kind: "archived",
          title: "成员绑定码已停用",
          detail: "当前绑定码已被组长停用，如需继续使用请联系组长获取新绑定码并在底部「连接配置」中更换。",
        };
        this.state.collectionState = COLLECTION_STATES.BLOCKED_BY_SERVER;
        this.state.lastError = "";
      } else if (/无效的成员凭证/.test(rawMsg)) {
        this.state.accountBlocked = {
          kind: "invalid_token",
          title: "成员绑定码已失效",
          detail: "服务端未识别当前绑定码（可能已被组长重置），请联系组长获取新绑定码并在「连接配置」中重新粘贴。",
        };
        this.state.collectionState = COLLECTION_STATES.BLOCKED_BY_SERVER;
        this.state.lastError = "";
      } else {
        this.state.accountBlocked = null;
        const proxyHint =
          !this.config.proxyUrl && /fetch failed|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(rawMsg)
            ? "（若使用 *.workers.dev 且未开 TUN，可在「连接配置」中填入本地代理地址或改用自定义域名）"
            : "";
        this.state.lastError = `同步暂未送达（已暂存本地队列，联网自动补传）：${rawMsg}${proxyHint}`;
      }
      this.saveState();
      this._isSyncing = false;
      return { ok: false, reason: rawMsg || "sync_failed", state: this.getPublicState() };
    }
  }

  _syncLocalAccountLockFromServer(accountLock) {
    if (!accountLock || typeof accountLock !== "object") return;
    let nextTarget = "";
    if (accountLock.isolationMode === "shared_owner_account" && normalizeAccountHash(accountLock.sharedAccountHash)) {
      nextTarget = normalizeAccountHash(accountLock.sharedAccountHash);
    } else if (accountLock.lockedByAdmin && normalizeAccountHash(accountLock.boundAccountHash)) {
      nextTarget = normalizeAccountHash(accountLock.boundAccountHash);
    }
    const curTarget = normalizeAccountHash(this.config.targetAccountHash || "");
    if (nextTarget !== curTarget) {
      this.config.targetAccountHash = nextTarget;
      if (nextTarget && this.config.boundAccountHash && this.config.boundAccountHash !== nextTarget) {
        this.config.boundAccountHash = "";
        this.config.boundAccountMasked = "";
      }
      writeJsonAtomic(this.configPath, this.config);
      try {
        this._configMtimeMs = fs.statSync(this.configPath).mtimeMs;
      } catch {}
    }
  }
}
