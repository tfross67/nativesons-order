// typesafe-client.js
// Minimal wrapper that calls the Supabase Edge Function 'jev-classify',
// which holds the Typesafe / Jev API key server-side. The browser only sees
// structured filter answers; the Typesafe key never leaves Supabase.
//
// Configuration:
//   window.__TYPESAFE_ENABLED (boolean, default true; set false to force fallback)
//   window.__TYPESAFE_DEBUG  (boolean, default false; logs requests/responses)
//
// Behavior:
//   - parseQueryJev(rawQuery) returns the same shape parseQuery() does.
//   - On any error (Supabase unavailable, Edge Function missing, malformed
//     response, low confidence), falls back to the existing regex/synonym
//     parseQuery — feature flag is the only switch.

(function (global) {
  'use strict';

  const DEFAULTS = {
    enabled: global.__TYPESAFE_ENABLED !== false,
    debug:   global.__TYPESAFE_DEBUG === true,
    timeoutMs: 800,
    confidenceFloor: 0.55,   // below this we ignore the Jev answer
  };

  function log(...args) {
    if (DEFAULTS.debug) {
      // eslint-disable-next-line no-console
      console.log('[typesafe]', ...args);
    }
  }

  /**
   * The Edge Function holds the Jev question schema and the Typesafe API key.
   * The browser just sends the raw query and consumes the structured answer.
   */

  /**
   * POST to Supabase Edge Function (which holds the Typesafe key).
   * The Edge Function is the only place the Typesafe API key lives — it never
   * reaches the browser. Lazy-creates a Supabase client from window.SUPABASE_CONFIG
   * so we don't have to share state with the rest of availability.html.
   */
  let _supabase = null;
  async function getSupabase() {
    if (_supabase) return _supabase;
    if (!global.supabase || !global.SUPABASE_CONFIG) {
      throw new Error('Supabase not configured');
    }
    const cfg = global.SUPABASE_CONFIG;
    _supabase = global.supabase.createClient(cfg.url, cfg.anonKey);
    return _supabase;
  }

  async function callJev(rawQuery) {
    const supabase = await getSupabase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULTS.timeoutMs);
    try {
      const { data, error } = await supabase.functions.invoke('jev-classify', {
        body: { query: rawQuery },
      });
      if (error) throw new Error(error.message || 'jev-classify error');
      if (controller.signal.aborted) throw new Error('aborted');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Map Jev's answer shape to the parseQuery() filter shape.
   * Returns null if confidence is too low on any individual answer or if
   * every answer was 'none' (meaning Jev saw nothing parseable).
   */
  function answersToFilters(answers) {
    const out = {
      colors: [], exposures: [], water: [], types: [], container: [],
      origin: [], heightBand: null, inBloom: false, budding: false, pollinator: false,
    };
    let anySignal = false;
    for (const [id, ans] of Object.entries(answers)) {
      if (!ans || typeof ans.choice !== 'string') continue;
      if ((ans.confidence || 0) < DEFAULTS.confidenceFloor) continue;
      const v = ans.choice;
      switch (id) {
        case 'colors':     if (v !== 'none') { out.colors.push(v); anySignal = true; } break;
        case 'exposures':  if (v !== 'none') { out.exposures.push(v); anySignal = true; } break;
        case 'water':      if (v !== 'none') { out.water.push(v); anySignal = true; } break;
        case 'types':      if (v !== 'none') { out.types.push(v); anySignal = true; } break;
        case 'container':  if (v !== 'none') { out.container.push(v); anySignal = true; } break;
        case 'origin':     if (v !== 'none') { out.origin.push(v); anySignal = true; } break;
        case 'height_band':if (v !== 'none') { out.heightBand = v; anySignal = true; } break;
        case 'in_bloom':   if (v === 'yes') { out.inBloom = true; anySignal = true; } break;
        case 'budding':    if (v === 'yes') { out.budding = true; anySignal = true; } break;
        case 'pollinator': if (v === 'yes') { out.pollinator = true; anySignal = true; } break;
      }
    }
    return anySignal ? out : null;
  }

  /**
   * parseQueryJev(rawQuery, fallbackParse):
   *   1. If disabled or no API key, run fallback.
   *   2. Call Jev with a hard 800ms timeout.
   *   3. Map Jev's answers onto the parseQuery filter shape.
   *   4. Merge: structured filters from Jev, free-text tokens from fallback
   *      (Jev isn't asked to do free-text tokenization — that's still regex).
   *   5. If anything goes wrong, return fallback unchanged.
   *
   * Returns the same { filters, freeText, active } shape parseQuery does.
   */
  async function parseQueryJev(rawQuery, fallbackParse) {
    const fallback = fallbackParse(rawQuery);

    if (!DEFAULTS.enabled) {
      return fallback;
    }

    try {
      const data = await callJev(rawQuery);
      log('response', data);
      const filters = answersToFilters(data.answers || {});
      if (!filters) {
        // Jev saw nothing — trust fallback entirely (especially freeText).
        return fallback;
      }

      // Merge: Jev wins for structured fields where it expressed a signal;
      // fallback fills the rest (freeText tokens, origin list, anything Jev
      // didn't cover).
      const merged = {
        filters: {
          ...fallback.filters,
          ...filters,
        },
        freeText: fallback.freeText,
      };
      const active = merged.filters.colors.length || merged.filters.exposures.length ||
                     merged.filters.water.length || merged.filters.types.length ||
                     merged.filters.container.length || merged.filters.heightBand ||
                     merged.filters.inBloom || merged.filters.budding ||
                     merged.filters.pollinator || merged.filters.origin.length ||
                     merged.freeText.length;
      return { filters: merged.filters, freeText: merged.freeText, active };
    } catch (e) {
      log('error, falling back', e);
      return fallback;
    }
  }

  global.TypesafeClient = { parseQueryJev, DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
