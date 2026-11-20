/* RiskLedger – SLA management front end. Talks to /api/sla/* (see server/sla.js).
   If the API is unreachable it runs in demo mode with example contracts. */
(function () {
  "use strict";
  const EMBED = new URLSearchParams(location.search).get("embed") === "1" && window.parent !== window;
  if (EMBED) document.documentElement.classList.add("embed");
  const notifyParent = () => { if (EMBED) window.parent.postMessage({ type: "sla-changed" }, location.origin); };
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const addMonths = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
  const diffDays = (a, b) => Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 86400000);
  const fmt = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
  const FREQ = { 0: "Not required", 1: "Monthly", 3: "Quarterly", 6: "Every 6 months", 12: "Yearly", 24: "Every 2 years" };
  const OUTCOMES = ["Satisfactory", "Needs improvement", "Unsatisfactory", "Terminate / do not renew"];
  const DAY_CHOICES = [180, 120, 90, 60, 30, 14, 7, 1];

  function toast(msg) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }

  /* ---------------- data layer ---------------- */
  async function api(method, path, body, headers) {
    const opt = { method, credentials: "same-origin", headers: { ...(headers || {}) } };
    if (body instanceof Blob || body instanceof ArrayBuffer) opt.body = body;
    else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
    const res = await fetch("/api/sla" + path, opt);
    if (res.status === 401) { (EMBED ? window.top : window).location.href = "/login.html"; throw new Error("Signed out"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.errors && data.errors.join(" ")) || data.error || data.message || res.statusText);
    return data;
  }
  const live = {
    list: () => api("GET", "/contracts"),
    create: (c) => api("POST", "/contracts", c),
    update: (id, c) => api("PUT", "/contracts/" + id, c),
    remove: (id) => api("DELETE", "/contracts/" + id),
    upload: (id, file) => api("POST", `/contracts/${id}/files`, file, { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) }),
    removeFile: (fid) => api("DELETE", "/files/" + fid),
    fileUrl: (fid) => "/api/sla/files/" + fid,
    reviews: (id) => api("GET", `/contracts/${id}/reviews`),
    addReview: (id, r) => api("POST", `/contracts/${id}/reviews`, r),
    notifications: () => api("GET", "/notifications"),
    settings: () => api("GET", "/settings"),
    saveSettings: (s) => api("PUT", "/settings", s),
    testEmail: (to) => api("POST", "/settings/test", { to }),
    runNow: () => api("POST", "/run-reminders"),
  };

  // Demo store: same shape as the API, kept in memory only.
  function makeDemo() {
    const t = today();
    let seq = 0, fseq = 0, rseq = 0;
    const mk = (title, vendor, service, owner, start, end, value, months, last, emails, extra = {}) => ({
      id: ++seq, ref: "SLA-" + String(seq).padStart(3, "0"), title, vendor, service, owner, startDate: start, endDate: end,
      value, currency: "PKR", autoRenew: false, reminderDays: [90, 60, 30, 7], reviewMonths: months, lastReview: last,
      status: "active", notes: "", notifyEmails: emails, files: [], ...extra,
    });
    const C = [
      mk("Microsoft 365 E3 licensing", "Microsoft (via CSP partner)", "Office 365 licences", "IT Manager", addDays(t, -340), addDays(t, 25), 4800000, 12, addDays(t, -300), "it.manager@example.com", { files: [{ id: ++fseq, filename: "M365-CSP-Agreement.pdf", size: 812000 }] }),
      mk("Internet leased line – head office", "Example ISP", "100 Mbps DIA + backup", "Network Administrator", addDays(t, -300), addDays(t, 65), 2100000, 6, addDays(t, -200), "network@example.com"),
      mk("Kaspersky EDR Optimum", "Security vendor", "Endpoint protection, 600 seats", "InfoSec Officer", addDays(t, -30), addDays(t, 335), 3500000, 3, null, "infosec@example.com", { files: [{ id: ++fseq, filename: "EDR-SLA-Schedule.pdf", size: 402000 }] }),
      mk("Oracle EBS support", "Oracle partner", "L2/L3 application support", "ERP Lead", addDays(t, -700), addDays(t, 30 + 365), 6200000, 12, addDays(t, -420), "erp@example.com"),
      mk("FortiGate FortiCare & UTM bundle", "Fortinet partner", "Firewall support and subscriptions", "Network Administrator", addDays(t, -358), addDays(t, 6), 1450000, 12, addDays(t, -380), "network@example.com", { autoRenew: true }),
      mk("Printer fleet managed service", "Print services vendor", "MFP lease + maintenance", "IT Support Lead", addDays(t, -800), addDays(t, -12), 900000, 6, addDays(t, -250), "support@example.com"),
      mk("Data centre co-location", "DC provider", "2 racks, power and cooling", "IT Infrastructure Lead", addDays(t, -150), addDays(t, 215), 5400000, 3, addDays(t, -95), "infra@example.com"),
      mk("Ruckus Wi-Fi support", "Ruckus partner", "Access point and ZoneDirector support", "Network Administrator", addDays(t, -200), addDays(t, 120), 650000, 12, null, "network@example.com"),
    ];
    const R = { 1: [{ id: ++rseq, reviewDate: addDays(t, -300), reviewer: "IT Manager", outcome: "Satisfactory", notes: "Licence count matched usage." }] };
    const N = [
      { id: 1, ref: "SLA-005", title: "FortiGate FortiCare & UTM bundle", kind: "expiry", milestone: "7", recipients: "network@example.com", subject: "[SLA SLA-005] FortiGate FortiCare & UTM bundle – expires in 7 days", status: "sent", sentAt: addDays(t, -1) + "T09:00:00Z" },
      { id: 2, ref: "SLA-001", title: "Microsoft 365 E3 licensing", kind: "expiry", milestone: "30", recipients: "it.manager@example.com", subject: "[SLA SLA-001] Microsoft 365 E3 licensing – expires in 30 days", status: "sent", sentAt: addDays(t, -5) + "T09:00:00Z" },
    ];
    const enrich = (c) => ({ ...c, daysLeft: diffDays(c.endDate, t), nextReview: c.reviewMonths ? addMonths(c.lastReview || c.startDate, c.reviewMonths) : null });
    let S = { smtpHost: "smtp.office365.com", smtpPort: 587, smtpUser: "", smtpPassSet: false, mailFrom: "", defaultRecipients: "", appUrl: "", timeZone: "Asia/Karachi", sendHour: 9, reviewLeadDays: 14, enabled: true };
    const ok = (v) => Promise.resolve(v);
    return {
      list: () => ok(C.map(enrich).sort((a, b) => a.endDate.localeCompare(b.endDate))),
      create: (c) => { const n = { ...c, id: ++seq, ref: "SLA-" + String(seq).padStart(3, "0"), files: [] }; C.push(n); return ok(n); },
      update: (id, c) => { const i = C.findIndex((x) => x.id === id); C[i] = { ...C[i], ...c }; return ok({ ok: true }); },
      remove: (id) => { C.splice(C.findIndex((x) => x.id === id), 1); return ok({ ok: true }); },
      upload: (id, f) => { C.find((x) => x.id === id).files.unshift({ id: ++fseq, filename: f.name, size: f.size }); return ok({}); },
      removeFile: (fid) => { C.forEach((c) => (c.files = c.files.filter((f) => f.id !== fid))); return ok({}); },
      fileUrl: () => null,
      reviews: (id) => ok(R[id] || []),
      addReview: (id, r) => { (R[id] = R[id] || []).unshift({ id: ++rseq, ...r }); const c = C.find((x) => x.id === id);
        if (!c.lastReview || r.reviewDate > c.lastReview) c.lastReview = r.reviewDate; return ok({}); },
      notifications: () => ok(N),
      settings: () => ok(S),
      saveSettings: (s) => { S = { ...S, ...s, smtpPass: undefined, smtpPassSet: S.smtpPassSet || !!s.smtpPass }; return ok({}); },
      testEmail: () => Promise.reject(new Error("Demo mode can't send email.")),
      runNow: () => Promise.reject(new Error("Demo mode can't send email.")),
    };
  }

  let store = live, demo = false, user = null, contracts = [], view = "contracts", filter = "all";

  /* ---------------- status helpers ---------------- */
  function expiryState(c) {
    if (c.status !== "active") return { cls: "idle", label: c.status === "renewed" ? "Renewed" : "Terminated" };
    if (c.daysLeft < 0) return { cls: "bad", label: `Expired ${-c.daysLeft}d ago` };
    if (c.daysLeft === 0) return { cls: "bad", label: "Expires today" };
    if (c.daysLeft <= 30) return { cls: "bad", label: `${c.daysLeft} days left` };
    if (c.daysLeft <= 90) return { cls: "warn", label: `${c.daysLeft} days left` };
    return { cls: "ok", label: `${c.daysLeft} days left` };
  }
  function reviewState(c, lead = 14) {
    if (!c.reviewMonths || !c.nextReview || c.status !== "active") return { cls: "idle", label: "Not scheduled", d: null };
    const d = diffDays(c.nextReview, today());
    if (d < 0) return { cls: "bad", label: `Overdue ${-d}d`, d };
    if (d <= lead) return { cls: "warn", label: d === 0 ? "Due today" : `Due in ${d}d`, d };
    return { cls: "ok", label: `In ${d}d`, d };
  }
  const elapsedPct = (c) => { const total = diffDays(c.endDate, c.startDate) || 1; return Math.max(0, Math.min(100, (diffDays(today(), c.startDate) / total) * 100)); };

  /* ---------------- tabs ---------------- */
  $$("nav.tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
  function show(v) {
    view = v;
    $$("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === v));
    $$("main > section").forEach((s) => (s.hidden = s.id !== "v-" + v));
    render();
  }
  function render() { ({ contracts: renderContracts, reviews: renderReviews, reminders: renderReminders, settings: renderSettings })[view](); }
  async function reload() { contracts = await store.list(); render(); notifyParent(); }

  /* ---------------- Contracts ---------------- */
  function renderContracts() {
    const el = $("#v-contracts");
    const q = ($("#cq", el) || {}).value || "";
    const active = contracts.filter((c) => c.status === "active");
    const counts = {
      all: contracts.length,
      soon: active.filter((c) => c.daysLeft >= 0 && c.daysLeft <= 90).length,
      expired: active.filter((c) => c.daysLeft < 0).length,
      review: active.filter((c) => reviewState(c).cls === "bad").length,
    };
    const match = { all: () => true, soon: (c) => c.status === "active" && c.daysLeft >= 0 && c.daysLeft <= 90, expired: (c) => c.status === "active" && c.daysLeft < 0, review: (c) => reviewState(c).cls === "bad" }[filter];
    const list = contracts.filter((c) => match(c) && (!q || [c.ref, c.title, c.vendor, c.service, c.owner].join(" ").toLowerCase().includes(q.toLowerCase())));
    el.innerHTML = `
      <div class="section-head"><h1>Contracts &amp; SLAs</h1><div class="grow"></div><button class="btn primary" id="addC">+ Add contract</button>
        <p>Reminder emails go to each contract's recipients before it expires. Crossed-out reminder points have passed.</p></div>
      <div class="stats">
        <button class="stat ${filter === "all" ? "on" : ""}" data-f="all"><b>${counts.all}</b><span>All contracts</span></button>
        <button class="stat warn ${filter === "soon" ? "on" : ""}" data-f="soon"><b>${counts.soon}</b><span>Expiring within 90 days</span></button>
        <button class="stat bad ${filter === "expired" ? "on" : ""}" data-f="expired"><b>${counts.expired}</b><span>Expired, still active</span></button>
        <button class="stat bad ${filter === "review" ? "on" : ""}" data-f="review"><b>${counts.review}</b><span>Reviews overdue</span></button>
      </div>
      <div class="toolbar"><input type="search" id="cq" placeholder="Search contract, vendor, owner…" value="${esc(q)}"><span class="note" style="margin-left:auto">${list.length} of ${contracts.length}</span></div>
      <div class="tbl"><table>
        <thead><tr><th>Ref</th><th>Contract</th><th>Period</th><th>Expiry</th><th>Reminders</th><th>Review</th><th>Files</th><th></th></tr></thead>
        <tbody>${list.map((c) => { const e = expiryState(c), r = reviewState(c);
          const crossed = c.reminderDays.filter((d) => c.daysLeft <= d);
          return `<tr>
            <td class="ref">${esc(c.ref)}</td>
            <td><b>${esc(c.title)}</b><div class="sub">${esc(c.vendor)}${c.owner ? " · " + esc(c.owner) : ""}</div></td>
            <td class="num" style="white-space:nowrap">${fmt(c.startDate)}<div class="sub">to ${fmt(c.endDate)}</div>
              <div class="bar"><i style="width:${elapsedPct(c)}%;background:var(--${e.cls === "idle" ? "idle" : e.cls})"></i></div></td>
            <td><span class="pill ${e.cls}">${esc(e.label)}</span>${c.autoRenew ? '<div class="sub">Auto-renews</div>' : ""}</td>
            <td><div class="days">${c.reminderDays.map((d) => `<span class="${crossed.includes(d) && c.status === "active" ? "done" : ""}">${d}d</span>`).join("") || '<span>none</span>'}</div>
              <div class="sub">${c.notifyEmails ? esc(c.notifyEmails.split(",").length + " recipient(s)") : "No recipients"}</div></td>
            <td><span class="pill ${r.cls}">${esc(r.label)}</span><div class="sub">${esc(FREQ[c.reviewMonths] || "")}</div></td>
            <td class="num">${(c.files || []).length || "—"}</td>
            <td class="actions"><button class="icon" data-edit="${c.id}" title="Edit">✎</button><button class="icon" data-del="${c.id}" title="Delete">🗑</button></td></tr>`; }).join("")
          || `<tr><td colspan="8" class="empty">${contracts.length ? "No contracts match." : "No contracts yet. Add your first SLA or contract."}</td></tr>`}</tbody>
      </table></div>`;
    $("#addC", el).addEventListener("click", () => contractForm());
    $("#cq", el).addEventListener("input", (ev) => { const p = ev.target.selectionStart; renderContracts(); const i = $("#cq"); i.focus(); i.setSelectionRange(p, p); });
    $$("[data-f]", el).forEach((b) => b.addEventListener("click", () => { filter = filter === b.dataset.f ? "all" : b.dataset.f; renderContracts(); }));
    $$("[data-edit]", el).forEach((b) => b.addEventListener("click", () => contractForm(contracts.find((c) => c.id === +b.dataset.edit))));
    $$("[data-del]", el).forEach((b) => b.addEventListener("click", () => { const c = contracts.find((x) => x.id === +b.dataset.del);
      confirmBox(`Delete ${c.ref}?`, `"${c.title}", its files and review history will be deleted.`, "Delete contract", async () => { await store.remove(c.id); toast(`${c.ref} deleted`); reload(); }); }));
  }

  /* ---------------- modal helpers ---------------- */
  function modal(title, body, foot) {
    $("#modalRoot").innerHTML = `<div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2><button class="icon" data-close aria-label="Close">✕</button></header>${body}<footer>${foot}</footer></div></div>`;
    const root = $("#modalRoot");
    $$("[data-close]", root).forEach((b) => b.addEventListener("click", closeModal));
    $(".overlay", root).addEventListener("mousedown", (e) => { if (e.target.classList.contains("overlay")) closeModal(); });
    setTimeout(() => $("input,select,textarea", root)?.focus(), 20);
    return root;
  }
  function closeModal() { $("#modalRoot").innerHTML = ""; }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  function confirmBox(title, text, btn, onYes) {
    const r = modal(title, `<div class="body"><p class="full" style="margin:0">${esc(text)}</p></div>`,
      `<button class="btn" data-close>Cancel</button><button class="btn danger" id="yes">${esc(btn)}</button>`);
    $("#yes", r).addEventListener("click", async () => { closeModal(); try { await onYes(); } catch (e) { toast(e.message); } });
  }

  /* ---------------- contract form ---------------- */
  function contractForm(c) {
    const isNew = !c;
    c = c || { reminderDays: [90, 60, 30, 7], reviewMonths: 12, currency: "PKR", status: "active", files: [], startDate: today(), endDate: addMonths(today(), 12) };
    const custom = c.reminderDays.filter((d) => !DAY_CHOICES.includes(d));
    let pending = [];
    const body = `<form class="body" id="cf" novalidate>
      <label class="fld full"><span>Contract / SLA title <span class="req">*</span></span><input id="c_title" value="${esc(c.title)}" placeholder="e.g. Internet leased line – head office"></label>
      <label class="fld"><span>Vendor <span class="req">*</span></span><input id="c_vendor" value="${esc(c.vendor)}"></label>
      <label class="fld"><span>Service covered</span><input id="c_service" value="${esc(c.service)}"></label>
      <label class="fld"><span>Start date <span class="req">*</span></span><input type="date" id="c_start" value="${esc(c.startDate)}"></label>
      <label class="fld"><span>End / expiry date <span class="req">*</span></span><input type="date" id="c_end" value="${esc(c.endDate)}"></label>
      <div class="full chks" style="margin-top:-6px"><span class="note">Period shortcut:</span>${[6, 12, 24, 36].map((m) => `<button type="button" class="btn sm" data-period="${m}">${m < 12 ? m + " months" : m / 12 + (m === 12 ? " year" : " years")}</button>`).join("")}</div>
      <label class="fld"><span>Contract owner</span><input id="c_owner" value="${esc(c.owner)}" placeholder="e.g. Network Administrator"></label>
      <label class="fld"><span>Value</span><div style="display:flex;gap:6px"><select id="c_cur" style="width:90px">${["PKR", "USD", "EUR", "GBP"].map((x) => `<option ${x === c.currency ? "selected" : ""}>${x}</option>`).join("")}</select><input type="number" id="c_value" value="${esc(c.value ?? "")}" min="0" step="any"></div></label>
      <fieldset class="group full"><legend>Expiry reminders</legend>
        <label class="fld"><span>Send reminders to (comma-separated emails)</span><input id="c_emails" value="${esc(c.notifyEmails)}" placeholder="owner@treetgroup.com, it.manager@treetgroup.com"></label>
        <div class="chks">${DAY_CHOICES.map((d) => `<label class="chk"><input type="checkbox" data-day="${d}" ${c.reminderDays.includes(d) ? "checked" : ""}> ${d} day${d > 1 ? "s" : ""} before</label>`).join("")}</div>
        <label class="fld" style="max-width:280px"><span>Other days (comma-separated)</span><input id="c_daysx" value="${esc(custom.join(", "))}" placeholder="e.g. 45"></label>
        <span class="note">A final reminder is also sent on the expiry day.</span>
      </fieldset>
      <fieldset class="group full"><legend>Periodic review</legend>
        <div class="form-grid">
          <label class="fld"><span>Review frequency</span><select id="c_freq">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${+k === c.reviewMonths ? "selected" : ""}>${v}</option>`).join("")}</select></label>
          <label class="fld"><span>Last reviewed</span><input type="date" id="c_last" value="${esc(c.lastReview || "")}"></label>
        </div>
        <span class="note" id="nextRev"></span>
      </fieldset>
      <label class="fld"><span>Status</span><select id="c_status">${["active", "renewed", "terminated"].map((s) => `<option value="${s}" ${s === c.status ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></label>
      <label class="chk" style="align-self:end;padding-bottom:8px"><input type="checkbox" id="c_auto" ${c.autoRenew ? "checked" : ""}> Renews automatically</label>
      <label class="fld full"><span>Notes</span><textarea id="c_notes">${esc(c.notes)}</textarea></label>
      <fieldset class="group full"><legend>SLA documents</legend>
        <div class="files" id="fileList"></div>
        <label class="drop" id="drop"><input type="file" id="c_files" multiple hidden>Drop the signed SLA / contract here, or <u>choose files</u> (max 25 MB each)</label>
      </fieldset>
      <div class="full err" id="cErr"></div></form>`;
    const root = modal(isNew ? "Add contract" : `Edit ${c.ref}`, body, `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveC">${isNew ? "Add contract" : "Save changes"}</button>`);

    const nextRev = () => { const m = +$("#c_freq", root).value, base = $("#c_last", root).value || $("#c_start", root).value;
      $("#nextRev", root).textContent = m && base ? `Next review due ${fmt(addMonths(base, m))}. A reminder is sent before it's due.` : "No periodic review."; };
    ["#c_freq", "#c_last", "#c_start"].forEach((s) => $(s, root).addEventListener("change", nextRev)); nextRev();
    $$("[data-period]", root).forEach((b) => b.addEventListener("click", () => { const s = $("#c_start", root).value || today(); $("#c_end", root).value = addDays(addMonths(s, +b.dataset.period), -1); }));

    const drawFiles = () => {
      $("#fileList", root).innerHTML = (c.files || []).map((f) => { const url = store.fileUrl(f.id);
        return `<div class="file">📄 ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(f.filename)}</a>` : `<span style="flex:1">${esc(f.filename)}</span>`}<span class="note">${Math.ceil(f.size / 1024)} KB</span><button type="button" class="icon" data-rmf="${f.id}" title="Remove file">✕</button></div>`; }).join("")
        + pending.map((f, i) => `<div class="file">⬆ <span style="flex:1">${esc(f.name)}</span><span class="note">uploads on save</span><button type="button" class="icon" data-rmp="${i}">✕</button></div>`).join("");
      $$("[data-rmf]", root).forEach((b) => b.addEventListener("click", async () => { try { await store.removeFile(+b.dataset.rmf); c.files = c.files.filter((f) => f.id !== +b.dataset.rmf); drawFiles(); toast("File removed"); reload(); } catch (e) { toast(e.message); } }));
      $$("[data-rmp]", root).forEach((b) => b.addEventListener("click", () => { pending.splice(+b.dataset.rmp, 1); drawFiles(); }));
    };
    const addFiles = (fl) => { for (const f of fl) { if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB`); continue; } pending.push(f); } drawFiles(); };
    $("#c_files", root).addEventListener("change", (e) => addFiles(e.target.files));
    const drop = $("#drop", root);
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
    drawFiles();

    $("#saveC", root).addEventListener("click", async () => {
      const days = [...$$("[data-day]", root).filter((x) => x.checked).map((x) => +x.dataset.day),
        ...$("#c_daysx", root).value.split(/[\s,]+/).filter(Boolean).map(Number)];
      const data = {
        title: $("#c_title", root).value, vendor: $("#c_vendor", root).value, service: $("#c_service", root).value, owner: $("#c_owner", root).value,
        startDate: $("#c_start", root).value, endDate: $("#c_end", root).value, currency: $("#c_cur", root).value, value: $("#c_value", root).value,
        notifyEmails: $("#c_emails", root).value, reminderDays: [...new Set(days)].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => b - a),
        reviewMonths: +$("#c_freq", root).value, lastReview: $("#c_last", root).value || null, status: $("#c_status", root).value,
        autoRenew: $("#c_auto", root).checked, notes: $("#c_notes", root).value,
      };
      const errs = [];
      if (!data.title.trim()) errs.push("Add a title."); if (!data.vendor.trim()) errs.push("Add the vendor.");
      if (!data.startDate || !data.endDate) errs.push("Set the start and end dates."); else if (data.endDate < data.startDate) errs.push("End date must be after the start date.");
      if (errs.length) { $("#cErr", root).textContent = errs.join(" "); return; }
      const btn = $("#saveC", root); btn.disabled = true; btn.textContent = "Saving…";
      try {
        let id = c.id, ref = c.ref;
        if (isNew) { const r = await store.create(data); id = r.id; ref = r.ref; } else await store.update(id, data);
        for (const f of pending) { btn.textContent = `Uploading ${f.name}…`; await store.upload(id, f); }
        closeModal(); toast(isNew ? `${ref} added` : `${ref} saved`); reload();
      } catch (e) { $("#cErr", root).textContent = e.message; btn.disabled = false; btn.textContent = isNew ? "Add contract" : "Save changes"; }
    });
  }

  /* ---------------- Reviews ---------------- */
  let lead = 14;
  function renderReviews() {
    const el = $("#v-reviews");
    const rows = contracts.filter((c) => c.status === "active").map((c) => ({ c, r: reviewState(c, lead) }))
      .sort((a, b) => (a.r.d ?? 1e9) - (b.r.d ?? 1e9));
    el.innerHTML = `
      <div class="section-head"><h1>Contract reviews</h1>
        <p>Set how often each contract is reviewed, then log each review. The next review date moves forward automatically, and a reminder email goes out before it's due.</p></div>
      <div class="tbl"><table>
        <thead><tr><th>Ref</th><th>Contract</th><th>Review frequency</th><th>Last review</th><th>Next review</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(({ c, r }) => `<tr>
          <td class="ref">${esc(c.ref)}</td>
          <td><b>${esc(c.title)}</b><div class="sub">${esc(c.vendor)}</div></td>
          <td><select data-freq="${c.id}" aria-label="Review frequency" style="width:auto">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${+k === c.reviewMonths ? "selected" : ""}>${v}</option>`).join("")}</select></td>
          <td class="num">${fmt(c.lastReview)}</td>
          <td class="num">${fmt(c.nextReview)}</td>
          <td><span class="pill ${r.cls}">${esc(r.label)}</span></td>
          <td class="actions"><button class="btn sm" data-hist="${c.id}">History</button> <button class="btn sm primary" data-log="${c.id}">Log review</button></td></tr>`).join("")
          || '<tr><td colspan="7" class="empty">No active contracts.</td></tr>'}</tbody>
      </table></div>`;
    $$("[data-freq]", el).forEach((s) => s.addEventListener("change", async () => {
      const c = contracts.find((x) => x.id === +s.dataset.freq);
      try { await store.update(c.id, { ...c, reviewMonths: +s.value }); toast(`${c.ref}: review ${FREQ[s.value].toLowerCase()}`); reload(); } catch (e) { toast(e.message); }
    }));
    $$("[data-log]", el).forEach((b) => b.addEventListener("click", () => reviewForm(contracts.find((x) => x.id === +b.dataset.log))));
    $$("[data-hist]", el).forEach((b) => b.addEventListener("click", () => reviewHistory(contracts.find((x) => x.id === +b.dataset.hist))));
  }
  function reviewForm(c) {
    const root = modal(`Log review – ${c.ref}`, `<form class="body" novalidate>
      <p class="full note" style="margin:0">${esc(c.title)} · reviewed ${esc((FREQ[c.reviewMonths] || "").toLowerCase())}</p>
      <label class="fld"><span>Review date <span class="req">*</span></span><input type="date" id="r_date" value="${today()}"></label>
      <label class="fld"><span>Reviewed by</span><input id="r_by" value="${esc(user?.username || user?.name || "")}"></label>
      <label class="fld full"><span>Outcome</span><select id="r_out">${OUTCOMES.map((o) => `<option>${o}</option>`).join("")}</select></label>
      <label class="fld full"><span>Notes</span><textarea id="r_notes" placeholder="SLA performance, incidents, cost, renewal decision…"></textarea></label>
      <div class="full err" id="rErr"></div></form>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="saveR">Save review</button>`);
    $("#saveR", root).addEventListener("click", async () => {
      const r = { reviewDate: $("#r_date", root).value, reviewer: $("#r_by", root).value, outcome: $("#r_out", root).value, notes: $("#r_notes", root).value };
      if (!r.reviewDate) { $("#rErr", root).textContent = "Set the review date."; return; }
      try { await store.addReview(c.id, r); closeModal(); toast("Review logged. Next review date updated."); reload(); } catch (e) { $("#rErr", root).textContent = e.message; }
    });
  }
  async function reviewHistory(c) {
    const list = await store.reviews(c.id);
    modal(`Review history – ${c.ref}`, `<div class="body"><div class="full history">${list.map((r) => `<div class="hist"><b>${fmt(r.reviewDate)}</b> · ${esc(r.outcome || "—")} · ${esc(r.reviewer || "")}${r.notes ? `<div class="sub">${esc(r.notes)}</div>` : ""}</div>`).join("") || '<p class="muted" style="margin:0">No reviews logged yet.</p>'}</div></div>`,
      `<button class="btn" data-close>Close</button>`);
  }

  /* ---------------- Reminders log ---------------- */
  async function renderReminders() {
    const el = $("#v-reminders");
    el.innerHTML = `<div class="section-head"><h1>Reminder emails</h1><div class="grow"></div>${isAdmin() ? '<button class="btn" id="runNow">Send due reminders now</button>' : ""}
      <p>Every reminder the server has sent or tried to send. Reminders go out once a day at the hour set under Settings.</p></div><div class="panel pad muted">Loading…</div>`;
    $("#runNow", el)?.addEventListener("click", async (e) => { e.target.disabled = true;
      try { const r = await store.runNow(); toast(r.skipped ? "Skipped: " + r.skipped : `Sent ${r.expiry} expiry and ${r.review} review reminder(s)${r.failed ? `, ${r.failed} failed` : ""}`); renderReminders(); }
      catch (err) { toast(err.message); e.target.disabled = false; } });
    let list = [];
    try { list = await store.notifications(); } catch (e) { $(".panel", el).textContent = e.message; return; }
    $(".panel", el).outerHTML = `<div class="tbl"><table><thead><tr><th>Sent</th><th>Contract</th><th>Type</th><th>Subject</th><th>To</th><th>Result</th></tr></thead><tbody>
      ${list.map((n) => `<tr><td class="num" style="white-space:nowrap">${esc(new Date(n.sentAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }))}</td>
        <td class="ref">${esc(n.ref || "—")}</td><td>${n.kind === "expiry" ? `Expiry · ${esc(n.milestone)}d` : n.kind === "review" ? "Review due" : "Test"}</td>
        <td>${esc(n.subject)}</td><td><span class="sub">${esc(n.recipients)}</span></td>
        <td><span class="pill ${n.status === "sent" ? "ok" : "bad"}" ${n.error ? `title="${esc(n.error)}"` : ""}>${n.status === "sent" ? "Sent" : "Failed"}</span></td></tr>`).join("")
        || '<tr><td colspan="6" class="empty">No reminders sent yet.</td></tr>'}</tbody></table></div>`;
  }

  /* ---------------- Settings ---------------- */
  const isAdmin = () => demo || String(user?.role || "").toLowerCase() === "admin";
  async function renderSettings() {
    const el = $("#v-settings");
    if (!isAdmin()) { el.innerHTML = '<div class="section-head"><h1>Settings</h1></div><div class="panel pad muted">Only admins can change email settings.</div>'; return; }
    let s; try { s = await store.settings(); } catch (e) { el.innerHTML = `<div class="panel pad err">${esc(e.message)}</div>`; return; }
    lead = s.reviewLeadDays;
    el.innerHTML = `<div class="section-head"><h1>Email settings</h1>
      <p>How the server sends reminder emails. For Office 365, use smtp.office365.com on port 587 with a licensed mailbox that has SMTP AUTH turned on.</p></div>
      <form class="panel pad" id="sf" novalidate style="display:flex;flex-direction:column;gap:16px">
        <div class="form-grid">
          <label class="fld"><span>SMTP server</span><input id="s_host" value="${esc(s.smtpHost)}"></label>
          <label class="fld"><span>Port</span><input type="number" id="s_port" value="${esc(s.smtpPort)}"></label>
          <label class="fld"><span>SMTP username</span><input id="s_user" value="${esc(s.smtpUser)}" autocomplete="off"></label>
          <label class="fld"><span>SMTP password</span><input type="password" id="s_pass" placeholder="${s.smtpPassSet ? "Saved. Leave blank to keep it" : "Not set"}" autocomplete="new-password"></label>
          <label class="fld"><span>From address</span><input id="s_from" value="${esc(s.mailFrom)}" placeholder="RiskLedger &lt;it.alerts@treetgroup.com&gt;"></label>
          <label class="fld"><span>Always copy (optional)</span><input id="s_cc" value="${esc(s.defaultRecipients)}" placeholder="it.manager@treetgroup.com"></label>
          <label class="fld"><span>RiskLedger address (for links in emails)</span><input id="s_url" value="${esc(s.appUrl)}" placeholder="https://192.168.0.87:8443"></label>
          <label class="fld"><span>Time zone</span><input id="s_tz" value="${esc(s.timeZone || "Asia/Karachi")}"></label>
          <label class="fld"><span>Send daily at (hour, 0–23)</span><input type="number" id="s_hour" min="0" max="23" value="${esc(s.sendHour)}"></label>
          <label class="fld"><span>Review reminder lead time (days)</span><input type="number" id="s_lead" min="0" max="90" value="${esc(s.reviewLeadDays)}"></label>
        </div>
        <label class="chk"><input type="checkbox" id="s_on" ${s.enabled ? "checked" : ""}> Send reminder emails automatically</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><button class="btn primary" id="saveS" type="button">Save settings</button><span class="err" id="sErr"></span></div>
      </form>
      <div class="panel pad" style="margin-top:16px;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end">
        <label class="fld" style="flex:1;min-width:220px"><span>Send a test email to</span><input id="t_to" type="email" placeholder="you@treetgroup.com"></label>
        <button class="btn" id="sendT" type="button">Send test</button>
      </div>`;
    $("#saveS", el).addEventListener("click", async () => {
      const d = { smtpHost: $("#s_host").value, smtpPort: +$("#s_port").value, smtpUser: $("#s_user").value, mailFrom: $("#s_from").value,
        defaultRecipients: $("#s_cc").value, appUrl: $("#s_url").value, timeZone: $("#s_tz").value.trim(), sendHour: +$("#s_hour").value, reviewLeadDays: +$("#s_lead").value, enabled: $("#s_on").checked };
      if ($("#s_pass").value) d.smtpPass = $("#s_pass").value;
      try { await store.saveSettings(d); toast("Settings saved"); renderSettings(); } catch (e) { $("#sErr").textContent = e.message; }
    });
    $("#sendT", el).addEventListener("click", async (e) => { e.target.disabled = true;
      try { await store.testEmail($("#t_to").value.trim()); toast("Test email sent"); } catch (err) { toast(err.message); } e.target.disabled = false; });
  }

  /* ---------------- boot ---------------- */
  (async function boot() {
    try {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      if (res.status === 401) { (EMBED ? window.top : window).location.href = "/login.html"; return; }
      if (!res.ok) throw new Error("no api");
      user = await res.json();
      contracts = await live.list();
    } catch (e) {
      if (e.message === "Signed out") return;
      demo = true; store = makeDemo(); $("#demoBanner").hidden = false; contracts = await store.list();
    }
    if (!isAdmin()) $("#tabSettings").hidden = true;
    const h = location.hash.slice(1);
    show("contracts");
    const hit = contracts.find((c) => c.ref === h);
    if (hit) contractForm(hit);
  })();
})();
