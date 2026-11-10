
const MU = 398600.4418;
const EARTH_KM = 6378.137;

export const DEFAULTS = {
  hours: 24,
  coarseS: 90,
  padKm: 50,
  keepKm: 120,
  alertKm: 10,
};

export function shell(satrec) {
  const n = satrec.no / 60;
  const a = Math.cbrt(MU / (n * n));
  return { a, e: satrec.ecco, periKm: a * (1 - satrec.ecco), apoKm: a * (1 + satrec.ecco) };
}

export function reachable(mine, catalogue, padKm = DEFAULTS.padKm) {
  const out = [];
  for (const other of catalogue) {
    if (other === mine || other.id === mine.id) {
      continue;
    }
    if (mine.periKm <= other.apoKm + padKm && other.periKm <= mine.apoKm + padKm) {
      out.push(other);
    }
  }
  return out;
}

const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function guess(a, b, c, stepS) {
  const vv = (a * a + c * c - 2 * b * b) / (2 * stepS * stepS);
  if (!(vv > 0) || !Number.isFinite(vv)) {
    return { km: b, offsetS: 0 };
  }
  const offsetS = (a * a - c * c) / (4 * stepS * vv);
  const mm = b * b - vv * offsetS * offsetS;
  return {
    km: mm > 0 ? Math.sqrt(mm) : 0,
    offsetS: Math.abs(offsetS) <= stepS ? offsetS : 0,
  };
}

export function passes(track, other, propagate, { keepKm = DEFAULTS.keepKm, stepS = DEFAULTS.coarseS } = {}) {
  const found = [];
  let twoBack = Infinity;
  let oneBack = Infinity;
  let atOneBack = null;
  for (const step of track) {
    const theirs = propagate(other, step.when);
    const d = theirs && step.p ? gap(theirs, step.p) : Infinity;
    if (oneBack < twoBack && oneBack < d) {
      const fitted = guess(twoBack, oneBack, d, stepS);
      if (fitted.km < keepKm) {
        found.push({ around: new Date(atOneBack.getTime() + fitted.offsetS * 1000), sampled: oneBack, fitted: fitted.km });
      }
    }
    twoBack = oneBack;
    oneBack = d;
    atOneBack = step.when;
  }
  return found;
}

const PHI = (Math.sqrt(5) - 1) / 2;

export function refine(mine, other, around, propagate, { windowS = DEFAULTS.coarseS, toleranceMs = 40 } = {}) {
  let lo = around.getTime() - windowS * 1000;
  let hi = around.getTime() + windowS * 1000;
  const distance = (ms) => {
    const when = new Date(ms);
    const a = propagate(mine, when);
    const b = propagate(other, when);
    return a && b ? gap(a, b) : Infinity;
  };
  let c = hi - PHI * (hi - lo);
  let e = lo + PHI * (hi - lo);
  let fc = distance(c);
  let fe = distance(e);
  while (hi - lo > toleranceMs) {
    if (fc < fe) {
      hi = e;
      e = c;
      fe = fc;
      c = hi - PHI * (hi - lo);
      fc = distance(c);
    } else {
      lo = c;
      c = e;
      fc = fe;
      e = lo + PHI * (hi - lo);
      fe = distance(e);
    }
  }
  return fc < fe ? { km: fc, at: new Date(c) } : { km: fe, at: new Date(e) };
}

export function screen(mine, catalogue, propagate, options = {}) {
  const { hours, coarseS, padKm, keepKm, alertKm } = { ...DEFAULTS, ...options };
  const from = options.from ?? new Date();
  const pool = reachable(mine, catalogue, padKm);

  const steps = Math.ceil((hours * 3600) / coarseS);
  const track = [];
  for (let s = 0; s <= steps; s += 1) {
    const when = new Date(from.getTime() + s * coarseS * 1000);
    track.push({ when, p: propagate(mine, when) });
  }

  const encounters = [];
  for (const other of pool) {
    for (const dip of passes(track, other, propagate, { keepKm })) {
      const best = refine(mine, other, dip.around, propagate, { windowS: coarseS });
      if (Number.isFinite(best.km)) {
        encounters.push({
          mine: mine.id,
          other: other.id,
          name: other.name ?? other.id,
          km: best.km,
          at: best.at.toISOString(),
          inHours: (best.at - from) / 3600000,
          alert: best.km <= alertKm,
        });
      }
    }
  }

  encounters.sort((a, b) => a.km - b.km);
  return { mine: mine.id, screened: pool.length, catalogue: catalogue.length, encounters, from: from.toISOString(), hours };
}

export function screenMany(fleet, catalogue, propagate, options = {}) {
  const { hours, coarseS, padKm, keepKm, alertKm } = { ...DEFAULTS, ...options };
  const from = options.from ?? new Date();
  const until = options.until ?? new Date(from.getTime() + hours * 3600 * 1000);
  const onStep = options.onStep;

  const pool = [];
  const index = new Map();
  const pairs = [];
  for (let f = 0; f < fleet.length; f += 1) {
    for (const other of reachable(fleet[f], catalogue, padKm)) {
      let at = index.get(other.id);
      if (at === undefined) {
        at = pool.length;
        index.set(other.id, at);
        pool.push(other);
      }
      pairs.push(f, at);
    }
  }
  if (!pairs.length) {
    return { encounters: [], screened: 0, pool: 0, pairs: 0 };
  }

  const count = pairs.length / 2;
  const twoBack = new Float64Array(count).fill(Infinity);
  const oneBack = new Float64Array(count).fill(Infinity);
  const whenBack = new Float64Array(count);

  const mineAt = new Float64Array(fleet.length * 3);
  const mineOk = new Uint8Array(fleet.length);
  const poolAt = new Float64Array(pool.length * 3);
  const poolOk = new Uint8Array(pool.length);

  const dips = [];
  const steps = Math.ceil((until - from) / (coarseS * 1000));
  for (let s = 0; s <= steps; s += 1) {
    const ms = from.getTime() + s * coarseS * 1000;
    const when = new Date(ms);

    for (let f = 0; f < fleet.length; f += 1) {
      const p = propagate(fleet[f], when);
      mineOk[f] = p ? 1 : 0;
      if (p) {
        mineAt[f * 3] = p.x;
        mineAt[f * 3 + 1] = p.y;
        mineAt[f * 3 + 2] = p.z;
      }
    }
    for (let o = 0; o < pool.length; o += 1) {
      const p = propagate(pool[o], when);
      poolOk[o] = p ? 1 : 0;
      if (p) {
        poolAt[o * 3] = p.x;
        poolAt[o * 3 + 1] = p.y;
        poolAt[o * 3 + 2] = p.z;
      }
    }

    for (let i = 0; i < count; i += 1) {
      const f = pairs[i * 2];
      const o = pairs[i * 2 + 1];
      let d = Infinity;
      if (mineOk[f] && poolOk[o]) {
        const dx = mineAt[f * 3] - poolAt[o * 3];
        const dy = mineAt[f * 3 + 1] - poolAt[o * 3 + 1];
        const dz = mineAt[f * 3 + 2] - poolAt[o * 3 + 2];
        d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      if (oneBack[i] < twoBack[i] && oneBack[i] < d) {
        const fitted = guess(twoBack[i], oneBack[i], d, coarseS);
        if (fitted.km < keepKm) {
          dips.push({ f, o, around: new Date(whenBack[i] + fitted.offsetS * 1000), sampled: oneBack[i] });
        }
      }
      twoBack[i] = oneBack[i];
      oneBack[i] = d;
      whenBack[i] = ms;
    }

    if (onStep && s % 24 === 0) {
      onStep({ done: s, total: steps, dips: dips.length });
    }
  }

  const encounters = [];
  for (const dip of dips) {
    const craft = fleet[dip.f];
    const other = pool[dip.o];
    const best = refine(craft, other, dip.around, propagate, { windowS: coarseS });
    if (Number.isFinite(best.km)) {
      encounters.push({
        mine: craft.id,
        mineName: craft.name ?? craft.id,
        other: other.id,
        name: other.name ?? other.id,
        group: other.group ?? null,
        km: best.km,
        at: best.at.toISOString(),
        inHours: (best.at - from) / 3600000,
        alert: best.km <= alertKm,
      });
    }
  }

  encounters.sort((a, b) => a.km - b.km);
  return { encounters, screened: pool.length, pool: pool.length, pairs: count, from: from.toISOString() };
}

export function histogram(encounters, { edges = [1, 2, 5, 10, 25, 50, 100, 200, 400] } = {}) {
  const bins = edges.map((high, index) => ({ from: index ? edges[index - 1] : 0, to: high, n: 0 }));
  for (const row of encounters) {
    const bin = bins.find((b) => row.km > b.from && row.km <= b.to);
    if (bin) {
      bin.n += 1;
    }
  }
  return bins;
}

export const CAVEAT =
  "Screened from public two-line elements, which carry no covariance and are accurate to roughly a kilometre. " +
  "These distances say what to look at, not what to do.";

export const altitudeOf = (satrec) => shell(satrec).periKm - EARTH_KM;
