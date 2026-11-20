/* RiskLedger – shows SLA management inside the main app (route #sla).
   Loaded by index.html before rl-client.js; used by renderMenu() and render(). */
(function () {
  "use strict";
  let pane = null, count = null;

  function ensurePane(main) {
    if (pane) return;
    pane = document.createElement("section");
    pane.id = "slaPane";
    pane.hidden = true;
    const cs = getComputedStyle(main);
    pane.style.cssText = "min-width:0;padding:0;position:sticky;top:0;height:100vh;height:100dvh;";
    pane.style.gridArea = cs.gridArea;
    const frame = document.createElement("iframe");
    frame.title = "Contracts & SLAs";
    frame.src = "/sla.html?embed=1";
    frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:transparent;";
    pane.appendChild(frame);
    main.parentNode.insertBefore(pane, main.nextSibling);
  }

  // Called from render() on every route change.
  window.slaToggle = function (route, main) {
    const on = route === "sla";
    if (on) ensurePane(main);
    if (pane) pane.hidden = !on;
    main.style.display = on ? "none" : "";
  };

  // Menu badge: active contracts expiring within 90 days (or expired) or with a review due.
  window.slaMenuCount = function () { return count ? count : ""; };

  async function refresh() {
    try {
      const res = await fetch("/api/sla/contracts", { credentials: "same-origin" });
      if (!res.ok) return;
      const list = await res.json();
      const today = new Date().toISOString().slice(0, 10);
      count = list.filter((c) => c.status === "active" && (c.daysLeft <= 90 || (c.nextReview && c.nextReview <= today))).length;
      if (typeof window.renderMenu === "function") window.renderMenu();
    } catch (e) { /* SLA module unavailable: no badge */ }
  }

  window.addEventListener("message", (e) => {
    if (e.origin === location.origin && e.data && e.data.type === "sla-changed") refresh();
  });
  window.addEventListener("load", () => { refresh(); setInterval(refresh, 5 * 60 * 1000); });
})();
