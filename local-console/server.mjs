/**
 * Antigravity 熟人家庭组额度账本 · 管理员本地桌面工作台后端
 *
 * 特性：
 * - 双模式：支持直连 Cloudflare Workers 云端中转（生产），也内置本地 Node SQLite 离线账本（即开即用/仿真演练）。
 * - 一键生成「熟人专属安装袋 (.zip)」：自动预填中转网址与专属成员码，附纯 ASCII+CRLF 双击安装脚本，熟人零配置门槛。
 * - 一键把组长本人插件安装到本机 Antigravity（免扣费、计入总池占比防误报黑洞）。
 * - 严格遵守原生 WebView2 .exe 宿主规范：支持 FAMILY_LEDGER_PORT、--no-browser 与唯一签名 /api/health。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LedgerStore, wrapNodeSqliteAdapter, randomHex } from "../shared/ledger-store.mjs";
import { formatYuan } from "../shared/billing-engine.mjs";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const EXPORTS_DIR = path.join(PROJECT_ROOT, "exports");
const MEMBER_PLUGIN_SRC = path.join(PROJECT_ROOT, "member-plugin");
const SCHEMA_PATH = path.join(PROJECT_ROOT, "shared", "schema.sql");
const CONFIG_FILE = path.join(DATA_DIR, "console_config.json");
const LOCAL_DB_FILE = path.join(DATA_DIR, "local_ledger.sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

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

// 初始化本地 SQLite 账本实例
const sqliteDb = new DatabaseSync(LOCAL_DB_FILE);
const localStore = new LedgerStore(wrapNodeSqliteAdapter(sqliteDb));
await localStore.ensureSchema(fs.readFileSync(SCHEMA_PATH, "utf8"));

async function proxyToCloud(cfg, apiPath, method = "GET", body = null) {
  if (!cfg.cloudWorkerUrl || !cfg.adminSecret) {
    throw new Error("云端模式需先填写 Cloudflare Worker 网址和管理员密钥");
  }
  const url = `${cfg.cloudWorkerUrl}${apiPath}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "User-Agent": "AgyFamilyLedger/1.0",
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
  // 本地 SQLite 路由
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
 * 为指定熟人打包专属安装袋（.zip）：
 * - 已预填云端中转网址和该熟人的 memberToken（熟人零手配）
 * - 附纯 ASCII + CRLF 的 Windows 一键安装脚本 install_windows.cmd 和 macOS/Linux 脚本
 * - 附 5 步大白话安装说明
 */
async function exportMemberInstallBundle(memberId, serverPort) {
  const dash = await callBackend("/api/admin/dashboard", "GET");
  const member = (dash.members || []).find((m) => m.id === memberId);
  if (!member) throw new Error("未找到指定成员");

  const cfg = loadConsoleConfig();
  const targetUrl =
    cfg.mode === "cloud" && cfg.cloudWorkerUrl
      ? cfg.cloudWorkerUrl
      : `http://127.0.0.1:${serverPort}`;

  const safeName = member.name.replace(/[<>:"/\\|?*\s]+/g, "_").slice(0, 28) || member.id;
  const stageDir = path.join(os.tmpdir(), `agy_ledger_bundle_${randomHex(5)}`);
  const bundleRoot = path.join(stageDir, `${safeName}_AGY家庭组账本安装袋`);
  const pluginDst = path.join(bundleRoot, "agy-family-ledger");
  const zipPath = path.join(EXPORTS_DIR, `${safeName}_AGY家庭组账本安装袋.zip`);

  try {
    copyDirSync(MEMBER_PLUGIN_SRC, pluginDst);
    const prefilledConfig = {
      serverUrl: targetUrl,
      memberToken: member.memberToken,
      memberName: member.name,
      syncIntervalSec: 90,
    };
    fs.writeFileSync(
      path.join(pluginDst, "sidecars", "ledger", "config.json"),
      JSON.stringify(prefilledConfig, null, 2),
      "utf8"
    );

    // 纯 7-bit ASCII + CRLF Windows 安装脚本（跨中文目录安全使用 %~dp0）
    const winCmd = [
      "@echo off",
      "setlocal",
      "set \"SRC=%~dp0agy-family-ledger\"",
      "set \"DST=%USERPROFILE%\\.gemini\\config\\plugins\\agy-family-ledger\"",
      "echo ========================================================",
      "echo   AGY Family Ledger Plugin Installer (Windows)",
      "echo ========================================================",
      "if not exist \"%SRC%\\plugin.json\" (",
      "  echo [ERROR] Missing agy-family-ledger folder next to this script.",
      "  pause",
      "  exit /b 1",
      ")",
      "if not exist \"%USERPROFILE%\\.gemini\\config\\plugins\" mkdir \"%USERPROFILE%\\.gemini\\config\\plugins\"",
      "xcopy /E /I /Y \"%SRC%\" \"%DST%\" >nul",
      "if errorlevel 1 (",
      "  echo [ERROR] Copy failed. Please close Antigravity and retry.",
      "  pause",
      "  exit /b 1",
      ")",
      "echo [OK] Installed to: %DST%",
      "echo Next step: Restart Antigravity, or open Customizations to enable the plugin.",
      "pause",
      "exit /b 0",
    ].join("\r\n") + "\r\n";
    fs.writeFileSync(path.join(bundleRoot, "install_windows.cmd"), winCmd, "ascii");

    const unixSh = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'DST="$HOME/.gemini/config/plugins/agy-family-ledger"',
      'mkdir -p "$HOME/.gemini/config/plugins"',
      'rm -rf "$DST"',
      'cp -R "$DIR/agy-family-ledger" "$DST"',
      'echo "[OK] Installed to $DST"',
      'echo "Please restart Antigravity or enable the plugin in Customizations."',
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(bundleRoot, "install_macos_linux.sh"), unixSh, "utf8");

    const readmeTxt = [
      `【${dash.settings?.family_name || "家庭组额度账本"} · ${member.name} 专属安装袋】`,
      "",
      "本安装袋已由组长提前填好你的专属成员码与记账网址，安装后无需任何手动配置。",
      "",
      "一、Windows 安装步骤（30 秒搞定）",
      "1. 将整个压缩包完整解压到一个普通文件夹（不要在压缩包预览窗口里直接双击）。",
      "2. 双击运行解压后的 install_windows.cmd，看到 [OK] 提示后按任意键关闭。",
      "3. 重启 Antigravity（或点击左侧栏顶部的「自定义扩展」确认「家庭组额度账本」已开启）。",
      "4. 在右侧边栏打开「家庭组额度账本」，看到你的名字和余额即表示连接成功。",
      "",
      "二、macOS / Linux 安装步骤",
      "打开终端，进入解压目录执行：bash install_macos_linux.sh ，随后重启 Antigravity。",
      "",
      "三、隐私边界承诺",
      "- 插件只读取 Antigravity 本地日志中的纯数字 Token 统计与官方剩余配额百分比。",
      "- 绝不读取你的代码文件、对话正文、思考过程、电脑运行进程、代理软件或账号密码。",
      "- 如需核查代码，可直接用记事本打开 agy-family-ledger/sidecars/ledger/collector.mjs 逐行审阅。",
      "",
      `中转地址：${targetUrl}`,
      `专属成员：${member.name}`,
    ].join("\r\n");
    fs.writeFileSync(path.join(bundleRoot, "安装说明.txt"), readmeTxt, "utf8");

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -Path '${bundleRoot.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true, timeout: 20000 }
    );
    return {
      ok: true,
      zipPath,
      fileName: path.basename(zipPath),
      targetUrl,
      isLocalPreviewUrl: targetUrl.includes("127.0.0.1"),
    };
  } finally {
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * 一键把组长本人的插件安装到本机 Antigravity 插件目录
 */
async function installOwnerPluginLocally(serverPort) {
  const dash = await callBackend("/api/admin/dashboard", "GET");
  const owner = (dash.members || []).find((m) => m.role === "owner") || (dash.members || [])[0];
  if (!owner) throw new Error("未找到组长账号记录");

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
 * 本地仿真演练：一键灌入 2 位熟人并发消耗 + 充值 + 官方配额重置 + 疑似未上报黑洞，方便立刻验收全部流程
 */
async function seedLocalDemoScenario() {
  const cfg = loadConsoleConfig();
  if (cfg.mode !== "local") {
    throw new Error("为避免污染正式云端账本，仿真演练仅在「本地体验模式」下开放");
  }
  await localStore.updateSettings({ calibration_dry_run: false });
  const dash0 = await localStore.getAdminDashboard();
  const owner = dash0.members.find((m) => m.role === "owner");
  let alice = dash0.members.find((m) => m.name === "林屿（熟人演示）");
  let bob = dash0.members.find((m) => m.name === "周然（熟人演示）");

  if (!alice) {
    alice = await localStore.createMember({
      name: "林屿（熟人演示）",
      role: "member",
      initialBalanceFen: 2000,
      lowBalanceFen: 300,
      note: "主力写前端代码，偶尔用 Opus",
    });
  }
  if (!bob) {
    bob = await localStore.createMember({
      name: "周然（熟人演示）",
      role: "member",
      initialBalanceFen: 500,
      lowBalanceFen: 200,
      note: "轻度写文档，先小额预充 5 元",
    });
  }

  const now = Date.now();
  const resetIso = new Date(now + 4 * 24 * 3600 * 1000).toISOString();
  const t0 = now - 25 * 60 * 1000;
  const t1 = now - 12 * 60 * 1000;
  const t2 = now - 2 * 60 * 1000;

  // T0：基线水位（Gemini 周剩 92%，3P 周剩 96%）
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

  // T1：组长 + 林屿 + 周然并发使用 Gemini，同时组长设备拉到总池从 92% 掉到 86%（掉 6%）
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

  // T2：林屿用了一段 Claude 3P，组长设备拉到 3P 周池变化
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

  return { ok: true, message: "已写入本地仿真演练数据（含并发拆账与低余额检测）" };
}

// 可选：后台轻量消息告警转发（仅当用户在 console_config.json 中配置了本地推送脚本与目标账号并开启时运行）
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

    const lines = list.map((a) => `• [${a.severity === "critical" ? "高危核查" : "提醒"}] ${a.title}：${a.detail}`);
    const text = `【家庭组额度账本提醒】\n${lines.join("\n")}`;
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
    // 推送服务未上线时静默跳过，绝不阻断控制台主服务
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
    // 唯一健康签名接口（供原生 WebView2 .exe 宿主核验，防端口误判）
    if (pathname === "/api/health" && req.method === "GET") {
      const cfg = loadConsoleConfig();
      return sendJson(res, {
        ok: true,
        app: "agy-family-ledger-console",
        version: "1.0.0",
        mode: cfg.mode,
        port: PORT,
      });
    }

    // 也开放本地成员上报端点（当用户在「本地体验模式」下实测成员插件时可直接连 127.0.0.1:PORT）
    if (pathname === "/api/member/heartbeat" && req.method === "POST") {
      const token = req.headers["x-member-token"] || body.memberToken || "";
      const { nowMs: _ignoredNowMs, ...safeBody } = body && typeof body === "object" ? body : {};
      return sendJson(res, await localStore.ingestHeartbeat(token, safeBody));
    }

    // 控制台连接配置（本地 / 云端切换）
    if (pathname === "/api/console-config" && req.method === "GET") {
      const cfg = loadConsoleConfig();
      return sendJson(res, {
        ok: true,
        config: {
          mode: cfg.mode,
          cloudWorkerUrl: cfg.cloudWorkerUrl,
          hasAdminSecret: Boolean(cfg.adminSecret),
          enableQqAlertForward: cfg.enableQqAlertForward,
          exportsDir: EXPORTS_DIR,
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
          exportsDir: EXPORTS_DIR,
        },
      });
    }

    // 一键导出熟人专属安装袋 (.zip)
    const expMatch = pathname.match(/^\/api\/export-bundle\/([^/]+)$/);
    if (expMatch && req.method === "POST") {
      return sendJson(res, await exportMemberInstallBundle(decodeURIComponent(expMatch[1]), PORT));
    }

    // 一键把组长插件装进本机 Antigravity
    if (pathname === "/api/install-owner-local" && req.method === "POST") {
      return sendJson(res, await installOwnerPluginLocally(PORT));
    }

    // 打开导出目录（在 Windows 资源管理器中高亮目录）
    if (pathname === "/api/open-exports" && req.method === "POST") {
      execFile("explorer.exe", [EXPORTS_DIR], { windowsHide: true }, () => {});
      return sendJson(res, { ok: true, dir: EXPORTS_DIR });
    }

    // 本地模式一键仿真演练
    if (pathname === "/api/demo/seed" && req.method === "POST") {
      return sendJson(res, await seedLocalDemoScenario());
    }

    // 管理端业务 API 透传（自动路由至本地 SQLite 或 Cloudflare Worker）
    if (pathname.startsWith("/api/admin/")) {
      return sendJson(res, await callBackend(pathname, req.method || "GET", body));
    }

    // 静态前端资源
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
      url: `http://127.0.0.1:${PORT}`,
      mode: loadConsoleConfig().mode,
    })
  );
});

setInterval(() => {
  pollAndForwardQqAlerts().catch(() => {});
}, 60_000).unref();
