# Secret Garden Extension

Desktop Chrome/Edge/Firefox helper for the Secret Garden site. It does two things:

1. Closes the popup/ad tabs that streaming embeds try to open.
2. Rewrites `Origin`/`Referer` on chunk requests so the CDN serves them, and forces
   a permissive `Access-Control-Allow-Origin` on the response.

## Remote config (no reinstall for rule changes)

The extension is a thin, stable shell. The parts that change over time — the
popup-block host list and the header-rewrite rules — are read from a JSON file on
the live site:

`https://maxharington19-dot.github.io/thesecretgarden/extension-config.json`

The background worker fetches it on install, on browser startup, and every 30
minutes, caches the last-good copy, and applies the header rules as dynamic
declarativeNetRequest rules. To change behavior, edit that JSON and commit — every
installed extension picks it up within ~30 minutes. No reinstall.

A reinstall is only ever needed when the extension's **permissions** or **code**
change (MV3 forbids running remotely-hosted code, so new logic ships in the
package, not the config).

## Install (unpacked)

1. Chrome -> `chrome://extensions` -> enable **Developer mode** (top-right).
2. **Load unpacked** -> select this `secret_garden_extension/` folder.
3. Open the site and reload once.

To force a config refresh immediately, toggle the extension off/on at
`chrome://extensions` (fires the startup fetch).
