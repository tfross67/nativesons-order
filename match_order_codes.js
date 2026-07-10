// Smart item-code matching for Native Sons orders.
// Requires: window.MASTER_ITEM_FULL must be loaded first.
(function() {
  const SPECIES_EXPANSIONS = {
    "grand\\.": "grandiflora",
    "nutkae\\.\\s*x\\s*fol\\.": "nutkaensis x foliosa",
    "sto\\.": "stoechas",
    "cookia\\.": "cookianum",
    "california\\b": "californica",
  };

  function normSize(s) {
    if (!s) return "";
    s = String(s).replace(/\n/g, "").trim().toLowerCase();
    if (!s) return "";
    if (s.endsWith('"')) {
      try { return (parseInt(s.slice(0, -1), 10) || s) + "inch"; } catch (e) { return s; }
    }
    if (s.endsWith("g") && s.length > 1) {
      try { return (parseInt(s.slice(0, -1), 10) || s) + "gal"; } catch (e) { return s; }
    }
    return s.replace(/\s+/g, "");
  }

  function expandDesc(s) {
    let r = String(s).toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
    for (const [k, v] of Object.entries(SPECIES_EXPANSIONS)) {
      const re = new RegExp("\\b" + k + "\\b", "g");
      r = r.replace(re, v);
    }
    r = r.replace(/\s*\([^)]*\)\s*$/, "").trim();
    return r;
  }

  function smartMatch(plantName, size) {
    if (!plantName || !window.MASTER_ITEM_FULL) return null;
    let pn = plantName.toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
    pn = pn.replace(/\s+n\s*$/, "").trim();
    pn = pn.replace(/\s+/g, " ");

    const cm = pn.match(/['\u2018\u2019]([^'\u2018\u2019]+)['\u2018\u2019]/);
    const cultivar = cm ? cm[1].toLowerCase().trim() : null;
    const genus = pn.split(' ')[0] || '';
    const sz = normSize(size);
    if (!sz) return null;

    const cands = (window.MASTER_ITEM_FULL || []).filter(m => {
      const g = m.d.split(' ')[0].toLowerCase();
      return g === genus && m.s === sz;
    });
    if (!cands.length) return null;

    // Pass 1: full plant name appears in expanded master description
    for (const m of cands) {
      const ed = expandDesc(m.d);
      if (ed === pn || pn === ed) return m;
    }

    // Pass 2: cultivar word appears in master description, prefer end-anchored matches
    if (cultivar) {
      const withCultivar = cands.filter(m => {
        const ed = expandDesc(m.d);
        return ed.includes(cultivar);
      });
      if (withCultivar.length === 1) return withCultivar[0];
      if (withCultivar.length > 1) {
        // Prefer the one whose expanded description ENDS with the cultivar in quotes
        const ended = withCultivar.filter(m => {
          const ed = expandDesc(m.d);
          return ed.endsWith("'" + cultivar + "'");
        });
        if (ended.length >= 1) return ended[0];
        return withCultivar[0];
      }
    }

    // Pass 3: genus-only fallback (sparingly — may mis-match on cultivars)
    // Only use if no other candidate exists
    return null;
  }

  window.matchItemCode = smartMatch;
  window.normSize = normSize;
})();
