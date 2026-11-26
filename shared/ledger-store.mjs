/**
 * 统一账本数据层：同时兼容 Cloudflare D1（生产云端）与 Node.js 内置 SQLite（本地联调/离线模式）。
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
  formatYuan,
} from "./billing-engine.mjs";

export function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 把 Cloudflare D1 包装为统一异步适配器
 */
export function wrapD1Adapter(d1) {
  return {
    async exec(sql) {
      const stmts = String(sql)
        .split(/;\s*(?:\r?\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("--"));
      for (const s of stmts) {
        await d1.prepare(s).run();
      }
    },
    async all(sql, params = []) {
      const res = await d1.prepare(sql).bind(...params).all();
      return Array.isArray(res?.results) ? res.results : [];
    },
    async first(sql, params = []) {
      return (await d1.prepare(sql).bind(...params).first()) ?? null;
    },
    async run(sql, params = []) {
      return await d1.prepare(sql).bind(...params).run();
    },
  };
}

/**
 * 把 Node.js 22+ 原生 DatabaseSync 包装为统一异步适配器
 */
export function wrapNodeSqliteAdapter(db) {
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async first(sql, params = []) {
      return db.prepare(sql).get(...params) ?? null;
    },
    async run(sql, params = []) {
      return db.prepare(sql).run(...params);
    },
  };
}

// 内存态未解释黑洞滑动缓冲（同时持久化在 settings 表防 Worker 冷启动丢失）
const BLACKHOLE_BUFFER_KEY = "__blackhole_recent_drops_json";

export class LedgerStore {
  constructor(dbAdapter, { nowFn = () => Date.now() } = {}) {
    this.db = dbAdapter;
    this.nowFn = nowFn;
  }

  async ensureSchema(schemaSql) {
    if (schemaSql) {
      await this.db.exec(schemaSql);
    }
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
    // 若还没有任何成员，默认创建一个「组长（我自己）」账号（role=owner，不扣余额只记占比）
    const cntRow = await this.db.first("SELECT COUNT(*) AS cnt FROM members");
    if (!cntRow || Number(cntRow.cnt) === 0) {
      await this.createMember({
        id: "owner_self",
        name: "组长（我自己）",
        role: "owner",
        initialBalanceFen: 0,
        lowBalanceFen: 0,
        note: "组长本人设备安装插件后自动计入总池占比，免扣余额，防止自用消耗触发黑洞误报",
      });
    }
  }

  async getSettings() {
    const rows = await this.db.all("SELECT key, value FROM settings");
    const out = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      if (r.key === BLACKHOLE_BUFFER_KEY) continue;
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    return out;
  }

  async updateSettings(patch = {}) {
    const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    const nowIso = new Date(this.nowFn()).toISOString();
    for (const [k, v] of Object.entries(patch || {})) {
      if (!allowedKeys.has(k)) continue;
      await this.db.run(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        [k, JSON.stringify(v), nowIso]
      );
    }
    return await this.getSettings();
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

    await this.db.run(
      `INSERT INTO members (id, name, role, member_token, balance_fen, low_balance_fen, status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [memberId, cleanName, cleanRole, memberToken, initFen, lowFen, String(note || "").trim(), nowIso, nowIso]
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
    const nextStatus = patch.status === "paused" || patch.status === "active" ? patch.status : cur.status;
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

  async deleteMember(memberId) {
    const cur = await this.db.first("SELECT * FROM members WHERE id = ?", [memberId]);
    if (!cur) throw new Error("未找到对应成员");
    if (cur.role === "owner") {
      const owners = await this.db.first("SELECT COUNT(*) AS cnt FROM members WHERE role = 'owner'");
      if (Number(owners?.cnt || 0) <= 1) {
        throw new Error("至少需保留一位组长账号，无法删除");
      }
    }
    await this.db.run("DELETE FROM transactions WHERE member_id = ?", [memberId]);
    await this.db.run("DELETE FROM slice_allocations WHERE member_id = ?", [memberId]);
    await this.db.run("DELETE FROM usage_reports WHERE member_id = ?", [memberId]);
    await this.db.run("DELETE FROM members WHERE id = ?", [memberId]);
    return { ok: true, deletedId: memberId };
  }

  async recordTransaction(memberId, { kind = "topup", amountFen = 0, note = "" } = {}) {
    const cur = await this.db.first("SELECT * FROM members WHERE id = ?", [memberId]);
    if (!cur) throw new Error("未找到对应成员");
    const delta = Math.round(Number(amountFen) || 0);
    if (delta === 0) throw new Error("金额不能为 0");
    const cleanKind = ["topup", "adjust", "refund"].includes(kind) ? kind : "topup";
    const nextBalance = Number(cur.balance_fen || 0) + delta;
    const nowIso = new Date(this.nowFn()).toISOString();
    const txId = `tx_${randomHex(8)}`;

    await this.db.run("UPDATE members SET balance_fen = ?, updated_at = ? WHERE id = ?", [
      nextBalance,
      nowIso,
      memberId,
    ]);
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

  /**
   * 成员端心跳 + 增量上报核心入口
   * 安全约束：
   * - 默认强制使用服务端时间（忽略客户端 payload.nowMs），仅显式传入 options.allowClientNowMs=true 时允许单测注入模拟时间。
   * - 默认仅组长（role === 'owner'）可写入官方总池水位快照，杜绝普通成员伪造水位暴跌/重置干扰账单或组长显示。
   */
  async ingestHeartbeat(memberToken, payload = {}, options = {}) {
    const token = String(memberToken || "").trim();
    if (!token) throw new Error("缺少成员凭证");
    const member = await this.db.first("SELECT * FROM members WHERE member_token = ?", [token]);
    if (!member) throw new Error("无效的成员凭证，请联系组长核对");

    const allowClientNow = Boolean(options?.allowClientNowMs);
    const nowMs =
      allowClientNow && Number(payload.nowMs) && Number.isFinite(Number(payload.nowMs))
        ? Number(payload.nowMs)
        : this.nowFn();
    const nowIso = new Date(nowMs).toISOString();
    const clientVer = String(payload.clientVersion || "1.0.0").slice(0, 32);

    await this.db.run(
      "UPDATE members SET last_seen_at = ?, last_client_version = ?, updated_at = ? WHERE id = ?",
      [nowIso, clientVer, nowIso, member.id]
    );

    const settings = await this.getSettings();
    let acceptedEvents = 0;
    const MAX_SINGLE_EVENT_TOKENS = 20_000_000;

    // 1. 写入幂等增量 Token 上报（钳制异常时间戳与单步超大数值，防溢出与未来时间戳污染）
    const events = Array.isArray(payload.usageEvents) ? payload.usageEvents : [];
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
      const res = await this.db.run(
        `INSERT OR IGNORE INTO usage_reports
          (id, member_id, slice_start_ms, pool_key, model_name, request_count, uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, weighted_units, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [fullId, member.id, sliceStartMs, poolKey, modelName, reqCount, uncached, cacheRead, cacheWrite, output, weighted, nowIso]
      );
      if ((res?.changes ?? res?.meta?.changes ?? 0) > 0) {
        acceptedEvents++;
      }
    }

    // 2. 处理官方总池配额水位快照，并执行增量切片分摊 + 黑洞核对
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

        // 读取上一条同池同窗口快照
        const prev = await this.db.first(
          `SELECT id, remaining_pct, reset_at, captured_at_ms
             FROM pool_snapshots
            WHERE pool_key = ? AND window_key = ?
            ORDER BY captured_at_ms DESC, id DESC
            LIMIT 1`,
          [poolKey, windowKey]
        );

        // 防旧快照倒灌
        if (prev && capturedAtMs < Number(prev.captured_at_ms)) continue;

        await this.db.run(
          `INSERT INTO pool_snapshots (pool_key, window_key, remaining_pct, reset_at, reporter_member_id, captured_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [poolKey, windowKey, Math.round(pct * 1000) / 1000, resetAt, member.id, capturedAtMs]
        );

        // 仅对 weekly 总池做正式分账与黑洞守恒审计（5h 仅用于实时水位展示）
        if (windowKey === "weekly" && prev) {
          const delta = evaluateQuotaDelta(prev.remaining_pct, pct, prev.reset_at, resetAt);
          if (delta.isReset) {
            await this.insertAlertDedup({
              kind: "quota_reset",
              severity: "info",
              poolKey,
              memberId: "",
              missingPct: 0,
              title: `${poolKey === "3p" ? "Claude 3P 池" : "Gemini 池"}已触发官方配额重置`,
              detail: `官方剩余水位由 ${Number(prev.remaining_pct).toFixed(1)}% 回升至 ${pct.toFixed(1)}%，账本已自动开启新周期，未产生任何误扣。`,
              nowMs,
            });
            continue;
          }

          if (delta.dropPct > 0) {
            // owner_only 模式下组长关机隔夜再开机时，自动回溯自上次权威快照起的全部熟人 Token 明细（最长 7 天）
            const maxLookbackMs = authority === "owner_only" ? 7 * 24 * 3600 * 1000 : 60 * 60 * 1000;
            const fromSlice = alignSliceStartMs(Math.max(Number(prev.captured_at_ms), capturedAtMs - maxLookbackMs));
            const toSlice = alignSliceStartMs(capturedAtMs);
            const usageRows = await this.db.all(
              `SELECT u.member_id AS memberId, m.role AS role, SUM(u.weighted_units) AS weightedUnits
                 FROM usage_reports u
                 JOIN members m ON m.id = u.member_id
                WHERE u.pool_key = ?
                  AND u.slice_start_ms >= ?
                  AND u.slice_start_ms <= ?
                GROUP BY u.member_id`,
              [poolKey, fromSlice, toSlice]
            );

            const allocResult = allocateSliceUsage({
              poolKey,
              poolDropPct: delta.dropPct,
              memberUsages: usageRows,
              settings,
            });

            const weekBucket = deriveWeekBucket(resetAt || prev.reset_at || "", capturedAtMs);
            const allocSliceMs = alignSliceStartMs(capturedAtMs);

            for (const a of allocResult.allocations) {
              if (a.attributedPct <= 0 && a.chargeFen <= 0) continue;
              const allocId = `${poolKey}:${capturedAtMs}:${a.memberId}`;
              await this.db.run(
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
              if (a.chargeFen > 0) {
                const target = await this.db.first("SELECT id, name, balance_fen, low_balance_fen, role FROM members WHERE id = ?", [a.memberId]);
                if (target && target.role !== "owner") {
                  const prevBal = Number(target.balance_fen || 0);
                  const nextBal = prevBal - a.chargeFen;
                  await this.db.run("UPDATE members SET balance_fen = ?, updated_at = ? WHERE id = ?", [
                    nextBal,
                    nowIso,
                    target.id,
                  ]);
                  // 余额首次跌破阈值提醒
                  if (prevBal > Number(target.low_balance_fen || 0) && nextBal <= Number(target.low_balance_fen || 0)) {
                    const lowAlert = await this.insertAlertDedup({
                      kind: "low_balance",
                      severity: "warning",
                      poolKey,
                      memberId: target.id,
                      missingPct: 0,
                      title: `成员「${target.name}」余额不足（剩余 ¥${formatYuan(nextBal)}）`,
                      detail: `已低于提醒线 ¥${formatYuan(target.low_balance_fen)}，成员插件侧边栏已同步显示温和续充提示。`,
                      nowMs,
                    });
                    if (lowAlert) newAlerts.push(lowAlert);
                  }
                }
              }
            }

            // 未解释黑洞缺口 -> 三层防误报滤波
            if (allocResult.unexplainedDropPct > 0) {
              const buf = await this.loadBlackholeBuffer();
              const list = buf[poolKey] || [];
              list.push({ capturedAtMs, missingPct: allocResult.unexplainedDropPct });
              // 仅保留最近 90 分钟内的样本
              buf[poolKey] = list.filter((x) => nowMs - Number(x.capturedAtMs) <= 90 * 60 * 1000).slice(-60);
              await this.saveBlackholeBuffer(buf);

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
                if (created) newAlerts.push(created);
              }
            }
          }
        }
      }
    }

    // 返回该成员自己的脱敏自查视图
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

  async getMemberSelfView(memberId, nowMs = this.nowFn()) {
    const member = await this.db.first(
      "SELECT id, name, role, balance_fen, low_balance_fen, status, last_seen_at FROM members WHERE id = ?",
      [memberId]
    );
    if (!member) throw new Error("未找到成员");
    const settings = await this.getSettings();
    const pools = await this.getLatestPoolSnapshots();
    const weekStartMs = nowMs - 7 * 24 * 3600 * 1000;
    const weekStats = await this.db.all(
      `SELECT pool_key, SUM(attributed_pct) AS total_pct, SUM(charge_fen) AS total_charge_fen, SUM(weighted_units) AS total_units
         FROM slice_allocations
        WHERE member_id = ? AND slice_start_ms >= ?
        GROUP BY pool_key`,
      [memberId, weekStartMs]
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
        ORDER BY created_at DESC LIMIT 8`,
      [memberId]
    );

    return {
      id: member.id,
      name: member.name,
      role: member.role,
      status: member.status,
      balanceFen: Number(member.balance_fen || 0),
      lowBalanceFen: Number(member.low_balance_fen || 0),
      isLowBalance: member.role !== "owner" && Number(member.balance_fen || 0) <= Number(member.low_balance_fen || 0),
      isDepleted: member.role !== "owner" && Number(member.balance_fen || 0) <= 0,
      lastSeenAt: member.last_seen_at || null,
      weekSummary,
      recentTransactions: recentTx,
      pools,
      pricing: {
        familyName: settings.family_name,
        pricingMode: settings.pricing_mode,
        geminiFenPerWeeklyPct: settings.gemini_fen_per_weekly_pct,
        thirdPartyFenPerWeeklyPct: settings.third_party_fen_per_weekly_pct,
        calibrationDryRun: Boolean(settings.calibration_dry_run),
      },
    };
  }

  async getAdminDashboard(nowMs = this.nowFn()) {
    const settings = await this.getSettings();
    const pools = await this.getLatestPoolSnapshots();
    const weekStartMs = nowMs - 7 * 24 * 3600 * 1000;
    const offlineGraceMs = Math.max(3, Number(settings.offline_grace_minutes) || 12) * 60 * 1000;

    const rawMembers = await this.db.all(
      "SELECT * FROM members ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at ASC"
    );

    const allocRows = await this.db.all(
      `SELECT member_id, pool_key, SUM(attributed_pct) AS total_pct, SUM(charge_fen) AS total_charge_fen, SUM(weighted_units) AS total_units
         FROM slice_allocations
        WHERE slice_start_ms >= ?
        GROUP BY member_id, pool_key`,
      [weekStartMs]
    );

    const rawReportRows = await this.db.all(
      `SELECT member_id, pool_key, SUM(request_count) AS reqs, SUM(uncached_input_tokens + cache_read_tokens + cache_write_tokens) AS in_toks, SUM(output_tokens) AS out_toks
         FROM usage_reports
        WHERE slice_start_ms >= ?
        GROUP BY member_id, pool_key`,
      [nowMs - 7 * 24 * 3600 * 1000]
    );

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

    const members = rawMembers.map((m) => {
      const lastSeenMs = m.last_seen_at ? Date.parse(m.last_seen_at) : 0;
      const online = Boolean(lastSeenMs && nowMs - lastSeenMs <= offlineGraceMs);
      const week = allocMap.get(m.id) || { geminiPct: 0, geminiChargeFen: 0, thirdPartyPct: 0, thirdPartyChargeFen: 0 };
      const r7 = reqMap.get(m.id) || { requests7d: 0, tokens7d: 0 };
      return {
        id: m.id,
        name: m.name,
        role: m.role,
        memberToken: m.member_token,
        balanceFen: Number(m.balance_fen || 0),
        lowBalanceFen: Number(m.low_balance_fen || 0),
        isLowBalance: m.role !== "owner" && Number(m.balance_fen || 0) <= Number(m.low_balance_fen || 0),
        status: m.status,
        note: m.note || "",
        online,
        lastSeenAt: m.last_seen_at || null,
        lastClientVersion: m.last_client_version || "",
        week,
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

    const alerts = await this.db.all(
      `SELECT * FROM alerts ORDER BY acknowledged ASC, created_at DESC LIMIT 30`
    );

    const totalTopupRow = await this.db.first(
      "SELECT SUM(amount_fen) AS total FROM transactions WHERE kind = 'topup'"
    );
    const totalWeekChargeFen = members.reduce(
      (s, m) => s + m.week.geminiChargeFen + m.week.thirdPartyChargeFen,
      0
    );

    return {
      ok: true,
      serverTimeIso: new Date(nowMs).toISOString(),
      settings,
      pools,
      summary: {
        memberCount: members.length,
        onlineCount: members.filter((m) => m.online).length,
        unackedAlertCount: alerts.filter((a) => !a.acknowledged).length,
        criticalAlertCount: alerts.filter((a) => !a.acknowledged && a.severity === "critical").length,
        totalTopupFen: Math.round(Number(totalTopupRow?.total || 0)),
        totalWeekChargeFen,
      },
      members,
      recentAllocations,
      recentTransactions,
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
