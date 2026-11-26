# Antigravity 家庭组额度账本

面向熟人共享 Google AI Ultra / Antigravity 家庭组的**透明用量分摊账本、预存记账台与无侵入黑洞预警套件**——整套代码完全开源，受邀成员可直接核查采集逻辑，云端中转跑在 Cloudflare Workers + D1 免费额度内，长期 0 元运行。

<!-- 视觉演示位：可在 GitHub 网页端编辑 README 时直接拖拽上传 5~15 秒演示 GIF 或 MP4 -->

---

## 给受邀成员（熟人）：30 秒隐私与安全自查

如果你是收到朋友发来的「专属安装袋」准备安装插件的成员，可以直接点开下方的完整源码核对，无需盲目信任：

- **核心采集器（全文约 450 行、零外部依赖）**：[`member-plugin/sidecars/ledger/collector.mjs`](./member-plugin/sidecars/ledger/collector.mjs)
- **侧边栏主进程与页面**：[`member-plugin/sidecars/ledger/main.mjs`](./member-plugin/sidecars/ledger/main.mjs)、[`member-plugin/sidecars/ledger/panel.html`](./member-plugin/sidecars/ledger/panel.html)

本插件严格遵守以下隐私边界：

- **仅读取两类纯数字信息**：
  1. 从本机 Antigravity 对话日志 `transcript.jsonl` 的 `PLANNER_RESPONSE` 行中，使用字段级正则只提取 `step_index`、`model`、`created_at`、`input_tokens`、`cache_read_tokens`、`cache_write_tokens`、`output_tokens` 纯数值计量字段（见 [`extractNumericUsageFromLine`](./member-plugin/sidecars/ledger/collector.mjs#L65-L104)）。
  2. 仅通过 Antigravity 官方 Sidecar 注入的 `127.0.0.1` 本地接口只读拉取 `RetrieveUserQuotaSummary` 剩余百分比（见 [`fetchLocalQuotaSnapshots`](./member-plugin/sidecars/ledger/collector.mjs#L254-L318)）。
- **首次安装不翻历史旧账**：首次初始化时会自动记录现有日志的文件末尾偏移量，只统计安装之后的新增对话。
- **绝不读取、绝不上传**：不碰你的任何代码文件、工作区内容、对话正文 `content`、思考过程 `thinking`、电脑运行进程、本地端口、代理软件配置或账号密码。
- **绝不拦截或篡改系统**：不会修改 Google / Antigravity 设置，不会自动踢人，也不会限制或阻断你的正常对话。

---

## 核心亮点

- **按真实倍率公平拆账**：Gemini 池与 Claude 3P 池分开核算与定价；多人同时使用时，按模型倍率（Carbon 3x、Opus 2x、Neon 1x、Hydrogen/Flash 0.7x）与缓存折算等效 Token 自动公平分摊官方总池掉落的百分比。
- **小额预存与温和提醒**：支持 1 元 / 5 元 / 10 元 / 20 元快捷记账、低于自定义提醒线时在成员侧边栏温和提示续充，并自动识别官方配额重置（绝不产生负数误扣）。
- **防篡改水位主权**：服务端默认开启 `owner_only` 权限，仅采信组长本人设备上报的官方总池水位，并强制采用服务端时间校验；普通成员只能上报自身 Token 与查看自身余额，无法伪造水位重置或干扰组长与他人显示。
- **三层防误报黑洞预警**：当总池出现明显未上报消耗（例如有人在未装插件的设备或第三方反代上消耗额度）时，经过「单次波动过滤 → 持续窗口校验 → 全员在线状态分级」给出黄/红提醒，避免误伤正常延迟。
- **Cloudflare 免费层 0 元托管**：基于 Cloudflare Workers + D1 SQLite 运行，组长关机期间熟人上报的 Token 照常入库，组长下次开机自动对齐结算。
- **熟人 30 秒零配置安装**：组长在本地控制台一键导出预填好网址与专属成员码的 `.zip` 安装袋，熟人解压后双击脚本（Windows / macOS / Linux）即可生效。

---

## 透明边界说明（先说清楚它能做什么、不能做什么）

- **它本质上是「透明记账与异常预警工具」，不能在 Google 侧强制限流**：Google 家庭组额度由 Google 服务端直接分配给成员账号，任何本地插件都无法在服务器端掐断配额。
- **适用于互信熟人组团，不适合面向陌生人硬防白嫖**：任何运行在成员本机的插件（无论是否开源）都无法从物理层面阻止对方关闭插件或换设备使用；本工具通过「官方总池水位守恒 + 未上报黑洞预警」确保偷跑无法隐身，但最终处理仍由组长本人线下沟通或手动移出家庭组。

---

## 极速上手（3 步跑通）

环境要求：Node.js 22+（使用内置 `node:sqlite` 与原生 `fetch`，无需安装任何 `npm` 运行时依赖）。

### 第 1 步：本地体验桌面控制台（30 秒零注册）

```bash
git clone https://github.com/Curelove/agy-family-ledger.git
cd agy-family-ledger
npm run console
```

浏览器打开终端输出的 `http://127.0.0.1:18945`，点击右上角 **演练拆账** 即可体验并发分摊、小额预存与异常预警；也可运行自动化全链路测试验证核心计费与安全边界：

```bash
npm test
```

### 第 2 步：5 分钟部署 Cloudflare 免费云端中转（组长操作）

复制模板配置并部署到自己的免费 Cloudflare 账号（无需绑卡）：

```bash
cp worker/wrangler.example.toml worker/wrangler.toml
npx wrangler login
npx wrangler d1 create agy-family-ledger-db
```

将返回的 `database_id` 填入 `worker/wrangler.toml`，随后首次发布并写入只有你自己知道的管理员密钥：

```bash
npx wrangler deploy --config worker/wrangler.toml
npx wrangler secret put ADMIN_SECRET --config worker/wrangler.toml
```

详细图文级分步操作请直接阅读 [`00_部署与熟人安装手把手指南.md`](./00_部署与熟人安装手把手指南.md)。

### 第 3 步：切换云端并给熟人分发专属安装袋

1. 在本地控制台进入 **价格与连接**，切换到 **Cloudflare 云端模式**，填入 Worker 网址与管理员密钥并保存，点击 **一键安装组长插件到本机**。
2. 在 **成员与充值** 中点击 **新增熟人** 录入称呼与初始预存金额，再点击该成员右侧的 **安装袋** 生成专属 `.zip`。
3. 把 `.zip` 发给熟人，解压后双击 `install_windows.cmd`（macOS / Linux 运行 `bash install_macos_linux.sh`）并重启 Antigravity 即可开始透明记账。

---

## 目录结构

```text
agy-family-ledger/
├── shared/
│   ├── billing-engine.mjs       # 纯函数计费、倍率折算、官方重置判定与三层黑洞滤波
│   ├── ledger-store.mjs         # 统一数据层（兼容 Cloudflare D1 与 Node SQLite）
│   └── schema.sql               # 数据库建表结构
├── worker/
│   ├── index.mjs                # Cloudflare Workers 云端记账接口（含权限与时间校验）
│   └── wrangler.example.toml    # Cloudflare 部署配置模板（不含任何私密 ID）
├── member-plugin/               # 安装到组长与熟人 Antigravity 的零隐私侧边栏插件
│   ├── plugin.json
│   └── sidecars/ledger/
│       ├── collector.mjs        # 零隐私纯数值增量采集器（熟人自查核心文件）
│       ├── main.mjs             # Sidecar 主入口
│       └── panel.html           # 熟人侧边栏余额与双池水位页面
├── local-console/               # 组长本地桌面控制台（支持双模式与一键打包安装袋）
│   ├── server.mjs
│   └── public/
├── scripts/
│   └── test_e2e.mjs             # 8 项端到端自动化测试（含零隐私、防伪造、隔夜结算与黑洞过滤）
└── 00_部署与熟人安装手把手指南.md
```

---

## 配置与常见问题

- **为什么组长自己也要安装成员插件？**
  组长账号默认标记为 `owner` 且永远免扣余额；装上后不仅能自动统计你本人的正常消耗占比（避免你跑重活触发黑洞误报），还能在默认 `owner_only` 模式下提供权威的官方总池水位基准。
- **组长电脑关机期间，熟人还在用怎么办？**
  熟人端插件会持续把纯数字 Token 上报到你的 Cloudflare D1 云端数据库；等你下次打开 Antigravity 时，组长插件拉取到最新的官方总池水位，服务端会自动回溯上次水位之后的全部熟人消耗并一次性公平结算。
- **如何先试跑再正式扣费？**
  账本默认开启 **试跑校准期**（只记占比、不扣余额），建议与熟人先免费试跑 3~7 天核对单价和拆账口径，确认满意后再到 **价格与连接** 中关闭试跑开关即可转入正式扣费。

---

## License

基于 [MIT License](./LICENSE) 开源。
