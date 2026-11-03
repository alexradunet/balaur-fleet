// The kiosk browser has no address bar or back button. On every local service
// page (anything but the dashboard on port 80) float a Home button that
// returns to the dashboard. Shadow DOM keeps the page's CSS out.
(() => {
  if (location.port === "" || location.port === "80" || window !== window.top) return;

  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; left: 0; top: 50%; transform: translateY(-50%); z-index: 2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      button {
        display: flex; align-items: center; gap: 8px; min-height: 64px; padding: 0 18px 0 14px;
        border: 1px solid #242d40; border-left: 0; border-radius: 0 18px 18px 0;
        background: rgba(19, 24, 35, .82); color: #e6eaf2; backdrop-filter: blur(6px);
        font: 600 18px/1 system-ui, sans-serif; cursor: none; touch-action: manipulation;
        box-shadow: 0 6px 24px rgba(0, 0, 0, .35);
      }
      button:active { background: rgba(122, 162, 255, .35); }
      span { font-size: 26px; }
    </style>
    <button type="button" aria-label="Back to the dashboard"><span>⌂</span>Home</button>`;
  root.querySelector("button").addEventListener("click", () => {
    location.href = `${location.protocol}//${location.hostname}/?kiosk=1`;
  });
  (document.body || document.documentElement).append(host);
})();
