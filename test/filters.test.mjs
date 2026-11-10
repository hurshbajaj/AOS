
import { OneEuro, approach, clamp, median, normalise, smoothstep } from "../src/orbital/filters.js";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (random) => {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
};
const rms = (values) => Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);

const DT = 1 / 30;
const JITTER = 0.0035;

{
  const random = mulberry32(1);
  const filter = new OneEuro();
  const errors = [];
  for (let i = 0; i < 200; i += 1) {
    const out = filter.filter(0.5 + gaussian(random) * JITTER, DT);
    if (i > 30) errors.push(out - 0.5);
  }
  const residual = rms(errors);
  ok("quietens a static signal", residual < JITTER / 2.4, `${(JITTER / residual).toFixed(1)}x reduction`);

  const ramp = new OneEuro();
  let value = 0;
  for (let i = 0; i < 20; i += 1) {
    value = ramp.filter(i * 0.05, DT);
  }
  const lag = 19 * 0.05 - value;
  ok("keeps up with a ramp", lag < 0.05, `${(lag / 0.05).toFixed(2)} frames behind`);

  const heavy = new OneEuro({ minCutoff: 0.4, beta: 0.2 });
  let slow = 0;
  for (let i = 0; i < 20; i += 1) {
    slow = heavy.filter(i * 0.05, DT);
  }
  ok("the knobs trade lag for smoothing", 19 * 0.05 - slow > lag * 2, `${((19 * 0.05 - slow) / 0.05).toFixed(2)} frames behind`);

  const first = new OneEuro();
  ok("the first sample passes through", first.filter(0.7, DT) === 0.7);
  ok("a zero dt does not divide by zero", Number.isFinite(first.filter(0.8, 0)));
  ok("a non-finite sample is ignored", first.filter(Number.NaN, DT) === 0.8, String(first.value));

  first.reset();
  ok("reset forgets", first.value === null);
}

{
  ok("median of odd", median([3, 1, 2]) === 2);
  ok("median of even", median([4, 1, 3, 2]) === 2.5);
  ok("median ignores an outlier", median([1, 1.05, 0.98, 1.02, 40]) === 1.02, String(median([1, 1.05, 0.98, 1.02, 40])));
  ok("median of nothing", median([]) === 0);

  ok("clamp holds the floor", clamp(-3, 0, 1) === 0);
  ok("clamp holds the ceiling", clamp(9, 0, 1) === 1);

  ok("smoothstep is flat below", smoothstep(0.1, 0.5, 1) === 0);
  ok("smoothstep is flat above", smoothstep(2, 0.5, 1) === 1);
  ok("smoothstep is a half at the middle", Math.abs(smoothstep(0.75, 0.5, 1) - 0.5) < 1e-12);
  ok("smoothstep survives a zero-width ramp", smoothstep(1, 1, 1) === 1 && smoothstep(0, 1, 1) === 0);

  const coarse = (() => {
    let v = 0;
    for (let i = 0; i < 30; i += 1) v = approach(v, 1, 1 / 30, 0.2);
    return v;
  })();
  const fine = (() => {
    let v = 0;
    for (let i = 0; i < 240; i += 1) v = approach(v, 1, 1 / 240, 0.2);
    return v;
  })();
  ok("approach is framerate-independent", Math.abs(coarse - fine) < 0.002, `${coarse.toFixed(4)} and ${fine.toFixed(4)}`);
  ok("approach reaches about 63% in one tau", Math.abs(approach(0, 1, 0.2, 0.2) - 0.6321) < 1e-3, approach(0, 1, 0.2, 0.2).toFixed(4));

  const unit = normalise(3, 4);
  ok("normalise gives a unit vector", Math.abs(Math.hypot(unit.x, unit.y) - 1) < 1e-12 && Math.abs(unit.x - 0.6) < 1e-12);
  ok("normalise refuses a zero vector", normalise(0, 0) === null);
  ok("normalise refuses a vector below the floor", normalise(1e-9, 1e-9) === null);
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
