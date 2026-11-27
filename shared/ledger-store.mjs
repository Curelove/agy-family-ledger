/**
 * Antigravity 家庭组共享额度看板 · 统一数据存储层 (v1.3.1)
 *
 * 兼容两类 SQLite 后端（纯标准 JS，零 Node 专有依赖，可直接部署 Cloudflare Workers）：
 * 1. Cloudflare D1（通过 wrapD1Adapter(env.DB)）
 * 2. Node 22+ 内置 node:sqlite DatabaseSync（通过 wrapNodeSqliteAdapter(db)）
 */
import {
  DEFAULT_SETTINGS,
  alignSliceStartMs,
  classifyModelPool,
  computeWeightedUnits,
  deriveWeekBucket,
  evaluateQuotaDelta,
  allocateSliceUsage,
  evaluateBlackholeAlert,
  formatPricingRuleSummary,
  evaluateUsageRulesStatus,
  normalizePctLimit,
  sanitizeUsageRuleNote,
  computeRuleNoteHash,
} from "./billing-engine.mjs";

const BLACKHOLE_BUFFER_KEY = "_internal_blackhole_buffer";
const PRUNE_META_KEY = "_internal_last_prune_ms";
const RULE_PRICING_KEYS = [
  "ledger_mode",
  "pricing_mode",
  "gemini_fen_per_weekly_pct",
  "third_party_fen_per_weekly_pct",
  "gemini_fen_per_million_units",
  "third_party_fen_per_million_units",
  "pool_reserve_floor_pct",
  "member_weekly_cap_pct",
  "apply_cap_to_owner",
  "usage_rule_note",
];

function randomHex(bytes = 12) {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function formatYuan(fen) {
  return ((Number(fen) || 0) / 100).toFixed(2);
}

/**
 * 清洗 SQL 中的 `--` 单行注释后再按 `;` 分割，确保注释后紧跟的 CREATE TABLE / CREATE INDEX 绝不被误过滤
 */
function splitSqlStatements(sql = "") {
  const cleaned = String(sql || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return cleaned
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function wrapD1Adapter(d1) {
  return {
    async exec(sql) {
      for (const stmt of splitSqlStatements(sql)) {
        await d1.prepare(stmt).run();
      }
    },
    async first(sql, params = []) {
      const res = await d1.prepare(sql).bind(...params).first();
      return res ?? null;
    },
    async all(sql, params = []) {
      const res = await d1.prepare(sql).bind(...params).all();
      return Array.isArray(res?.results) ? res.results : [];
    },
    async run(sql, params = []) {
      return await d1.prepare(sql).bind(...params).run();
    },
    async batch(stmts = []) {
      if (!Array.isArray(stmts) || stmts.length === 0) return [];
      const prepared = stmts.map((s) => d1.prepare(s.sql).bind(...(s.params || [])));
      return await d1.batch(prepared);
    },
  };
}

export function wrapNodeSqliteAdapter(db) {
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async first(sql, params = []) {
      const stmt = db.prepare(sql);
      return stmt.get(...params) ?? null;
    },
    async all(sql, params = []) {
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    },
    async run(sql, params = []) {
      const stmt = db.prepare(sql);
      return stmt.run(...params);
    },
    async batch(stmts = []) {
      if (!Array.isArray(stmts) || stmts.length === 0) return [];
      const results = [];
      for (const s of stmts) {
        const stmt = db.prepare(s.sql);
        results.push(stmt.run(...(s.params || [])));
      }
      return results;
    },
  };
}

export class LedgerStore {
  constructor(dbAdapter, { nowFn = () => Date.now() } = {}) {
    this.db = dbAdapter;
    this.nowFn = nowFn;
  }

  async ensureSchema(schemaSql) {
    if (schemaSql) {
      await this.db.exec(schemaSql);
    }

    // 兼容旧版数据库无缝原地升级（忽略列已存在错误）
    const migrations = [
      "ALTER TABLE members ADD COLUMN accepted_rule_version INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE usage_reports ADD COLUMN settled_snapshot_id INTEGER DEFAULT NULL",
      "ALTER TABLE usage_reports ADD COLUMN event_ts_ms INTEGER NOT NULL DEFAULT 0",
    ];
    for (const sql of migrations) {
      try {
        await this.db.run(sql);
      } catch {
        // 已存在该列时直接跳过
      }
    }

    // 补齐全部查询与结算所需索引及审计表
    const extraDdl = `
      CREATE INDEX IF NOT EXISTS idx_usage_reports_slice_pool ON usage_reports (slice_start_ms, pool_key);
      CREATE INDEX IF NOT EXISTS idx_usage_reports_member ON usage_reports (member_id, slice_start_ms);
      CREATE INDEX IF NOT EXISTS idx_usage_reports_unsettled ON usage_reports (pool_key, settled_snapshot_id, slice_start_ms);
      CREATE INDEX IF NOT EXISTS idx_pool_snapshots_lookup ON pool_snapshots (pool_key, window_key, captured_at_ms);
      CREATE INDEX IF NOT EXISTS idx_slice_alloc_member_week ON slice_allocations (member_id, week_bucket);
      CREATE INDEX IF NOT EXISTS idx_slice_alloc_time ON slice_allocations (slice_start_ms);
      CREATE INDEX IF NOT EXISTS idx_transactions_member ON transactions (member_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts (acknowledged, created_at);
      CREATE TABLE IF NOT EXISTS rule_changes (
        id TEXT PRIMARY KEY,
        rule_version INTEGER NOT NULL,
        changed_fields_json TEXT NOT NULL,
        prev_summary TEXT NOT NULL,
        next_summary TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rule_changes_version ON rule_changes (rule_version DESC);
    `;
    await this.db.exec(extraDdl);

    const existingSettings = await this.getSettings();
    const nowIso = new Date(this.nowFn()).toISOString();
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in existingSettings)) {
        await this.db.run(
          "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
          [key, JSON.stringify(val), nowIso]
        );
      }
    }

    const cntRow = await this.db.first("SELECT COUNT(*) AS cnt FROM members");
    if (!cntRow || Number(cntRow.cnt) === 0) {
      await this.createMember({
        id: "owner_self",
        name: "组长",
        role: "owner",
        initialBalanceFen: 0,
        lowBalanceFen: 0,
        note: "组长本人设备安装插件后自动计入全组占比，不参与扣费",
      });
    }
  }

  async getSettings() {
    const rows = await this.db.all("SELECT key, value FROM settings");
    const out = { ...DEFAULT_SETTINGS };
    let hasExplicitLedgerMode = false;
    for (const r of rows) {
      if (r.key === BLACKHOLE_BUFFER_KEY || r.key === PRUNE_META_KEY) continue;
      if (r.key === "ledger_mode") hasExplicitLedgerMode = true;
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    if (!hasExplicitLedgerMode) {
      out.ledger_mode = out.calibration_dry_run === false ? "prepaid" : "board_only";
    }
    out.rule_version = Math.max(1, Number(out.rule_version) || 1);
    out.pool_reserve_floor_pct = normalizePctLimit(out.pool_reserve_floor_pct, 95);
    out.member_weekly_cap_pct = normalizePctLimit(out.member_weekly_cap_pct, 100);
    out.apply_cap_to_owner = out.apply_cap_to_owner !== false;
    out.usage_rule_note = sanitizeUsageRuleNote(out.usage_rule_note);
    return out;
  }

  async updateSettings(patch = {}) {
    const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    const before = await this.getSettings();
    const normalized = { ...(patch || {}) };
    const changeNote = String(patch?.change_note || patch?.note || "").trim().slice(0, 160);
    delete normalized.rule_version; // 版本号仅由系统在规则或约定变化时自动递增

    if (normalized.ledger_mode === "board_only" || normalized.ledger_mode === "prepaid") {
      normalized.calibration_dry_run = normalized.ledger_mode !== "prepaid";
    } else if (normalized.calibration_dry_run !== undefined) {
      normalized.ledger_mode = normalized.calibration_dry_run ? "board_only" : "prepaid";
    }
    if ("pool_reserve_floor_pct" in normalized) {
      normalized.pool_reserve_floor_pct = normalizePctLimit(normalized.pool_reserve_floor_pct, 95);
    }
    if ("member_weekly_cap_pct" in normalized) {
      normalized.member_weekly_cap_pct = normalizePctLimit(normalized.member_weekly_cap_pct, 100);
    }
    if ("apply_cap_to_owner" in normalized) {
      normalized.apply_cap_to_owner = Boolean(normalized.apply_cap_to_owner);
    }
    if ("usage_rule_note" in normalized) {
      normalized.usage_rule_note = sanitizeUsageRuleNote(normalized.usage_rule_note);
    }

    const nowMs = this.nowFn();
    const nowIso = new Date(nowMs).toISOString();

    const changedPricingFields = {};
    for (const k of RULE_PRICING_KEYS) {
      if (k in normalized && normalized[k] !== undefined && normalized[k] !== before[k]) {
        changedPricingFields[k] = { before: before[k], after: normalized[k] };
      }
    }

    let nextRuleVersion = Number(before.rule_version) || 1;
    const pricingChanged = Object.keys(changedPricingFields).length > 0;
    if (pricingChanged) {
      nextRuleVersion = nextRuleVersion + 1;
      normalized.rule_version = nextRuleVersion;
    }

    for (const [k, v] of Object.entries(normalized)) {
      if (!allowedKeys.has(k)) continue;
      await this.db.run(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        [k, JSON.stringify(v), nowIso]
      );
    }

    const after = await this.getSettings();

    if (pricingChanged) {
      const prevSummary = formatPricingRuleSummary(before);
      const nextSummary = formatPricingRuleSummary(after);
      await this.db.run(
        `INSERT INTO rule_changes (id, rule_version, changed_fields_json, prev_summary, next_summary, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          `rc_${randomHex(8)}`,
          nextRuleVersion,
          JSON.stringify(changedPricingFields),
          prevSummary,
          nextSummary,
          changeNote,
          nowIso,
        ]
      );
      // 组长自身自动视为已确认新规则，普通成员须在各自侧边栏手动确认
      await this.db.run(
        "UPDATE members SET accepted_rule_version = ?, updated_at = ? WHERE role = 'owner'",
        [nextRuleVersion, nowIso]
      );
      const confirmHint =
        after.ledger_mode === "prepaid"
          ? "普通成员在侧边栏确认新规则前，系统不会按新单价静默扣费。"
          : "全体成员侧边栏已弹出变更对比，需各自查看确认。";
      await this.db.run(
        `INSERT INTO alerts (id, kind, severity, pool_key, member_id, missing_pct, title, detail, acknowledged, qq_notified, created_at)
         VALUES (?, 'rule_change', 'info', '', '', 0, ?, ?, 0, 1, ?)`,
        [
          `alt_${randomHex(8)}`,
          `规则版本已更新为 v${nextRuleVersion}`,
          `由「${prevSummary}」变更为「${nextSummary}」${changeNote ? `（说明：${changeNote}）` : ""}。${confirmHint}`,
          nowIso,
        ]
      );
    }

    return after;
  }

  async loadBlackholeBuffer() {
    const row = await this.db.first("SELECT value FROM settings WHERE key = ?", [BLACKHOLE_BUFFER_KEY]);
    if (!row?.value) return { gemini: [], "3p": [] };
    try {
      const parsed = JSON.parse(row.value);
      return {
        gemini: Array.isArray(parsed?.gemini) ? parsed.gemini : [],
        "3p": Array.isArray(parsed?.["3p"]) ? parsed["3p"] : [],
      };
    } catch {
      return { gemini: [], "3p": [] };
    }
  }

  async saveBlackholeBuffer(buf) {
    const nowIso = new Date(this.nowFn()).toISOString();
    await this.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      [BLACKHOLE_BUFFER_KEY, JSON.stringify(buf), nowIso]
    );
  }

  async maybePruneOldData(nowMs = this.nowFn()) {
    try {
      const row = await this.db.first("SELECT value FROM settings WHERE key = ?", [PRUNE_META_KEY]);
      const lastPruneMs = row?.value ? Number(JSON.parse(row.value)) : 0;
      if (Number.isFinite(lastPruneMs) && nowMs - lastPruneMs < 12 * 3600 * 1000) return;

      const cutoff30d = nowMs - 30 * 24 * 3600 * 1000;
      await this.db.run("DELETE FROM pool_snapshots WHERE captured_at_ms < ?", [cutoff30d]);
      await this.db.run(
        "DELETE FROM usage_reports WHERE settled_snapshot_id IS NOT NULL AND slice_start_ms < ?",
        [cutoff30d]
      );
      const nowIso = new Date(nowMs).toISOString();
      await this.db.run(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        [PRUNE_META_KEY, JSON.stringify(nowMs), nowIso]
      );
    } catch {
      // 定期清理失败不影响主流程
    }
  }

  async createMember({
    id = "",
    name = "",
    role = "member",
    initialBalanceFen = 0,
    lowBalanceFen = 200,
    note = "",
  } = {}) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("成员名称不能为空");
    const cleanRole = role === "owner" ? "owner" : "member";
    const memberId = String(id || `mem_${randomHex(6)}`);
    const memberToken = `agf_${randomHex(16)}`;
    const nowIso = new Date(this.nowFn()).toISOString();
    const initFen = Math.round(Number(initialBalanceFen) || 0);
    const lowFen = Math.max(0, Math.round(Number(lowBalanceFen) || 200));
    const settings = await this.getSettings();
    const ruleVer = Math.max(1, Number(settings.rule_version) || 1);

    await this.db.run(
      `INSERT INTO members (id, name, role, member_token, balance_fen, low_balance_fen, status, accepted_rule_version, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [memberId, cleanName, cleanRole, memberToken, initFen, lowFen, ruleVer, String(note || "").trim(), nowIso, nowIso]
    );

    if (initFen !== 0) {
      await this.db.run(
        `INSERT INTO transactions (id, member_id, kind, amount_fen, balance_after_fen, note, created_at)
         VALUES (?, ?, 'topup', ?, ?, ?, ?)`,
        [`tx_${randomHex(8)}`, memberId, initFen, initFen, "建档初始预存", nowIso]
      );
    }

    return await this.db.first("SELECT * FROM members WHERE id = ?", [memberId]);
  }

  async updateMember(memberId, patch = {}) {
    const cur = await this.db.first("SELECT * FROM members WHERE id = ?", [memberId]);
    if (!cur) throw new Error("未找到对应成员");
    const nextName = patch.name !== undefined ? String(patch.name).trim() || cur.name : cur.name;
    const nextRole = patch.role === "owner" || patch.role === "member" ? patch.role : cur.role;
    const nextStatus =
      patch.status === "paused" || patch.status === "active" || patch.status === "archived"
        ? patch.status
        : cur.status;
    if (cur.role === "owner" && nextStatus !== "active") {
      throw new Error("组长账号不能暂停或停用");
    }
    const nextLow =
      patch.lowBalanceFen !== undefined
        ? Math.max(0, Math.round(Number(patch.lowBalanceFen) || 0))
        : cur.low_balance_fen;
    const nextNote = patch.note !== undefined ? String(patch.note).trim() : cur.note;
    const nextToken = patch.rotateToken ? `agf_${randomHex(16)}` : cur.member_token;
    const nowIso = new Date(this.nowFn()).toISOString();

    await this.db.run(
      `UPDATE members
         SET name = ?, role = ?, status = ?, low_balance_fen = ?, note = ?, member_token = ?, updated_at = ?
       WHERE id = ?`,
      [nextName, nextRole, nextStatus, nextLow, nextNote, nextToken, nowIso, memberId]
    );
    return await this.db.first("SELECT * FROM members WHERE id = ?", [memberId]);
  }

  /**
   * 停用/移除成员：
   * - 若该成员已有历史充值或分摊记录，自动改为「软停用归档（archived）」并立刻吊销原绑定码，完整保留历史总账不失真；
   * - 若是刚建档且无任何历史账目的空成员，则直接清理。
   */
  async deleteMember(memberId) {
    const cur = await this.db.first("SELECT * FROM members WHERE id = ?", [memberId]);
    if (!cur) throw new Error("未找到对应成员");
    if (cur.role === "owner") {
      const owners = await this.db.first("SELECT COUNT(*) AS cnt FROM members WHERE role = 'owner' AND status = 'active'");
      if (Number(owners?.cnt || 0) <= 1) {
        throw new Error("至少需保留一位组长账号，无法停用或删除");
      }
    }

    const txCnt = await this.db.first("SELECT COUNT(*) AS cnt FROM transactions WHERE member_id = ?", [memberId]);
    const allocCnt = await this.db.first("SELECT COUNT(*) AS cnt FROM slice_allocations WHERE member_id = ?", [memberId]);
    const hasHistory = Number(txCnt?.cnt || 0) > 0 || Number(allocCnt?.cnt || 0) > 0;

    if (hasHistory) {
      const nowIso = new Date(this.nowFn()).toISOString();
      const revokedToken = `revoked_${randomHex(14)}`;
      await this.db.run(
        "UPDATE members SET status = 'archived', member_token = ?, updated_at = ? WHERE id = ?",
        [revokedToken, nowIso, memberId]
      );
      return {
        ok: true,
        archived: true,
        deletedId: memberId,
        message: "该成员已有历史记录，已停用并吊销原绑定码，历史账目已完整保留",
      };
    }

    await this.db.run("DELETE FROM usage_reports WHERE member_id = ?", [memberId]);
    await this.db.run("DELETE FROM members WHERE id = ?", [memberId]);
    return { ok: true, archived: false, deletedId: memberId, message: "已移除该成员" };
  }

  async recordTransaction(memberId, { kind = "topup", amountFen = 0, note = "" } = {}) {
    const cur = await this.db.first("SELECT * FROM members WHERE id = ?", [memberId]);
    if (!cur) throw new Error("未找到对应成员");
    const delta = Math.round(Number(amountFen) || 0);
    if (delta === 0) throw new Error("金额不能为 0");
    const cleanKind = ["topup", "adjust", "refund"].includes(kind) ? kind : "topup";
    const nowIso = new Date(this.nowFn()).toISOString();
    const txId = `tx_${randomHex(8)}`;

    // 使用单条原子 SQL 增减余额，杜绝并发心跳扣费与手动充值互相覆盖丢账
    await this.db.run("UPDATE members SET balance_fen = balance_fen + ?, updated_at = ? WHERE id = ?", [
      delta,
      nowIso,
      memberId,
    ]);
    const afterRow = await this.db.first("SELECT balance_fen FROM members WHERE id = ?", [memberId]);
    const nextBalance = Number(afterRow?.balance_fen || 0);

    await this.db.run(
      `INSERT INTO transactions (id, member_id, kind, amount_fen, balance_after_fen, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [txId, memberId, cleanKind, delta, nextBalance, String(note || "").trim(), nowIso]
    );
    return {
      ok: true,
      transaction: {
        id: txId,
        member_id: memberId,
        kind: cleanKind,
        amount_fen: delta,
        balance_after_fen: nextBalance,
        note: String(note || "").trim(),
        created_at: nowIso,
      },
      balanceFen: nextBalance,
    };
  }

  /**
   * 成员显式确认同意最新规则版本
   */
  async confirmMemberRules(memberToken, requestedVersion = null) {
    const token = String(memberToken || "").trim();
    if (!token) throw new Error("缺少成员凭证");
    const member = await this.db.first("SELECT * FROM members WHERE member_token = ?", [token]);
    if (!member) throw new Error("无效的成员凭证，请联系组长核对");
    if (member.status !== "active") {
      throw new Error("该成员账号已暂停或已停用，请联系组长");
    }
    const settings = await this.getSettings();
    const curVer = Math.max(1, Number(settings.rule_version) || 1);
    const targetVer =
      requestedVersion !== null && Number.isFinite(Number(requestedVersion))
        ? Math.min(curVer, Math.max(1, Math.round(Number(requestedVersion))))
        : curVer;
    const nowMs = this.nowFn();
    const nowIso = new Date(nowMs).toISOString();

    await this.db.run(
      "UPDATE members SET accepted_rule_version = ?, updated_at = ? WHERE id = ?",
      [targetVer, nowIso, member.id]
    );

    const selfView = await this.getMemberSelfView(member.id, nowMs);
    return { ok: true, acceptedRuleVersion: targetVer, member: selfView };
  }

  async getLatestPoolSnapshots() {
    const pools = {};
    for (const poolKey of ["gemini", "3p"]) {
      pools[poolKey] = {};
      for (const windowKey of ["5h", "weekly"]) {
        const row = await this.db.first(
          `SELECT remaining_pct, reset_at, captured_at_ms, reporter_member_id
             FROM pool_snapshots
            WHERE pool_key = ? AND window_key = ?
            ORDER BY captured_at_ms DESC, id DESC
            LIMIT 1`,
          [poolKey, windowKey]
        );
        pools[poolKey][windowKey] = row
          ? {
              remainingPct: Number(row.remaining_pct),
              resetAt: row.reset_at || null,
              capturedAtMs: Number(row.captured_at_ms),
            }
          : null;
      }
    }
    return pools;
  }

  async markUsageReportsSettled(ids = [], snapshotId) {
    if (!Array.isArray(ids) || ids.length === 0 || !snapshotId) return;
    const chunkSize = 40;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      await this.db.run(
        `UPDATE usage_reports SET settled_snapshot_id = ? WHERE settled_snapshot_id IS NULL AND id IN (${placeholders})`,
        [snapshotId, ...chunk]
      );
    }
  }

  async settleWeeklyDrop({
    poolKey,
    snapshotId,
    dropPct,
    fromSliceMs,
    toSliceMs,
    minEventTsMs = 0,
    resetAt,
    capturedAtMs,
    nowMs,
    nowIso,
    settings,
    newAlerts,
  }) {
    const unsettledRows = await this.db.all(
      `SELECT u.id, u.member_id AS memberId, m.role AS role,
              COALESCE(m.accepted_rule_version, 1) AS acceptedRuleVersion,
              u.weighted_units AS weightedUnits, u.event_ts_ms AS eventTsMs, u.slice_start_ms AS sliceStartMs
         FROM usage_reports u
         JOIN members m ON m.id = u.member_id
        WHERE u.pool_key = ?
          AND u.settled_snapshot_id IS NULL
          AND u.slice_start_ms >= ?
          AND u.slice_start_ms <= ?`,
      [poolKey, fromSliceMs, toSliceMs]
    );

    const eligibleRows =
      minEventTsMs > 0
        ? unsettledRows.filter((r) => {
            const ts = Number(r.eventTsMs) > 0 ? Number(r.eventTsMs) : Number(r.sliceStartMs);
            return ts >= minEventTsMs;
          })
        : unsettledRows;

    const byMember = new Map();
    const consumedIds = [];
    for (const r of eligibleRows) {
      consumedIds.push(r.id);
      const prev = byMember.get(r.memberId) || {
        memberId: r.memberId,
        role: r.role,
        acceptedRuleVersion: Number(r.acceptedRuleVersion || 1),
        weightedUnits: 0,
      };
      prev.weightedUnits += Number(r.weightedUnits || 0);
      byMember.set(r.memberId, prev);
    }

    const allocResult = allocateSliceUsage({
      poolKey,
      poolDropPct: dropPct,
      memberUsages: Array.from(byMember.values()),
      settings,
    });

    // 立即将本次已参与结算的 usage_reports 打标，彻底杜绝后续 90 秒心跳重复拉出旧记录多次计费
    if (consumedIds.length > 0) {
      await this.markUsageReportsSettled(consumedIds, snapshotId);
    }

    const weekBucket = deriveWeekBucket(resetAt || "", capturedAtMs);
    const allocSliceMs = alignSliceStartMs(capturedAtMs);

    for (const a of allocResult.allocations) {
      if (a.attributedPct <= 0 && a.chargeFen <= 0) continue;
      const allocId = `${poolKey}:${snapshotId}:${a.memberId}`;
      const ins = await this.db.run(
        `INSERT OR IGNORE INTO slice_allocations
          (id, pool_key, slice_start_ms, week_bucket, member_id, pool_drop_pct, member_share_ratio, attributed_pct, weighted_units, unit_price_fen_per_pct, charge_fen, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          allocId,
          poolKey,
          allocSliceMs,
          weekBucket,
          a.memberId,
          a.poolDropPct,
          a.shareRatio,
          a.attributedPct,
          a.weightedUnits,
          a.unitPriceFenPerPct,
          a.chargeFen,
          nowIso,
        ]
      );
      const inserted = (ins?.changes ?? ins?.meta?.changes ?? 1) > 0;
      if (inserted && a.chargeFen > 0) {
        const targetBefore = await this.db.first(
          "SELECT id, name, balance_fen, low_balance_fen, role FROM members WHERE id = ?",
          [a.memberId]
        );
        if (targetBefore && targetBefore.role !== "owner") {
          const prevBal = Number(targetBefore.balance_fen || 0);
          // 原子 SQL 扣减余额，防并发丢失更新
          await this.db.run("UPDATE members SET balance_fen = balance_fen - ?, updated_at = ? WHERE id = ?", [
            a.chargeFen,
            nowIso,
            targetBefore.id,
          ]);
          const targetAfter = await this.db.first("SELECT balance_fen FROM members WHERE id = ?", [targetBefore.id]);
          const nextBal = Number(targetAfter?.balance_fen ?? prevBal - a.chargeFen);
          if (prevBal > Number(targetBefore.low_balance_fen || 0) && nextBal <= Number(targetBefore.low_balance_fen || 0)) {
            const lowAlert = await this.insertAlertDedup({
              kind: "low_balance",
              severity: "warning",
              poolKey,
              memberId: targetBefore.id,
              missingPct: 0,
              title: `成员「${targetBefore.name}」余额不足（剩余 ¥${formatYuan(nextBal)}）`,
              detail: `已低于提醒线 ¥${formatYuan(targetBefore.low_balance_fen)}，成员插件侧边栏已同步显示温和提醒。`,
              nowMs,
            });
            if (lowAlert) newAlerts.push(lowAlert);
          }
        }
      }
    }

    // 未解释消耗差值 -> 滚动累计防误报滤波
    if (allocResult.unexplainedDropPct > 0) {
      const buf = await this.loadBlackholeBuffer();
      const list = buf[poolKey] || [];
      list.push({ capturedAtMs, missingPct: allocResult.unexplainedDropPct });
      buf[poolKey] = list.filter((x) => nowMs - Number(x.capturedAtMs) <= 90 * 60 * 1000).slice(-80);

      const allMembers = await this.db.all("SELECT id, name, role, last_seen_at FROM members WHERE status = 'active'");
      const membersStatus = allMembers.map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        lastSeenAtMs: m.last_seen_at ? Date.parse(m.last_seen_at) : 0,
      }));
      const blackhole = evaluateBlackholeAlert({
        poolKey,
        recentUnexplainedDrops: buf[poolKey],
        membersStatus,
        nowMs,
        settings,
      });
      if (blackhole) {
        const created = await this.insertAlertDedup({
          kind: blackhole.kind,
          severity: blackhole.severity,
          poolKey,
          memberId: "",
          missingPct: blackhole.missingPct,
          title: blackhole.title,
          detail: blackhole.detail,
          nowMs,
        });
        if (created) {
          newAlerts.push(created);
          // 告警已发出后清空已消费的缺口缓冲，避免 30 分钟后因旧样本残余反复重复报警
          buf[poolKey] = [];
        }
      }
      await this.saveBlackholeBuffer(buf);
    }
  }

  /**
   * 成员端心跳 + 增量上报核心入口
   */
  async ingestHeartbeat(memberToken, payload = {}, options = {}) {
    const token = String(memberToken || "").trim();
    if (!token) throw new Error("缺少成员凭证");
    const member = await this.db.first("SELECT * FROM members WHERE member_token = ?", [token]);
    if (!member) throw new Error("无效的成员凭证，请联系组长核对");
    if (member.status === "paused") {
      throw new Error("你的成员状态当前已被组长暂停，请联系组长恢复后再同步");
    }
    if (member.status === "archived") {
      throw new Error("该成员凭证已停用，如需重新加入请联系组长获取新绑定码");
    }

    const allowClientNow = Boolean(options?.allowClientNowMs);
    const nowMs =
      allowClientNow && Number(payload.nowMs) && Number.isFinite(Number(payload.nowMs))
        ? Number(payload.nowMs)
        : this.nowFn();
    const nowIso = new Date(nowMs).toISOString();
    const clientVer = String(payload.clientVersion || "1.2.0").slice(0, 32);

    await this.db.run(
      "UPDATE members SET last_seen_at = ?, last_client_version = ?, updated_at = ? WHERE id = ?",
      [nowIso, clientVer, nowIso, member.id]
    );

    const settings = await this.getSettings();
    let acceptedEvents = 0;
    const MAX_SINGLE_EVENT_TOKENS = 20_000_000;

    // 1. 写入幂等增量 Token 上报（采用批量提交，避免 Cloudflare D1 逐条串行写入导致大批次补传超时）
    const events = Array.isArray(payload.usageEvents) ? payload.usageEvents : [];
    const insertSql = `INSERT OR IGNORE INTO usage_reports
          (id, member_id, slice_start_ms, event_ts_ms, pool_key, model_name, request_count, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, weighted_units, settled_snapshot_id, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`;
    const pendingStmts = [];
    for (const ev of events.slice(0, 500)) {
      if (!ev || typeof ev !== "object") continue;
      const evId = String(ev.id || "").trim().slice(0, 96);
      if (!evId) continue;
      const modelName = String(ev.modelName || ev.model || "").slice(0, 80);
      const poolKey = ev.poolKey === "3p" || ev.poolKey === "gemini" ? ev.poolKey : classifyModelPool(modelName);
      const rawTs = Number(ev.timestampMs);
      const tsMs = Number.isFinite(rawTs)
        ? Math.min(nowMs + 2 * 60 * 1000, Math.max(nowMs - 7 * 24 * 3600 * 1000, rawTs))
        : nowMs;
      const sliceStartMs = alignSliceStartMs(tsMs);
      const uncached = Math.min(MAX_SINGLE_EVENT_TOKENS, Math.max(0, Math.round(Number(ev.uncachedInputTokens) || 0)));
      const cacheRead = Math.min(MAX_SINGLE_EVENT_TOKENS, Math.max(0, Math.round(Number(ev.cacheReadTokens) || 0)));
      const cacheWrite = Math.min(MAX_SINGLE_EVENT_TOKENS, Math.max(0, Math.round(Number(ev.cacheWriteTokens) || 0)));
      const output = Math.min(MAX_SINGLE_EVENT_TOKENS, Math.max(0, Math.round(Number(ev.outputTokens) || 0)));
      const reqCount = Math.min(100, Math.max(1, Math.round(Number(ev.requestCount) || 1)));
      const weighted = computeWeightedUnits({
        modelName,
        uncachedInputTokens: uncached,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
      });
      const fullId = `${member.id}:${evId}`;
      pendingStmts.push({
        sql: insertSql,
        params: [fullId, member.id, sliceStartMs, Math.round(tsMs), poolKey, modelName, reqCount, uncached, cacheRead, cacheWrite, output, weighted, nowIso],
      });
    }

    const BATCH_CHUNK = 50;
    for (let i = 0; i < pendingStmts.length; i += BATCH_CHUNK) {
      const chunk = pendingStmts.slice(i, i + BATCH_CHUNK);
      if (typeof this.db.batch === "function") {
        const results = await this.db.batch(chunk);
        for (const res of results || []) {
          if ((res?.changes ?? res?.meta?.changes ?? 0) > 0) acceptedEvents++;
        }
      } else {
        for (const s of chunk) {
          const res = await this.db.run(s.sql, s.params);
          if ((res?.changes ?? res?.meta?.changes ?? 0) > 0) acceptedEvents++;
        }
      }
    }

    // 2. 处理官方总池配额水位快照，并执行一次性增量分摊与未统计消耗检测
    const authority = settings.quota_snapshot_authority === "all_members" ? "all_members" : "owner_only";
    const canReportQuota = member.role === "owner" || authority === "all_members";
    const snapshots = Array.isArray(payload.quotaSnapshots) ? payload.quotaSnapshots : [];
    let ignoredQuotaSnapshots = 0;
    const newAlerts = [];

    if (!canReportQuota) {
      ignoredQuotaSnapshots = snapshots.length;
    } else {
      for (const snap of snapshots) {
        if (!snap || typeof snap !== "object") continue;
        const poolKey = snap.poolKey === "3p" ? "3p" : snap.poolKey === "gemini" ? "gemini" : "";
        const windowKey = snap.windowKey === "weekly" ? "weekly" : snap.windowKey === "5h" ? "5h" : "";
        const pct = Number(snap.remainingPct);
        if (!poolKey || !windowKey || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
        const resetAt = typeof snap.resetAt === "string" ? snap.resetAt.slice(0, 64) : null;
        const rawCap = Number(snap.capturedAtMs);
        const capturedAtMs = Number.isFinite(rawCap)
          ? Math.min(nowMs + 60 * 1000, Math.max(nowMs - 10 * 60 * 1000, rawCap))
          : nowMs;

        const prev = await this.db.first(
          `SELECT id, remaining_pct, reset_at, captured_at_ms
             FROM pool_snapshots
            WHERE pool_key = ? AND window_key = ?
            ORDER BY captured_at_ms DESC, id DESC
            LIMIT 1`,
          [poolKey, windowKey]
        );

        if (prev && capturedAtMs < Number(prev.captured_at_ms)) continue;

        const insSnap = await this.db.run(
          `INSERT INTO pool_snapshots (pool_key, window_key, remaining_pct, reset_at, reporter_member_id, captured_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [poolKey, windowKey, Math.round(pct * 1000) / 1000, resetAt, member.id, capturedAtMs]
        );
        let snapshotId = Number(insSnap?.lastInsertRowid ?? insSnap?.meta?.last_row_id ?? 0);
        if (!snapshotId) {
          const latestRow = await this.db.first(
            "SELECT id FROM pool_snapshots WHERE pool_key = ? AND window_key = ? AND captured_at_ms = ? ORDER BY id DESC LIMIT 1",
            [poolKey, windowKey, capturedAtMs]
          );
          snapshotId = Number(latestRow?.id || 0);
        }

        if (windowKey === "weekly" && prev) {
          const delta = evaluateQuotaDelta(prev.remaining_pct, pct, prev.reset_at, resetAt);
          if (delta.isReset) {
            // 新周期开启时清空上一周期残留的异常缺口缓冲
            const buf = await this.loadBlackholeBuffer();
            if (Array.isArray(buf[poolKey]) && buf[poolKey].length > 0) {
              buf[poolKey] = [];
              await this.saveBlackholeBuffer(buf);
            }
            await this.insertAlertDedup({
              kind: "quota_reset",
              severity: "info",
              poolKey,
              memberId: "",
              missingPct: 0,
              title: `${poolKey === "3p" ? "Claude 3P 池" : "Gemini 池"}已触发官方配额重置`,
              detail:
                delta.postResetDropPct > 0
                  ? `官方周期已重置，当前剩余 ${pct.toFixed(1)}%（新周期已消耗 ${delta.postResetDropPct.toFixed(1)}%，已按新周期自动结算），未对旧周期重复扣费。`
                  : `官方剩余水位由 ${Number(prev.remaining_pct).toFixed(1)}% 回升至 ${pct.toFixed(1)}%，已开启新周期，未产生任何误扣。`,
              nowMs,
            });

            // 跨重置边界离线补算：若重置后、组长开机前新周期已有真实消耗（100 - pct），将其准确结算到新周期
            if (delta.postResetDropPct > 0 && snapshotId > 0) {
              const prevResetMs = prev.reset_at ? Date.parse(prev.reset_at) : NaN;
              const minPostResetTs = Number.isFinite(prevResetMs)
                ? Math.max(Number(prev.captured_at_ms), prevResetMs)
                : Number(prev.captured_at_ms);
              const fromSlice = alignSliceStartMs(minPostResetTs);
              const toSlice = alignSliceStartMs(capturedAtMs);
              await this.settleWeeklyDrop({
                poolKey,
                snapshotId,
                dropPct: delta.postResetDropPct,
                fromSliceMs: fromSlice,
                toSliceMs: toSlice,
                minEventTsMs: minPostResetTs,
                resetAt: resetAt || "",
                capturedAtMs,
                nowMs,
                nowIso,
                settings,
                newAlerts,
              });
            }
            continue;
          }

          if (delta.dropPct > 0 && snapshotId > 0) {
            const maxLookbackMs = authority === "owner_only" ? 7 * 24 * 3600 * 1000 : 60 * 60 * 1000;
            const fromSlice = alignSliceStartMs(Math.max(Number(prev.captured_at_ms), capturedAtMs - maxLookbackMs));
            const toSlice = alignSliceStartMs(capturedAtMs);
            await this.settleWeeklyDrop({
              poolKey,
              snapshotId,
              dropPct: delta.dropPct,
              fromSliceMs: fromSlice,
              toSliceMs: toSlice,
              minEventTsMs: 0,
              resetAt: resetAt || prev.reset_at || "",
              capturedAtMs,
              nowMs,
              nowIso,
              settings,
              newAlerts,
            });
          }
        }
      }
    }

    await this.maybePruneOldData(nowMs);

    const selfView = await this.getMemberSelfView(member.id, nowMs);
    return {
      ok: true,
      acceptedEvents,
      ignoredQuotaSnapshots,
      newAlertsCount: newAlerts.length,
      member: selfView,
    };
  }

  async insertAlertDedup({ kind, severity, poolKey, memberId, missingPct, title, detail, nowMs }) {
    const cutoffIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
    const dup = await this.db.first(
      `SELECT id FROM alerts
        WHERE kind = ? AND pool_key = ? AND member_id = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`,
      [kind, poolKey || "", memberId || "", cutoffIso]
    );
    if (dup) return null;
    const id = `alt_${randomHex(8)}`;
    const createdAt = new Date(nowMs).toISOString();
    await this.db.run(
      `INSERT INTO alerts (id, kind, severity, pool_key, member_id, missing_pct, title, detail, acknowledged, qq_notified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [id, kind, severity, poolKey || "", memberId || "", Number(missingPct) || 0, title, detail, createdAt]
    );
    return { id, kind, severity, poolKey, memberId, missingPct, title, detail, createdAt };
  }

  getActiveWeekBuckets(pools, nowMs) {
    return {
      gemini: deriveWeekBucket(pools?.gemini?.weekly?.resetAt || "", nowMs),
      "3p": deriveWeekBucket(pools?.["3p"]?.weekly?.resetAt || "", nowMs),
    };
  }

  /**
   * 统计最近 5 小时窗口内各成员的等效用量相对占比（便于晚高峰错峰协同）
   */
  async computeRecent5hStats(nowMs) {
    const cutoff5h = nowMs - 5 * 3600 * 1000;
    const rows = await this.db.all(
      `SELECT member_id, pool_key, SUM(weighted_units) AS total_units, SUM(request_count) AS reqs
         FROM usage_reports
        WHERE (CASE WHEN event_ts_ms > 0 THEN event_ts_ms ELSE slice_start_ms END) >= ?
        GROUP BY member_id, pool_key`,
      [cutoff5h]
    );
    const poolTotals = { gemini: 0, "3p": 0 };
    const perMember = new Map();
    for (const r of rows) {
      const pk = r.pool_key === "3p" ? "3p" : "gemini";
      const u = Math.max(0, Number(r.total_units || 0));
      poolTotals[pk] += u;
      const cur = perMember.get(r.member_id) || { geminiUnits: 0, thirdPartyUnits: 0, requests5h: 0 };
      if (pk === "3p") cur.thirdPartyUnits += u;
      else cur.geminiUnits += u;
      cur.requests5h += Number(r.reqs || 0);
      perMember.set(r.member_id, cur);
    }
    const shareMap = new Map();
    for (const [mid, v] of perMember.entries()) {
      shareMap.set(mid, {
        geminiSharePct: poolTotals.gemini > 0 ? Math.round((v.geminiUnits / poolTotals.gemini) * 1000) / 10 : 0,
        thirdPartySharePct: poolTotals["3p"] > 0 ? Math.round((v.thirdPartyUnits / poolTotals["3p"]) * 1000) / 10 : 0,
        requests5h: v.requests5h,
      });
    }
    return { shareMap, has5hGemini: poolTotals.gemini > 0, has5hThirdParty: poolTotals["3p"] > 0 };
  }

  async getMemberSelfView(memberId, nowMs = this.nowFn()) {
    const member = await this.db.first(
      "SELECT id, name, role, balance_fen, low_balance_fen, status, COALESCE(accepted_rule_version, 1) AS accepted_rule_version, last_seen_at FROM members WHERE id = ?",
      [memberId]
    );
    if (!member) throw new Error("未找到成员");
    if (member.status !== "active") {
      throw new Error("该成员账号已暂停或已停用，请联系组长");
    }

    const settings = await this.getSettings();
    const pools = await this.getLatestPoolSnapshots();
    const weekBuckets = this.getActiveWeekBuckets(pools, nowMs);

    // 严格按当前有效 week_bucket 统计「本周期」消耗，彻底消除周重置后旧周数据叠加超过 100% 的问题
    const weekStats = await this.db.all(
      `SELECT pool_key, SUM(attributed_pct) AS total_pct, SUM(charge_fen) AS total_charge_fen, SUM(weighted_units) AS total_units
         FROM slice_allocations
        WHERE member_id = ?
          AND ((pool_key = 'gemini' AND week_bucket = ?) OR (pool_key = '3p' AND week_bucket = ?))
        GROUP BY pool_key`,
      [memberId, weekBuckets.gemini, weekBuckets["3p"]]
    );

    const weekSummary = {
      geminiPct: 0,
      geminiChargeFen: 0,
      thirdPartyPct: 0,
      thirdPartyChargeFen: 0,
    };
    for (const r of weekStats) {
      if (r.pool_key === "3p") {
        weekSummary.thirdPartyPct = Math.round(Number(r.total_pct || 0) * 100) / 100;
        weekSummary.thirdPartyChargeFen = Math.round(Number(r.total_charge_fen || 0));
      } else {
        weekSummary.geminiPct = Math.round(Number(r.total_pct || 0) * 100) / 100;
        weekSummary.geminiChargeFen = Math.round(Number(r.total_charge_fen || 0));
      }
    }

    const recentTx = await this.db.all(
      `SELECT id, kind, amount_fen, balance_after_fen, note, created_at
         FROM transactions
        WHERE member_id = ?
        ORDER BY created_at DESC LIMIT 12`,
      [memberId]
    );

    // 透明公开该成员自己的近 20 条分摊扣费明细
    const recentAllocations = await this.db.all(
      `SELECT id, pool_key, slice_start_ms, week_bucket, pool_drop_pct, member_share_ratio, attributed_pct, unit_price_fen_per_pct, charge_fen, created_at
         FROM slice_allocations
        WHERE member_id = ?
        ORDER BY created_at DESC
        LIMIT 20`,
      [memberId]
    );

    const recentRuleChanges = await this.db.all(
      `SELECT id, rule_version, prev_summary, next_summary, note, created_at
         FROM rule_changes
        ORDER BY rule_version DESC
        LIMIT 8`
    );

    const recent5h = await this.computeRecent5hStats(nowMs);
    const my5h = recent5h.shareMap.get(memberId) || { geminiSharePct: 0, thirdPartySharePct: 0, requests5h: 0 };

    const isPrepaid = settings.ledger_mode === "prepaid";
    const currentRuleVersion = Math.max(1, Number(settings.rule_version) || 1);
    const acceptedRuleVersion = Math.max(1, Number(member.accepted_rule_version) || 1);
    const needsRuleConfirm = member.role !== "owner" && acceptedRuleVersion < currentRuleVersion;
    const usageRules = evaluateUsageRulesStatus({
      settings,
      pools,
      weekSummary,
      role: member.role,
    });

    const showPeerShares = settings.show_peer_shares_to_members !== false;
    let peers = [];
    if (showPeerShares) {
      const offlineGraceMs = Math.max(3, Number(settings.offline_grace_minutes) || 12) * 60 * 1000;
      const peerMembers = await this.db.all(
        "SELECT id, name, role, last_seen_at FROM members WHERE status = 'active' ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at ASC"
      );
      const peerAllocs = await this.db.all(
        `SELECT member_id, pool_key, SUM(attributed_pct) AS total_pct
           FROM slice_allocations
          WHERE (pool_key = 'gemini' AND week_bucket = ?) OR (pool_key = '3p' AND week_bucket = ?)
          GROUP BY member_id, pool_key`,
        [weekBuckets.gemini, weekBuckets["3p"]]
      );
      const pMap = new Map();
      for (const r of peerAllocs) {
        const cur = pMap.get(r.member_id) || { geminiPct: 0, thirdPartyPct: 0 };
        if (r.pool_key === "3p") cur.thirdPartyPct = Math.round(Number(r.total_pct || 0) * 100) / 100;
        else cur.geminiPct = Math.round(Number(r.total_pct || 0) * 100) / 100;
        pMap.set(r.member_id, cur);
      }
      const capPct = usageRules.memberWeeklyCapPct;
      const applyCapOwner = usageRules.applyCapToOwner;
      peers = peerMembers.map((pm) => {
        const seenMs = pm.last_seen_at ? Date.parse(pm.last_seen_at) : 0;
        const w = pMap.get(pm.id) || { geminiPct: 0, thirdPartyPct: 0 };
        const h5 = recent5h.shareMap.get(pm.id) || { geminiSharePct: 0, thirdPartySharePct: 0, requests5h: 0 };
        const peerCapApplies = capPct > 0 && (pm.role !== "owner" || applyCapOwner);
        const isSelf = pm.id === memberId;
        const rawPeerName = String(pm.name || "").trim();
        const displayName = !isSelf
          ? rawPeerName.replace(/[（(]我自己[）)]$/, "").trim() || (pm.role === "owner" ? "组长" : rawPeerName)
          : rawPeerName;
        return {
          name: displayName,
          role: pm.role,
          isSelf,
          online: Boolean(seenMs && nowMs - seenMs <= offlineGraceMs),
          geminiPct: w.geminiPct,
          thirdPartyPct: w.thirdPartyPct,
          recent5hGeminiShare: h5.geminiSharePct,
          recent5hThirdPartyShare: h5.thirdPartySharePct,
          capReached: peerCapApplies && (w.geminiPct >= capPct || w.thirdPartyPct >= capPct),
        };
      });
    }

    return {
      id: member.id,
      name: member.name,
      role: member.role,
      status: member.status,
      acceptedRuleVersion,
      needsRuleConfirm,
      balanceFen: Number(member.balance_fen || 0),
      lowBalanceFen: Number(member.low_balance_fen || 0),
      isLowBalance: isPrepaid && member.role !== "owner" && Number(member.balance_fen || 0) <= Number(member.low_balance_fen || 0),
      isDepleted: isPrepaid && member.role !== "owner" && Number(member.balance_fen || 0) <= 0,
      lastSeenAt: member.last_seen_at || null,
      weekBuckets,
      weekSummary,
      recent5h: my5h,
      recentTransactions: recentTx,
      recentAllocations,
      recentRuleChanges,
      peers,
      pools,
      usageRules,
      pricing: {
        familyName: settings.family_name,
        ruleVersion: currentRuleVersion,
        ledgerMode: isPrepaid ? "prepaid" : "board_only",
        showPeerShares,
        pricingMode: settings.pricing_mode,
        geminiFenPerWeeklyPct: settings.gemini_fen_per_weekly_pct,
        thirdPartyFenPerWeeklyPct: settings.third_party_fen_per_weekly_pct,
        poolReserveFloorPct: usageRules.poolReserveFloorPct,
        memberWeeklyCapPct: usageRules.memberWeeklyCapPct,
        applyCapToOwner: usageRules.applyCapToOwner,
        usageRuleNote: usageRules.usageRuleNote,
        usageRuleNoteHash: usageRules.usageRuleNoteHash,
        summaryText: formatPricingRuleSummary(settings),
        calibrationDryRun: !isPrepaid,
      },
    };
  }

  async getAdminDashboard(nowMs = this.nowFn()) {
    const settings = await this.getSettings();
    const pools = await this.getLatestPoolSnapshots();
    const weekBuckets = this.getActiveWeekBuckets(pools, nowMs);
    const offlineGraceMs = Math.max(3, Number(settings.offline_grace_minutes) || 12) * 60 * 1000;
    const currentRuleVersion = Math.max(1, Number(settings.rule_version) || 1);

    const rawMembers = await this.db.all(
      "SELECT * FROM members ORDER BY CASE WHEN status = 'archived' THEN 2 WHEN role = 'owner' THEN 0 ELSE 1 END, created_at ASC"
    );

    const allocRows = await this.db.all(
      `SELECT member_id, pool_key, SUM(attributed_pct) AS total_pct, SUM(charge_fen) AS total_charge_fen, SUM(weighted_units) AS total_units
         FROM slice_allocations
        WHERE (pool_key = 'gemini' AND week_bucket = ?) OR (pool_key = '3p' AND week_bucket = ?)
        GROUP BY member_id, pool_key`,
      [weekBuckets.gemini, weekBuckets["3p"]]
    );

    const rawReportRows = await this.db.all(
      `SELECT member_id, pool_key, SUM(request_count) AS reqs, SUM(uncached_input_tokens + cache_read_tokens + cache_write_tokens) AS in_toks, SUM(output_tokens) AS out_toks
         FROM usage_reports
        WHERE slice_start_ms >= ?
        GROUP BY member_id, pool_key`,
      [nowMs - 7 * 24 * 3600 * 1000]
    );

    const recent5h = await this.computeRecent5hStats(nowMs);

    const allocMap = new Map();
    for (const r of allocRows) {
      if (!allocMap.has(r.member_id)) {
        allocMap.set(r.member_id, { geminiPct: 0, geminiChargeFen: 0, thirdPartyPct: 0, thirdPartyChargeFen: 0 });
      }
      const item = allocMap.get(r.member_id);
      if (r.pool_key === "3p") {
        item.thirdPartyPct = Math.round(Number(r.total_pct || 0) * 100) / 100;
        item.thirdPartyChargeFen = Math.round(Number(r.total_charge_fen || 0));
      } else {
        item.geminiPct = Math.round(Number(r.total_pct || 0) * 100) / 100;
        item.geminiChargeFen = Math.round(Number(r.total_charge_fen || 0));
      }
    }

    const reqMap = new Map();
    for (const r of rawReportRows) {
      const cur = reqMap.get(r.member_id) || { requests7d: 0, tokens7d: 0 };
      cur.requests7d += Number(r.reqs || 0);
      cur.tokens7d += Number(r.in_toks || 0) + Number(r.out_toks || 0);
      reqMap.set(r.member_id, cur);
    }

    const usageRules = evaluateUsageRulesStatus({
      settings,
      pools,
      weekSummary: { geminiPct: 0, thirdPartyPct: 0 },
      role: "owner",
    });
    const capPct = usageRules.memberWeeklyCapPct;
    const applyCapOwner = usageRules.applyCapToOwner;

    const members = rawMembers.map((m) => {
      const lastSeenMs = m.last_seen_at ? Date.parse(m.last_seen_at) : 0;
      const online = m.status === "active" && Boolean(lastSeenMs && nowMs - lastSeenMs <= offlineGraceMs);
      const week = allocMap.get(m.id) || { geminiPct: 0, geminiChargeFen: 0, thirdPartyPct: 0, thirdPartyChargeFen: 0 };
      const r7 = reqMap.get(m.id) || { requests7d: 0, tokens7d: 0 };
      const h5 = recent5h.shareMap.get(m.id) || { geminiSharePct: 0, thirdPartySharePct: 0, requests5h: 0 };
      const acceptedVer = Math.max(1, Number(m.accepted_rule_version) || 1);
      const capApplies = m.status === "active" && capPct > 0 && (m.role !== "owner" || applyCapOwner);
      const capReached = capApplies && (week.geminiPct >= capPct || week.thirdPartyPct >= capPct);
      const capApproaching =
        capApplies && !capReached && (week.geminiPct >= capPct * 0.85 || week.thirdPartyPct >= capPct * 0.85);
      return {
        id: m.id,
        name: m.name,
        role: m.role,
        memberToken: m.member_token,
        balanceFen: Number(m.balance_fen || 0),
        lowBalanceFen: Number(m.low_balance_fen || 0),
        isLowBalance: m.status === "active" && m.role !== "owner" && Number(m.balance_fen || 0) <= Number(m.low_balance_fen || 0),
        status: m.status,
        acceptedRuleVersion: acceptedVer,
        needsRuleConfirm: m.status === "active" && m.role !== "owner" && acceptedVer < currentRuleVersion,
        capReached,
        capApproaching,
        note: m.note || "",
        online,
        lastSeenAt: m.last_seen_at || null,
        lastClientVersion: m.last_client_version || "",
        week,
        recent5h: h5,
        requests7d: r7.requests7d,
        tokens7d: r7.tokens7d,
        createdAt: m.created_at,
      };
    });

    const recentAllocations = await this.db.all(
      `SELECT a.*, m.name AS member_name
         FROM slice_allocations a
         LEFT JOIN members m ON m.id = a.member_id
        ORDER BY a.slice_start_ms DESC, a.created_at DESC
        LIMIT 40`
    );

    const recentTransactions = await this.db.all(
      `SELECT t.*, m.name AS member_name
         FROM transactions t
         LEFT JOIN members m ON m.id = t.member_id
        ORDER BY t.created_at DESC
        LIMIT 30`
    );

    const ruleChanges = await this.db.all(
      `SELECT id, rule_version, changed_fields_json, prev_summary, next_summary, note, created_at
         FROM rule_changes
        ORDER BY rule_version DESC
        LIMIT 15`
    );

    const alerts = await this.db.all(
      `SELECT * FROM alerts ORDER BY acknowledged ASC, created_at DESC LIMIT 30`
    );

    const totalTopupRow = await this.db.first(
      "SELECT SUM(amount_fen) AS total FROM transactions WHERE kind = 'topup'"
    );
    const activeMembers = members.filter((m) => m.status !== "archived");
    const totalWeekChargeFen = members.reduce(
      (s, m) => s + m.week.geminiChargeFen + m.week.thirdPartyChargeFen,
      0
    );
    const totalWeekGeminiPct =
      Math.round(members.reduce((s, m) => s + (m.week.geminiPct || 0), 0) * 100) / 100;
    const totalWeekThirdPartyPct =
      Math.round(members.reduce((s, m) => s + (m.week.thirdPartyPct || 0), 0) * 100) / 100;

    return {
      ok: true,
      serverTimeIso: new Date(nowMs).toISOString(),
      settings,
      usageRules,
      pools,
      weekBuckets,
      summary: {
        memberCount: activeMembers.length,
        archivedCount: members.length - activeMembers.length,
        onlineCount: activeMembers.filter((m) => m.online).length,
        pendingRuleConfirmCount: activeMembers.filter((m) => m.needsRuleConfirm).length,
        unackedAlertCount: alerts.filter((a) => !a.acknowledged).length,
        criticalAlertCount: alerts.filter((a) => !a.acknowledged && a.severity === "critical").length,
        totalTopupFen: Math.round(Number(totalTopupRow?.total || 0)),
        totalWeekChargeFen,
        totalWeekGeminiPct,
        totalWeekThirdPartyPct,
      },
      members,
      recentAllocations,
      recentTransactions,
      ruleChanges,
      alerts,
    };
  }

  async acknowledgeAlert(alertId) {
    await this.db.run("UPDATE alerts SET acknowledged = 1 WHERE id = ?", [alertId]);
    return { ok: true, id: alertId };
  }

  async getUnnotifiedAlerts() {
    return await this.db.all(
      "SELECT * FROM alerts WHERE qq_notified = 0 AND severity IN ('warning', 'critical') ORDER BY created_at ASC LIMIT 20"
    );
  }

  async markAlertsQqNotified(ids = []) {
    for (const id of ids) {
      await this.db.run("UPDATE alerts SET qq_notified = 1 WHERE id = ?", [id]);
    }
  }
}
