
import { readFileSync } from "node:fs";
import { LOOKBACK, STORM, featuresAt } from "../src/orbital/kpfeatures.js";
import { describeKp, evaluate, forecast } from "../src/orbital/forecast.js";
import { combine, parseGeomagnetic, parseSolar, splice } from "../src/orbital/spaceweather.js";
import { flarePosition, severityFromFlares, severityFromKp, stormPosition } from "../src/orbital/live.js";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const model = JSON.parse(readFileSync("src/orbital/model/kp-net.json", "utf8"));
const history = JSON.parse(readFileSync("assets/data/kp-recent.json", "utf8")).days;

{
  ok("the model was trained on the full record", model.rows.train > 15000, `${model.rows.train} training days`);
  ok("and held years back to be tested on", model.rows.test > 3000 && model.split.validEnd < model.trained, `${model.rows.test} test days from ${model.split.validEnd}`);
  ok("the feature list matches the shared definition", model.features.length === featuresAt(history, LOOKBACK).length, `${model.features.length} features`);
  ok("normalisation covers every feature", model.normalise.centre.length === model.features.length && model.normalise.spread.length === model.features.length);
  ok("no normaliser has zero spread", model.normalise.spread.every((value) => value > 0));

  const [input] = model.architecture;
  ok("the input layer matches the features", input === model.features.length, `${input} inputs`);
  ok("the output layer is Kp and a storm logit", model.architecture[model.architecture.length - 1] === 2);
  model.weights.forEach((layer, index) => {
    const expected = model.architecture[index + 1];
    if (layer.w.length !== expected || layer.w[0].length !== model.architecture[index]) {
      ok(`layer ${index} is the right shape`, false, `${layer.w.length}x${layer.w[0].length}`);
    }
  });
  ok("every layer is the right shape", true, model.architecture.join("-"));
}

{
  const { test, baselines, skill } = model.metrics;
  ok("it beats persistence", test.rmse < baselines.persistence.rmse, `${test.rmse.toFixed(3)} against ${baselines.persistence.rmse.toFixed(3)}`);
  ok("it beats climatology", test.rmse < baselines.climatology.rmse, `${test.rmse.toFixed(3)} against ${baselines.climatology.rmse.toFixed(3)}`);
  ok("its storm probabilities beat the base rate", test.brier < baselines.climatology.brier, `Brier ${test.brier.toFixed(4)} against ${baselines.climatology.brier.toFixed(4)}`);
  ok("skill over persistence is real but not magical", skill.rmseOverPersistence > 0.05 && skill.rmseOverPersistence < 0.6, `${(skill.rmseOverPersistence * 100).toFixed(1)}%`);
  ok("the network is at least as good as ridge", test.rmse <= model.metrics.ridge.rmse, `${test.rmse.toFixed(4)} against ${model.metrics.ridge.rmse.toFixed(4)}`);
}

{
  const out = forecast(history, model);
  ok("a forecast comes out of the shipped history", out !== null);
  ok("Kp is on its scale", out.kp >= 0 && out.kp <= 9, out.kp.toFixed(2));
  ok("the probability is a probability", out.probability >= 0 && out.probability <= 1, out.probability.toFixed(3));
  ok("it forecasts the day after the data ends", out.date > out.basis, `${out.basis} to ${out.date}`);
  ok("the storm flag agrees with the threshold", out.storm === out.kp >= STORM);
  ok("persistence is carried for comparison", out.persistence === history[history.length - 1].kpMax);

  ok("inference is deterministic", JSON.stringify(forecast(history, model)) === JSON.stringify(out));

  ok("a short history forecasts nothing", forecast(history.slice(-10), model) === null);
  ok("no model forecasts nothing", forecast(history, null) === null);

  const quiet = history.map((day) => ({ ...day, kpMax: 0.7, kpMean: 0.5, ap: 2 }));
  const rough = history.map((day) => ({ ...day, kpMax: 6.5, kpMean: 5.5, ap: 80 }));
  const calm = forecast(quiet, model);
  const wild = forecast(rough, model);
  ok("a quiet record forecasts quiet", calm.kp < 3, calm.kp.toFixed(2));
  ok("a disturbed record forecasts disturbance", wild.kp > calm.kp + 1.5, `${calm.kp.toFixed(2)} against ${wild.kp.toFixed(2)}`);
  ok("and raises the storm probability with it", wild.probability > calm.probability * 3, `${calm.probability.toFixed(3)} to ${wild.probability.toFixed(3)}`);

  const absurd = evaluate(model, new Array(model.features.length).fill(500));
  ok("an absurd input stays on the Kp scale", absurd.kp >= 0 && absurd.kp <= 9, absurd.kp.toFixed(2));
  ok("and still yields a probability", absurd.probability >= 0 && absurd.probability <= 1, absurd.probability.toFixed(3));

  ok("Kp is described in the usual words", describeKp(1) === "quiet" && describeKp(5) === "minor storm" && describeKp(9) === "extreme storm");
}

const GEOMAGNETIC = `#  Date        A     K-indices        A     K-indices        A     K-indices
2026 10 06     8  2 3 2 2 2 2 2 2    27  3 3 5 6 5 2 1 1    11   3.00  3.00  2.33  2.67  2.67  1.67  2.00  5.33
2026 10 07     4  1 1 1 0 2 2 2 1     3  0 1 2 1 1 1 1 1     6   1.00  1.33  1.00  0.67  1.00  2.67  2.33  1.00
`;
const SOLAR = `#  Date     10.7cm Number  Hemis. Regions Field  Flux   C  M  X  S  1  2  3
2026 10 06  113     77      180      0    -999      *  11  2  0  4  1  0  0
2026 10 07  114     78      270      1    -999      *   8  0  1  6  0  0  0
`;

{
  const geo = parseGeomagnetic(GEOMAGNETIC);
  ok("the geomagnetic feed parses", geo.length === 2, `${geo.length} days`);
  ok("it reads the planetary indices, not the station ones", geo[0].kpMax === 5.33, String(geo[0].kpMax));
  ok("and the daily Ap beside them", geo[0].ap === 11, String(geo[0].ap));
  ok("dates come out padded", geo[0].date === "2026-10-06", geo[0].date);

  const solar = parseSolar(SOLAR);
  ok("the solar feed parses", solar.length === 2 && solar[1].f107 === 114, JSON.stringify(solar[1]));
  ok("flare counts come through", solar[1].flares.x === 1 && solar[0].flares.m === 2, JSON.stringify(solar[1].flares));

  const merged = combine(geo, solar);
  ok("the two feeds merge by date", merged[0].kpMax === 5.33 && merged[0].f107 === 113);

  const baked = [
    { date: "2026-10-05", kpMax: 2, kpMean: 1, ap: 4, f107: 100, sunspots: 50 },
    { date: "2026-10-06", kpMax: 9, kpMean: 9, ap: 400, f107: 100, sunspots: 50 },
  ];
  const run = splice(baked, merged);
  ok("the live value wins over the baked one", run.find((day) => day.date === "2026-10-06").kpMax === 5.33);
  ok("the baked tail survives in front of it", run[0].date === "2026-10-05" && run[0].kpMax === 2);
  ok("the run comes out in order", run.every((day, i) => i === 0 || day.date > run[i - 1].date));
  ok("a day with no flux is dropped", splice([], [{ date: "2026-10-08", kpMax: 3 }]).length === 0);
  ok("an empty splice is empty, not broken", splice([], []).length === 0);
}

{
  ok("storm level maps to a third of the scale", Math.abs(severityFromKp(5) - 0.2) < 0.01, severityFromKp(5).toFixed(3));
  ok("an extreme storm maps to all of it", severityFromKp(9) === 1);
  ok("a quiet day cannot reach zero severity", severityFromKp(0) > 0);
  ok("severity rises with Kp", severityFromKp(7) > severityFromKp(5));

  ok("an X-class day outranks an M-class one", severityFromFlares({ c: 0, m: 0, x: 1 }) > severityFromFlares({ c: 0, m: 9, x: 0 }));
  ok("and M outranks C", severityFromFlares({ c: 0, m: 1, x: 0 }) > severityFromFlares({ c: 20, m: 0, x: 0 }));
  ok("a quiet day is no flare at all", severityFromFlares({ c: 0, m: 0, x: 0 }) === 0 && severityFromFlares(null) === 0);

  const quiet = stormPosition(3, new Date("2026-11-04T00:00:00Z"));
  const severe = stormPosition(8, new Date("2026-11-04T00:00:00Z"));
  ok("a storm sits in the auroral oval", quiet.lat > 55 && quiet.lat <= 70, quiet.lat.toFixed(1));
  ok("and reaches further south as it grows", severe.lat < quiet.lat, `${quiet.lat.toFixed(1)} to ${severe.lat.toFixed(1)}`);
  ok("longitude is a longitude", quiet.lon >= -180 && quiet.lon <= 180, quiet.lon.toFixed(1));

  const midnightAt = (hour) => stormPosition(4, new Date(`2026-11-04T${String(hour).padStart(2, "0")}:00:00Z`)).lon;
  const drift = (((midnightAt(0) - midnightAt(6)) + 540) % 360) - 180;
  ok("the disturbance tracks magnetic midnight", Math.abs(drift - 90) < 0.01, `${drift.toFixed(1)} degrees over six hours`);

  const june = flarePosition(new Date("2026-06-21T12:00:00Z"));
  const december = flarePosition(new Date("2026-12-21T12:00:00Z"));
  ok("a flare lands on the subsolar point in June", june.lat > 20 && june.lat < 24, june.lat.toFixed(1));
  ok("and south of the equator in December", december.lat < -20 && december.lat > -24, december.lat.toFixed(1));
  ok("the sunlit side is opposite the midnight one", Math.abs(Math.abs(((june.lon - stormPosition(4, new Date("2026-06-21T12:00:00Z")).lon + 540) % 360) - 180) - 180) < 1);
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
