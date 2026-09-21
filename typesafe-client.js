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
    const startedAt = Date.now();
    try {
      const { data, error } = await supabase.functions.invoke('jev-classify', {
        body: { query: rawQuery },
      });
      const ms = Date.now() - startedAt;
      if (error) throw new Error(error.message || 'jev-classify error');
      if (controller.signal.aborted) throw new Error('aborted');
      // Attach timing + a "used" flag so parseQueryJev can log it for analytics.
      if (data && typeof data === 'object') {
        data.__meta = { jevMs: ms, jevUsed: true };
      }
      return data;
    } catch (e) {
      const ms = Date.now() - startedAt;
      throw Object.assign(e, { __meta: { jevMs: ms, jevUsed: true, error: true } });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sanitize the Edge Function's already-mapped filter shape.
   * Returns null if no filter signal — caller treats that as "fall back".
   */
  function answersToFilters(filters) {
    if (!filters || typeof filters !== 'object') return null;
    // The Edge Function already maps Jev's answers into the parseQuery filter
    // shape and returns it as `filters`. We just sanitize the shape here and
    // return it as-is for the merger in parseQueryJev.
    const out = {
      colors:     Array.isArray(filters.colors)     ? filters.colors     : [],
      exposures:  Array.isArray(filters.exposures)  ? filters.exposures  : [],
      water:      Array.isArray(filters.water)      ? filters.water      : [],
      types:      Array.isArray(filters.types)      ? filters.types      : [],
      container:  Array.isArray(filters.container)  ? filters.container  : [],
      origin:     Array.isArray(filters.origin)     ? filters.origin     : [],
      heightBand: filters.heightBand || null,
      inBloom:    !!filters.inBloom,
      budding:    !!filters.budding,
      pollinator: !!filters.pollinator,
      isPlantName: !!filters.isPlantName,
      // Score primitive output (2026-09-20 pilot): scale the name-match
      // boost by score (0..4) and confidence (0..1) instead of applying a
      // hard binary threshold. null when Edge Function returns neither
      // (older deployments / fallback path).
      plantNameScore: Number.isFinite(filters.plantNameScore) ? filters.plantNameScore : null,
      plantNameConfidence: Number.isFinite(filters.plantNameConfidence) ? filters.plantNameConfidence : null,
    };
    const anySignal =
      out.colors.length || out.exposures.length || out.water.length ||
      out.types.length || out.container.length || out.origin.length ||
      out.heightBand || out.inBloom || out.budding || out.pollinator ||
      out.isPlantName || out.plantNameScore !== null;
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
      // Jev disabled — explicitly mark meta so analytics knows we skipped it.
      fallback.__meta = { jevMs: 0, jevUsed: false };
      return fallback;
    }

    try {
      const data = await callJev(rawQuery);
      log('response', data);
      const filters = answersToFilters(data?.filters);
      if (!filters) {
        // Jev saw nothing — trust fallback entirely (especially freeText).
        return fallback;
      }

      // Merge: Jev always wins where it expressed a signal. The fallback
      // (regex parser) only fills empty slots — it doesn't overwrite Jev's
      // structured answers. Critical for heightBand: the regex only matches
      // "under 1'" (apostrophe) not "under 1 foot", so Jev's "under1" must
      // not be overwritten by fallback's null.
      const merged = {
        filters: {
          colors:     filters.colors.length     ? filters.colors     : fallback.filters.colors,
          exposures:  filters.exposures.length  ? filters.exposures  : fallback.filters.exposures,
          water:      filters.water.length      ? filters.water      : fallback.filters.water,
          types:      filters.types.length      ? filters.types      : fallback.filters.types,
          container:  filters.container.length  ? filters.container  : fallback.filters.container,
          origin:     filters.origin.length     ? filters.origin     : fallback.filters.origin,
          heightBand: filters.heightBand || fallback.filters.heightBand,
          inBloom:    filters.inBloom    || fallback.filters.inBloom,
          budding:    filters.budding    || fallback.filters.budding,
          pollinator: filters.pollinator || fallback.filters.pollinator,
          isPlantName: filters.isPlantName || fallback.filters.isPlantName,
          plantNameScore: filters.plantNameScore ?? fallback.filters.plantNameScore ?? null,
          plantNameConfidence: filters.plantNameConfidence ?? fallback.filters.plantNameConfidence ?? null,
        },
        freeText: fallback.freeText,
      };
      const active = merged.filters.colors.length || merged.filters.exposures.length ||
                     merged.filters.water.length || merged.filters.types.length ||
                     merged.filters.container.length || merged.filters.heightBand ||
                     merged.filters.inBloom || merged.filters.budding ||
                     merged.filters.pollinator || merged.filters.origin.length ||
                     merged.freeText.length;
      // Attach timing meta so availability.html can log per-search analytics.
      return { filters: merged.filters, freeText: merged.freeText, active, __meta: data?.__meta };
    } catch (e) {
      log('error, falling back', e);
      // Even on failure, surface the timing meta (with error flag) so analytics
      // can record that Jev was attempted but failed.
      fallback.__meta = e.__meta || { jevMs: 0, jevUsed: true, error: true };
      return fallback;
    }
  }

  global.TypesafeClient = { parseQueryJev, DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
