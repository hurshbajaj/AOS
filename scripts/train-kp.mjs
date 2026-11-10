
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const INPUT = "scratch/kp-full.json";
const OUTPUT = "src/orbital/model/kp-net.json";

const TRAIN_END = "2005-01-01";
const VALID_END = "2015-01-01";

const SEED = 7;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

import { FEATURES, LOOKBACK, STORM, featuresAt } from "../src/orbital/kpfeatures.js";

function buildSet(days) {
  const rows = [];
  for (let t = LOOKBACK; t < days.length - 1; t += 1) {
    const x = featuresAt(days, t);
    if (!x || x.some((value) => !Number.isFinite(value))) {
      continue;
    }
    const target = days[t + 1].kpMax;
    rows.push({ date: days[t].date, x, kp: target, storm: target >= STORM ? 1 : 0, today: days[t].kpMax });
  }
  return rows;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rmse = (pairs) => Math.sqrt(mean(pairs.map(([a, b]) => (a - b) ** 2)));
const mae = (pairs) => mean(pairs.map(([a, b]) => Math.abs(a - b)));
const brier = (pairs) => mean(pairs.map(([p, y]) => (p - y) ** 2));
const skill = (score, reference) => 1 - score / reference;

function ridge(rows, lambda) {
  const n = rows[0].x.length + 1;
  const a = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (const row of rows) {
    const x = [...row.x, 1];
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        a[i][j] += x[i] * x[j];
      }
      a[i][n] += x[i] * row.kp;
    }
  }
  for (let i = 0; i < n - 1; i += 1) {
    a[i][i] += lambda;
  }
  for (let i = 0; i < n; i += 1) {
    let pivot = i;
    for (let r = i + 1; r < n; r += 1) {
      if (Math.abs(a[r][i]) > Math.abs(a[pivot][i])) {
        pivot = r;
      }
    }
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const head = a[i][i] || 1e-12;
    for (let j = i; j <= n; j += 1) {
      a[i][j] /= head;
    }
    for (let r = 0; r < n; r += 1) {
      if (r === i) continue;
      const factor = a[r][i];
      if (!factor) continue;
      for (let j = i; j <= n; j += 1) {
        a[r][j] -= factor * a[i][j];
      }
    }
  }
  const w = Array.from({ length: n }, (_, i) => a[i][n]);
  return (x) => [...x, 1].reduce((sum, value, i) => sum + value * w[i], 0);
}

class Net {
  constructor(sizes, random) {
    this.sizes = sizes;
    this.layers = [];
    for (let i = 0; i < sizes.length - 1; i += 1) {
      const fan = sizes[i];
      const spread = Math.sqrt(6 / (fan + sizes[i + 1]));
      this.layers.push({
        w: Array.from({ length: sizes[i + 1] }, () => Array.from({ length: fan }, () => (random() * 2 - 1) * spread)),
        b: new Float64Array(sizes[i + 1]),
        mw: Array.from({ length: sizes[i + 1] }, () => new Float64Array(fan)),
        vw: Array.from({ length: sizes[i + 1] }, () => new Float64Array(fan)),
        mb: new Float64Array(sizes[i + 1]),
        vb: new Float64Array(sizes[i + 1]),
      });
    }
    this.step = 0;
  }

  forward(x) {
    const activations = [x];
    this.layers.forEach((layer, index) => {
      const last = index === this.layers.length - 1;
      const out = layer.w.map((row, i) => {
        let sum = layer.b[i];
        for (let j = 0; j < row.length; j += 1) {
          sum += row[j] * activations[index][j];
        }
        return last ? sum : Math.tanh(sum);
      });
      activations.push(out);
    });
    return activations;
  }

  train(batch, lr) {
    const grads = this.layers.map((layer) => ({
      w: layer.w.map((row) => new Float64Array(row.length)),
      b: new Float64Array(layer.b.length),
    }));
    let loss = 0;

    for (const row of batch) {
      const a = this.forward(row.x);
      const out = a[a.length - 1];
      const probability = 1 / (1 + Math.exp(-out[1]));
      loss += (out[0] - row.kp) ** 2;
      loss -= 2 * (row.storm * Math.log(probability + 1e-9) + (1 - row.storm) * Math.log(1 - probability + 1e-9));

      let delta = [2 * (out[0] - row.kp), 2 * (probability - row.storm)];
      for (let index = this.layers.length - 1; index >= 0; index -= 1) {
        const layer = this.layers[index];
        const input = a[index];
        for (let i = 0; i < layer.w.length; i += 1) {
          grads[index].b[i] += delta[i];
          for (let j = 0; j < input.length; j += 1) {
            grads[index].w[i][j] += delta[i] * input[j];
          }
        }
        if (index > 0) {
          const next = new Array(input.length).fill(0);
          for (let j = 0; j < input.length; j += 1) {
            let sum = 0;
            for (let i = 0; i < layer.w.length; i += 1) {
              sum += layer.w[i][j] * delta[i];
            }
            next[j] = sum * (1 - input[j] ** 2);
          }
          delta = next;
        }
      }
    }

    this.step += 1;
    const scale = 1 / batch.length;
    const b1 = 0.9;
    const b2 = 0.999;
    const correct1 = 1 - b1 ** this.step;
    const correct2 = 1 - b2 ** this.step;
    this.layers.forEach((layer, index) => {
      const g = grads[index];
      for (let i = 0; i < layer.w.length; i += 1) {
        for (let j = 0; j < layer.w[i].length; j += 1) {
          const grad = g.w[i][j] * scale;
          layer.mw[i][j] = b1 * layer.mw[i][j] + (1 - b1) * grad;
          layer.vw[i][j] = b2 * layer.vw[i][j] + (1 - b2) * grad * grad;
          layer.w[i][j] -= (lr * (layer.mw[i][j] / correct1)) / (Math.sqrt(layer.vw[i][j] / correct2) + 1e-8);
        }
        const grad = g.b[i] * scale;
        layer.mb[i] = b1 * layer.mb[i] + (1 - b1) * grad;
        layer.vb[i] = b2 * layer.vb[i] + (1 - b2) * grad * grad;
        layer.b[i] -= (lr * (layer.mb[i] / correct1)) / (Math.sqrt(layer.vb[i] / correct2) + 1e-8);
      }
    });
    return loss / batch.length;
  }

  predict(x) {
    const out = this.forward(x)[this.sizes.length - 1];
    return { kp: out[0], storm: 1 / (1 + Math.exp(-out[1])) };
  }

  export() {
    return this.layers.map((layer) => ({ w: layer.w.map((row) => [...row]), b: [...layer.b] }));
  }
}

async function main() {
  const raw = JSON.parse(await readFile(INPUT, "utf8"));
  const rows = buildSet(raw.days);
  const train = rows.filter((row) => row.date < TRAIN_END);
  const valid = rows.filter((row) => row.date >= TRAIN_END && row.date < VALID_END);
  const test = rows.filter((row) => row.date >= VALID_END);
  process.stdout.write(
    `${rows.length} usable days: ${train.length} train (to ${TRAIN_END}), ` +
      `${valid.length} validate, ${test.length} test (from ${VALID_END})\n`,
  );
  process.stdout.write(`storm rate: train ${(mean(train.map((r) => r.storm)) * 100).toFixed(1)}%, test ${(mean(test.map((r) => r.storm)) * 100).toFixed(1)}%\n\n`);

  const columns = FEATURES.map((_, i) => train.map((row) => row.x[i]));
  const centre = columns.map(mean);
  const spread = columns.map((values, i) => Math.sqrt(mean(values.map((v) => (v - centre[i]) ** 2))) || 1);
  const normalise = (x) => x.map((value, i) => (value - centre[i]) / spread[i]);
  for (const row of rows) {
    row.x = normalise(row.x);
  }

  const climate = mean(train.map((row) => row.kp));
  const stormRate = mean(train.map((row) => row.storm));
  const baselines = {
    climatology: {
      rmse: rmse(test.map((row) => [climate, row.kp])),
      mae: mae(test.map((row) => [climate, row.kp])),
      brier: brier(test.map((row) => [stormRate, row.storm])),
    },
    persistence: {
      rmse: rmse(test.map((row) => [row.today, row.kp])),
      mae: mae(test.map((row) => [row.today, row.kp])),
      brier: brier(test.map((row) => [row.today >= STORM ? 1 : 0, row.storm])),
    },
  };

  const linear = ridge(train, 1);
  const linearScore = {
    rmse: rmse(test.map((row) => [linear(row.x), row.kp])),
    mae: mae(test.map((row) => [linear(row.x), row.kp])),
  };

  const random = mulberry32(SEED);
  const net = new Net([FEATURES.length, 24, 12, 2], random);
  const order = train.map((_, i) => i);
  const BATCH = 256;
  let best = { loss: Infinity, weights: null, epoch: 0 };
  let patience = 0;

  const validate = () => {
    const pairs = valid.map((row) => {
      const out = net.predict(row.x);
      return [out.kp, row.kp, out.storm, row.storm];
    });
    return {
      rmse: rmse(pairs.map(([a, b]) => [a, b])),
      brier: brier(pairs.map(([, , p, y]) => [p, y])),
    };
  };

  for (let epoch = 1; epoch <= 400; epoch += 1) {
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const lr = 0.004 * 0.5 ** ((epoch - 1) / 120);
    for (let start = 0; start < order.length; start += BATCH) {
      net.train(order.slice(start, start + BATCH).map((i) => train[i]), lr);
    }
    const score = validate();
    const combined = score.rmse + 4 * score.brier;
    if (combined < best.loss - 1e-5) {
      best = { loss: combined, weights: net.export(), epoch };
      patience = 0;
    } else {
      patience += 1;
    }
    if (epoch % 20 === 0 || epoch === 1) {
      process.stdout.write(`epoch ${String(epoch).padStart(3)}  val rmse ${score.rmse.toFixed(4)}  brier ${score.brier.toFixed(4)}\n`);
    }
    if (patience >= 30) {
      process.stdout.write(`stopped at epoch ${epoch}; best was ${best.epoch}\n`);
      break;
    }
  }

  best.weights.forEach((layer, index) => {
    net.layers[index].w = layer.w.map((row) => [...row]);
    net.layers[index].b = Float64Array.from(layer.b);
  });

  const predictions = test.map((row) => {
    const out = net.predict(row.x);
    return { kp: out.kp, probability: out.storm, kpTrue: row.kp, stormTrue: row.storm };
  });
  const netScore = {
    rmse: rmse(predictions.map((p) => [p.kp, p.kpTrue])),
    mae: mae(predictions.map((p) => [p.kp, p.kpTrue])),
    brier: brier(predictions.map((p) => [p.probability, p.stormTrue])),
  };

  const alarm = (threshold) => {
    let hit = 0;
    let miss = 0;
    let falseAlarm = 0;
    for (const p of predictions) {
      const warned = p.probability >= threshold;
      if (p.stormTrue && warned) hit += 1;
      else if (p.stormTrue) miss += 1;
      else if (warned) falseAlarm += 1;
    }
    return {
      threshold,
      detection: hit / (hit + miss || 1),
      falseAlarms: falseAlarm / (hit + falseAlarm || 1),
      csi: hit / (hit + miss + falseAlarm || 1),
    };
  };
  const detection = [0.2, 0.3, 0.5].map(alarm);

  const report = {
    test: netScore,
    detection,
    baselines,
    ridge: linearScore,
    skill: {
      rmseOverPersistence: skill(netScore.rmse, baselines.persistence.rmse),
      rmseOverClimatology: skill(netScore.rmse, baselines.climatology.rmse),
      brierOverClimatology: skill(netScore.brier, baselines.climatology.brier),
      brierOverPersistence: skill(netScore.brier, baselines.persistence.brier),
    },
  };

  process.stdout.write("\n                 RMSE     MAE    Brier\n");
  const line = (name, score) =>
    process.stdout.write(
      `${name.padEnd(14)} ${score.rmse.toFixed(4)}  ${score.mae?.toFixed(4) ?? "     -"}  ${score.brier?.toFixed(4) ?? "     -"}\n`,
    );
  line("climatology", baselines.climatology);
  line("persistence", baselines.persistence);
  line("ridge", linearScore);
  line("network", netScore);
  for (const level of detection) {
    process.stdout.write(
      `warn above ${level.threshold.toFixed(2)}: catches ${(level.detection * 100).toFixed(0)}% of storms, ` +
        `${(level.falseAlarms * 100).toFixed(0)}% of warnings are false, CSI ${level.csi.toFixed(2)}\n`,
    );
  }
  process.stdout.write(
    `\nskill over persistence: ${(report.skill.rmseOverPersistence * 100).toFixed(1)}% of its error removed\n` +
      `skill over climatology: ${(report.skill.rmseOverClimatology * 100).toFixed(1)}%\n` +
      `storm Brier skill vs climatology: ${(report.skill.brierOverClimatology * 100).toFixed(1)}%\n`,
  );

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(
    OUTPUT,
    JSON.stringify(
      {
        trained: new Date().toISOString().slice(0, 10),
        source: raw.source,
        span: raw.span,
        rows: { train: train.length, valid: valid.length, test: test.length },
        split: { trainEnd: TRAIN_END, validEnd: VALID_END },
        features: FEATURES,
        lookback: LOOKBACK,
        storm: STORM,
        normalise: { centre, spread },
        architecture: net.sizes,
        epoch: best.epoch,
        weights: net.export(),
        metrics: report,
      },
      null,
      1,
    ),
  );
  process.stdout.write(`\nwrote ${OUTPUT}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
