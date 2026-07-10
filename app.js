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

  const defaultMarkupInput = $('defaultMarkupInput');
  const applyDefaultMarkupBtn = $('applyDefaultMarkupBtn');
  const cartDefaultMarkupSaved = $('cartDefaultMarkupSaved');

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

      // Display name: botanical first (upright, sans), common name underneath (italic, serif)
      const displayName = p.botanical
        ? `<span class="plant-botanical">${esc(p.botanical)}</span>${p.common ? `<br><span class="plant-common">${esc(p.common)}</span>` : ''}`
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
    const retailSubtotal = Cart.getRetailSubtotal();
    const hasRetailOverride = items.some(i => i.retailMode !== 'wholesale');

    // Floating bar (always shows wholesale subtotal)
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
      cartItems.innerHTML = items.map(i => {
        const retailLineTotal = i.retailPrice * i.qty;
        const mode = i.retailMode || 'wholesale';
        const isMarkup = mode === 'markup';
        const isManual = mode === 'manual';
        // Pre-fill markup multiplier from current retailPrice (so editing keeps existing relationship).
        const markupValue = isMarkup && i.price > 0
          ? (Math.round((i.retailPrice / i.price) * 100) / 100)
          : '';
        // Manual mode: show empty placeholder when value is 0 (so user can type
        // from scratch). Show formatted value when non-zero.
        const manualValue = isManual
          ? (i.retailPrice > 0 ? i.retailPrice.toFixed(2) : '')
          : '';

        return `
        <div class="cart-item">
          <div class="cart-item-row">
            <div class="cart-item-info">
              <div class="cart-item-name">${esc(i.name)}</div>
              <div class="cart-item-meta">${esc(i.size || '')} · wholesale $${fmtPrice(i.price)}/ea</div>
            </div>
            <div class="cart-item-qty">
              <button class="qty-btn" data-action="dec" data-key="${esc(i.key)}" aria-label="Decrease">−</button>
              <input type="number" min="0" value="${i.qty}" data-action="set" data-key="${esc(i.key)}" aria-label="Quantity">
              <button class="qty-btn" data-action="inc" data-key="${esc(i.key)}" aria-label="Increase">+</button>
            </div>
            <div class="cart-item-total">
              <div class="cart-item-total-wholesale">$${fmtPrice(i.price * i.qty)}</div>
              ${hasRetailOverride ? `<div class="cart-item-total-retail">retail $${fmtPrice(retailLineTotal)}</div>` : ''}
            </div>
            <button class="cart-item-remove" data-action="remove" data-key="${esc(i.key)}" aria-label="Remove">✕</button>
          </div>
          <div class="cart-item-pricing">
            <span class="cart-item-pricing-label">Retail pricing</span>
            <div class="pricing-mode" role="group" aria-label="Pricing mode">
              <button type="button" class="pricing-mode-btn ${mode === 'wholesale' ? 'active' : ''}" data-action="retail-mode" data-mode="wholesale" data-key="${esc(i.key)}">Wholesale</button>
              <button type="button" class="pricing-mode-btn ${mode === 'markup' ? 'active' : ''}" data-action="retail-mode" data-mode="markup" data-key="${esc(i.key)}">Markup ×</button>
              <button type="button" class="pricing-mode-btn ${mode === 'manual' ? 'active' : ''}" data-action="retail-mode" data-mode="manual" data-key="${esc(i.key)}">Manual $</button>
            </div>
            ${isMarkup ? `
              <div class="pricing-input-wrap" title="Multiplier applied to wholesale">
                <input type="number" step="0.01" placeholder="2.0" aria-label="Markup multiplier"
                  data-action="retail-input" data-mode="markup" data-key="${esc(i.key)}" value="${markupValue}">
                <span class="pricing-input-suffix">×</span>
                <span class="pricing-input-result">= $${fmtPrice(i.retailPrice)}/ea</span>
              </div>` : ''}
            ${isManual ? `
              <div class="pricing-input-wrap" title="Retail price per unit">
                <span class="pricing-input-prefix">$</span>
                <input type="number" step="0.01" placeholder="0.00" aria-label="Retail price"
                  data-action="retail-input" data-mode="manual" data-key="${esc(i.key)}" value="${manualValue}">
                <span class="pricing-input-suffix">/ea</span>
              </div>` : ''}
          </div>
        </div>
      `;
      }).join('');
      cartSummary.hidden = false;
      cartSummaryTotal.textContent = fmtPrice(subtotal);

      // Prefill the default-markup input with the most common markup
      // multiplier used by markup-mode items in the cart (if any).
      if (defaultMarkupInput) {
        const markupItems = items.filter(i => i.retailMode === 'markup' && i.price > 0);
        if (markupItems.length > 0) {
          // Pick the first one's multiplier as a sensible default
          const first = markupItems[0];
          const mult = Math.round((first.retailPrice / first.price) * 100) / 100;
          defaultMarkupInput.value = mult;
        }
        // Don't clear it if empty — keep whatever user typed
      }

      // Show retail subtotal line in summary if any line has an override
      const summaryRetailEl = document.getElementById('cartSummaryRetail');
      if (summaryRetailEl) {
        if (hasRetailOverride) {
          summaryRetailEl.hidden = false;
          summaryRetailEl.innerHTML = `
            <span class="cart-summary-row">
              <span>Retail (for labels)</span>
              <span>$<span id="cartSummaryRetailTotal">${fmtPrice(retailSubtotal)}</span></span>
            </span>`;
        } else {
          summaryRetailEl.hidden = true;
        }
      }
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

    // Link to native-sons.com plant page when matched (approach C — link only, no thumbnail)
    const nativesonLink = p.nativeson_url
      ? `<a class="detail-nativeson-link" href="${esc(p.nativeson_url)}" target="_blank" rel="noopener noreferrer">↗ View on nativeson.com</a>`
      : '';

    // Spec table — only show rows with values
    const specRows = [];
    if (p.height) specRows.push(['Height', esc(p.height)]);
    if (p.width) specRows.push(['Width', esc(p.width)]);
    if (p.flower_color) specRows.push(['Flower color', `<span class="spec-flower">${esc(p.flower_color)}</span>`]);
    if (p.origin) specRows.push(['Origin', esc(p.origin)]);
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
        ${nativesonLink}
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

  // ----- Customer preference lookup -----
  // Look up the saved default markup for an email. Returns null if none.
  async function fetchCustomerMarkup(email) {
    if (!supabase || !email) return null;
    try {
      const { data, error } = await supabase.rpc('get_customer_markup', { p_email: email });
      if (error) { console.warn('get_customer_markup error:', error); return null; }
      if (data == null) return null;
      const m = parseFloat(data);
      return (isNaN(m) || m <= 0) ? null : m;
    } catch (e) {
      console.warn('get_customer_markup failed:', e);
      return null;
    }
  }

  function flashSavedMarkup(markup) {
    // Briefly show a "saved" confirmation in the default-markup card.
    if (!cartDefaultMarkupSaved) return;
    const textEl = cartDefaultMarkupSaved.querySelector('.cart-default-markup-saved-text');
    if (textEl) textEl.textContent = `We'll use your ${markup}× markup on future orders.`;
    cartDefaultMarkupSaved.hidden = false;
    setTimeout(() => { cartDefaultMarkupSaved.hidden = true; }, 4000);
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
    const retailSubtotal = Cart.getRetailSubtotal();
    const orderNumber = generateOrderNumber();

    const pItems = items.map(i => ({
      plant_key: i.key,
      plant_name: i.name,
      plant_size: i.size || null,
      unit_price: i.price,
      qty: i.qty,
      line_total: i.price * i.qty,
      retail_mode: i.retailMode || 'wholesale',
      retail_price: i.retailPrice,
      retail_line_total: (i.retailPrice || 0) * i.qty,
    }));

    const { data: orderId, error } = await supabase.rpc('submit_order', {
      p_order_number: orderNumber,
      p_customer_name: formData.customer_name.trim(),
      p_customer_email: formData.customer_email.trim().toLowerCase(),
      p_customer_phone: (formData.customer_phone || '').trim() || null,
      p_customer_company: (formData.customer_company || '').trim() || null,
      p_notes: (formData.notes || '').trim() || null,
      p_subtotal: subtotal,
      p_retail_subtotal: retailSubtotal,
      p_item_count: Cart.getCount(),
      p_items: pItems,
    });

    if (error) throw error;

    return { orderNumber, orderId };
  }

  // ----- Send order confirmation emails via Supabase Edge Function -----
  // The Edge Function (send-order-email) runs server-side and calls AgentMail
  // from there, bypassing browser CORS restrictions. Called fire-and-forget
  // after submitOrder() succeeds so the customer isn't blocked on email latency.
  async function sendOrderEmails(orderNumber, orderId, items, formData) {
    if (!supabase) {
      console.warn('Supabase not configured — skipping order emails.');
      return;
    }
    // TEMPORARY: redirect office email to tfross@gmail.com until
    // AgentMail deliverability is resolved. Customer email still goes to
    // whatever was entered in the form.
    const debugOfficeEmail = 'tfross@gmail.com';
    const order = {
      order_number: orderNumber,
      customer_name: formData.customer_name.trim(),
      customer_email: formData.customer_email.trim().toLowerCase(),
      customer_phone: (formData.customer_phone || '').trim() || null,
      customer_company: (formData.customer_company || '').trim() || null,
      notes: (formData.notes || '').trim() || null,
      subtotal: Cart.getSubtotal(),
      retail_subtotal: Cart.getRetailSubtotal(),
      item_count: Cart.getCount(),
    };
    const fnPayload = {
      record: order,
      items: items.map(i => ({
        plant_key: i.key,
        plant_name: i.name,
        plant_size: i.size || null,
        unit_price: i.price,
        qty: i.qty,
        line_total: i.price * i.qty,
      })),
      debugOfficeEmail: debugOfficeEmail || undefined,
    };
    try {
      const { data, error } = await supabase.functions.invoke('send-order-email', {
        body: fnPayload,
      });
      if (error) {
        console.error('[DIAG] Edge function invoke error:', error);
        return { ok: false, error: 'invoke error: ' + (error.message || JSON.stringify(error)) };
      }
      console.log('[DIAG] Order emails response:', data);
      return data || { ok: false, error: 'no data returned from function' };
    } catch (e) {
      console.error('[DIAG] Order emails threw:', e);
      return { ok: false, error: 'exception: ' + (e && e.message ? e.message : String(e)) };
    }
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

    // Default markup — apply to all wholesale items in the cart
    function applyMarkupFromInput() {
      const mult = parseFloat(defaultMarkupInput.value);
      if (isNaN(mult) || mult < 0) return;
      const changed = Cart.applyDefaultMarkup(mult);
      if (changed === 0) {
        // Nothing to apply — give a subtle visual cue
        defaultMarkupInput.focus();
      }
    }
    if (applyDefaultMarkupBtn) {
      applyDefaultMarkupBtn.addEventListener('click', applyMarkupFromInput);
    }
    if (defaultMarkupInput) {
      defaultMarkupInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applyMarkupFromInput();
        }
      });
    }

    // Cart items
    cartItems.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const key = btn.dataset.key;
      const action = btn.dataset.action;
      if (action === 'retail-mode') {
        const mode = btn.dataset.mode;
        const item = Cart.getItems().find(i => i.key === key);
        let val = '';
        if (mode === 'markup' && item && item.price > 0) {
          // If the item was previously on a non-default markup, preserve that ratio.
          // Otherwise default to the cart-level default markup if set, else 2.0×.
          if (item.retailMode === 'markup' && item.retailPrice > 0) {
            val = Math.round((item.retailPrice / item.price) * 100) / 100;
          } else {
            const globalDefault = defaultMarkupInput && defaultMarkupInput.value
              ? parseFloat(defaultMarkupInput.value)
              : NaN;
            val = (!isNaN(globalDefault) && globalDefault > 0) ? globalDefault : 2.0;
          }
        } else if (mode === 'manual' && item) {
          val = item.retailPrice;
        }
        Cart.setRetail(key, mode, val);
        return;
      }
      const item = Cart.getItems().find(i => i.key === key);
      if (!item) return;
      if (action === 'inc') Cart.setQty(key, item.qty + 1);
      else if (action === 'dec') Cart.setQty(key, item.qty - 1);
      else if (action === 'remove') Cart.remove(key);
    });
    cartItems.addEventListener('change', (e) => {
      // Quantity input
      const setInput = e.target.closest('input[data-action="set"]');
      if (setInput) {
        const key = setInput.dataset.key;
        const qty = parseInt(setInput.value, 10) || 0;
        Cart.setQty(key, qty);
        return;
      }
      // Retail markup or manual input — change fires on commit (blur/enter).
      // Re-render so the readonly result text snaps to the new saved value.
      const retailInput = e.target.closest('input[data-action="retail-input"]');
      if (retailInput) {
        const key = retailInput.dataset.key;
        const mode = retailInput.dataset.mode;
        Cart.setRetail(key, mode, retailInput.value);
        return;
      }
    });
    // Live-update retail on each keystroke — silent so we don't tear down the
    // input element mid-typing. The input itself displays the typed value; we
    // also update the line-total preview in-place.
    cartItems.addEventListener('input', (e) => {
      const retailInput = e.target.closest('input[data-action="retail-input"]');
      if (!retailInput) return;
      const key = retailInput.dataset.key;
      const mode = retailInput.dataset.mode;
      Cart.setRetail(key, mode, retailInput.value, { silent: true });
      // Update the inline preview (line total / per-unit) without re-rendering
      const item = Cart.getItems().find(i => i.key === key);
      if (!item) return;
      const card = retailInput.closest('.cart-item');
      if (!card) return;
      const result = card.querySelector('.pricing-input-result');
      const lineRetail = card.querySelector('.cart-item-total-retail');
      if (result) {
        if (mode === 'markup') {
          const mult = parseFloat(retailInput.value);
          const m = (isNaN(mult) || mult < 0) ? 0 : mult;
          result.textContent = `= $${fmtPrice(item.price * m)}/ea`;
        }
      }
      if (lineRetail) {
        lineRetail.textContent = `retail $${fmtPrice(item.retailPrice * item.qty)}`;
      }
    });

    // Proceed to checkout
    proceedBtn.addEventListener('click', openCheckout);
    closeCheckoutBtn.addEventListener('click', closeCheckout);
    cancelCheckoutBtn.addEventListener('click', closeCheckout);
    checkoutOverlay.addEventListener('click', closeCheckout);

    // When the customer enters their email, look up their saved markup.
    const emailInput = checkoutForm.querySelector('input[name="customer_email"]');
    if (emailInput) {
      let lookupTimer = null;
      let lookedUp = false;
      const tryApply = async () => {
        const email = (emailInput.value || '').trim().toLowerCase();
        if (!email || !email.includes('@')) return;
        const saved = await fetchCustomerMarkup(email);
        lookedUp = true;
        if (saved == null) return; // No saved preference — silent
        // Only offer if the cart has at least one wholesale item
        const items = Cart.getItems();
        const hasWholesale = items.some(i => i.retailMode === 'wholesale');
        if (!hasWholesale) return;
        const confirmed = confirm(
          `Welcome back. Your saved default markup is ${saved}×.\n\nApply it to the wholesale items in your cart?`
        );
        if (confirmed) {
          Cart.applyDefaultMarkup(saved);
          if (defaultMarkupInput) defaultMarkupInput.value = saved;
        }
      };
      emailInput.addEventListener('blur', () => {
        if (lookedUp) return;
        clearTimeout(lookupTimer);
        lookupTimer = setTimeout(tryApply, 200);
      });
      emailInput.addEventListener('input', () => {
        // Reset so re-typing the email triggers another lookup attempt
        lookedUp = false;
      });
    }

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

      // Diagnostic banner — shows email status on-screen without DevTools.
      const diag = document.createElement('div');
      diag.id = 'submitDiag';
      diag.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;padding:12px 16px;border-radius:8px;font:14px -apple-system,sans-serif;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.2);background:#fffbe6;border:1px solid #f0c000;color:#333;';
      diag.textContent = 'Submitting order…';
      document.body.appendChild(diag);

      try {
        const { orderNumber, orderId } = await submitOrder(formData);
        diag.style.background = '#e3f0ff';
        diag.style.borderColor = '#7aa8d8';
        diag.textContent = `Order ${orderNumber} saved. Sending email…`;

        // AWAIT the email send before navigating. If we navigate first, the
        // browser aborts the in-flight fetch to the Edge Function and no
        // emails get sent. Cap with a 6s budget so a slow AgentMail response
        // doesn't block the confirmation page forever.
        const emailStart = Date.now();
        const emailPromise = sendOrderEmails(orderNumber, orderId, Cart.getItems(), formData);
        const emailTimeout = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 6000));
        const emailResult = await Promise.race([emailPromise, emailTimeout]);
        const emailMs = Date.now() - emailStart;

        if (emailResult && emailResult.ok) {
          diag.style.background = '#e6f4d9';
          diag.style.borderColor = '#7aa84a';
          diag.textContent = `✓ Email sent (${emailMs}ms). Going to confirmation…`;
        } else if (emailResult && emailResult.timeout) {
          diag.style.background = '#fff0d6';
          diag.style.borderColor = '#d8a87a';
          diag.textContent = `⚠ Email still sending after 6s — proceeding anyway. Order saved.`;
        } else {
          diag.style.background = '#ffe0e0';
          diag.style.borderColor = '#d87a7a';
          const errMsg = emailResult && emailResult.error ? emailResult.error : JSON.stringify(emailResult);
          diag.textContent = `✗ Email failed: ${errMsg}. Order ${orderNumber} still saved.`;
          console.error('[DIAG] Full email result:', emailResult);
          console.error('[DIAG] Full error message:', errMsg);
          // Sticky banner on error so user can read it
          diag.style.cursor = 'pointer';
          diag.title = 'Click to dismiss';
          diag.textContent += '  (click to dismiss)';
          await new Promise((resolve) => {
            const dismiss = () => { diag.removeEventListener('click', dismiss); diag.remove(); resolve(); };
            diag.addEventListener('click', dismiss);
          });
        }
        if (!diag.isConnected) {
          // already dismissed, skip pause
        } else if (emailResult && emailResult.ok) {
          await new Promise(r => setTimeout(r, 1200));
        }

        // If the customer used a markup, surface a tiny confirmation before
        // the cart is cleared. Save for next time is automatic via submit_order RPC.
        const usedMarkup = Cart.getItems().some(i => i.retailMode === 'markup');
        if (usedMarkup) {
          const multInput = defaultMarkupInput && defaultMarkupInput.value;
          if (multInput) {
            // flashSavedMarkup relies on the cart still being mounted, so do it
            // synchronously before clearing. It'll be a no-op once we navigate.
            flashSavedMarkup(parseFloat(multInput));
          }
        }
        // Clear cart and go to confirmation
        Cart.clear();
        const params = new URLSearchParams({
          n: orderNumber,
          e: formData.customer_email,
        });
        window.location.href = `confirmation.html?${params.toString()}`;
      } catch (err) {
        diag.style.background = '#ffe0e0';
        diag.style.borderColor = '#d87a7a';
        diag.textContent = `✗ Order submit failed: ${err.message || err}`;
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
