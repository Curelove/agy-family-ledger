/**
 * 官方纯净成员插件自动打包脚本（供 GitHub Actions 与本地检验共用）
 *
 * 产出：
 * - dist/agy-family-ledger-plugin-v<version>.zip（不含任何私人网址或成员 Token）
 * - dist/SHA256SUMS.txt（供下载者用 certutil / shasum 核验文件未被篡改）
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
    if (ent.name === "config.json" || ent.name.startsWith(".")) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyCleanPlugin(s, d);
    else fs.copyFileSync(s, d);
  }
}

try {
  copyCleanPlugin(path.join(ROOT, "member-plugin"), pluginDst);

  // 纯 7-bit ASCII + CRLF Windows 安装脚本
  const winCmd =
    [
      "@echo off",
      "setlocal",
      'set "SRC=%~dp0agy-family-ledger"',
      'set "DST=%USERPROFILE%\\.gemini\\config\\plugins\\agy-family-ledger"',
      "echo ========================================================",
      "echo   AGY Family Ledger Plugin Installer (Official Build)",
      "echo ========================================================",
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
      "echo Restart Antigravity, open the sidebar panel, and paste your binding code.",
      "pause",
      "exit /b 0",
    ].join("\r\n") + "\r\n";

  // 校验 100% 7-bit ASCII
  for (let i = 0; i < winCmd.length; i++) {
    if (winCmd.charCodeAt(i) > 127) {
      throw new Error("install_windows.cmd 包含非 ASCII 字符");
    }
  }
  fs.writeFileSync(path.join(bundleDir, "install_windows.cmd"), winCmd, "ascii");

  const unixSh =
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'DIR="$(cd "$(dirname "$0")" && pwd)"',
      'DST="$HOME/.gemini/config/plugins/agy-family-ledger"',
      'mkdir -p "$HOME/.gemini/config/plugins"',
      'rm -rf "$DST"',
      'cp -R "$DIR/agy-family-ledger" "$DST"',
      'echo "[OK] Installed to $DST"',
      'echo "Restart Antigravity, open the sidebar panel, and paste your binding code."',
    ].join("\n") + "\n";
  fs.writeFileSync(path.join(bundleDir, "install_macos_linux.sh"), unixSh, "utf8");

  const readmeTxt = [
    `家庭组额度看板插件（GitHub 官方纯净构建 ${expectedTag}）`,
    "",
    "本压缩包直接由 GitHub Actions 从公开源码自动打包，未包含任何个人网址或成员凭证。",
    "",
    "安装与连接步骤：",
    "1. Windows：完整解压本压缩包后，双击运行 install_windows.cmd。",
    "   macOS / Linux：解压后在终端运行 bash install_macos_linux.sh。",
    "2. 重启 Antigravity，在右侧边栏打开「家庭组额度看板」。",
    "3. 将组长发给你的单行纯文本绑定码（格式如 https://域名#agf_xxxx）粘贴进输入框，点击「连接看板」即可。",
    "",
    "源码核查地址：https://github.com/Curelove/agy-family-ledger",
  ].join("\r\n");
  fs.writeFileSync(path.join(bundleDir, "安装说明.txt"), readmeTxt, "utf8");

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
