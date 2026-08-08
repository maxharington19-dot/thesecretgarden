
const signalPresence = () => {
  window.dispatchEvent(new Event('extensionPresent'));
  document.body?.setAttribute('secret-garden-installed-o1in2weasoidf-v2', 'true');
};

signalPresence();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', signalPresence);
}

document.addEventListener('checkExtensionPresent', () => {
  window.dispatchEvent(new Event('extensionPresent'));
});