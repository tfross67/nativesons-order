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

  const plantDetailOverlay = $('plantDetailOverlay');
  const plantDetailModal = $('plantDetailModal');
  const plantDetailBody = $('plantDetailBody');
  const closePlantDetailBtn = $('closePlantDetail');

  // ----- State -----
  let currentFilter = 'all';
  let currentQuery = '';

  // ----- Helpers -----
  const fmtPrice = (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ----- Plant shape -----
  // Each plant has a `sizes` array of { container, price }. We render ONE card per plant.
  // Multi-size plants open a detail modal with a size picker before adding to cart.
  function getPlantKey(p) {
    return p.botanical || p.common || 'unknown';
  }

  function getRowKey(plantKey, container) {
    return `${plantKey}|${container || ''}`;
  }

  function getSizes(p) {
    return (p.sizes && p.sizes.length > 0) ? p.sizes : [];
  }

  function minPrice(p) {
    const sizes = getSizes(p);
    if (sizes.length === 0) return 0;
    return Math.min(...sizes.map(s => typeof s.price === 'number' ? s.price : Infinity));
  }

  function plantIsInBloom(p) {
    return p.bloom === true || p.bud === true;
  }

  function plantMatchesQuery(p, q) {
    if (!q) return true;
    const haystack = [
      p.botanical, p.common, p.section,
      p.flower_color,
      ...getSizes(p).map(s => s.container)
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  }

  function plantMatchesFilter(p) {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'bloom') return p.bloom === true;
    if (currentFilter === 'bud') return p.bud === true;
    return true;
  }

  // ----- Render plant grid -----
  // One card per plant. Multi-size plants open the detail modal to pick a size.
  function renderPlants() {
    const q = currentQuery.trim().toLowerCase();
    const filtered = PLANTS.filter(p => plantMatchesQuery(p, q) && plantMatchesFilter(p));

    if (PLANTS.length === 0) {
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

    const html = filtered.map(p => {
      const badges = [];
      if (p.bloom) badges.push('<span class="badge badge-bloom"><span class="dot"></span>In Bloom</span>');
      if (p.bud) badges.push('<span class="badge badge-bud"><span class="dot"></span>Budding</span>');

      // Display name: botanical first, common name underneath (when present)
      const displayName = p.botanical
        ? `<span class="botanical" style="font-style:italic; font-family: var(--font-serif); font-weight: 500;">${esc(p.botanical)}</span>${p.common ? `<br><span class="common" style="font-size:14px; color:var(--c-ink-soft); font-style:normal; font-family: var(--font-sans); font-weight: 400; display: inline-block; margin-top: 2px;">${esc(p.common)}</span>` : ''}`
        : esc(p.common);

      // Build the compact specs line. Only include fields that have values.
      // Container sizes + H + W + flower color.
      const sizes = getSizes(p);
      const sizeLabels = sizes.map(s => esc(s.container)).filter(Boolean);
      const specsParts = [];
      if (sizeLabels.length) specsParts.push(sizeLabels.join(' / '));
      if (p.height) specsParts.push(`<span class="spec-label">H</span> ${esc(p.height)}`);
      if (p.width) specsParts.push(`<span class="spec-label">W</span> ${esc(p.width)}`);
      if (p.flower_color) specsParts.push(`<span class="spec-flower">${esc(p.flower_color)}</span>`);
      const specsLine = specsParts.length
        ? `<div class="plant-specs">${specsParts.join(' · ')}</div>`
        : '';

      const fromPrice = minPrice(p);
      const sizeCount = sizes.length;
      const plantKey = getPlantKey(p);

      return `
        <article class="plant-card" data-plant-key="${esc(plantKey)}">
          <h3 class="plant-name">${displayName}</h3>
          ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
          ${specsLine}
          <div class="plant-price">
            ${sizeCount > 1 ? '<span class="price-from">from</span> ' : ''}$${fmtPrice(fromPrice)}<span class="unit">/ea</span>
            ${sizeCount > 1 ? `<span class="size-count">${sizeCount} sizes</span>` : ''}
          </div>
          <div class="add-to-cart">
            <button class="btn btn-primary btn-block" data-action="open-detail" data-plant-key="${esc(plantKey)}">
              ${sizeCount > 1 ? 'Choose size' : 'Add to order'}
            </button>
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

  // ----- Plant detail modal -----
  // Renders full info for a plant, with a size picker that adds (plant, size, qty) to cart.
  function renderPlantDetail(p) {
    const sizes = getSizes(p);

    const badges = [];
    if (p.bloom) badges.push('<span class="badge badge-bloom"><span class="dot"></span>In Bloom</span>');
    if (p.bud) badges.push('<span class="badge badge-bud"><span class="dot"></span>Budding</span>');

    // Hero — botanical (italic) + common under, like the card
    const heroName = p.botanical
      ? `<div class="detail-botanical">${esc(p.botanical)}</div>${p.common ? `<div class="detail-common">${esc(p.common)}</div>` : ''}`
      : `<div class="detail-botanical">${esc(p.common)}</div>`;

    // Spec table — only show rows with values
    const specRows = [];
    if (p.height) specRows.push(['Height', esc(p.height)]);
    if (p.width) specRows.push(['Width', esc(p.width)]);
    if (p.flower_color) specRows.push(['Flower color', `<span class="spec-flower">${esc(p.flower_color)}</span>`]);
    if (p.section) specRows.push(['Category', esc(p.section)]);
    const specsHtml = specRows.length
      ? `<dl class="detail-specs">${specRows.map(([k, v]) =>
          `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`
      : '';

    // Size picker — one row per size with its own qty input + Add button.
    const plantKey = getPlantKey(p);
    const sizesHtml = sizes.map((s, idx) => {
      const rowKey = getRowKey(plantKey, s.container);
      return `
        <div class="detail-size-row" data-row-key="${esc(rowKey)}">
          <div class="detail-size-info">
            <div class="detail-size-container">${esc(s.container || 'Default')}</div>
            <div class="detail-size-price">$${fmtPrice(s.price)}<span class="unit">/ea</span></div>
          </div>
          <div class="detail-size-controls">
            <input type="number" min="0" step="1" placeholder="0"
              aria-label="Quantity for ${esc(p.common || p.botanical)} (${esc(s.container)})"
              data-action="detail-qty" data-row-key="${esc(rowKey)}">
            <button class="btn btn-primary" data-action="detail-add"
              data-row-key="${esc(rowKey)}"
              data-name="${esc(p.botanical || p.common)}"
              data-size="${esc(s.container)}"
              data-price="${s.price}">Add</button>
          </div>
        </div>
      `;
    }).join('');

    plantDetailBody.innerHTML = `
      <div class="detail-hero">
        ${heroName}
        ${badges.length ? `<div class="badges detail-badges">${badges.join('')}</div>` : ''}
      </div>
      ${specsHtml}
      <div class="detail-section-title">Available sizes</div>
      <div class="detail-sizes">${sizesHtml}</div>
      <p class="detail-footnote">Quantities are not held until confirmed by our office.</p>
    `;
  }

  function openPlantDetail(plantKey) {
    const p = PLANTS.find(pl => getPlantKey(pl) === plantKey);
    if (!p) return;
    renderPlantDetail(p);
    plantDetailModal.hidden = false;
    plantDetailOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closePlantDetail() {
    plantDetailModal.hidden = true;
    plantDetailOverlay.hidden = true;
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
  // Uses the submit_order() RPC, which is SECURITY DEFINER and does both
  // the order and order_items inserts in a single transaction. This
  // bypasses RLS for the insert path so we don't need separate
  // anon-write policies on each table.
  async function submitOrder(formData) {
    if (!supabase) {
      throw new Error('Supabase is not configured. Edit supabase-config.js with your anon key.');
    }

    const items = Cart.getItems();
    if (items.length === 0) throw new Error('Cart is empty.');

    const subtotal = Cart.getSubtotal();
    const orderNumber = generateOrderNumber();

    const pItems = items.map(i => ({
      plant_key: i.key,
      plant_name: i.name,
      plant_size: i.size || null,
      unit_price: i.price,
      qty: i.qty,
      line_total: i.price * i.qty,
    }));

    const { data: orderId, error } = await supabase.rpc('submit_order', {
      p_order_number: orderNumber,
      p_customer_name: formData.customer_name.trim(),
      p_customer_email: formData.customer_email.trim().toLowerCase(),
      p_customer_phone: (formData.customer_phone || '').trim() || null,
      p_customer_company: (formData.customer_company || '').trim() || null,
      p_notes: (formData.notes || '').trim() || null,
      p_subtotal: subtotal,
      p_item_count: Cart.getCount(),
      p_items: pItems,
    });

    if (error) throw error;

    return { orderNumber, orderId };
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

    // Plant grid — "Add to order" / "Choose size" buttons open the detail modal
    plantGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="open-detail"]');
      if (!btn) return;
      const plantKey = btn.dataset.plantKey;
      openPlantDetail(plantKey);
    });

    // Plant detail modal — size row "Add" buttons + close
    plantDetailBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="detail-add"]');
      if (!btn) return;
      const row = btn.closest('.detail-size-row');
      const qtyInput = row.querySelector('input[type="number"]');
      const qty = parseInt(qtyInput.value, 10) || 0;
      if (qty <= 0) {
        qtyInput.focus();
        return;
      }
      Cart.add({
        key: btn.dataset.rowKey,
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
    closePlantDetailBtn.addEventListener('click', closePlantDetail);
    plantDetailOverlay.addEventListener('click', closePlantDetail);

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
        if (!plantDetailModal.hidden) closePlantDetail();
        else if (!checkoutModal.hidden) closeCheckout();
        else if (!cartPanel.hidden) closeCart();
      }
    });
  }

  // ----- Header counts -----
  function renderHeaderCounts() {
    const inBloom = PLANTS.filter(p => p.bloom === true).length;
    const budding = PLANTS.filter(p => p.bud === true).length;
    countsEl.textContent = `${PLANTS.length} plants · ${inBloom} in bloom · ${budding} budding`;

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
