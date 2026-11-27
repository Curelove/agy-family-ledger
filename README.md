# Antigravity 家庭组额度看板

供熟人合用 Google AI Ultra / Antigravity 家庭组时查看共享剩余额度、近 5 小时窗口活跃情况与本周期各成员用量的轻量插件和管理控制台。后端运行在 Cloudflare Workers + D1 免费额度内，无需额外租用服务器。

---

## 受邀成员如何安装与核查代码

所有成员均直接从 GitHub 公开仓库或 Releases 自动构建包安装同一份代码，无需接收组长私下发来的私人压缩包。

### 使用前提
- 需要 **Antigravity App**（支持侧边栏 Sidecar 扩展；独立 IDE 版本暂不支持侧边栏）以及本机已安装 Node.js 20 或以上版本。

### 1. 安装插件（任选一种）

- **方式 A：下载 GitHub Releases 自动构建包（推荐）**
  前往 [Releases 页面](https://github.com/Curelove/agy-family-ledger/releases/latest) 下载由 GitHub Actions 从公开源码自动打包的 `agy-family-ledger-plugin-v*.zip`，并可对照同页面的 `SHA256SUMS.txt` 校验文件完整性：
  - Windows：完整解压后双击运行 `install_windows.cmd`（升级覆盖不会清除已有绑定配置）。
  - macOS / Linux：解压后在终端运行 `bash install_macos_linux.sh`（自动保留已有 `config.json` 并写入本机 `node` 绝对路径，避免 GUI 环境找不到 `node`）。
- **方式 B：从源码目录直接安装**
  执行 `git clone --depth 1 https://github.com/Curelove/agy-family-ledger.git`，将仓库内的 `member-plugin` 文件夹复制到 `~/.gemini/config/plugins/agy-family-ledger`。

### 2. 启用插件并粘贴单行绑定码

1. 重启 Antigravity App，进入扩展管理页面确认 `agy-family-ledger`（家庭组额度看板）已启用。
2. 在右侧边栏打开「家庭组额度看板」，粘贴组长发来的单行纯文本绑定码（例如 `https://域名#agf_xxxx&v=1&m=board&g=100&p=180`），点击 **连接看板**。
3. 若组长使用的是免费 `*.workers.dev` 地址且本机未开启 TUN 代理导致同步超时，可在侧边栏底部「连接配置」中填写本地 HTTP 代理地址（例如 `http://127.0.0.1:7897`），或建议组长给 Worker 绑定自定义域名。

### 3. 规则锁定、全组使用约定与防暗改机制

- 组长可在管理台「设置」中选填 **全组使用约定**，例如「总池剩余 20% 时暂停非紧急任务」、按人数设定的「单人本周期参考上限（如双人 50%、三人 30%、四人 25%）」以及补充文字说明，并明确标明单人上限是否对组长本人同样生效（默认全员同等适用）。
- 绑定码内锁定了入组时的模式、单价与全部使用约定，插件会在本机记录这份初始约定。
- 如果组长后续在云端切换记账模式、修改单价，或调整保留底线、单人上限、组长适用范围与文字说明中的任意一项，系统都会自动递增规则版本号并写入全体成员可见的变更记录；成员侧边栏顶部会显示原约定与新规则对比卡片，由成员本人决定 **确认接受新规则** 或 **暂不接受并断开**（按量记账模式下，成员确认前服务端不会按新单价静默扣费）。
- 所有使用约定均以温和提醒方式展示（进度条底线刻度 + 触及阈值后的顶部提醒），插件不会也不会尝试在服务端强行中断成员使用。

### 4. 数据读取与上报范围（源码可直接查阅）

成员端采集逻辑全部集中在单文件 [`member-plugin/sidecars/ledger/collector.mjs`](./member-plugin/sidecars/ledger/collector.mjs)（零第三方依赖）：

- **实际读取与上报的内容**：本机 Antigravity 会话日志 `transcript.jsonl` 中已完成或产生真实消耗步骤的纯数字 Token 计数、模型名、步数索引、毫秒级时间戳、SHA-256 脱敏会话短哈希、90 秒在线心跳，以及宿主 `127.0.0.1` 本地接口返回的官方剩余配额百分比（`RetrieveUserQuotaSummary`）。首次安装只追踪安装之后的新建对话与新增步骤，不追溯历史旧账。
- **绝不读取的内容**：不读取工作区代码、对话正文 `content`、思考过程 `thinking`、工具参数、本机运行进程列表、代理软件配置或账号登录凭证。
- **提醒**：由于包含 90 秒在线状态心跳与请求时间戳，同组在线成员可以看到你的近期活跃状态；不需要使用时可在 Antigravity 扩展页关闭插件。

### 5. 彻底卸载

- Windows：运行安装包内的 `uninstall_windows.cmd`。
- macOS / Linux：运行 `bash uninstall_macos_linux.sh`。
- 手动清理路径：删除 `~/.gemini/config/plugins/agy-family-ledger`、`~/.gemini/agy-family-ledger-member-state.json` 及 `~/.gemini/antigravity/sidecar_data/agy-family-ledger` 后重启 Antigravity App。

---

## 功能与客观边界

- **默认纯看板模式，按需开启记账**
  默认仅展示全组 Gemini 4 与 Claude 3P 的周剩余额度、5 小时窗口剩余比例、近 5 小时各人活跃参考以及本周期（按官方 `reset_at` 切分，周重置后自动归零）各成员用量，不显示余额与金额。若确需按比例分摊预存余额，可在管理端「设置」中开启按量记账模式，并在成员侧边栏透明查看每一笔分摊扣费明细。
- **一次性结算游标与防背锅保护**
  每条本地上报记录绑定 `settled_snapshot_id`，参与一次官方水位结算后立即打标，避免 90 秒高频心跳重复结算同一记录；对单人可解释掉量设置合理上限，防止未装插件设备的消耗转嫁给在线成员；组长离线跨越每周配额重置点时，新周期已发生的真实消耗仍会准确记入新周期。
- **未统计消耗滚动提醒**
  使用滚动时间窗口累计官方总池未匹配掉量，既能捕捉持续慢速未上报消耗，也能在触发提醒后清空缓冲避免重复打扰。
- **客观能力说明**
  Google 家庭组配额由 Google 服务端直接分配给成员账号，本地插件无法在服务端拦截或切断他人用量。对于熟人合租，最稳妥的方式仍是固定月费平摊配合本看板查看余量、错峰使用；若启用按量记账，请确保所有常用设备均安装插件。

---

## 组长部署步骤

本地管理控制台需要 **Node.js 22.5 或以上版本**（使用 Node 内置 `node:sqlite`，无需安装第三方运行时依赖；云端部署时通过 `npx wrangler` 执行）。

### 1. 本地预览与测试

```bash
git clone https://github.com/Curelove/agy-family-ledger.git
cd agy-family-ledger
npm test
npm run console
```

浏览器打开 `http://127.0.0.1:18945` 可在离线模式下预览界面；本地管理台内置随机一次性会话令牌与来源校验，防止外部网页跨站调用本地接口。

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

更详细的分步部署与网络连通说明见 [`00_部署与熟人安装手把手指南.md`](./00_部署与熟人安装手把手指南.md)。

### 3. 连接云端、同步组长插件并邀请成员

1. 在本地管理控制台打开 **设置**，选择 **Cloudflare 云端同步**，填入 Worker 地址与 `ADMIN_SECRET` 并保存。
2. 点击 **安装组长插件到本机**（运行中的插件会在下次同步前自动热重载新配置，无需重启 Antigravity）。
3. 回到 **看板总览**，点击 **添加成员** 输入称呼，即可复制官方 Releases 下载链接与带规则锁定的纯文本绑定码。

---

## 目录说明

```text
agy-family-ledger/
├── shared/
│   ├── billing-engine.mjs       # 模型倍率、重置识别、防背锅上限与滚动异常检测
│   ├── ledger-store.mjs         # 数据层（一次性结算游标、规则版本审计、软归档、D1/SQLite 兼容）
│   └── schema.sql               # 完整表结构与全部索引定义
├── worker/
│   ├── index.mjs                # Cloudflare Workers 接口入口
│   └── wrangler.example.toml    # Cloudflare 部署配置模板
├── member-plugin/               # Antigravity App 侧边栏插件源码
│   ├── plugin.json
│   └── sidecars/ledger/
│       ├── collector.mjs        # 增量纯数字采集、绑定码校验、代理隧道与热重载
│       ├── update-service.mjs   # 内置 GitHub Releases / Atom 更新检查（零注册表读取）
│       ├── main.mjs             # Sidecar 服务与独立预览入口
│       └── panel.html           # 侧边栏界面（含变价确认、扣费明细与更新检查）
├── local-console/               # 组长本地管理控制台（CSRF 保护、无私货依赖）
│   ├── server.mjs
│   └── public/
└── scripts/
    ├── package_release.mjs      # GitHub Releases 自动打包、安装/卸载脚本与 SHA-256 生成
    └── test_e2e.mjs             # 全链路自动化与安全回归测试
```

---

## License

[MIT License](./LICENSE)
