import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemberLedgerCollector } from "./collector.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PANEL_HTML_PATH = path.join(__dirname, "panel.html");
const CONFIG_PATH = path.join(__dirname, "config.json");
const DEFAULT_CONFIG_PATH = path.join(__dirname, "config.default.json");
const PANEL_SESSION_TOKEN = crypto.randomBytes(20).toString("hex");

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

const collector = new MemberLedgerCollector({
  configPath: CONFIG_PATH,
  defaultConfigPath: DEFAULT_CONFIG_PATH,
});

function startSyncLoop() {
  setTimeout(() => {
    collector.syncOnce().catch(() => {});
  }, 2500);
  const intervalMs = Math.max(30_000, (collector.config.syncIntervalSec || 90) * 1000);
  setInterval(() => {
    collector.syncOnce().catch(() => {});
  }, intervalMs).unref();
}

function isAllowedLoopbackOrigin(req, port) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp, Response } = await loadOfficialSidecarSdk();
  const app = new SidecarApp();

  app.api(
    "/",
    () =>
      new Response(readPanelHtml(false), {
        contentType: "text/html; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
      }),
    "GET"
  );

  app.api(
    "/api/state",
    () =>
      new Response(JSON.stringify(collector.getPublicState()), {
        contentType: "application/json; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
      }),
    "GET"
  );

  app.api(
    "/api/sync-now",
    async () => {
      const out = await collector.syncOnce();
      return new Response(JSON.stringify(out), {
        contentType: "application/json; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
      });
    },
    "POST"
  );

  app.api(
    "/api/config",
    async (data) => {
      try {
        collector.saveConfig(data || {});
        const out = await collector.syncOnce();
        return new Response(JSON.stringify(out), {
          contentType: "application/json; charset=utf-8",
          headers: { "Cache-Control": "no-store" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: String(err?.message || err), state: collector.getPublicState() }),
          {
            contentType: "application/json; charset=utf-8",
            headers: { "Cache-Control": "no-store" },
          }
        );
      }
    },
    "POST"
  );

  app.api(
    "/api/confirm-rules",
    async () => {
      try {
        const out = await collector.confirmRules();
        return new Response(JSON.stringify(out), {
          contentType: "application/json; charset=utf-8",
          headers: { "Cache-Control": "no-store" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: String(err?.message || err), state: collector.getPublicState() }),
          {
            contentType: "application/json; charset=utf-8",
            headers: { "Cache-Control": "no-store" },
          }
        );
      }
    },
    "POST"
  );

  app.api(
    "/api/unbind",
    () => {
      const state = collector.unbind();
      return new Response(JSON.stringify({ ok: true, state }), {
        contentType: "application/json; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
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

    if (u.pathname === "/api/state" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(collector.getPublicState()));
      return;
    }
    if (u.pathname === "/api/sync-now" && req.method === "POST") {
      const out = await collector.syncOnce();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }
    if (u.pathname === "/api/config" && req.method === "POST") {
      try {
        collector.saveConfig(body);
        const out = await collector.syncOnce();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(err?.message || err), state: collector.getPublicState() }));
      }
      return;
    }
    if (u.pathname === "/api/confirm-rules" && req.method === "POST") {
      try {
        const out = await collector.confirmRules();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(err?.message || err), state: collector.getPublicState() }));
      }
      return;
    }
    if (u.pathname === "/api/unbind" && req.method === "POST") {
      const state = collector.unbind();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, state }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readPanelHtml(true));
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ ok: true, mode: "standalone_member_preview", url: `http://127.0.0.1:${port}` }));
  });
  startSyncLoop();
}
