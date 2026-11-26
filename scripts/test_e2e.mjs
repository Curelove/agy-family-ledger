/**
 * Antigravity 家庭组共享额度看板 · 全链路自动化端到端与安全回归验证 (v1.2.0)
 * 覆盖核心采集、真实 Antigravity Token 语义、防重复结算、防背锅上限、滚动黑洞检测、
 * 离线跨重置周期补算、本周期 week_bucket 过滤、绑定码规则锁定与变价确认、成员停用保账与安全校验。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { LedgerStore, wrapNodeSqliteAdapter } from "../shared/ledger-store.mjs";
import {
  extractNumericUsageFromLine,
  scanIncrementalTranscriptUsage,
  parseQuotaSummaryResponse,
  parseInviteCode,
  buildInviteCode,
  evaluateRuleMismatch,
} from "../member-plugin/sidecars/ledger/collector.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SCHEMA_SQL = fs.readFileSync(path.join(PROJECT_ROOT, "shared", "schema.sql"), "utf8");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-family-ledger-test-"));

try {
  // 1. 真实 Antigravity input_tokens 语义（与 cache_read_tokens 互斥，不扣成 0）+ 中断步骤统计 + 无正文泄露
  await test("collector:native-input-tokens-and-cancelled-step-no-content-leak", async () => {
    const fakeLine = JSON.stringify({
      step_index: 6,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      model: "gemini-4-carbon-high",
      created_at: "2026-11-26T09:00:00Z",
      input_tokens: 37589,
      cache_read_tokens: 88296,
      cache_write_tokens: 0,
      output_tokens: 2100,
      content: 'TOP_SECRET_PASSWORD_DO_NOT_READ "input_tokens": 99999999',
      thinking: "SECRET_THOUGHT",
    });
    const ev = extractNumericUsageFromLine(fakeLine, "abcdef123456-7890");
    assert.ok(ev);
    assert.equal(ev.poolKey, "gemini");
    assert.equal(ev.uncachedInputTokens, 37589, "原生 input_tokens 本身即为未缓存新增输入，绝不能减去 cache_read_tokens 归零");
    assert.equal(ev.cacheReadTokens, 88296);
    assert.equal(ev.outputTokens, 2100);
    assert.ok(!JSON.stringify(ev).includes("TOP_SECRET"), "不得包含任何正文文本");
    assert.ok(!ev.id.includes("abcdef123456"), "会话 ID 必须经过短哈希脱敏");

    const cancelledLine = JSON.stringify({
      step_index: 7,
      type: "PLANNER_RESPONSE",
      status: "CANCELLED",
      model: "claude-opus-5-5-high",
      created_at: "2026-11-26T09:02:00Z",
      input_tokens: 12000,
      output_tokens: 800,
    });
    const evCancel = extractNumericUsageFromLine(cancelledLine, "abcdef123456-7890");
    assert.ok(evCancel && evCancel.poolKey === "3p" && evCancel.outputTokens === 800, "产生真实消耗的 CANCELLED 步骤也应计入");
  });

  // 2. 安装前旧对话跳过历史 + 安装后新建对话/子代理从 offset=0 完整采集首轮 + 单行超 4MB 自动跳过不死锁
  await test("collector:historical-anchor-new-conv-first-turn-and-oversized-line-skip", async () => {
    const root = path.join(tmpDir, "fake_root");
    const tInstall = Date.parse("2026-11-26T09:00:00Z");

    // 历史老对话（安装前）
    const oldDir = path.join(root, "11111111-old-conv", ".system_generated", "logs");
    fs.mkdirSync(oldDir, { recursive: true });
    const oldLog = path.join(oldDir, "transcript.jsonl");
    fs.writeFileSync(
      oldLog,
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-xhigh",
        created_at: "2026-11-26T08:00:00Z",
        input_tokens: 10000,
        output_tokens: 500,
      }) + "\n",
      "utf8"
    );

    const state = { installedAtMs: tInstall, fileOffsets: {} };
    const first = scanIncrementalTranscriptUsage(state, [root], { nowMs: tInstall + 10_000 });
    assert.equal(first.length, 0, "安装前已存在的旧对话应锚定末尾，不翻旧账");

    // 安装后新开的对话（首轮立即落盘）
    const newDir = path.join(root, "22222222-new-conv", ".system_generated", "logs");
    fs.mkdirSync(newDir, { recursive: true });
    const newLog = path.join(newDir, "transcript.jsonl");
    fs.writeFileSync(
      newLog,
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "claude-opus-5-5-high",
        created_at: "2026-11-26T09:00:30Z",
        input_tokens: 20000,
        output_tokens: 1500,
      }) + "\n",
      "utf8"
    );
    const second = scanIncrementalTranscriptUsage(state, [root], { nowMs: tInstall + 60_000 });
    assert.equal(second.length, 1, "安装后新建的对话首轮步骤必须完整采集，绝不吞单");
    assert.equal(second[0].poolKey, "3p");
    assert.equal(second[0].uncachedInputTokens, 20000);

    // 追加一行 >4.2MB 的巨型行 + 一行正常记录 -> 巨型行被安全跳过且后续正常行可继续采集
    const giantLine = `{"step_index":2,"type":"GENERIC","content":"${"A".repeat(4_300_000)}"}\n`;
    const afterGiant =
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-xhigh",
        created_at: "2026-11-26T09:02:00Z",
        input_tokens: 8000,
        output_tokens: 600,
      }) + "\n";
    fs.appendFileSync(newLog, giantLine + afterGiant, "utf8");
    const third = scanIncrementalTranscriptUsage(state, [root], { nowMs: tInstall + 120_000 });
    assert.equal(third.length, 1, "遇到 >4MB 单行不得死锁，后续正常步骤应被成功采集");
    assert.equal(third[0].uncachedInputTokens, 8000);
  });

  // 3. 官方配额摘要解析
  await test("collector:parse-official-quota-summary-groups-and-buckets", async () => {
    const snaps = parseQuotaSummaryResponse({
      groups: [
        {
          displayName: "Gemini",
          buckets: [
            { bucketId: "gemini-5h", remainingFraction: 0.885, resetTime: "2026-11-26T14:00:00Z" },
            { bucketId: "gemini-weekly", remainingFraction: 0.74, resetTime: "2026-12-01T00:00:00Z" },
          ],
        },
        {
          displayName: "Claude 3P",
          buckets: [{ bucketId: "3p-weekly", remainingFraction: 0.91, resetTime: "2026-12-01T00:00:00Z" }],
        },
      ],
    });
    assert.equal(snaps.length, 3);
    assert.equal(snaps.find((x) => x.poolKey === "gemini" && x.windowKey === "weekly").remainingPct, 74);
    assert.equal(snaps.find((x) => x.poolKey === "3p" && x.windowKey === "weekly").remainingPct, 91);
  });

  // 4. 绑定码规则锁定解析 + HTTPS / 防私网 SSRF 校验
  await test("invite:terms-locked-code-and-https-ssrf-guard", async () => {
    const built = buildInviteCode({
      serverUrl: "https://agy-family-ledger.example.workers.dev",
      memberToken: "agf_test_sample_token_01",
      ruleVersion: 2,
      ledgerMode: "prepaid",
      geminiFenPerWeeklyPct: 100,
      thirdPartyFenPerWeeklyPct: 180,
    });
    const parsed = parseInviteCode(`请复制这行绑定码：${built} 粘贴进侧边栏`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.serverUrl, "https://agy-family-ledger.example.workers.dev");
    assert.equal(parsed.memberToken, "agf_test_sample_token_01");
    assert.equal(parsed.agreedRules.ruleVersion, 2);
    assert.equal(parsed.agreedRules.ledgerMode, "prepaid");
    assert.equal(parsed.agreedRules.geminiFenPerWeeklyPct, 100);
    assert.equal(parsed.agreedRules.thirdPartyFenPerWeeklyPct, 180);

    // 兼容旧版短绑定码与本地 loopback 调试
    const legacy = parseInviteCode("https://demo.workers.dev#agf_test_sample_token_02");
    assert.equal(legacy.ok, true);
    assert.equal(legacy.agreedRules, null);
    assert.equal(parseInviteCode("http://127.0.0.1:18945#agf_test_sample_token_03").ok, true);

    // 拦截公网明文 http:// 与内网 LAN SSRF
    assert.equal(parseInviteCode("http://evil.example.com#agf_test_sample_token_04").ok, false, "公网必须强制 https");
    assert.equal(parseInviteCode("http://192.168.1.1:8080#agf_test_sample_token_05").ok, false, "必须拦截私网 IP");
    assert.equal(parseInviteCode("https://10.0.0.5#agf_test_sample_token_06").ok, false, "必须拦截 10.x 私网 IP");
  });

  // 5. 核心引擎测试初始化
  let mockNow = Date.parse("2026-11-26T10:00:00Z");
  const db = new DatabaseSync(":memory:");
  const store = new LedgerStore(wrapNodeSqliteAdapter(db), { nowFn: () => mockNow });
  await store.ensureSchema(SCHEMA_SQL);
  await store.updateSettings({
    ledger_mode: "prepaid",
    gemini_fen_per_weekly_pct: 100,
    third_party_fen_per_weekly_pct: 200,
    blackhole_min_single_drop_pct: 0.5,
    blackhole_warn_missing_pct: 5.0,
    blackhole_critical_missing_pct: 15.0,
  });

  const initDash = await store.getAdminDashboard();
  const owner = initDash.members.find((m) => m.role === "owner");
  assert.ok(owner);

  const alice = await store.createMember({ name: "熟人A", initialBalanceFen: 2000, lowBalanceFen: 200 });
  const bob = await store.createMember({ name: "熟人B", initialBalanceFen: 1000, lowBalanceFen: 200 });
  const resetIso = "2026-12-01T00:00:00Z";

  // 锚定基线 100%
  await store.ingestHeartbeat(owner.memberToken, {
    quotaSnapshots: [
      { poolKey: "gemini", windowKey: "weekly", remainingPct: 100.0, resetAt: resetIso, capturedAtMs: mockNow },
      { poolKey: "3p", windowKey: "weekly", remainingPct: 100.0, resetAt: resetIso, capturedAtMs: mockNow },
    ],
  });

  // 6. 多人并发加权分摊 + 90 秒心跳绝不重复扣费（复现并验证修复 Carbon High Proof 3）
  await test("billing:90s-heartbeats-never-double-charge-settled-member", async () => {
    mockNow += 80 * 1000; // 10:01:20
    const evA = { id: "c1:s1", modelName: "gemini-4-carbon-high", uncachedInputTokens: 100000, outputTokens: 25000, timestampMs: mockNow - 2000 };
    const rA1 = await store.ingestHeartbeat(alice.member_token, { usageEvents: [evA] });
    const rA2 = await store.ingestHeartbeat(alice.member_token, { usageEvents: [evA] });
    assert.equal(rA1.acceptedEvents, 1);
    assert.equal(rA2.acceptedEvents, 0);

    mockNow += 10 * 1000; // 10:01:30 组长快照 #1: 100% -> 98% (-2%)
    await store.ingestHeartbeat(owner.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 98.0, resetAt: resetIso, capturedAtMs: mockNow }],
    });
    const after1 = (await store.getAdminDashboard()).members.find((m) => m.id === alice.id);
    assert.equal(after1.balanceFen, 1800, "首次扣 2% = ¥2.00，余额 2000 -> 1800");

    // 熟人A 停手离开；接下来同一 5 分钟切片与跨边界 90s 内池子继续连降 3 次各 -2%
    for (const nextPct of [96.0, 94.0, 92.0]) {
      mockNow += 90 * 1000;
      await store.ingestHeartbeat(owner.memberToken, {
        quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: nextPct, resetAt: resetIso, capturedAtMs: mockNow }],
      });
    }
    const after4 = (await store.getAdminDashboard()).members.find((m) => m.id === alice.id);
    assert.equal(after4.balanceFen, 1800, "已结算记录必须打标消耗，后续 90s 快照绝不得对已停手成员重复扣费");
  });

  // 7. 规则/单价变更防暗改：改价后立即写入审计记录 + 未确认成员冻结新价扣费 + 确认后恢复
  await test("trust:price-change-audit-freezes-unconfirmed-member-until-consent", async () => {
    const beforeVer = (await store.getSettings()).rule_version;
    await store.updateSettings({ gemini_fen_per_weekly_pct: 300 }); // 组长把单价从 ¥1 改成 ¥3
    const afterSet = await store.getSettings();
    assert.equal(afterSet.rule_version, beforeVer + 1, "修改单价必须递增 rule_version");

    const viewBeforeConfirm = await store.getMemberSelfView(bob.id, mockNow);
    assert.equal(viewBeforeConfirm.needsRuleConfirm, true, "未确认新单价的成员必须看到待确认标记");
    assert.ok(viewBeforeConfirm.recentRuleChanges.length >= 1, "必须返回公开规则变更记录");
    const mismatch = evaluateRuleMismatch(
      { ruleVersion: beforeVer, ledgerMode: "prepaid", geminiFenPerWeeklyPct: 100, thirdPartyFenPerWeeklyPct: 200 },
      viewBeforeConfirm
    );
    assert.equal(mismatch.mismatch, true, "客户端本地契约比对必须触发显著变价提示");

    // 熟人B 尚未点击确认新规则期间产生消耗 -> 占比照常透明记账，但绝不按新 ¥3 单价静默扣钱
    const bobBal0 = viewBeforeConfirm.balanceFen;
    mockNow += 2 * 60 * 1000;
    await store.ingestHeartbeat(bob.member_token, {
      usageEvents: [{ id: "unconfirmed:s1", modelName: "gemini-4-neon-xhigh", uncachedInputTokens: 200000, outputTokens: 50000, timestampMs: mockNow - 1000 }],
    });
    await store.ingestHeartbeat(owner.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 90.0, resetAt: resetIso, capturedAtMs: mockNow }],
    });
    const bobMid = (await store.getAdminDashboard()).members.find((m) => m.id === bob.id);
    assert.equal(bobMid.balanceFen, bobBal0, "成员确认新规则前，服务端绝不得按新单价静默扣费");

    // 熟人B 显式点击「确认接受新规则」后，下次消耗才按新单价 ¥3/1% 计费
    const conf = await store.confirmMemberRules(bob.member_token);
    assert.equal(conf.member.needsRuleConfirm, false);

    mockNow += 2 * 60 * 1000;
    await store.ingestHeartbeat(bob.member_token, {
      usageEvents: [{ id: "confirmed:s1", modelName: "gemini-4-neon-xhigh", uncachedInputTokens: 200000, outputTokens: 50000, timestampMs: mockNow - 1000 }],
    });
    await store.ingestHeartbeat(owner.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 89.0, resetAt: resetIso, capturedAtMs: mockNow }],
    });
    const bobAfter = (await store.getAdminDashboard()).members.find((m) => m.id === bob.id);
    assert.equal(bobAfter.balanceFen, bobBal0 - 300, "确认新规则后应准确按 ¥3/1% 扣 300 分");

    // 恢复单价为 ¥1/1% 并让两人确认以便后续测试
    await store.updateSettings({ gemini_fen_per_weekly_pct: 100 });
    await store.confirmMemberRules(alice.member_token);
    await store.confirmMemberRules(bob.member_token);
  });

  // 8. 防背锅上限 + 90 秒持续慢速偷跑黑洞捕捉（验证修复 Proof 4 & P1-1）
  await test("blackhole:slow-90s-drain-caught-and-tiny-reporter-cannot-be-scapegoated", async () => {
    mockNow += 60 * 1000;
    await store.ingestHeartbeat(owner.memberToken, {});
    await store.ingestHeartbeat(alice.member_token, {});
    await store.ingestHeartbeat(bob.member_token, {});

    // 1) 熟人A 只发了极小一句提问（约 12k 等效单位），但未装插件设备同时烧掉 8.5% 3P 池
    const aliceBalBefore = (await store.getAdminDashboard()).members.find((m) => m.id === alice.id).balanceFen;
    await store.ingestHeartbeat(alice.member_token, {
      usageEvents: [{ id: "tiny3p:s1", modelName: "claude-opus-5-5-high", uncachedInputTokens: 2000, outputTokens: 1000, timestampMs: mockNow - 1000 }],
    });
    mockNow += 90 * 1000;
    await store.ingestHeartbeat(owner.memberToken, {
      quotaSnapshots: [{ poolKey: "3p", windowKey: "weekly", remainingPct: 91.5, resetAt: resetIso, capturedAtMs: mockNow }],
    });
    const aliceAfterTiny = (await store.getAdminDashboard()).members.find((m) => m.id === alice.id);
    assert.ok(aliceBalBefore - aliceAfterTiny.balanceFen < 300, "轻度上报者绝不能替未装插件设备扛下 8.5% 全部账单");

    // 2) 全员在线零上报，每 90s 匀速偷跑 2.5% 3P（连续 4 次累计 10% + 此前未解释部分 >= 15%）-> 必须触发黑洞严重提醒！
    let cur3p = 91.5;
    for (let i = 0; i < 4; i++) {
      mockNow += 90 * 1000;
      cur3p -= 2.5;
      await store.ingestHeartbeat(owner.memberToken, {
        quotaSnapshots: [{ poolKey: "3p", windowKey: "weekly", remainingPct: cur3p, resetAt: resetIso, capturedAtMs: mockNow }],
      });
    }
    const d = await store.getAdminDashboard();
    assert.ok(
      d.alerts.some((a) => (a.kind === "blackhole_critical" || a.kind === "blackhole_warn") && a.pool_key === "3p"),
      "90 秒心跳下的匀速慢速未统计掉量必须被滚动窗口捕获，不能被单次门槛滤空"
    );
  });

  // 9. 离线跨周重置边界补算 + 本周期 week_bucket 归零隔离（验证修复 Proof 5 & P1-5）
  await test("billing:post-reset-offline-drop-captured-and-week-bucket-isolates-cycles", async () => {
    const nextResetIso = "2026-12-08T00:00:00Z";
    // 组长离线跨越 resetIso (2026-12-01T00:00:00Z)，新周期熟人B先消耗 18%（池子剩 82%）
    mockNow = Date.parse("2026-12-01T02:00:00Z");
    const bobBalBefore = (await store.getAdminDashboard()).members.find((m) => m.id === bob.id).balanceFen;
    await store.ingestHeartbeat(bob.member_token, {
      usageEvents: [
        { id: "newweek:s1", modelName: "gemini-4-carbon-high", uncachedInputTokens: 800000, outputTokens: 200000, timestampMs: mockNow - 5000 },
      ],
    });

    mockNow = Date.parse("2026-12-01T03:00:00Z");
    await store.ingestHeartbeat(owner.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 82.0, resetAt: nextResetIso, capturedAtMs: mockNow }],
    });

    const d = await store.getAdminDashboard();
    const bobNewWeek = d.members.find((m) => m.id === bob.id);
    const aliceNewWeek = d.members.find((m) => m.id === alice.id);
    assert.equal(aliceNewWeek.week.geminiPct, 0, "新周开启后旧周消耗不得混入本周期占比");
    assert.ok(bobNewWeek.week.geminiPct > 0, "跨重置边界的新周期真实消耗必须入账而非归零蒸发");
    assert.ok(bobNewWeek.balanceFen < bobBalBefore, "新周期消耗应正常扣费");
  });

  // 10. 安全边界：成员暂停拦截、防伪造快照、软停用归档保留历史账目、成员可见扣费明细与近 5h 活跃度
  await test("security:paused-blocked-soft-archive-preserves-history-and-member-transparency", async () => {
    // 1) 普通成员无法伪造总池水位
    const spoof = await store.ingestHeartbeat(alice.member_token, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 1.0, resetAt: "2026-12-08T00:00:00Z", capturedAtMs: mockNow }],
    });
    assert.equal(spoof.ignoredQuotaSnapshots, 1);

    // 2) 成员侧边栏可看到自己的分摊扣费明细 + 全组近 5h 活跃占比，且不泄露他人余额/凭证
    const viewA = await store.getMemberSelfView(alice.id, mockNow);
    assert.ok(Array.isArray(viewA.recentAllocations) && viewA.recentAllocations.length > 0, "成员端必须可查阅个人分摊扣费明细");
    const peersJson = JSON.stringify(viewA.peers);
    assert.ok(!peersJson.includes("agf_") && !peersJson.includes("balance"), "peers 列表严禁泄露凭证或余额");

    // 3) 暂停成员后心跳立即被拒
    await store.updateMember(alice.id, { status: "paused" });
    await assert.rejects(() => store.ingestHeartbeat(alice.member_token, {}), /暂停/);

    // 4) 对有历史账目的成员执行停用移除 -> 自动软归档并吊销凭证，全组历史预存总账不丢失
    const topupBefore = (await store.getAdminDashboard()).summary.totalTopupFen;
    const delRes = await store.deleteMember(alice.id);
    assert.equal(delRes.archived, true, "有历史记录的成员必须软停用归档，禁止硬删毁账");
    const topupAfter = (await store.getAdminDashboard()).summary.totalTopupFen;
    assert.equal(topupAfter, topupBefore, "停用归档后历史预存总账必须完整保留");
    await assert.rejects(() => store.ingestHeartbeat(alice.member_token, {}), /无效|停用/);
  });

  // 11. 兼容旧版 v1.1.0 数据库原地无损升级测试（确保不含新列的旧表先 ALTER 再建索引，绝不报错）
  await test("migration:v110-database-upgrades-in-place-without-data-loss", async () => {
    const legacyDb = new DatabaseSync(":memory:");
    legacyDb.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE members (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', member_token TEXT NOT NULL UNIQUE, balance_fen INTEGER NOT NULL DEFAULT 0, low_balance_fen INTEGER NOT NULL DEFAULT 200, status TEXT NOT NULL DEFAULT 'active', note TEXT NOT NULL DEFAULT '', last_seen_at TEXT, last_client_version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE usage_reports (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, slice_start_ms INTEGER NOT NULL, pool_key TEXT NOT NULL, model_name TEXT NOT NULL DEFAULT '', request_count INTEGER NOT NULL DEFAULT 0, uncached_input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, weighted_units REAL NOT NULL DEFAULT 0, reported_at TEXT NOT NULL);
      CREATE TABLE pool_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, pool_key TEXT NOT NULL, window_key TEXT NOT NULL, remaining_pct REAL NOT NULL, reset_at TEXT, reporter_member_id TEXT NOT NULL, captured_at_ms INTEGER NOT NULL);
      CREATE TABLE slice_allocations (id TEXT PRIMARY KEY, pool_key TEXT NOT NULL, slice_start_ms INTEGER NOT NULL, week_bucket TEXT NOT NULL, member_id TEXT NOT NULL, pool_drop_pct REAL NOT NULL, member_share_ratio REAL NOT NULL, attributed_pct REAL NOT NULL, weighted_units REAL NOT NULL, unit_price_fen_per_pct INTEGER NOT NULL, charge_fen INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE transactions (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, kind TEXT NOT NULL, amount_fen INTEGER NOT NULL, balance_after_fen INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE alerts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL, pool_key TEXT NOT NULL DEFAULT '', member_id TEXT NOT NULL DEFAULT '', missing_pct REAL NOT NULL DEFAULT 0, title TEXT NOT NULL, detail TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, qq_notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      INSERT INTO members (id, name, role, member_token, created_at, updated_at) VALUES ('owner_self', '旧组长', 'owner', 'agf_legacy_owner_token', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z');
    `);
    const upgraded = new LedgerStore(wrapNodeSqliteAdapter(legacyDb));
    await upgraded.ensureSchema(SCHEMA_SQL);
    const dash = await upgraded.getAdminDashboard();
    assert.equal(dash.ok, true);
    assert.equal(dash.members[0].name, "旧组长");
    assert.equal(dash.members[0].acceptedRuleVersion, 1);
    assert.ok(Array.isArray(dash.ruleChanges));
  });

  console.log(`\nALL E2E TESTS PASSED (${passed}/${passed})`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
