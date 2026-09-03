// saved-filters.js — shared saved-filter chip UI for availability.html
// and compact-list.html. Stores named slots + recent filters in
// localStorage, renders them as clickable chips beside the filter row,
// and mirrors active-filter state into the URL via ?f=<base64> so any
// view is shareable.
//
// Page contract:
//   - <div class="saved-filters" id="savedFilters"></div> in the toolbar
//     area. Module mounts chips inside this element on init.
//   - Call SavedFilters.init({ get, apply, label, page }) from the page's
//     own init() once the catalog is ready.
//     get(): returns the current filter snapshot object { q, type, ... }
//     apply(snap): restores the snapshot and re-runs the catalog filter.
//     label(snap): short human-readable string for the chip text.
//     page: 'availability' | 'compact-list' — namespaces localStorage.
//
// URL contract:
//   ?f=<base64url(JSON.stringify(snap))>. Round-trip safe through
//   copy/paste + chat/share. No privacy issues since the filter is just
//   "what someone is searching for".

(function () {
  if (window.SavedFilters && window.SavedFilters.__v) return;
  const VERSION = 1;

  const STORE_KEY = 'ns_saved_filters_v1';
  const F_URL_PARAM = 'f';
  const F_RECENTS_LIMIT = 5;
  const F_SLOTS_LIMIT = 3;

  function safeJSON(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }

  function readStore() {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { slots: [null, null, null], recents: [], per: {} };
    const v = safeJSON(raw, null);
    if (!v || typeof v !== 'object') return { slots: [null, null, null], recents: [], per: {} };
    v.slots = Array.isArray(v.slots) ? v.slots.slice(0, F_SLOTS_LIMIT) : [null, null, null];
    while (v.slots.length < F_SLOTS_LIMIT) v.slots.push(null);
    v.recents = Array.isArray(v.recents) ? v.recents.slice(0, F_RECENTS_LIMIT) : [];
    v.per = (v && typeof v.per === 'object' && v.per) || {};
    return v;
  }

  function writeStore(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* quota? */ }
  }

  // Base64 of utf-8 string, URL-safe (no padding). Browser fallback.
  function b64UrlEncode(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function b64UrlDecode(s) {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function readFromURL() {
    try {
      const v = new URLSearchParams(window.location.search).get(F_URL_PARAM);
      if (!v) return null;
      const snap = safeJSON(b64UrlDecode(v), null);
      if (!snap || typeof snap !== 'object') return null;
      return snap;
    } catch (e) { return null; }
  }

  function writeToURL(snap, replace) {
    try {
      const url = new URL(window.location.href);
      if (snap) url.searchParams.set(F_URL_PARAM, b64UrlEncode(JSON.stringify(snap)));
      else url.searchParams.delete(F_URL_PARAM);
      const h = url.toString();
      if (h === window.location.href) return;
      if (replace) window.history.replaceState({}, '', h);
      else window.history.pushState({}, '', h);
    } catch (e) { /* URL writer best-effort */ }
  }

  function tsName(snap) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildChip(slotIdx, entry, kind) {
    if (!entry) {
      return `<span class="sf-chip sf-slot sf-empty" data-slot="${slotIdx}">` +
        `<button type="button" class="sf-slot-btn" aria-label="Save current filter to slot ${slotIdx + 1}">★ Star</button>` +
        `</span>`;
    }
    return `<span class="sf-chip sf-slot" data-slot="${slotIdx}">` +
      `<button type="button" class="sf-apply" data-kind="${kind}" data-idx="${slotIdx}" title="${escAttr(entry.label || entry.label || '')} (${new Date(entry.ts).toLocaleString()})">` +
      `★ ${escAttr(entry.label || 'Saved')}` +
      `</button>` +
      `<button type="button" class="sf-del" aria-label="Clear slot ${slotIdx + 1}" title="Remove">×</button>` +
      `</span>`;
  }

  function buildRecentChip(entry, idx) {
    return `<span class="sf-chip sf-recent" data-recent="${idx}">` +
      `<button type="button" class="sf-apply" data-kind="recent" data-idx="${idx}" title="Apply this filter">` +
      `${escAttr(entry.label || '')}</button>` +
      `<button type="button" class="sf-del" aria-label="Remove">×</button>` +
      `</span>`;
  }

  function renderInto(mount, store, page) {
    const slotsHtml = store.slots.map((s, i) => buildChip(i, s, 'slot')).join('');
    const recentsHtml = store.recents.map((r, i) => buildRecentChip(r, i)).join('');
    // Compact inline layout — chips + tools on a single row, separated by
    // a thin divider. Empty slots render as a single "★ Star" placeholder
    // chip so the user understands they're there to fill. Recents collapse
    // into the same row, prefixed by "Recent:" only when non-empty.
    const recentsSection = recentsHtml
      ? '<span class="sf-recent-label">Recent:</span>' + recentsHtml
      : '';
    mount.innerHTML =
      `<div class="sf-row sf-row-main">` +
        `<span class="sf-label">Saved:</span>${slotsHtml}` +
        recentsSection +
        `<span class="sf-divider" aria-hidden="true"></span>` +
        `<button type="button" class="sf-tool sf-save" title="Save the current filter to a slot">＋ Save view</button>` +
        `<button type="button" class="sf-tool sf-share" title="Copy a link to this view">🔗 Share</button>` +
      `</div>`;
  }

  function create({ get, apply, label, page }) {
    const mount = document.getElementById('savedFilters');
    if (!mount) return; // page didn't include the mount node; nothing to do

    const store = readStore();

    // 1) URL → apply: if the page was loaded with ?f=... (or pushed via
    //    history.back), apply that snapshot first.
    const fromUrl = readFromURL();
    if (fromUrl) {
      try { apply(fromUrl); } catch (e) { console.warn('[saved-filters] apply failed', e); }
    }

    function doRender() { renderInto(mount, store, page); }

    function rememberCurrent(snap) {
      // No last-active recording on its own — we wait for the user to
      // press "Save current view" or to navigate away, whichever.
      return snap;
    }

    function snapshot() {
      let snap;
      try { snap = get(); } catch (e) { snap = null; }
      if (!snap || typeof snap !== 'object') return null;
      return snap;
    }

    // Public API the page can call when its filter changes (so the
    // "recent" can be re-written to keep this view at the top). Use
    // sparingly — every keystroke would be too much. Best hook: tag
    // changes as "settled" after the user pauses typing OR on submit
    // of the search box.
    function commitActive(opts) {
      const o = opts || {};
      const snap = snapshot();
      if (!snap) return;
      writeToURL(snap, o.replace !== false);
      if (o.skipRemember) return;
      // Maintain a "last active" entry under per[page]; differs from
      // recents (which stores explicit user-applied views only). Used
      // by the page on reload if no ?f= and no recents slot match.
      store.per = store.per || {};
      store.per[page] = { snap, ts: Date.now() };
      writeStore(store);
    }

    function rememberApplied(snap) {
      // Push snap onto the recents (LIFO dedup by label). Called when the
      // user clicks an existing chip, so "what I just re-used" floats up.
      if (!snap || typeof snap !== 'object') return;
      const lbl = (label ? label(snap) : '') || tsName();
      const without = (store.recents || []).filter((r) => (r.label || '') !== lbl);
      without.unshift({ snap, label: lbl, ts: Date.now() });
      store.recents = without.slice(0, F_RECENTS_LIMIT);
      writeStore(store);
    }

    // === Bind handlers ===
    mount.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const applyBtn = t.closest('.sf-apply');
      const delBtn = t.closest('.sf-del');
      const slotBtn = t.closest('.sf-slot-btn');

      if (applyBtn) {
        const kind = applyBtn.getAttribute('data-kind');
        const idx = parseInt(applyBtn.getAttribute('data-idx'), 10);
        let entry = null;
        if (kind === 'slot') entry = store.slots[idx];
        else if (kind === 'recent') entry = store.recents[idx];
        if (entry && entry.snap) {
          try { apply(entry.snap); } catch (e) { console.warn('[saved-filters] apply failed', e); }
          rememberApplied(entry.snap);
          writeToURL(entry.snap, true);
          doRender();
        }
        return;
      }
      if (delBtn) {
        const chip = delBtn.closest('[data-slot],[data-recent]');
        if (!chip) return;
        if (chip.hasAttribute('data-slot')) {
          const idx = parseInt(chip.getAttribute('data-slot'), 10);
          store.slots[idx] = null;
        } else {
          const idx = parseInt(chip.getAttribute('data-recent'), 10);
          store.recents.splice(idx, 1);
        }
        writeStore(store);
        doRender();
        return;
      }
      if (slotBtn) {
        // Empty slot — promote to save-to-slot form.
        const slotIdx = parseInt(slotBtn.closest('[data-slot]').getAttribute('data-slot'), 10);
        promptSaveToSlot(slotIdx, doRender, snapshot, store);
        return;
      }
      if (t.classList.contains('sf-save')) {
        promptSaveToSlot(null, doRender, snapshot, store);
        return;
      }
      if (t.classList.contains('sf-share')) {
        const snap = snapshot();
        if (!snap) return;
        writeToURL(snap, true);
        const url = window.location.href;
        copyToClipboard(url).then((ok) => {
          t.textContent = ok ? '✓ Copied link' : '✗ Copy failed';
          t.disabled = true;
          setTimeout(() => { t.textContent = '🔗 Share this view'; t.disabled = false; }, 1800);
        });
        return;
      }
    });

    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
      }
      return Promise.resolve(fallbackCopy(text));
    }
    function fallbackCopy(text) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }

    function promptSaveToSlot(preferredIdx, doRender, snapshot, store) {
      const snap = snapshot();
      if (!snap) {
        alert('Set a filter first, then save it.');
        return;
      }
      const slots = store.slots;
      // Pick first empty slot, or first slot if all filled.
      let idx = preferredIdx;
      if (idx == null) idx = slots.findIndex((s) => !s);
      if (idx < 0 || idx >= slots.length) idx = 0;
      const defaultName = (label ? label(snap) : '') || tsName();
      const name = window.prompt('Name this saved view:', defaultName);
      if (name == null) return; // cancelled
      slots[idx] = { snap, label: String(name).trim() || defaultName, ts: Date.now() };
      writeStore(store);
      doRender();
    }

    doRender();

    // Listen for back/forward when the URL has a filter param.
    window.addEventListener('popstate', () => {
      const fromUrl = readFromURL();
      if (!fromUrl) return;
      try { apply(fromUrl); } catch (e) { /* ignore */ }
    });

    return { commit: commitActive, snapshot, store };
  }

  window.SavedFilters = { __v: VERSION, create, readFromURL, writeToURL, b64UrlEncode, b64UrlDecode };
})();
