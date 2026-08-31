// reorder.js — shared "reorder a past order into the current cart" flow.
//
// Two entry points:
//   - Reorder.fromConfirmationButton(el, orderNumber, email)  -- confirmation.html
//   - Reorder.fromQuery()                                    -- availability.html
//
// Both call public.get_reorder_items via fetch, then resolve each
// returned item against the current week's availability + master item
// codes so the cart row is keyed identically to one created by
// compact-list's quick order (item_code, upc, current week's price).
// Items that have rolled out of stock are surfaced as a 'skipped'
// list — the customer sees the list and can choose to add
// substitutes manually.
(function () {
  if (window.Reorder && window.Reorder.__v) return;
  const VERSION = 1;

  // Anon key from supabase-config.js. No service-role reads — the
  // SQL RPC is SECURITY DEFINER and only reveals rows when the
  // email matches.
  const cfg = window.SUPABASE_CONFIG || {};
  const RPC_URL = cfg.url
    ? `${cfg.url.replace(/\/+$/, '')}/rest/v1/rpc/get_reorder_items`
    : null;

  function callRpc(orderNumber, email) {
    if (!RPC_URL) {
      return Promise.reject(new Error('Supabase config missing; cannot call get_reorder_items.'));
    }
    const headers = {
      'apikey': cfg.anonKey,
      'Authorization': 'Bearer ' + cfg.anonKey,
      'Content-Type': 'application/json',
    };
    return fetch(RPC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_order_number: orderNumber, p_email: email }),
    }).then((r) => {
      if (!r.ok) throw new Error('RPC ' + r.status);
      return r.json();
    });
  }

  // Resolve a saved item against the live catalog. Falls back to the
  // past unit_price when the plant is no longer in stock — the user
  // will see "out of stock" on the message, but the pricing line still
  // gets a number so any downstream display doesn't NaN.
  // Returns { key, name, size, price, qty, item_code, upc, status } where
  // status is one of 'ok' | 'plant_dropped' | 'size_dropped'.
  function resolveItem(item, catalog, codeIndex) {
    const wantName = String(item.plant_name || '').trim();
    const wantSize = String(item.plant_size || '').trim();
    const wantQty = Math.max(1, parseInt(item.qty || 1, 10) || 1);
    if (!wantName) return { status: 'plant_dropped', reason: 'missing name' };

    // 1. Item-code lookup via master codes (most precise).
    const codeHit = lookupItemCode(wantName, wantSize, codeIndex);
    if (codeHit && codeHit.plant) {
      return {
        status: 'ok',
        key: codeHit.plant.botanical + '|' + codeHit.plant.size,
        plant: codeHit.plant,
        qty: wantQty,
        item_code: codeHit.code,
        upc: codeHit.upc,
      };
    }

    // 2. Normalized exact botanical match in the live catalog.
    const exact = (catalog || []).find((p) =>
      normForMatch(p.botanical) === normForMatch(wantName)
    );
    if (exact) {
      const sizes = exact.sizes || [];
      const sizeHit = sizes.find((s) => normSize(s.container) === normSize(wantSize));
      if (sizeHit) {
        const codeInfo = lookupItemCode(exact.botanical, sizeHit.container, codeIndex);
        return {
          status: 'ok',
          key: exact.botanical + '|' + sizeHit.container,
          plant: { ...exact, size: sizeHit.container, price: sizeHit.price },
          qty: wantQty,
          item_code: codeInfo && codeInfo.code,
          upc: codeInfo && codeInfo.upc,
        };
      }
      // Plant in stock but not at this size — fall through.
      const plantMatchNoSize = exact;
      return { status: 'size_dropped', reason: `size ${wantSize} not available`, plant: plantMatchNoSize };
    }

    // 3. Soft fuzzy match — every token of the past name appears in
    //    some current plant. Use this as a last resort.
    const toks = normForMatch(wantName).split(' ').filter((t) => t.length >= 3);
    if (toks.length) {
      const fuzzy = (catalog || []).find((p) =>
        toks.every((t) => normForMatch((p.botanical || '') + ' ' + (p.common || '')).includes(t))
      );
      if (fuzzy) {
        const sizes = fuzzy.sizes || [];
        const sizeHit = sizes.find((s) => normSize(s.container) === normSize(wantSize));
        if (sizeHit) {
          return {
            status: 'ok',
            key: fuzzy.botanical + '|' + sizeHit.container,
            plant: { ...fuzzy, size: sizeHit.container, price: sizeHit.price },
            qty: wantQty,
            item_code: null,
            upc: null,
            fuzzy_name: true,
          };
        }
      }
    }
    return { status: 'plant_dropped', reason: 'no longer in stock' };
  }

  function normForMatch(s) {
    return String(s || '').toLowerCase()
      .replace(/['‘’]/g, "'").replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
  }
  function normSize(s) {
    const v = String(s || '').toLowerCase().replace(/["\s]/g, '');
    if (v === '4' || v === '4in') return '4in';
    const m = v.match(/^(\d+)g$/);
    return m ? m[1] + 'gal' : v;
  }

  function lookupItemCode(botanical, container, codeIndex) {
    const want = normSize(container);
    const arr = codeIndex || [];
    if (!arr.length) return null;
    for (const it of arr) {
      if (!it || !it.d) continue;
      if (normSize(it.s) !== want) continue;
      // Match by item description == botanical name (case + space tolerant)
      if (normForMatch(it.d) === normForMatch(botanical)) {
        return { code: it.c, upc: it.u, plant: { botanical: botanical, size: container, price: null } };
      }
    }
    return null;
  }

  // Build a window.MASTER_ITEM_FULL-style index from the page if it's
  // already loaded. Falls back to an empty index.
  function getCatalogAndCodes() {
    const catalog = (window.AVAILABILITY && window.AVAILABILITY.plants) || [];
    const codeIndex = (window.MASTER_ITEM_FULL || []).filter(Boolean);
    return { catalog, codeIndex };
  }

  // Hydrate localStorage with the resolved cart lines using Cart.add()
  // semantics. We write directly to the storage key Cart.js owns so the
  // updated state is visible on the next render without calling anything.
  const STORAGE_KEY = 'nativesons_cart_v1';
  function writeCart(lines) {
    const items = lines.map((l) => ({
      key: l.key,
      name: l.plant.botanical,
      size: l.plant.size || (l.plant.sizes && l.plant.sizes[0] && l.plant.sizes[0].container) || '',
      price: l.plant.price || 0,
      qty: l.qty,
      item_code: l.item_code || null,
      upc: l.upc || null,
      retailMode: 'wholesale',
      retailPrice: null,
      specialOrder: false,
    }));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch (e) {}
    return items.length;
  }

  // Public surface
  window.Reorder = {
    __v: VERSION,
    callRpc,
    resolveItem,
    writeCart,
    STORAGE_KEY,
    // Boot a reorder from a (number, email) pair. Returns a Promise<{added, skipped}>.
    reorderIntoCart(orderNumber, email) {
      return callRpc(orderNumber, email).then((rows) => {
        if (!Array.isArray(rows) || rows.length === 0) {
          return { added: [], skipped: [], notFound: true };
        }
        const { catalog, codeIndex } = getCatalogAndCodes();
        const resolved = rows.map((r) => ({ raw: r, ...resolveItem(r, catalog, codeIndex) }));
        const ok = resolved.filter((r) => r.status === 'ok');
        const skip = resolved.filter((r) => r.status !== 'ok');
        if (ok.length) writeCart(ok);
        return {
          added: ok.map((r) => ({
            key: r.key,
            name: r.plant.botanical,
            size: r.plant.size || '',
            qty: r.qty,
            fuzzy_name: !!r.fuzzy_name,
          })),
          skipped: skip.map((r) => ({
            name: r.raw.plant_name,
            size: r.raw.plant_size,
            qty: r.raw.qty,
            reason: r.reason,
          })),
          notFound: false,
        };
      });
    },
  };
})();
