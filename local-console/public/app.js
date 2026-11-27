const $ = (id) => document.getElementById(id);
const yuan = (fen) => "¥" + ((Number(fen) || 0) / 100).toFixed(2);
const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) + "%" : "--");
const consoleToken = document.querySelector('meta[name="console-token"]')?.content || "";

let currentDash = null;
let currentConsoleCfg = null;
let activeTopupMemberId = null;
let activeLockMemberId = null;
let activeInviteInfo = null;
let pendingSharedAccountHash = "";
let expandedMemberIds = new Set();
let currentUpdateMeta = null;
let currentUpdateInfo = null;
let consoleAutoCheckUpdates = true;
let consoleStartupUpdateChecked = false;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256HexFallback(str) {
  const bytes = new TextEncoder().encode(String(str ?? ""));
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/**
 * 在浏览器本地计算账号 20 位短指纹（明文邮箱永不离开浏览器）
 */
async function computeAccountFingerprintLocal(rawEmail = "") {
  const clean = String(rawEmail || "").trim().toLowerCase();
  if (!clean || !clean.includes("@")) return "";
  const input = `agy-family-ledger:acct:v1:${clean}`;
  try {
    if (globalThis.crypto?.subtle?.digest) {
      const bytes = new TextEncoder().encode(input);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 20);
    }
  } catch {}
  return sha256HexFallback(input).slice(0, 20);
}

function fmtCollectionStatusLabel(status) {
  if (status === "paused_account_mismatch") return "切号已暂停";
  if (status === "paused_manual") return "手动已暂停";
  if (status === "paused_identity_unavailable") return "本地接口未连通";
  return "活跃统计中";
}

function fmtTierBadge(tier) {
  if (tier === "ultra") return "Ultra";
  if (tier === "pro") return "Pro";
  if (tier === "free") return "Free";
  return "";
}

function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3200);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(iso) {
  if (!iso) return "尚未同步";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtReset(iso) {
  if (!iso) return "等待组长插件同步重置时间";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "重置时间待同步";
  return "下次重置：" + d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function api(url, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(consoleToken ? { "X-Console-Token": consoleToken } : {}),
    ...(opts.headers || {}),
  };
  const resp = await fetch(url, { ...opts, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败 (${resp.status})`);
  }
  return data;
}

function isPrepaidMode() {
  const s = currentDash?.settings || {};
  return s.ledger_mode === "prepaid";
}

function renderMemberList(members) {
  const el = $("member-list");
  if (!members || members.length === 0) {
    el.innerHTML = '<div class="empty-box">暂无成员记录，点击右上角「添加成员」即可生成绑定码。</div>';
    return;
  }

  const prepaid = isPrepaidMode();

  el.innerHTML = members
    .map((m) => {
      const isOpen = expandedMemberIds.has(m.id);
      const isOwner = m.role === "owner";
      const isPaused = m.status === "paused";
      const isArchived = m.status === "archived";
      const gPct = (m.week?.geminiPct || 0).toFixed(1);
      const pPct = (m.week?.thirdPartyPct || 0).toFixed(1);
      const h5G = Number(m.recent5h?.geminiSharePct || 0);
      const h5P = Number(m.recent5h?.thirdPartySharePct || 0);
      const weekTotalCost = (m.week?.geminiChargeFen || 0) + (m.week?.thirdPartyChargeFen || 0);
      const lowCls = prepaid && !isOwner && !isArchived && m.isLowBalance ? "low-bal" : "";
      const archCls = isArchived ? "archived" : "";

      let rightMetricHtml = "";
      if (prepaid) {
        rightMetricHtml = isOwner
          ? `<div class="balance-amt">Gemini ${gPct}% · 3P ${pPct}%</div><div class="balance-cap">组长免计费</div>`
          : `<div class="balance-amt ${m.isLowBalance ? "low" : ""}">${yuan(m.balanceFen)}</div><div class="balance-cap">本周期 ${yuan(weekTotalCost)}</div>`;
      } else {
        rightMetricHtml = `<div class="balance-amt">Gemini ${gPct}% · 3P ${pPct}%</div><div class="balance-cap">本周期用量</div>`;
      }

      // 单行按钮严格控制在 <= 2 个
      let quickOpsHtml = "";
      if (isOwner) {
        quickOpsHtml = `<button class="btn-soft" data-op="install-owner">装到本机</button>`;
      } else if (isArchived) {
        quickOpsHtml = `<span class="role-tag muted">已停用归档</span>`;
      } else if (prepaid) {
        quickOpsHtml = `
          <button class="btn-soft" data-op="topup" data-id="${escapeHtml(m.id)}">记录余额</button>
          <button class="btn-soft" data-op="invite" data-id="${escapeHtml(m.id)}">邀请绑定</button>
        `;
      } else {
        quickOpsHtml = `<button class="btn-soft" data-op="invite" data-id="${escapeHtml(m.id)}">邀请绑定</button>`;
      }

      const tags = [];
      if (isOwner) tags.push('<span class="role-tag">我自己</span>');
      if (isPaused) tags.push('<span class="role-tag warn">已暂停</span>');
      if (!isArchived && m.collectionStatus === "paused_account_mismatch") {
        tags.push('<span class="role-tag pine">切号暂停</span>');
      } else if (!isArchived && m.collectionStatus === "paused_manual") {
        tags.push('<span class="role-tag muted">手动暂停</span>');
      } else if (!isArchived && m.collectionStatus === "paused_identity_unavailable") {
        tags.push('<span class="role-tag warn">接口未连通</span>');
      }
      if (!isArchived && Number(m.onlineDeviceCount || 0) > 1) {
        tags.push(`<span class="role-tag pine">${Number(m.onlineDeviceCount)} 台设备</span>`);
      }
      if (!isArchived && m.isLegacyClient) {
        tags.push(`<span class="role-tag muted" title="升级到 v1.6.0 后支持切号防混账">v${escapeHtml(m.lastClientVersion)}</span>`);
      }
      if (!isArchived && m.needsRuleConfirm) tags.push('<span class="role-tag warn">待确认新规则</span>');
      if (!isArchived && m.poolViolated) tags.push('<span class="role-tag warn">误用 3P</span>');
      if (!isArchived && m.capReached) tags.push('<span class="role-tag warn">已达上限参考</span>');

      const h5Parts = [];
      if (h5G > 0) h5Parts.push(`Gemini ${h5G.toFixed(0)}%`);
      if (h5P > 0) h5Parts.push(`3P ${h5P.toFixed(0)}%`);
      const h5Desc = h5Parts.length
        ? `${h5Parts.join(" · ")}（${m.recent5h?.requests5h || 0} 次）`
        : "近 5 小时暂无记录";

      const lockDesc = m.boundAccountHash
        ? `#${m.boundAccountHash.slice(0, 8)}…（${m.boundAccountLockedByAdmin ? "组长预锁" : "自动锁定"}）`
        : "尚未锁定（首次同步自动锁定）";
      const tierStr = fmtTierBadge(m.accountTier);
      const devicesList = Array.isArray(m.devices) ? m.devices : [];
      const devicePillsHtml = devicesList.length
        ? `<div class="device-pills">${devicesList
            .slice(0, 4)
            .map((d) => {
              const stLabel =
                d.collectionStatus === "paused_account_mismatch"
                  ? "切号暂停"
                  : d.collectionStatus === "paused_manual"
                  ? "手动暂停"
                  : d.online
                  ? "在线"
                  : "离线";
              return `<span class="device-pill ${d.online ? "on" : ""}" title="${escapeHtml(d.deviceId)}">设备 #${escapeHtml(d.deviceId.slice(-4))} · ${stLabel}</span>`;
            })
            .join("")}</div>`
        : "";
      const legacyHint = m.isLegacyClient
        ? `<span>客户端 <strong>v${escapeHtml(m.lastClientVersion)}</strong>（升级后支持切号防混账）</span>`
        : "";

      return `
        <article class="member-card ${lowCls} ${archCls} ${isOpen ? "open" : ""}" data-member-id="${escapeHtml(m.id)}">
          <div class="member-row" data-toggle-member="${escapeHtml(m.id)}">
            <div class="member-left">
              <span class="presence-dot ${m.online ? "on" : ""}" title="${m.online ? "插件在线" : "未在线"}"></span>
              <div class="member-ident">
                <div class="member-name-line">
                  <span>${escapeHtml(m.name)}</span>
                  ${tags.join("")}
                </div>
                <div class="member-sub">
                  最近同步：${fmtTime(m.lastSeenAt)}${m.note ? " · " + escapeHtml(m.note) : ""}
                </div>
              </div>
            </div>
            <div class="member-right">
              <div class="balance-block">${rightMetricHtml}</div>
              <div class="member-quick-ops">${quickOpsHtml}</div>
            </div>
          </div>

          <div class="member-drawer">
            <div class="drawer-grid">
              <div class="drawer-cell">
                <div class="dk">本周期 Gemini 用量</div>
                <div class="dv">${gPct}%${prepaid && !isOwner ? "（" + yuan(m.week?.geminiChargeFen) + "）" : ""}</div>
              </div>
              <div class="drawer-cell">
                <div class="dk">本周期 Claude 3P 用量</div>
                <div class="dv">${pPct}%${prepaid && !isOwner ? "（" + yuan(m.week?.thirdPartyChargeFen) + "）" : ""}</div>
              </div>
              <div class="drawer-cell">
                <div class="dk">近 5 小时活跃参考</div>
                <div class="dv">${h5Desc}</div>
              </div>
            </div>
            <div class="drawer-meta-strip">
              <span>账号锁：<strong>${escapeHtml(lockDesc)}</strong>${tierStr ? ` · ${tierStr}` : ""}</span>
              <span>采集状态：<strong>${fmtCollectionStatusLabel(m.collectionStatus)}</strong></span>
              ${devicesList.length > 0 ? `<span>设备：${Number(m.onlineDeviceCount || 0)} / ${devicesList.length} 台</span>` : ""}
              ${devicePillsHtml}
              ${legacyHint}
            </div>
            <div class="drawer-token-bar">
              <span class="token-code">规则已确认 v${Number(m.acceptedRuleVersion || 1)} · 近 7 天 ${m.requests7d || 0} 次请求${m.lastClientVersion ? ` · v${escapeHtml(m.lastClientVersion)}` : ""}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${!isArchived ? `<button class="btn-soft" data-op="invite" data-id="${escapeHtml(m.id)}">查看绑定码</button>` : ""}
                ${!isArchived ? `<button class="btn-soft" data-op="account-lock" data-id="${escapeHtml(m.id)}">账号锁</button>` : ""}
                ${!isOwner && !isArchived ? `<button class="btn-soft" data-op="toggle-pause" data-id="${escapeHtml(m.id)}" data-paused="${isPaused ? "1" : "0"}">${isPaused ? "恢复同步" : "暂停同步"}</button>` : ""}
                ${!isOwner && !isArchived ? `<button class="btn-soft" data-op="rotate-token" data-id="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}">重置绑定码</button>` : ""}
                ${!isOwner && !isArchived ? `<button class="btn-danger-soft" data-op="delete" data-id="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}">停用移除</button>` : ""}
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderActivityFeed(dash) {
  const prepaid = isPrepaidMode();
  const items = [];
  if (prepaid) {
    for (const t of (dash.recentTransactions || []).slice(0, 8)) {
      items.push({
        ts: Date.parse(t.created_at) || 0,
        title: `${t.member_name || t.member_id} · ${t.kind === "topup" ? "补充余额" : "余额调整"}`,
        meta: `${fmtTime(t.created_at)}${t.note ? " · " + t.note : ""}`,
        amt: (t.amount_fen >= 0 ? "+" : "") + yuan(t.amount_fen),
        cls: t.amount_fen >= 0 ? "pos" : "neg",
      });
    }
  }
  for (const a of (dash.recentAllocations || []).slice(0, 12)) {
    const poolText = a.pool_key === "3p" ? "Claude 3P" : "Gemini";
    items.push({
      ts: a.slice_start_ms || Date.parse(a.created_at) || 0,
      title: `${a.member_name || a.member_id} · ${poolText} ${Number(a.attributed_pct || 0).toFixed(2)}%`,
      meta: `${fmtTime(a.created_at)} · 当次总池降 ${Number(a.pool_drop_pct || 0).toFixed(2)}%（占 ${(Number(a.member_share_ratio || 0) * 100).toFixed(0)}%）`,
      amt: prepaid && a.charge_fen > 0 ? "-" + yuan(a.charge_fen) : Number(a.attributed_pct || 0).toFixed(2) + "%",
      cls: "neg",
    });
  }
  items.sort((a, b) => b.ts - a.ts);

  const el = $("activity-feed");
  if (items.length === 0) {
    el.innerHTML = '<div class="empty-box">暂无用量变动记录。</div>';
    return;
  }
  el.innerHTML = items
    .slice(0, 8)
    .map(
      (x) => `
      <div class="feed-item">
        <div class="feed-left">
          <div class="feed-title">${escapeHtml(x.title)}</div>
          <div class="feed-meta">${escapeHtml(x.meta)}</div>
        </div>
        <div class="feed-amt ${x.cls}">${escapeHtml(x.amt)}</div>
      </div>`
    )
    .join("");
}

function renderTxTable(txs) {
  const body = $("tx-table-body");
  if (!txs || txs.length === 0) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:18px;">暂无余额变动记录</td></tr>';
    return;
  }
  body.innerHTML = txs
    .map(
      (t) => `
      <tr>
        <td>${fmtTime(t.created_at)}</td>
        <td>${escapeHtml(t.member_name || t.member_id)}</td>
        <td>${t.kind === "topup" ? "补充余额" : t.kind === "refund" ? "退款" : "调整"}</td>
        <td class="num" style="color:${t.amount_fen >= 0 ? "var(--leaf)" : "var(--vermilion)"}">${t.amount_fen >= 0 ? "+" : ""}${yuan(t.amount_fen)}</td>
        <td class="num">${yuan(t.balance_after_fen)}</td>
        <td>${escapeHtml(t.note || "—")}</td>
      </tr>`
    )
    .join("");
}

function renderRuleChanges(list) {
  const box = $("rule-history-box");
  const el = $("rule-history-list");
  if (!list || list.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  el.innerHTML = list
    .slice(0, 6)
    .map(
      (r) => `
      <div class="rule-history-item">
        <div><strong>v${Number(r.rule_version)}</strong> · ${escapeHtml(r.next_summary)}</div>
        <div class="rule-history-meta">${fmtTime(r.created_at)} · 原为：${escapeHtml(r.prev_summary)}</div>
      </div>`
    )
    .join("");
}

function renderAlerts(alerts) {
  const el = $("alert-list");
  if (!alerts || alerts.length === 0) {
    el.innerHTML = '<div class="empty-box">目前全组用量记录正常，没有未匹配的异常掉量。</div>';
    return;
  }
  el.innerHTML = alerts
    .map(
      (a) => `
      <article class="alert-card ${escapeHtml(a.severity)} ${a.acknowledged ? "acked" : ""}">
        <div style="min-width:0;flex:1;">
          <div class="alert-title">${escapeHtml(a.title)}</div>
          <div class="alert-detail">${escapeHtml(a.detail)}</div>
          <div class="alert-time">${fmtTime(a.created_at)}${a.acknowledged ? " · 已读" : ""}</div>
        </div>
        ${!a.acknowledged ? `<button class="btn-ghost" data-ack-alert="${escapeHtml(a.id)}">标记已读</button>` : ""}
      </article>`
    )
    .join("");
}

function syncSettingsFormVisibility() {
  const selectedLedgerMode = document.querySelector('input[name="ledger-mode"]:checked')?.value || "board_only";
  $("prepaid-price-box").hidden = selectedLedgerMode !== "prepaid";

  const selectedConsoleMode = document.querySelector('input[name="console-mode"]:checked')?.value || "local";
  $("cloud-cfg-box").hidden = selectedConsoleMode !== "cloud";

  const selectedIsoMode = document.querySelector('input[name="account-isolation-mode"]:checked')?.value || "per_member_lock";
  $("shared-account-box").hidden = selectedIsoMode !== "shared_owner_account";
}

function renderSharedHashStatus() {
  const el = $("shared-hash-status");
  const clearBtn = $("btn-clear-shared-hash");
  if (!el) return;
  if (pendingSharedAccountHash) {
    el.textContent = `当前已锁全组共享指纹：#${pendingSharedAccountHash.slice(0, 10)}…（20 位短指纹）`;
    if (clearBtn) clearBtn.hidden = false;
  } else {
    el.textContent = "尚未设定共享账号指纹，可点击下方按钮锁定组长当前账号或输入共享邮箱生成。";
    if (clearBtn) clearBtn.hidden = true;
  }
}

function updatePricePreview() {
  const gemYuan = Math.max(0, Number($("set-gem-price").value) || 0);
  const p3Yuan = Math.max(0, Number($("set-3p-price").value) || 0);
  $("price-preview-line").textContent =
    `按当前单价：Gemini 消耗 5% 约 ¥${(gemYuan * 5).toFixed(2)}，Claude 3P 消耗 5% 约 ¥${(p3Yuan * 5).toFixed(2)}`;
}

function updateUsageRulePreview() {
  const floor = Math.max(0, Math.min(95, Number($("set-pool-floor").value) || 0));
  const cap = Math.max(0, Math.min(100, Number($("set-member-cap").value) || 0));
  const applyOwner = $("set-apply-cap-owner").checked;
  const restrict3p = $("set-restrict-3p").checked;
  const note = $("set-usage-note").value.trim();
  const fmtL = (v) => (Number.isInteger(v) ? v + "%" : v.toFixed(1) + "%");
  const parts = [];
  if (floor > 0) parts.push(`总池剩余 ${fmtL(floor)} 时暂停非紧急任务`);
  if (cap > 0) parts.push(`单人每周期上限 ${fmtL(cap)}（${applyOwner ? "全员同等适用" : "适用于普通成员"}）`);
  if (restrict3p) parts.push("普通成员仅限 Gemini 池（禁用 Claude 3P）");
  if (note) parts.push(`补充说明：${note.length > 36 ? note.slice(0, 36) + "…" : note}`);
  $("usage-rule-preview").textContent = parts.length
    ? `成员侧边栏公示预览：${parts.join("；")}`
    : "当前未设置使用约定，成员侧边栏将保持精简，不显示约定卡片。";
}

function applyDashboard(dash) {
  currentDash = dash;
  const s = dash.settings || {};
  const prepaid = s.ledger_mode === "prepaid";

  $("hdr-family-name").textContent = s.family_name || "家庭组共享额度看板";
  $("hdr-prepaid-badge").hidden = !prepaid;
  $("hdr-sync-time").textContent = "更新于 " + fmtTime(dash.serverTimeIso);

  const gw = dash.pools?.gemini?.weekly;
  const g5 = dash.pools?.gemini?.["5h"];
  const pw = dash.pools?.["3p"]?.weekly;
  const p5 = dash.pools?.["3p"]?.["5h"];

  $("ov-gem-week-pct").textContent = pct(gw?.remainingPct);
  $("ov-gem-week-bar").style.width = (gw ? Math.max(0, Math.min(100, gw.remainingPct)) : 0) + "%";
  $("ov-gem-5h-pct").textContent = pct(g5?.remainingPct);
  $("ov-gem-reset").textContent = fmtReset(gw?.resetAt);

  $("ov-3p-week-pct").textContent = pct(pw?.remainingPct);
  $("ov-3p-week-bar").style.width = (pw ? Math.max(0, Math.min(100, pw.remainingPct)) : 0) + "%";
  $("ov-3p-5h-pct").textContent = pct(p5?.remainingPct);
  $("ov-3p-reset").textContent = fmtReset(pw?.resetAt);

  const ur = dash.usageRules || {};
  const floorPct = Number(ur.poolReserveFloorPct || 0);
  const fmtL = (v) => (Number.isInteger(v) ? v + "%" : v.toFixed(1) + "%");
  $("ov-gem-floor-mark").hidden = !(floorPct > 0);
  $("ov-3p-floor-mark").hidden = !(floorPct > 0);
  $("ov-gem-floor-foot").hidden = !(floorPct > 0);
  $("ov-3p-floor-foot").hidden = !(floorPct > 0);
  if (floorPct > 0) {
    $("ov-gem-floor-mark").style.left = floorPct + "%";
    $("ov-3p-floor-mark").style.left = floorPct + "%";
    $("ov-gem-floor-foot").textContent = ur.poolFloor?.geminiReached ? `已达保留底线 ${fmtL(floorPct)}` : `保留底线 ${fmtL(floorPct)}`;
    $("ov-gem-floor-foot").className = "floor-foot" + (ur.poolFloor?.geminiReached ? " reached" : "");
    $("ov-3p-floor-foot").textContent = ur.poolFloor?.thirdPartyReached ? `已达保留底线 ${fmtL(floorPct)}` : `保留底线 ${fmtL(floorPct)}`;
    $("ov-3p-floor-foot").className = "floor-foot" + (ur.poolFloor?.thirdPartyReached ? " reached" : "");
  }

  $("ov-convention-strip").hidden = !Boolean(ur.hasUsageRules);
  if (ur.hasUsageRules) {
    $("ov-convention-ver").textContent = `v${Number(s.rule_version || 1)}`;
    $("ov-floor-reached-tag").hidden = !Boolean(ur.poolFloor?.anyReached);
    $("ov-convention-text").textContent = ur.summaryText || "";
  }

  const sum = dash.summary || {};
  $("kpi-online").textContent = `${sum.onlineCount || 0} / ${sum.memberCount || 0}`;
  if (prepaid) {
    $("kpi-col2-label").textContent = "本周期合计扣费";
    $("kpi-col2-val").textContent = yuan(sum.totalWeekChargeFen || 0);
    $("kpi-col3-label").textContent = "累计收到预存";
    $("kpi-col3-val").textContent = yuan(sum.totalTopupFen || 0);
    $("kpi-col3-val").className = "kpi-value positive";
  } else {
    $("kpi-col2-label").textContent = "本周期 Gemini 已用";
    $("kpi-col2-val").textContent = Number(sum.totalWeekGeminiPct || 0).toFixed(1) + "%";
    $("kpi-col3-label").textContent = "本周期 Claude 已用";
    $("kpi-col3-val").textContent = Number(sum.totalWeekThirdPartyPct || 0).toFixed(1) + "%";
    $("kpi-col3-val").className = "kpi-value";
  }

  const kpiAlert = $("kpi-alerts");
  kpiAlert.textContent = `${sum.unackedAlertCount || 0} 条`;
  kpiAlert.className = "kpi-value" + ((sum.criticalAlertCount || 0) > 0 ? " danger" : "");

  const navBadge = $("nav-alert-count");
  navBadge.textContent = String(sum.unackedAlertCount || 0);
  navBadge.hidden = !(sum.unackedAlertCount > 0);

  $("prepaid-tx-section").hidden = !prepaid;

  renderMemberList(dash.members || []);
  renderActivityFeed(dash);
  if (prepaid) renderTxTable(dash.recentTransactions || []);
  renderAlerts(dash.alerts || []);
  renderRuleChanges(dash.ruleChanges || []);

  // 回填设置页
  $("set-family-name").value = s.family_name || "";
  const modeVal = s.ledger_mode === "prepaid" ? "prepaid" : "board_only";
  for (const r of document.querySelectorAll('input[name="ledger-mode"]')) {
    r.checked = r.value === modeVal;
  }
  $("set-owner-only-quota").checked = (s.quota_snapshot_authority || "owner_only") !== "all_members";
  $("set-show-peers").checked = s.show_peer_shares_to_members !== false;
  $("set-broadcast-blackhole").checked = s.broadcast_blackhole_to_members !== false;
  $("set-gem-price").value = ((Number(s.gemini_fen_per_weekly_pct) || 100) / 100).toFixed(2);
  $("set-3p-price").value = ((Number(s.third_party_fen_per_weekly_pct) || 180) / 100).toFixed(2);
  $("set-pool-floor").value = Number(s.pool_reserve_floor_pct || 0);
  $("set-member-cap").value = Number(s.member_weekly_cap_pct || 0);
  $("set-apply-cap-owner").checked = s.apply_cap_to_owner !== false;
  $("set-restrict-3p").checked = Boolean(s.restrict_3p_for_members);
  $("set-usage-note").value = s.usage_rule_note || "";
  $("set-warn-pct").value = Number(s.blackhole_warn_missing_pct) || 5;
  $("set-crit-pct").value = Number(s.blackhole_critical_missing_pct) || 15;

  // 回填多账号归属锁与套餐档位
  const isoMode = s.account_isolation_mode === "shared_owner_account" ? "shared_owner_account" : "per_member_lock";
  for (const r of document.querySelectorAll('input[name="account-isolation-mode"]')) {
    r.checked = r.value === isoMode;
  }
  pendingSharedAccountHash = String(s.shared_account_hash || "");
  renderSharedHashStatus();
  const ownerHash = String(sum.ownerBoundAccountHash || "");
  const lockOwnerBtn = $("btn-lock-owner-account");
  if (lockOwnerBtn) {
    lockOwnerBtn.textContent = ownerHash
      ? `一键锁定组长当前账号 (#${ownerHash.slice(0, 6)}…)`
      : "一键锁定组长当前账号（需组长先同步）";
  }
  $("set-plan-tier").value = s.plan_tier === "pro" || s.plan_tier === "ultra" ? s.plan_tier : "auto";
  const detectedTier = fmtTierBadge(sum.ownerAccountTier || sum.effectivePlanTier || "");
  const argonNote = s.has_separate_argon_pool
    ? "已自动识别 Pro 独立 Argon 桶，Argon 用量不混入普通 Gemini 周池分摊。"
    : "当前 Argon 与 Gemini 共享周池（Ultra 模式），按 1.5x 正常分摊。";
  $("plan-tier-hint").textContent =
    (detectedTier ? `已检测到组长当前档位：${detectedTier}。` : "尚未检测到组长档位，默认按 Ultra 基准计算。") + argonNote;

  updatePricePreview();
  updateUsageRulePreview();
  syncSettingsFormVisibility();
}

function applyConsoleConfig(cfg) {
  currentConsoleCfg = cfg;
  const badge = $("hdr-storage-badge");
  const isCloud = cfg.mode === "cloud";
  badge.textContent = isCloud ? "Cloudflare 云端同步" : "本机离线存储";
  badge.className = "status-stamp" + (isCloud ? " cloud" : "");
  $("btn-demo-seed").hidden = isCloud;

  $("owner-sync-warn").hidden = !Boolean(cfg.ownerPluginNeedsSync);
  if (cfg.ownerPluginNeedsSync) {
    $("owner-old-url").textContent = cfg.ownerPluginServerUrl || "旧地址";
  }

  for (const r of document.querySelectorAll('input[name="console-mode"]')) {
    r.checked = r.value === cfg.mode;
  }
  $("cfg-worker-url").value = cfg.cloudWorkerUrl || "";
  syncSettingsFormVisibility();
}

async function refreshAll() {
  try {
    const cfgRes = await api("/api/console-config");
    applyConsoleConfig(cfgRes.config);
    const dash = await api("/api/admin/dashboard");
    applyDashboard(dash);
  } catch (err) {
    showToast("读取数据失败：" + err.message);
  }
}

async function openInviteModal(memberId) {
  try {
    const info = await api(`/api/invite-info/${encodeURIComponent(memberId)}`);
    activeInviteInfo = info;
    $("inv-member-name").textContent = info.memberName;
    $("inv-releases-url").textContent = info.releasesUrl;
    $("inv-code-text").textContent = info.inviteCode;
    $("inv-terms-summary").textContent = info.termsSummary || "纯看板模式";
    $("inv-releases-link").href = info.releasesUrl;
    $("invite-local-warn").hidden = !info.isLocalOnly;
    const lockNote = $("inv-account-lock-note");
    if (lockNote) {
      if (info.targetAccountHash) {
        lockNote.hidden = false;
        lockNote.textContent =
          info.accountIsolationMode === "shared_owner_account"
            ? `绑定码已内置全组共享账号指纹锁（#${info.targetAccountHash.slice(0, 8)}…），成员挂在其他个人号上粘贴也会自动暂停防绑错。`
            : `绑定码已内置该成员预锁账号指纹（#${info.targetAccountHash.slice(0, 8)}…），仅统计匹配的家庭组账号。`;
      } else {
        lockNote.hidden = true;
      }
    }
    $("modal-invite").hidden = false;
  } catch (err) {
    showToast(err.message);
  }
}

function buildPlainInviteMessage(info) {
  return [
    `家庭组额度看板插件已公开在 GitHub，直接从官方页面下载安装即可（无需接收私人压缩包）：`,
    `1. 官方构建包下载与 SHA-256 核验：${info.releasesUrl}`,
    `   公开源码仓库：${info.repoUrl}`,
    `2. 解压后运行对应系统的安装脚本（Windows 运行 install_windows.cmd，macOS / Linux 运行 bash install_macos_linux.sh），重启 Antigravity App 并在扩展设置中确认启用。`,
    `3. 打开右侧边栏「家庭组额度看板」，粘贴下方纯文本绑定码即可连接（已锁定当前规则：${info.termsSummary}）：`,
    info.inviteCode,
  ].join("\n");
}

document.querySelectorAll(".index-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    document.querySelectorAll(".index-tab").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".tab-view").forEach((v) => {
      v.classList.toggle("active", v.id === "view-" + target);
    });
  });
});

document.querySelectorAll('input[name="ledger-mode"], input[name="console-mode"], input[name="account-isolation-mode"]').forEach((el) => {
  el.addEventListener("change", syncSettingsFormVisibility);
});

document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $(btn.dataset.closeModal).hidden = true;
  });
});

document.addEventListener("click", async (e) => {
  const ackBtn = e.target.closest("[data-ack-alert]");
  if (ackBtn) {
    try {
      await api(`/api/admin/alerts/${encodeURIComponent(ackBtn.dataset.ackAlert)}/ack`, { method: "POST", body: "{}" });
      showToast("已标记为已读");
      await refreshAll();
    } catch (err) {
      showToast(err.message);
    }
    return;
  }

  const opBtn = e.target.closest("[data-op]");
  if (opBtn) {
    e.stopPropagation();
    const op = opBtn.dataset.op;
    const id = opBtn.dataset.id;
    if (op === "install-owner") {
      await handleInstallOwner();
    } else if (op === "invite") {
      await openInviteModal(id);
    } else if (op === "account-lock") {
      const m = (currentDash?.members || []).find((x) => x.id === id);
      if (!m) return;
      activeLockMemberId = id;
      $("lock-member-name").textContent = m.name;
      $("lock-current-status").textContent = m.boundAccountHash
        ? `当前已锁指纹：#${m.boundAccountHash.slice(0, 10)}…（${m.boundAccountLockedByAdmin ? "组长后台预锁，成员端不可自助换绑" : "成员首次同步自动锁定"}）`
        : "当前尚未锁定账号指纹（成员首次同步时将自动锁定当时登录的账号）。";
      $("edit-lock-email").value = "";
      $("edit-lock-hash-preview").textContent = "输入完整邮箱后将实时显示 20 位不可逆短指纹";
      $("edit-lock-hash-preview").className = "hash-preview-line";
      $("btn-clear-member-lock").hidden = !Boolean(m.boundAccountHash);
      $("modal-account-lock").hidden = false;
      $("edit-lock-email").focus();
    } else if (op === "topup") {
      const m = (currentDash?.members || []).find((x) => x.id === id);
      if (!m) return;
      activeTopupMemberId = id;
      $("topup-member-name").textContent = m.name;
      $("topup-current-bal").textContent = yuan(m.balanceFen);
      $("topup-yuan").value = "10";
      $("topup-note").value = "补充预存余额";
      $("modal-topup").hidden = false;
    } else if (op === "toggle-pause") {
      const currentlyPaused = opBtn.dataset.paused === "1";
      try {
        await api(`/api/admin/members/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: currentlyPaused ? "active" : "paused" }),
        });
        showToast(currentlyPaused ? "已恢复该成员同步" : "已暂停该成员同步");
        await refreshAll();
      } catch (err) {
        showToast(err.message);
      }
    } else if (op === "rotate-token") {
      if (!confirm(`确认重置「${opBtn.dataset.name}」的绑定码吗？重置后原绑定码立即失效，需要将新绑定码发给对方。`)) return;
      try {
        await api(`/api/admin/members/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ rotateToken: true }),
        });
        showToast("已生成新绑定码，旧凭证已失效");
        await refreshAll();
        await openInviteModal(id);
      } catch (err) {
        showToast(err.message);
      }
    } else if (op === "delete") {
      if (!confirm(`确认停用或移除「${opBtn.dataset.name}」吗？若该成员已有历史记录，系统会自动停用其绑定码并保留历史总账。`)) return;
      try {
        const res = await api(`/api/admin/members/${encodeURIComponent(id)}`, { method: "DELETE" });
        showToast(res.message || "已处理该成员");
        await refreshAll();
      } catch (err) {
        showToast(err.message);
      }
    }
    return;
  }

  const row = e.target.closest("[data-toggle-member]");
  if (row) {
    const id = row.dataset.toggleMember;
    if (expandedMemberIds.has(id)) expandedMemberIds.delete(id);
    else expandedMemberIds.add(id);
    document.querySelectorAll(`.member-card[data-member-id="${CSS.escape(id)}"]`).forEach((card) => {
      card.classList.toggle("open", expandedMemberIds.has(id));
    });
  }
});

document.querySelectorAll(".quick-chip[data-yuan]").forEach((chip) => {
  chip.addEventListener("click", () => {
    $("topup-yuan").value = chip.dataset.yuan;
  });
});

document.querySelectorAll("[data-rule-preset]").forEach((chip) => {
  chip.addEventListener("click", () => {
    const preset = chip.dataset.rulePreset;
    if (preset === "clear") {
      $("set-pool-floor").value = "0";
      $("set-member-cap").value = "0";
      $("set-restrict-3p").checked = false;
      $("set-usage-note").value = "";
    } else if (preset === "floor20") {
      $("set-pool-floor").value = "20";
    } else if (preset === "cap50") {
      $("set-member-cap").value = "50";
    } else if (preset === "cap30") {
      $("set-member-cap").value = "30";
    } else if (preset === "cap25") {
      $("set-member-cap").value = "25";
    }
    updateUsageRulePreview();
  });
});

$("btn-jump-rules").addEventListener("click", () => {
  const settingsBtn = document.querySelector('.index-tab[data-tab="settings"]');
  if (settingsBtn) settingsBtn.click();
  $("usage-rules-box")?.scrollIntoView({ behavior: "smooth", block: "center" });
});

$("btn-open-add-member").addEventListener("click", () => {
  $("add-name").value = "";
  $("add-note").value = "";
  $("add-lock-email").value = "";
  $("add-lock-hash-preview").textContent = "填后将锁定该成员仅统计指定邮箱，防止首次绑定挂错个人号。";
  $("add-lock-hash-preview").className = "hash-preview-line";
  $("add-prepaid-fields").hidden = !isPrepaidMode();
  $("modal-add-member").hidden = false;
  $("add-name").focus();
});

async function bindEmailHashPreview(inputId, previewId, emptyHint) {
  const inputEl = $(inputId);
  const previewEl = $(previewId);
  if (!inputEl || !previewEl) return;
  inputEl.addEventListener("input", async () => {
    const raw = inputEl.value.trim();
    if (!raw) {
      previewEl.textContent = emptyHint;
      previewEl.className = "hash-preview-line";
      return;
    }
    const h = await computeAccountFingerprintLocal(raw);
    if (!h) {
      previewEl.textContent = "请输入包含 @ 的完整邮箱地址以计算本地短指纹";
      previewEl.className = "hash-preview-line";
      return;
    }
    previewEl.textContent = `本地短指纹预览：#${h}（仅上传此 20 位不可逆哈希，明文邮箱不离开浏览器）`;
    previewEl.className = "hash-preview-line ready";
  });
}

void bindEmailHashPreview(
  "add-lock-email",
  "add-lock-hash-preview",
  "填后将锁定该成员仅统计指定邮箱，防止首次绑定挂错个人号。"
);
void bindEmailHashPreview(
  "edit-lock-email",
  "edit-lock-hash-preview",
  "输入完整邮箱后将实时显示 20 位不可逆短指纹"
);
void bindEmailHashPreview(
  "set-shared-email",
  "shared-email-hash-preview",
  "留空则保持上方已锁指纹不变"
);

$("btn-confirm-add-member").addEventListener("click", async () => {
  const name = $("add-name").value.trim();
  if (!name) return showToast("请先填写成员称呼");
  const rawEmail = $("add-lock-email").value.trim();
  let boundAccountHash = "";
  if (rawEmail) {
    boundAccountHash = await computeAccountFingerprintLocal(rawEmail);
    if (!boundAccountHash) return showToast("预锁邮箱格式不正确，需包含 @ 或留空");
  }
  const prepaid = isPrepaidMode();
  try {
    const out = await api("/api/admin/members", {
      method: "POST",
      body: JSON.stringify({
        name,
        role: "member",
        initialBalanceFen: prepaid ? Math.round((Number($("add-init-yuan").value) || 0) * 100) : 0,
        lowBalanceFen: prepaid ? Math.round((Number($("add-low-yuan").value) || 2) * 100) : 200,
        note: $("add-note").value.trim(),
        boundAccountHash,
        boundAccountLockedByAdmin: Boolean(boundAccountHash),
      }),
    });
    $("add-lock-email").value = "";
    $("modal-add-member").hidden = true;
    await refreshAll();
    if (out.member?.id) {
      await openInviteModal(out.member.id);
    }
  } catch (err) {
    showToast(err.message);
  }
});

$("btn-save-member-lock").addEventListener("click", async () => {
  if (!activeLockMemberId) return;
  const rawEmail = $("edit-lock-email").value.trim();
  if (!rawEmail) return showToast("请先输入该成员的家庭组邮箱");
  const hash = await computeAccountFingerprintLocal(rawEmail);
  if (!hash) return showToast("邮箱格式不正确，需包含 @");
  try {
    await api(`/api/admin/members/${encodeURIComponent(activeLockMemberId)}`, {
      method: "PATCH",
      body: JSON.stringify({ boundAccountHash: hash, boundAccountLockedByAdmin: true }),
    });
    $("edit-lock-email").value = "";
    $("modal-account-lock").hidden = true;
    showToast(`已锁定成员账号指纹 (#${hash.slice(0, 8)}…)`);
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

$("btn-clear-member-lock").addEventListener("click", async () => {
  if (!activeLockMemberId) return;
  try {
    await api(`/api/admin/members/${encodeURIComponent(activeLockMemberId)}`, {
      method: "PATCH",
      body: JSON.stringify({ clearAccountLock: true }),
    });
    $("edit-lock-email").value = "";
    $("modal-account-lock").hidden = true;
    showToast("已清除该成员账号锁，允许其重新绑定账号");
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

$("btn-lock-owner-account").addEventListener("click", () => {
  const ownerHash = String(currentDash?.summary?.ownerBoundAccountHash || "");
  if (!ownerHash) {
    return showToast("组长插件尚未同步到当前账号指纹，请先打开 Antigravity 侧边栏同步一次");
  }
  pendingSharedAccountHash = ownerHash;
  $("set-shared-email").value = "";
  $("shared-email-hash-preview").textContent = "已选定组长当前同步账号指纹，点击下方「保存账号锁与档位」即可生效";
  $("shared-email-hash-preview").className = "hash-preview-line ready";
  renderSharedHashStatus();
});

$("btn-clear-shared-hash").addEventListener("click", () => {
  pendingSharedAccountHash = "";
  $("set-shared-email").value = "";
  $("shared-email-hash-preview").textContent = "已清空共享指纹，保存后生效";
  $("shared-email-hash-preview").className = "hash-preview-line";
  renderSharedHashStatus();
});

$("btn-save-isolation").addEventListener("click", async () => {
  const mode = document.querySelector('input[name="account-isolation-mode"]:checked')?.value || "per_member_lock";
  const planTier = $("set-plan-tier").value || "auto";
  const typedEmail = $("set-shared-email").value.trim();
  let finalSharedHash = pendingSharedAccountHash;
  if (mode === "shared_owner_account" && typedEmail) {
    finalSharedHash = await computeAccountFingerprintLocal(typedEmail);
    if (!finalSharedHash) return showToast("共享邮箱格式不正确，需包含 @");
  }
  if (mode === "shared_owner_account" && !finalSharedHash) {
    return showToast("开启「全组共用同一登录账号」需先锁定组长账号或输入共享邮箱");
  }
  try {
    await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({
        account_isolation_mode: mode,
        shared_account_hash: mode === "shared_owner_account" ? finalSharedHash : "",
        plan_tier: planTier,
      }),
    });
    $("set-shared-email").value = "";
    showToast("账号归属锁与套餐档位已保存");
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

$("btn-copy-releases-url").addEventListener("click", async () => {
  if (!activeInviteInfo) return;
  await navigator.clipboard?.writeText(activeInviteInfo.releasesUrl).catch(() => {});
  showToast("已复制 GitHub Releases 下载页链接");
});

$("btn-copy-code-only").addEventListener("click", async () => {
  if (!activeInviteInfo) return;
  await navigator.clipboard?.writeText(activeInviteInfo.inviteCode).catch(() => {});
  showToast("已复制纯文本绑定码");
});

$("btn-copy-full-invite").addEventListener("click", async () => {
  if (!activeInviteInfo) return;
  await navigator.clipboard?.writeText(buildPlainInviteMessage(activeInviteInfo)).catch(() => {});
  showToast("已复制完整邀请说明，可直接发给朋友");
});

$("btn-confirm-topup").addEventListener("click", async () => {
  if (!activeTopupMemberId) return;
  const amountFen = Math.round((Number($("topup-yuan").value) || 0) * 100);
  if (amountFen === 0) return showToast("请输入非 0 金额");
  try {
    await api(`/api/admin/members/${encodeURIComponent(activeTopupMemberId)}/transactions`, {
      method: "POST",
      body: JSON.stringify({
        kind: amountFen > 0 ? "topup" : "adjust",
        amountFen,
        note: $("topup-note").value.trim(),
      }),
    });
    $("modal-topup").hidden = true;
    showToast(`已记录余额变动（${amountFen > 0 ? "+" : ""}${yuan(amountFen)}）`);
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

$("set-gem-price").addEventListener("input", updatePricePreview);
$("set-3p-price").addEventListener("input", updatePricePreview);
$("set-pool-floor").addEventListener("input", updateUsageRulePreview);
$("set-member-cap").addEventListener("input", updateUsageRulePreview);
$("set-apply-cap-owner").addEventListener("change", updateUsageRulePreview);
$("set-restrict-3p").addEventListener("change", updateUsageRulePreview);
$("set-usage-note").addEventListener("input", updateUsageRulePreview);

$("btn-save-settings").addEventListener("click", async () => {
  const ledgerMode = document.querySelector('input[name="ledger-mode"]:checked')?.value || "board_only";
  try {
    await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({
        family_name: $("set-family-name").value.trim() || "家庭组共享额度看板",
        ledger_mode: ledgerMode,
        quota_snapshot_authority: $("set-owner-only-quota").checked ? "owner_only" : "all_members",
        show_peer_shares_to_members: $("set-show-peers").checked,
        broadcast_blackhole_to_members: $("set-broadcast-blackhole").checked,
        gemini_fen_per_weekly_pct: Math.round((Number($("set-gem-price").value) || 1) * 100),
        third_party_fen_per_weekly_pct: Math.round((Number($("set-3p-price").value) || 1.8) * 100),
        pool_reserve_floor_pct: Math.max(0, Math.min(95, Number($("set-pool-floor").value) || 0)),
        member_weekly_cap_pct: Math.max(0, Math.min(100, Number($("set-member-cap").value) || 0)),
        apply_cap_to_owner: $("set-apply-cap-owner").checked,
        restrict_3p_for_members: $("set-restrict-3p").checked,
        usage_rule_note: $("set-usage-note").value.trim().slice(0, 180),
        blackhole_warn_missing_pct: Number($("set-warn-pct").value) || 5,
        blackhole_critical_missing_pct: Number($("set-crit-pct").value) || 15,
      }),
    });
    showToast("看板规则已保存");
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

$("btn-save-console-cfg").addEventListener("click", async () => {
  const mode = document.querySelector('input[name="console-mode"]:checked')?.value || "local";
  try {
    await api("/api/console-config", {
      method: "PATCH",
      body: JSON.stringify({
        mode,
        cloudWorkerUrl: $("cfg-worker-url").value.trim(),
        adminSecret: $("cfg-admin-secret").value.trim(),
      }),
    });
    $("cfg-admin-secret").value = "";
    showToast("存储设置已保存");
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

async function handleInstallOwner() {
  try {
    const out = await api("/api/install-owner-local", { method: "POST", body: "{}" });
    showToast(`组长插件已同步到本机（${out.memberName}）`);
    await refreshAll();
  } catch (err) {
    showToast("安装失败：" + err.message);
  }
}

$("btn-install-owner-settings").addEventListener("click", handleInstallOwner);
$("btn-refresh").addEventListener("click", refreshAll);

$("btn-demo-seed").addEventListener("click", async () => {
  try {
    const out = await api("/api/demo/seed", { method: "POST", body: "{}" });
    showToast(out.message || "已填充示例数据");
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

function renderConsoleUpdateUi() {
  const curVer = String(currentUpdateMeta?.version || "1.6.0");
  const fallbackRel = String(currentUpdateMeta?.releasesUrl || "https://github.com/Curelove/agy-family-ledger/releases");
  $("console-cur-ver-badge").textContent = "v" + curVer;
  $("console-releases-link").href = currentUpdateInfo?.releasesUrl || fallbackRel;
  $("chk-console-auto-update").checked = consoleAutoCheckUpdates !== false;

  const upd = currentUpdateInfo;
  const shouldNotify = Boolean(upd && upd.ok && upd.shouldNotify && upd.latestVersion);
  $("btn-console-update-pill").hidden = !shouldNotify;
  if (shouldNotify) {
    $("console-update-pill-label").textContent = "新版 v" + upd.latestVersion;
  }

  const box = $("console-update-box");
  if (!upd) {
    box.innerHTML = '<div>当前版本 <strong>v' + escapeHtml(curVer) + '</strong>，点击下方按钮即可从 GitHub Releases 检查最新更新。</div>';
    return;
  }
  const relUrl = upd.releaseUrl || upd.releasesUrl || fallbackRel;
  if (!upd.ok) {
    box.innerHTML = `
      <div class="console-update-title is-err">检查更新暂未连通</div>
      <div style="margin-top:3px;">${escapeHtml(upd.error || "更新检查暂不可用")}</div>
      <div class="console-update-actions">
        <a class="btn-soft" style="text-decoration:none;" href="${escapeHtml(relUrl)}" target="_blank" rel="noopener">前往 Releases 页 ↗</a>
      </div>`;
    return;
  }

  const dateStr = upd.publishedAt ? String(upd.publishedAt).slice(0, 10) : "";
  const srcNote = upd.source === "github_atom" ? " · Atom 源" : "";
  if (upd.updateAvailable) {
    const ignoredTag = upd.isIgnored ? '<span class="role-tag">已忽略此版本</span>' : "";
    const notesHtml = upd.bodySnippet ? `<div class="console-update-notes">${escapeHtml(upd.bodySnippet)}</div>` : "";
    const zipBtn = upd.zipDownloadUrl
      ? `<a class="btn-soft" style="text-decoration:none;" href="${escapeHtml(upd.zipDownloadUrl)}" target="_blank" rel="noopener">下载插件 ZIP</a>`
      : "";
    const ignoreBtn = upd.isIgnored
      ? `<button type="button" class="btn-soft" data-console-upd="unignore">取消忽略</button>`
      : `<button type="button" class="btn-soft" data-console-upd="ignore" data-ver="${escapeHtml(upd.latestVersion)}">忽略此版本</button>`;
    box.innerHTML = `
      <div class="console-update-title has-new">发现新版本 v${escapeHtml(upd.latestVersion)}${ignoredTag}</div>
      <div style="color:var(--muted);margin-top:2px;">当前 v${escapeHtml(curVer)}${dateStr ? " · 发布于 " + escapeHtml(dateStr) : ""}${srcNote}</div>
      ${notesHtml}
      <div class="console-update-actions">
        <a class="ext-btn-primary" href="${escapeHtml(relUrl)}" target="_blank" rel="noopener">前往下载 v${escapeHtml(upd.latestVersion)} ↗</a>
        ${zipBtn}
        <button type="button" class="btn-soft" data-console-upd="copy" data-url="${escapeHtml(relUrl)}">复制链接</button>
        ${ignoreBtn}
      </div>`;
    return;
  }

  const sameTag = String(upd.latestVersion || "") === curVer;
  const subInfo = sameTag
    ? (dateStr ? `最新 Release 发布于 ${escapeHtml(dateStr)}` : "与 GitHub 最新版本一致")
    : `GitHub 最新 Release 为 v${escapeHtml(upd.latestVersion)}${dateStr ? " · " + escapeHtml(dateStr) : ""}`;
  box.innerHTML = `
    <div class="console-update-title">已是最新版本 v${escapeHtml(curVer)}</div>
    <div style="color:var(--muted);margin-top:2px;">${subInfo}${srcNote}</div>
    <div class="console-update-actions">
      <a class="btn-soft" style="text-decoration:none;" href="${escapeHtml(relUrl)}" target="_blank" rel="noopener">查看更新日志 ↗</a>
    </div>`;
}

async function loadConsoleUpdateStatus() {
  try {
    const res = await api("/api/update/status");
    currentUpdateMeta = res.meta || null;
    currentUpdateInfo = res.update || null;
    consoleAutoCheckUpdates = res.autoCheckUpdates !== false;
    renderConsoleUpdateUi();
    if (!consoleStartupUpdateChecked) {
      consoleStartupUpdateChecked = true;
      if (consoleAutoCheckUpdates) {
        setTimeout(() => {
          void checkConsoleUpdates(false);
        }, 2000);
      }
    }
  } catch {}
}

async function checkConsoleUpdates(force = false) {
  const btn = $("btn-console-check-update");
  if (force && btn) {
    btn.disabled = true;
    btn.textContent = "检查中…";
  }
  try {
    const res = force
      ? await fetch("/api/update/check", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(consoleToken ? { "X-Console-Token": consoleToken } : {}) },
          body: JSON.stringify({ force: true }),
        }).then((r) => r.json())
      : await fetch("/api/update/check").then((r) => r.json());
    if (res && typeof res === "object") {
      currentUpdateInfo = res;
      renderConsoleUpdateUi();
      if (force) {
        if (!res.ok) showToast(res.error || "更新检查未连通");
        else if (res.updateAvailable) showToast("发现新版本 v" + res.latestVersion);
        else showToast("当前已是最新版本 v" + (res.currentVersion || currentUpdateMeta?.version || "1.6.0"));
      }
    }
  } catch (err) {
    if (force) showToast("检查更新失败：" + err.message);
  } finally {
    if (force && btn) {
      btn.disabled = false;
      btn.textContent = "立即检查更新";
    }
  }
}

$("btn-console-update-pill").addEventListener("click", () => {
  const settingsBtn = document.querySelector('.index-tab[data-tab="settings"]');
  if (settingsBtn) settingsBtn.click();
  $("console-update-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
});

$("btn-console-check-update").addEventListener("click", () => {
  void checkConsoleUpdates(true);
});

$("chk-console-auto-update").addEventListener("change", async (e) => {
  const checked = Boolean(e.currentTarget.checked);
  try {
    await api("/api/update/settings", { method: "POST", body: JSON.stringify({ autoCheckUpdates: checked }) });
    consoleAutoCheckUpdates = checked;
    showToast(checked ? "已开启启动时静默检查更新" : "已关闭启动时自动检查更新");
  } catch (err) {
    showToast(err.message);
  }
});

$("console-update-box").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-console-upd]");
  if (!btn) return;
  const act = btn.dataset.consoleUpd;
  if (act === "copy") {
    await navigator.clipboard?.writeText(btn.dataset.url || "").catch(() => {});
    showToast("已复制 GitHub Releases 链接");
  } else if (act === "ignore") {
    const ver = btn.dataset.ver || currentUpdateInfo?.latestVersion || "";
    try {
      const res = await api("/api/update/ignore", { method: "POST", body: JSON.stringify({ version: ver }) });
      if (res.update) currentUpdateInfo = res.update;
      renderConsoleUpdateUi();
      showToast(`已忽略 v${ver}，更高版本发布时将恢复提醒`);
    } catch (err) {
      showToast(err.message);
    }
  } else if (act === "unignore") {
    try {
      const res = await api("/api/update/ignore", { method: "POST", body: JSON.stringify({ version: "" }) });
      if (res.update) currentUpdateInfo = res.update;
      renderConsoleUpdateUi();
      showToast("已恢复新版本更新提醒");
    } catch (err) {
      showToast(err.message);
    }
  }
});

refreshAll();
loadConsoleUpdateStatus();
setInterval(refreshAll, 45000);
