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
