// Dust dissolve, ported from Telegram iOS (DustEffectShaders.metal, DustEffectLayer.swift):
// https://github.com/TelegramMessenger/Telegram-iOS/tree/master/submodules/TelegramUI/Components/DustEffect
//
// One grain per CSS pixel. Until a grain is released it draws its own tile of a full-resolution snapshot,
// so the element looks exactly intact; that is what makes the hand-off from DOM to canvas invisible.
// A wandering front sweeps left to right; grains just ahead of it tremble, then break away, round off,
// dwindle to a single device pixel, drift up on a swirling (divergence-free) air flow and glint faintly and go out.
// Canvas 2D instead of Metal, and the fluid simulation is replaced by analytic curl noise.

// ---------- Noise and hashes (same as the shader) ----------

function hash(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
/** Random value in [0, 1) for a grain; `salt` picks independent values. */
function rnd(id: number, salt: number): number {
  return (hash((Math.imul(id, 0x9e3779b9) + salt) >>> 0) >>> 8) / 16777216;
}

/** Gradient noise corner term: dot(gradient at lattice point, offset). Allocation-free (hot path). */
function corner(ix: number, iy: number, dx: number, dy: number): number {
  let n = (ix + iy * 11111) | 0;
  n = (n << 13) ^ n;
  n = (Math.imul(n, (Math.imul(Math.imul(n, n), 15731) + 789221) | 0) + 1376312589) >> 16;
  n &= 7;
  const gx = (n & 1) * 2 - 1;
  const gy = (n >> 1) * 2 - 1;
  return n >= 6 ? gx * dy : n >= 4 ? gx * dx : gx * dx + gy * dy;
}
function noise(px: number, py: number): number {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const d00 = corner(ix, iy, fx, fy), d10 = corner(ix + 1, iy, fx - 1, fy);
  const d01 = corner(ix, iy + 1, fx, fy - 1), d11 = corner(ix + 1, iy + 1, fx - 1, fy - 1);
  const a = d00 + (d10 - d00) * ux;
  const b = d01 + (d11 - d01) * ux;
  return a + (b - a) * uy;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;


/** Stream function of the air: slowly drifting noise. Its curl is the velocity, so dust swirls without bunching up. */
function psi(x: number, y: number, t: number): number {
  return noise(x / 34 + t * 0.15, y / 34 - t * 0.25) + 0.5 * noise(x / 15 + 9, y / 15 + t * 0.4);
}
const FLOW_CELL = 8; // CSS px, like Telegram's fluid grid
const FLOW_GAIN = 700; // stream-function gradient -> CSS px per sim second

// ---------- Effect ----------

export interface DustOptions {
  /** Paints the element in CSS px; origin = top-left of `rect` minus `margin`. Drawn at device resolution. */
  paint: (ctx: CanvasRenderingContext2D) => void;
  rect: DOMRect;
  /** Extra CSS px around the rect that the snapshot covers (shadow). */
  margin: number;
  parent: Node;
  /** Called after the first frame is on screen, when the canvas shows the intact element. */
  onTakeover: () => void;
  onDone: () => void;
}

const SWEEP = 0.5; // seconds the release front takes to cross
// Headroom for drifting dust, CSS px. Multiples of 8 so they land on whole device pixels at 125/150/175%.
const UP = 96;
const SIDE = 64;
const DOWN = 24;
const KEEP = 0.4; // share of grains that linger as dust; the rest just dim out as they come loose
const MAX_T = 3; // hard stop, seconds
const GHOST_ALPHA = 48; // cells fainter than this (soft shadow) fade in place instead of flying

export function dissolve(o: DustOptions): void {
  const dpr = window.devicePixelRatio || 1;
  const gw = Math.ceil(o.rect.width + o.margin * 2); // grain grid, CSS px
  const gh = Math.ceil(o.rect.height + o.margin * 2);
  // Device-pixel span of grain row/column i (fractional DPR gives 1- and 2-pixel tiles).
  const d0 = (i: number) => Math.floor(i * dpr);

  // Snapshot at exact device resolution.
  const snap = document.createElement("canvas");
  const sw = d0(gw), sh = d0(gh);
  snap.width = sw;
  snap.height = sh;
  const sctx = snap.getContext("2d")!;
  sctx.scale(dpr, dpr);
  o.paint(sctx);
  const src = sctx.getImageData(0, 0, sw, sh).data;

  // Output canvas, larger than the element so the dust can travel. Snapped to the device grid (1:1 pixels).
  const baseX = Math.round(SIDE * dpr), baseY = Math.round(UP * dpr);
  const cw = sw + baseX * 2;
  const ch = sh + baseY + Math.round(DOWN * dpr);
  const snapCss = (v: number) => Math.round(v * dpr) / dpr;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  Object.assign(canvas.style, {
    position: "fixed",
    left: `${snapCss(o.rect.left - o.margin) - baseX / dpr}px`,
    top: `${snapCss(o.rect.top - o.margin) - baseY / dpr}px`,
    width: `${cw / dpr}px`,
    height: `${ch / dpr}px`,
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  o.parent.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(cw, ch);
  const out = img.data;

  // ---- Grains (struct of arrays). One per CSS pixel with ink. ----
  const cap = gw * gh;
  const gX = new Int16Array(cap), gY = new Int16Array(cap);
  const cR = new Float32Array(cap), cG = new Float32Array(cap), cB = new Float32Array(cap), cA = new Float32Array(cap);
  const rel = new Float32Array(cap);
  const vx = new Float32Array(cap), vy = new Float32Array(cap);
  const ox = new Float32Array(cap), oy = new Float32Array(cap);
  const life = new Float32Array(cap), age = new Float32Array(cap);
  const shPh1 = new Float32Array(cap), shPh2 = new Float32Array(cap);
  const gSize = new Float32Array(cap), dStart = new Float32Array(cap), dDur = new Float32Array(cap);
  const inten = new Float32Array(cap), twOff = new Float32Array(cap);
  const ghost = new Uint8Array(cap), keep = new Uint8Array(cap);
  const ids = new Int32Array(cap);
  let n = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let r = 0, g = 0, b = 0, a = 0, k = 0;
      for (let y = d0(gy); y < d0(gy + 1); y++)
        for (let x = d0(gx); x < d0(gx + 1); x++) {
          const i = (y * sw + x) * 4;
          const al = src[i + 3];
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; k++;
        }
      const avg = a / Math.max(1, k);
      if (avg < 2) continue;
      const id = gy * gw + gx;
      const shape = clamp01(0.5 + 0.6 * (noise(gx / 22, gy / 22) + 0.5 * noise(gx / 9 + 31, gy / 9 + 31)));
      const dir = rnd(id, 4) * Math.PI * 2;
      const speed = 10 + rnd(id, 5) * 14;
      const pattern = noise(gx / 14, gy / 14) + 0.5 * noise(gx / 6 + 17, gy / 6 + 17);
      gX[n] = gx; gY[n] = gy; ids[n] = id;
      cR[n] = r / a; cG[n] = g / a; cB[n] = b / a; cA[n] = avg;
      ghost[n] = avg < GHOST_ALPHA ? 1 : 0;
      keep[n] = rnd(id, 12) < KEEP ? 1 : 0;
      // Where along the sweep the grain comes loose: mostly x, plus smooth noise (wandering edge) and scatter.
      rel[n] = 0.5 * (gx / gw) + 0.2 * shape + 0.3 * rnd(id, 6);
      vx[n] = Math.cos(dir) * speed; vy[n] = Math.sin(dir) * speed;
      // Neighbours leave in patches: lifetime follows noise.
      life[n] = keep[n] ? 1.3 + 1.1 * smooth(-0.45, 0.45, pattern) + rnd(id, 11) * 0.3 : 0.3 + 0.2 * rnd(id, 11);
      shPh1[n] = rnd(id, 1) * 6.283; shPh2[n] = rnd(id, 2) * 6.283;
      gSize[n] = 0.6 + 1.2 * Math.pow(rnd(id, 3), 2.2);
      dStart[n] = 0.1 + 0.3 * rnd(id, 9);
      dDur[n] = 0.5 + 0.8 * rnd(id, 10);
      inten[n] = 0.1 + 0.5 * Math.pow(rnd(id, 7), 4);
      twOff[n] = rnd(id, 8);
      n++;
    }
  }

  // ---- Air velocity on a coarse grid, refreshed every frame ----
  const fx0 = -SIDE, fy0 = -UP; // grid origin in grain coordinates (CSS px)
  const fgw = Math.ceil((gw + SIDE * 2) / FLOW_CELL) + 3;
  const fgh = Math.ceil((gh + UP + DOWN) / FLOW_CELL) + 3;
  const ps = new Float32Array(fgw * fgh);
  const fvx = new Float32Array(fgw * fgh);
  const fvy = new Float32Array(fgw * fgh);
  const updateFlow = (t: number) => {
    for (let j = 0; j < fgh; j++)
      for (let i = 0; i < fgw; i++) ps[j * fgw + i] = psi(fx0 + i * FLOW_CELL, fy0 + j * FLOW_CELL, t);
    const k = FLOW_GAIN / (2 * FLOW_CELL);
    for (let j = 1; j < fgh - 1; j++)
      for (let i = 1; i < fgw - 1; i++) {
        const c = j * fgw + i;
        fvx[c] = (ps[c + fgw] - ps[c - fgw]) * k;
        fvy[c] = -(ps[c + 1] - ps[c - 1]) * k;
      }
  };
  let flowX = 0, flowY = 0;
  const flowAt = (x: number, y: number) => {
    const gx = (x - fx0) / FLOW_CELL, gy = (y - fy0) / FLOW_CELL;
    const i = Math.min(fgw - 3, Math.max(1, gx | 0)), j = Math.min(fgh - 3, Math.max(1, gy | 0));
    const u = clamp01(gx - i), v = clamp01(gy - j);
    const c = j * fgw + i;
    flowX = mix(mix(fvx[c], fvx[c + 1], u), mix(fvx[c + fgw], fvx[c + fgw + 1], u), v);
    flowY = mix(mix(fvy[c], fvy[c + 1], u), mix(fvy[c + fgw], fvy[c + fgw + 1], u), v);
  };

  // ---- Pixel helpers on the output buffer (straight alpha) ----
  const blend = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || y < 0 || x >= cw || y >= ch || a <= 0.5) return;
    const o4 = (y * cw + x) * 4;
    const da = out[o4 + 3];
    if (da === 0 || a >= 254.5) {
      out[o4] = r; out[o4 + 1] = g; out[o4 + 2] = b; out[o4 + 3] = a;
      return;
    }
    const sa = a / 255, dA = (da / 255) * (1 - sa);
    const oa = sa + dA;
    out[o4] = (r * sa + out[o4] * dA) / oa;
    out[o4 + 1] = (g * sa + out[o4 + 1] * dA) / oa;
    out[o4 + 2] = (b * sa + out[o4 + 2] * dA) / oa;
    out[o4 + 3] = oa * 255;
  };
  /** Copy a grain's snapshot tile, shifted by (sx, sy) device px, alpha scaled by `fade`. */
  const copyTile = (gx: number, gy: number, sx: number, sy: number, fade: number) => {
    for (let y = d0(gy); y < d0(gy + 1); y++)
      for (let x = d0(gx); x < d0(gx + 1); x++) {
        const i = (y * sw + x) * 4;
        blend(baseX + x + sx, baseY + y + sy, src[i], src[i + 1], src[i + 2], src[i + 3] * fade);
      }
  };
  /** Clear a grain's tile at its resting place in `buf` (snapshot layout, or output layout when `outLayout`). */
  const clearTile = (buf: Uint8ClampedArray, outLayout: boolean, gx: number, gy: number) => {
    const stride = outLayout ? cw : sw, ox0 = outLayout ? baseX : 0, oy0 = outLayout ? baseY : 0;
    const x0 = d0(gx), x1 = d0(gx + 1);
    for (let y = d0(gy); y < d0(gy + 1); y++) buf.fill(0, ((oy0 + y) * stride + ox0 + x0) * 4, ((oy0 + y) * stride + ox0 + x1) * 4);
  };

  // Grains still resting in place live in `rest`, a copy of the snapshot that loses a tile for good when its
  // grain leaves. Each frame starts from it with a row copy, so only moving grains cost per-pixel work.
  const rest = new Uint8ClampedArray(src);
  const inRest = new Uint8Array(n).fill(1);
  const leave = (p: number) => {
    if (inRest[p]) {
      inRest[p] = 0;
      clearTile(rest, false, gX[p], gY[p]);
    }
  };
  // Per frame: what to draw on top. 1 = shifted tile, 2 = fading ghost tile, 3 = free grain.
  const mode = new Uint8Array(n);
  const shX = new Int8Array(n), shY = new Int8Array(n);
  const fadeA = new Float32Array(n);
  const tX = new Float32Array(n), tY = new Float32Array(n); // tremble offset of free grains, CSS px
  const drawList = new Int32Array(n);

  const onePx = 1 / dpr;
  let phase = 0;
  let last = 0;
  let first = true;

  const frame = (now: number) => {
    const dt = first ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    phase += dt;
    const sim = dt * 2; // Telegram runs the simulation at twice real time
    const effect = Math.min(SWEEP, phase) / SWEEP;
    const windowPos = -0.8 + 1.8 * effect;
    const releaseStart = 1.8 * effect;
    out.fill(0);
    for (let y = 0; y < sh; y++) out.set(rest.subarray(y * sw * 4, (y + 1) * sw * 4), ((baseY + y) * cw + baseX) * 4);
    if (sim > 0) updateFlow(phase);
    let alive = 0, nd = 0;

    // Pass 1: simulate, and lift every grain that is not exactly at rest out of the frame.
    for (let p = 0; p < n; p++) {
      if (life[p] <= 0) continue;
      // How far into its release window the grain is: 0 = held, 1 = moving at full speed.
      const pf = 1 - clamp01((rel[p] - windowPos) / 0.8);

      if (ghost[p]) {
        alive++;
        if (pf <= 0) continue;
        const fade = 1 - smooth(0, 0.6, pf);
        leave(p);
        if (fade <= 0) { life[p] = 0; continue; }
        mode[p] = 2; fadeA[p] = fade; drawList[nd++] = p;
        continue;
      }

      // Grains just ahead of the front loosen and tremble before they break away.
      let loose = 0;
      if (pf > 0) loose = 1 - smooth(0, 0.3, pf);
      else {
        const ahead = 1 - ((rel[p] - releaseStart) * gw) / 16;
        loose = ahead > 0 ? ahead * ahead : 0;
      }

      let dx = 0, dy = 0;
      if ((pf > 0 || loose > 0) && sim > 0) {
        flowAt(gX[p] + ox[p], gY[p] + oy[p]);
        dx = loose * (Math.sin(phase * 69 + shPh1[p]) * 0.4 + flowX * 0.006);
        dy = loose * (Math.sin(phase * 83 + shPh2[p]) * 0.4 + flowY * 0.006);
        if (pf > 0) {
          const step = sim * pf;
          vx[p] += -vx[p] * 1.5 * step;
          vy[p] += (-36 - vy[p] * 1.5) * step; // rise (canvas y grows downward)
          const hang = mix(1, 0.35, 1 - smooth(1, 1.6, life[p]));
          ox[p] += (vx[p] + flowX) * step * hang;
          oy[p] += (vy[p] + flowY) * step * hang;
          life[p] = Math.max(0, life[p] - step);
          age[p] += step;
          if (life[p] <= 0) { leave(p); continue; }
        }
      }
      alive++;

      if (age[p] <= 0) {
        // Still in place: its own tile of the snapshot, so the element looks intact. Trembling = shifted copy.
        const sx = Math.round(dx * dpr), sy = Math.round(dy * dpr);
        if (sx === 0 && sy === 0) continue;
        if (inRest[p]) clearTile(out, true, gX[p], gY[p]);
        mode[p] = 1; shX[p] = sx; shY[p] = sy; drawList[nd++] = p;
        continue;
      }
      leave(p);
      tX[p] = dx; tY[p] = dy;
      mode[p] = 3; drawList[nd++] = p;
    }

    // Pass 2: draw what moved.
    for (let k = 0; k < nd; k++) {
      const p = drawList[k];
      const m = mode[p];
      if (m === 1) { copyTile(gX[p], gY[p], shX[p], shY[p], 1); continue; }
      if (m === 2) { copyTile(gX[p], gY[p], 0, 0, fadeA[p]); continue; }

      // Free: becomes a round grain, dwindles to one device pixel, glints faintly, goes out.
      const a = age[p];
      const released = smooth(0, 0.25, a);
      const goingOut = smooth(0, keep[p] ? 0.6 : 0.3, life[p]);
      const cx = baseX + (gX[p] + 0.5 + ox[p] + tX[p]) * dpr;
      const cy = baseY + (gY[p] + 0.5 + oy[p] + tY[p]) * dpr;
      let alpha = cA[p] * goingOut;
      if (!keep[p]) {
        // Short-lived grain: a single pixel that dims out.
        blend(cx | 0, cy | 0, cR[p], cG[p], cB[p], alpha * (1 - 0.5 * released));
        continue;
      }
      alpha *= 0.85;
      const dp = clamp01((a - dStart[p]) / dDur[p]);
      const dwindled = 1 - (1 - dp) * (1 - dp);
      const sizeDev = mix(1, mix(gSize[p] * 1.13, onePx, dwindled), released) * dpr;

      let glint = 0;
      if (dwindled > 0.85) {
        const tw = a * 12 + twOff[p];
        const twi = Math.floor(tw);
        const flash = rnd(ids[p], 1000 + twi);
        const peak = flash > 0.8 ? 0.4 + 0.3 * flash : 0.1;
        const rise = Math.sin((tw - twi) * Math.PI);
        glint = released * smooth(0.85, 1, dwindled) * inten[p] * mix(0.15, peak, rise * rise) * goingOut;
      }
      let r = cR[p], g = cG[p], b = cB[p];
      if (glint > 0) {
        // The pixel catches the light: towards warm white with a trace of its own colour.
        const q = Math.min(0.6, glint * 1.5);
        r = mix(r, mix(r, 255, 0.8), q);
        g = mix(g, mix(g, 250, 0.8), q);
        b = mix(b, mix(b, 240, 0.8), q);
      }

      if (sizeDev <= 1.6) {
        // About one pixel: alpha by coverage, so dwindling stays smooth.
        blend(cx | 0, cy | 0, r, g, b, alpha * Math.min(1, sizeDev * sizeDev));
      } else {
        const rad = sizeDev / 2;
        const x0 = Math.floor(cx - rad), x1 = Math.ceil(cx + rad);
        const y0 = Math.floor(cy - rad), y1 = Math.ceil(cy + rad);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const ddx = x + 0.5 - cx, ddy = y + 0.5 - cy;
            const cov = clamp01(rad - Math.sqrt(ddx * ddx + ddy * ddy) + 0.5); // one-pixel edge ramp
            if (cov > 0) blend(x, y, r, g, b, alpha * cov);
          }
      }
    }

    ctx.putImageData(img, 0, 0);
    if (first) {
      first = false;
      o.onTakeover();
    }
    if (alive > 0 && phase < MAX_T) requestAnimationFrame(frame);
    else {
      canvas.remove();
      o.onDone();
    }
  };
  last = performance.now();
  frame(last);
}
