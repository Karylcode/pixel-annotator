/* pixelate/detect/arbitrate.js
   移植自 Pixel Art Fixer python/pixelfixer/core.py 共識／仲裁
   + varcontrast.py / reconsearch.py（precise：積分影像變異數對比與 round-trip 誤差）
   commit ef376e57e1c272633ca2dbf5f29ec3fcf6596465  MIT */
var PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
PA_ROOT.PA = PA_ROOT.PA || {};
PA.pixelate = PA.pixelate || {};

(function() {
  const SMALLEST_QUALIFIED = 0.78;

  function median(arr) {
    const a = arr.slice().sort((x, y) => x - y);
    const m = (a.length - 1) / 2;
    return (a[Math.floor(m)] + a[Math.ceil(m)]) / 2;
  }

  function nxOf(v, w) {
    if (v.meta && v.meta.nx != null) return v.meta.nx;
    return Math.max(1, Math.round((w - (v.phx || 0)) / v.sx));
  }
  function nyOf(v, h) {
    if (v.meta && v.meta.ny != null) return v.meta.ny;
    return Math.max(1, Math.round((h - (v.phy || 0)) / v.sy));
  }

  function closeSize(a, b, w, h) {
    const na = nxOf(a, w), nb = nxOf(b, w);
    const ma = nyOf(a, h), mb = nyOf(b, h);
    return Math.abs(na - nb) <= Math.max(1, 0.01 * nb) &&
           Math.abs(ma - mb) <= Math.max(1, 0.01 * mb);
  }

  function scoreAt(vote, s, axis) {
    const curve = axis === 'y' ? (vote.meta && (vote.meta.curveY || vote.meta.curve)) : (vote.meta && vote.meta.curve);
    const target = axis === 'y' ? vote.sy : vote.sx;
    if (curve && curve.length) {
      let best = null, bd = Infinity;
      for (let i = 0; i < curve.length; i++) {
        const d = Math.abs(Math.log(curve[i][0] / s));
        if (d < bd) { bd = d; best = curve[i][1]; }
      }
      if (bd < 0.08) return best;
    }
    return Math.abs(Math.log(target / s)) < 0.03 ? (vote.score || 1) : 0;
  }

  function bestPhase(E, s) {
    let bv = -1, bp = 0;
    for (let k = 0; k < 64; k++) {
      const phi = s * k / 64;
      let on = 0, n = 0;
      for (let x = phi; x < E.length - 0.5; x += s) {
        const i = Math.round(x);
        if (i >= 0 && i < E.length) { on += E[i]; n++; }
      }
      const v = n ? on / n : -1;
      if (v > bv) { bv = v; bp = phi; }
    }
    return bp;
  }

  function buildSat(rgba, w, h) {
    const stride = w + 1;
    const S = new Float64Array((h + 1) * stride);
    const Q = new Float64Array((h + 1) * stride);
    for (let y = 0; y < h; y++) {
      let rowS = 0, rowQ = 0;
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const a = rgba[p + 3] / 255;
        const g = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) * a;
        rowS += g; rowQ += g * g;
        const i = (y + 1) * stride + (x + 1);
        S[i] = S[y * stride + (x + 1)] + rowS;
        Q[i] = Q[y * stride + (x + 1)] + rowQ;
      }
    }
    const n = w * h || 1;
    const tot = S[(h + 1) * stride - 1];
    const tot2 = Q[(h + 1) * stride - 1];
    const mean = tot / n;
    return { S, Q, w, h, stride, totalVar: Math.max(1e-9, tot2 / n - mean * mean) };
  }

  function rectSum(A, stride, x0, y0, x1, y1) {
    return A[y1 * stride + x1] - A[y0 * stride + x1] - A[y1 * stride + x0] + A[y0 * stride + x0];
  }

  function meanCellVar(sat, s, phi, axis) {
    const { S, Q, w, h, stride } = sat;
    const phx = axis === 'x' ? phi : 0;
    const phy = axis === 'y' ? phi : 0;
    const nx = Math.max(1, Math.floor((w - phx) / s));
    const ny = Math.max(1, Math.floor((h - phy) / s));
    let sum = 0, n = 0;
    for (let j = 0; j < ny; j++) {
      const y0 = Math.max(0, Math.round(phy + j * s));
      const y1 = Math.min(h, Math.round(phy + (j + 1) * s));
      if (y1 <= y0) continue;
      for (let i = 0; i < nx; i++) {
        const x0 = Math.max(0, Math.round(phx + i * s));
        const x1 = Math.min(w, Math.round(phx + (i + 1) * s));
        if (x1 <= x0) continue;
        const area = (x1 - x0) * (y1 - y0);
        const s1 = rectSum(S, stride, x0, y0, x1, y1);
        const s2 = rectSum(Q, stride, x0, y0, x1, y1);
        const mu = s1 / area;
        sum += Math.max(0, s2 / area - mu * mu);
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  function vcRecon(sat, s, axis) {
    const nPh = 6;
    let best = Infinity, worst = -Infinity, bestPhi = 0;
    for (let k = 0; k < nPh; k++) {
      const phi = s * k / nPh;
      const v = meanCellVar(sat, s, phi, axis);
      if (v < best) { best = v; bestPhi = phi; }
      if (v > worst) worst = v;
    }
    const vc = (worst - best) / (best + 0.05 * sat.totalVar);
    const er = meanCellVar(sat, s, (bestPhi + s / 2) % s, axis);
    return { vc: Math.max(0, vc), eb: best, er };
  }

  function detailCap(rgba, w, h) {
    const runs = [];
    for (let y = 0; y < h; y += Math.max(1, (h / 128) | 0)) {
      let run = 0;
      for (let x = 1; x < w; x++) {
        const p = (y * w + x) * 4, q = p - 4;
        const d = Math.abs(rgba[p] - rgba[q]) + Math.abs(rgba[p + 1] - rgba[q + 1]) + Math.abs(rgba[p + 2] - rgba[q + 2]);
        if (d > 24) run++;
        else if (run) { runs.push(run); run = 0; }
      }
      if (run) runs.push(run);
    }
    if (!runs.length) return Infinity;
    runs.sort((a, b) => a - b);
    return Math.max(4, runs[(runs.length * 0.1) | 0] * 3);
  }

  function pickAxis(votes, w, h, axis, extent, precise, sat, cap) {
    const key = axis === 'x' ? 'sx' : 'sy';
    const pool = [];
    function add(s) {
      if (!(s > 1.2 && s < extent / 3)) return;
      for (let i = 0; i < pool.length; i++) {
        if (Math.abs(Math.log(pool[i] / s)) < 0.03) return;
      }
      pool.push(s);
    }
    for (let i = 0; i < votes.length; i++) {
      if (!votes[i]) continue;
      add(votes[i][key]);
      const cands = votes[i].meta && votes[i].meta.candidates;
      if (cands) for (let j = 0; j < Math.min(5, cands.length); j++) add(cands[j].s);
    }
    if (!pool.length) return null;

    const scores = pool.map(s => {
      let fused = 0, n = 0, agree = 0;
      for (let i = 0; i < votes.length; i++) {
        const v = votes[i];
        if (!v) continue;
        fused += scoreAt(v, s, axis);
        n++;
        const vs = axis === 'x' ? v.sx : v.sy;
        if (Math.abs(vs - s) / s <= 0.03) agree++;
      }
      fused = n ? fused / n : 0;
      return { s, z: fused + 0.25 * Math.max(0, agree - 1), agree };
    });

    if (precise && sat) {
      const recs = [];
      const ebs = [];
      for (let i = 0; i < scores.length; i++) {
        const r = vcRecon(sat, scores[i].s, axis);
        ebs.push(r.eb);
        recs.push(Math.max(r.er - r.eb, 0));
        scores[i].z += 0.20 * r.vc;
      }
      let rmax = 0;
      for (let i = 0; i < recs.length; i++) if (recs[i] > rmax) rmax = recs[i];
      const sorted = ebs.slice().sort((a, b) => a - b);
      const trend = sorted[sorted.length >> 1] || 1e-9;
      for (let i = 0; i < scores.length; i++) {
        const rec = recs[i] * Math.max(1 - ebs[i] / trend, 0);
        scores[i].z += 0.6 * (rmax ? rec / rmax : 0);
        if (cap && scores[i].s > cap) scores[i].z *= 0.35;
      }
    }

    let vmax = -Infinity;
    for (let i = 0; i < scores.length; i++) if (scores[i].z > vmax) vmax = scores[i].z;
    const qual = scores.filter(c => c.z >= SMALLEST_QUALIFIED * vmax);
    qual.sort((a, b) => a.s - b.s);
    return (qual[0] || scores.sort((a, b) => b.z - a.z)[0]).s;
  }

  async function run(votes, rgba, w, h, params, hooks) {
    const valid = (votes || []).filter(Boolean);
    if (!valid.length) return null;
    if (valid.length === 1) return PA.pixelate.voteToGrid(valid[0], w, h, votes);

    let agree = true;
    for (let i = 1; i < valid.length; i++) {
      if (!closeSize(valid[0], valid[i], w, h)) { agree = false; break; }
    }
    let aspectOk = true;
    for (let i = 0; i < valid.length && aspectOk; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const li = Math.log(valid[i].sx / valid[i].sy);
        const lj = Math.log(valid[j].sx / valid[j].sy);
        if (Math.abs(li - lj) >= 0.35) aspectOk = false;
      }
    }
    if (valid.length >= 3 && agree && aspectOk) {
      const nx = Math.round(median(valid.map(v => nxOf(v, w))));
      const ny = Math.round(median(valid.map(v => nyOf(v, h))));
      const sx = median(valid.map(v => v.sx));
      const sy = median(valid.map(v => v.sy));
      return {
        sx, sy, phx: valid[0].phx, phy: valid[0].phy, nx, ny,
        scoreX: valid[0].score, scoreY: valid[0].score,
        source: 'consensus', votes,
      };
    }

    const precise = !!(params && params.precise);
    const sat = precise && rgba ? buildSat(rgba, w, h) : null;
    const cap = precise && rgba ? detailCap(rgba, w, h) : Infinity;
    if (hooks && hooks.tick) await hooks.tick();
    if (hooks && hooks.cancelled && hooks.cancelled()) return null;
    let sx = pickAxis(valid, w, h, 'x', w, precise, sat, cap);
    let sy = pickAxis(valid, w, h, 'y', h, precise, sat, cap);
    if (!sx || !sy) return PA.pixelate.voteToGrid(valid[0], w, h, votes);

    const lr = Math.abs(Math.log(sx / sy));
    if (lr < 0.08) {
      const hmean = 2 * sx * sy / (sx + sy);
      sx = sy = hmean;
    } else if (lr > 0.45) {
      const finer = sx < sy ? sx : sy;
      sx = sy = finer;
    }

    let phx = 0, phy = 0;
    const match = valid.find(v => Math.abs(v.sx - sx) / sx < 0.03);
    if (match) { phx = match.phx; phy = match.phy; }
    else {
      const prof = PA.pixelate.edgeProfiles(rgba, w, h);
      phx = bestPhase(prof.ex, sx);
      phy = bestPhase(prof.ey, sy);
    }
    const nx = Math.max(1, Math.min(512, Math.round((w - phx) / sx)));
    const ny = Math.max(1, Math.min(512, Math.round((h - phy) / sy)));
    return {
      sx, sy, phx, phy, nx, ny,
      scoreX: 1, scoreY: 1,
      source: 'arbitration', votes,
    };
  }

  PA.pixelate.register('detect', {
    id: 'arbitrate',
    label: '共識／仲裁',
    credit: { project: 'Pixel Art Fixer', file: 'python/pixelfixer/core.py', license: 'MIT', url: 'https://github.com/Retro-Diffusion/pixel-art-fixer' },
    cost: 'fast',
    params: [],
    run,
  });
})();
