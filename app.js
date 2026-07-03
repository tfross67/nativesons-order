// ============================================================
// app.js — Native Sons order portal main app
// Renders plants, handles search/filter, manages cart UI,
// submits orders to Supabase.
// ============================================================

(function () {
  'use strict';

  // ----- Data access -----
  // availability_data.js sets window.AVAILABILITY = { plants: [...], updated: '...' }
  const DATA = window.AVAILABILITY || { plants: [] };
  const PLANTS = DATA.plants || [];

  // ----- Supabase client -----
  const cfg = window.SUPABASE_CONFIG || {};
  let supabase = null;
  if (cfg.url && cfg.anonKey && cfg.anonKey !== 'YOUR_SUPABASE_ANON_KEY_HERE') {
    try {
      supabase = window.supabase.createClient(cfg.url, cfg.anonKey);
    } catch (e) {
      console.error('Supabase init failed:', e);
    }
  }

  // ----- DOM refs -----
  const $ = (id) => document.getElementById(id);
  const plantGrid = $('plantGrid');
  const searchInput = $('searchInput');
  const filterChips = $('filterChips');
  const noResults = $('noResults');
  const countsEl = $('counts');
  const weekLabel = $('weekLabel');

  const cartBar = $('cartBar');
  const cartCount = $('cartCount');
  const cartTotal = $('cartTotal');
  const cartOverlay = $('cartOverlay');
  const cartPanel = $('cartPanel');
  const cartItems = $('cartItems');
  const cartSummary = $('cartSummary');
  const cartSummaryTotal = $('cartSummaryTotal');
  const closeCartBtn = $('closeCart');
  const proceedBtn = $('proceedToCheckout');

  const checkoutOverlay = $('checkoutOverlay');
  const checkoutModal = $('checkoutModal');
  const closeCheckoutBtn = $('closeCheckout');
  const cancelCheckoutBtn = $('cancelCheckout');
  const checkoutForm = $('checkoutForm');
  const submitOrderBtn = $('submitOrder');

  // ----- State -----
  let currentFilter = 'all';
  let currentQuery = '';

  // ----- Helpers -----
  const fmtPrice = (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Each plant has a `sizes` array of { container, price }. Flatten to one row per size
  // so the customer can pick a specific container/price combo.
  function expandPlant(p) {
    const sizes = (p.sizes && p.sizes.length > 0) ? p.sizes : [{ container: '', price: 0 }];
    return sizes.map((s, idx) => ({
      key: `${p.botanical || p.common || 'plant'}|${s.container || ''}|${idx}`,
      botanical: p.botanical || '',
      common: p.common || '',
      section: p.section || '',
      container: s.container || '',
      price: typeof s.price === 'number' ? s.price : 0,
      bloom: p.bloom === true,
      bud: p.bud === true,
      height: p.height || '',
      width: p.width || '',
      flower_color: p.flower_color || '',
    }));
  }

  // Build the flat row list once
  const ROWS = PLANTS.flatMap(expandPlant);

  function plantMatchesQuery(row, q) {
    if (!q) return true;
    const haystack = [row.botanical, row.common, row.section, row.container, row.flower_color]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  }

  function plantMatchesFilter(p) {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'bloom') return p.bloom === true;
    if (currentFilter === 'bud') return p.bud === true;
    return true;
  }

  // ----- Render plant grid -----
  function renderPlants() {
    const q = currentQuery.trim().toLowerCase();
    const filtered = ROWS.filter(r => plantMatchesQuery(r, q) && plantMatchesFilter(r));

    if (ROWS.length === 0) {
      plantGrid.innerHTML = '<p class="loading">No plants loaded. Check that availability_data.js is present.</p>';
      noResults.hidden = true;
      return;
    }

    if (filtered.length === 0) {
      plantGrid.innerHTML = '';
      noResults.hidden = false;
      return;
    }
    noResults.hidden = true;

    const html = filtered.map(r => {
      const badges = [];
      if (r.bloom) badges.push('<span class="badge badge-bloom"><span class="dot"></span>In Bloom</span>');
      if (r.bud) badges.push('<span class="badge badge-bud"><span class="dot"></span>Budding</span>');

      // Display name: prefer common name + botanical for context
      const displayName = r.common
        ? `<span class="common">${esc(r.common)}</span><br><span class="botanical" style="font-size:13px; color:var(--c-muted); font-style:italic; font-family: var(--font-serif); font-weight: 400;">${esc(r.botanical)}</span>`
        : esc(r.botanical);

      const sizeText = r.container || '';
      const price = r.price;

      return `
        <article class="plant-card">
          <h3 class="plant-name">${displayName}</h3>
          ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
          <div class="plant-meta">
            <span class="plant-size">${esc(sizeText || '—')}</span>
          </div>
          <div class="plant-price">$${fmtPrice(price)}<span class="unit">/ea</span></div>
          <div class="add-to-cart">
            <input type="number" min="0" step="1" placeholder="0" aria-label="Quantity for ${esc(r.common || r.botanical)}" data-key="${esc(r.key)}">
            <button class="btn btn-primary" data-action="add" data-key="${esc(r.key)}" data-name="${esc((r.common || r.botanical) + (r.container ? ' (' + r.container + ')' : ''))}" data-size="${esc(sizeText)}" data-price="${price}">Add</button>
          </div>
        </article>
      `;
    }).join('');

    plantGrid.innerHTML = html;
  }

  // ----- Render cart panel -----
  function renderCart() {
    const items = Cart.getItems();
    const count = Cart.getCount();
    const subtotal = Cart.getSubtotal();

    // Floating bar
    if (count > 0) {
      cartBar.hidden = false;
      cartCount.textContent = count;
      cartTotal.textContent = fmtPrice(subtotal);
    } else {
      cartBar.hidden = true;
    }

    // Cart panel
    if (items.length === 0) {
      cartItems.innerHTML = '<p class="cart-empty">Cart is empty. Browse plants and add quantities to get started.</p>';
      cartSummary.hidden = true;
    } else {
      cartItems.innerHTML = items.map(i => `
        <div class="cart-item">
          <div>
            <div class="cart-item-name">${esc(i.name)}</div>
            <div class="cart-item-meta">${esc(i.size || '')} · $${fmtPrice(i.price)}/ea</div>
          </div>
          <div class="cart-item-qty">
            <button class="qty-btn" data-action="dec" data-key="${esc(i.key)}" aria-label="Decrease">−</button>
            <input type="number" min="0" value="${i.qty}" data-action="set" data-key="${esc(i.key)}" aria-label="Quantity">
            <button class="qty-btn" data-action="inc" data-key="${esc(i.key)}" aria-label="Increase">+</button>
          </div>
          <div class="cart-item-total">$${fmtPrice(i.price * i.qty)}</div>
          <button class="cart-item-remove" data-action="remove" data-key="${esc(i.key)}" aria-label="Remove">✕</button>
        </div>
      `).join('');
      cartSummary.hidden = false;
      cartSummaryTotal.textContent = fmtPrice(subtotal);
    }
  }

  // ----- Cart panel open/close -----
  function openCart() {
    cartPanel.hidden = false;
    cartOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeCart() {
    cartPanel.hidden = true;
    cartOverlay.hidden = true;
    document.body.style.overflow = '';
  }

  function openCheckout() {
    if (Cart.getCount() === 0) return;
    closeCart();
    checkoutModal.hidden = false;
    checkoutOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      const firstInput = checkoutForm.querySelector('input');
      if (firstInput) firstInput.focus();
    }, 100);
  }
  function closeCheckout() {
    checkoutModal.hidden = true;
    checkoutOverlay.hidden = true;
    document.body.style.overflow = '';
  }

  // ----- Order number generator -----
  function generateOrderNumber() {
    const year = new Date().getFullYear();
    // Random 4-digit suffix; collision chance is negligible at our volume
    const suffix = Math.floor(1000 + Math.random() * 9000);
    return `NS-${year}-${suffix}`;
  }

  // ----- Submit order to Supabase -----
  async function submitOrder(formData) {
    if (!supabase) {
      throw new Error('Supabase is not configured. Edit supabase-config.js with your anon key.');
    }

    const items = Cart.getItems();
    if (items.length === 0) throw new Error('Cart is empty.');

    const subtotal = Cart.getSubtotal();
    const orderNumber = generateOrderNumber();

    // 1. Insert the order
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        order_number: orderNumber,
        customer_name: formData.customer_name.trim(),
        customer_email: formData.customer_email.trim().toLowerCase(),
        customer_phone: (formData.customer_phone || '').trim() || null,
        customer_company: (formData.customer_company || '').trim() || null,
        notes: (formData.notes || '').trim() || null,
        status: 'new',
        subtotal: subtotal,
        item_count: Cart.getCount(),
      })
      .select()
      .single();

    if (orderErr) throw orderErr;

    // 2. Insert the line items
    const lineItems = items.map(i => ({
      order_id: order.id,
      plant_key: i.key,
      plant_name: i.name,
      plant_size: i.size || null,
      unit_price: i.price,
      qty: i.qty,
      line_total: i.price * i.qty,
    }));

    const { error: itemsErr } = await supabase
      .from('order_items')
      .insert(lineItems);

    if (itemsErr) {
      // Try to clean up the orphan order
      await supabase.from('orders').delete().eq('id', order.id);
      throw itemsErr;
    }

    return { orderNumber, orderId: order.id };
  }

  // ----- Wire up event listeners -----
  function attachListeners() {
    // Search
    searchInput.addEventListener('input', (e) => {
      currentQuery = e.target.value;
      renderPlants();
    });

    // Filter chips
    filterChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      filterChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentFilter = chip.dataset.filter;
      renderPlants();
    });

    // Plant grid — qty inputs and Add buttons
    plantGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="add"]');
      if (!btn) return;
      const key = btn.dataset.key;
      const card = btn.closest('.plant-card');
      const qtyInput = card.querySelector('input[type="number"]');
      const qty = parseInt(qtyInput.value, 10) || 0;
      if (qty <= 0) {
        qtyInput.focus();
        return;
      }
      Cart.add({
        key,
        name: btn.dataset.name,
        size: btn.dataset.size,
        price: parseFloat(btn.dataset.price) || 0,
        qty,
      });
      // Visual feedback
      const orig = btn.textContent;
      btn.textContent = '✓ Added';
      btn.classList.add('btn-added');
      qtyInput.value = '';
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('btn-added');
      }, 900);
    });

    // Cart bar
    cartBar.addEventListener('click', openCart);
    closeCartBtn.addEventListener('click', closeCart);
    cartOverlay.addEventListener('click', closeCart);

    // Cart items
    cartItems.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const key = btn.dataset.key;
      const action = btn.dataset.action;
      const item = Cart.getItems().find(i => i.key === key);
      if (!item) return;
      if (action === 'inc') Cart.setQty(key, item.qty + 1);
      else if (action === 'dec') Cart.setQty(key, item.qty - 1);
      else if (action === 'remove') Cart.remove(key);
    });
    cartItems.addEventListener('change', (e) => {
      const input = e.target.closest('input[data-action="set"]');
      if (!input) return;
      const key = input.dataset.key;
      const qty = parseInt(input.value, 10) || 0;
      Cart.setQty(key, qty);
    });

    // Proceed to checkout
    proceedBtn.addEventListener('click', openCheckout);
    closeCheckoutBtn.addEventListener('click', closeCheckout);
    cancelCheckoutBtn.addEventListener('click', closeCheckout);
    checkoutOverlay.addEventListener('click', closeCheckout);

    // Submit order
    checkoutForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(checkoutForm);
      const formData = Object.fromEntries(fd.entries());

      if (!formData.customer_name || !formData.customer_email) {
        alert('Please provide your name and email.');
        return;
      }

      submitOrderBtn.disabled = true;
      submitOrderBtn.textContent = 'Submitting…';

      try {
        const { orderNumber } = await submitOrder(formData);
        // Clear cart and go to confirmation
        Cart.clear();
        const params = new URLSearchParams({
          n: orderNumber,
          e: formData.customer_email,
        });
        window.location.href = `confirmation.html?${params.toString()}`;
      } catch (err) {
        console.error('Order submit failed:', err);
        alert(`Sorry, we couldn't submit your order. ${err.message || err}\n\nPlease try again or call 805.481.5996.`);
        submitOrderBtn.disabled = false;
        submitOrderBtn.textContent = 'Submit Order';
      }
    });

    // Cart updates
    Cart.onChange(renderCart);

    // Esc to close panels
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!checkoutModal.hidden) closeCheckout();
        else if (!cartPanel.hidden) closeCart();
      }
    });
  }

  // ----- Header counts -----
  function renderHeaderCounts() {
    const inBloom = ROWS.filter(r => r.bloom).length;
    const budding = ROWS.filter(r => r.bud).length;
    const uniquePlants = PLANTS.length;
    countsEl.textContent = `${uniquePlants} plants · ${inBloom} in bloom · ${budding} budding`;

    if (DATA.generated || DATA.week) {
      const dateStr = DATA.generated || DATA.week;
      try {
        const d = new Date(dateStr);
        if (!isNaN(d)) {
          weekLabel.textContent = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        } else {
          weekLabel.textContent = DATA.week || dateStr;
        }
      } catch (_) {
        weekLabel.textContent = DATA.week || dateStr;
      }
    }
  }

  // ----- Init -----
  function init() {
    renderHeaderCounts();
    renderPlants();
    renderCart();
    attachListeners();

    // Sanity warning if supabase not configured
    if (!supabase) {
      console.warn('Supabase not configured. Edit supabase-config.js to enable order submission.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
