// Secret Garden background worker.
//
// The extension package is a thin, stable shell. The behavior that actually
// changes over time — which hosts spawn popups to close, and the Origin/Referer
// header rewrites the CDN wants — lives in a remote JSON config on the GitHub
// Pages site. This worker fetches that config on install, on startup, and every
// 30 minutes, then applies it. Editing the JSON on the site deploys new behavior
// to every installed extension with no reinstall. (New *permissions* or new
// *code* still need a reinstall — MV3 forbids remotely-hosted code.)

const CONFIG_URL =
  "https://maxharington19-dot.github.io/thesecretgarden/extension-config.json";

const STORAGE_KEY = "sg_config";
const REFRESH_ALARM = "sg-config-refresh";
const DNR_RULE_BASE = 1000; // dynamic header-rewrite rules live at 1000+

// Bundled fallback so the extension works on first run before the first fetch,
// and if the site is ever unreachable. Kept intentionally small.
const DEFAULT_CONFIG = {
  version: 0,
  popupBlockPatterns: [
    "autoembed",
    "vidsrc",
    "cloudnestra",
    "2embed",
    "yesmovies",
    "player4u",
    "vidlink",
  ],
  headerRules: [],
};

// ---------- config fetch + apply ----------

async function getStoredConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || DEFAULT_CONFIG;
}

function isValidConfig(cfg) {
  return (
    cfg &&
    typeof cfg === "object" &&
    Array.isArray(cfg.popupBlockPatterns) &&
    Array.isArray(cfg.headerRules)
  );
}

async function fetchAndApplyConfig() {
  let cfg;
  try {
    const res = await fetch(CONFIG_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const parsed = await res.json();
    if (!isValidConfig(parsed)) throw new Error("invalid config shape");
    cfg = parsed;
    await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
    console.log("[secret-garden] config v" + cfg.version + " fetched and stored");
  } catch (e) {
    // Fall back to last-good (or bundled default) so behavior degrades gracefully.
    cfg = await getStoredConfig();
    console.warn(
      "[secret-garden] config fetch failed (" + e.message + "), using cached v" + cfg.version
    );
  }
  await applyHeaderRules(cfg.headerRules);
  return cfg;
}

// Turn config headerRules into declarativeNetRequest dynamic rules and swap them
// in atomically, replacing any previously installed header rules.
async function applyHeaderRules(headerRules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules = headerRules.map((hr, i) => {
    const requestHeaders = [];
    if (hr.origin) {
      requestHeaders.push({ header: "origin", operation: "set", value: hr.origin });
    }
    if (hr.referer) {
      requestHeaders.push({ header: "referer", operation: "set", value: hr.referer });
    }
    if (hr.removeOrigin) {
      requestHeaders.push({ header: "origin", operation: "remove" });
    }
    if (hr.userAgent) {
      requestHeaders.push({ header: "user-agent", operation: "set", value: hr.userAgent });
    }
    return {
      id: DNR_RULE_BASE + i,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders,
        responseHeaders: [
          { header: "access-control-allow-origin", operation: "set", value: "*" },
        ],
      },
      condition: {
        urlFilter: hr.urlFilter,
        resourceTypes: hr.resourceTypes || ["media", "xmlhttprequest", "other"],
      },
    };
  });

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  console.log("[secret-garden] applied " + addRules.length + " header rule(s)");
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
    if (isKnown(tab.url, patterns)) {
      chrome.tabs.remove(details.tabId);
    }
  });
});

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(() => {
  fetchAndApplyConfig();
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 30 });
});

chrome.runtime.onStartup.addListener(() => {
  fetchAndApplyConfig();
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 30 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) fetchAndApplyConfig();
});
