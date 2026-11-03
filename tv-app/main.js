// Start page of the "Duet" TV app. Kept ES5-only: older Tizen browsers.
// Opens the dashboard (TV mode) in this window. The dashboard's Back on its
// home page comes back here, and coming back means "leave the app".
document.getElementById("msg").textContent = "Connecting to Duet…";
var DASHBOARD = "__DASHBOARD_URL__";
var target = DASHBOARD + (DASHBOARD.indexOf("?") < 0 ? "?" : "&") + "tv";

function exitApp() {
  try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
}

// Probe first so an unreachable server shows a message here rather than a
// browser error page. no-cors: we only need "did anything answer".
function tryOpen() {
  var timeout = new Promise(function (_, reject) { setTimeout(reject, 4000); });
  Promise.race([fetch(DASHBOARD, { mode: "no-cors", cache: "no-store" }), timeout]).then(function () {
    sessionStorage.setItem("opened", "1");
    location.href = target;
  }, retry);
}
function retry() {
  document.getElementById("msg").textContent = "Duet is not reachable";
  document.getElementById("sub").textContent = DASHBOARD + " · retrying… (Back to exit)";
  setTimeout(tryOpen, 5000);
}

document.addEventListener("keydown", function (e) {
  if (e.keyCode === 10009) exitApp(); // Back on the remote
});
// Back from the dashboard lands here again: leave instead of reopening it.
window.addEventListener("pageshow", function () {
  if (sessionStorage.getItem("opened")) { sessionStorage.removeItem("opened"); exitApp(); }
  else tryOpen();
});
