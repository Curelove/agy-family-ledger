/**
 * Antigravity 熟人家庭组额度账本 · 全链路自动化端到端验证
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
  // 1. 零隐私增量采集器单测
  await test("collector:extract-numeric-only-no-content-leak", async () => {
    const fakeLine = JSON.stringify({
      step_index: 7,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      model: "gemini-4-carbon-high",
      created_at: "2026-11-26T09:00:00Z",
      input_tokens: 50000,
      cache_read_tokens: 30000,
      cache_write_tokens: 5000,
      output_tokens: 2000,
      content: "TOP_SECRET_PASSWORD_DO_NOT_READ",
      thinking: "SECRET_THOUGHT",
    });
    const ev = extractNumericUsageFromLine(fakeLine, "abcdef123456-7890");
    assert.ok(ev);
    assert.equal(ev.poolKey, "gemini");
    assert.equal(ev.uncachedInputTokens, 15000);
    assert.equal(ev.cacheReadTokens, 30000);
    assert.equal(ev.outputTokens, 2000);
    assert.ok(!JSON.stringify(ev).includes("TOP_SECRET"), "不得包含任何正文文本");
  });

  await test("collector:incremental-offset-ignores-historical-lines", async () => {
    const convDir = path.join(tmpDir, "fake_root", "11111111-2222-3333-4444-555555555555", ".system_generated", "logs");
    fs.mkdirSync(convDir, { recursive: true });
    const logPath = path.join(convDir, "transcript.jsonl");
    const oldLine = JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      model: "gemini-4-neon-xhigh",
      created_at: "2026-11-26T08:00:00Z",
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 500,
    }) + "\n";
    fs.writeFileSync(logPath, oldLine, "utf8");

    const state = {};
    const first = scanIncrementalTranscriptUsage(state, [path.join(tmpDir, "fake_root")]);
    assert.equal(first.length, 0, "首次建档应锚定旧日志末尾，不翻历史旧账");

    const newLine = JSON.stringify({
      step_index: 2,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      model: "claude-opus-5-5-high",
      created_at: "2026-11-26T09:05:00Z",
      input_tokens: 20000,
      cache_read_tokens: 5000,
      output_tokens: 1500,
    }) + "\n";
    fs.appendFileSync(logPath, newLine, "utf8");
    const second = scanIncrementalTranscriptUsage(state, [path.join(tmpDir, "fake_root")]);
    assert.equal(second.length, 1);
    assert.equal(second[0].poolKey, "3p");
    assert.equal(second[0].outputTokens, 1500);
  });

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
          buckets: [
            { bucketId: "3p-weekly", remainingFraction: 0.91, resetTime: "2026-12-01T00:00:00Z" },
          ],
        },
      ],
    });
    assert.equal(snaps.length, 3);
    assert.equal(snaps.find((x) => x.poolKey === "gemini" && x.windowKey === "weekly").remainingPct, 74);
    assert.equal(snaps.find((x) => x.poolKey === "3p" && x.windowKey === "weekly").remainingPct, 91);
  });

  await test("invite:parse-single-line-binding-code-and-chat-message", async () => {
    const p1 = parseInviteCode("https://agy-family-ledger.example.workers.dev/#agf_test_sample_token_01");
    assert.equal(p1.ok, true);
    assert.equal(p1.serverUrl, "https://agy-family-ledger.example.workers.dev");
    assert.equal(p1.memberToken, "agf_test_sample_token_01");

    const p2 = parseInviteCode("朋友你好，粘贴这行绑定码：https://demo.workers.dev#agf_test_sample_token_02 即可连接");
    assert.equal(p2.ok, true);
    assert.equal(p2.serverUrl, "https://demo.workers.dev");
    assert.equal(p2.memberToken, "agf_test_sample_token_02");

    const p3 = parseInviteCode("https://demo.workers.dev/without-token");
    assert.equal(p3.ok, false);
  });

  // 2. 账本核心引擎全流程测试
  let mockNow = Date.parse("2026-11-26T10:00:00Z");
  const db = new DatabaseSync(":memory:");
  const store = new LedgerStore(wrapNodeSqliteAdapter(db), { nowFn: () => mockNow });
  await store.ensureSchema(SCHEMA_SQL);
  // 切换为正式扣费模式便于检验金额
  await store.updateSettings({
    calibration_dry_run: false,
    gemini_fen_per_weekly_pct: 100, // 1% = 1.00 元
    third_party_fen_per_weekly_pct: 200, // 1% = 2.00 元
    blackhole_min_single_drop_pct: 3.0,
    blackhole_warn_missing_pct: 5.0,
    blackhole_critical_missing_pct: 15.0,
  });

  const initDash = await store.getAdminDashboard();
  const owner = initDash.members.find((m) => m.role === "owner");
  assert.ok(owner, "必须自动创建组长账号");

  const alice = await store.createMember({ name: "熟人A", initialBalanceFen: 500, lowBalanceFen: 200 });
  const bob = await store.createMember({ name: "熟人B", initialBalanceFen: 1000, lowBalanceFen: 200 });
  const resetIso = "2026-12-01T00:00:00Z";

  // 锚定基线 100%
  await store.ingestHeartbeat(owner.memberToken, {
    nowMs: mockNow,
    quotaSnapshots: [
      { poolKey: "gemini", windowKey: "weekly", remainingPct: 100.0, resetAt: resetIso, capturedAtMs: mockNow },
      { poolKey: "3p", windowKey: "weekly", remainingPct: 100.0, resetAt: resetIso, capturedAtMs: mockNow },
    ],
  });

  await test("billing:concurrent-weighted-allocation-owner-exempt-and-idempotent", async () => {
    mockNow += 5 * 60 * 1000;
    // 组长(Neon 1x): 100k input + 25k output => base=200k * 1.0 = 200k
    // 熟人A(Carbon 3x): 100k input + 25k output => base=200k * 3.0 = 600k
    // 熟人B(Neon 1x): 100k input + 25k output => base=200k * 1.0 = 200k
    // 总加权 = 1000k，占比：组长 20%（免扣）、A 60%、B 20%
    // 全组掉 5% => A 分摊 3.0%（扣 300 分 = 3元，余额 500 -> 200 触发低余额预警！），B 分摊 1.0%（扣 100 分 = 1元）
    const evA = { id: "c1:s1", modelName: "gemini-4-carbon-high", uncachedInputTokens: 100000, outputTokens: 25000, timestampMs: mockNow - 2000 };
    const rA1 = await store.ingestHeartbeat(alice.member_token, { usageEvents: [evA] });
    const rA2 = await store.ingestHeartbeat(alice.member_token, { usageEvents: [evA] }); // 重复上报同一事件！
    assert.equal(rA1.acceptedEvents, 1);
    assert.equal(rA2.acceptedEvents, 0, "重复事件必须 100% 幂等去重");

    await store.ingestHeartbeat(bob.member_token, {
      usageEvents: [{ id: "cb:s1", modelName: "gemini-4-neon-xhigh", uncachedInputTokens: 100000, outputTokens: 25000, timestampMs: mockNow - 2000 }],
    });

    // 权威官方总池水位由组长设备上报
    await store.ingestHeartbeat(owner.memberToken, {
      usageEvents: [{ id: "co:s1", modelName: "gemini-4-neon-xhigh", uncachedInputTokens: 100000, outputTokens: 25000, timestampMs: mockNow - 2000 }],
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 95.0, resetAt: resetIso, capturedAtMs: mockNow }],
    });

    const d = await store.getAdminDashboard();
    const mO = d.members.find((m) => m.id === owner.id);
    const mA = d.members.find((m) => m.id === alice.id);
    const mB = d.members.find((m) => m.id === bob.id);

    assert.equal(mO.balanceFen, 0, "组长余额始终免扣");
    assert.equal(mO.week.geminiPct, 1);
    assert.equal(mA.week.geminiPct, 3);
    assert.equal(mA.balanceFen, 200, "熟人A应准确扣 300 分剩余 200 分");
    assert.equal(mB.week.geminiPct, 1);
    assert.equal(mB.balanceFen, 900, "熟人B应准确扣 100 分剩余 900 分");
    assert.ok(d.alerts.some((a) => a.kind === "low_balance" && a.member_id === alice.id), "熟人A跌至提醒线应触发低余额提醒");
  });

  await test("security:member-cannot-spoof-quota-snapshots-or-server-time", async () => {
    mockNow += 2 * 60 * 1000;
    const before = await store.getAdminDashboard();
    const beforeOwnerPct = before.members.find((m) => m.id === owner.id).week.geminiPct;
    const beforePoolPct = before.pools.gemini.weekly.remainingPct;

    // 恶意普通成员伪造未来时间 + 伪造总池暴跌至 10% + 伪造重置到 100%
    const spoofRes = await store.ingestHeartbeat(alice.member_token, {
      nowMs: mockNow + 365 * 24 * 3600 * 1000,
      quotaSnapshots: [
        { poolKey: "gemini", windowKey: "weekly", remainingPct: 10.0, resetAt: resetIso, capturedAtMs: mockNow + 99999999 },
        { poolKey: "gemini", windowKey: "weekly", remainingPct: 100.0, resetAt: "2099-01-01T00:00:00Z", capturedAtMs: mockNow + 99999999 },
      ],
    });
    assert.equal(spoofRes.ignoredQuotaSnapshots, 2, "默认 owner_only 模式下必须忽略普通成员上报的总池水位快照");

    const after = await store.getAdminDashboard();
    assert.equal(after.pools.gemini.weekly.remainingPct, beforePoolPct, "普通成员绝不能篡改官方总池水位");
    assert.equal(after.members.find((m) => m.id === owner.id).week.geminiPct, beforeOwnerPct, "普通成员绝不能干扰组长用量显示");
    assert.equal(after.alerts.filter((a) => a.kind === "quota_reset").length, 0, "普通成员绝不能伪造配额重置事件");
  });

  await test("security:offline-owner-overnight-catchup-settles-member-usage", async () => {
    // 组长电脑关机 8 小时，期间熟人 B 在 3 小时后使用 Gemini，8 小时后组长开机同步权威水位掉 2%
    mockNow += 3 * 3600 * 1000;
    const balBefore = (await store.getAdminDashboard()).members.find((m) => m.id === bob.id).balanceFen;
    await store.ingestHeartbeat(bob.member_token, {
      usageEvents: [{ id: "overnight:s1", modelName: "gemini-4-neon-xhigh", uncachedInputTokens: 300000, outputTokens: 80000, timestampMs: mockNow }],
    });

    mockNow += 5 * 3600 * 1000;
    await store.ingestHeartbeat(owner.memberToken, {
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 93.0, resetAt: resetIso, capturedAtMs: mockNow }],
    });

    const d = await store.getAdminDashboard();
    const bobAfter = d.members.find((m) => m.id === bob.id);
    assert.equal(bobAfter.balanceFen, balBefore - 200, "组长隔夜开机后应完整追溯熟人夜间 Token 并准确扣 2%（200 分）");
    assert.equal(d.alerts.filter((a) => a.kind.startsWith("blackhole")).length, 0, "正常隔夜结算不得误报黑洞");
  });

  await test("billing:topup-and-official-quota-reset-no-negative-charge", async () => {
    const tx = await store.recordTransaction(alice.id, { kind: "topup", amountFen: 500, note: "微信续充5元" });
    assert.equal(tx.balanceFen, 700);

    mockNow += 10 * 60 * 1000;
    // 模拟官方重置：Gemini 周池从 95% 反弹回 100%
    await store.ingestHeartbeat(owner.memberToken, {
      nowMs: mockNow,
      quotaSnapshots: [{ poolKey: "gemini", windowKey: "weekly", remainingPct: 100.0, resetAt: "2026-12-08T00:00:00Z", capturedAtMs: mockNow }],
    });
    const d = await store.getAdminDashboard();
    assert.equal(d.members.find((m) => m.id === alice.id).balanceFen, 700, "重置绝不能误扣或乱改余额");
    assert.ok(d.alerts.some((a) => a.kind === "quota_reset"), "应记录官方配额重置事件");
  });

  await test("blackhole:3-tier-anti-false-positive-filter", async () => {
    // 先把所有成员心跳刷为在线，但都不上报任何 3P Token
    mockNow += 2 * 60 * 1000;
    await store.ingestHeartbeat(owner.memberToken, { nowMs: mockNow });
    await store.ingestHeartbeat(alice.member_token, { nowMs: mockNow });
    await store.ingestHeartbeat(bob.member_token, { nowMs: mockNow });

    // 1) 单次微抖动 2%（低于 3% 滤波门槛）-> 绝不误报！
    mockNow += 3 * 60 * 1000;
    await store.ingestHeartbeat(owner.memberToken, {
      nowMs: mockNow,
      quotaSnapshots: [{ poolKey: "3p", windowKey: "weekly", remainingPct: 98.0, resetAt: resetIso, capturedAtMs: mockNow }],
    });
    let d = await store.getAdminDashboard();
    assert.equal(d.alerts.filter((a) => a.kind.startsWith("blackhole")).length, 0, "小于 3% 抖动禁止误报黑洞");

    // 2) 全员均在线但 3P 凭空继续暴跌 18%（98% -> 80%，零 Token 上报）-> 触发红色高危警报！
    mockNow += 6 * 60 * 1000;
    await store.ingestHeartbeat(owner.memberToken, {
      nowMs: mockNow,
      quotaSnapshots: [{ poolKey: "3p", windowKey: "weekly", remainingPct: 80.0, resetAt: resetIso, capturedAtMs: mockNow }],
    });
    d = await store.getAdminDashboard();
    const crit = d.alerts.find((a) => a.kind === "blackhole_critical" && a.pool_key === "3p");
    assert.ok(crit, "全员在线且凭空暴跌 18% 必须触发严重提醒");
  });

  await test("board:peer-shares-visible-without-leaking-tokens-or-balances", async () => {
    await store.updateSettings({ ledger_mode: "board_only", show_peer_shares_to_members: true });
    const view = await store.getMemberSelfView(alice.id, mockNow);
    assert.equal(view.pricing.ledgerMode, "board_only");
    assert.equal(view.isLowBalance, false, "纯看板模式不应触发低余额告警");
    assert.equal(view.peers.length, 3, "应返回全组 3 位成员的透明用量占比");
    const serialized = JSON.stringify(view.peers);
    assert.ok(!serialized.includes("agf_"), "peers 列表严禁泄露任何人的 memberToken");
    assert.ok(!serialized.includes("balance"), "peers 列表严禁泄露任何人的余额字段");
  });

  console.log(`\nALL E2E TESTS PASSED (${passed}/${passed})`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
