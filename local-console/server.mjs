/**
 * Antigravity 家庭组共享额度看板 · 本地管理控制台后端 (v1.4.0)
 *
 * 特性：
 * - 支持 Cloudflare Workers 云端同步与本机 SQLite 离线存储切换。
 * - 零私包分发：所有成员统一从 GitHub Releases 官方构建包或仓库源码安装插件，组长仅发送含初始约定的纯文本绑定码。
 * - 启用本地随机一次性 Session Token + Origin / Content-Type 校验，彻底防跨站请求伪造（CSRF）。
 * - 切换为云端同步模式后自动拦截本地死库心跳，并提示同步更新组长本机插件地址，杜绝本地/云端脑裂。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LedgerStore, wrapNodeSqliteAdapter } from "../shared/ledger-store.mjs";
import { formatPricingRuleSummary } from "../shared/billing-engine.mjs";
import { buildInviteCode } from "../member-plugin/sidecars/ledger/collector.mjs";
import { UpdateService } from "../member-plugin/sidecars/ledger/update-service.mjs";

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
const SESSION_TOKEN = crypto.randomBytes(24).toString("hex");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadConsoleConfig() {
  const def = {
    mode: "local", // 'local' | 'cloud'
    cloudWorkerUrl: "",
    adminSecret: "",
    autoCheckUpdates: true,
    ignoredUpdateVersion: "",
  };
  try {
    if (!fs.existsSync(CONFIG_FILE)) return def;
    const raw = fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return {
      mode: parsed.mode === "cloud" ? "cloud" : "local",
      cloudWorkerUrl: String(parsed.cloudWorkerUrl || "").trim().replace(/\/+$/, ""),
      adminSecret: String(parsed.adminSecret || "").trim(),
      autoCheckUpdates: parsed.autoCheckUpdates !== false,
      ignoredUpdateVersion: String(parsed.ignoredUpdateVersion || "").trim().replace(/^v/i, ""),
    };
  } catch {
    return def;
  }
}

function saveConsoleConfig(patch = {}) {
  const cur = loadConsoleConfig();
  const next = {
    mode: patch.mode === "cloud" || patch.mode === "local" ? patch.mode : cur.mode,
    cloudWorkerUrl:
      patch.cloudWorkerUrl !== undefined
        ? String(patch.cloudWorkerUrl).trim().replace(/\/+$/, "")
        : cur.cloudWorkerUrl,
    adminSecret:
      patch.adminSecret !== undefined && patch.adminSecret !== ""
        ? String(patch.adminSecret).trim()
        : cur.adminSecret,
    autoCheckUpdates:
      patch.autoCheckUpdates !== undefined ? Boolean(patch.autoCheckUpdates) : cur.autoCheckUpdates !== false,
    ignoredUpdateVersion:
      patch.ignoredUpdateVersion !== undefined
        ? String(patch.ignoredUpdateVersion || "").trim().replace(/^v/i, "")
        : cur.ignoredUpdateVersion,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

const consoleUpdateService = new UpdateService({
  cachePath: path.join(DATA_DIR, "update_cache.json"),
  pluginRoot: MEMBER_PLUGIN_SRC,
  getIgnoredVersion: () => loadConsoleConfig().ignoredUpdateVersion || "",
});

function inspectOwnerLocalPluginTarget(cfg, serverPort) {
  const expectedUrl =
    cfg.mode === "cloud" && cfg.cloudWorkerUrl
      ? cfg.cloudWorkerUrl.replace(/\/+$/, "")
      : `http://127.0.0.1:${serverPort}`;
  const pluginCfgPath = path.join(
    os.homedir(),
    ".gemini",
    "config",
    "plugins",
    "agy-family-ledger",
    "sidecars",
    "ledger",
    "config.json"
  );
  try {
    if (!fs.existsSync(pluginCfgPath)) {
      return { installed: false, currentServerUrl: "", needsSync: false };
    }
    const parsed = JSON.parse(fs.readFileSync(pluginCfgPath, "utf8").replace(/^\uFEFF/, ""));
    const curUrl = String(parsed?.serverUrl || "").trim().replace(/\/+$/, "");
    const needsSync = Boolean(curUrl && curUrl !== expectedUrl);
    return { installed: true, currentServerUrl: curUrl, needsSync };
  } catch {
    return { installed: false, currentServerUrl: "", needsSync: false };
  }
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
      "User-Agent": "AgyFamilyLedger/1.3",
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
    if (ent.name === "config.json" || ent.name.startsWith(".")) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * 生成指定成员的含初始规则约定的纯文本绑定信息（零私包，官方 GitHub Releases 渠道）
 */
async function buildMemberInviteInfo(memberId, serverPort) {
  const dash = await callBackend("/api/admin/dashboard", "GET");
  const member = (dash.members || []).find((m) => m.id === memberId);
  if (!member) throw new Error("未找到指定成员");
  if (member.status === "archived") {
    throw new Error("该成员已停用归档，无法生成有效绑定码");
  }

  const cfg = loadConsoleConfig();
  const s = dash.settings || {};
  const targetUrl =
    cfg.mode === "cloud" && cfg.cloudWorkerUrl
      ? cfg.cloudWorkerUrl
      : `http://127.0.0.1:${serverPort}`;

  const ruleVersion = Math.max(1, Number(s.rule_version) || 1);
  const ledgerMode = s.ledger_mode === "prepaid" ? "prepaid" : "board_only";
  const gemFen = Number(s.gemini_fen_per_weekly_pct) || 100;
  const p3Fen = Number(s.third_party_fen_per_weekly_pct) || 180;
  const poolReserveFloorPct = Number(s.pool_reserve_floor_pct) || 0;
  const memberWeeklyCapPct = Number(s.member_weekly_cap_pct) || 0;
  const applyCapToOwner = s.apply_cap_to_owner !== false;
  const usageRuleNote = String(s.usage_rule_note || "").trim();

  const inviteCode = buildInviteCode({
    serverUrl: targetUrl,
    memberToken: member.memberToken,
    ruleVersion,
    ledgerMode,
    geminiFenPerWeeklyPct: gemFen,
    thirdPartyFenPerWeeklyPct: p3Fen,
    poolReserveFloorPct,
    memberWeeklyCapPct,
    applyCapToOwner,
    usageRuleNote,
  });
  const isLocalOnly = /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(targetUrl);

  return {
    ok: true,
    memberId: member.id,
    memberName: member.name,
    serverUrl: targetUrl,
    inviteCode,
    ruleVersion,
    termsSummary: formatPricingRuleSummary(s),
    isLocalOnly,
    repoUrl: GITHUB_REPO_URL,
    releasesUrl: `${GITHUB_REPO_URL}/releases/latest`,
    collectorSourceUrl: `${GITHUB_REPO_URL}/blob/main/member-plugin/sidecars/ledger/collector.mjs`,
    gitCloneCmd: `git clone --depth 1 ${GITHUB_REPO_URL}.git`,
  };
}

/**
 * 将组长本人插件同步到本机 Antigravity 插件目录（写入最新 config.json 后运行中 Sidecar 会自动热重载）
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
  const cfgFile = path.join(dst, "sidecars", "ledger", "config.json");
  let existingProxy = "";
  let existingAutoCheck = true;
  let existingIgnoredVer = "";
  try {
    if (fs.existsSync(cfgFile)) {
      const prev = JSON.parse(fs.readFileSync(cfgFile, "utf8").replace(/^\uFEFF/, ""));
      existingProxy = String(prev?.proxyUrl || "").trim();
      if (prev?.autoCheckUpdates === false) existingAutoCheck = false;
      existingIgnoredVer = String(prev?.ignoredUpdateVersion || "").trim();
    }
  } catch {}

  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      {
        serverUrl: targetUrl,
        memberToken: owner.memberToken,
        memberName: owner.name,
        proxyUrl: existingProxy,
        syncIntervalSec: 90,
        autoCheckUpdates: existingAutoCheck,
        ignoredUpdateVersion: existingIgnoredVer,
      },
      null,
      2
    ),
    "utf8"
  );
  return { ok: true, installDir: dst, memberName: owner.name, targetUrl };
}

/**
 * 本地离线模式示例数据
 */
async function seedLocalDemoScenario() {
  const cfg = loadConsoleConfig();
  if (cfg.mode !== "local") {
    throw new Error("示例数据仅在「本机离线模式」下提供，避免写入正式云端数据");
  }
  const dash0 = await localStore.getAdminDashboard();
  const owner = dash0.members.find((m) => m.role === "owner");
  let alice = dash0.members.find((m) => m.name === "林屿（示例）" && m.status !== "archived");
  let bob = dash0.members.find((m) => m.name === "周然（示例）" && m.status !== "archived");

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

function checkLocalCsrf(req, port) {
  const origin = String(req.headers.origin || "").trim();
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    return { ok: false, error: "拒绝跨站来源请求（CSRF 防护）" };
  }
  const token = String(req.headers["x-console-token"] || "").trim();
  if (token !== SESSION_TOKEN) {
    return { ok: false, error: "缺少或无效的本地会话令牌，请刷新控制台页面重试" };
  }
  return { ok: true };
}

const PORT = Number(process.env.FAMILY_LEDGER_PORT || 18945);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  const isMemberRoute = pathname.startsWith("/api/member/");
  const isMutatingConsoleApi =
    pathname.startsWith("/api/") && !isMemberRoute && ["POST", "PATCH", "PUT", "DELETE"].includes(method);

  if (isMutatingConsoleApi) {
    const csrf = checkLocalCsrf(req, PORT);
    if (!csrf.ok) {
      return sendJson(res, { ok: false, error: csrf.error }, 403);
    }
  }

  let body = {};
  if (["POST", "PATCH", "PUT"].includes(method)) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.trim()) {
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      if (isMutatingConsoleApi && !ct.includes("application/json")) {
        return sendJson(res, { ok: false, error: "仅接受 application/json 请求体" }, 415);
      }
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJson(res, { ok: false, error: "请求体不是合法 JSON" }, 400);
      }
    }
  }

  try {
    if (pathname === "/api/health" && method === "GET") {
      const cfg = loadConsoleConfig();
      return sendJson(res, {
        ok: true,
        app: "agy-family-ledger-console",
        version: "1.4.0",
        mode: cfg.mode,
        port: PORT,
      });
    }

    if (pathname === "/api/update/status" && method === "GET") {
      const cfg = loadConsoleConfig();
      return sendJson(res, {
        ok: true,
        meta: consoleUpdateService.getPluginMeta(),
        update: consoleUpdateService.getCachedResult(),
        autoCheckUpdates: cfg.autoCheckUpdates !== false,
        ignoredUpdateVersion: cfg.ignoredUpdateVersion || "",
      });
    }
    if (pathname === "/api/update/check" && method === "GET") {
      const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
      return sendJson(res, await consoleUpdateService.checkForUpdates({ force }));
    }
    if (pathname === "/api/update/check" && method === "POST") {
      return sendJson(res, await consoleUpdateService.checkForUpdates({ force: Boolean(body?.force) }));
    }
    if (pathname === "/api/update/ignore" && method === "POST") {
      const version = String(body?.version || "").trim().replace(/^v/i, "");
      const next = saveConsoleConfig({ ignoredUpdateVersion: version });
      return sendJson(res, {
        ok: true,
        autoCheckUpdates: next.autoCheckUpdates !== false,
        ignoredUpdateVersion: next.ignoredUpdateVersion || "",
        update: consoleUpdateService.getCachedResult(),
      });
    }
    if (pathname === "/api/update/settings" && method === "POST") {
      const next = saveConsoleConfig({
        ...(typeof body?.autoCheckUpdates === "boolean" ? { autoCheckUpdates: body.autoCheckUpdates } : {}),
      });
      return sendJson(res, {
        ok: true,
        autoCheckUpdates: next.autoCheckUpdates !== false,
        ignoredUpdateVersion: next.ignoredUpdateVersion || "",
      });
    }

    if (pathname === "/api/member/heartbeat" && method === "POST") {
      const cfg = loadConsoleConfig();
      if (cfg.mode === "cloud") {
        return sendJson(
          res,
          {
            ok: false,
            error: "管理台已切换为云端同步模式，请重新点击「装到本机」或将插件绑定码更新为云端地址",
          },
          409
        );
      }
      const token = req.headers["x-member-token"] || body.memberToken || "";
      const { nowMs: _ignoredNowMs, ...safeBody } = body && typeof body === "object" ? body : {};
      return sendJson(res, await localStore.ingestHeartbeat(token, safeBody));
    }

    if (pathname === "/api/member/confirm-rules" && method === "POST") {
      const cfg = loadConsoleConfig();
      if (cfg.mode === "cloud") {
        return sendJson(res, { ok: false, error: "管理台已切换为云端同步模式，请改连云端地址" }, 409);
      }
      const token = req.headers["x-member-token"] || body.memberToken || "";
      return sendJson(res, await localStore.confirmMemberRules(token, body?.ruleVersion ?? null));
    }

    if (pathname === "/api/console-config" && method === "GET") {
      const cfg = loadConsoleConfig();
      const ownerLocal = inspectOwnerLocalPluginTarget(cfg, PORT);
      return sendJson(res, {
        ok: true,
        config: {
          mode: cfg.mode,
          cloudWorkerUrl: cfg.cloudWorkerUrl,
          hasAdminSecret: Boolean(cfg.adminSecret),
          ownerPluginInstalled: ownerLocal.installed,
          ownerPluginServerUrl: ownerLocal.currentServerUrl,
          ownerPluginNeedsSync: ownerLocal.needsSync,
        },
      });
    }
    if (pathname === "/api/console-config" && method === "PATCH") {
      const next = saveConsoleConfig(body);
      const ownerLocal = inspectOwnerLocalPluginTarget(next, PORT);
      return sendJson(res, {
        ok: true,
        config: {
          mode: next.mode,
          cloudWorkerUrl: next.cloudWorkerUrl,
          hasAdminSecret: Boolean(next.adminSecret),
          ownerPluginInstalled: ownerLocal.installed,
          ownerPluginServerUrl: ownerLocal.currentServerUrl,
          ownerPluginNeedsSync: ownerLocal.needsSync,
        },
      });
    }

    const invMatch = pathname.match(/^\/api\/invite-info\/([^/]+)$/);
    if (invMatch && method === "GET") {
      return sendJson(res, await buildMemberInviteInfo(decodeURIComponent(invMatch[1]), PORT));
    }

    if (pathname === "/api/install-owner-local" && method === "POST") {
      return sendJson(res, await installOwnerPluginLocally(PORT));
    }

    if (pathname === "/api/demo/seed" && method === "POST") {
      return sendJson(res, await seedLocalDemoScenario());
    }

    if (pathname.startsWith("/api/admin/")) {
      return sendJson(res, await callBackend(pathname, method, body));
    }

    const relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const safeFile = path.resolve(PUBLIC_DIR, relPath);
    const relCheck = path.relative(PUBLIC_DIR, safeFile);
    if (relCheck.startsWith("..") || path.isAbsolute(relCheck) || !fs.existsSync(safeFile) || fs.statSync(safeFile).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const ext = path.extname(safeFile).toLowerCase();
    if (ext === ".html") {
      const rawHtml = fs.readFileSync(safeFile, "utf8");
      const withToken = rawHtml.replace(
        "</head>",
        `  <meta name="console-token" content="${SESSION_TOKEN}"/>\n</head>`
      );
      res.writeHead(200, {
        "Content-Type": MIME[ext],
        "Cache-Control": "no-store",
      });
      res.end(withToken);
      return;
    }
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
      version: "1.4.0",
      url: `http://127.0.0.1:${PORT}`,
      mode: loadConsoleConfig().mode,
    })
  );
});
