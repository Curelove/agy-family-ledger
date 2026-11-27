/**
 * 成员端零隐私侵入数据采集器 (v1.3.1 · Windows / macOS / Linux 全平台零依赖)
 *
 * 严格隐私边界：
 * 1. 读取本机 Antigravity 会话日志 transcript.jsonl 时，仅读取顶层纯数字 Token 计数、模型名、步数索引与时间戳，
 *    绝不读取、存储或上传任何对话正文 content、思考内容 thinking 或工具调用参数 tool_calls；会话 ID 经 SHA-256 短哈希脱敏。
 * 2. 读取官方配额水位时，仅调用宿主 Sidecar 注入的 127.0.0.1 本地接口（RetrieveUserQuotaSummary）。
 * 3. 永不扫描本机进程、端口、代理配置或任何工作区文件。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import tls from "node:tls";
import crypto from "node:crypto";

const CLIENT_VERSION = "1.3.1";
const MAX_PENDING_QUEUE = 1500;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES_PER_POLL = 8 * 1024 * 1024;
const MAX_TRACKED_FILES = 2000;

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
  const note = sanitizeUsageRuleNote(rules.usageRuleNote);
  const noteHash = String(rules.usageRuleNoteHash || "").trim();

  const convParts = [];
  if (floor > 0) convParts.push(`总池剩余 ${fmtPctLabel(floor)} 时暂停非紧急任务`);
  if (cap > 0) convParts.push(`单人每周期上限 ${fmtPctLabel(cap)}（${applyOwner ? "全员同等适用" : "适用于普通成员"}）`);
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
 * 构造含初始规则与全组使用约定的纯文本绑定码：
 * https://<domain>#<token>&v=<ruleVersion>&m=<board|prepaid>&g=<gemFen>&p=<3pFen>[&rf=<floor>&mc=<cap>&ao=<1|0>&nh=<hash>]
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
  usageRuleNote = "",
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
  const nh = computeRuleNoteHash(usageRuleNote);

  let frag = `${cleanToken}&v=${v}&m=${modeShort}&g=${g}&p=${p}`;
  if (rf > 0 || mc > 0 || ao === 0 || nh) {
    frag += `&rf=${rf}&mc=${mc}&ao=${ao}`;
    if (nh) frag += `&nh=${nh}`;
  }
  return `${cleanUrl}#${frag}`;
}

/**
 * 解析单行纯文本绑定码（兼容旧版 https://域名#agf_xxxx、v1.2.0 与 v1.3.0 含使用约定后缀）
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
  if (extraFrag && extraFrag.includes("=")) {
    const params = new URLSearchParams(extraFrag.replace(/^[&?]+/, ""));
    const rawV = Number(params.get("v"));
    const rawM = params.get("m");
    const rawG = Number(params.get("g"));
    const rawP = Number(params.get("p"));
    const rawRf = params.get("rf");
    const rawMc = params.get("mc");
    const rawAo = params.get("ao");
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
  const localNoteHash =
    String(agreedRules.usageRuleNoteHash || "").trim() || computeRuleNoteHash(agreedRules.usageRuleNote || "");
  const serverNoteHash =
    String(serverPricing.usageRuleNoteHash || "").trim() || computeRuleNoteHash(serverPricing.usageRuleNote || "");

  const conventionDiff =
    localFloor !== serverFloor ||
    localCap !== serverCap ||
    (serverCap > 0 && localApplyOwner !== serverApplyOwner) ||
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

export function getDefaultStatePath() {
  return path.join(os.homedir(), ".gemini", "agy-family-ledger-member-state.json");
}

function getDefaultTranscriptRoots() {
  const home = os.homedir();
  const baseDot = ".gemini";
  const subDir = "brain";
  return [
    path.join(home, baseDot, "antigravity", subDir),
    path.join(home, baseDot, "antigravity-ide", subDir),
  ];
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
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
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
  if (/gemini|gemma|\bneon\b|\bcarbon\b|\bhydrogen\b|\bargon\b|\bflash\b/.test(s)) {
    return "gemini";
  }
  if (/claude|opus|sonnet|haiku|anthropic|gpt|openai|\bo1\b|\bo3\b|\bo4\b|deepseek|qwen|llama|mistral|^3p/.test(s)) {
    return "3p";
  }
  return "3p";
}

function hashConvId(convId = "") {
  return crypto.createHash("sha256").update(String(convId || "local")).digest("hex").slice(0, 10);
}

/**
 * 提取单行 PLANNER_RESPONSE 的纯数值计量字段（严格只读取顶层数字与模型名，不访问 content / thinking / tool_calls）
 * 注：在 Antigravity 原生日志中，input_tokens 本身就是不含缓存的新增未缓存输入 Token，与 cache_read_tokens 互斥。
 */
export function extractNumericUsageFromLine(line = "", convId = "") {
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

  const stepIndex = numVal("step_index");
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

  return {
    id: `${shortHash}:s${stepIndex}`,
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
 * 读取 transcript 文件首行时间戳（用于区分「安装前历史老对话」与「安装后新建对话/子代理」）
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

/**
 * 增量扫描本机 Antigravity 的 transcript.jsonl：
 * - 首次建档记录 installedAtMs：安装前已存在的旧对话锚定在末尾不翻旧账；
 * - 安装后新开的对话与子代理（首行时间 >= installedAtMs - 5s）从 offset=0 完整读取，不再漏计首轮消耗；
 * - 流式扫描 0x0A 换行字节，遇到单行超 4MB 的巨型行自动跳过并推进游标，永不卡死。
 */
export function scanIncrementalTranscriptUsage(stateObj = {}, transcriptRoots = null, { nowMs = Date.now() } = {}) {
  const dirs =
    Array.isArray(transcriptRoots) && transcriptRoots.length
      ? transcriptRoots
      : getDefaultTranscriptRoots();

  if (!stateObj.fileOffsets || typeof stateObj.fileOffsets !== "object") {
    stateObj.fileOffsets = {};
  }
  if (!Number.isFinite(Number(stateObj.installedAtMs)) || Number(stateObj.installedAtMs) <= 0) {
    stateObj.installedAtMs = nowMs;
  }
  const installedAtMs = Number(stateObj.installedAtMs);
  const cutoffMs = nowMs - 48 * 3600 * 1000;
  const freshEvents = [];

  for (const root of dirs) {
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
        const startMs = peekConversationStartMs(logPath, st);
        if (startMs >= installedAtMs - 5000) {
          // 安装之后新建的对话或子代理：从 0 字节开始完整读取首轮与后续步骤
          offset = 0;
          stateObj.fileOffsets[key] = 0;
        } else {
          // 安装之前已存在的历史老对话：锚定在当前文件末尾，仅追踪未来新增
          stateObj.fileOffsets[key] = st.size;
          continue;
        }
      } else {
        offset = Number(stateObj.fileOffsets[key] || 0);
        // 刷新 LRU 顺序，避免活跃旧对话被过早淘汰
        delete stateObj.fileOffsets[key];
        stateObj.fileOffsets[key] = offset;
      }

      if (st.size < offset) offset = 0;
      if (st.size === offset) continue;

      let fd = null;
      try {
        fd = fs.openSync(logPath, "r");
        let curPos = offset;
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
                const ev = extractNumericUsageFromLine(lineStr, convId);
                if (ev) freshEvents.push(ev);
                carryChunks = [];
                carryLen = 0;
              } else {
                carryChunks = [];
                carryLen = 0;
              }
              stateObj.fileOffsets[key] = lineEndPos;
              sliceStart = i + 1;
            }
          }

          if (sliceStart < bytesRead) {
            const remLen = bytesRead - sliceStart;
            if (!skippingOversized) {
              if (carryLen + remLen > MAX_LINE_BYTES) {
                // 单行超过 4MB：切换跳过模式直到遇到下一个换行符，绝不永久阻塞游标
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
            // 若在跳过超大行中途达到本次扫描上限，记录进度下次接着跳过
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

  const keys = Object.keys(stateObj.fileOffsets);
  if (keys.length > MAX_TRACKED_FILES) {
    for (const k of keys.slice(0, keys.length - Math.floor(MAX_TRACKED_FILES * 0.8))) {
      delete stateObj.fileOffsets[k];
    }
  }

  return freshEvents;
}

/**
 * 归一化官方 RetrieveUserQuotaSummary 响应 -> [{ poolKey, windowKey, remainingPct, resetAt, capturedAtMs }]
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

  const out = [];
  const seen = new Set();
  for (const b of buckets) {
    if (b.disabled === true) continue;
    const rawId = String(b.bucketId || "").toLowerCase();
    const gName = String(b._groupName || b.displayName || "").toLowerCase();
    const windowKey =
      b.window === "5h" || b.window === "weekly"
        ? b.window
        : rawId.endsWith("-5h")
        ? "5h"
        : rawId.endsWith("-weekly")
        ? "weekly"
        : "";
    if (!windowKey) continue;

    if (rawId.includes("argon")) continue;
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

    out.push({
      poolKey,
      windowKey,
      remainingPct: Math.round(frac * 10000) / 100,
      resetAt: typeof b.resetTime === "string" ? b.resetTime : null,
      capturedAtMs: nowMs,
    });
  }
  return out;
}

/**
 * 通过官方 Sidecar 注入的 127.0.0.1 环境变量只读拉取当前配额水位（零进程扫描、跨平台兼容）
 */
export async function fetchLocalQuotaSnapshots(env = process.env) {
  const rawAddr = String(env.ANTIGRAVITY_LS_ADDRESS || "").trim();
  const csrf = String(env.ANTIGRAVITY_CSRF_TOKEN || "").trim();
  if (!rawAddr || !csrf) {
    return { ok: false, reason: "sidecar_env_unavailable", snapshots: [] };
  }

  let host = "127.0.0.1";
  let port = 0;
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(rawAddr) ? rawAddr : `http://${rawAddr}`);
    if (!isLoopbackHost(parsed.hostname)) {
      return { ok: false, reason: "non_loopback_blocked", snapshots: [] };
    }
    host = "127.0.0.1";
    port = Number(parsed.port);
  } catch {
    return { ok: false, reason: "invalid_ls_address", snapshots: [] };
  }
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, reason: "invalid_ls_port", snapshots: [] };
  }

  const body = JSON.stringify({});
  return await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: host,
        port,
        method: "POST",
        path: "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": csrf,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 6000,
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (chunks += d));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, reason: `http_${res.statusCode}`, snapshots: [] });
            return;
          }
          try {
            const parsed = JSON.parse(chunks || "{}");
            resolve({ ok: true, snapshots: parseQuotaSummaryResponse(parsed, Date.now()) });
          } catch {
            resolve({ ok: false, reason: "parse_error", snapshots: [] });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ ok: false, reason: err.message, snapshots: [] }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "timeout", snapshots: [] });
    });
    req.end(body);
  });
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

export class MemberLedgerCollector {
  constructor({ configPath, defaultConfigPath, statePath = getDefaultStatePath(), transcriptRoots = null }) {
    this.configPath = configPath;
    this.defaultConfigPath = defaultConfigPath;
    this.statePath = statePath;
    this.transcriptRoots = transcriptRoots;
    this._configMtimeMs = 0;
    this._syncInFlight = null;
    this.config = this.loadConfig();
    this.state = readJsonSafe(this.statePath, {
      installedAtMs: Date.now(),
      fileOffsets: {},
      pendingEvents: [],
      lastSyncAt: null,
      lastError: "",
      lastMemberView: null,
      lastLocalSnapshots: [],
    });
    if (!Number.isFinite(Number(this.state.installedAtMs)) || Number(this.state.installedAtMs) <= 0) {
      this.state.installedAtMs = Date.now();
    }
    scanIncrementalTranscriptUsage(this.state, this.transcriptRoots);
    this.saveState();
  }

  loadConfig() {
    const def = readJsonSafe(this.defaultConfigPath, {
      serverUrl: "",
      memberToken: "",
      memberName: "",
      proxyUrl: "",
      syncIntervalSec: 90,
      agreedRules: null,
    });
    const user = readJsonSafe(this.configPath, {});
    try {
      this._configMtimeMs = fs.existsSync(this.configPath) ? fs.statSync(this.configPath).mtimeMs : 0;
    } catch {
      this._configMtimeMs = 0;
    }
    return { ...def, ...user };
  }

  maybeReloadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) return false;
      const mtime = fs.statSync(this.configPath).mtimeMs;
      if (mtime && mtime !== this._configMtimeMs) {
        this.config = this.loadConfig();
        return true;
      }
    } catch {}
    return false;
  }

  saveConfig(patch = {}) {
    let nextUrl = patch.serverUrl;
    let nextToken = patch.memberToken;
    let nextAgreed = patch.agreedRules !== undefined ? patch.agreedRules : this.config.agreedRules;

    if (patch.inviteCode !== undefined && String(patch.inviteCode).trim() !== "") {
      const parsed = parseInviteCode(patch.inviteCode);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      nextUrl = parsed.serverUrl;
      nextToken = parsed.memberToken;
      nextAgreed = parsed.agreedRules || null;
    } else if (typeof nextUrl === "string" && nextUrl.includes("#agf_")) {
      const parsed = parseInviteCode(nextUrl);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      nextUrl = parsed.serverUrl;
      nextToken = parsed.memberToken;
      if (parsed.agreedRules) nextAgreed = parsed.agreedRules;
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

    this.config = {
      ...this.config,
      serverUrl: String(nextUrl ?? this.config.serverUrl ?? "").trim().replace(/\/+$/, ""),
      memberToken: String(nextToken ?? this.config.memberToken ?? "").trim(),
      memberName: String(patch.memberName ?? this.config.memberName ?? "").trim(),
      proxyUrl: nextProxy,
      agreedRules: nextAgreed || null,
      syncIntervalSec: Math.max(30, Math.min(600, Number(patch.syncIntervalSec ?? this.config.syncIntervalSec) || 90)),
    };
    writeJsonAtomic(this.configPath, this.config);
    try {
      this._configMtimeMs = fs.statSync(this.configPath).mtimeMs;
    } catch {}
    return this.config;
  }

  unbind() {
    this.config = {
      ...this.config,
      serverUrl: "",
      memberToken: "",
      memberName: "",
      agreedRules: null,
    };
    writeJsonAtomic(this.configPath, this.config);
    try {
      this._configMtimeMs = fs.statSync(this.configPath).mtimeMs;
    } catch {}
    this.state.lastMemberView = null;
    this.state.lastError = "";
    this.saveState();
    return this.getPublicState();
  }

  saveState() {
    try {
      writeJsonAtomic(this.statePath, this.state);
    } catch {}
  }

  getPublicState() {
    this.maybeReloadConfig();
    const mv = this.state.lastMemberView || null;
    const ruleMismatch = evaluateRuleMismatch(this.config.agreedRules, mv);
    return {
      configured: Boolean(this.config.serverUrl && this.config.memberToken),
      config: {
        serverUrl: this.config.serverUrl || "",
        memberName: this.config.memberName || "",
        proxyUrl: this.config.proxyUrl || "",
        hasToken: Boolean(this.config.memberToken),
        tokenPreview: this.config.memberToken ? `${this.config.memberToken.slice(0, 8)}••••` : "",
        syncIntervalSec: this.config.syncIntervalSec || 90,
        agreedRules: this.config.agreedRules || null,
      },
      ruleMismatch,
      pendingQueueCount: Array.isArray(this.state.pendingEvents) ? this.state.pendingEvents.length : 0,
      lastSyncAt: this.state.lastSyncAt || null,
      lastError: this.state.lastError || "",
      localSnapshots: this.state.lastLocalSnapshots || [],
      memberView: mv,
      clientVersion: CLIENT_VERSION,
    };
  }

  async confirmRules() {
    this.maybeReloadConfig();
    if (!this.config.serverUrl || !this.config.memberToken) {
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
    // 并发互斥锁：避免手动点击「同步」与后台定时任务重叠导致重复发包与队列错切
    if (this._syncInFlight) {
      return await this._syncInFlight;
    }
    this._syncInFlight = this._runSyncOnce().finally(() => {
      this._syncInFlight = null;
    });
    return await this._syncInFlight;
  }

  async _runSyncOnce() {
    this.maybeReloadConfig();

    const fresh = scanIncrementalTranscriptUsage(this.state, this.transcriptRoots);
    if (!Array.isArray(this.state.pendingEvents)) this.state.pendingEvents = [];
    if (fresh.length > 0) {
      const seenIds = new Set(this.state.pendingEvents.map((e) => e.id));
      for (const ev of fresh) {
        if (!seenIds.has(ev.id)) {
          this.state.pendingEvents.push(ev);
          seenIds.add(ev.id);
        }
      }
      if (this.state.pendingEvents.length > MAX_PENDING_QUEUE) {
        this.state.pendingEvents = this.state.pendingEvents.slice(-MAX_PENDING_QUEUE);
      }
    }

    const qRes = await fetchLocalQuotaSnapshots();
    if (qRes.ok && qRes.snapshots.length > 0) {
      this.state.lastLocalSnapshots = qRes.snapshots;
    }

    if (!this.config.serverUrl || !this.config.memberToken) {
      this.state.lastError = "尚未填写绑定码";
      this.saveState();
      return { ok: false, reason: "not_configured", state: this.getPublicState() };
    }

    const endpoint = `${this.config.serverUrl.replace(/\/+$/, "")}/api/member/heartbeat`;

    try {
      // 单次心跳最多携带 80 条记录并给足 25 秒超时；若有积压队列则连续分批平滑补传（单轮最多 4 批）
      let lastData = null;
      const MAX_DRAIN_ROUNDS = 4;
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
        const batch = this.state.pendingEvents.slice(0, 80);
        const batchIds = new Set(batch.map((e) => e.id));
        const sendSnapshots = round === 0 && qRes.ok ? qRes.snapshots : [];
        const { ok, status, data } = await postJsonRequest(
          endpoint,
          {
            "User-Agent": `AgyFamilyLedger/${CLIENT_VERSION}`,
            "Content-Type": "application/json",
            "X-Member-Token": this.config.memberToken,
          },
          {
            clientVersion: CLIENT_VERSION,
            usageEvents: batch,
            quotaSnapshots: sendSnapshots,
          },
          { proxyUrl: this.config.proxyUrl, timeoutMs: 25000 }
        );
        if (!ok || !data?.ok) {
          throw new Error(data?.error || `中转服务返回 HTTP ${status}`);
        }
        // 按精确已送达 ID 剔除，绝不误删请求在途期间新采集到的事件
        this.state.pendingEvents = this.state.pendingEvents.filter((e) => !batchIds.has(e.id));
        lastData = data;
        if (this.state.pendingEvents.length === 0) break;
      }

      const data = lastData || {};
      this.state.lastSyncAt = new Date().toISOString();
      this.state.lastError = "";
      if (data.member) {
        this.state.lastMemberView = data.member;
        // 兼容旧版短绑定码：若首次同步时尚未记录 agreedRules，自动锁定入组基线规则
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
              usageRuleNote: sanitizeUsageRuleNote(p.usageRuleNote || ""),
              usageRuleNoteHash: String(p.usageRuleNoteHash || "") || computeRuleNoteHash(p.usageRuleNote || ""),
              agreedAt: new Date().toISOString(),
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
            // 若绑定码仅携带了文字说明短哈希且与服务端原文一致，补存原文便于日后变动对比
            this.saveConfig({
              agreedRules: {
                ...ar,
                usageRuleNote: sanitizeUsageRuleNote(p.usageRuleNote),
              },
            });
          }

          // 若成员刚通过新版绑定码入组，且绑定码中锁定的版本号与全部计费/约定参数与云端 100% 一致，
          // 自动同步服务端 accepted_rule_version，避免弹出“原约定与云端新规则完全一样”的重复确认卡片；
          // 只要云端有任何一项参数与绑定码不符或版本号更新，绝不自动确认。
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
              // 自动对齐失败不影响主流程，用户仍可手动点击确认
            }
          }
        }
      }
      this.saveState();
      return { ok: true, state: this.getPublicState() };
    } catch (err) {
      const rawMsg = String(err?.message || err);
      const proxyHint =
        !this.config.proxyUrl && /fetch failed|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(rawMsg)
          ? "（若使用 *.workers.dev 且未开 TUN，可在「连接配置」中填入本地代理地址或改用自定义域名）"
          : "";
      this.state.lastError = `同步暂未送达（已暂存本地队列，联网自动补传）：${rawMsg}${proxyHint}`;
      this.saveState();
      return { ok: false, reason: rawMsg || "sync_failed", state: this.getPublicState() };
    }
  }
}
