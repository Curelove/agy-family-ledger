/**
 * 官方纯净成员插件自动打包脚本 (v1.3.0 · 供 GitHub Actions 与本地检验共用)
 *
 * 产出：
 * - dist/agy-family-ledger-plugin-v<version>.zip（不含任何私人网址或成员凭证）
 *   内含：
 *   - agy-family-ledger/（纯净插件源码）
 *   - install_windows.cmd / uninstall_windows.cmd（纯 7-bit ASCII + CRLF）
 *   - install_macos_linux.sh / uninstall_macos_linux.sh（保留已有 config.json + 自动解析 node 路径）
 *   - 安装与卸载说明.txt
 * - dist/SHA256SUMS.txt
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, "member-plugin", "plugin.json"), "utf8"));

if (pkg.version !== pluginJson.version) {
  throw new Error(`版本号不一致：package.json (${pkg.version}) !== member-plugin/plugin.json (${pluginJson.version})`);
}

const expectedTag = process.env.RELEASE_TAG ? String(process.env.RELEASE_TAG).trim() : `v${pkg.version}`;
if (expectedTag !== `v${pkg.version}`) {
  throw new Error(`标签 (${expectedTag}) 与代码版本 (v${pkg.version}) 不一致`);
}

const distDir = path.join(ROOT, "dist");
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-family-ledger-rel-"));
const bundleName = "agy-family-ledger-plugin";
const bundleDir = path.join(stageRoot, bundleName);
const pluginDst = path.join(bundleDir, "agy-family-ledger");

function copyCleanPlugin(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === "config.json" || ent.name === "backups" || ent.name.startsWith(".")) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyCleanPlugin(s, d);
    else fs.copyFileSync(s, d);
  }
}

function assertPureAscii(text, label) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      throw new Error(`${label} 包含非 ASCII 字符`);
    }
  }
}

try {
  copyCleanPlugin(path.join(ROOT, "member-plugin"), pluginDst);

  // 1. 纯 7-bit ASCII + CRLF Windows 安装脚本（保留已有 config.json）
  const winInstallCmd =
    [
      "@echo off",
      "setlocal",
      'set "SRC=%~dp0agy-family-ledger"',
      'set "DST=%USERPROFILE%\\.gemini\\config\\plugins\\agy-family-ledger"',
      "echo ========================================================",
      "echo   AGY Family Ledger Plugin Installer (Official Build)",
      "echo ========================================================",
      "where node >nul 2>&1",
      "if errorlevel 1 (",
      "  echo [WARN] Node.js was not found in PATH. Please install Node.js 20+ before starting Antigravity.",
      ")",
      'if not exist "%SRC%\\plugin.json" (',
      "  echo [ERROR] Missing agy-family-ledger folder next to this script.",
      "  pause",
      "  exit /b 1",
      ")",
      'if not exist "%USERPROFILE%\\.gemini\\config\\plugins" mkdir "%USERPROFILE%\\.gemini\\config\\plugins"',
      'xcopy /E /I /Y "%SRC%" "%DST%" >nul',
      "if errorlevel 1 (",
      "  echo [ERROR] Copy failed. Please close Antigravity and retry.",
      "  pause",
      "  exit /b 1",
      ")",
      "echo [OK] Installed to: %DST%",
      "echo Next steps:",
      "echo   1. Restart Antigravity App (requires Sidecar support).",
      "echo   2. Open Extensions / Custom Plugins and make sure agy-family-ledger is enabled.",
      "echo   3. Open the right sidebar panel and paste your binding code.",
      "pause",
      "exit /b 0",
    ].join("\r\n") + "\r\n";

  assertPureAscii(winInstallCmd, "install_windows.cmd");
  fs.writeFileSync(path.join(bundleDir, "install_windows.cmd"), winInstallCmd, "ascii");

  // 2. 纯 7-bit ASCII + CRLF Windows 彻底卸载脚本（同步清理插件目录与本地状态文件）
  const winUninstallCmd =
    [
      "@echo off",
      "setlocal",
      'set "DST=%USERPROFILE%\\.gemini\\config\\plugins\\agy-family-ledger"',
      'set "STATE=%USERPROFILE%\\.gemini\\agy-family-ledger-member-state.json"',
      'set "SIDECAR_DATA=%USERPROFILE%\\.gemini\\antigravity\\sidecar_data\\agy-family-ledger"',
      "echo ========================================================",
      "echo   AGY Family Ledger Plugin Uninstaller",
      "echo ========================================================",
      'if exist "%DST%" rmdir /S /Q "%DST%"',
      'if exist "%STATE%" del /F /Q "%STATE%"',
      'if exist "%SIDECAR_DATA%" rmdir /S /Q "%SIDECAR_DATA%"',
      "echo [OK] Plugin folder and local state files removed.",
      "echo Restart Antigravity App to complete removal.",
      "pause",
      "exit /b 0",
    ].join("\r\n") + "\r\n";

  assertPureAscii(winUninstallCmd, "uninstall_windows.cmd");
  fs.writeFileSync(path.join(bundleDir, "uninstall_windows.cmd"), winUninstallCmd, "ascii");

  // 3. macOS / Linux 安装脚本（保留既有 config.json + 解析真实 node 绝对路径防止 macOS GUI 找不到 node）
  const unixInstallSh =
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'DST="$HOME/.gemini/config/plugins/agy-family-ledger"',
      'CFG="$DST/sidecars/ledger/config.json"',
      'TMP_CFG=""',
      'if [ -f "$CFG" ]; then',
      '  TMP_CFG="$(mktemp)"',
      '  cp "$CFG" "$TMP_CFG"',
      "fi",
      'mkdir -p "$HOME/.gemini/config/plugins"',
      'rm -rf "$DST"',
      'cp -R "$DIR/agy-family-ledger" "$DST"',
      'if [ -n "$TMP_CFG" ] && [ -f "$TMP_CFG" ]; then',
      '  cp "$TMP_CFG" "$CFG"',
      '  rm -f "$TMP_CFG"',
      '  echo "[OK] Preserved existing binding config.json"',
      "fi",
      'NODE_BIN="$(command -v node || true)"',
      'if [ -z "$NODE_BIN" ]; then',
      '  for cand in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do',
      '    if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi',
      "  done",
      "fi",
      'if [ -n "$NODE_BIN" ]; then',
      '  "$NODE_BIN" -e \'const fs=require("fs");const p=process.argv[1];const b=process.argv[2];const j=JSON.parse(fs.readFileSync(p,"utf8"));j.command=b;fs.writeFileSync(p,JSON.stringify(j,null,2)+"\\n");\' "$DST/sidecars/ledger/sidecar.json" "$NODE_BIN"',
      '  echo "[OK] Bound Node runtime: $NODE_BIN"',
      "else",
      '  echo "[WARN] Node.js not found. Please install Node.js 20+ before launching Antigravity."',
      "fi",
      'echo "[OK] Installed to $DST"',
      'echo "1. Restart Antigravity App and enable agy-family-ledger in Extensions."',
      'echo "2. Open the sidebar panel and paste your binding code."',
    ].join("\n") + "\n";
  fs.writeFileSync(path.join(bundleDir, "install_macos_linux.sh"), unixInstallSh, "utf8");

  // 4. macOS / Linux 彻底卸载脚本
  const unixUninstallSh =
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'rm -rf "$HOME/.gemini/config/plugins/agy-family-ledger"',
      'rm -f "$HOME/.gemini/agy-family-ledger-member-state.json"',
      'rm -rf "$HOME/.gemini/antigravity/sidecar_data/agy-family-ledger"',
      'echo "[OK] Plugin folder and local state files removed. Restart Antigravity App to complete removal."',
    ].join("\n") + "\n";
  fs.writeFileSync(path.join(bundleDir, "uninstall_macos_linux.sh"), unixUninstallSh, "utf8");

  const readmeTxt = [
    `家庭组额度看板插件（GitHub 官方纯净构建 ${expectedTag}）`,
    "",
    "本压缩包直接由 GitHub Actions 从公开源码自动打包，未包含任何个人网址或成员凭证。",
    "",
    "使用前提：",
    "- 需要 Antigravity App（支持侧边栏 Sidecar 扩展）与本机已安装 Node.js 20+。",
    "",
    "安装与连接步骤：",
    "1. Windows：完整解压本压缩包后，双击运行 install_windows.cmd（升级覆盖会自动保留已有绑定、代理与账号锁设置）。",
    "   macOS / Linux：解压后在终端运行 bash install_macos_linux.sh（自动保留已有 config.json 并写入本机 node 绝对路径）。",
    "2. 重启 Antigravity App，在扩展管理页面确认「家庭组额度看板（agy-family-ledger）」已启用。",
    "3. 在右侧边栏打开「家庭组额度看板」，粘贴组长提供的单行绑定码并点击「连接看板」。",
    "4. 切换至个人其他账号时，侧边栏会自动暂停计入家庭组并在切回后从此刻起算（仍可实时查看全组余量）；如需临时停采也可一键「暂停统计」。",
    "5. 若使用免费 workers.dev 地址且直连超时，可在「连接配置」中填写本地 HTTP 代理地址（如 http://127.0.0.1:7897）。",
    "",
    "彻底卸载：",
    "- Windows 双击运行 uninstall_windows.cmd，macOS / Linux 运行 bash uninstall_macos_linux.sh，可同步清理插件与本地状态文件。",
    "",
    "源码与校验地址：https://github.com/Curelove/agy-family-ledger",
  ].join("\r\n");
  fs.writeFileSync(path.join(bundleDir, "安装与卸载说明.txt"), readmeTxt, "utf8");

  const zipFileName = `agy-family-ledger-plugin-${expectedTag}.zip`;
  const zipFilePath = path.join(distDir, zipFileName);

  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -Path '${bundleDir.replace(/'/g, "''")}' -DestinationPath '${zipFilePath.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: "inherit" }
    );
  } else {
    execFileSync("zip", ["-r", "-q", zipFilePath, bundleName], { cwd: stageRoot, stdio: "inherit" });
  }

  const zipBytes = fs.readFileSync(zipFilePath);
  const sha256 = crypto.createHash("sha256").update(zipBytes).digest("hex");
  const sumsPath = path.join(distDir, "SHA256SUMS.txt");
  fs.writeFileSync(sumsPath, `${sha256}  ${zipFileName}\n`, "utf8");

  console.log(`Built: ${zipFileName} (${zipBytes.length} bytes)`);
  console.log(`SHA256: ${sha256}`);
} finally {
  fs.rmSync(stageRoot, { recursive: true, force: true });
}
