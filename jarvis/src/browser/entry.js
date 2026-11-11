// Standalone JARVIS: the whole assistant running inside one web page.
// The dashboard modules start first and wait for setBackend(); meanwhile
// this boots the kernel on browser storage, after an unlock if needed.
import '../../public/js/main.js';
import { Jarvis } from '../core/jarvis.js';
import { BrowserStore } from './store.js';
import { createRouter } from './router.js';
import { createBrowserSystem } from './system.js';
import { setBackend } from './api.js';

function unlockScreen(store) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.setAttribute('aria-labelledby', 'unlock-title');
    dialog.innerHTML = `
      <h2 id="unlock-title">JARVIS is locked</h2>
      <p>Your data on this device is encrypted. Enter your passphrase to unlock it.</p>
      <form class="stack" method="dialog">
        <label class="field"><span>Passphrase</span><input type="password" autocomplete="current-password" required></label>
        <p class="field" role="alert" data-error style="color: var(--critical-text); min-height: 1.2em"></p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" data-erase>Forgot it? Erase all data</button>
          <button type="submit" class="btn btn-primary">Unlock</button>
        </div>
      </form>`;
    document.body.append(dialog);
    const input = dialog.querySelector('input');
    const error = dialog.querySelector('[data-error]');
    const submit = dialog.querySelector('button[type="submit"]');
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = 'Unlocking';
      try {
        await store.unlock(input.value);
        dialog.close();
        dialog.remove();
        resolve();
      } catch (e) {
        error.textContent = e.message;
        input.select();
      } finally {
        submit.disabled = false;
      }
    });
    dialog.querySelector('[data-erase]').addEventListener('click', () => {
      if (!window.confirm('Erase every task, reminder, conversation, setting and saved key in this browser? This cannot be undone.')) return;
      store.eraseAll();
      location.reload();
    });
    dialog.showModal();
    input.focus();
  });
}

async function boot() {
  const store = BrowserStore.create();
  if (store.isLocked()) await unlockScreen(store);
  else await store.load();

  const jarvis = new Jarvis({
    store,
    dataDir: null,
    env: {},
    logger: { log() {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) },
    storageLabel: store.persistent ? 'This browser only (local storage on this device)' : 'This tab only (browser storage is blocked, so nothing is saved)',
  });
  // Encryption follows the passphrase, so report it live.
  Object.defineProperty(jarvis, 'encryption', {
    configurable: true,
    get: () => (store.encrypted
      ? { enabled: true, algorithm: 'AES-256-GCM', keySource: 'your passphrase' }
      : { enabled: false, algorithm: 'AES-256-GCM', keySource: 'none', hint: 'set a passphrase in Settings, Privacy' }),
  });
  const baseReport = jarvis.privacyReport.bind(jarvis);
  jarvis.privacyReport = () => ({ ...baseReport(), passphrase: { supported: true, enabled: store.encrypted } });
  store.onError = (error) => {
    console.error('[jarvis] could not save to browser storage', error);
    jarvis.events.publish('storage.error', { message: error.message });
  };

  await jarvis.ready();
  const router = createRouter(jarvis, { system: createBrowserSystem(), store });
  setBackend({ jarvis, router, store });
  window.addEventListener('pagehide', () => { jarvis.learning.persist(); });
}

boot().catch((error) => {
  console.error('[jarvis] failed to start', error);
  document.body.insertAdjacentHTML('beforeend', `<div class="toasts"><div class="toast is-error">JARVIS could not start: ${String(error.message).replace(/[<>&]/g, '')}</div></div>`);
});
