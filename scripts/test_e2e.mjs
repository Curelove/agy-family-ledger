/**
 * Antigravity 家庭组共享额度看板 · 全链路自动化端到端与红队安全回归验证 (v1.6.0)
 * 覆盖原有 17 组核心测试 + 12 组 v1.6.0 多账号防串号/边界加固红队对抗测试（合计 29 组）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  computeRuleNoteHash as engineNoteHash,
  computeAccountFingerprint as engineAccountHash,
  classifyModelPool as engineClassifyPool,
  getModelMultiplier,
  evaluateQuotaDelta,
} from "../shared/billing-engine.mjs";
import { LedgerStore, wrapNodeSqliteAdapter } from "../shared/ledger-store.mjs";
import {
  extractNumericUsageFromLine,
  scanIncrementalTranscriptUsage,
  getDefaultTranscriptRoots,
  parseQuotaSummaryResponse,
  fetchLocalUserStatus,
  parseInviteCode,
  buildInviteCode,
  evaluateRuleMismatch,
  computeRuleNoteHash as collectorNoteHash,
  computeAccountFingerprint as collectorAccountHash,
  maskEmailForLocalDisplay,
  classifyModelPool as collectorClassifyPool,
  SidecarLease,
  COLLECTION_STATES,
  MemberLedgerCollector,
} from "../member-plugin/sidecars/ledger/collector.mjs";
import {
  compareSemver,
  parseReleasesAtom,
  computeUpdateNotificationState,
  UpdateService,
} from "../member-plugin/sidecars/ledger/update-service.mjs";
import http from "node:http";

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
    const parsed = parseQuotaSummaryResponse({
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
    const snaps = parsed.snapshots;
    assert.equal(parsed.hasSeparateArgonPool, false);
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

    // 2) 成员侧边栏可看到自己的分摊扣费明细 + 全组近 5h 活跃占比，且不泄露他人余额/凭证，也不显示「（我自己）」误导文案
    const viewA = await store.getMemberSelfView(alice.id, mockNow);
    assert.ok(Array.isArray(viewA.recentAllocations) && viewA.recentAllocations.length > 0, "成员端必须可查阅个人分摊扣费明细");
    const peersJson = JSON.stringify(viewA.peers);
    assert.ok(!peersJson.includes("agf_") && !peersJson.includes("balance"), "peers 列表严禁泄露凭证或余额");
    const ownerPeerForAlice = viewA.peers.find((p) => p.role === "owner");
    assert.ok(ownerPeerForAlice && ownerPeerForAlice.name === "组长", "默认组长称呼应为「组长」，不得对组员显示「（我自己）」");

    // 兼容老库仍存有「组长（我自己）」时，成员视角自动剥离「（我自己）」后缀
    await store.updateMember(owner.id, { name: "组长（我自己）" });
    const viewALegacyOwner = await store.getMemberSelfView(alice.id, mockNow);
    assert.equal(viewALegacyOwner.peers.find((p) => p.role === "owner").name, "组长", "老库组长名含「（我自己）」时，对其他成员必须自动剥离");
    await store.updateMember(owner.id, { name: "组长" });

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

  // 12. 全组使用约定绑定码锁定、纯 JS 短哈希一致性与防暗改检测（含 v1.2.0 向后兼容）
  await test("usage-rules:invite-code-lock-note-hash-parity-and-tamper-detection", async () => {
    const sampleNote = "周池低于 20% 时优先留给有急事的成员";
    assert.equal(engineNoteHash(sampleNote), collectorNoteHash(sampleNote), "Worker 引擎与成员端文字指纹算法必须完全一致");

    const code = buildInviteCode({
      serverUrl: "https://agy-family-ledger.example.workers.dev",
      memberToken: "agf_test_rules_token_01",
      ruleVersion: 3,
      ledgerMode: "board_only",
      poolReserveFloorPct: 20,
      memberWeeklyCapPct: 30,
      applyCapToOwner: true,
      usageRuleNote: sampleNote,
    });
    assert.ok(code.includes("&rf=20&mc=30&ao=1&nh="));
    const parsed = parseInviteCode(code);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.agreedRules.poolReserveFloorPct, 20);
    assert.equal(parsed.agreedRules.memberWeeklyCapPct, 30);
    assert.equal(parsed.agreedRules.applyCapToOwner, true);
    assert.equal(parsed.agreedRules.usageRuleNoteHash, engineNoteHash(sampleNote));

    const matchingView = {
      role: "member",
      needsRuleConfirm: false,
      pricing: {
        ruleVersion: 3,
        ledgerMode: "board_only",
        geminiFenPerWeeklyPct: 100,
        thirdPartyFenPerWeeklyPct: 180,
        poolReserveFloorPct: 20,
        memberWeeklyCapPct: 30,
        applyCapToOwner: true,
        usageRuleNote: sampleNote,
        usageRuleNoteHash: engineNoteHash(sampleNote),
      },
    };
    assert.equal(evaluateRuleMismatch(parsed.agreedRules, matchingView).mismatch, false);

    // 即使版本号未变，只要云端暗自收紧上限或改成组长豁免或篡改补充说明，客户端也必须立刻拦截提示
    const tamperedCap = evaluateRuleMismatch(parsed.agreedRules, {
      ...matchingView,
      pricing: { ...matchingView.pricing, memberWeeklyCapPct: 20 },
    });
    assert.equal(tamperedCap.mismatch, true);
    assert.equal(tamperedCap.isBoardOnlyChange, true);

    const tamperedOwnerScope = evaluateRuleMismatch(parsed.agreedRules, {
      ...matchingView,
      pricing: { ...matchingView.pricing, applyCapToOwner: false },
    });
    assert.equal(tamperedOwnerScope.mismatch, true);

    const tamperedNote = evaluateRuleMismatch(parsed.agreedRules, {
      ...matchingView,
      pricing: { ...matchingView.pricing, usageRuleNote: "改为仅限白天使用", usageRuleNoteHash: engineNoteHash("改为仅限白天使用") },
    });
    assert.equal(tamperedNote.mismatch, true);

    // 兼容 v1.2.0 绑定码（不含 rf/mc/ao/nh）连接未设约定的 v1.3.0 服务端时无误报
    const v120Parsed = parseInviteCode("https://demo.workers.dev#agf_legacy_v120_tok&v=1&m=board&g=100&p=180");
    assert.equal(v120Parsed.ok, true);
    const defaultV130View = {
      role: "member",
      needsRuleConfirm: false,
      pricing: {
        ruleVersion: 1,
        ledgerMode: "board_only",
        geminiFenPerWeeklyPct: 100,
        thirdPartyFenPerWeeklyPct: 180,
        poolReserveFloorPct: 0,
        memberWeeklyCapPct: 0,
        applyCapToOwner: true,
        usageRuleNote: "",
        usageRuleNoteHash: "",
      },
    };
    assert.equal(evaluateRuleMismatch(v120Parsed.agreedRules, defaultV130View).mismatch, false);
  });

  // 13. 纯看板模式下的全组使用约定版本审计、底线/上限触发状态与组长同等适用开关
  await test("usage-rules:board-only-version-audit-floor-cap-and-owner-scope", async () => {
    let t = Date.parse("2026-11-27T08:00:00Z");
    const db2 = new DatabaseSync(":memory:");
    const s2 = new LedgerStore(wrapNodeSqliteAdapter(db2), { nowFn: () => t });
    await s2.ensureSchema(SCHEMA_SQL);
    const d0 = await s2.getAdminDashboard();
    const own2 = d0.members.find((m) => m.role === "owner");
    const m1 = await s2.createMember({ name: "成员甲" });
    const m2 = await s2.createMember({ name: "成员乙" });

    assert.equal(d0.settings.ledger_mode, "board_only");
    assert.equal(d0.settings.rule_version, 1);
    assert.equal(d0.usageRules.hasUsageRules, false);

    // 组长设定三人组常用约定：总池留 20% 底线、单人参考上限 30%、全员同等适用
    await s2.updateSettings({
      pool_reserve_floor_pct: 20,
      member_weekly_cap_pct: 30,
      apply_cap_to_owner: true,
      usage_rule_note: "周日晚上临近重置前余量充足可放开",
    });
    const d1 = await s2.getAdminDashboard();
    assert.equal(d1.settings.rule_version, 2, "修改全组使用约定必须自动递增 rule_version");
    assert.equal(d1.ruleChanges.length, 1);
    assert.ok(d1.ruleChanges[0].next_summary.includes("20%") && d1.ruleChanges[0].next_summary.includes("30%"));

    const m1Before = await s2.getMemberSelfView(m1.id, t);
    assert.equal(m1Before.needsRuleConfirm, true, "纯看板模式修改使用约定后，成员侧边栏也必须收到确认提示");
    assert.equal(m1Before.usageRules.hasUsageRules, true);

    await s2.confirmMemberRules(m1.member_token);
    await s2.confirmMemberRules(m2.member_token);

    // 模拟消耗：成员甲先用掉 32%（超过 30% 单人参考上限），随后全组池降到 18%（触及 20% 总池保留底线）
    const rIso = "2026-12-03T00:00:00Z";
    await s2.ingestHeartbeat(own2.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 100, resetAt: rIso, capturedAtMs: t }],
    });
    t += 60_000;
    await s2.ingestHeartbeat(m1.member_token, {
      usageEvents: [{ id: "u1:s1", modelName: "gemini-4-carbon-high", uncachedInputTokens: 2_500_000, outputTokens: 800_000, timestampMs: t - 5000 }],
    });
    await s2.ingestHeartbeat(own2.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 68, resetAt: rIso, capturedAtMs: t }],
    });
    t += 60_000;
    await s2.ingestHeartbeat(own2.memberToken, {
      usageEvents: [{ id: "o1:s1", modelName: "gemini-4-carbon-high", uncachedInputTokens: 4_000_000, outputTokens: 1_200_000, timestampMs: t - 5000 }],
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 18, resetAt: rIso, capturedAtMs: t }],
    });

    const m1After = await s2.getMemberSelfView(m1.id, t);
    assert.equal(m1After.usageRules.poolFloor.geminiReached, true, "剩余 18% 必须触发 20% 总池底线提醒");
    assert.equal(m1After.usageRules.memberCap.geminiReached, true, "成员甲已用 32% 必须触发 30% 单人参考上限提醒");
    assert.equal(m1After.peers.find((p) => p.name === "成员甲").capReached, true);
    assert.equal(m1After.peers.find((p) => p.role === "owner").capReached, true, "开启全员同等适用时，组长超 30% 也同样公开标示");

    // 组长改为仅约束普通成员 -> 版本号再次递增，成员收到明确变更通知，且组长不再计入单人上限
    await s2.updateSettings({ apply_cap_to_owner: false });
    const ownView = await s2.getMemberSelfView(own2.id, t);
    const m1ScopeChanged = await s2.getMemberSelfView(m1.id, t);
    assert.equal(ownView.pricing.ruleVersion, 3);
    assert.equal(ownView.usageRules.memberCap.applies, false);
    assert.equal(m1ScopeChanged.needsRuleConfirm, true, "调整组长适用范围必须触发成员确认，杜绝暗中双标");
  });

  // 14. 新版绑定码首次连接自动对齐同版本确认状态 + 中途暗改仍严格拦截
  await test("usage-rules:matching-v2-invite-auto-aligns-while-v3-change-prompts-confirm", async () => {
    const db3 = new DatabaseSync(":memory:");
    const s3 = new LedgerStore(wrapNodeSqliteAdapter(db3));
    await s3.ensureSchema(SCHEMA_SQL);
    const m = await s3.createMember({ name: "新成员丙" }); // 创建时为 v1
    await s3.updateSettings({
      pool_reserve_floor_pct: 20,
      member_weekly_cap_pct: 30,
      apply_cap_to_owner: true,
      usage_rule_note: "晚高峰错峰",
    }); // 升级为 v2

    const srv = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const tok = req.headers["x-member-token"] || "";
      let out;
      if (req.url === "/api/member/heartbeat") out = await s3.ingestHeartbeat(tok, body);
      else if (req.url === "/api/member/confirm-rules") out = await s3.confirmMemberRules(tok, body.ruleVersion);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      const colDir = fs.mkdtempSync(path.join(tmpDir, "col-"));
      const col = new MemberLedgerCollector({
        configPath: path.join(colDir, "config.json"),
        defaultConfigPath: path.join(colDir, "config.default.json"),
        statePath: path.join(colDir, "state.json"),
        transcriptRoots: [],
      });
      const v2Code = buildInviteCode({
        serverUrl: `http://127.0.0.1:${port}`,
        memberToken: m.member_token,
        ruleVersion: 2,
        ledgerMode: "board_only",
        poolReserveFloorPct: 20,
        memberWeeklyCapPct: 30,
        applyCapToOwner: true,
        usageRuleNote: "晚高峰错峰",
      });
      col.saveConfig({ inviteCode: v2Code });
      const r1 = await col.syncOnce();
      assert.equal(r1.ok, true);
      assert.equal(r1.state.ruleMismatch.mismatch, false, "与绑定码 100% 一致的 v2 首次入组不得弹出相同新旧对比的误报卡片");
      assert.equal(r1.state.memberView.needsRuleConfirm, false);

      // 组长后续收紧上限到 25%（v3）-> 立刻触发确认卡片，绝不自动确认
      await s3.updateSettings({ member_weekly_cap_pct: 25 });
      const r2 = await col.syncOnce();
      assert.equal(r2.ok, true);
      assert.equal(r2.state.ruleMismatch.mismatch, true, "后续任何规则变动必须触发成员确认卡片");
      assert.equal(r2.state.ruleMismatch.isBoardOnlyChange, true);
      assert.ok(r2.state.ruleMismatch.agreedSummary.includes("30%"));
      assert.ok(r2.state.ruleMismatch.currentSummary.includes("25%"));
    } finally {
      srv.close();
    }
  });

  // 15. 大批量积压队列（180 条记录）通过 batch 分批入库并一次同步清空队列
  await test("performance:180-queued-events-drain-in-80-item-batches-via-db-batch", async () => {
    const db4 = new DatabaseSync(":memory:");
    let batchCalls = 0;
    const baseAdapter = wrapNodeSqliteAdapter(db4);
    const wrappedAdapter = {
      ...baseAdapter,
      async batch(stmts) {
        batchCalls++;
        return await baseAdapter.batch(stmts);
      },
    };
    const s4 = new LedgerStore(wrappedAdapter);
    await s4.ensureSchema(SCHEMA_SQL);
    const m = await s4.createMember({ name: "重度成员丁" });

    let reqCount = 0;
    const srv = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const tok = req.headers["x-member-token"] || "";
      reqCount++;
      assert.ok((body.usageEvents || []).length <= 80, "单次心跳上报记录数不得超过 80 条");
      const out = await s4.ingestHeartbeat(tok, body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      const colDir = fs.mkdtempSync(path.join(tmpDir, "col-batch-"));
      const col = new MemberLedgerCollector({
        configPath: path.join(colDir, "config.json"),
        defaultConfigPath: path.join(colDir, "config.default.json"),
        statePath: path.join(colDir, "state.json"),
        transcriptRoots: [],
      });
      col.saveConfig({ serverUrl: `http://127.0.0.1:${port}`, memberToken: m.member_token });
      const now = Date.now();
      col.state.pendingEvents = Array.from({ length: 180 }, (_, idx) => ({
        id: `backlog:s${idx + 1}`,
        poolKey: "gemini",
        modelName: "gemini-4-neon-xhigh",
        requestCount: 1,
        uncachedInputTokens: 3000,
        cacheReadTokens: 10000,
        cacheWriteTokens: 0,
        outputTokens: 200,
        timestampMs: now - (180 - idx) * 1000,
      }));
      const beforeSync = col.getPublicState();
      assert.equal(beforeSync.pendingQueueCount, 180);
      assert.equal(beforeSync.pendingQueuePreview.length, 6, "待传预览最多返回 6 条精简摘要");
      assert.equal(beforeSync.syncInFlight, false);

      const res = await col.syncOnce();
      assert.equal(res.ok, true);
      assert.equal(res.state.pendingQueueCount, 0, "180 条积压记录应在同一轮同步内按 80/80/20 自动清空");
      assert.equal(res.state.pendingQueuePreview.length, 0);
      assert.equal(res.state.syncInFlight, false);
      assert.equal(res.state.lastSyncedBatch?.count, 180, "应保留最近一批已送达总数用于点击详情查看");
      assert.equal(res.state.lastSyncedBatch?.items?.length, 6, "最近一批已送达明细应保留最多 6 条模型摘要");
      assert.equal(reqCount, 3, "180 条应拆分为 3 次请求（80 + 80 + 20）");
      assert.ok(batchCalls >= 5, "服务端应使用 adapter.batch 分块写入");
      const cntRow = await wrappedAdapter.first("SELECT COUNT(*) AS cnt FROM usage_reports WHERE member_id = ?", [m.id]);
      assert.equal(Number(cntRow.cnt), 180, "180 条记录必须全部准确入库");
    } finally {
      srv.close();
    }
  });

  // 16. 内置 GitHub Releases 更新检查：Semver、API + Atom 限流降级、6h 缓存、版本忽略自动恢复与零注册表隐私约束
  await test("updater:github-api-atom-fallback-cache-ignore-and-privacy", async () => {
    assert.equal(compareSemver("1.4.0", "1.3.1"), 1);
    assert.equal(compareSemver("v1.4.0", "1.4.0"), 0);
    assert.equal(compareSemver("1.4.0", "1.4.0-rc.1"), 1);
    assert.equal(compareSemver("1.3.9", "1.4.0"), -1);

    const updSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, "member-plugin", "sidecars", "ledger", "update-service.mjs"),
      "utf8"
    );
    assert.ok(!/child_process|reg\.exe|execFile/i.test(updSrc), "更新服务严禁调用注册表或系统进程命令");

    const updDir = fs.mkdtempSync(path.join(tmpDir, "upd-"));
    const fakePluginRoot = path.join(updDir, "plugin");
    fs.mkdirSync(fakePluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(fakePluginRoot, "plugin.json"),
      JSON.stringify({
        name: "agy-family-ledger",
        version: "1.4.0",
        repository: { url: "https://github.com/Curelove/agy-family-ledger" },
      }),
      "utf8"
    );
    const cachePath = path.join(updDir, "update_cache.json");

    let ignoredVer = "";
    let apiHits = 0;
    let mockMode = "api_v150";

    const svc = new UpdateService({
      cachePath,
      pluginRoot: fakePluginRoot,
      getIgnoredVersion: () => ignoredVer,
      fetchJsonImpl: async (url) => {
        apiHits++;
        if (mockMode === "api_403") {
          const e = new Error("HTTP 403");
          e.statusCode = 403;
          throw e;
        }
        const tag = mockMode === "api_v160" ? "v1.6.0" : "v1.5.0";
        return {
          tag_name: tag,
          name: `家庭组额度看板 ${tag}`,
          html_url: `https://github.com/Curelove/agy-family-ledger/releases/tag/${tag}`,
          published_at: "2026-12-01T10:00:00Z",
          body: `### 更新内容\n- 新增 ${tag} 优化`,
          assets: [
            {
              name: `agy-family-ledger-plugin-${tag}.zip`,
              size: 42000,
              browser_download_url: `https://github.com/Curelove/agy-family-ledger/releases/download/${tag}/agy-family-ledger-plugin-${tag}.zip`,
            },
          ],
        };
      },
      fetchTextImpl: async () => `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>tag:github.com,2008:Repository/1/v1.5.2-beta.1</id>
            <link rel="alternate" href="/Curelove/agy-family-ledger/releases/tag/v1.5.2-beta.1"/>
            <title>v1.5.2-beta.1</title>
            <updated>2026-12-05T00:00:00Z</updated>
            <content type="html">&lt;p&gt;测试版&lt;/p&gt;</content>
          </entry>
          <entry>
            <id>tag:github.com,2008:Repository/1/v1.5.1</id>
            <link rel="alternate" href="/Curelove/agy-family-ledger/releases/tag/v1.5.1"/>
            <title>家庭组额度看板 v1.5.1</title>
            <updated>2026-12-04T00:00:00Z</updated>
            <content type="html">&lt;p&gt;修复 &amp;amp; 稳定性提升&lt;/p&gt;</content>
          </entry>
        </feed>`,
    });

    // 1) GitHub API 正常命中，解析 ZIP 资源并写入缓存
    const r1 = await svc.checkForUpdates({ force: false });
    assert.equal(r1.ok, true);
    assert.equal(r1.latestVersion, "1.5.0");
    assert.equal(r1.updateAvailable, true);
    assert.equal(r1.shouldNotify, true);
    assert.ok(r1.zipDownloadUrl.endsWith("agy-family-ledger-plugin-v1.5.0.zip"));
    assert.equal(apiHits, 1);

    // 2) 6 小时内再次静默检查直接命中缓存，不重复请求 GitHub
    const r2 = await svc.checkForUpdates({ force: false });
    assert.equal(r2.fromCache, true);
    assert.equal(apiHits, 1);

    // 3) 忽略 v1.5.0 后停止提醒，但发布更高版本 v1.6.0 时自动恢复提醒
    ignoredVer = "1.5.0";
    const rIgnored = svc.getCachedResult();
    assert.equal(rIgnored.isIgnored, true);
    assert.equal(rIgnored.shouldNotify, false);

    mockMode = "api_v160";
    const rHigher = await svc.checkForUpdates({ force: true });
    assert.equal(rHigher.latestVersion, "1.6.0");
    assert.equal(rHigher.isIgnored, false);
    assert.equal(rHigher.shouldNotify, true);

    // 4) GitHub API 触发 403 限流时自动降级到 releases.atom，优先选最新稳定版 v1.5.1 并正确解码实体
    ignoredVer = "";
    mockMode = "api_403";
    const rAtom = await svc.checkForUpdates({ force: true });
    assert.equal(rAtom.ok, true);
    assert.equal(rAtom.source, "github_atom");
    assert.equal(rAtom.latestVersion, "1.5.1");
    assert.ok(rAtom.bodySnippet.includes("修复 & 稳定性提升"), "Atom 内容实体应正确解码");

    const atomDirect = parseReleasesAtom("<feed></feed>");
    assert.equal(atomDirect, null);
    assert.equal(computeUpdateNotificationState({ ok: true, latestVersion: "1.5.0", updateAvailable: true }, "v1.5.0").shouldNotify, false);

    // 5) collector 持久化更新偏好且解绑时不清空
    const colDir = fs.mkdtempSync(path.join(tmpDir, "col-upd-"));
    const col = new MemberLedgerCollector({
      configPath: path.join(colDir, "config.json"),
      defaultConfigPath: path.join(colDir, "config.default.json"),
      statePath: path.join(colDir, "state.json"),
      transcriptRoots: [],
    });
    col.saveConfig({ autoCheckUpdates: false, ignoredUpdateVersion: "v1.5.0" });
    assert.equal(col.getPublicState().config.autoCheckUpdates, false);
    assert.equal(col.getPublicState().config.ignoredUpdateVersion, "1.5.0");
    const afterUnbind = col.unbind();
    assert.equal(afterUnbind.config.autoCheckUpdates, false);
    assert.equal(afterUnbind.config.ignoredUpdateVersion, "1.5.0");
  });

  // 17. 禁用 Claude 3P 池显式约定、即时违规标红、黑洞异常全组隐私公示与组员暂停态结构化识别
  await test("alerts:restrict-3p-violation-blackhole-broadcast-and-paused-classification", async () => {
    let t = Date.parse("2026-11-28T09:00:00Z");
    const db5 = new DatabaseSync(":memory:");
    const s5 = new LedgerStore(wrapNodeSqliteAdapter(db5), { nowFn: () => t });
    await s5.ensureSchema(SCHEMA_SQL);
    const d0 = await s5.getAdminDashboard();
    const own5 = d0.members.find((m) => m.role === "owner");
    const mem5 = await s5.createMember({ name: "组员戊", initialBalanceFen: 500, lowBalanceFen: 200 });

    // 开启「普通成员仅限 Gemini 池」+ 保持黑洞全组公示开启 -> 规则版本号递增并编码到绑定码 r3p=1
    await s5.updateSettings({
      restrict_3p_for_members: true,
      broadcast_blackhole_to_members: true,
      blackhole_min_single_drop_pct: 0.5,
      blackhole_warn_missing_pct: 5.0,
      blackhole_critical_missing_pct: 15.0,
    });
    const d1 = await s5.getAdminDashboard();
    assert.equal(d1.settings.rule_version, 2);
    assert.equal(d1.settings.restrict_3p_for_members, true);

    const codeR3p = buildInviteCode({
      serverUrl: "https://agy-family-ledger.example.workers.dev",
      memberToken: mem5.member_token,
      ruleVersion: 2,
      ledgerMode: "board_only",
      restrict3pForMembers: true,
    });
    assert.ok(codeR3p.includes("&r3p=1"));
    const parsedR3p = parseInviteCode(codeR3p);
    assert.equal(parsedR3p.agreedRules.restrict3pForMembers, true);

    // 组员确认规则后，哪怕只发了 1 次 Claude 3P 调用（尚未结算周水位下降），也应立即标红并写入组长异常记录
    await s5.confirmMemberRules(mem5.member_token);
    await s5.ingestHeartbeat(own5.memberToken, {
      quotaSnapshots: [
        { poolKey: "gemini", windowKey: "weekly", remainingPct: 90, resetAt: "2026-12-04T00:00:00Z", capturedAtMs: t },
        { poolKey: "3p", windowKey: "weekly", remainingPct: 80, resetAt: "2026-12-04T00:00:00Z", capturedAtMs: t },
      ],
    });
    t += 60_000;
    await s5.ingestHeartbeat(mem5.member_token, {
      usageEvents: [{ id: "bad3p:s1", modelName: "claude-opus-5-5-high", uncachedInputTokens: 6000, outputTokens: 1200, timestampMs: t - 1000 }],
    });
    // 组长自己使用 Claude 3P 不应被判定违规
    await s5.ingestHeartbeat(own5.memberToken, {
      usageEvents: [{ id: "own3p:s1", modelName: "claude-opus-5-5-high", uncachedInputTokens: 6000, outputTokens: 1200, timestampMs: t - 1000 }],
    });

    const mv5 = await s5.getMemberSelfView(mem5.id, t);
    assert.equal(mv5.usageRules.poolRestriction.thirdPartyViolated, true, "普通成员使用 3P 必须立即触发违规警示");
    assert.equal(mv5.peers.find((p) => p.name === "组员戊").poolViolated, true);
    assert.equal(mv5.peers.find((p) => p.role === "owner").poolViolated, false, "组长本人不受普通成员禁用 3P 约束");
    const dashAfter3p = await s5.getAdminDashboard(t);
    assert.equal(dashAfter3p.members.find((m) => m.id === mem5.id).poolViolated, true);
    assert.ok(dashAfter3p.alerts.some((a) => a.kind === "pool_violation" && a.member_id === mem5.id), "必须写入组长异常记录");
    assert.equal(mv5.groupAlerts.length, 0, "私人的 pool_violation / low_balance 告警严禁泄露进全组 groupAlerts");

    // 触发未统计黑洞异常 -> 开启公示时成员端 groupAlerts 可见，组长标已读后自动撤下
    for (let i = 0; i < 3; i++) {
      t += 90_000;
      await s5.ingestHeartbeat(own5.memberToken, {
        quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 90 - (i + 1) * 3, resetAt: "2026-12-04T00:00:00Z", capturedAtMs: t }],
      });
    }
    const mvWithBh = await s5.getMemberSelfView(mem5.id, t);
    assert.equal(mvWithBh.groupAlerts.length, 1, "开启黑洞公示时成员端必须收到未统计消耗全组提醒");
    assert.ok(mvWithBh.groupAlerts[0].kind === "blackhole_warn" || mvWithBh.groupAlerts[0].kind === "blackhole_critical");

    // 关闭黑洞公示 -> groupAlerts 清空
    await s5.updateSettings({ broadcast_blackhole_to_members: false });
    assert.equal((await s5.getMemberSelfView(mem5.id, t)).groupAlerts.length, 0, "关闭黑洞公示后成员端不再展示");

    // 重新开启并由组长标记已读 -> groupAlerts 自动撤下
    await s5.updateSettings({ broadcast_blackhole_to_members: true });
    await s5.acknowledgeAlert(mvWithBh.groupAlerts[0].id);
    assert.equal((await s5.getMemberSelfView(mem5.id, t)).groupAlerts.length, 0, "组长标记已读后全组公示应自动撤下");

    // 暂停该成员并通过真实 HTTP 回环验证 collector 归类为 accountBlocked.kind === 'paused' 且不套用网络报错前缀
    await s5.updateMember(mem5.id, { status: "paused" });
    const srv = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      try {
        const out = await s5.ingestHeartbeat(req.headers["x-member-token"] || "", body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
      const colDir = fs.mkdtempSync(path.join(tmpDir, "col-paused-"));
      const col = new MemberLedgerCollector({
        configPath: path.join(colDir, "config.json"),
        defaultConfigPath: path.join(colDir, "config.default.json"),
        statePath: path.join(colDir, "state.json"),
        transcriptRoots: [],
      });
      col.saveConfig({ serverUrl: `http://127.0.0.1:${port}`, memberToken: mem5.member_token });
      const syncRes = await col.syncOnce();
      assert.equal(syncRes.ok, false);
      assert.equal(syncRes.state.accountBlocked?.kind, "paused", "暂停状态应结构化归类为 accountBlocked.paused");
      assert.equal(syncRes.state.lastError, "", "暂停状态不得再套用「同步暂未送达」普通断网报错");
    } finally {
      srv.close();
    }
  });

  // =========================================================================
  // v1.6.0 新增 12 组红队对抗性回归测试（对应冻结规格书第七章）
  // =========================================================================

  function writeTranscriptStep(rootDir, convId, stepObj, mtimeMs = null) {
    const logDir = path.join(rootDir, convId, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "transcript.jsonl");
    fs.appendFileSync(logPath, JSON.stringify(stepObj) + "\n", "utf8");
    if (mtimeMs !== null) {
      const sec = mtimeMs / 1000;
      fs.utimesSync(logPath, sec, sec);
    }
    return logPath;
  }

  async function startLedgerHttpServer(ledgerStore, onRequest = null) {
    const srv = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const tok = req.headers["x-member-token"] || "";
      if (onRequest) onRequest({ url: req.url, method: req.method, token: tok, body });
      try {
        let out;
        if (req.url === "/api/member/heartbeat") out = await ledgerStore.ingestHeartbeat(tok, body);
        else if (req.url === "/api/member/confirm-rules") out = await ledgerStore.confirmMemberRules(tok, body.ruleVersion);
        else out = { ok: false, error: "not_found" };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { server: srv, port: srv.address().port };
  }

  // 18 (Red-Team #1). 切至 B 号自动暂停零入队 + 切回 A 号零翻旧账 + 恢复后新步正常采集
  await test("multi-account:auto-pause-on-account-b-and-zero-backfill-on-return-to-a", async () => {
    let t = Date.parse("2026-11-29T10:00:00Z");
    const dbM = new DatabaseSync(":memory:");
    const storeM = new LedgerStore(wrapNodeSqliteAdapter(dbM), { nowFn: () => t });
    await storeM.ensureSchema(SCHEMA_SQL);
    const mem = await storeM.createMember({ name: "多号成员甲" });

    const receivedBodies = [];
    const { server, port } = await startLedgerHttpServer(storeM, ({ body }) => receivedBodies.push(body));

    const emailA = "family-member-a@gmail.com";
    const emailB = "personal-secret-b@gmail.com";
    const hashA = collectorAccountHash(emailA);
    const hashB = collectorAccountHash(emailB);
    let currentEmail = emailA;
    let currentTier = "ultra";

    try {
      const workDir = fs.mkdtempSync(path.join(tmpDir, "rt-ma1-"));
      const brainRoot = path.join(workDir, "brain");
      fs.mkdirSync(brainRoot, { recursive: true });
      const cfgPath = path.join(workDir, "config.json");
      const stPath = path.join(workDir, "state.json");

      const col = new MemberLedgerCollector({
        configPath: cfgPath,
        defaultConfigPath: path.join(workDir, "config.default.json"),
        statePath: stPath,
        transcriptRoots: [brainRoot],
        nowFn: () => t,
        fetchUserStatusImpl: async () => ({
          ok: true,
          statusCode: 200,
          loggedIn: true,
          accountHash: collectorAccountHash(currentEmail),
          accountMasked: maskEmailForLocalDisplay(currentEmail),
          accountTier: currentTier,
        }),
        fetchQuotaSnapshotsImpl: async () => ({
          ok: true,
          statusCode: 200,
          hasSeparateArgonPool: false,
          snapshots: [
            { poolKey: "gemini", windowKey: "weekly", remainingPct: 88, resetAt: "2026-12-06T00:00:00Z", capturedAtMs: t },
          ],
        }),
      });

      col.saveConfig({ serverUrl: `http://127.0.0.1:${port}`, memberToken: mem.member_token });
      const initSync = await col.syncOnce();
      assert.equal(initSync.ok, true);
      assert.equal(initSync.state.accountGuard.collectionState, COLLECTION_STATES.ACTIVE_MATCH);
      assert.equal(col.config.boundAccountHash, hashA);
      assert.equal(col.config.boundAccountMasked, "fam***@gmail.com");

      // 明文邮箱绝不落盘任何本地文件
      const rawCfgDisk = fs.readFileSync(cfgPath, "utf8");
      const rawStDisk = fs.readFileSync(stPath, "utf8");
      assert.ok(!rawCfgDisk.includes(emailA) && !rawStDisk.includes(emailA), "明文完整邮箱严禁写入本地磁盘");

      // A 号产生 1 条步骤 -> 正常入队并上传
      t += 10_000;
      writeTranscriptStep(
        brainRoot,
        "conv-a-1",
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          model: "gemini-4-neon-xhigh",
          created_at: new Date(t).toISOString(),
          input_tokens: 15000,
          output_tokens: 2000,
        },
        t
      );
      const sA1 = await col.syncOnce();
      assert.equal(sA1.ok, true);
      const cntA1 = await storeM.db.first("SELECT COUNT(*) AS cnt FROM usage_reports WHERE member_id = ?", [mem.id]);
      assert.equal(Number(cntA1.cnt), 1, "A 号步骤应正常入库");

      // 切换至个人号 B -> 12s 守卫立切 PAUSED_ACCOUNT_MISMATCH
      currentEmail = emailB;
      currentTier = "pro";
      t += 12_000;
      const gB1 = await col.tickAccountGuard();
      assert.equal(gB1.state, COLLECTION_STATES.PAUSED_ACCOUNT_MISMATCH);

      // B 号期间新建多个会话与追加步骤，多次运行守卫与同步 -> 0 入队、0 上报、0 水位，但 memberView 照常刷新
      for (let i = 1; i <= 3; i++) {
        t += 12_000;
        writeTranscriptStep(
          brainRoot,
          `conv-b-${i}`,
          {
            step_index: i,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            model: "claude-opus-5-5-high",
            created_at: new Date(t).toISOString(),
            input_tokens: 90000,
            outputTokens: 8000,
            output_tokens: 8000,
          },
          t
        );
        await col.tickAccountGuard();
        assert.equal(col.state.pendingEvents.length, 0, "切至 B 号期间 pendingEvents 必须始终为 0");
      }
      const sB = await col.syncOnce();
      assert.equal(sB.ok, true, "切至 B 号仍应能正常拉取全组只读余量视图");
      assert.ok(sB.state.memberView && sB.state.memberView.id === mem.id);
      const lastWireB = receivedBodies[receivedBodies.length - 1];
      assert.equal(lastWireB.usageEvents.length, 0, "B 号心跳严禁发送任何 usageEvents");
      assert.equal(lastWireB.quotaSnapshots.length, 0, "B 号心跳严禁发送任何 quotaSnapshots");
      assert.equal(lastWireB.collectionStatus, "paused_account_mismatch");
      assert.ok(!JSON.stringify(lastWireB).includes(emailB), "上传载荷严禁包含明文邮箱");

      // 在切回 A 号前 B 号再写一条尾随步骤（模拟未触发最后一次 12s 守卫前的残留尾）
      t += 5_000;
      writeTranscriptStep(
        brainRoot,
        "conv-b-tail",
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          model: "gemini-4-carbon-high",
          created_at: new Date(t).toISOString(),
          input_tokens: 120000,
          output_tokens: 9000,
        },
        t
      );

      // 切回家庭组账号 A -> 必须先锚定 EOF 消除全部 B 号余尾，0 翻旧账！
      currentEmail = emailA;
      currentTier = "ultra";
      t += 10_000;
      const gBackA = await col.tickAccountGuard();
      assert.equal(gBackA.state, COLLECTION_STATES.ACTIVE_MATCH);
      assert.equal(col.state.pendingEvents.length, 0, "切回 A 号瞬间必须先全盘锚定 EOF，绝不翻出 B 号任何旧账");

      // 随后 A 号新增步骤 -> 正常采集并入库
      t += 10_000;
      writeTranscriptStep(
        brainRoot,
        "conv-a-2",
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          model: "gemini-4-neon-xhigh",
          created_at: new Date(t).toISOString(),
          input_tokens: 22000,
          output_tokens: 3000,
        },
        t
      );
      await col.syncOnce();
      const cntFinal = await storeM.db.first("SELECT COUNT(*) AS cnt FROM usage_reports WHERE member_id = ?", [mem.id]);
      assert.equal(Number(cntFinal.cnt), 2, "仅 A 号前后两条步骤入库，B 号所有会话彻底零混入");
    } finally {
      server.close();
    }
  });

  // 19 (Red-Team #2). 组长切到个人 100% Pro 号绝不触发假重置、假扣费或假黑洞告警（客户端+服务端+引擎三道防线）
  await test("multi-account:owner-switch-to-personal-100pct-never-triggers-false-reset-or-charge", async () => {
    let t = Date.parse("2026-11-29T12:00:00Z");
    const dbO = new DatabaseSync(":memory:");
    const storeO = new LedgerStore(wrapNodeSqliteAdapter(dbO), { nowFn: () => t });
    await storeO.ensureSchema(SCHEMA_SQL);
    await storeO.updateSettings({ ledger_mode: "prepaid", gemini_fen_per_weekly_pct: 100 });
    const d0 = await storeO.getAdminDashboard(t);
    const own = d0.members.find((m) => m.role === "owner");
    const mem = await storeO.createMember({ name: "组员子", initialBalanceFen: 2000 });

    const hashA = collectorAccountHash("owner-ultra-a@gmail.com");
    const hashB = collectorAccountHash("owner-personal-pro-b@gmail.com");
    const resetA = "2026-12-06T07:00:00Z";
    const resetB = "2026-12-04T00:00:00Z"; // 早于 resetA 超过 6 小时

    // 1) 组长在 A 号（周剩余 74%）同步并锁号
    await storeO.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: hashA,
      accountTier: "ultra",
      collectionStatus: "active",
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 74.0, resetAt: resetA, capturedAtMs: t }],
    });

    // 2) 服务端第二道防线：即使恶意或异常请求直接携带 B 号（100% Pro）或缺失指纹的快照，服务端一律拒收
    t += 90_000;
    const rogueB = await storeO.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: hashB,
      accountTier: "pro",
      collectionStatus: "active",
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 100.0, resetAt: resetB, capturedAtMs: t }],
    });
    assert.equal(rogueB.ignoredQuotaSnapshots, 1, "不匹配组长 bound_account_hash 的 B 号水位快照必须被服务端拒收");

    t += 90_000;
    const rogueEmpty = await storeO.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: "",
      collectionStatus: "active",
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 100.0, resetAt: resetB, capturedAtMs: t }],
    });
    assert.equal(rogueEmpty.ignoredQuotaSnapshots, 1, "已升级 v1.6.0 且已锁号的组长若突发无指纹快照，服务端也必须拒收");

    // 3) 组长切回 A 号（仍为 74%）-> 余额与告警全零误报
    t += 90_000;
    await storeO.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: hashA,
      accountTier: "ultra",
      collectionStatus: "active",
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 74.0, resetAt: resetA, capturedAtMs: t }],
    });

    const dash = await storeO.getAdminDashboard(t);
    assert.equal(dash.pools.gemini.weekly.remainingPct, 74.0, "总池水位绝不能被个人 B 号 100% 污染");
    assert.equal(dash.members.find((m) => m.id === own.id).accountTier, "ultra", "组长订阅档位绝不能被 B 号 Pro 覆盖");
    assert.equal(dash.members.find((m) => m.id === mem.id).balanceFen, 2000, "成员余额零误扣");
    assert.equal(
      dash.alerts.filter((a) => a.kind === "quota_reset" || a.kind.startsWith("blackhole")).length,
      0,
      "绝不产生假重置或假黑洞告警"
    );

    // 4) 引擎第三道防线：直接调用 evaluateQuotaDelta 模拟 reset_at 倒退 >6h -> isAnchorSwitch 熔断
    const deltaRewind = evaluateQuotaDelta(74.0, 100.0, resetA, resetB);
    assert.equal(deltaRewind.isAnchorSwitch, true);
    assert.equal(deltaRewind.isReset, false);
    assert.equal(deltaRewind.dropPct, 0);
  });

  // 20 (Red-Team #3). shared_owner_account 模式带 &ah= 绑定码：挂着 B 号首次粘贴立刻暂停保护，绝不绑错号，但可看全组余量
  await test("multi-account:shared-owner-account-mode-blocks-wrong-account-on-first-bind", async () => {
    let t = Date.parse("2026-11-29T14:00:00Z");
    const dbS = new DatabaseSync(":memory:");
    const storeS = new LedgerStore(wrapNodeSqliteAdapter(dbS), { nowFn: () => t });
    await storeS.ensureSchema(SCHEMA_SQL);
    const d0 = await storeS.getAdminDashboard(t);
    const own = d0.members.find((m) => m.role === "owner");
    const mem = await storeS.createMember({ name: "合租成员丑" });

    const hashShared = collectorAccountHash("shared-family-owner@gmail.com");
    const hashPersonal = collectorAccountHash("member-personal@gmail.com");

    await storeS.updateSettings({
      account_isolation_mode: "shared_owner_account",
      shared_account_hash: hashShared,
    });
    await storeS.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: hashShared,
      accountTier: "ultra",
      collectionStatus: "active",
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 66.5, resetAt: "2026-12-06T00:00:00Z", capturedAtMs: t }],
    });

    const { server, port } = await startLedgerHttpServer(storeS);
    try {
      const code = buildInviteCode({
        serverUrl: `http://127.0.0.1:${port}`,
        memberToken: mem.member_token,
        ruleVersion: 1,
        ledgerMode: "board_only",
        targetAccountHash: hashShared,
      });
      assert.ok(code.includes(`&ah=${hashShared}`), "shared 模式绑定码必须携带 &ah=<20位hex>");
      const parsed = parseInviteCode(code);
      assert.equal(parsed.targetAccountHash, hashShared);

      const workDir = fs.mkdtempSync(path.join(tmpDir, "rt-shared-"));
      const col = new MemberLedgerCollector({
        configPath: path.join(workDir, "config.json"),
        defaultConfigPath: path.join(workDir, "config.default.json"),
        statePath: path.join(workDir, "state.json"),
        transcriptRoots: [],
        nowFn: () => t,
        fetchUserStatusImpl: async () => ({
          ok: true,
          statusCode: 200,
          loggedIn: true,
          accountHash: hashPersonal,
          accountMasked: "mem***@gmail.com",
          accountTier: "free",
        }),
      });

      col.saveConfig({ inviteCode: code });
      const res = await col.syncOnce();
      assert.equal(res.ok, true);
      assert.equal(
        res.state.accountGuard.collectionState,
        COLLECTION_STATES.PAUSED_ACCOUNT_MISMATCH,
        "挂着个人号 B 粘贴带 &ah= 绑定码必须立刻进入 PAUSED_ACCOUNT_MISMATCH"
      );
      assert.notEqual(col.config.boundAccountHash, hashPersonal, "绝不得把个人号 B 误绑为目标账号");
      assert.equal(res.state.accountGuard.canSelfRebind, false, "shared_owner_account 模式下成员端不得允许自助换绑");
      assert.equal(res.state.memberView?.pools?.gemini?.weekly?.remainingPct, 66.5, "处于切号暂停态仍应能看到全组余量");
    } finally {
      server.close();
    }
  });

  // 21 (Red-Team #4). 解绑与换码立即净空待传队列，未绑定期间停止后台采集且重绑绝不翻旧账
  await test("lifecycle:unbind-and-rebind-purges-pending-queue-and-stops-background-harvest", async () => {
    let t = Date.parse("2026-11-29T15:00:00Z");
    const dbU = new DatabaseSync(":memory:");
    const storeU = new LedgerStore(wrapNodeSqliteAdapter(dbU), { nowFn: () => t });
    await storeU.ensureSchema(SCHEMA_SQL);
    const mem1 = await storeU.createMember({ name: "旧身份" });
    const mem2 = await storeU.createMember({ name: "新身份" });

    const { server, port } = await startLedgerHttpServer(storeU);
    try {
      const workDir = fs.mkdtempSync(path.join(tmpDir, "rt-unbind-"));
      const brainRoot = path.join(workDir, "brain");
      fs.mkdirSync(brainRoot, { recursive: true });

      const col = new MemberLedgerCollector({
        configPath: path.join(workDir, "config.json"),
        defaultConfigPath: path.join(workDir, "config.default.json"),
        statePath: path.join(workDir, "state.json"),
        transcriptRoots: [brainRoot],
        nowFn: () => t,
        fetchUserStatusImpl: async () => ({
          ok: true,
          statusCode: 200,
          loggedIn: true,
          accountHash: collectorAccountHash("user-u@gmail.com"),
          accountMasked: "use***@gmail.com",
          accountTier: "ultra",
        }),
      });

      // 先绑定到一个不可达端口，制造断网积压队列
      col.saveConfig({ serverUrl: "http://127.0.0.1:1", memberToken: mem1.member_token });
      await col.tickAccountGuard();
      t += 10_000;
      writeTranscriptStep(
        brainRoot,
        "conv-before-unbind",
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          model: "gemini-4-neon-xhigh",
          created_at: new Date(t).toISOString(),
          input_tokens: 30000,
          output_tokens: 2000,
        },
        t
      );
      await col.tickAccountGuard();
      assert.equal(col.state.pendingEvents.length, 1, "解绑前队列应积压 1 条");

      // 点击解绑 -> 队列必须立即清空！
      col.unbind();
      assert.equal(col.state.pendingEvents.length, 0, "unbind() 必须立即清空 pendingEvents");
      assert.equal(col.state.collectionState, COLLECTION_STATES.UNBOUND);

      // 未绑定期间新写对话日志并跑多轮守卫/同步 -> 队列始终为 0
      for (let i = 0; i < 3; i++) {
        t += 15_000;
        writeTranscriptStep(
          brainRoot,
          `conv-while-unbound-${i}`,
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            model: "gemini-4-carbon-high",
            created_at: new Date(t).toISOString(),
            input_tokens: 50000,
            output_tokens: 4000,
          },
          t
        );
        await col.tickAccountGuard();
        await col.syncOnce();
        assert.equal(col.state.pendingEvents.length, 0, "未绑定状态下严禁后台采集入队");
      }

      // 重新绑定新成员凭证 -> 绝不补传解绑前后的任何历史对话
      t += 10_000;
      col.saveConfig({ serverUrl: `http://127.0.0.1:${port}`, memberToken: mem2.member_token });
      const resRebind = await col.syncOnce();
      assert.equal(resRebind.ok, true);
      const cntMem2 = await storeU.db.first("SELECT COUNT(*) AS cnt FROM usage_reports WHERE member_id = ?", [mem2.id]);
      assert.equal(Number(cntMem2.cnt), 0, "重绑后绝不得把解绑前后历史对话补传到新凭证名下");
    } finally {
      server.close();
    }
  });

  // 22 (Red-Team #5). 插件停摆窗口（>45s）防翻旧账 + 手动暂停/恢复（从此刻起算）
  await test("lifecycle:plugin-disabled-gap-and-manual-pause-resume-from-now", async () => {
    let t = Date.parse("2026-11-29T16:00:00Z");
    const dbG = new DatabaseSync(":memory:");
    const storeG = new LedgerStore(wrapNodeSqliteAdapter(dbG), { nowFn: () => t });
    await storeG.ensureSchema(SCHEMA_SQL);
    const mem = await storeG.createMember({ name: "暂停恢复测试员" });
    const { server, port } = await startLedgerHttpServer(storeG);

    try {
      const workDir = fs.mkdtempSync(path.join(tmpDir, "rt-gap-"));
      const brainRoot = path.join(workDir, "brain");
      fs.mkdirSync(brainRoot, { recursive: true });
      const cfgPath = path.join(workDir, "config.json");
      const stPath = path.join(workDir, "state.json");
      const fakeUser = async () => ({
        ok: true,
        statusCode: 200,
        loggedIn: true,
        accountHash: collectorAccountHash("gap-tester@gmail.com"),
        accountMasked: "gap***@gmail.com",
        accountTier: "ultra",
      });

      const col1 = new MemberLedgerCollector({
        configPath: cfgPath,
        defaultConfigPath: path.join(workDir, "config.default.json"),
        statePath: stPath,
        transcriptRoots: [brainRoot],
        nowFn: () => t,
        fetchUserStatusImpl: fakeUser,
      });
      col1.saveConfig({ serverUrl: `http://127.0.0.1:${port}`, memberToken: mem.member_token });
      await col1.syncOnce();

      // 模拟插件被禁用 70 秒（>45s），期间用户在 t + 20s 产生 B 号新对话
      const bConvTime = t + 20_000;
      writeTranscriptStep(
        brainRoot,
        "conv-during-disabled-gap",
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          model: "claude-opus-5-5-high",
          created_at: new Date(bConvTime).toISOString(),
          input_tokens: 80000,
          output_tokens: 6000,
        },
        bConvTime
      );

      // t + 70s 插件重新启用（新实例重启）
      t += 70_000;
      const col2 = new MemberLedgerCollector({
        configPath: cfgPath,
        defaultConfigPath: path.join(workDir, "config.default.json"),
        statePath: stPath,
        transcriptRoots: [brainRoot],
        nowFn: () => t,
        fetchUserStatusImpl: fakeUser,
      });
      await col2.syncOnce();
      const cntAfterGap = await storeG.db.first("SELECT COUNT(*) AS cnt FROM usage_reports WHERE member_id = ?", [mem.id]);
      assert.equal(Number(cntAfterGap.cnt), 0, "插件停摆超过 45s 期间产生的对话在重启后绝不得翻旧账补扫");

      // 手动暂停 -> 产生对话 -> 恢复（从此刻起算）-> 暂停期对话 0 补扫，恢复后新对话首轮正常入账
      t += 10_000;
      col2.setManualPaused(true);
      await col2.syncOnce();
      assert.equal(col2.state.collectionState, COLLECTION_STATES.PAUSED_MANUAL);

      t += 10_000;
      writeTranscriptStep(
        brainRoot,
        "conv-during-manual-pause",
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          model: "gemini-4-carbon-high",
          created_at: new Date(t).toISOString(),
          input_tokens: 60000,
          output_tokens: 5000,
        },
        t
      );
      await col2.tickAccountGuard();
      assert.equal(col2.state.pendingEvents.length, 0);

      t += 10_000;
      col2.setManualPaused(false);
      await col2.syncOnce();
      const cntAfterResume = await storeG.db.first("SELECT COUNT(*) AS cnt FROM usage_reports WHERE member_id = ?", [mem.id]);
      assert.equal(Number(cntAfterResume.cnt), 0, "点击恢复统计后不得补扫手动暂停期间的历史记录");

      // 恢复后新建对话 -> 首轮必须完整入账
      t += 5_000;
      writeTranscriptStep(
        brainRoot,
        "conv-after-resume",
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          model: "gemini-4-neon-xhigh",
          created_at: new Date(t).toISOString(),
          input_tokens: 18000,
          output_tokens: 1500,
        },
        t
      );
      await col2.syncOnce();
      const cntFinal = await storeG.db.first("SELECT COUNT(*) AS cnt FROM usage_reports WHERE member_id = ?", [mem.id]);
      assert.equal(Number(cntFinal.cnt), 1, "恢复统计后的新对话首轮步骤必须正常采集入账");
    } finally {
      server.close();
    }
  });

  // 23 (Red-Team #6). 回退重试相同 step_index 不丢步 + step_index:0 与缺失 step_index 零碰撞 + 重扫幂等
  await test("collector:duplicate-step-index-on-retry-and-missing-step-index-no-collision", async () => {
    const root = path.join(tmpDir, "rt-step-idx");
    const t0 = Date.parse("2026-11-29T17:00:00Z");
    const logDir = path.join(root, "conv-retry-case", ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "transcript.jsonl");

    const lines = [
      // 真实捕获场景：同一会话回退重试产生两条 step_index: 110，不同时间戳与 Token（含 272,706）
      JSON.stringify({
        step_index: 110,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-xhigh",
        created_at: "2026-11-29T17:01:00.000Z",
        input_tokens: 272706,
        output_tokens: 1200,
      }),
      JSON.stringify({
        step_index: 110,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-xhigh",
        created_at: "2026-11-29T17:02:15.000Z",
        input_tokens: 185000,
        output_tokens: 2400,
      }),
      // 合法 step_index: 0
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-hydrogen-high",
        created_at: "2026-11-29T17:03:00.000Z",
        input_tokens: 5000,
        output_tokens: 300,
      }),
      // 两条均缺失 step_index（即使时间戳与 Token 完全相同，因 lineOffset 不同也绝不碰撞）
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "claude-opus-5-5-high",
        created_at: "2026-11-29T17:04:00.000Z",
        input_tokens: 9000,
        output_tokens: 600,
      }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "claude-opus-5-5-high",
        created_at: "2026-11-29T17:04:00.000Z",
        input_tokens: 9000,
        output_tokens: 600,
      }),
    ];
    fs.writeFileSync(logPath, lines.join("\n") + "\n", "utf8");
    const mtimeSec = (t0 + 300_000) / 1000;
    fs.utimesSync(logPath, mtimeSec, mtimeSec);

    const st1 = { installedAtMs: t0, fileOffsets: {} };
    const evs1 = scanIncrementalTranscriptUsage(st1, [root], { nowMs: t0 + 600_000 });
    assert.equal(evs1.length, 5, "5 条步骤必须全部采集，零丢步");
    const ids1 = new Set(evs1.map((e) => e.id));
    assert.equal(ids1.size, 5, "同 step_index 回退重试与无 step_index 记录必须拥有 5 个互不碰撞的唯一 ID");
    assert.ok(evs1[0].id.includes(":s110:") && evs1[1].id.includes(":s110:") && evs1[0].id !== evs1[1].id);
    assert.ok(evs1[2].id.includes(":s0:"), "合法 step_index:0 应生成 :s0: 前缀");
    assert.ok(evs1[3].id.includes(":ns:") && evs1[4].id.includes(":ns:") && evs1[3].id !== evs1[4].id, "缺失 step_index 应使用 :ns: 且按 lineOffset 去撞");

    // 从 0 重扫同一文件 -> 所有 ID 100% 确定性一致（保证服务端幂等去重）
    const st2 = { installedAtMs: t0, fileOffsets: {} };
    const evs2 = scanIncrementalTranscriptUsage(st2, [root], { nowMs: t0 + 600_000 });
    assert.deepEqual(
      evs2.map((e) => e.id),
      evs1.map((e) => e.id),
      "重扫同一日志行必须生成 100% 一致的幂等 ID"
    );
  });

  // 24 (Red-Team #7). antigravity-cli/brain 三端目录覆盖 + 老状态升级首次新增目录锚定末尾不翻旧账
  await test("collector:cli-brain-root-coverage-and-upgrade-eof-anchor", async () => {
    const fakeGeminiDir = path.join(tmpDir, "rt-cli-gemini");
    const roots = getDefaultTranscriptRoots({ ANTIGRAVITY_GEMINI_DIR: fakeGeminiDir });
    assert.ok(roots.some((r) => r.endsWith(path.join("antigravity", "brain"))));
    assert.ok(roots.some((r) => r.endsWith(path.join("antigravity-ide", "brain"))));
    assert.ok(roots.some((r) => r.endsWith(path.join("antigravity-cli", "brain"))), "必须覆盖 antigravity-cli/brain");

    const appRoot = path.join(fakeGeminiDir, "antigravity", "brain");
    const cliRoot = path.join(fakeGeminiDir, "antigravity-cli", "brain");
    const tOldInstall = Date.parse("2026-11-20T00:00:00Z");
    const tNow = Date.parse("2026-11-29T18:00:00Z");

    // 已有 App 对话 + 升级前已存在的 CLI 历史对话（晚于 tOldInstall）
    const existingAppLog = writeTranscriptStep(
      appRoot,
      "app-existing",
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-xhigh",
        created_at: "2026-11-28T10:00:00Z",
        input_tokens: 10000,
        output_tokens: 500,
      },
      tNow - 3600_000
    );
    writeTranscriptStep(
      cliRoot,
      "cli-legacy-history",
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-carbon-high",
        created_at: "2026-11-29T10:00:00Z",
        input_tokens: 99000,
        output_tokens: 5000,
      },
      tNow - 1800_000
    );

    // 模拟 v1.5.0 老状态文件：无 knownRoots，仅记录了 appRoot 下的偏移
    const legacyState = {
      installedAtMs: tOldInstall,
      fileOffsets: {
        [existingAppLog.toLowerCase()]: fs.statSync(existingAppLog).size,
      },
    };

    const firstUpgradeScan = scanIncrementalTranscriptUsage(legacyState, [appRoot, cliRoot], { nowMs: tNow });
    assert.equal(firstUpgradeScan.length, 0, "老状态升级首次挂载 antigravity-cli/brain 时，旧历史对话必须锚定末尾零翻旧账");
    assert.ok(Array.isArray(legacyState.knownRoots) && legacyState.knownRoots.length >= 2);

    // 升级完成后在 antigravity-cli/brain 新开对话 -> 必须完整采集！
    writeTranscriptStep(
      cliRoot,
      "cli-brand-new",
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-xhigh",
        created_at: new Date(tNow + 5000).toISOString(),
        input_tokens: 24000,
        output_tokens: 1800,
      },
      tNow + 5000
    );
    const secondScan = scanIncrementalTranscriptUsage(legacyState, [appRoot, cliRoot], { nowMs: tNow + 10_000 });
    assert.equal(secondScan.length, 1, "升级后在 antigravity-cli/brain 新建的对话必须完整采集");
    assert.equal(secondScan[0].uncachedInputTokens, 24000);
  });

  // 25 (Red-Team #8). 非整 5 分钟重置点（07:02:12Z）：跨周重置秒级封账，旧周记录绝不漏入新周扣费
  await test("billing:cross-reset-mid-slice-timestamp-never-leaks-old-week-usage", async () => {
    let t = Date.parse("2026-12-03T06:55:00Z");
    const dbR = new DatabaseSync(":memory:");
    const storeR = new LedgerStore(wrapNodeSqliteAdapter(dbR), { nowFn: () => t });
    await storeR.ensureSchema(SCHEMA_SQL);
    await storeR.updateSettings({ ledger_mode: "prepaid", gemini_fen_per_weekly_pct: 100 });
    const d0 = await storeR.getAdminDashboard(t);
    const own = d0.members.find((m) => m.role === "owner");
    const oldWeekMember = await storeR.createMember({ name: "旧周成员", initialBalanceFen: 2000 });

    const oldResetIso = "2026-12-03T07:02:12Z";
    const newResetIso = "2026-12-10T07:02:12Z";

    await storeR.ingestHeartbeat(own.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 60.0, resetAt: oldResetIso, capturedAtMs: t }],
    });

    // 07:01:00Z（旧周，但落在 07:00:00Z~07:05:00Z 同一 5 分钟切片内）产生大额消耗
    t = Date.parse("2026-12-03T07:01:00Z");
    await storeR.ingestHeartbeat(oldWeekMember.member_token, {
      usageEvents: [
        { id: "old_week_heavy:s1", modelName: "gemini-4-carbon-high", uncachedInputTokens: 600000, outputTokens: 150000, timestampMs: t },
      ],
    });

    // 07:03:00Z 组长触发跨周重置快照（100%，新 resetAt）
    t = Date.parse("2026-12-03T07:03:00Z");
    await storeR.ingestHeartbeat(own.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 100.0, resetAt: newResetIso, capturedAtMs: t }],
    });

    // 验证旧周记录已被负号快照 ID 封账
    const sealedRow = await storeR.db.first("SELECT settled_snapshot_id FROM usage_reports WHERE member_id = ?", [oldWeekMember.id]);
    assert.ok(Number(sealedRow?.settled_snapshot_id) < 0, "旧周遗留未结算记录必须在跨周重置时被封账为负快照 ID");

    // 07:04:30Z（仍在 07:00:00Z 切片内！）新周水位下降 1%（99%）
    t = Date.parse("2026-12-03T07:04:30Z");
    await storeR.ingestHeartbeat(own.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 99.0, resetAt: newResetIso, capturedAtMs: t }],
    });

    const dashAfter = await storeR.getAdminDashboard(t);
    const mAfter = dashAfter.members.find((m) => m.id === oldWeekMember.id);
    assert.equal(mAfter.week.geminiPct, 0, "07:01:00Z 旧周记录绝不得混入新周百分比分摊");
    assert.equal(mAfter.balanceFen, 2000, "07:01:00Z 旧周记录绝不得在新周产生任何扣费");
  });

  // 26 (Red-Team #9). 模型归类（下划线词边界/Orchestrator/GPT-OSS）与 Pro 独立 Argon 桶动态隔离
  await test("billing:model-classification-underscore-orchestrator-and-pro-argon-isolation", async () => {
    const geminiModels = [
      "neon_xhigh",
      "flash_lite",
      "Orchestrator (Carbon)",
      "Orchestrator (Neon)",
      "Orchestrator (Argon)",
      "Orchestrator",
      "gemini-4-hydrogen-tiered-high",
      "gemini-4-argon-high",
    ];
    for (const m of geminiModels) {
      assert.equal(engineClassifyPool(m), "gemini", `engine 应将 ${m} 归入 gemini 池`);
      assert.equal(collectorClassifyPool(m), "gemini", `collector 应将 ${m} 归入 gemini 池`);
    }
    for (const m of ["GPT-OSS 120B", "gpt-oss-120b", "claude-opus-5-5-high", "claude-sonnet-5-5"]) {
      assert.equal(engineClassifyPool(m), "3p", `engine 应将 ${m} 归入 3p 池`);
      assert.equal(collectorClassifyPool(m), "3p", `collector 应将 ${m} 归入 3p 池`);
    }
    assert.equal(getModelMultiplier("Orchestrator (Carbon)"), 3.0);
    assert.equal(getModelMultiplier("Orchestrator (Argon)"), 1.5);
    assert.equal(getModelMultiplier("Orchestrator (Neon)"), 1.0);

    // parseQuotaSummaryResponse 识别 Pro 独立 Argon 桶 vs Ultra 共享池
    const proParsed = parseQuotaSummaryResponse({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", remainingFraction: 0.9, resetTime: "2026-12-06T00:00:00Z" },
            { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.75, resetTime: "2026-12-06T00:00:00Z" },
          ],
        },
      ],
    });
    assert.equal(proParsed.hasSeparateArgonPool, true, "未禁用的独立 argon 桶必须置 hasSeparateArgonPool=true");
    assert.equal(proParsed.snapshots.length, 1);

    const disabledArgonParsed = parseQuotaSummaryResponse({
      buckets: [
        { bucketId: "gemini-weekly", remainingFraction: 0.9, resetTime: "2026-12-06T00:00:00Z" },
        { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 1.0, disabled: true },
      ],
    });
    assert.equal(disabledArgonParsed.hasSeparateArgonPool, false, "disabled=true 的 argon 桶不得触发独立池隔离");

    // 端到端验证：禁用 3P 规则下使用 neon_xhigh / Orchestrator (Carbon) 绝不误报违规；Pro 独立 Argon 桶不混入普通 gemini 周池分摊，Ultra 下照常 1.5x 分摊
    let t = Date.parse("2026-11-30T08:00:00Z");
    const dbA = new DatabaseSync(":memory:");
    const storeA = new LedgerStore(wrapNodeSqliteAdapter(dbA), { nowFn: () => t });
    await storeA.ensureSchema(SCHEMA_SQL);
    await storeA.updateSettings({ restrict_3p_for_members: true });
    const d0 = await storeA.getAdminDashboard(t);
    const own = d0.members.find((m) => m.role === "owner");
    const argonUser = await storeA.createMember({ name: "Argon用户" });
    const neonUser = await storeA.createMember({ name: "Neon用户" });
    await storeA.confirmMemberRules(argonUser.member_token);
    await storeA.confirmMemberRules(neonUser.member_token);

    const rIso = "2026-12-07T00:00:00Z";
    await storeA.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: collectorAccountHash("pro-owner@gmail.com"),
      accountTier: "pro",
      hasSeparateArgonPool: true,
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 100.0, resetAt: rIso, capturedAtMs: t }],
    });

    t += 60_000;
    await storeA.ingestHeartbeat(argonUser.member_token, {
      usageEvents: [
        { id: "ag1:s1", modelName: "gemini-4-argon-high", uncachedInputTokens: 100000, outputTokens: 25000, timestampMs: t - 5000 },
      ],
    });
    await storeA.ingestHeartbeat(neonUser.member_token, {
      usageEvents: [
        { id: "ne1:s1", modelName: "neon_xhigh", uncachedInputTokens: 100000, outputTokens: 25000, timestampMs: t - 4000 },
        { id: "oc1:s2", modelName: "Orchestrator (Carbon)", uncachedInputTokens: 10000, outputTokens: 2000, timestampMs: t - 3000 },
      ],
    });
    await storeA.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: collectorAccountHash("pro-owner@gmail.com"),
      accountTier: "pro",
      hasSeparateArgonPool: true,
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 96.0, resetAt: rIso, capturedAtMs: t }],
    });

    const dashPro = await storeA.getAdminDashboard(t);
    assert.equal(dashPro.members.find((m) => m.id === neonUser.id).poolViolated, false, "neon_xhigh 与 Orchestrator (Carbon) 绝不得误触 3P 违规");
    assert.equal(dashPro.members.find((m) => m.id === argonUser.id).week.geminiPct, 0, "Pro 独立 Argon 桶开启时，Argon 用量不得替他人分摊普通 gemini 周池");
    assert.equal(dashPro.members.find((m) => m.id === neonUser.id).week.geminiPct, 4, "普通 gemini 周池掉落 4% 应全部分摊给 Neon/Orchestrator 用户");

    // 切换为 Ultra 共享池（has_separate_argon_pool = false）-> Argon 按 1.5x 正常参与分摊
    t += 60_000;
    await storeA.ingestHeartbeat(argonUser.member_token, {
      usageEvents: [
        { id: "ag2:s1", modelName: "gemini-4-argon-high", uncachedInputTokens: 100000, outputTokens: 25000, timestampMs: t - 5000 },
      ],
    });
    await storeA.ingestHeartbeat(neonUser.member_token, {
      usageEvents: [
        { id: "ne2:s1", modelName: "gemini-4-neon-xhigh", uncachedInputTokens: 100000, outputTokens: 25000, timestampMs: t - 4000 },
      ],
    });
    await storeA.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: collectorAccountHash("pro-owner@gmail.com"),
      accountTier: "ultra",
      hasSeparateArgonPool: false,
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 91.0, resetAt: rIso, capturedAtMs: t }],
    });
    const dashUltra = await storeA.getAdminDashboard(t);
    // 同等 token 下 Argon 1.5x vs Neon 1.0x -> 占 60%（5% * 0.6 = 3.0%）
    assert.equal(dashUltra.members.find((m) => m.id === argonUser.id).week.geminiPct, 3, "Ultra 共享池下 Argon 必须按 1.5x 权重分摊 3.0%");
  });

  // 27 (Red-Team #10). Pro vs Ultra 档位防背锅/黑洞基准自适应
  await test("billing:pro-vs-ultra-tier-adaptive-explainable-cap", async () => {
    let t = Date.parse("2026-11-30T10:00:00Z");
    const dbP = new DatabaseSync(":memory:");
    const storeP = new LedgerStore(wrapNodeSqliteAdapter(dbP), { nowFn: () => t });
    await storeP.ensureSchema(SCHEMA_SQL);
    const d0 = await storeP.getAdminDashboard(t);
    const own = d0.members.find((m) => m.role === "owner");
    const mem = await storeP.createMember({ name: "Pro组员" });
    const ownHash = collectorAccountHash("pro-group-owner@gmail.com");
    const rIso = "2026-12-07T00:00:00Z";

    // plan_tier 为默认 auto，组长上报 accountTier: "pro"
    assert.equal(d0.settings.plan_tier, "auto");
    await storeP.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: ownHash,
      accountTier: "pro",
      quotaSnapshots: [{ poolKey: "3p", windowKey: "weekly", remainingPct: 100.0, resetAt: rIso, capturedAtMs: t }],
    });

    // 单轮合理 Opus 消耗（约 44,000 加权单位），Pro 小池下降 3.5% -> Pro 基准 45,000 应全额解释 3.5%，零黑洞！
    t += 90_000;
    await storeP.ingestHeartbeat(mem.member_token, {
      usageEvents: [
        { id: "pro3p:s1", modelName: "claude-opus-5-5-high", uncachedInputTokens: 10000, outputTokens: 3000, timestampMs: t - 5000 },
      ],
    });
    await storeP.ingestHeartbeat(own.memberToken, {
      clientVersion: "1.6.0",
      accountHash: ownHash,
      accountTier: "pro",
      quotaSnapshots: [{ poolKey: "3p", windowKey: "weekly", remainingPct: 96.5, resetAt: rIso, capturedAtMs: t }],
    });

    const dashMid = await storeP.getAdminDashboard(t);
    assert.equal(dashMid.summary.effectivePlanTier, "pro");
    assert.equal(dashMid.members.find((m) => m.id === mem.id).week.thirdPartyPct, 3.5, "Pro 小池 3.5% 合理消耗必须全额正常分摊");
    assert.equal(
      dashMid.alerts.filter((a) => a.kind.startsWith("blackhole")).length,
      0,
      "Pro 合理单轮消耗不得误报黑洞告警"
    );

    // 未装插件偷跑 10%（分两次各 5%，无上报）-> 仍须准确触发黑洞告警！
    for (const nextRem of [91.5, 86.5]) {
      t += 90_000;
      await storeP.ingestHeartbeat(own.memberToken, {
        clientVersion: "1.6.0",
        accountHash: ownHash,
        accountTier: "pro",
        quotaSnapshots: [{ poolKey: "3p", windowKey: "weekly", remainingPct: nextRem, resetAt: rIso, capturedAtMs: t }],
      });
    }
    const dashAfterStealth = await storeP.getAdminDashboard(t);
    assert.ok(
      dashAfterStealth.alerts.some((a) => (a.kind === "blackhole_warn" || a.kind === "blackhole_critical") && a.pool_key === "3p"),
      "Pro 模式下未装插件偷跑 10% 仍必须准确报警"
    );
  });

  // 28 (Red-Team #11). SidecarLease 单实例租约抢占 + 连续 3 次本地 401/ECONNREFUSED 自愈与 10 分钟冷却锁
  await test("sidecar:single-instance-lease-and-ls-disconnect-cooldown-guard", async () => {
    const leaseDir = fs.mkdtempSync(path.join(tmpDir, "rt-lease-"));
    const leasePath = path.join(leaseDir, "active-sidecar.json");

    const lease1 = new SidecarLease({ leasePath, pollIntervalMs: 500 });
    lease1.acquire();
    assert.equal(lease1.isOwner(), true);

    let lostCount = 0;
    lease1.watchOwnership(() => {
      lostCount++;
    });

    const lease2 = new SidecarLease({ leasePath, pollIntervalMs: 500 });
    lease2.acquire();
    assert.equal(lease2.isOwner(), true);
    assert.equal(lease1.isOwner(), false, "第二个 SidecarLease 抢占后旧实例必须立刻失去所有权");

    // 等待 fs.watch 或短轮询触发 onLost
    await new Promise((r) => setTimeout(r, 120));
    lease1._notifyLostIfNeeded();
    assert.equal(lostCount, 1, "失锁回调必须触发且仅触发一次");
    lease1.stop();
    lease2.stop();

    // 连续 3 次 401 / ECONNREFUSED 触发受控自愈 + 10 分钟冷却锁防死循环
    let t = Date.parse("2026-11-30T11:00:00Z");
    const colDir = fs.mkdtempSync(path.join(tmpDir, "rt-heal-"));
    const cfgPath = path.join(colDir, "config.json");
    const stPath = path.join(colDir, "state.json");
    let healCalls = 0;

    const makeHostedCol = () =>
      new MemberLedgerCollector({
        configPath: cfgPath,
        defaultConfigPath: path.join(colDir, "config.default.json"),
        statePath: stPath,
        transcriptRoots: [],
        env: { ANTIGRAVITY_SIDECAR_WEB_PORT: "19999" },
        nowFn: () => t,
        fetchUserStatusImpl: async () => ({
          ok: false,
          statusCode: 401,
          code: "ECONNREFUSED",
          reason: "http_401",
          loggedIn: false,
          accountHash: "",
          accountMasked: "",
          accountTier: "",
        }),
        onSelfHealRequested: () => {
          healCalls++;
        },
      });

    const c1 = makeHostedCol();
    c1.saveConfig({ serverUrl: "https://demo.workers.dev", memberToken: "agf_heal_test_token_01" });
    await c1.tickAccountGuard(); // fail 1
    await c1.tickAccountGuard(); // fail 2
    assert.equal(healCalls, 0, "前 2 次失败不得触发自愈退出");
    const g3 = await c1.tickAccountGuard(); // fail 3
    assert.equal(g3.state, COLLECTION_STATES.PAUSED_IDENTITY_UNAVAILABLE);
    assert.equal(healCalls, 1, "连续第 3 次 401/ECONNREFUSED 必须触发受控自愈一次");

    // 2 分钟后宿主拉起新进程再次连续 3 次失败 -> 受 10 分钟冷却锁保护，绝不死循环重启
    t += 2 * 60 * 1000;
    const c2 = makeHostedCol();
    await c2.tickAccountGuard();
    await c2.tickAccountGuard();
    await c2.tickAccountGuard();
    assert.equal(healCalls, 1, "10 分钟冷却期内严禁重复触发自愈退出");
    assert.equal(c2.state.lsConnectionIssue?.coolingDown, true);

    // 超过 10 分钟后（+11 分钟）再次重启连续 3 次失败 -> 冷却解除允许再次自愈
    t += 11 * 60 * 1000;
    const c3 = makeHostedCol();
    await c3.tickAccountGuard();
    await c3.tickAccountGuard();
    await c3.tickAccountGuard();
    assert.equal(healCalls, 2, "满 10 分钟冷却后应重新允许一次受控自愈");
  });

  // 29 (Red-Team #12). v1.5.0 旧端兼容 + 多设备规则版本单调性 + 指纹算法一致 + 静态隐私零子进程红线扫描
  await test("compat:v150-legacy-client-and-multi-device-rule-version-monotonicity", async () => {
    // 1) Pure-JS SHA-256 (billing-engine) 与 Node crypto (collector) 指纹 100% 一致
    for (const email of ["Alice.Test@Gmail.com ", "a@b.co", "bruce771@example.org"]) {
      assert.equal(
        engineAccountHash(email),
        collectorAccountHash(email),
        `引擎与采集器对 ${email} 的账号短指纹必须 100% 一致`
      );
      assert.match(engineAccountHash(email), /^[0-9a-f]{20}$/);
    }
    assert.equal(maskEmailForLocalDisplay("alice.demo@example.com"), "ali***@example.com");
    assert.equal(maskEmailForLocalDisplay("ab@gmail.com"), "a***@gmail.com");

    // 2) v1.5.0 旧客户端不带 accountHash / deviceId 在 v1.6.0 服务端无缝运行
    let t = Date.parse("2026-11-30T12:00:00Z");
    const dbC = new DatabaseSync(":memory:");
    const storeC = new LedgerStore(wrapNodeSqliteAdapter(dbC), { nowFn: () => t });
    await storeC.ensureSchema(SCHEMA_SQL);
    const legacyMem = await storeC.createMember({ name: "旧版成员" });
    const multiDevMem = await storeC.createMember({ name: "多设备成员" });

    const legacyHb = await storeC.ingestHeartbeat(legacyMem.member_token, {
      clientVersion: "1.5.0",
      usageEvents: [{ id: "leg:s1", modelName: "gemini-4-neon-xhigh", uncachedInputTokens: 15000, outputTokens: 1000, timestampMs: t }],
    });
    assert.equal(legacyHb.ok, true);
    assert.equal(legacyHb.acceptedEvents, 1, "未升级的 v1.5.0 旧客户端必须正常接收上报");

    // 3) 多设备同步状态 + confirmMemberRules 版本严格单调不回退
    await storeC.updateSettings({ pool_reserve_floor_pct: 15 }); // v2
    await storeC.updateSettings({ pool_reserve_floor_pct: 20 }); // v3
    const confV3 = await storeC.confirmMemberRules(multiDevMem.member_token, 3);
    assert.equal(confV3.acceptedRuleVersion, 3);
    const confOldV2 = await storeC.confirmMemberRules(multiDevMem.member_token, 2);
    assert.equal(confOldV2.acceptedRuleVersion, 3, "旧设备提交 v2 确认绝不得把已确认的 v3 回退");

    await storeC.ingestHeartbeat(multiDevMem.member_token, {
      clientVersion: "1.6.0",
      deviceId: "dev_aaa111222333",
      accountHash: engineAccountHash("multi@gmail.com"),
      collectionStatus: "active",
    });
    await storeC.ingestHeartbeat(multiDevMem.member_token, {
      clientVersion: "1.6.0",
      deviceId: "dev_bbb444555666",
      accountHash: engineAccountHash("other@gmail.com"),
      collectionStatus: "paused_account_mismatch",
    });

    const dashC = await storeC.getAdminDashboard(t);
    assert.equal(dashC.members.find((m) => m.id === legacyMem.id).isLegacyClient, true);
    const mMulti = dashC.members.find((m) => m.id === multiDevMem.id);
    assert.equal(mMulti.acceptedRuleVersion, 3);
    assert.equal(mMulti.onlineDeviceCount, 2, "应准确汇总同一成员的 2 台在线匿名设备");
    assert.equal(mMulti.devices.length, 2);

    // 4) 静态隐私与零子进程红线扫描（成员插件运行时绝不含 child_process / execFile / spawn / reg.exe / 凭据库读取）
    const pluginFiles = [
      path.join(PROJECT_ROOT, "member-plugin", "sidecars", "ledger", "collector.mjs"),
      path.join(PROJECT_ROOT, "member-plugin", "sidecars", "ledger", "main.mjs"),
      path.join(PROJECT_ROOT, "member-plugin", "sidecars", "ledger", "update-service.mjs"),
    ];
    for (const fp of pluginFiles) {
      const src = fs.readFileSync(fp, "utf8");
      assert.ok(
        !/child_process|execFile|execSync|spawnSync|\bspawn\(|reg\.exe|CryptUnprotectData|keychain/i.test(src),
        `${path.basename(fp)} 违反零子进程/零凭据库安全红线`
      );
    }
  });

  // 30 (Total 29 tests). 实机回环 GetUserStatus（userTier 优先于 planName: "Pro"）+ 非回环拦截 + 零明文邮箱返回
  await test("collector:get-user-status-loopback-tier-priority-and-zero-plaintext-email", async () => {
    // 拦截非回环地址
    const blocked = await fetchLocalUserStatus({
      ANTIGRAVITY_LS_ADDRESS: "http://192.168.1.99:9000",
      ANTIGRAVITY_CSRF_TOKEN: "csrf_demo",
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "non_loopback_blocked");

    // 真实 127.0.0.1 HTTP 回环：planName 为 'Pro' 但 userTier 为 g1-ultra-tier -> 必须识别为 'ultra'
    const rawSecretEmail = "Ultra.Owner.Real@Gmail.com";
    const mockLs = http.createServer((req, res) => {
      if (req.headers["x-codeium-csrf-token"] !== "valid_csrf_123") {
        res.writeHead(401);
        res.end("unauthorized");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          userStatus: {
            email: rawSecretEmail,
            userTier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
            planStatus: { planInfo: { planName: "Pro" } },
          },
        })
      );
    });
    await new Promise((r) => mockLs.listen(0, "127.0.0.1", r));
    const lsPort = mockLs.address().port;
    try {
      const okRes = await fetchLocalUserStatus({
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${lsPort}`,
        ANTIGRAVITY_CSRF_TOKEN: "valid_csrf_123",
      });
      assert.equal(okRes.ok, true);
      assert.equal(okRes.loggedIn, true);
      assert.equal(okRes.accountTier, "ultra", "必须以 userStatus.userTier 为主判据，不能被 planName:'Pro' 误导");
      assert.equal(okRes.accountHash, collectorAccountHash(rawSecretEmail));
      assert.equal(okRes.accountMasked, "ult***@gmail.com");
      assert.ok(!JSON.stringify(okRes).toLowerCase().includes(rawSecretEmail.toLowerCase()), "返回值严禁包含明文完整邮箱");

      const unauthRes = await fetchLocalUserStatus({
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${lsPort}`,
        ANTIGRAVITY_CSRF_TOKEN: "wrong_csrf",
      });
      assert.equal(unauthRes.ok, false);
      assert.equal(unauthRes.statusCode, 401);
    } finally {
      mockLs.close();
    }
  });

  // 30. 红队终审加固：D1 零全表扫描（EXPLAIN QUERY PLAN）+ 水位拉取中毫秒级切号拦截 + Pro 独立 Argon 封账
  await test("redteam:d1-zero-full-table-scan-and-mid-rpc-switch-and-argon-seal", async () => {
    let t = Date.parse("2026-12-05T10:00:00Z");
    const dbOpt = new DatabaseSync(":memory:");
    const storeOpt = new LedgerStore(wrapNodeSqliteAdapter(dbOpt), { nowFn: () => t });
    await storeOpt.ensureSchema(SCHEMA_SQL);

    // 验证冷启动第二次 ensureSchema 走 _internal_schema_ver 快速路径（仅 1 次查询，零 DDL）
    let execCount = 0;
    const origExec = storeOpt.db.exec.bind(storeOpt.db);
    storeOpt.db.exec = async (sql) => {
      execCount += 1;
      return await origExec(sql);
    };
    await storeOpt.ensureSchema(SCHEMA_SQL);
    assert.equal(execCount, 0, "已升级到最新版本的数据库在 Worker 冷启动时必须跳过重复 DDL");

    // 验证高频心跳核心 SQL 100% 走复合索引（EXPLAIN QUERY PLAN 零 SCAN 全表扫描）
    const plansToCheck = [
      {
        label: "computeRecent5hStats",
        sql: `SELECT member_id, pool_key, SUM(weighted_units) AS total_units, SUM(request_count) AS reqs
                FROM usage_reports
               WHERE slice_start_ms >= ?
                 AND (CASE WHEN event_ts_ms > 0 THEN event_ts_ms ELSE slice_start_ms END) >= ?
               GROUP BY +member_id, +pool_key`,
        params: [t - 5 * 3600 * 1000 - 300_000, t - 5 * 3600 * 1000],
      },
      {
        label: "peerAllocsByPoolWeek",
        sql: `SELECT member_id, pool_key, SUM(attributed_pct) AS total_pct
                FROM slice_allocations
               WHERE (pool_key = 'gemini' AND week_bucket = ?) OR (pool_key = '3p' AND week_bucket = ?)
               GROUP BY +member_id, +pool_key`,
        params: ["rst_2026-12-10T00:00:00Z", "rst_2026-12-10T00:00:00Z"],
      },
      {
        label: "recentMemberAllocations",
        sql: `SELECT id, pool_key FROM slice_allocations WHERE member_id = ? ORDER BY created_at DESC LIMIT 20`,
        params: ["owner_self"],
      },
      {
        label: "insertAlertDedup",
        sql: `SELECT id FROM alerts WHERE kind = ? AND pool_key = ? AND member_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
        params: ["blackhole_warn", "gemini", "", "2026-12-05T09:30:00.000Z"],
      },
    ];
    for (const q of plansToCheck) {
      const planRows = dbOpt.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params);
      const detailText = planRows.map((r) => String(r.detail || "")).join(" | ");
      assert.ok(!/\bSCAN\s+(usage_reports|slice_allocations|alerts)\b/i.test(detailText), `${q.label} 不得触发全表扫描: ${detailText}`);
      assert.ok(/\bSEARCH\b/i.test(detailText), `${q.label} 必须命中索引 SEARCH: ${detailText}`);
    }

    // 验证 Pro 独立 Argon 桶开启时，被排除的 Argon 记录会被封账为负快照 ID（不残留 NULL）
    const d0 = await storeOpt.getAdminDashboard(t);
    const own = d0.members.find((m) => m.role === "owner");
    const proMem = await storeOpt.createMember({ name: "Pro成员", initialBalanceFen: 1000 });
    await storeOpt.ingestHeartbeat(own.memberToken, {
      accountHash: collectorAccountHash("owner.pro@example.com"),
      accountTier: "pro",
      hasSeparateArgonPool: true,
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 90, resetAt: "2026-12-10T00:00:00Z", capturedAtMs: t }],
    });
    t += 60_000;
    await storeOpt.ingestHeartbeat(proMem.member_token, {
      usageEvents: [
        { id: "argon_step:s1", modelName: "gemini-4-argon-high", uncachedInputTokens: 50000, outputTokens: 5000, timestampMs: t },
      ],
    });
    t += 60_000;
    await storeOpt.ingestHeartbeat(own.memberToken, {
      accountHash: collectorAccountHash("owner.pro@example.com"),
      accountTier: "pro",
      hasSeparateArgonPool: true,
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 89, resetAt: "2026-12-10T00:00:00Z", capturedAtMs: t }],
    });
    const argonRow = await storeOpt.db.first("SELECT settled_snapshot_id FROM usage_reports WHERE member_id = ?", [proMem.id]);
    assert.ok(Number(argonRow?.settled_snapshot_id) < 0, "Pro 独立 Argon 桶下被跳过的记录必须以负快照 ID 封账");

    // 验证水位 RPC 执行瞬间发生毫秒级切号（GetUserStatus 事前为 A，RetrieveUserQuotaSummary 返回 B 的 100%，事后复核变为 B）-> 客户端原子丢弃快照
    let receivedQuotas = [];
    const mockSrv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        if (Array.isArray(body.quotaSnapshots) && body.quotaSnapshots.length > 0) {
          receivedQuotas.push(...body.quotaSnapshots);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, member: { id: "owner_self", role: "owner", pricing: { ruleVersion: 1 } } }));
      });
    });
    await new Promise((r) => mockSrv.listen(0, "127.0.0.1", r));
    const srvPort = mockSrv.address().port;
    try {
      const workMid = path.join(tmpDir, "rt-mid-rpc");
      fs.mkdirSync(workMid, { recursive: true });
      const cfgMid = path.join(workMid, "config.json");
      const hashA = collectorAccountHash("family.a@example.com");
      const hashB = collectorAccountHash("personal.b@example.com");
      fs.writeFileSync(
        cfgMid,
        JSON.stringify({
          serverUrl: `http://127.0.0.1:${srvPort}`,
          memberToken: "agf_mid_rpc_token",
          boundAccountHash: hashA,
          boundAccountMasked: "fam***@example.com",
        }),
        "utf8"
      );
      let userCallIdx = 0;
      const colMid = new MemberLedgerCollector({
        configPath: cfgMid,
        defaultConfigPath: path.join(workMid, "config.default.json"),
        statePath: path.join(workMid, "state.json"),
        transcriptRoots: [workMid],
        fetchUserStatusImpl: async () => {
          userCallIdx += 1;
          // 第 1 次（tickAccountGuard）在 A 号，第 2 次（水位拉取后原子复核）已切到 B 号
          return userCallIdx === 1
            ? { ok: true, loggedIn: true, accountHash: hashA, accountMasked: "fam***@example.com", accountTier: "ultra" }
            : { ok: true, loggedIn: true, accountHash: hashB, accountMasked: "per***@example.com", accountTier: "pro" };
        },
        fetchQuotaImpl: async () => ({
          ok: true,
          hasSeparateArgonPool: true,
          snapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 100, resetAt: "2026-12-09T00:00:00Z", capturedAtMs: Date.now() }],
        }),
      });
      await colMid.syncOnce();
      assert.equal(receivedQuotas.length, 0, "水位拉取瞬间发生切号时，客户端后置原子复核必须丢弃快照");
    } finally {
      mockSrv.close();
    }
  });

  console.log(`\nALL E2E TESTS PASSED (${passed}/${passed})`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
