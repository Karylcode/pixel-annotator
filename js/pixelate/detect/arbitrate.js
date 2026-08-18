/* pixelate/detect/arbitrate.js
   移植自 Pixel Art Fixer python/pixelfixer/core.py 共識／仲裁
   commit ef376e57e1c272633ca2dbf5f29ec3fcf6596465  MIT
   P2：快速路徑 + 非 precise 評分。precise 的 vc/recon 見 P6。 */
const PA_ROOT = typeof globalThis !== 'undefined' ? globalThis : self;
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

  function pickAxis(votes, w, h, axis, extent, precise, rgba) {
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

    let vmax = -Infinity;
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
      let z = fused + 0.25 * Math.max(0, agree - 1);
      if (z > vmax) vmax = z;
      return { s, z, agree };
    });
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

    let sx = pickAxis(valid, w, h, 'x', w, params && params.precise, rgba);
    let sy = pickAxis(valid, w, h, 'y', h, params && params.precise, rgba);
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
