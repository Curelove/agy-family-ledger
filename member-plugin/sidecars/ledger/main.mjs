import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemberLedgerCollector, SidecarLease } from "./collector.mjs";
import { UpdateService } from "./update-service.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PANEL_HTML_PATH = path.join(__dirname, "panel.html");
const CONFIG_PATH = process.env.MEMBER_LEDGER_CONFIG_PATH
  ? path.resolve(process.env.MEMBER_LEDGER_CONFIG_PATH)
  : path.join(__dirname, "config.json");
const DEFAULT_CONFIG_PATH = path.join(__dirname, "config.default.json");
const STATE_PATH = process.env.MEMBER_LEDGER_STATE_PATH
  ? path.resolve(process.env.MEMBER_LEDGER_STATE_PATH)
  : null;
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const PANEL_SESSION_TOKEN = crypto.randomBytes(20).toString("hex");
const IS_HOSTED_SIDECAR = Boolean(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);

async function loadOfficialSidecarSdk() {
  try {
    return await import("sidecar_sdk");
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
    const resolved = createRequire(import.meta.url).resolve("sidecar_sdk");
    return await import(pathToFileURL(resolved).href);
  }
}

function readPanelHtml(injectToken = false) {
  const html = fs.readFileSync(PANEL_HTML_PATH, "utf8");
  if (!injectToken) return html;
  return html.replace(
    "</head>",
    `<meta name="panel-token" content="${PANEL_SESSION_TOKEN}"/>\n</head>`
  );
}

const activeTimers = [];
function registerTimer(id) {
  activeTimers.push(id);
  return id;
}
function stopAllTimers() {
  while (activeTimers.length > 0) {
    const id = activeTimers.pop();
    try {
      clearInterval(id);
      clearTimeout(id);
    } catch {}
  }
}

let sidecarLease = null;
if (IS_HOSTED_SIDECAR) {
  sidecarLease = new SidecarLease({ env: process.env });
  sidecarLease.acquire();
  sidecarLease.watchOwnership(() => {
    stopAllTimers();
    process.exit(0);
  });
}

const collector = new MemberLedgerCollector({
  configPath: CONFIG_PATH,
  defaultConfigPath: DEFAULT_CONFIG_PATH,
  statePath: STATE_PATH,
  env: process.env,
  leaseCheckFn: () => (sidecarLease ? sidecarLease.isOwner() : true),
  onSelfHealRequested: () => {
    if (!IS_HOSTED_SIDECAR) return;
    stopAllTimers();
    sidecarLease?.stop();
    const exitTimer = setTimeout(() => process.exit(1), 250);
    if (typeof exitTimer.unref === "function") exitTimer.unref();
  },
});

const updateService = new UpdateService({
  pluginRoot: PLUGIN_ROOT,
  getProxyUrl: () => collector.config.proxyUrl || "",
  getIgnoredVersion: () => collector.config.ignoredUpdateVersion || "",
});

function buildFullState() {
  const base = collector.getPublicState();
  const meta = updateService.getPluginMeta();
  return {
    ...base,
    pluginMeta: meta,
    update: updateService.getCachedResult(),
  };
}

function enrichOut(out) {
  if (!out || typeof out !== "object") return out;
  return {
    ...out,
    state: buildFullState(),
  };
}

function startSyncLoop() {
  // 1. 12 秒本地零流量账号守卫（切号即时停采 + 持续快进 EOF）
  const initGuard = setTimeout(() => {
    collector.tickAccountGuard().catch(() => {});
  }, 800);
  if (typeof initGuard.unref === "function") initGuard.unref();
  registerTimer(initGuard);

  const guardLoop = setInterval(() => {
    collector.tickAccountGuard().catch(() => {});
  }, 12_000);
  if (typeof guardLoop.unref === "function") guardLoop.unref();
  registerTimer(guardLoop);

  // 2. 90 秒云端心跳与增量上报
  const initSync = setTimeout(() => {
    collector.syncOnce().catch(() => {});
  }, 2500);
  if (typeof initSync.unref === "function") initSync.unref();
  registerTimer(initSync);

  const intervalMs = Math.max(30_000, (collector.config.syncIntervalSec || 90) * 1000);
  const syncLoop = setInterval(() => {
    collector.syncOnce().catch(() => {});
  }, intervalMs);
  if (typeof syncLoop.unref === "function") syncLoop.unref();
  registerTimer(syncLoop);

  // 3. 启动后延迟静默检查 GitHub 更新（命中 6 小时缓存时不发网络请求）
  const initUpdate = setTimeout(() => {
    collector.maybeReloadConfig();
    if (collector.config.autoCheckUpdates !== false) {
      updateService.checkForUpdates({ force: false }).catch(() => {});
    }
  }, 5500);
  if (typeof initUpdate.unref === "function") initUpdate.unref();
  registerTimer(initUpdate);
}

function isAllowedLoopbackOrigin(req, port) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

if (IS_HOSTED_SIDECAR) {
  const { SidecarApp, Response } = await loadOfficialSidecarSdk();
  const app = new SidecarApp();

  const jsonResp = (obj) =>
    new Response(JSON.stringify(obj), {
      contentType: "application/json; charset=utf-8",
      headers: { "Cache-Control": "no-store" },
    });

  app.api(
    "/",
    () =>
      new Response(readPanelHtml(false), {
        contentType: "text/html; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
      }),
    "GET"
  );

  app.api("/api/state", () => jsonResp(buildFullState()), "GET");

  app.api(
    "/api/sync-now",
    async () => {
      const out = await collector.syncOnce();
      return jsonResp(enrichOut(out));
    },
    "POST"
  );

  app.api(
    "/api/pause-toggle",
    async (data) => {
      try {
        const paused = Boolean(data?.paused);
        collector.setManualPaused(paused);
        const out = collector.config.serverUrl && collector.config.memberToken
          ? await collector.syncOnce()
          : { ok: true };
        return jsonResp(enrichOut(out));
      } catch (err) {
        return jsonResp({ ok: false, error: String(err?.message || err), state: buildFullState() });
      }
    },
    "POST"
  );

  app.api(
    "/api/rebind-account",
    async () => {
      try {
        await collector.rebindToCurrentAccount();
        const out = await collector.syncOnce();
        return jsonResp(enrichOut(out));
      } catch (err) {
        return jsonResp({ ok: false, error: String(err?.message || err), state: buildFullState() });
      }
    },
    "POST"
  );

  app.api(
    "/api/retry-identity",
    async () => {
      try {
        const out = await collector.retryIdentityCheck();
        return jsonResp(enrichOut(out));
      } catch (err) {
        return jsonResp({ ok: false, error: String(err?.message || err), state: buildFullState() });
      }
    },
    "POST"
  );

  app.api(
    "/api/config",
    async (data) => {
      try {
        collector.saveConfig(data || {});
        const out = await collector.syncOnce();
        return jsonResp(enrichOut(out));
      } catch (err) {
        return jsonResp({ ok: false, error: String(err?.message || err), state: buildFullState() });
      }
    },
    "POST"
  );

  app.api(
    "/api/confirm-rules",
    async () => {
      try {
        const out = await collector.confirmRules();
        return jsonResp(enrichOut(out));
      } catch (err) {
        return jsonResp({ ok: false, error: String(err?.message || err), state: buildFullState() });
      }
    },
    "POST"
  );

  app.api(
    "/api/unbind",
    () => {
      collector.unbind();
      return jsonResp({ ok: true, state: buildFullState() });
    },
    "POST"
  );

  app.api(
    "/api/update/status",
    () => {
      collector.maybeReloadConfig();
      return jsonResp({
        ok: true,
        meta: updateService.getPluginMeta(),
        update: updateService.getCachedResult(),
        autoCheckUpdates: collector.config.autoCheckUpdates !== false,
        ignoredUpdateVersion: collector.config.ignoredUpdateVersion || "",
      });
    },
    "GET"
  );

  app.api(
    "/api/update/check",
    async (data) => {
      collector.maybeReloadConfig();
      const force = data?.force === "1" || data?.force === "true" || Boolean(data?.force);
      const res = await updateService.checkForUpdates({ force });
      return jsonResp(res);
    },
    "GET"
  );

  app.api(
    "/api/update/check",
    async (data) => {
      collector.maybeReloadConfig();
      const res = await updateService.checkForUpdates({ force: Boolean(data?.force) });
      return jsonResp(res);
    },
    "POST"
  );

  app.api(
    "/api/update/ignore",
    (data) => {
      const version = String(data?.version || "").trim().replace(/^v/i, "");
      collector.saveConfig({ ignoredUpdateVersion: version });
      return jsonResp({
        ok: true,
        update: updateService.getCachedResult(),
        state: buildFullState(),
      });
    },
    "POST"
  );

  app.api(
    "/api/update/settings",
    (data) => {
      if (data && typeof data.autoCheckUpdates === "boolean") {
        collector.saveConfig({ autoCheckUpdates: data.autoCheckUpdates });
      }
      return jsonResp({
        ok: true,
        state: buildFullState(),
      });
    },
    "POST"
  );

  app.run();
  startSyncLoop();
} else {
  // 独立预览 / 自动化测试模式（仅监听 127.0.0.1，启用 Origin + 随机一次性 Token 防 CSRF）
  const port = Number(process.env.MEMBER_LEDGER_PORT || 18946);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (req.method === "POST") {
      if (!isAllowedLoopbackOrigin(req, port) || req.headers["x-panel-token"] !== PANEL_SESSION_TOKEN) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "来源校验失败（防跨站请求保护）" }));
        return;
      }
    }

    let body = {};
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {}
    }

    const sendJson = (obj, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };

    if (u.pathname === "/api/state" && req.method === "GET") {
      return sendJson(buildFullState());
    }
    if (u.pathname === "/api/sync-now" && req.method === "POST") {
      const out = await collector.syncOnce();
      return sendJson(enrichOut(out));
    }
    if (u.pathname === "/api/pause-toggle" && req.method === "POST") {
      try {
        collector.setManualPaused(Boolean(body?.paused));
        const out = collector.config.serverUrl && collector.config.memberToken
          ? await collector.syncOnce()
          : { ok: true };
        return sendJson(enrichOut(out));
      } catch (err) {
        return sendJson({ ok: false, error: String(err?.message || err), state: buildFullState() }, 400);
      }
    }
    if (u.pathname === "/api/rebind-account" && req.method === "POST") {
      try {
        await collector.rebindToCurrentAccount();
        const out = await collector.syncOnce();
        return sendJson(enrichOut(out));
      } catch (err) {
        return sendJson({ ok: false, error: String(err?.message || err), state: buildFullState() }, 400);
      }
    }
    if (u.pathname === "/api/retry-identity" && req.method === "POST") {
      try {
        const out = await collector.retryIdentityCheck();
        return sendJson(enrichOut(out));
      } catch (err) {
        return sendJson({ ok: false, error: String(err?.message || err), state: buildFullState() }, 400);
      }
    }
    if (u.pathname === "/api/config" && req.method === "POST") {
      try {
        collector.saveConfig(body);
        const out = await collector.syncOnce();
        return sendJson(enrichOut(out));
      } catch (err) {
        return sendJson({ ok: false, error: String(err?.message || err), state: buildFullState() }, 400);
      }
    }
    if (u.pathname === "/api/confirm-rules" && req.method === "POST") {
      try {
        const out = await collector.confirmRules();
        return sendJson(enrichOut(out));
      } catch (err) {
        return sendJson({ ok: false, error: String(err?.message || err), state: buildFullState() }, 400);
      }
    }
    if (u.pathname === "/api/unbind" && req.method === "POST") {
      collector.unbind();
      return sendJson({ ok: true, state: buildFullState() });
    }
    if (u.pathname === "/api/update/status" && req.method === "GET") {
      collector.maybeReloadConfig();
      return sendJson({
        ok: true,
        meta: updateService.getPluginMeta(),
        update: updateService.getCachedResult(),
        autoCheckUpdates: collector.config.autoCheckUpdates !== false,
        ignoredUpdateVersion: collector.config.ignoredUpdateVersion || "",
      });
    }
    if (u.pathname === "/api/update/check" && req.method === "GET") {
      collector.maybeReloadConfig();
      const force = u.searchParams.get("force") === "1" || u.searchParams.get("force") === "true";
      return sendJson(await updateService.checkForUpdates({ force }));
    }
    if (u.pathname === "/api/update/check" && req.method === "POST") {
      collector.maybeReloadConfig();
      return sendJson(await updateService.checkForUpdates({ force: Boolean(body?.force) }));
    }
    if (u.pathname === "/api/update/ignore" && req.method === "POST") {
      const version = String(body?.version || "").trim().replace(/^v/i, "");
      collector.saveConfig({ ignoredUpdateVersion: version });
      return sendJson({ ok: true, update: updateService.getCachedResult(), state: buildFullState() });
    }
    if (u.pathname === "/api/update/settings" && req.method === "POST") {
      if (typeof body?.autoCheckUpdates === "boolean") {
        collector.saveConfig({ autoCheckUpdates: body.autoCheckUpdates });
      }
      return sendJson({ ok: true, state: buildFullState() });
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readPanelHtml(true));
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ ok: true, mode: "standalone_member_preview", url: `http://127.0.0.1:${port}` }));
  });
  startSyncLoop();
}
