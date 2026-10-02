// Signals the extension's presence AND its version to the page. The site gates Chrome
// playback on the version so a stale/old extension (which applies no header rules and
// silently 403s every segment) is treated as "not installed" instead of being let
// through. Old extensions set only the legacy presence attribute; the version attribute
// is what the current gate requires. Attributes are set BEFORE the event fires so a
// listener that resolves on the event can read the version synchronously.
const VERSION = chrome.runtime.getManifest().version;

const signalPresence = () => {
  if (document.body) {
    document.body.setAttribute('secret-garden-installed-o1in2weasoidf-v2', 'true');
    document.body.setAttribute('secret-garden-ext-version', VERSION);
  }
  window.dispatchEvent(new CustomEvent('extensionPresent', { detail: { version: VERSION } }));
};

signalPresence();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', signalPresence);
}

document.addEventListener('checkExtensionPresent', () => {
  window.dispatchEvent(new CustomEvent('extensionPresent', { detail: { version: VERSION } }));
});

// Relay between the page and the background worker. The page posts { __sg, dir:'req', reqId, type,
// payload }; we forward it to chrome.runtime and post the reply back as { __sg, dir:'res', reqId,
// resp }. Used so the page can ask the worker to run the Referer-gated SuperEmbed resolve chain it
// cannot run itself. postMessage (not CustomEvent) so the clone crosses the isolated world on every
// browser. See background.js (sg-resolve) and site/src/data/streams/superembed-bridge.js.
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const m = e.data;
  if (!m || m.__sg !== true || m.dir !== 'req') return;
  const reply = (resp) => window.postMessage({ __sg: true, dir: 'res', reqId: m.reqId, resp }, '*');
  try {
    chrome.runtime.sendMessage({ type: m.type, payload: m.payload }, (resp) => {
      const err = chrome.runtime.lastError;
      reply(err ? { ok: false, error: err.message } : (resp || null));
    });
  } catch (err) {
    reply({ ok: false, error: String(err) });
  }
});
