// RiskLedger – SLA / contract management module
// Plug in from server.js (after needAuth/needPwOk/needAdmin are defined):
//   require("./sla")(app, { pool, needAuth, needPwOk, needAdmin });
const express = require("express");
const nodemailer = require("nodemailer");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sla_contracts (
  id            SERIAL PRIMARY KEY,
  ref           TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  vendor        TEXT NOT NULL,
  service       TEXT NOT NULL DEFAULT '',
  owner         TEXT NOT NULL DEFAULT '',
  notify_emails TEXT NOT NULL DEFAULT '',
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  value         NUMERIC(14,2),
  currency      TEXT NOT NULL DEFAULT 'PKR',
  auto_renew    BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_days INT[] NOT NULL DEFAULT '{90,60,30,7}',
  review_months INT NOT NULL DEFAULT 12,
  last_review   DATE,
  next_review   DATE,
  status        TEXT NOT NULL DEFAULT 'active',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sla_files (
  id          SERIAL PRIMARY KEY,
  contract_id INT NOT NULL REFERENCES sla_contracts(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INT NOT NULL,
  content     BYTEA NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sla_reviews (
  id          SERIAL PRIMARY KEY,
  contract_id INT NOT NULL REFERENCES sla_contracts(id) ON DELETE CASCADE,
  review_date DATE NOT NULL,
  reviewer    TEXT NOT NULL DEFAULT '',
  outcome     TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sla_notifications (
  id          SERIAL PRIMARY KEY,
  contract_id INT REFERENCES sla_contracts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,           -- expiry | review | test
  milestone   TEXT NOT NULL,           -- e.g. "30" days before, or review date
  target_date DATE,
  recipients  TEXT NOT NULL,
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL,           -- sent | failed
  error       TEXT,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sla_notif_once
  ON sla_notifications (contract_id, kind, milestone, target_date) WHERE status = 'sent';
CREATE TABLE IF NOT EXISTS sla_settings (
  id   INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data JSONB NOT NULL DEFAULT '{}'
);
INSERT INTO sla_settings (id, data) VALUES (1, '{}') ON CONFLICT DO NOTHING;
`;

const DEFAULT_SETTINGS = {
  smtpHost: process.env.SMTP_HOST || "smtp.office365.com",
  smtpPort: +(process.env.SMTP_PORT || 587),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  mailFrom: process.env.MAIL_FROM || "",
  defaultRecipients: "",
  appUrl: process.env.APP_URL || "",
  sendHour: 9,               // hour of day (in timeZone) to send the daily batch
  timeZone: process.env.TZ_REMINDERS || "Asia/Karachi",
  reviewLeadDays: 14,        // remind this many days before a review is due
  enabled: true,
};

const validTz = (tz) => { try { return !!tz && !!new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { return false; } };
const MAX_FILE = 25 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

module.exports = function sla(app, { pool, needAuth, needPwOk, needAdmin }) {
  const admin = needAdmin || ((req, res, next) => (String(req.user?.role).toLowerCase() === "admin" ? next() : res.status(403).json({ error: "Admins only." })));
  const canEdit = (req, res, next) => (String(req.user?.role).toLowerCase() === "viewer" ? res.status(403).json({ error: "Your role can't change contracts." }) : next());
  const who = (req) => req.user?.username || req.user?.name || String(req.user?.id || "");
  const ready = pool.query(SCHEMA).catch((e) => console.error("[sla] schema error", e));

  const r = express.Router();
  r.use(needAuth);

  // ---------- helpers ----------
  const SELECT = `
    SELECT c.id, c.ref, c.title, c.vendor, c.service, c.owner, c.notify_emails AS "notifyEmails",
           to_char(c.start_date,'YYYY-MM-DD') AS "startDate", to_char(c.end_date,'YYYY-MM-DD') AS "endDate",
           c.value, c.currency, c.auto_renew AS "autoRenew", c.reminder_days AS "reminderDays",
           c.review_months AS "reviewMonths", to_char(c.last_review,'YYYY-MM-DD') AS "lastReview",
           to_char(c.next_review,'YYYY-MM-DD') AS "nextReview", c.status, c.notes,
           (c.end_date - CURRENT_DATE) AS "daysLeft",
           (SELECT json_agg(json_build_object('id',f.id,'filename',f.filename,'size',f.size,'uploadedAt',f.uploaded_at,'uploadedBy',f.uploaded_by) ORDER BY f.uploaded_at DESC)
              FROM sla_files f WHERE f.contract_id=c.id) AS files
      FROM sla_contracts c`;

  function clean(b) {
    const errs = [];
    const s = (v) => (v == null ? "" : String(v).trim());
    const out = {
      title: s(b.title), vendor: s(b.vendor), service: s(b.service), owner: s(b.owner),
      notifyEmails: s(b.notifyEmails).split(/[\s,;]+/).filter(Boolean).join(", "),
      startDate: s(b.startDate), endDate: s(b.endDate),
      value: b.value === "" || b.value == null ? null : Number(b.value),
      currency: s(b.currency) || "PKR", autoRenew: !!b.autoRenew,
      reminderDays: (Array.isArray(b.reminderDays) ? b.reminderDays : String(b.reminderDays || "90,60,30,7").split(/[\s,]+/))
        .map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 730),
      reviewMonths: Number(b.reviewMonths ?? 12), lastReview: s(b.lastReview) || null,
      status: ["active", "terminated", "renewed"].includes(b.status) ? b.status : "active",
      notes: s(b.notes),
    };
    if (!out.title) errs.push("Title is required.");
    if (!out.vendor) errs.push("Vendor is required.");
    if (!DATE_RE.test(out.startDate)) errs.push("Start date is required.");
    if (!DATE_RE.test(out.endDate)) errs.push("End date is required.");
    if (out.startDate && out.endDate && out.endDate < out.startDate) errs.push("End date must be after the start date.");
    if (out.lastReview && !DATE_RE.test(out.lastReview)) errs.push("Last review date is invalid.");
    if (out.value != null && !Number.isFinite(out.value)) errs.push("Value must be a number.");
    if (![0, 1, 3, 6, 12, 24].includes(out.reviewMonths)) errs.push("Review frequency must be 0, 1, 3, 6, 12 or 24 months.");
    const bad = out.notifyEmails.split(", ").filter((e) => e && !EMAIL_RE.test(e));
    if (bad.length) errs.push("Invalid email: " + bad.join(", "));
    out.reminderDays = [...new Set(out.reminderDays)].sort((a, b) => b - a);
    return { out, errs };
  }

  // next review = last review (or start date) + frequency; if that is in the past the review shows as overdue
  const NEXT_REVIEW_SQL = `CASE WHEN $11::int = 0 THEN NULL ELSE (COALESCE($12::date,$6::date) + make_interval(months => $11::int))::date END`;

  // ---------- contracts ----------
  r.get("/contracts", async (req, res, next) => {
    try { await ready; const { rows } = await pool.query(`${SELECT} ORDER BY c.end_date`); res.json(rows); } catch (e) { next(e); }
  });

  r.post("/contracts", needPwOk, canEdit, async (req, res, next) => {
    const { out: c, errs } = clean(req.body || {});
    if (errs.length) return res.status(400).json({ errors: errs });
    try {
      await ready;
      const { rows } = await pool.query(
        `WITH n AS (SELECT 'SLA-' || lpad((COALESCE(MAX(NULLIF(split_part(ref,'-',2),'')::int),0)+1)::text,3,'0') AS ref FROM sla_contracts)
         INSERT INTO sla_contracts (ref,title,vendor,service,owner,start_date,end_date,value,currency,notify_emails,review_months,last_review,
                                    auto_renew,reminder_days,status,notes,created_by,updated_by,next_review)
         SELECT n.ref,$1,$2,$3,$4,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$5,$5,${NEXT_REVIEW_SQL} FROM n RETURNING id, ref`,
        [c.title, c.vendor, c.service, c.owner, who(req), c.startDate, c.endDate, c.value, c.currency, c.notifyEmails,
         c.reviewMonths, c.lastReview, c.autoRenew, c.reminderDays, c.status, c.notes]);
      res.status(201).json(rows[0]);
    } catch (e) { next(e); }
  });

  r.put("/contracts/:id", needPwOk, canEdit, async (req, res, next) => {
    const { out: c, errs } = clean(req.body || {});
    if (errs.length) return res.status(400).json({ errors: errs });
    try {
      const { rowCount } = await pool.query(
        `UPDATE sla_contracts SET title=$1,vendor=$2,service=$3,owner=$4,updated_by=$5,start_date=$6,end_date=$7,value=$8,currency=$9,
                notify_emails=$10,review_months=$11,last_review=$12,auto_renew=$13,reminder_days=$14,status=$15,notes=$16,
                next_review=${NEXT_REVIEW_SQL},updated_at=now() WHERE id=$17`,
        [c.title, c.vendor, c.service, c.owner, who(req), c.startDate, c.endDate, c.value, c.currency, c.notifyEmails,
         c.reviewMonths, c.lastReview, c.autoRenew, c.reminderDays, c.status, c.notes, +req.params.id]);
      rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
    } catch (e) { next(e); }
  });

  r.delete("/contracts/:id", needPwOk, canEdit, async (req, res, next) => {
    try {
      const { rowCount } = await pool.query("DELETE FROM sla_contracts WHERE id=$1", [+req.params.id]);
      rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
    } catch (e) { next(e); }
  });

  // ---------- files (raw upload: body = file bytes, header X-Filename) ----------
  r.post("/contracts/:id/files", needPwOk, canEdit,
    express.raw({ type: () => true, limit: MAX_FILE }), async (req, res, next) => {
      try {
        const name = decodeURIComponent(req.get("X-Filename") || "").replace(/[\\/\0]/g, "_").slice(0, 200);
        if (!name) return res.status(400).json({ error: "Missing file name." });
        if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "The file is empty." });
        const { rows } = await pool.query(
          `INSERT INTO sla_files (contract_id,filename,mime,size,content,uploaded_by)
           SELECT id,$2,$3,$4,$5,$6 FROM sla_contracts WHERE id=$1 RETURNING id`,
          [+req.params.id, name, (req.get("Content-Type") || "application/octet-stream").slice(0, 120), req.body.length, req.body, who(req)]);
        rows.length ? res.status(201).json(rows[0]) : res.status(404).json({ error: "Contract not found" });
      } catch (e) { next(e); }
    });

  r.get("/files/:fid", async (req, res, next) => {
    try {
      const { rows } = await pool.query("SELECT filename,mime,content FROM sla_files WHERE id=$1", [+req.params.fid]);
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      const f = rows[0];
      res.set("Content-Type", f.mime);
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
      res.send(f.content);
    } catch (e) { next(e); }
  });

  r.delete("/files/:fid", needPwOk, canEdit, async (req, res, next) => {
    try {
      const { rowCount } = await pool.query("DELETE FROM sla_files WHERE id=$1", [+req.params.fid]);
      rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
    } catch (e) { next(e); }
  });

  // ---------- reviews ----------
  r.get("/contracts/:id/reviews", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, to_char(review_date,'YYYY-MM-DD') AS "reviewDate", reviewer, outcome, notes
           FROM sla_reviews WHERE contract_id=$1 ORDER BY review_date DESC, id DESC`, [+req.params.id]);
      res.json(rows);
    } catch (e) { next(e); }
  });

  r.post("/contracts/:id/reviews", needPwOk, canEdit, async (req, res, next) => {
    const b = req.body || {};
    if (!DATE_RE.test(b.reviewDate || "")) return res.status(400).json({ errors: ["Review date is required."] });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO sla_reviews (contract_id,review_date,reviewer,outcome,notes)
         SELECT id,$2,$3,$4,$5 FROM sla_contracts WHERE id=$1 RETURNING id`,
        [+req.params.id, b.reviewDate, String(b.reviewer || who(req)).slice(0, 120), String(b.outcome || "").slice(0, 60), String(b.notes || "").slice(0, 4000)]);
      if (!ins.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Contract not found" }); }
      await client.query(
        `UPDATE sla_contracts SET last_review = GREATEST(COALESCE(last_review,$2::date),$2::date),
                next_review = CASE WHEN review_months=0 THEN NULL ELSE GREATEST(COALESCE(last_review,$2::date),$2::date) + make_interval(months => review_months) END,
                updated_at=now(), updated_by=$3 WHERE id=$1`, [+req.params.id, b.reviewDate, who(req)]);
      await client.query("COMMIT");
      res.status(201).json(ins.rows[0]);
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); next(e); } finally { client.release(); }
  });

  // ---------- notifications log ----------
  r.get("/notifications", async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT n.id, c.ref, c.title, n.kind, n.milestone, to_char(n.target_date,'YYYY-MM-DD') AS "targetDate",
                n.recipients, n.subject, n.status, n.error, n.sent_at AS "sentAt"
           FROM sla_notifications n LEFT JOIN sla_contracts c ON c.id=n.contract_id
          ORDER BY n.sent_at DESC LIMIT 200`);
      res.json(rows);
    } catch (e) { next(e); }
  });

  // ---------- settings (admin) ----------
  async function getSettings() {
    await ready;
    const { rows } = await pool.query("SELECT data FROM sla_settings WHERE id=1");
    return { ...DEFAULT_SETTINGS, ...(rows[0]?.data || {}) };
  }
  r.get("/settings", admin, async (req, res, next) => {
    try { const s = await getSettings(); res.json({ ...s, smtpPass: undefined, smtpPassSet: !!s.smtpPass }); } catch (e) { next(e); }
  });
  r.put("/settings", needPwOk, admin, async (req, res, next) => {
    try {
      const cur = await getSettings(), b = req.body || {};
      const s = {
        smtpHost: String(b.smtpHost ?? cur.smtpHost).trim(), smtpPort: +(b.smtpPort ?? cur.smtpPort) || 587,
        smtpUser: String(b.smtpUser ?? cur.smtpUser).trim(), smtpPass: b.smtpPass ? String(b.smtpPass) : cur.smtpPass,
        mailFrom: String(b.mailFrom ?? cur.mailFrom).trim(), defaultRecipients: String(b.defaultRecipients ?? cur.defaultRecipients).trim(),
        appUrl: String(b.appUrl ?? cur.appUrl).trim(), timeZone: validTz(b.timeZone) ? b.timeZone : cur.timeZone, sendHour: Math.min(23, Math.max(0, +(b.sendHour ?? cur.sendHour) || 0)),
        reviewLeadDays: Math.min(90, Math.max(0, +(b.reviewLeadDays ?? cur.reviewLeadDays) || 0)), enabled: b.enabled ?? cur.enabled,
      };
      await pool.query("UPDATE sla_settings SET data=$1 WHERE id=1", [JSON.stringify(s)]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.post("/settings/test", needPwOk, admin, async (req, res) => {
    const to = String(req.body?.to || "").trim();
    if (!EMAIL_RE.test(to)) return res.status(400).json({ error: "Enter one valid email address." });
    try {
      const s = await getSettings();
      await send(s, to, "RiskLedger SLA – test email", "This is a test email from RiskLedger SLA management. Reminders are set up correctly.");
      await logNotif(null, "test", "test", null, to, "RiskLedger SLA – test email", "sent");
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: "Email failed: " + e.message }); }
  });
  r.post("/run-reminders", needPwOk, admin, async (req, res) => {
    try { res.json(await runReminders(true)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.use("/api/sla", r);

  // ---------- email + scheduler ----------
  async function send(s, to, subject, text) {
    if (!s.smtpHost || !s.mailFrom) throw new Error("SMTP host and From address are not set.");
    const t = nodemailer.createTransport({
      host: s.smtpHost, port: s.smtpPort, secure: s.smtpPort === 465, requireTLS: s.smtpPort === 587,
      auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPass } : undefined,
    });
    await t.sendMail({ from: s.mailFrom, to, subject, text });
  }
  async function logNotif(contractId, kind, milestone, target, to, subject, status, error) {
    await pool.query(
      `INSERT INTO sla_notifications (contract_id,kind,milestone,target_date,recipients,subject,status,error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [contractId, kind, milestone, target, to, subject, status, error || null]);
  }
  const fmt = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  let running = false;
  async function runReminders(manual = false) {
    if (running) return { skipped: "already running" };
    running = true;
    const result = { expiry: 0, review: 0, failed: 0 };
    try {
      const s = await getSettings();
      if (!s.enabled && !manual) return { skipped: "reminders disabled" };
      const { rows } = await pool.query(`${SELECT} WHERE c.status='active'`);
      const sentQ = await pool.query(`SELECT contract_id, kind, milestone, to_char(target_date,'YYYY-MM-DD') AS t FROM sla_notifications WHERE status='sent'`);
      const sent = new Set(sentQ.rows.map((x) => `${x.contract_id}|${x.kind}|${x.milestone}|${x.t}`));
      for (const c of rows) {
        const to = [c.notifyEmails, s.defaultRecipients].filter(Boolean).join(", ");
        if (!to) continue;
        const link = s.appUrl ? `\n\nOpen in RiskLedger: ${s.appUrl.replace(/\/$/, "")}/sla.html#${c.ref}` : "";
        // Expiry: send the most urgent milestone crossed and not yet sent; mark earlier ones as covered.
        const crossed = [...c.reminderDays, 0].filter((d) => c.daysLeft <= d && c.daysLeft >= 0);
        const due = crossed.filter((d) => !sent.has(`${c.id}|expiry|${d}|${c.endDate}`));
        if (due.length) {
          const d = Math.min(...due);
          const when = c.daysLeft === 0 ? "expires TODAY" : `expires in ${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"}`;
          const subject = `[SLA ${c.ref}] ${c.title} – ${when} (${fmt(c.endDate)})`;
          const text = `The following contract ${when}.\n\nContract: ${c.ref} – ${c.title}\nVendor: ${c.vendor}\nService: ${c.service || "-"}\nOwner: ${c.owner || "-"}\n` +
            `Period: ${fmt(c.startDate)} to ${fmt(c.endDate)}\nAuto-renew: ${c.autoRenew ? "Yes" : "No"}\n` +
            (c.value != null ? `Value: ${c.currency} ${Number(c.value).toLocaleString()}\n` : "") +
            `\nPlease decide whether to renew, renegotiate or end this contract before it expires.${link}\n\n– RiskLedger SLA management`;
          try {
            await send(s, to, subject, text);
            for (const m of due) await logNotif(c.id, "expiry", String(m), c.endDate, to, m === d ? subject : `(covered by ${d}-day reminder)`, "sent");
            result.expiry++;
          } catch (e) { await logNotif(c.id, "expiry", String(d), c.endDate, to, subject, "failed", e.message); result.failed++; }
        }
        // Review: remind once per review cycle when it's within the lead time or overdue.
        if (c.nextReview) {
          const daysToReview = Math.round((new Date(c.nextReview) - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
          if (daysToReview <= s.reviewLeadDays && !sent.has(`${c.id}|review|due|${c.nextReview}`)) {
            const when = daysToReview < 0 ? `is ${-daysToReview} day(s) OVERDUE` : daysToReview === 0 ? "is due TODAY" : `is due in ${daysToReview} day(s)`;
            const subject = `[SLA ${c.ref}] Contract review ${when} – ${c.title}`;
            const text = `The periodic review of this contract ${when} (${fmt(c.nextReview)}).\n\nContract: ${c.ref} – ${c.title}\nVendor: ${c.vendor}\n` +
              `Review frequency: every ${c.reviewMonths} month(s)\nLast review: ${c.lastReview ? fmt(c.lastReview) : "never"}\n` +
              `\nCheck service levels, performance, cost and risks, then log the review in RiskLedger.${link}\n\n– RiskLedger SLA management`;
            try { await send(s, to, subject, text); await logNotif(c.id, "review", "due", c.nextReview, to, subject, "sent"); result.review++; }
            catch (e) { await logNotif(c.id, "review", "due", c.nextReview, to, subject, "failed", e.message); result.failed++; }
          }
        }
      }
      return result;
    } finally { running = false; }
  }

  // Check hourly; send once per day at the configured hour (and once at startup if that hour has passed).
  let lastRunDay = null;
  async function tick() {
    try {
      const s = await getSettings();
      const now = new Date(), tz = validTz(s.timeZone) ? s.timeZone : "UTC";
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
      const hour = +new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now);
      if (s.enabled && hour >= s.sendHour && lastRunDay !== day) {
        lastRunDay = day;
        const r = await runReminders();
        console.log("[sla] reminders", day, JSON.stringify(r));
      }
    } catch (e) { console.error("[sla] reminder run failed", e.message); }
  }
  setTimeout(tick, 15000);
  setInterval(tick, 60 * 60 * 1000).unref();
};
