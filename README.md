# Antigravity 家庭组额度看板

供熟人合用 Google AI Ultra / Antigravity 家庭组时查看共享剩余额度与各人近 7 天用量占比的轻量插件与管理面板。后端直接部署在 Cloudflare Workers + D1 免费额度内，无需购买服务器。

<!-- 可在 GitHub 网页端编辑 README 时拖拽上传界面截图或演示动图 -->

---

## 受邀成员如何安装与核查代码

本仓库无需接收组长私下打包发来的任何 `.zip` 或脚本文件，所有成员均直接从 GitHub 公开仓库安装同一份代码，再粘贴组长提供的纯文本绑定码即可连接。

### 1. 安装插件（任选一种）

- **通过 AGY Market 直接从本仓库拉取**：
  ```bash
  npx agy-market add https://github.com/Curelove/agy-family-ledger/tree/main/member-plugin
  ```
- **从 GitHub Releases 下载自动构建包**：
  前往 [Releases 页面](https://github.com/Curelove/agy-family-ledger/releases/latest) 下载由 GitHub Actions 自动打包的 `agy-family-ledger-plugin-v*.zip`（可对照同页面的 `SHA256SUMS.txt` 校验文件完整性），解压后在 Windows 双击 `install_windows.cmd`，或在 macOS / Linux 执行 `bash install_macos_linux.sh`。

### 2. 粘贴单行绑定码

重启 Antigravity，在右侧边栏打开「家庭组额度看板」，将组长发给你的那一行纯文本绑定码（格式为 `https://域名#agf_xxxx`）粘贴进输入框，点击 **连接看板** 即可。

### 3. 数据读取范围说明（源码可直接查阅）

成员端采集逻辑全部集中在单文件 [`member-plugin/sidecars/ledger/collector.mjs`](./member-plugin/sidecars/ledger/collector.mjs)（约 470 行，无任何第三方依赖）：

- 从本机 Antigravity 日志 `transcript.jsonl` 的已完成步骤中，仅通过正则提取 `step_index`、`model`、`created_at` 与输入/缓存/输出 Token 数字计数（见 [`extractNumericUsageFromLine`](./member-plugin/sidecars/ledger/collector.mjs#L86-L125)），首次运行自动从现有日志末尾开始统计，不追溯安装前的旧记录。
- 仅通过 Antigravity 官方 Sidecar 注入的 `127.0.0.1` 本地接口只读查询 `RetrieveUserQuotaSummary` 剩余配额百分比（见 [`fetchLocalQuotaSnapshots`](./member-plugin/sidecars/ledger/collector.mjs#L275-L339)）。
- 不读取任何工作区代码、对话正文 `content`、思考过程 `thinking`、本机进程列表、网络代理配置或账号凭证。

---

## 功能与能力边界

- **默认纯看板模式，按需开启记账**
  默认只展示全组 Gemini 4 与 Claude 3P 的周剩余额度、5 小时窗口剩余比例，以及组内每位成员近 7 天的用量占比（按模型倍率与缓存权重自动折算并发比例），界面不出现任何余额与金额字段。若组内确实需要记录预存余额与按比例扣费，可在管理端「设置」中切换为「按量记账模式」。
- **防篡改权限隔离**
  服务端强制使用服务器时间，并默认仅接受组长本人设备同步的官方总剩余额度（`owner_only`）。普通成员凭证只能上报自身 Token 计数和查看看板数据，无法伪造总额度变化或修改他人记录。组长电脑关机期间，成员上报的计数会正常保存在 Cloudflare D1 中，待组长下次打开 Antigravity 时自动合并结算。
- **未统计消耗提醒**
  当官方总剩余额度的减少量持续超出全组插件上报之和（单次小于 3% 的正常波动自动忽略）时，管理端会记录差值，便于在群内确认是否有人更换了未装插件的电脑或误开了第三方中转工具。
- **客观能力说明**
  Google 家庭组配额由 Google 服务端直接授权给各成员账号，本地插件无法在服务器端限制或切断任何人的用量；本工具仅提供透明统计与提醒，适合互信熟人之间同步余量、错峰使用。

---

## 组长部署步骤

本地运行环境需 Node.js 22 或以上版本（直接使用 Node 内置 `node:sqlite`，无需执行 `npm install` 安装运行时包）。

### 1. 本地预览管理界面

```bash
git clone https://github.com/Curelove/agy-family-ledger.git
cd agy-family-ledger
npm run console
```

浏览器打开终端输出的 `http://127.0.0.1:18945` 可先在离线模式下查看界面；运行 `npm test` 可执行全部 10 项端到端测试。

### 2. 部署 Cloudflare 免费云端服务

```bash
cp worker/wrangler.example.toml worker/wrangler.toml
npx wrangler login
npx wrangler d1 create agy-family-ledger-db
```

将终端输出的 `database_id` 填入 `worker/wrangler.toml`，然后发布 Worker 并设置管理员密钥：

```bash
npx wrangler deploy --config worker/wrangler.toml
npx wrangler secret put ADMIN_SECRET --config worker/wrangler.toml
```

更详细的分步操作说明见 [`00_部署与熟人安装手把手指南.md`](./00_部署与熟人安装手把手指南.md)。

### 3. 添加成员并发送绑定码

1. 在本地管理控制台打开 **设置**，选择 **Cloudflare 云端同步**，填入刚才生成的 Worker 地址与管理员密钥并保存，点击 **安装组长插件到本机**。
2. 回到 **看板总览**，点击右上角 **添加成员** 输入朋友称呼，在弹出的窗口中即可一键复制 GitHub 安装说明与该成员专属的纯文本绑定码。

---

## 目录说明

```text
agy-family-ledger/
├── shared/
│   ├── billing-engine.mjs       # 倍率折算、配额重置识别与异常掉量判断
│   ├── ledger-store.mjs         # 数据读写层（兼容 Cloudflare D1 与 Node SQLite）
│   └── schema.sql               # 数据库表结构
├── worker/
│   ├── index.mjs                # Cloudflare Workers 接口入口
│   └── wrangler.example.toml    # Cloudflare 部署配置模板
├── member-plugin/               # Antigravity 侧边栏插件源码
│   ├── plugin.json
│   └── sidecars/ledger/
│       ├── collector.mjs        # 纯数字增量采集与绑定码解析
│       ├── main.mjs             # Sidecar 服务入口
│       └── panel.html           # 侧边栏界面
├── local-console/               # 组长本地管理控制台
│   ├── server.mjs
│   └── public/
└── scripts/
    ├── package_release.mjs      # GitHub Releases 自动打包与 SHA-256 生成脚本
    └── test_e2e.mjs             # 自动化测试套件
```

---

## License

[MIT License](./LICENSE)
