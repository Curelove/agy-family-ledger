/**
 * 成员端零隐私侵入数据采集器（Windows / macOS / Linux 全平台零依赖）
 *
 * 严格隐私边界：
 * 1. 读取本机 Antigravity 会话日志目录中的 transcript.jsonl 时，
 *    仅用字段级正则提取纯数字 Token 统计与模型名，永不读取、永不上传任何正文 content / thinking 文本。
 * 2. 读取官方配额水位时，仅使用宿主官方 Sidecar 注入的 127.0.0.1 本地接口（RetrieveUserQuotaSummary）。
 * 3. 永不扫描本机进程、端口、代理配置或任何工作区文件。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

const CLIENT_VERSION = "1.0.0";
const MAX_PENDING_QUEUE = 1500;

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
  const s = String(modelName || "").toLowerCase();
  if (/claude|opus|sonnet|haiku|anthropic|gpt|openai|o1|o3|o4|^3p/.test(s)) return "3p";
  return "gemini";
}

/**
 * 纯正则提取单行 PLANNER_RESPONSE 的纯数值计量字段（不触碰 content / thinking）
 */
export function extractNumericUsageFromLine(line = "", convId = "") {
  if (!line || !line.includes('"PLANNER_RESPONSE"')) return null;
  if (!line.includes('"status":"DONE"') && !line.includes('"status": "DONE"')) return null;

  const numField = (key) => {
    const m = line.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  const strField = (key) => {
    const m = line.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{1,96})"`));
    return m ? m[1] : "";
  };

  const stepIndex = numField("step_index");
  const modelName = strField("model");
  const createdAt = strField("created_at");
  const inputTokens = numField("input_tokens");
  const cacheReadTokens = numField("cache_read_tokens");
  const cacheWriteTokens = numField("cache_write_tokens");
  const outputTokens = numField("output_tokens");

  if (!modelName && inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0) {
    return null;
  }
  const tsMs = createdAt ? Date.parse(createdAt) : Date.now();
  const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const shortConv = String(convId || "local").slice(0, 12);

  return {
    id: `${shortConv}:s${stepIndex}`,
    poolKey: classifyModelPool(modelName),
    modelName,
    requestCount: 1,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    timestampMs: Number.isFinite(tsMs) ? tsMs : Date.now(),
  };
}

/**
 * 增量扫描本机 Antigravity App / IDE 的 transcript.jsonl（仅扫描最近 48 小时修改过的文件）
 */
export function scanIncrementalTranscriptUsage(stateObj = {}, transcriptRoots = null) {
  const dirs =
    Array.isArray(transcriptRoots) && transcriptRoots.length
      ? transcriptRoots
      : getDefaultTranscriptRoots();

  if (!stateObj.fileOffsets || typeof stateObj.fileOffsets !== "object") {
    stateObj.fileOffsets = {};
  }
  const cutoffMs = Date.now() - 48 * 3600 * 1000;
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
      let offset = Number(stateObj.fileOffsets[key] || 0);
      // 首次初始化时，仅从当前文件末尾开始追踪未来新增消耗（避免把入组前历史老对话算进账单）
      if (!(key in stateObj.fileOffsets)) {
        stateObj.fileOffsets[key] = st.size;
        continue;
      }
      if (st.size < offset) offset = 0;
      if (st.size === offset) continue;

      const deltaLen = Math.min(st.size - offset, 4 * 1024 * 1024);
      const buf = Buffer.allocUnsafe(deltaLen);
      let fd = null;
      try {
        fd = fs.openSync(logPath, "r");
        const bytesRead = fs.readSync(fd, buf, 0, deltaLen, offset);
        const text = buf.subarray(0, bytesRead).toString("utf8");
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline < 0) continue; // 等待整行落盘
        const completeChunk = text.slice(0, lastNewline);
        const consumedBytes = Buffer.byteLength(completeChunk + "\n", "utf8");
        stateObj.fileOffsets[key] = offset + consumedBytes;

        for (const line of completeChunk.split(/\r?\n/)) {
          const ev = extractNumericUsageFromLine(line, convId);
          if (ev) freshEvents.push(ev);
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
  if (keys.length > 300) {
    for (const k of keys.slice(0, keys.length - 200)) {
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
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.toLowerCase())) {
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

export class MemberLedgerCollector {
  constructor({ configPath, defaultConfigPath, statePath = getDefaultStatePath(), transcriptRoots = null }) {
    this.configPath = configPath;
    this.defaultConfigPath = defaultConfigPath;
    this.statePath = statePath;
    this.transcriptRoots = transcriptRoots;
    this.config = this.loadConfig();
    this.state = readJsonSafe(this.statePath, {
      fileOffsets: {},
      pendingEvents: [],
      lastSyncAt: null,
      lastError: "",
      lastMemberView: null,
      lastLocalSnapshots: [],
    });
    scanIncrementalTranscriptUsage(this.state, this.transcriptRoots);
    this.saveState();
  }

  loadConfig() {
    const def = readJsonSafe(this.defaultConfigPath, {
      serverUrl: "",
      memberToken: "",
      memberName: "",
      syncIntervalSec: 90,
    });
    const user = readJsonSafe(this.configPath, {});
    return { ...def, ...user };
  }

  saveConfig(patch = {}) {
    this.config = {
      ...this.config,
      serverUrl: String(patch.serverUrl ?? this.config.serverUrl ?? "").trim().replace(/\/+$/, ""),
      memberToken: String(patch.memberToken ?? this.config.memberToken ?? "").trim(),
      memberName: String(patch.memberName ?? this.config.memberName ?? "").trim(),
      syncIntervalSec: Math.max(30, Math.min(600, Number(patch.syncIntervalSec ?? this.config.syncIntervalSec) || 90)),
    };
    writeJsonAtomic(this.configPath, this.config);
    return this.config;
  }

  saveState() {
    try {
      writeJsonAtomic(this.statePath, this.state);
    } catch {}
  }

  getPublicState() {
    return {
      configured: Boolean(this.config.serverUrl && this.config.memberToken),
      config: {
        serverUrl: this.config.serverUrl || "",
        memberName: this.config.memberName || "",
        hasToken: Boolean(this.config.memberToken),
        tokenPreview: this.config.memberToken ? `${this.config.memberToken.slice(0, 8)}••••` : "",
        syncIntervalSec: this.config.syncIntervalSec || 90,
      },
      pendingQueueCount: Array.isArray(this.state.pendingEvents) ? this.state.pendingEvents.length : 0,
      lastSyncAt: this.state.lastSyncAt || null,
      lastError: this.state.lastError || "",
      localSnapshots: this.state.lastLocalSnapshots || [],
      memberView: this.state.lastMemberView || null,
      clientVersion: CLIENT_VERSION,
    };
  }

  async syncOnce() {
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
      this.state.lastError = "尚未填写云端中转网址或成员凭证";
      this.saveState();
      return { ok: false, reason: "not_configured", state: this.getPublicState() };
    }

    const batch = this.state.pendingEvents.slice(0, 200);
    const endpoint = `${this.config.serverUrl.replace(/\/+$/, "")}/api/member/heartbeat`;

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "User-Agent": "AgyFamilyLedger/1.0",
          "Content-Type": "application/json",
          "X-Member-Token": this.config.memberToken,
        },
        body: JSON.stringify({
          clientVersion: CLIENT_VERSION,
          usageEvents: batch,
          quotaSnapshots: qRes.ok ? qRes.snapshots : [],
        }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error || `中转服务返回 HTTP ${resp.status}`);
      }
      this.state.pendingEvents = this.state.pendingEvents.slice(batch.length);
      this.state.lastSyncAt = new Date().toISOString();
      this.state.lastError = "";
      if (data.member) {
        this.state.lastMemberView = data.member;
      }
      this.saveState();
      return { ok: true, state: this.getPublicState() };
    } catch (err) {
      this.state.lastError = `同步暂未送达（已暂存本地队列，联网自动补传）：${String(err?.message || err)}`;
      this.saveState();
      return { ok: false, reason: err?.message || "sync_failed", state: this.getPublicState() };
    }
  }
}
