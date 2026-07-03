// ============================================================
// cart.js — localStorage-backed cart for the order portal
// ============================================================

const Cart = (() => {
  const STORAGE_KEY = 'nativesons_cart_v1';

  // In-memory state
  let items = []; // [{ key, name, size, price, qty }]
  let listeners = [];

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      items = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(items)) items = [];
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
    // plant: { key, name, size, price }
    const existing = items.find(i => i.key === plant.key);
    if (existing) {
      existing.qty += plant.qty;
    } else {
      items.push({ ...plant, qty: plant.qty });
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

  function remove(key) {
    items = items.filter(i => i.key !== key);
    save();
  }

  function clear() {
    items = [];
    save();
  }

  function getItems() { return [...items]; }
  function getCount() { return items.reduce((sum, i) => sum + i.qty, 0); }
  function getSubtotal() { return items.reduce((sum, i) => sum + (i.price * i.qty), 0); }

  load();
  return { add, setQty, remove, clear, getItems, getCount, getSubtotal, onChange };
})();
