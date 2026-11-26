/**
 * Antigravity 家庭组共享额度看板 · 本地管理控制台后端
 *
 * 特性：
 * - 支持 Cloudflare Workers 云端同步与本机 SQLite 离线存储切换。
 * - 零私包分发：所有成员统一从 GitHub 官方公开源安装插件，组长仅生成单行纯文本绑定码（https://域名#agf_xxxx）。
 * - 一键将组长本人插件同步到本机 Antigravity 目录。
 * - 兼容原生 WebView2 .exe 宿主规范（支持 FAMILY_LEDGER_PORT 与 /api/health 签名校验）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LedgerStore, wrapNodeSqliteAdapter } from "../shared/ledger-store.mjs";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.FAMILY_LEDGER_DATA_DIR
  ? path.resolve(process.env.FAMILY_LEDGER_DATA_DIR)
  : path.join(__dirname, "data");
const MEMBER_PLUGIN_SRC = path.join(PROJECT_ROOT, "member-plugin");
const SCHEMA_PATH = path.join(PROJECT_ROOT, "shared", "schema.sql");
const CONFIG_FILE = path.join(DATA_DIR, "console_config.json");
const LOCAL_DB_FILE = path.join(DATA_DIR, "local_ledger.sqlite");
const GITHUB_REPO_URL = "https://github.com/Curelove/agy-family-ledger";

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadConsoleConfig() {
  const def = {
    mode: "local", // 'local' | 'cloud'
    cloudWorkerUrl: "",
    adminSecret: "",
    enableQqAlertForward: false,
    ownerQqUin: "",
    qqBridgeScript: "",
  };
  try {
    if (!fs.existsSync(CONFIG_FILE)) return def;
    const raw = fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
    return { ...def, ...(raw.trim() ? JSON.parse(raw) : {}) };
  } catch {
    return def;
  }
}

function saveConsoleConfig(patch = {}) {
  const cur = loadConsoleConfig();
  const next = {
    ...cur,
    mode: patch.mode === "cloud" || patch.mode === "local" ? patch.mode : cur.mode,
    cloudWorkerUrl:
      patch.cloudWorkerUrl !== undefined
        ? String(patch.cloudWorkerUrl).trim().replace(/\/+$/, "")
        : cur.cloudWorkerUrl,
    adminSecret:
      patch.adminSecret !== undefined && patch.adminSecret !== ""
        ? String(patch.adminSecret).trim()
        : cur.adminSecret,
    enableQqAlertForward:
      patch.enableQqAlertForward !== undefined ? Boolean(patch.enableQqAlertForward) : cur.enableQqAlertForward,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

const sqliteDb = new DatabaseSync(LOCAL_DB_FILE);
const localStore = new LedgerStore(wrapNodeSqliteAdapter(sqliteDb));
await localStore.ensureSchema(fs.readFileSync(SCHEMA_PATH, "utf8"));

async function proxyToCloud(cfg, apiPath, method = "GET", body = null) {
  if (!cfg.cloudWorkerUrl || !cfg.adminSecret) {
    throw new Error("云端模式需先填写 Cloudflare Worker 地址和管理员密钥");
  }
  const url = `${cfg.cloudWorkerUrl}${apiPath}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "User-Agent": "AgyFamilyLedger/1.1",
      "Content-Type": "application/json",
      "X-Admin-Secret": cfg.adminSecret,
    },
    ...(body !== null && method !== "GET" ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) {
    throw new Error(data?.error || `云端接口返回 HTTP ${resp.status}`);
  }
  return data;
}

async function callBackend(apiPath, method = "GET", body = null) {
  const cfg = loadConsoleConfig();
  if (cfg.mode === "cloud") {
    return await proxyToCloud(cfg, apiPath, method, body);
  }
  if (apiPath === "/api/admin/dashboard" && method === "GET") {
    return await localStore.getAdminDashboard();
  }
  if (apiPath === "/api/admin/members" && method === "POST") {
    return { ok: true, member: await localStore.createMember(body) };
  }
  const mMatch = apiPath.match(/^\/api\/admin\/members\/([^/]+)$/);
  if (mMatch && method === "PATCH") {
    return { ok: true, member: await localStore.updateMember(decodeURIComponent(mMatch[1]), body) };
  }
  if (mMatch && method === "DELETE") {
    return await localStore.deleteMember(decodeURIComponent(mMatch[1]));
  }
  const txMatch = apiPath.match(/^\/api\/admin\/members\/([^/]+)\/transactions$/);
  if (txMatch && method === "POST") {
    return await localStore.recordTransaction(decodeURIComponent(txMatch[1]), body);
  }
  if (apiPath === "/api/admin/settings" && method === "PATCH") {
    return { ok: true, settings: await localStore.updateSettings(body) };
  }
  const ackMatch = apiPath.match(/^\/api\/admin\/alerts\/([^/]+)\/ack$/);
  if (ackMatch && method === "POST") {
    return await localStore.acknowledgeAlert(decodeURIComponent(ackMatch[1]));
  }
  throw new Error(`未知接口: ${method} ${apiPath}`);
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 生成指定成员的纯文本绑定信息（不生成任何私发压缩包）
 */
async function buildMemberInviteInfo(memberId, serverPort) {
  const dash = await callBackend("/api/admin/dashboard", "GET");
  const member = (dash.members || []).find((m) => m.id === memberId);
  if (!member) throw new Error("未找到指定成员");

  const cfg = loadConsoleConfig();
  const targetUrl =
    cfg.mode === "cloud" && cfg.cloudWorkerUrl
      ? cfg.cloudWorkerUrl
      : `http://127.0.0.1:${serverPort}`;

  const inviteCode = `${targetUrl}#${member.memberToken}`;
  const isLocalOnly = /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(targetUrl);

  return {
    ok: true,
    memberId: member.id,
    memberName: member.name,
    serverUrl: targetUrl,
    inviteCode,
    isLocalOnly,
    repoUrl: GITHUB_REPO_URL,
    releasesUrl: `${GITHUB_REPO_URL}/releases/latest`,
    collectorSourceUrl: `${GITHUB_REPO_URL}/blob/main/member-plugin/sidecars/ledger/collector.mjs`,
    marketCmd: `npx agy-market add ${GITHUB_REPO_URL}/tree/main/member-plugin`,
  };
}

/**
 * 将组长本人插件同步到本机 Antigravity 插件目录
 */
async function installOwnerPluginLocally(serverPort) {
  const dash = await callBackend("/api/admin/dashboard", "GET");
  const owner = (dash.members || []).find((m) => m.role === "owner") || (dash.members || [])[0];
  if (!owner) throw new Error("未找到组长记录");

  const cfg = loadConsoleConfig();
  const targetUrl =
    cfg.mode === "cloud" && cfg.cloudWorkerUrl
      ? cfg.cloudWorkerUrl
      : `http://127.0.0.1:${serverPort}`;

  const dst = path.join(os.homedir(), ".gemini", "config", "plugins", "agy-family-ledger");
  copyDirSync(MEMBER_PLUGIN_SRC, dst);
  fs.writeFileSync(
    path.join(dst, "sidecars", "ledger", "config.json"),
    JSON.stringify(
      {
        serverUrl: targetUrl,
        memberToken: owner.memberToken,
        memberName: owner.name,
        syncIntervalSec: 90,
      },
      null,
      2
    ),
    "utf8"
  );
  return { ok: true, installDir: dst, memberName: owner.name, targetUrl };
}

/**
 * 本地离线模式示例数据：写入 2 位演示成员的多池消耗，保留当前所选运行模式（纯看板或按量记账）
 */
async function seedLocalDemoScenario() {
  const cfg = loadConsoleConfig();
  if (cfg.mode !== "local") {
    throw new Error("示例数据仅在「本机离线模式」下提供，避免写入正式云端数据");
  }
  const dash0 = await localStore.getAdminDashboard();
  const owner = dash0.members.find((m) => m.role === "owner");
  let alice = dash0.members.find((m) => m.name === "林屿（示例）");
  let bob = dash0.members.find((m) => m.name === "周然（示例）");

  if (!alice) {
    alice = await localStore.createMember({
      name: "林屿（示例）",
      role: "member",
      initialBalanceFen: 2000,
      lowBalanceFen: 300,
      note: "日常写前端与脚本",
    });
  }
  if (!bob) {
    bob = await localStore.createMember({
      name: "周然（示例）",
      role: "member",
      initialBalanceFen: 500,
      lowBalanceFen: 200,
      note: "文档整理与检索",
    });
  }

  const now = Date.now();
  const resetIso = new Date(now + 4 * 24 * 3600 * 1000).toISOString();
  const t0 = now - 25 * 60 * 1000;
  const t1 = now - 12 * 60 * 1000;
  const t2 = now - 2 * 60 * 1000;

  await localStore.ingestHeartbeat(
    owner.memberToken,
    {
      nowMs: t0,
      quotaSnapshots: [
        { poolKey: "gemini", windowKey: "weekly", remainingPct: 92.0, resetAt: resetIso, capturedAtMs: t0 },
        { poolKey: "gemini", windowKey: "5h", remainingPct: 96.0, resetAt: new Date(now + 3 * 3600 * 1000).toISOString(), capturedAtMs: t0 },
        { poolKey: "3p", windowKey: "weekly", remainingPct: 96.0, resetAt: resetIso, capturedAtMs: t0 },
        { poolKey: "3p", windowKey: "5h", remainingPct: 100.0, resetAt: new Date(now + 3 * 3600 * 1000).toISOString(), capturedAtMs: t0 },
      ],
    },
    { allowClientNowMs: true }
  );

  await localStore.ingestHeartbeat(
    alice.member_token || alice.memberToken,
    {
      nowMs: t1 - 2000,
      usageEvents: [
        { id: `demo_a_${t1}`, modelName: "gemini-4-carbon-high", uncachedInputTokens: 350000, outputTokens: 90000, timestampMs: t1 - 4000 },
      ],
    },
    { allowClientNowMs: true }
  );
  await localStore.ingestHeartbeat(
    bob.member_token || bob.memberToken,
    {
      nowMs: t1 - 1000,
      usageEvents: [
        { id: `demo_b_${t1}`, modelName: "gemini-4-hydrogen-high", uncachedInputTokens: 180000, outputTokens: 60000, timestampMs: t1 - 3000 },
      ],
    },
    { allowClientNowMs: true }
  );
  await localStore.ingestHeartbeat(
    owner.memberToken,
    {
      nowMs: t1,
      usageEvents: [
        { id: `demo_o_${t1}`, modelName: "gemini-4-neon-xhigh", uncachedInputTokens: 400000, outputTokens: 120000, timestampMs: t1 - 5000 },
      ],
      quotaSnapshots: [
        { poolKey: "gemini", windowKey: "weekly", remainingPct: 86.0, resetAt: resetIso, capturedAtMs: t1 },
        { poolKey: "gemini", windowKey: "5h", remainingPct: 78.0, resetAt: new Date(now + 3 * 3600 * 1000).toISOString(), capturedAtMs: t1 },
      ],
    },
    { allowClientNowMs: true }
  );

  await localStore.ingestHeartbeat(
    alice.member_token || alice.memberToken,
    {
      nowMs: t2 - 1000,
      usageEvents: [
        { id: `demo_a3p_${t2}`, modelName: "claude-opus-5-5-high", uncachedInputTokens: 120000, outputTokens: 45000, timestampMs: t2 - 2000 },
      ],
    },
    { allowClientNowMs: true }
  );
  await localStore.ingestHeartbeat(
    owner.memberToken,
    {
      nowMs: t2,
      quotaSnapshots: [
        { poolKey: "3p", windowKey: "weekly", remainingPct: 91.5, resetAt: resetIso, capturedAtMs: t2 },
        { poolKey: "3p", windowKey: "5h", remainingPct: 84.0, resetAt: new Date(now + 3 * 3600 * 1000).toISOString(), capturedAtMs: t2 },
      ],
    },
    { allowClientNowMs: true }
  );

  return { ok: true, message: "已填充本地示例数据" };
}

async function pollAndForwardQqAlerts() {
  const cfg = loadConsoleConfig();
  const bridgeScript = String(cfg.qqBridgeScript || process.env.AGY_QQ_BRIDGE_SCRIPT || "").trim();
  const targetUser = String(cfg.ownerQqUin || process.env.AGY_OWNER_QQ_UIN || "").trim();
  if (!cfg.enableQqAlertForward || !bridgeScript || !targetUser || !fs.existsSync(bridgeScript)) return;
  try {
    const res =
      cfg.mode === "cloud"
        ? await proxyToCloud(cfg, "/api/admin/alerts/unnotified", "GET")
        : { ok: true, alerts: await localStore.getUnnotifiedAlerts() };
    const list = Array.isArray(res?.alerts) ? res.alerts : [];
    if (list.length === 0) return;

    const lines = list.map((a) => `• [${a.severity === "critical" ? "严重" : "提醒"}] ${a.title}：${a.detail}`);
    const text = `【家庭组额度看板提醒】\n${lines.join("\n")}`;
    await execFileAsync(
      process.execPath,
      [bridgeScript, "send-private", "--user", targetUser, "--text", text],
      { windowsHide: true, timeout: 15000 }
    );
    const ids = list.map((a) => a.id);
    if (cfg.mode === "cloud") {
      await proxyToCloud(cfg, "/api/admin/alerts/mark-notified", "POST", { ids });
    } else {
      await localStore.markAlertsQqNotified(ids);
    }
  } catch {
    // 推送未就绪时静默跳过
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

const PORT = Number(process.env.FAMILY_LEDGER_PORT || 18945);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  let body = {};
  if (["POST", "PATCH", "PUT"].includes(req.method || "")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJson(res, { ok: false, error: "请求体不是合法 JSON" }, 400);
      }
    }
  }

  try {
    if (pathname === "/api/health" && req.method === "GET") {
      const cfg = loadConsoleConfig();
      return sendJson(res, {
        ok: true,
        app: "agy-family-ledger-console",
        version: "1.1.0",
        mode: cfg.mode,
        port: PORT,
      });
    }

    if (pathname === "/api/member/heartbeat" && req.method === "POST") {
      const token = req.headers["x-member-token"] || body.memberToken || "";
      const { nowMs: _ignoredNowMs, ...safeBody } = body && typeof body === "object" ? body : {};
      return sendJson(res, await localStore.ingestHeartbeat(token, safeBody));
    }

    if (pathname === "/api/console-config" && req.method === "GET") {
      const cfg = loadConsoleConfig();
      return sendJson(res, {
        ok: true,
        config: {
          mode: cfg.mode,
          cloudWorkerUrl: cfg.cloudWorkerUrl,
          hasAdminSecret: Boolean(cfg.adminSecret),
          enableQqAlertForward: cfg.enableQqAlertForward,
          hasLocalPushConfig: Boolean(cfg.qqBridgeScript && cfg.ownerQqUin),
        },
      });
    }
    if (pathname === "/api/console-config" && req.method === "PATCH") {
      const next = saveConsoleConfig(body);
      return sendJson(res, {
        ok: true,
        config: {
          mode: next.mode,
          cloudWorkerUrl: next.cloudWorkerUrl,
          hasAdminSecret: Boolean(next.adminSecret),
          enableQqAlertForward: next.enableQqAlertForward,
          hasLocalPushConfig: Boolean(next.qqBridgeScript && next.ownerQqUin),
        },
      });
    }

    const invMatch = pathname.match(/^\/api\/invite-info\/([^/]+)$/);
    if (invMatch && req.method === "GET") {
      return sendJson(res, await buildMemberInviteInfo(decodeURIComponent(invMatch[1]), PORT));
    }

    if (pathname === "/api/install-owner-local" && req.method === "POST") {
      return sendJson(res, await installOwnerPluginLocally(PORT));
    }

    if (pathname === "/api/demo/seed" && req.method === "POST") {
      return sendJson(res, await seedLocalDemoScenario());
    }

    if (pathname.startsWith("/api/admin/")) {
      return sendJson(res, await callBackend(pathname, req.method || "GET", body));
    }

    const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const safeFile = path.resolve(PUBLIC_DIR, relPath);
    if (!safeFile.startsWith(PUBLIC_DIR) || !fs.existsSync(safeFile) || fs.statSync(safeFile).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const ext = path.extname(safeFile).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(safeFile).pipe(res);
  } catch (err) {
    sendJson(res, { ok: false, error: String(err?.message || err) }, 400);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      ok: true,
      app: "agy-family-ledger-console",
      version: "1.1.0",
      url: `http://127.0.0.1:${PORT}`,
      mode: loadConsoleConfig().mode,
    })
  );
});

setInterval(() => {
  pollAndForwardQqAlerts().catch(() => {});
}, 60_000).unref();
