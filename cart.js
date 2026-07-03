// ============================================================
// cart.js — localStorage-backed cart for the order portal
// Exposed as window.Cart so app.js (loaded via separate <script>)
// can reach it. (const/let at top of a script tag don't go on window.)
// ============================================================

window.Cart = (() => {
  const STORAGE_KEY = 'nativesons_cart_v1';

  // In-memory state
  // items: [{ key, name, size, price, qty, retailMode, retailPrice }]
  //   retailMode: 'wholesale' | 'markup' | 'manual'
  //   retailPrice: per-unit retail price used for the order
  //   When retailMode === 'wholesale', retailPrice === price (wholesale).
  //   When retailMode === 'markup',  retailPrice === price * markupMultiplier.
  //   When retailMode === 'manual',  retailPrice is whatever the user typed.
  // Cart subtotal always reflects WHOLESALE; retail is only used at order submit.
  let items = [];
  let listeners = [];

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) { items = []; return; }
      // Backfill retail fields on legacy items.
      items = parsed.map(i => Object.assign(
        { retailMode: 'wholesale', retailPrice: i.price || 0 },
        i
      ));
      // If item is wholesale mode but retailPrice drifted, snap it back to wholesale.
      items.forEach(i => {
        if (i.retailMode === 'wholesale') i.retailPrice = i.price || 0;
      });
    } catch (e) {
      console.warn('Cart load failed, starting fresh', e);
      items = [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      console.warn('Cart save failed', e);
    }
    notify();
  }

  function onChange(fn) { listeners.push(fn); }
  function notify() { listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }

  function add(plant) {
    // plant: { key, name, size, price, qty }
    const existing = items.find(i => i.key === plant.key);
    if (existing) {
      existing.qty += plant.qty;
    } else {
      items.push({
        key: plant.key,
        name: plant.name,
        size: plant.size,
        price: plant.price,
        qty: plant.qty,
        retailMode: 'wholesale',
        retailPrice: plant.price,
      });
    }
    save();
  }

  function setQty(key, qty) {
    const item = items.find(i => i.key === key);
    if (!item) return;
    if (qty <= 0) {
      remove(key);
      return;
    }
    item.qty = qty;
    save();
  }

  function setRetail(key, mode, value) {
    // mode: 'wholesale' | 'markup' | 'manual'
    // value: markup multiplier (e.g. 2.0) for 'markup', or $/ea for 'manual'.
    // Ignored for 'wholesale'.
    const item = items.find(i => i.key === key);
    if (!item) return;
    item.retailMode = mode;
    if (mode === 'wholesale') {
      item.retailPrice = item.price;
    } else if (mode === 'markup') {
      const mult = parseFloat(value);
      const m = (isNaN(mult) || mult < 0) ? 0 : mult;
      item.retailPrice = Math.round(item.price * m * 100) / 100;
    } else if (mode === 'manual') {
      const p = parseFloat(value);
      item.retailPrice = (isNaN(p) || p < 0) ? 0 : Math.round(p * 100) / 100;
    }
    save();
  }

  // Apply a markup multiplier to every item currently in 'wholesale' mode.
  // Items already on 'markup' or 'manual' are left untouched. Returns the
  // number of items affected.
  function applyDefaultMarkup(multiplier) {
    const mult = parseFloat(multiplier);
    if (isNaN(mult) || mult < 0) return 0;
    let changed = 0;
    items.forEach(item => {
      if (item.retailMode === 'wholesale') {
        item.retailMode = 'markup';
        item.retailPrice = Math.round(item.price * mult * 100) / 100;
        changed++;
      }
    });
    if (changed > 0) save();
    return changed;
  }

  function remove(key) {
    items = items.filter(i => i.key !== key);
    save();
  }

  function clear() {
    items = [];
    save();
  }

  function getItems() { return items.map(i => ({ ...i })); }
  function getCount() { return items.reduce((sum, i) => sum + i.qty, 0); }
  function getSubtotal() { return items.reduce((sum, i) => sum + (i.price * i.qty), 0); }
  function getRetailSubtotal() { return items.reduce((sum, i) => sum + (i.retailPrice * i.qty), 0); }

  load();
  return { add, setQty, setRetail, applyDefaultMarkup, remove, clear, getItems, getCount, getSubtotal, getRetailSubtotal, onChange };
})();