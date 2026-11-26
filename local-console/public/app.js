const $ = (id) => document.getElementById(id);
const yuan = (fen) => "¥" + ((Number(fen) || 0) / 100).toFixed(2);
const pct = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) + "%" : "--");

let currentDash = null;
let currentConsoleCfg = null;
let activeTopupMemberId = null;
let expandedMemberIds = new Set();

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
  if (!iso) return "从未同步";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtReset(iso) {
  if (!iso) return "等待成员插件上报重置时间";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "重置时间待更新";
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

function renderMemberList(containerId, members) {
  const el = $(containerId);
  if (!members || members.length === 0) {
    el.innerHTML = '<div class="empty-box">暂无家庭组成员，点击右上角「新增熟人」即可建档并生成专属安装袋。</div>';
    return;
  }

  el.innerHTML = members
    .map((m) => {
      const isOpen = expandedMemberIds.has(m.id);
      const isOwner = m.role === "owner";
      const weekTotalCost = (m.week?.geminiChargeFen || 0) + (m.week?.thirdPartyChargeFen || 0);
      const lowCls = !isOwner && m.isLowBalance ? "low-bal" : "";
      const balHtml = isOwner
        ? '<div class="balance-amt">免扣费</div><div class="balance-cap">组长占比</div>'
        : `<div class="balance-amt ${m.isLowBalance ? "low" : ""}">${yuan(m.balanceFen)}</div><div class="balance-cap">本周 ${yuan(weekTotalCost)}</div>`;

      return `
        <article class="member-card ${lowCls} ${isOpen ? "open" : ""}" data-member-id="${escapeHtml(m.id)}">
          <div class="member-row" data-toggle-member="${escapeHtml(m.id)}">
            <div class="member-left">
              <span class="presence-dot ${m.online ? "on" : ""}" title="${m.online ? "插件在线" : "暂未在线"}"></span>
              <div class="member-ident">
                <div class="member-name-line">
                  <span>${escapeHtml(m.name)}</span>
                  ${isOwner ? '<span class="role-tag">组长</span>' : ""}
                </div>
                <div class="member-sub">
                  Gemini ${(m.week?.geminiPct || 0).toFixed(2)}% · 3P ${(m.week?.thirdPartyPct || 0).toFixed(2)}% · 最近同步 ${fmtTime(m.lastSeenAt)}
                </div>
              </div>
            </div>
            <div class="member-right">
              <div class="balance-block">${balHtml}</div>
              <div class="member-quick-ops">
                ${isOwner ? `<button class="btn-soft" data-op="install-owner">装到本机</button>` : `<button class="btn-soft" data-op="topup" data-id="${escapeHtml(m.id)}">记充值</button>`}
                <button class="btn-soft" data-op="export" data-id="${escapeHtml(m.id)}">安装袋</button>
              </div>
            </div>
          </div>

          <div class="member-drawer">
            <div class="drawer-grid">
              <div class="drawer-cell">
                <div class="dk">本周 Gemini 周池归账</div>
                <div class="dv">${(m.week?.geminiPct || 0).toFixed(2)}%（${isOwner ? "组长免扣" : yuan(m.week?.geminiChargeFen)}）</div>
              </div>
              <div class="drawer-cell">
                <div class="dk">本周 Claude 3P 归账</div>
                <div class="dv">${(m.week?.thirdPartyPct || 0).toFixed(2)}%（${isOwner ? "组长免扣" : yuan(m.week?.thirdPartyChargeFen)}）</div>
              </div>
              <div class="drawer-cell">
                <div class="dk">近 7 天上报请求 / Token</div>
                <div class="dv">${m.requests7d || 0} 次 · ${((m.tokens7d || 0) / 10000).toFixed(1)} 万</div>
              </div>
            </div>
            ${m.note ? `<div style="margin-bottom:8px;color:var(--ink-soft);">备注：${escapeHtml(m.note)}</div>` : ""}
            <div class="drawer-token-bar">
              <span class="token-code">成员码：${escapeHtml(m.memberToken)}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="btn-soft" data-op="copy-token" data-token="${escapeHtml(m.memberToken)}">复制成员码</button>
                ${!isOwner ? `<button class="btn-danger-soft" data-op="delete" data-id="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}">移除档案</button>` : ""}
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderActivityFeed(dash) {
  const items = [];
  for (const t of (dash.recentTransactions || []).slice(0, 8)) {
    items.push({
      ts: Date.parse(t.created_at) || 0,
      title: `${t.member_name || t.member_id} · ${t.kind === "topup" ? "预存充值" : "账目调整"}`,
      meta: `${fmtTime(t.created_at)}${t.note ? " · " + t.note : ""}`,
      amt: (t.amount_fen >= 0 ? "+" : "") + yuan(t.amount_fen),
      cls: t.amount_fen >= 0 ? "pos" : "neg",
    });
  }
  for (const a of (dash.recentAllocations || []).slice(0, 10)) {
    const poolText = a.pool_key === "3p" ? "Claude 3P" : "Gemini";
    items.push({
      ts: a.slice_start_ms || Date.parse(a.created_at) || 0,
      title: `${a.member_name || a.member_id} · 分摊 ${poolText} ${Number(a.attributed_pct || 0).toFixed(2)}%`,
      meta: `${fmtTime(a.created_at)} · 当次总池掉 ${Number(a.pool_drop_pct || 0).toFixed(2)}%（占 ${(Number(a.member_share_ratio || 0) * 100).toFixed(0)}%）`,
      amt: a.charge_fen > 0 ? "-" + yuan(a.charge_fen) : "记占比",
      cls: "neg",
    });
  }
  items.sort((a, b) => b.ts - a.ts);

  const el = $("ov-activity-feed");
  if (items.length === 0) {
    el.innerHTML = '<div class="empty-box">尚无拆账或充值记录。可点击右上角「演练拆账」先预览多人并发分账效果。</div>';
    return;
  }
  el.innerHTML = items
    .slice(0, 7)
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
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px;">暂无充值或调账流水</td></tr>';
    return;
  }
  body.innerHTML = txs
    .map(
      (t) => `
      <tr>
        <td>${fmtTime(t.created_at)}</td>
        <td>${escapeHtml(t.member_name || t.member_id)}</td>
        <td>${t.kind === "topup" ? "预存充值" : t.kind === "refund" ? "退款" : "调整"}</td>
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
    el.innerHTML = '<div class="empty-box">目前全组账目守恒正常，没有待核对的未上报黑洞或低余额提醒。</div>';
    return;
  }
  el.innerHTML = alerts
    .map(
      (a) => `
      <article class="alert-card ${escapeHtml(a.severity)} ${a.acknowledged ? "acked" : ""}">
        <div style="min-width:0;flex:1;">
          <div class="alert-title">${escapeHtml(a.title)}</div>
          <div class="alert-detail">${escapeHtml(a.detail)}</div>
          <div class="alert-time">${fmtTime(a.created_at)}${a.acknowledged ? " · 已核对归档" : ""}</div>
        </div>
        ${!a.acknowledged ? `<button class="btn-ghost" data-ack-alert="${escapeHtml(a.id)}">已知悉归档</button>` : ""}
      </article>`
    )
    .join("");
}

function updatePricePreview() {
  const gemYuan = Math.max(0, Number($("set-gem-price").value) || 0);
  const p3Yuan = Math.max(0, Number($("set-3p-price").value) || 0);
  $("prev-gem-3").textContent = "¥" + (gemYuan * 3).toFixed(2);
  $("prev-gem-10").textContent = "¥" + (gemYuan * 10).toFixed(2);
  $("prev-gem-100").textContent = "¥" + (gemYuan * 100).toFixed(2);
  $("prev-3p-3").textContent = "¥" + (p3Yuan * 3).toFixed(2);
  $("prev-3p-10").textContent = "¥" + (p3Yuan * 10).toFixed(2);
  $("prev-gem-month").textContent = "¥" + (gemYuan * 100 * 4.3).toFixed(0);
}

function applyDashboard(dash) {
  currentDash = dash;
  const s = dash.settings || {};
  $("hdr-family-name").textContent = s.family_name || "Ultra 20x 熟人家庭组";
  $("hdr-dry-badge").hidden = !s.calibration_dry_run;
  $("hdr-sync-time").textContent = "最后刷新：" + fmtTime(dash.serverTimeIso);

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
  $("kpi-week-charge").textContent = yuan(sum.totalWeekChargeFen || 0);
  $("kpi-total-topup").textContent = yuan(sum.totalTopupFen || 0);
  const kpiAlert = $("kpi-alerts");
  kpiAlert.textContent = `${sum.unackedAlertCount || 0} 条`;
  kpiAlert.className = "kpi-value" + ((sum.criticalAlertCount || 0) > 0 ? " danger" : "");

  const navBadge = $("nav-alert-count");
  navBadge.textContent = String(sum.unackedAlertCount || 0);
  navBadge.hidden = !(sum.unackedAlertCount > 0);

  renderMemberList("ov-member-list", dash.members || []);
  renderMemberList("full-member-list", dash.members || []);
  renderActivityFeed(dash);
  renderTxTable(dash.recentTransactions || []);
  renderAlerts(dash.alerts || []);

  // 回填设置表单
  $("set-family-name").value = s.family_name || "";
  $("set-dry-run").checked = Boolean(s.calibration_dry_run);
  $("set-owner-only-quota").checked = (s.quota_snapshot_authority || "owner_only") !== "all_members";
  $("set-gem-price").value = ((Number(s.gemini_fen_per_weekly_pct) || 100) / 100).toFixed(2);
  $("set-3p-price").value = ((Number(s.third_party_fen_per_weekly_pct) || 180) / 100).toFixed(2);
  $("set-warn-pct").value = Number(s.blackhole_warn_missing_pct) || 5;
  $("set-crit-pct").value = Number(s.blackhole_critical_missing_pct) || 15;
  updatePricePreview();
}

function applyConsoleConfig(cfg) {
  currentConsoleCfg = cfg;
  const badge = $("hdr-mode-badge");
  const isCloud = cfg.mode === "cloud";
  badge.textContent = isCloud ? "Cloudflare 云端同步中" : "本地体验模式";
  badge.className = "status-stamp" + (isCloud ? " cloud" : "");
  $("btn-demo-seed").hidden = isCloud;

  for (const r of document.querySelectorAll('input[name="console-mode"]')) {
    r.checked = r.value === cfg.mode;
  }
  $("cfg-worker-url").value = cfg.cloudWorkerUrl || "";
  $("cfg-qq-forward").checked = Boolean(cfg.enableQqAlertForward);
}

async function refreshAll() {
  try {
    const cfgRes = await api("/api/console-config");
    applyConsoleConfig(cfgRes.config);
    const dash = await api("/api/admin/dashboard");
    applyDashboard(dash);
  } catch (err) {
    showToast("读取账本失败：" + err.message);
  }
}

// 折签切换
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

// 弹窗关闭
document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $(btn.dataset.closeModal).hidden = true;
  });
});

// 委托处理成员列表动作
document.addEventListener("click", async (e) => {
  const ackBtn = e.target.closest("[data-ack-alert]");
  if (ackBtn) {
    try {
      await api(`/api/admin/alerts/${encodeURIComponent(ackBtn.dataset.ackAlert)}/ack`, { method: "POST" });
      showToast("该条异常记录已归档");
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
      return;
    } else if (op === "topup") {
      const m = (currentDash?.members || []).find((x) => x.id === id);
      if (!m) return;
      activeTopupMemberId = id;
      $("topup-member-name").textContent = m.name;
      $("topup-current-bal").textContent = yuan(m.balanceFen);
      $("topup-yuan").value = "5";
      $("topup-note").value = "微信转账小额预存";
      $("modal-topup").hidden = false;
    } else if (op === "export") {
      try {
        showToast("正在打包熟人专属安装袋…");
        const out = await api(`/api/export-bundle/${encodeURIComponent(id)}`, { method: "POST" });
        showToast(`已生成 ${out.fileName}${out.isLocalPreviewUrl ? "（当前为本地体验地址，部署云端后可重新导出）" : ""}`);
      } catch (err) {
        showToast("导出失败：" + err.message);
      }
    } else if (op === "copy-token") {
      await navigator.clipboard?.writeText(opBtn.dataset.token || "").catch(() => {});
      showToast("已复制专属成员码");
    } else if (op === "delete") {
      if (!confirm(`确认从账本中移除「${opBtn.dataset.name}」的档案与流水吗？（不会影响 Google 家庭组本身）`)) return;
      try {
        await api(`/api/admin/members/${encodeURIComponent(id)}`, { method: "DELETE" });
        showToast("已移除该成员档案");
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

// 快捷金额点选
document.querySelectorAll(".quick-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    $("topup-yuan").value = chip.dataset.yuan;
  });
});

$("btn-open-add-member").addEventListener("click", () => {
  $("add-name").value = "";
  $("add-note").value = "";
  $("modal-add-member").hidden = false;
  $("add-name").focus();
});

$("btn-confirm-add-member").addEventListener("click", async () => {
  const name = $("add-name").value.trim();
  if (!name) return showToast("请先填写熟人称呼");
  try {
    await api("/api/admin/members", {
      method: "POST",
      body: JSON.stringify({
        name,
        role: "member",
        initialBalanceFen: Math.round((Number($("add-init-yuan").value) || 0) * 100),
        lowBalanceFen: Math.round((Number($("add-low-yuan").value) || 2) * 100),
        note: $("add-note").value.trim(),
      }),
    });
    $("modal-add-member").hidden = true;
    showToast(`已为「${name}」建档并生成专属成员码`);
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
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
    showToast(`记账成功（${amountFen > 0 ? "+" : ""}${yuan(amountFen)}）`);
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

$("set-gem-price").addEventListener("input", updatePricePreview);
$("set-3p-price").addEventListener("input", updatePricePreview);

$("btn-save-settings").addEventListener("click", async () => {
  try {
    await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({
        family_name: $("set-family-name").value.trim() || "Ultra 20x 熟人家庭组",
        calibration_dry_run: $("set-dry-run").checked,
        quota_snapshot_authority: $("set-owner-only-quota").checked ? "owner_only" : "all_members",
        gemini_fen_per_weekly_pct: Math.round((Number($("set-gem-price").value) || 1) * 100),
        third_party_fen_per_weekly_pct: Math.round((Number($("set-3p-price").value) || 1.8) * 100),
        blackhole_warn_missing_pct: Number($("set-warn-pct").value) || 5,
        blackhole_critical_missing_pct: Number($("set-crit-pct").value) || 15,
      }),
    });
    showToast("账本单价与预警规则已保存");
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
    showToast("连接设置已更新");
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

async function handleInstallOwner() {
  try {
    const out = await api("/api/install-owner-local", { method: "POST" });
    showToast(`已将组长插件安装到本机 Antigravity，请在「自定义扩展」启用`);
    console.log("Installed owner plugin:", out);
  } catch (err) {
    showToast("安装失败：" + err.message);
  }
}

$("btn-install-owner-quick").addEventListener("click", handleInstallOwner);
$("btn-install-owner-settings").addEventListener("click", handleInstallOwner);
$("btn-open-exports").addEventListener("click", () => api("/api/open-exports", { method: "POST" }).catch(() => {}));
$("btn-refresh").addEventListener("click", refreshAll);

$("btn-demo-seed").addEventListener("click", async () => {
  try {
    const out = await api("/api/demo/seed", { method: "POST" });
    showToast(out.message || "已生成本地演练数据");
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  }
});

refreshAll();
setInterval(refreshAll, 45000);
