/* Native Sons PWA install banner — shared between availability.html
 * and compact-list.html (and any future page that wants the banner).
 *
 * Behavior:
 *   - On Android Chrome / desktop Chromium: shows the real "Install"
 *     button; click triggers `beforeinstallprompt` and the OS install
 *     UI. Falls back to showing the button after 4s even if no event has
 *     fired yet (handles slow-to-fire cases).
 *   - On iOS Safari: hides the Install button and shows a text span
 *     "Tap Share → Add to Home Screen" (iOS has no programmatic PWA
 *     install API; the Share → Add to Home Screen menu is the canonical
 *     install flow). UI engine never blocked by an unimplemented event.
 *   - × dismisses the banner and sets a localStorage flag so the user
 *     doesn't see it again. `?reset-pwa=1` in the URL clears the flag.
 *
 * No deps — globals used: document, window, navigator, localStorage,
 * URLSearchParams. Safe to load in <head> or before/after other scripts.
 */
(function () {
  if (window.__nsPwaInit) return; // idempotent if accidentally loaded twice

  const STORAGE_KEY_DEFAULT = 'ns_pwa_install_dismissed';
  const SHOW_DELAY_MS = 4000;
  const INSTRUCTIONS_HTML =
    'Tap <strong>Share</strong> → <strong>Add to Home Screen</strong>';

  function isIosSafari(ua) {
    // Crios / Chrome-iOS / FxiOS webviews aren't real iOS Safari — they
    // handle beforeinstallprompt differently or have their own install
    // path. Only flag genuine WebKit iOS as the fallback target.
    return /iphone|ipad|ipod/.test(ua)
      && /safari/.test(ua)
      && !/crios|fxios|chrome|android/.test(ua);
  }

  function detectIosSafari() {
    return isIosSafari((navigator.userAgent || '').toLowerCase());
  }

  function dismissedAlready(storageKey) {
    try { return localStorage.getItem(storageKey) === '1'; }
    catch (e) { return false; }
  }

  function dismiss(banner, storageKey) {
    banner.hidden = true;
    try { localStorage.setItem(storageKey, '1'); } catch (e) {}
    document.body.classList.add('pwa-hidden');
  }

  function armDismiss(banner, storageKey) {
    const no = banner.querySelector('.install-no');
    if (!no) return;
    no.addEventListener('click', () => dismiss(banner, storageKey));
  }

  /** iOS Safari path. Replace the Install button with text instructions
   * and reveal the banner after the same 4s delay as Android's fallback. */
  function initIosPath(banner, storageKey) {
    const yes = banner.querySelector('.install-yes');
    const instr = banner.querySelector('.install-instructions');
    if (yes) yes.hidden = true;
    if (instr) {
      instr.innerHTML = INSTRUCTIONS_HTML;
      instr.hidden = false;
    }
    armDismiss(banner, storageKey);
    setTimeout(() => {
      if (!document.body.classList.contains('pwa-hidden')) banner.hidden = false;
    }, SHOW_DELAY_MS);
  }

  /** Standard PWA-install path (Android Chrome / desktop Chromium /
   * Samsung Internet / etc.). Uses the `beforeinstallprompt` event. */
  function initChromiumPath(banner, storageKey) {
    let promptEvent = null;
    const show = () => { banner.hidden = false; };
    const hide = (reason) => dismiss(banner, storageKey);

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      promptEvent = e;
      show();
    });
    window.addEventListener('appinstalled', () => hide('installed'));

    const yes = banner.querySelector('.install-yes');
    if (yes) {
      yes.addEventListener('click', async () => {
        if (!promptEvent) return;
        promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        hide(choice && choice.outcome === 'dismissed' ? 'dismiss' : 'installed');
        promptEvent = null;
      });
    }
    armDismiss(banner, storageKey);

    // Best-effort fallback for browsers that fire the event slowly.
    setTimeout(() => {
      if (!promptEvent && !document.body.classList.contains('pwa-hidden')) {
        if (/android/i.test(navigator.userAgent || '')) show();
      }
    }, SHOW_DELAY_MS);
  }

  /**
   * Initialize the install banner. Idempotent — calling twice is a no-op.
   * @param {object} [opts]
   * @param {string} [opts.storageKey] override the localStorage key.
   * @param {boolean} [opts.debug]      log path selection to console.
   */
  window.__nsPwaInit = function init(opts) {
    opts = opts || {};
    const storageKey = opts.storageKey || STORAGE_KEY_DEFAULT;
    const debug = !!opts.debug;

    const banner = document.getElementById('pwa-install');
    if (!banner || banner.__nsPwaWired) return;
    banner.__nsPwaWired = true;

    // Already installed as a PWA — nothing to do.
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return;

    // ?reset-pwa=1 — clear the dismissed flag for re-deciding.
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('reset-pwa') === '1') {
        localStorage.removeItem(storageKey);
        params.delete('reset-pwa');
        const next = params.toString();
        const url = window.location.pathname + (next ? '?' + next : '') + window.location.hash;
        window.history.replaceState({}, '', url);
      }
    } catch (e) { /* URL parsing failed — skip */ }

    if (dismissedAlready(storageKey)) {
      document.body.classList.add('pwa-hidden');
      return;
    }

    if (detectIosSafari()) {
      if (debug) console.log('[pwa-install] iOS Safari path');
      initIosPath(banner, storageKey);
    } else {
      if (debug) console.log('[pwa-install] Chromium path (beforeinstallprompt)');
      initChromiumPath(banner, storageKey);
    }
  };
})();
