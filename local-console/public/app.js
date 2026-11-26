const $ = (id) => document.getElementById(id);
const yuan = (fen) => "¥" + ((Number(fen) || 0) / 100).toFixed(2);
const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) + "%" : "--");

let currentDash = null;
let currentConsoleCfg = null;
let activeTopupMemberId = null;
let activeInviteInfo = null;
let expandedMemberIds = new Set();

function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3000);
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
  const resp = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
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
      const gPct = (m.week?.geminiPct || 0).toFixed(1);
      const pPct = (m.week?.thirdPartyPct || 0).toFixed(1);
      const weekTotalCost = (m.week?.geminiChargeFen || 0) + (m.week?.thirdPartyChargeFen || 0);
      const lowCls = prepaid && !isOwner && m.isLowBalance ? "low-bal" : "";

      let rightMetricHtml = "";
      if (prepaid) {
        rightMetricHtml = isOwner
          ? `<div class="balance-amt">Gemini ${gPct}% · 3P ${pPct}%</div><div class="balance-cap">组长免计费</div>`
          : `<div class="balance-amt ${m.isLowBalance ? "low" : ""}">${yuan(m.balanceFen)}</div><div class="balance-cap">近 7 天 ${yuan(weekTotalCost)}</div>`;
      } else {
        rightMetricHtml = `<div class="balance-amt">Gemini ${gPct}% · 3P ${pPct}%</div><div class="balance-cap">近 7 天用量占比</div>`;
      }

      // 单行按钮严格控制在 <= 2 个
      let quickOpsHtml = "";
      if (isOwner) {
        quickOpsHtml = `<button class="btn-soft" data-op="install-owner">装到本机</button>`;
      } else if (prepaid) {
        quickOpsHtml = `
          <button class="btn-soft" data-op="topup" data-id="${escapeHtml(m.id)}">记录余额</button>
          <button class="btn-soft" data-op="invite" data-id="${escapeHtml(m.id)}">邀请绑定</button>
        `;
      } else {
        quickOpsHtml = `<button class="btn-soft" data-op="invite" data-id="${escapeHtml(m.id)}">邀请绑定</button>`;
      }

      return `
        <article class="member-card ${lowCls} ${isOpen ? "open" : ""}" data-member-id="${escapeHtml(m.id)}">
          <div class="member-row" data-toggle-member="${escapeHtml(m.id)}">
            <div class="member-left">
              <span class="presence-dot ${m.online ? "on" : ""}" title="${m.online ? "插件在线" : "未在线"}"></span>
              <div class="member-ident">
                <div class="member-name-line">
                  <span>${escapeHtml(m.name)}</span>
                  ${isOwner ? '<span class="role-tag">组长</span>' : ""}
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
                <div class="dk">近 7 天 Gemini 占比</div>
                <div class="dv">${gPct}%${prepaid && !isOwner ? "（" + yuan(m.week?.geminiChargeFen) + "）" : ""}</div>
              </div>
              <div class="drawer-cell">
                <div class="dk">近 7 天 Claude 3P 占比</div>
                <div class="dv">${pPct}%${prepaid && !isOwner ? "（" + yuan(m.week?.thirdPartyChargeFen) + "）" : ""}</div>
              </div>
              <div class="drawer-cell">
                <div class="dk">近 7 天请求 / Token</div>
                <div class="dv">${m.requests7d || 0} 次 · ${((m.tokens7d || 0) / 10000).toFixed(1)} 万</div>
              </div>
            </div>
            <div class="drawer-token-bar">
              <span class="token-code">成员凭证：${escapeHtml(m.memberToken.slice(0, 10))}••••</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="btn-soft" data-op="invite" data-id="${escapeHtml(m.id)}">查看完整绑定码</button>
                ${!isOwner ? `<button class="btn-danger-soft" data-op="delete" data-id="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}">删除成员</button>` : ""}
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
}

function updatePricePreview() {
  const gemYuan = Math.max(0, Number($("set-gem-price").value) || 0);
  const p3Yuan = Math.max(0, Number($("set-3p-price").value) || 0);
  $("price-preview-line").textContent =
    `按当前单价：Gemini 消耗 5% 约 ¥${(gemYuan * 5).toFixed(2)}，Claude 3P 消耗 5% 约 ¥${(p3Yuan * 5).toFixed(2)}`;
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

  const sum = dash.summary || {};
  $("kpi-online").textContent = `${sum.onlineCount || 0} / ${sum.memberCount || 0}`;
  if (prepaid) {
    $("kpi-col2-label").textContent = "近 7 天合计扣费";
    $("kpi-col2-val").textContent = yuan(sum.totalWeekChargeFen || 0);
    $("kpi-col3-label").textContent = "累计收到预存";
    $("kpi-col3-val").textContent = yuan(sum.totalTopupFen || 0);
    $("kpi-col3-val").className = "kpi-value positive";
  } else {
    $("kpi-col2-label").textContent = "近 7 天 Gemini 已用";
    $("kpi-col2-val").textContent = Number(sum.totalWeekGeminiPct || 0).toFixed(1) + "%";
    $("kpi-col3-label").textContent = "近 7 天 Claude 已用";
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

  // 回填设置页
  $("set-family-name").value = s.family_name || "";
  const modeVal = s.ledger_mode === "prepaid" ? "prepaid" : "board_only";
  for (const r of document.querySelectorAll('input[name="ledger-mode"]')) {
    r.checked = r.value === modeVal;
  }
  $("set-owner-only-quota").checked = (s.quota_snapshot_authority || "owner_only") !== "all_members";
  $("set-show-peers").checked = s.show_peer_shares_to_members !== false;
  $("set-gem-price").value = ((Number(s.gemini_fen_per_weekly_pct) || 100) / 100).toFixed(2);
  $("set-3p-price").value = ((Number(s.third_party_fen_per_weekly_pct) || 180) / 100).toFixed(2);
  $("set-warn-pct").value = Number(s.blackhole_warn_missing_pct) || 5;
  $("set-crit-pct").value = Number(s.blackhole_critical_missing_pct) || 15;
  updatePricePreview();
  syncSettingsFormVisibility();
}

function applyConsoleConfig(cfg) {
  currentConsoleCfg = cfg;
  const badge = $("hdr-storage-badge");
  const isCloud = cfg.mode === "cloud";
  badge.textContent = isCloud ? "Cloudflare 云端同步" : "本机离线存储";
  badge.className = "status-stamp" + (isCloud ? " cloud" : "");
  $("btn-demo-seed").hidden = isCloud;

  for (const r of document.querySelectorAll('input[name="console-mode"]')) {
    r.checked = r.value === cfg.mode;
  }
  $("cfg-worker-url").value = cfg.cloudWorkerUrl || "";
  $("local-push-row").hidden = !(cfg.hasLocalPushConfig || cfg.enableQqAlertForward);
  $("cfg-qq-forward").checked = Boolean(cfg.enableQqAlertForward);
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
    $("inv-market-cmd").textContent = info.marketCmd;
    $("inv-code-text").textContent = info.inviteCode;
    $("inv-releases-link").href = info.releasesUrl;
    $("invite-local-warn").hidden = !info.isLocalOnly;
    $("modal-invite").hidden = false;
  } catch (err) {
    showToast(err.message);
  }
}

function buildPlainInviteMessage(info) {
  return [
    `家庭组额度看板插件已公开在 GitHub，直接从官方仓库安装即可（不用传压缩包）：`,
    `仓库与安装说明：${info.repoUrl}`,
    `如已安装 AGY Market，可直接运行：${info.marketCmd}`,
    `也可在 Releases 下载自动打包版：${info.releasesUrl}`,
    ``,
    `装好后打开 Antigravity 右侧边栏「家庭组额度看板」，粘贴下面这一行绑定码即可连接：`,
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

document.querySelectorAll('input[name="ledger-mode"], input[name="console-mode"]').forEach((el) => {
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
      await api(`/api/admin/alerts/${encodeURIComponent(ackBtn.dataset.ackAlert)}/ack`, { method: "POST" });
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
    } else if (op === "topup") {
      const m = (currentDash?.members || []).find((x) => x.id === id);
      if (!m) return;
      activeTopupMemberId = id;
      $("topup-member-name").textContent = m.name;
      $("topup-current-bal").textContent = yuan(m.balanceFen);
      $("topup-yuan").value = "10";
      $("topup-note").value = "补充预存余额";
      $("modal-topup").hidden = false;
    } else if (op === "delete") {
      if (!confirm(`确认从看板中删除「${opBtn.dataset.name}」吗？（不会影响 Google 家庭组本身）`)) return;
      try {
        await api(`/api/admin/members/${encodeURIComponent(id)}`, { method: "DELETE" });
        showToast("已删除该成员");
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

document.querySelectorAll(".quick-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    $("topup-yuan").value = chip.dataset.yuan;
  });
});

$("btn-open-add-member").addEventListener("click", () => {
  $("add-name").value = "";
  $("add-note").value = "";
  $("add-prepaid-fields").hidden = !isPrepaidMode();
  $("modal-add-member").hidden = false;
  $("add-name").focus();
});

$("btn-confirm-add-member").addEventListener("click", async () => {
  const name = $("add-name").value.trim();
  if (!name) return showToast("请先填写成员称呼");
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
      }),
    });
    $("modal-add-member").hidden = true;
    await refreshAll();
    if (out.member?.id) {
      await openInviteModal(out.member.id);
    }
  } catch (err) {
    showToast(err.message);
  }
});

$("btn-copy-market-cmd").addEventListener("click", async () => {
  if (!activeInviteInfo) return;
  await navigator.clipboard?.writeText(activeInviteInfo.marketCmd).catch(() => {});
  showToast("已复制安装命令");
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
        gemini_fen_per_weekly_pct: Math.round((Number($("set-gem-price").value) || 1) * 100),
        third_party_fen_per_weekly_pct: Math.round((Number($("set-3p-price").value) || 1.8) * 100),
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
        enableQqAlertForward: $("cfg-qq-forward").checked,
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
    const out = await api("/api/install-owner-local", { method: "POST" });
    showToast(`组长插件已同步到本机（${out.memberName}）`);
  } catch (err) {
    showToast("安装失败：" + err.message);
  }
}

$("btn-install-owner-settings").addEventListener("click", handleInstallOwner);
$("btn-refresh").addEventListener("click", refreshAll);

$("btn-demo-seed").addEventListener("click", async () => {
  try {
    const out = await api("/api/demo/seed", { method: "POST" });
    showToast(out.message || "已填充示例数据");
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

refreshAll();
