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

// ---------- SuperEmbed live resolve ----------
//
// The page cannot run the SuperEmbed resolve chain: playvideo.php -> vipstream_vfx.php send no
// CORS header and are Referer-gated. This worker can — host permissions bypass CORS, and a
// per-request session DNR rule sets the Referer. Given a title's resolve token + a server's ids,
// it returns a FRESH, directly-playable HLS master. The page asks via its content-script relay
// (window.postMessage -> chrome.runtime). See site/src/data/streams/superembed-bridge.js.
//
// The decoder below mirrors site/src/data/streams/superembed-vfx.js (pure arithmetic, no eval),
// kept in sync by hand. The master ships inside a per-page packer; we replicate it so the real
// CDN URL (which the scrubbing proxy does not rewrite inside the blob) comes out playable.

const SE_RULE_ID = 9100; // session DNR rule id for the resolve-chain Referer (far above DNR_RULE_BASE)
const SE_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";

function seConvertBase(digits, fromBase, alphabet) {
  const from = alphabet.slice(0, fromBase).split("");
  let n = digits.split("").reverse().reduce(
    (acc, ch, i) => (from.indexOf(ch) !== -1 ? acc + from.indexOf(ch) * Math.pow(fromBase, i) : acc), 0);
  let out = "";
  while (n > 0) { out = (n % 10) + out; n = (n - (n % 10)) / 10; }
  return out || "0";
}

function seUnpackVfx(html) {
  const s = String(html == null ? "" : html);
  const call = s.match(/return decodeURIComponent\(escape\(r\)\)\}\("([^"]*)",(\d+),"([^"]*)",(\d+),(\d+),(\d+)\)/);
  if (!call) return null;
  const h = call[1], n = call[3], t = +call[4], e = +call[5];
  const alphaM = s.match(/"(0123456789[a-zA-Z]{50,}\+\/)"/);
  const alphabet = alphaM ? alphaM[1] : SE_ALPHABET;
  const delim = n[e];
  let r = "";
  for (let i = 0; i < h.length; i++) {
    let tok = "";
    while (i < h.length && h[i] !== delim) { tok += h[i]; i++; }
    for (let j = 0; j < n.length; j++) tok = tok.split(n[j]).join(String(j));
    r += String.fromCharCode(seConvertBase(tok, e, alphabet) - t);
  }
  try { return decodeURIComponent(escape(r)); } catch { return r; }
}

function seFileFromVfx(html) {
  const decoded = seUnpackVfx(html);
  if (!decoded) return null;
  const fileM = decoded.match(/["']?file["']?\s*:\s*["']([^"']+)["']/);
  if (!fileM) return null;
  const posterM = decoded.match(/["']?poster["']?\s*:\s*["']([^"']+)["']/);
  return { file: fileM[1].replace(/\\\//g, "/"), poster: posterM ? posterM[1].replace(/\\\//g, "/") : null };
}

function seVfxLinkFromPlayvideo(html) {
  const m = String(html == null ? "" : html).match(/vipstream_vfx\.php\?s=(\d+)&token=([^"'&\s\\]+)/);
  if (!m) return null;
  return { path: `vipstream_vfx.php?s=${m[1]}&token=${m[2]}` };
}

// --- File-host (non-VIP) servers. Mirrors site/src/data/streams/filehost.js + packer.js. ---
// Dean-Edwards unpacker (the wrapper around StreamWish/Mixdrop embed players).
function seUnpackDeanEdwards(src) {
  const m = String(src).match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?return p\}\('((?:\\.|[^'\\])*)',(\d+),(\d+),'((?:\\.|[^'\\])*)'\.split\('\|'\)/);
  if (!m) return null;
  let p = m[1]; const a = +m[2], c = +m[3], k = m[4].split("|");
  try { p = p.replace(/\\'/g, "'").replace(/\\n/g, "\n"); } catch (e) {}
  const digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const tok = (n) => { if (n === 0) return "0"; let s = ""; while (n) { s = digits[n % a] + s; n = Math.floor(n / a); } return s; };
  for (let i = c - 1; i >= 0; i--) { if (!k[i]) continue; p = p.replace(new RegExp("\\b" + tok(i) + "\\b", "g"), k[i]); }
  return p;
}
function seUnpackAll(html) {
  const re = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?return p\}\('(?:\\.|[^'\\])*',\d+,\d+,'(?:\\.|[^'\\])*'\.split\('\|'\)[^)]*\)/g;
  const s = String(html); const out = []; let m;
  while ((m = re.exec(s))) { const u = seUnpackDeanEdwards(m[0]); if (u) out.push(u); }
  return out.length ? out.join("\n") : s;
}
function seEmbedFromPlayvideo(html) {
  const s = String(html == null ? "" : html);
  const pats = [
    { provider: "streamwish", re: /https?:\/\/[a-z0-9.-]*(?:streamwish\.to|niramirus\.com)\/e\/[a-z0-9]+/i },
    { provider: "mixdrop", re: /https?:\/\/[a-z0-9.-]*mix?drop[0-9]*\.(?:net|top|co|to|club|ps)\/e\/[a-z0-9]+/i },
  ];
  for (const p of pats) { const m = s.match(p.re); if (m) return { provider: p.provider, url: m[0] }; }
  return null; // abyss / koko / doodstream: no playable manifest
}
function seHlsFromStreamwish(html) {
  const u = seUnpackAll(html);
  const m = u.match(/"hls2":"(https:[^"]+)"/) || u.match(/"hls3":"(https:[^"]+)"/) ||
    u.match(/"hls4":"(https:[^"]+)"/) || u.match(/file:\s*"(https:[^"]+\.m3u8[^"]*)"/);
  if (!m) return null;
  const url = m[1].replace(/\\u0026/g, "&").replace(/\\"/g, '"');
  return url.includes("null") ? null : url;
}
function seMp4FromMixdrop(html) {
  const u = seUnpackAll(html);
  const m = u.match(/MDCore\.wurl\s*=\s*"([^"]+)"/) || u.match(/\bwurl\s*=\s*"([^"]+)"/);
  if (!m || !m[1]) return null;
  let url = m[1].trim(); if (url.startsWith("//")) url = "https:" + url;
  return /^https:\/\/\S+\.mp4/i.test(url) ? url : null;
}

// Resolve one file-host server: playvideo.php -> embed URL -> fetch embed page -> unpack -> URL.
async function seResolveFilehostServer(base, host, dataId, serverId, token) {
  const pvUrl = `${base}/playvideo.php?video_id=${encodeURIComponent(dataId)}&server_id=${encodeURIComponent(serverId)}&token=${encodeURIComponent(token)}`;
  const pv = await seFetchText(host, "/playvideo.php", pvUrl, base + "/");
  const embed = seEmbedFromPlayvideo(pv.text);
  if (!embed) return null; // abyss/koko/doodstream or nothing embeddable
  let embedHost;
  try { embedHost = new URL(embed.url).hostname; } catch (e) { return null; }
  // The embed host serves its player; SuperEmbed is the embedder, so Referer = the play host.
  const page = await seFetchText(embedHost, "/e/", embed.url, base + "/");
  if (embed.provider === "streamwish") {
    const u = seHlsFromStreamwish(page.text);
    return u ? { manifestUrl: u, kind: "hls" } : null;
  }
  if (embed.provider === "mixdrop") {
    const u = seMp4FromMixdrop(page.text);
    return u ? { manifestUrl: u, kind: "mp4" } : null;
  }
  return null;
}

// Set the Referer the resolve pages require, scoped to one path on the resolve host. Chrome's
// fetch() cannot set Referer (forbidden header), so a session DNR rule does it for THIS worker's
// own request. One rule at a time (removeRuleIds clears the previous), so each fetch gets its own.
async function seSetReferer(host, pathFilter, referer) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [SE_RULE_ID],
    addRules: [{
      id: SE_RULE_ID,
      priority: 10,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: referer }] },
      condition: { urlFilter: pathFilter, requestDomains: [host], resourceTypes: ["xmlhttprequest", "other"] },
    }],
  });
}
async function seClearReferer() {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [SE_RULE_ID] }); } catch (e) {}
}

// credentials:"include" so the browser's cf_clearance + site cookies (set when a real browser
// cleared the play page's Turnstile) ride along — the resolve endpoints gate on them.
async function seFetchText(host, pathFilter, url, referer, init = {}) {
  await seSetReferer(host, pathFilter, referer);
  const res = await fetch(url, { credentials: "include", cache: "no-store", redirect: "follow", ...init });
  const text = await res.text();
  return { text, finalUrl: res.url };
}

// Minimal server-list parser for a response.php page: ordered { server, serverId, dataId, quality }
// rows. Mirrors site/src/data/streams/superembed-parse.js.
function seParseServers(html) {
  const s = String(html == null ? "" : html);
  const out = [];
  const liRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(s))) {
    const dataId = (m[1].match(/data-id="([^"]*)"/) || [])[1];
    const serverId = (m[1].match(/data-server="(\d+)"/) || [])[1];
    const nameM = m[2].match(/server-image\s+server-([^"\s]+)/);
    if (!dataId || !serverId || !nameM) continue;
    const qualM = m[2].match(/<span class="quality">([^<]*)<\/span>/);
    out.push({ server: nameM[1], serverId, dataId, quality: qualM ? qualM[1].trim() : null });
  }
  return out;
}

// Rank for "most reliable server at the highest quality." Mirrors superembed-rank.js.
function seReliabilityTier(server) {
  const s = String(server || "");
  if (/^vipstream/i.test(s)) return 0; // native HLS, same CDN as the primary source
  if (/streamwish/i.test(s)) return 1; // third-party HLS
  if (/mixdrop/i.test(s)) return 2;    // Referer-gated progressive MP4
  return 99;                           // abyss/koko/doodstream: no playable manifest
}
function seQualityScore(q) {
  const s = String(q || "").toLowerCase();
  if (/2160|\b4k\b|uhd/.test(s)) return 2160;
  if (/1440|\b2k\b/.test(s)) return 1440;
  if (/1080|fhd/.test(s)) return 1080;
  if (/multi|auto|adaptive/.test(s)) return 1081;
  if (/720|\bhd\b/.test(s)) return 720;
  if (/480/.test(s)) return 480;
  if (/360/.test(s)) return 360;
  return 0;
}
function seRankServers(servers) {
  return (servers || [])
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && r.serverId && r.dataId && seReliabilityTier(r.server) !== 99)
    .sort((a, b) =>
      seReliabilityTier(a.r.server) - seReliabilityTier(b.r.server) ||
      seQualityScore(b.r.quality) - seQualityScore(a.r.quality) ||
      a.i - b.i)
    .map(({ r }) => r);
}

// One VIP server: playvideo.php (Referer = play host root) -> vipstream_vfx.php (Referer = the
// playvideo URL) -> decode. `base` is the play host, `token` the ?play token for this title.
async function seResolveVipServer(base, host, dataId, serverId, token) {
  const pvUrl = `${base}/playvideo.php?video_id=${encodeURIComponent(dataId)}&server_id=${encodeURIComponent(serverId)}&token=${encodeURIComponent(token)}`;
  const pv = await seFetchText(host, "/playvideo.php", pvUrl, base + "/");
  const link = seVfxLinkFromPlayvideo(pv.text);
  if (!link) return null;
  const vfxUrl = `${base}/${link.path}`;
  const vfx = await seFetchText(host, "/vipstream_vfx.php", vfxUrl, pvUrl);
  const d = seFileFromVfx(vfx.text);
  if (!d || !d.file) return null;
  return { manifestUrl: d.file, poster: d.poster, serverId: String(serverId) };
}

// Manual per-server path: caller already has the ?play token + a server's ids.
async function resolveSuperembed({ origin, dataId, serverId, token }) {
  if (!origin || !dataId || !serverId || !token) return null;
  const base = String(origin).replace(/\/$/, "");
  let host;
  try { host = new URL(base).hostname; } catch (e) { return null; }
  try { return await seResolveVipServer(base, host, dataId, serverId, token); }
  catch (e) { return null; }
  finally { await seClearReferer(); }
}

// On-demand, any-title: entry (title id -> ?play token, ungated) -> response.php (server list) ->
// first resolvable VIP server. Returns { manifestUrl, server, serverId } | { needsArming:true } | null.
// `needsArming` = the server list came back empty/gated, i.e. the session has not cleared the play
// page's Turnstile yet (one real-browser pass arms it).
async function resolveSuperembedTitle({ entryHost, playHost, tmdbId, imdbId }) {
  if (!entryHost || !playHost || (tmdbId == null && !imdbId)) return null;
  const entryBase = `https://${entryHost}`.replace(/\/$/, "");
  const playBase = `https://${playHost}`.replace(/\/$/, "");
  let eHostname, pHostname;
  try { eHostname = new URL(entryBase).hostname; pHostname = new URL(playBase).hostname; }
  catch (e) { return null; }

  try {
    // 1. Entry mints a fresh, ungated ?play token (redirect to the play page). video_id takes a
    //    tmdb id (&tmdb=1); imdb ids go through the same param without the flag.
    const entryUrl = tmdbId != null
      ? `${entryBase}/?video_id=${encodeURIComponent(tmdbId)}&tmdb=1`
      : `${entryBase}/?video_id=${encodeURIComponent(imdbId)}`;
    const entry = await seFetchText(eHostname, "/", entryUrl, entryBase + "/");
    const playMatch = (String(entry.finalUrl || "").match(/[?&]play=([^&]+)/) ||
      String(entry.text || "").match(/[?&]play=([^&"'\s]+)/));
    const playToken = playMatch ? decodeURIComponent(playMatch[1]) : null;
    if (!playToken) return { needsArming: true };

    // 2. response.php lists all servers for the title (gates on the armed session's cookie).
    const respUrl = `${playBase}/response.php`;
    const resp = await seFetchText(pHostname, "/response.php", respUrl, playBase + "/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=" + encodeURIComponent(playToken),
    });
    const servers = seParseServers(resp.text);
    if (!servers.length) return { needsArming: true };

    // 3. Resolve in ranked order — most reliable tier first, highest quality within a tier — and
    //    keep the FIRST server that returns a real URL (so we stop at the best reachable one, not
    //    the first listed). VIP resolves via vipstream_vfx; file-hosts via their embed unpackers.
    for (const r of seRankServers(servers)) {
      const vip = /^vipstream/i.test(r.server);
      let hit = null;
      try {
        hit = vip
          ? await seResolveVipServer(playBase, pHostname, r.dataId, r.serverId, playToken)
          : await seResolveFilehostServer(playBase, pHostname, r.dataId, r.serverId, playToken);
      } catch (e) { hit = null; }
      if (hit && hit.manifestUrl)
        return { manifestUrl: hit.manifestUrl, server: r.server, serverId: r.serverId, quality: r.quality || null, kind: hit.kind || "hls" };
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    await seClearReferer();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "sg-resolve") {
    resolveSuperembed(msg.payload || {})
      .then((result) => sendResponse({ ok: !!(result && result.manifestUrl), result }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }
  if (msg && msg.type === "sg-resolve-title") {
    resolveSuperembedTitle(msg.payload || {})
      .then((result) => sendResponse({ ok: !!(result && result.manifestUrl), result }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
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
