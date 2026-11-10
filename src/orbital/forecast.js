
import { LOOKBACK, STORM, featuresAt } from "./kpfeatures.js";

export { STORM };

const MODEL_URL = "src/orbital/model/kp-net.json";

export function evaluate(model, raw) {
  const { centre, spread } = model.normalise;
  let signal = raw.map((value, i) => (value - centre[i]) / spread[i]);

  model.weights.forEach((layer, index) => {
    const last = index === model.weights.length - 1;
    signal = layer.w.map((row, i) => {
      let sum = layer.b[i];
      for (let j = 0; j < row.length; j += 1) {
        sum += row[j] * signal[j];
      }
      return last ? sum : Math.tanh(sum);
    });
  });

  return {
    kp: Math.min(Math.max(signal[0], 0), 9),
    probability: 1 / (1 + Math.exp(-signal[1])),
  };
}

export function forecast(days, model) {
  if (!model || days.length <= LOOKBACK) {
    return null;
  }
  const t = days.length - 1;
  const raw = featuresAt(days, t);
  if (!raw || raw.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const out = evaluate(model, raw);
  const from = new Date(`${days[t].date}T00:00:00Z`);
  return {
    ...out,
    storm: out.kp >= STORM,
    date: new Date(from.getTime() + 86400000).toISOString().slice(0, 10),
    basis: days[t].date,
    persistence: days[t].kpMax,
  };
}

export function describeKp(kp) {
  if (kp >= 8) return "extreme storm";
  if (kp >= 7) return "severe storm";
  if (kp >= 6) return "strong storm";
  if (kp >= 5) return "minor storm";
  if (kp >= 4) return "unsettled";
  return "quiet";
}

let cached = null;

export async function loadModel(url = MODEL_URL) {
  if (cached) {
    return cached;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`model fetch failed: ${response.status}`);
  }
  cached = await response.json();
  return cached;
}
