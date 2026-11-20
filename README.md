# RiskLedger SLA management

Adds contract / SLA tracking to a self-hosted RiskLedger (Node.js + PostgreSQL in Docker):

- Upload signed SLA documents, with start and end dates, value and owner
- Expiry reminder emails 90, 60, 30 and 7 days before expiry (editable per contract), plus on the expiry day
- Periodic contract reviews (monthly to every 2 years) with a review log and reminder emails
- Email log, a "send due reminders now" button, and SMTP settings with a test email (admins)

## Install on the RiskLedger server

```bash
cd /root
wget github.com/ishtiaqrafique/riskledger-sla/archive/refs/heads/main.tar.gz
tar xzf main.tar.gz
cd riskledger-sla-main
bash install.sh            # default app folder: /opt/riskledger
```

The installer backs up `server.js` and the package files, copies the module in, hooks it into
`server.js`, adds `nodemailer`, rebuilds the containers and checks that `/sla.html` loads.

Then open RiskLedger and choose **Contracts & SLAs** in the menu (`https://<server>:8443/#sla`), go to **Settings**, enter the SMTP details
(Office 365: `smtp.office365.com`, port 587, a mailbox with SMTP AUTH enabled) and send a test email.

## Files

| File | Goes to |
|---|---|
| `sla.js` | `server/sla.js` (API, database tables, daily reminder job) |
| `sla.html`, `sla.css`, `sla-app.js` | `public/` (SLA management page) |
| `sla-embed.js` | `public/` (shows Contracts & SLAs inside the RiskLedger app, menu badge) |
| `integrate.py` | adds the **Contracts & SLAs** menu item and `#sla` page to `public/index.html` |
| `install.sh` | installer |
| `riskledger-admin.html` | standalone risk register admin console (fields, lists, matrix) |
| `risk-matrix.html` | standalone risk matrix + register page |

## Undo

Copy the files from `/opt/riskledger/backup-<timestamp>/` back into `/opt/riskledger/server/`
and run `docker compose up -d --build`.
