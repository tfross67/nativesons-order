/* Glimm-style page transition sweep for the wholesale portal.

Vanilla JS + WebGL port of the glimm library's sweep effect. Triggered on:
  - Submit order success (celebration of the action)
  - Compact ↔ tile view switch (section-level navigation)

Self-contained: ~10 KB of JS + GLSL, no framework deps. Builds a single
WebGL context lazily on the first sweep, so an app that never triggers
costs nothing. Falls back to a CSS animation if WebGL isn't available.

Usage:
  window.__glimm.trigger({ palette: 'prism' });
  window.__glimm.trigger({ palette: 'citrus', direction: 'rtl' });
*/
(function () {
  'use strict';

  // 6 cosine-gradient palettes inlined from glimm — {a, b, c, d} in 0..1 RGB.
  const PALETTES = {
    prism:  { a: [0.66, 0.55, 0.74], b: [0.40, 0.42, 0.46], c: [0.50, 0.50, 0.50], d: [0.54, 0.22, 0.84] },
    berry:  { a: [0.86, 0.30, 0.55], b: [0.42, 0.20, 0.40], c: [0.50, 0.50, 0.50], d: [0.10, 0.20, 0.40] },
    lagoon: { a: [0.20, 0.66, 0.78], b: [0.30, 0.30, 0.40], c: [0.50, 0.50, 0.50], d: [0.62, 0.42, 0.32] },
    citrus: { a: [0.92, 0.74, 0.28], b: [0.30, 0.36, 0.20], c: [0.50, 0.50, 0.50], d: [0.18, 0.44, 0.16] },
    azure:  { a: [0.30, 0.55, 0.86], b: [0.30, 0.30, 0.40], c: [0.50, 0.50, 0.50], d: [0.60, 0.10, 0.20] },
    ember:  { a: [0.94, 0.42, 0.18], b: [0.40, 0.30, 0.18], c: [0.50, 0.50, 0.50], d: [0.10, 0.30, 0.40] },
  };

  // 10 easing curves inlined from glimm. Each takes t in [0,1] -> eased t.
  const EASINGS = {
    snap:   t => t < 0.4 ? 0 : t > 0.6 ? 1 : (t - 0.4) / 0.2,
    linear: t => t,
    ease:   t => 1 - Math.pow(1 - t, 3),
    easeOutQuart: t => 1 - Math.pow(1 - t, 4),
    easeInCubic: t => t * t * t,
    easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    easeOutExpo: t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
    back:   t => {
      const c1 = 1.70158, c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    sine:   t => 1 - Math.cos((t * Math.PI) / 2),
    quad:   t => 1 - (1 - t) * (1 - t),
  };

  const VERT_SRC = `
    attribute vec2 a_position;
    void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
  `;

  // Fragment shader — sweeps a soft gaussian band across the screen.
  // Reads u_palette uniform (a, b, c, d) to compute color via cosine palette.
  const FRAG_SRC = `
    precision mediump float;
    uniform float u_time;       // 0..1 progress of the sweep
    uniform float u_sweepMs;     // not used; for future tuning
    uniform vec3 u_a, u_b, u_c, u_d;
    uniform float u_direction;   // 0=LTR, 1=RTL, 2=TTB, 3=BTT
    uniform float u_bandTight;
    uniform float u_peakAlpha;
    uniform float u_brightness;
    varying vec2 v_uv;

    vec3 palette(float t) {
      // Cosine palette: a + b * cos(2*PI * (c*t + d))
      return u_a + u_b * cos(6.28318 * (u_c * t + u_d));
    }

    void main() {
      // Progress along sweep axis.
      float progress = u_time;
      float bandCenter;
      if (u_direction < 0.5)      bandCenter = v_uv.x;
      else if (u_direction < 1.5) bandCenter = 1.0 - v_uv.x;
      else if (u_direction < 2.5) bandCenter = v_uv.y;
      else                        bandCenter = 1.0 - v_uv.y;

      // Gaussian falloff centered on the band.
      float dx = bandCenter - progress;
      float band = exp(-dx * dx * u_bandTight);

      // Color from cosine palette using position along axis.
      vec3 col = palette(v_uv.x);
      col *= u_brightness;

      gl_FragColor = vec4(col, band * u_peakAlpha);
    }
  `;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile failed: ' + log);
    }
    return sh;
  }

  function link(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program link failed');
    }
    return p;
  }

  let canvas, gl, program, buf, uniforms, css3dFallback;
  let pending = null;        // queued trigger (only one — last wins)
  let animating = false;     // a sweep is currently in flight
  let rafId = 0;             // current rAF id so we can cancel

  function cancel() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  function init() {
    if (canvas || css3dFallback) return;
    const c = document.createElement('canvas');
    c.id = 'glimm-sweep';
    c.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;'
                    + 'pointer-events:none;z-index:99999;display:none;mix-blend-mode:normal;';
    const ctx = c.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true });
    if (!ctx) {
      // CSS-only fallback
      css3dFallback = document.createElement('div');
      css3dFallback.id = 'glimm-sweep-fallback';
      css3dFallback.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;'
                                 + 'pointer-events:none;z-index:99999;background:linear-gradient(90deg,transparent,#7fc89e 50%,transparent);'
                                 + 'transition:width 800ms cubic-bezier(.5,0,.5,1);';
      document.body.appendChild(css3dFallback);
      return;
    }
    gl = ctx;
    canvas = c;
    document.body.appendChild(canvas);
    const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    program = link(gl, vs, fs);
    buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1, 1,   1, -1,   1, 1,
    ]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    uniforms = {
      time:      gl.getUniformLocation(program, 'u_time'),
      a:         gl.getUniformLocation(program, 'u_a'),
      b:         gl.getUniformLocation(program, 'u_b'),
      c:         gl.getUniformLocation(program, 'u_c'),
      d:         gl.getUniformLocation(program, 'u_d'),
      direction: gl.getUniformLocation(program, 'u_direction'),
      bandTight: gl.getUniformLocation(program, 'u_bandTight'),
      peakAlpha: gl.getUniformLocation(program, 'u_peakAlpha'),
      brightness:gl.getUniformLocation(program, 'u_brightness'),
    };
  }

  function run(opts) {
    // Cancel any in-flight sweep — last trigger wins. This handles the
    // case where a previous sweep's rAF never ran (e.g. page was hidden)
    // and left animating stuck true, blocking all future triggers.
    cancel();
    pending = null;
    animating = true;
    init();
    const palName = opts.palette || 'prism';
    const pal = (typeof palName === 'string' ? PALETTES[palName] : palName) || PALETTES.prism;
    const sweepMs = opts.sweepMs || 800;
    const outroMs = opts.outroMs || 350;
    const easing = (typeof opts.easing === 'function' ? opts.easing
                  : (typeof opts.easing === 'string' ? EASINGS[opts.easing] : null)) || EASINGS.easeInOutCubic;
    const directionMap = { ltr: 0, rtl: 1, ttb: 2, btt: 3 };
    const direction = directionMap[opts.direction || 'ltr'];
    const bandTight = opts.bandTight != null ? opts.bandTight : 14;
    const peakAlpha = opts.peakAlpha != null ? opts.peakAlpha : 1.0;
    const brightness = opts.brightness != null ? opts.brightness : 1.0;

    if (css3dFallback) {
      // CSS fallback — animate width from 0 to 100vw
      css3dFallback.style.transitionDuration = sweepMs + 'ms';
      css3dFallback.style.transitionTimingFunction = 'cubic-bezier(.34,1.56,.64,1)';
      css3dFallback.style.width = '100vw';
      setTimeout(() => {
        css3dFallback.style.transitionDuration = outroMs + 'ms';
        css3dFallback.style.transitionTimingFunction = 'ease-out';
        css3dFallback.style.opacity = '0';
      }, sweepMs);
      setTimeout(() => {
        css3dFallback.style.transition = 'none';
        css3dFallback.style.width = '0';
        css3dFallback.style.opacity = '1';
        animating = false;
        if (pending) { const p = pending; pending = null; run(p); }
        if (opts.onDone) opts.onDone();
      }, sweepMs + outroMs);
      return;
    }

    canvas.style.display = 'block';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.uniform3fv(uniforms.a, pal.a);
    gl.uniform3fv(uniforms.b, pal.b);
    gl.uniform3fv(uniforms.c, pal.c);
    gl.uniform3fv(uniforms.d, pal.d);
    gl.uniform1f(uniforms.direction, direction);
    gl.uniform1f(uniforms.bandTight, bandTight);
    gl.uniform1f(uniforms.peakAlpha, peakAlpha);
    gl.uniform1f(uniforms.brightness, brightness);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    const start = performance.now();
    function frame(now) {
      const t = Math.min((now - start) / sweepMs, 1);
      const eased = easing(t);
      gl.uniform1f(uniforms.time, eased);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (t < 1) {
        rafId = requestAnimationFrame(frame);
      } else {
        // Outro — fade out the band by reducing peak alpha
        const fadeStart = performance.now();
        function fade(now) {
          const ft = Math.min((now - fadeStart) / outroMs, 1);
          gl.uniform1f(uniforms.peakAlpha, peakAlpha * (1 - ft));
          gl.uniform1f(uniforms.time, eased + ft * 0.05); // drift slightly
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          if (ft < 1) {
            rafId = requestAnimationFrame(fade);
          } else {
            canvas.style.display = 'none';
            gl.clear(gl.COLOR_BUFFER_BIT);
            animating = false;
            rafId = 0;
            if (pending) { const p = pending; pending = null; run(p); }
            if (opts.onDone) opts.onDone();
          }
        }
        rafId = requestAnimationFrame(fade);
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  // Public API
  window.__glimm = {
    trigger(opts = {}) {
      try { run(opts); } catch (e) { console.warn('[glimm] sweep failed:', e); }
    },
    palettes: Object.keys(PALETTES),
    easings: Object.keys(EASINGS),
  };
})();
