// Diagnostics page. Opened by worker/ext-logs.mjs over CDP so the extension's runtime
// state can be read without visiting chrome://extensions. Being an extension page it
// stays alive (unlike the MV3 service worker) and has full chrome API access.
// It first pokes the service worker to force a fresh config fetch + rule apply, then
// dumps STATUS_KEY / LOG_KEY plus the live dynamic rules into window.__sg.
(async () => {
  const out = document.getElementById("out");
  let refresh = null;
  try {
    refresh = await chrome.runtime.sendMessage({ type: "sg-refresh-config" });
  } catch (e) {
    refresh = { error: e.message };
  }
  const s = await chrome.storage.local.get(["sg_status", "sg_log", "sg_config"]);
  const dyn = await chrome.declarativeNetRequest.getDynamicRules();
  window.__sg = {
    extId: chrome.runtime.id,
    refresh,
    configVersion: s.sg_config ? s.sg_config.version : null,
    status: s.sg_status || null,
    liveDynamicRuleCount: dyn.length,
    liveDynamicRules: dyn,
    log: (s.sg_log || []).slice(-40),
  };
  out.textContent = JSON.stringify(window.__sg, null, 2);
})();
