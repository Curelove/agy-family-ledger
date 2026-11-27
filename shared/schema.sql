-- Antigravity 家庭组共享额度看板 · 统一表结构（兼容 Cloudflare D1 与本地 Node SQLite）

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',            -- 'owner'（组长免计费） | 'member'（普通成员）
  member_token TEXT NOT NULL UNIQUE,
  balance_fen INTEGER NOT NULL DEFAULT 0,         -- 余额（分，100 分 = 1.00 元）
  low_balance_fen INTEGER NOT NULL DEFAULT 200,   -- 低余额提醒线（分）
  status TEXT NOT NULL DEFAULT 'active',          -- 'active' | 'paused' | 'archived'
  accepted_rule_version INTEGER NOT NULL DEFAULT 1, -- 成员最近一次确认同意的规则版本号
  bound_account_hash TEXT NOT NULL DEFAULT '',    -- 成员锁定的 20 位账号指纹（空表示未锁）
  bound_account_locked_by_admin INTEGER NOT NULL DEFAULT 0, -- 1 表示组长后台锁死，成员端不可自助换绑
  account_tier TEXT NOT NULL DEFAULT '',          -- 最近上报的账号档位 ('ultra' | 'pro' | 'free' | '')
  collection_status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused_account_mismatch' | 'paused_manual' | 'paused_identity_unavailable'
  devices_json TEXT NOT NULL DEFAULT '{}',        -- 匿名设备状态汇总（最多保留 6 台）
  note TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT,
  last_client_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 成员增量上报记录（幂等去重 + settled_snapshot_id 一次性结算游标，防重复计费）
CREATE TABLE IF NOT EXISTS usage_reports (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  slice_start_ms INTEGER NOT NULL,                -- 5 分钟对齐切片起点 (UTC ms)
  event_ts_ms INTEGER NOT NULL DEFAULT 0,         -- 原始事件时间戳 (UTC ms)
  pool_key TEXT NOT NULL,                         -- 'gemini' | '3p'
  model_name TEXT NOT NULL DEFAULT '',
  request_count INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  weighted_units REAL NOT NULL DEFAULT 0,
  settled_snapshot_id INTEGER DEFAULT NULL,       -- 已参与结算的 pool_snapshots.id（NULL 表示未结算）
  reported_at TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_usage_reports_slice_pool ON usage_reports (slice_start_ms, pool_key);
CREATE INDEX IF NOT EXISTS idx_usage_reports_member ON usage_reports (member_id, slice_start_ms);

-- 全组官方配额水位快照（来自 RetrieveUserQuotaSummary）
CREATE TABLE IF NOT EXISTS pool_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_key TEXT NOT NULL,                         -- 'gemini' | '3p'
  window_key TEXT NOT NULL,                       -- '5h' | 'weekly'
  remaining_pct REAL NOT NULL,                    -- 0.0 ~ 100.0
  reset_at TEXT,
  reporter_member_id TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  account_hash TEXT NOT NULL DEFAULT ''           -- 上报者账号 20 位短指纹（防串号追溯）
);
CREATE INDEX IF NOT EXISTS idx_pool_snapshots_lookup ON pool_snapshots (pool_key, window_key, captured_at_ms);

-- 已结算分摊流水（精确追溯每一次水位下降与费用计算）
CREATE TABLE IF NOT EXISTS slice_allocations (
  id TEXT PRIMARY KEY,                            -- `${pool_key}:${snapshot_id}:${member_id}`
  pool_key TEXT NOT NULL,                         -- 'gemini' | '3p'
  slice_start_ms INTEGER NOT NULL,
  week_bucket TEXT NOT NULL,                      -- 周重置周期标识（来自 reset_at）
  member_id TEXT NOT NULL,
  pool_drop_pct REAL NOT NULL,                    -- 本次可解释的总池掉落百分比（0~100）
  member_share_ratio REAL NOT NULL,               -- 该成员占比（0~1）
  attributed_pct REAL NOT NULL,                   -- 分摊到该成员身上的百分比
  weighted_units REAL NOT NULL,
  unit_price_fen_per_pct INTEGER NOT NULL,        -- 当时执行的单价（分 / 1%）
  charge_fen INTEGER NOT NULL DEFAULT 0,          -- 实扣金额（分；owner 或未确认新规则成员为 0）
  created_at TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_slice_alloc_member_week ON slice_allocations (member_id, week_bucket);
CREATE INDEX IF NOT EXISTS idx_slice_alloc_time ON slice_allocations (slice_start_ms);

-- 成员资金流水（充值、手动调账、退款）
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,                             -- 'topup' | 'adjust' | 'refund'
  amount_fen INTEGER NOT NULL,                    -- 正数入账，负数扣减
  balance_after_fen INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id)
);
CREATE INDEX IF NOT EXISTS idx_transactions_member ON transactions (member_id, created_at);

-- 规则与单价变更审计记录（公开透明，成员端可查阅）
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

-- 异常未统计消耗与提醒记录
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                             -- 'blackhole_warn' | 'blackhole_critical' | 'low_balance' | 'quota_reset' | 'rule_change'
  severity TEXT NOT NULL,                         -- 'info' | 'warning' | 'critical'
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
