/**
 * Cloudflare Workers 云端记账中转（免费层 0 元运行）
 *
 * 环境变量：
 * - env.DB           : Cloudflare D1 数据库绑定
 * - env.ADMIN_SECRET : 管理员访问密钥（由 `wrangler secret put ADMIN_SECRET` 安全注入）
 */
import { LedgerStore, wrapD1Adapter } from "../shared/ledger-store.mjs";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', member_token TEXT NOT NULL UNIQUE, balance_fen INTEGER NOT NULL DEFAULT 0, low_balance_fen INTEGER NOT NULL DEFAULT 200, status TEXT NOT NULL DEFAULT 'active', note TEXT NOT NULL DEFAULT '', last_seen_at TEXT, last_client_version TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_reports (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, slice_start_ms INTEGER NOT NULL, pool_key TEXT NOT NULL, model_name TEXT NOT NULL DEFAULT '', request_count INTEGER NOT NULL DEFAULT 0, uncached_input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, weighted_units REAL NOT NULL DEFAULT 0, reported_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_usage_reports_slice_pool ON usage_reports (slice_start_ms, pool_key);
CREATE TABLE IF NOT EXISTS pool_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, pool_key TEXT NOT NULL, window_key TEXT NOT NULL, remaining_pct REAL NOT NULL, reset_at TEXT, reporter_member_id TEXT NOT NULL, captured_at_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pool_snapshots_lookup ON pool_snapshots (pool_key, window_key, captured_at_ms);
CREATE TABLE IF NOT EXISTS slice_allocations (id TEXT PRIMARY KEY, pool_key TEXT NOT NULL, slice_start_ms INTEGER NOT NULL, week_bucket TEXT NOT NULL, member_id TEXT NOT NULL, pool_drop_pct REAL NOT NULL, member_share_ratio REAL NOT NULL, attributed_pct REAL NOT NULL, weighted_units REAL NOT NULL, unit_price_fen_per_pct INTEGER NOT NULL, charge_fen INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_slice_alloc_member_week ON slice_allocations (member_id, week_bucket);
CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, kind TEXT NOT NULL, amount_fen INTEGER NOT NULL, balance_after_fen INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT NOT NULL, pool_key TEXT NOT NULL DEFAULT '', member_id TEXT NOT NULL DEFAULT '', missing_pct REAL NOT NULL DEFAULT 0, title TEXT NOT NULL, detail TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, qq_notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
`;

let schemaBootstrapped = false;

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Secret,X-Member-Token",
    },
  });
}

function constantTimeEq(a = "", b = "") {
  const sa = String(a);
  const sb = String(b);
  if (!sa || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

function checkAdmin(req, env) {
  const expected = String(env?.ADMIN_SECRET || "").trim();
  if (!expected) return { ok: false, reason: "服务端尚未配置 ADMIN_SECRET 密钥" };
  const provided =
    req.headers.get("X-Admin-Secret") ||
    (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!constantTimeEq(provided, expected)) {
    return { ok: false, reason: "管理员密钥校验失败" };
  }
  return { ok: true };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Admin-Secret,X-Member-Token",
        },
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (pathname === "/api/health" || pathname === "/") {
      return jsonResp({
        ok: true,
        service: "agy-family-ledger-worker",
        version: "1.0.1",
        hasDb: Boolean(env?.DB),
        hasAdminSecret: Boolean(env?.ADMIN_SECRET),
      });
    }

    if (!env?.DB) {
      return jsonResp({ ok: false, error: "尚未绑定 Cloudflare D1 数据库 (DB)" }, 500);
    }

    const store = new LedgerStore(wrapD1Adapter(env.DB));
    if (!schemaBootstrapped) {
      await store.ensureSchema(SCHEMA_SQL);
      schemaBootstrapped = true;
    }

    const readBody = async () => {
      try {
        return await request.json();
      } catch {
        return {};
      }
    };

    try {
      // ========== 成员端 API（持专属 member_token 访问） ==========
      if (pathname === "/api/member/heartbeat" && request.method === "POST") {
        const body = await readBody();
        const token = request.headers.get("X-Member-Token") || body.memberToken || "";
        const { nowMs: _ignoredNowMs, ...safeBody } = body && typeof body === "object" ? body : {};
        const res = await store.ingestHeartbeat(token, safeBody);
        return jsonResp(res);
      }

      if (pathname === "/api/member/me" && request.method === "GET") {
        const token = request.headers.get("X-Member-Token") || url.searchParams.get("token") || "";
        const row = await store.db.first("SELECT id FROM members WHERE member_token = ?", [token]);
        if (!row) return jsonResp({ ok: false, error: "无效的成员凭证" }, 401);
        const member = await store.getMemberSelfView(row.id);
        return jsonResp({ ok: true, member });
      }

      // ========== 管理员 API（需 ADMIN_SECRET 鉴权） ==========
      if (pathname.startsWith("/api/admin/")) {
        const auth = checkAdmin(request, env);
        if (!auth.ok) return jsonResp({ ok: false, error: auth.reason }, 401);

        if (pathname === "/api/admin/dashboard" && request.method === "GET") {
          return jsonResp(await store.getAdminDashboard());
        }
        if (pathname === "/api/admin/members" && request.method === "POST") {
          const body = await readBody();
          const m = await store.createMember(body);
          return jsonResp({ ok: true, member: m });
        }
        const memberMatch = pathname.match(/^\/api\/admin\/members\/([^/]+)$/);
        if (memberMatch && request.method === "PATCH") {
          const body = await readBody();
          const m = await store.updateMember(decodeURIComponent(memberMatch[1]), body);
          return jsonResp({ ok: true, member: m });
        }
        if (memberMatch && request.method === "DELETE") {
          return jsonResp(await store.deleteMember(decodeURIComponent(memberMatch[1])));
        }
        const txMatch = pathname.match(/^\/api\/admin\/members\/([^/]+)\/transactions$/);
        if (txMatch && request.method === "POST") {
          const body = await readBody();
          return jsonResp(await store.recordTransaction(decodeURIComponent(txMatch[1]), body));
        }
        if (pathname === "/api/admin/settings" && request.method === "PATCH") {
          const body = await readBody();
          return jsonResp({ ok: true, settings: await store.updateSettings(body) });
        }
        const ackMatch = pathname.match(/^\/api\/admin\/alerts\/([^/]+)\/ack$/);
        if (ackMatch && request.method === "POST") {
          return jsonResp(await store.acknowledgeAlert(decodeURIComponent(ackMatch[1])));
        }
        if (pathname === "/api/admin/alerts/unnotified" && request.method === "GET") {
          return jsonResp({ ok: true, alerts: await store.getUnnotifiedAlerts() });
        }
        if (pathname === "/api/admin/alerts/mark-notified" && request.method === "POST") {
          const body = await readBody();
          await store.markAlertsQqNotified(Array.isArray(body.ids) ? body.ids : []);
          return jsonResp({ ok: true });
        }
      }

      return jsonResp({ ok: false, error: "未找到对应接口" }, 404);
    } catch (err) {
      return jsonResp({ ok: false, error: String(err?.message || err) }, 400);
    }
  },
};
