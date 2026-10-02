// Secret Garden background worker.
//
// This package is a thin, GENERIC, stable shell. All behavior that changes over
// time lives in a remote JSON config on the GitHub Pages site: which hosts spawn
// popups to close, and — expressed as a fully generic declarativeNetRequest rule
// schema — any request/response header rewrites the CDN or providers want. The
// worker fetches that config on install, on startup, every 15 minutes, AND every
// time a tab loads the site, then applies it. Because the header-rule interpreter
// is generic (it passes arbitrary header operations and conditions straight through
// to declarativeNetRequest), NEW header behavior never needs a code change or a
// reinstall — just edit the JSON. Only new *permissions* still require a reinstall
// (MV3 forbids remotely-hosted code), and this shell already requests <all_urls>.

const CONFIG_URL =
  "https://maxharington19-dot.github.io/thesecretgarden/extension-config.json";
const SITE_MATCH = "maxharington19-dot.github.io/thesecretgarden";

const STORAGE_KEY = "sg_config";
const REFRESH_ALARM = "sg-config-refresh";
const DNR_RULE_BASE = 1000; // dynamic header-rewrite rules live at 1000+
const LOG_KEY = "sg_log";       // rolling debug log, persisted so it survives SW restarts
const STATUS_KEY = "sg_status"; // last rule-apply status, read by worker/ext-logs.mjs over CDP
const LOG_MAX = 300;

// Bundled fallback so the extension works on first run before the first fetch,
// and if the site is ever unreachable. Kept intentionally small.
const DEFAULT_CONFIG = {
  version: 0,
  popupBlockPatterns: ["autoembed", "vidsrc", "cloudnestra", "2embed", "yesmovies", "player4u", "vidlink"],
  headerRules: [],
};

// ---------- config fetch + apply ----------

async function getStoredConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || DEFAULT_CONFIG;
}

// Persist a line to the console AND to chrome.storage.local. The stored buffer is
// what worker/ext-logs.mjs reads over CDP, so debugging needs no manual trip to the
// service-worker console.
async function log(msg) {
  console.log("[secret-garden] " + msg);
  try {
    const s = await chrome.storage.local.get(LOG_KEY);
    const arr = s[LOG_KEY] || [];
    arr.push({ t: Date.now(), msg });
    while (arr.length > LOG_MAX) arr.shift();
    await chrome.storage.local.set({ [LOG_KEY]: arr });
  } catch (e) {}
}

function isValidConfig(cfg) {
  return cfg && typeof cfg === "object" && Array.isArray(cfg.headerRules);
}

async function fetchAndApplyConfig() {
  let cfg, source;
  try {
    const res = await fetch(CONFIG_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const parsed = await res.json();
    if (!isValidConfig(parsed)) throw new Error("invalid config shape");
    cfg = parsed;
    source = "network";
    await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
    await log("config v" + cfg.version + " fetched and stored");
  } catch (e) {
    cfg = await getStoredConfig();
    source = "cache";
    await log("config fetch failed (" + e.message + "), using cached v" + cfg.version);
  }
  await applyHeaderRules(cfg.headerRules || [], { version: cfg.version, source });
  return cfg;
}

// Generic config-rule -> declarativeNetRequest rule. A config rule may specify:
//   condition: urlFilter, regexFilter, resourceTypes[], requestDomains[], initiatorDomains[]
//   action:    requestHeaders[]  and/or  responseHeaders[]  (each {header, operation, value})
//   priority:  number
//   cors:      false to skip the automatic Access-Control-Allow-Origin:* response header
// Back-compat convenience fields (origin/referer/removeOrigin/userAgent) still work so
// older configs keep applying. Because the arrays pass straight through, ANY future header
// manipulation is expressible in the JSON with no code change.
function toDnrRule(hr, i) {
  const requestHeaders = Array.isArray(hr.requestHeaders) ? hr.requestHeaders.slice() : [];
  const responseHeaders = Array.isArray(hr.responseHeaders) ? hr.responseHeaders.slice() : [];

  if (hr.origin) requestHeaders.push({ header: "origin", operation: "set", value: hr.origin });
  if (hr.referer) requestHeaders.push({ header: "referer", operation: "set", value: hr.referer });
  if (hr.removeOrigin) requestHeaders.push({ header: "origin", operation: "remove" });
  if (hr.userAgent) requestHeaders.push({ header: "user-agent", operation: "set", value: hr.userAgent });

  const hasAcao = responseHeaders.some((h) => (h.header || "").toLowerCase() === "access-control-allow-origin");
  if (hr.cors !== false && !hasAcao) {
    responseHeaders.push({ header: "access-control-allow-origin", operation: "set", value: "*" });
  }

  const action = { type: "modifyHeaders" };
  if (requestHeaders.length) action.requestHeaders = requestHeaders;
  if (responseHeaders.length) action.responseHeaders = responseHeaders;

  const condition = { resourceTypes: hr.resourceTypes || ["media", "xmlhttprequest", "other"] };
  if (hr.urlFilter) condition.urlFilter = hr.urlFilter;
  if (hr.regexFilter) condition.regexFilter = hr.regexFilter;
  if (hr.requestDomains) condition.requestDomains = hr.requestDomains;
  if (hr.initiatorDomains) condition.initiatorDomains = hr.initiatorDomains;

  return { id: DNR_RULE_BASE + i, priority: hr.priority || 1, action, condition };
}

// Turn config headerRules into DNR dynamic rules and swap them in atomically.
// meta = { version, source } is recorded into STATUS_KEY so the CDP harness can read
// exactly what happened without the service-worker console.
async function applyHeaderRules(headerRules, meta = {}) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const built = [];
  const errors = [];
  headerRules.forEach((hr, i) => {
    try { built.push(toDnrRule(hr, i)); }
    catch (e) { errors.push("build rule " + i + ": " + e.message); }
  });
  let appliedCount = 0;
  let mode = "batch";
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: built });
    appliedCount = built.length;
    await log("applied " + appliedCount + " header rule(s)");
  } catch (e) {
    // A single rule Chrome rejects aborts the whole batch, silently disabling ALL rules.
    // Fall back to applying one at a time so the valid rules still take effect.
    mode = "individual";
    errors.push("batch rejected: " + e.message);
    await log("batch rejected (" + e.message + "); applying individually");
    try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] }); } catch (e0) {}
    for (const rule of built) {
      try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [], addRules: [rule] }); appliedCount++; }
      catch (e2) { errors.push("rule " + rule.id + " rejected: " + e2.message); }
    }
    await log("applied " + appliedCount + "/" + built.length + " header rule(s) individually");
  }
  try {
    const active = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.storage.local.set({ [STATUS_KEY]: {
      ts: Date.now(),
      configVersion: meta.version ?? null,
      configSource: meta.source ?? null,
      builtCount: built.length,
      appliedCount,
      mode,
      errors,
      activeRuleIds: active.map((r) => r.id),
      activeRules: active,
    } });
  } catch (e) {}
}

// ---------- popup blocking (patterns come from config) ----------

function isKnown(url, patterns) {
  if (!url) return false;
  if (url.includes("thesecretgarden")) return true;
  return patterns.some((p) => url.includes(p));
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  const opener = details.sourceTabId;
  if (!opener) return;
  const cfg = await getStoredConfig();
  const patterns = cfg.popupBlockPatterns || DEFAULT_CONFIG.popupBlockPatterns;
  chrome.tabs.get(opener, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) return;
    if (isKnown(tab.url, patterns)) chrome.tabs.remove(details.tabId);
  });
});

// ---------- fast config propagation ----------

// Refresh the config whenever a tab loads the site, so editing the JSON and
// reloading the page applies new rules immediately (no waiting for the alarm).
chrome.webNavigation.onCommitted.addListener(
  () => { fetchAndApplyConfig(); },
  { url: [{ urlContains: SITE_MATCH }] }
);

// Manual refresh hook (e.g. a page can dispatch this to force an immediate update).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "sg-refresh-config") {
    fetchAndApplyConfig().then((cfg) => sendResponse({ ok: true, version: cfg.version }));
    return true; // async response
  }
});

// ---------- lifecycle ----------

function boot() {
  fetchAndApplyConfig();
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 15 });
}
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) fetchAndApplyConfig();
});
