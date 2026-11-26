-- Antigravity 熟人家庭组透明用量账本 · 统一表结构（兼容 Cloudflare D1 与本地 Node SQLite）

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',          -- 'owner'（组长免扣费仅记占比） | 'member'（熟人计费成员）
  member_token TEXT NOT NULL UNIQUE,
  balance_fen INTEGER NOT NULL DEFAULT 0,       -- 余额（单位：分，避免浮点精度误差；100 分 = 1.00 元）
  low_balance_fen INTEGER NOT NULL DEFAULT 200, -- 余额不足提醒线（默认 2.00 元）
  status TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'paused'
  note TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT,
  last_client_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 成员增量上报记录（幂等：同一成员同一切片上报覆盖或按 event_id 去重）
CREATE TABLE IF NOT EXISTS usage_reports (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  slice_start_ms INTEGER NOT NULL,              -- 5 分钟对齐切片起点 (UTC ms)
  pool_key TEXT NOT NULL,                       -- 'gemini' | '3p'
  model_name TEXT NOT NULL DEFAULT '',
  request_count INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  weighted_units REAL NOT NULL DEFAULT 0,
  reported_at TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_usage_reports_slice_pool ON usage_reports (slice_start_ms, pool_key);
CREATE INDEX IF NOT EXISTS idx_usage_reports_member ON usage_reports (member_id, slice_start_ms);

-- 全组配额水位快照（来自成员或组长上报的官方 RetrieveUserQuotaSummary）
CREATE TABLE IF NOT EXISTS pool_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_key TEXT NOT NULL,                       -- 'gemini' | '3p'
  window_key TEXT NOT NULL,                     -- '5h' | 'weekly'
  remaining_pct REAL NOT NULL,                  -- 0.0 ~ 100.0
  reset_at TEXT,
  reporter_member_id TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pool_snapshots_lookup ON pool_snapshots (pool_key, window_key, captured_at_ms);

-- 已结算的 5 分钟切片分摊流水（精确追溯每一分钱和每 0.01% 消耗）
CREATE TABLE IF NOT EXISTS slice_allocations (
  id TEXT PRIMARY KEY,                          -- `${pool_key}:${slice_start_ms}:${member_id}`
  pool_key TEXT NOT NULL,                       -- 'gemini' | '3p'
  slice_start_ms INTEGER NOT NULL,
  week_bucket TEXT NOT NULL,                    -- 周重置周期标识（来自 reset_at 或 ISO 周）
  member_id TEXT NOT NULL,
  pool_drop_pct REAL NOT NULL,                  -- 本切片全组总池掉落百分比（0~100）
  member_share_ratio REAL NOT NULL,             -- 该成员占比（0~1）
  attributed_pct REAL NOT NULL,                 -- 分摊到该成员身上的百分比
  weighted_units REAL NOT NULL,
  unit_price_fen_per_pct INTEGER NOT NULL,      -- 当时执行的单价（分 / 1%）
  charge_fen INTEGER NOT NULL DEFAULT 0,        -- 实扣金额（分；owner 恒为 0）
  created_at TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_slice_alloc_member_week ON slice_allocations (member_id, week_bucket);
CREATE INDEX IF NOT EXISTS idx_slice_alloc_time ON slice_allocations (slice_start_ms);

-- 成员资金流水（充值、手动调账、退款、月结清零等）
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- 'topup' | 'adjust' | 'refund'
  amount_fen INTEGER NOT NULL,                  -- 正数入账，负数扣减
  balance_after_fen INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_transactions_member ON transactions (member_id, created_at);

-- 异常黑洞与低余额提醒记录（分级：info / warning / critical，零自动踢人）
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                           -- 'blackhole_warn' | 'blackhole_critical' | 'low_balance' | 'quota_reset'
  severity TEXT NOT NULL,                       -- 'info' | 'warning' | 'critical'
  pool_key TEXT NOT NULL DEFAULT '',
  member_id TEXT NOT NULL DEFAULT '',
  missing_pct REAL NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  qq_notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts (acknowledged, created_at);
