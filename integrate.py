#!/usr/bin/env python3
"""Adds the 'Contracts & SLAs' page to RiskLedger's main app (public/index.html).
Each edit must match exactly once; otherwise nothing is changed. Safe to run again."""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/opt/riskledger/public/index.html"
with open(path, encoding="utf-8") as f:
    src = f.read()

if "sla-embed.js" in src:
    print("index.html already includes Contracts & SLAs; nothing to do.")
    sys.exit(0)

EDITS = [
    # 1. route
    ('"incidents", "users", "audit"]',
     '"incidents", "sla", "users", "audit"]'),
    # 2. sidebar menu item (before Users & roles)
    ('["users", "Users & roles",',
     '["sla", "Contracts & SLAs", (window.slaMenuCount ? window.slaMenuCount() : "")], ["users", "Users & roles",'),
    # 3. show/hide the SLA pane on every render
    ('main.innerHTML = noticeHtml() + (r === "dashboard"',
     'main.innerHTML = noticeHtml() + (window.slaToggle && window.slaToggle(r, main), r === "dashboard"'),
    # 4. the SLA route has no list of its own in main
    ('r === "audit" ? auditHtml() :',
     'r === "audit" ? auditHtml() : r === "sla" ? "" :'),
    # 5. load the helper before the app script
    ('<script src="/rl-client.js"></script>',
     '<script src="/sla-embed.js"></script>\n<script src="/rl-client.js"></script>'),
]

problems = [f"expected 1 match, found {src.count(old)}: {old}" for old, _ in EDITS if src.count(old) != 1]
if problems:
    print("ERROR: index.html is not in the expected shape; no changes made.")
    print("\n".join(problems))
    sys.exit(1)

for old, new in EDITS:
    src = src.replace(old, new)
with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print("Added 'Contracts & SLAs' to the RiskLedger menu (5 edits).")
