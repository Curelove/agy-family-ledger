import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemberLedgerCollector } from "./collector.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PANEL_HTML_PATH = path.join(__dirname, "panel.html");
const CONFIG_PATH = path.join(__dirname, "config.json");
const DEFAULT_CONFIG_PATH = path.join(__dirname, "config.default.json");

async function loadOfficialSidecarSdk() {
  try {
    return await import("sidecar_sdk");
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
    const resolved = createRequire(import.meta.url).resolve("sidecar_sdk");
    return await import(pathToFileURL(resolved).href);
  }
}

function readPanelHtml() {
  return fs.readFileSync(PANEL_HTML_PATH, "utf8");
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

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp, Response } = await loadOfficialSidecarSdk();
  const app = new SidecarApp();

  app.api(
    "/",
    () =>
      new Response(readPanelHtml(), {
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
      collector.saveConfig(data || {});
      const out = await collector.syncOnce();
      return new Response(JSON.stringify(out), {
        contentType: "application/json; charset=utf-8",
        headers: { "Cache-Control": "no-store" },
      });
    },
    "POST"
  );

  app.run();
  startSyncLoop();
} else {
  // 独立预览 / 自动化测试模式（仅监听 127.0.0.1）
  const port = Number(process.env.MEMBER_LEDGER_PORT || 18946);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
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
      collector.saveConfig(body);
      const out = await collector.syncOnce();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readPanelHtml());
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ ok: true, mode: "standalone_member_preview", url: `http://127.0.0.1:${port}` }));
  });
  startSyncLoop();
}
