
import { CAVEAT, DEFAULTS, guess, histogram, passes, reachable, refine, screen, screenMany, shell } from "../src/orbital/conjunctions.js";
import { byCraft, risk } from "../src/orbital/screening.js";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const near = (a, b, slack) => Math.abs(a - b) < slack;

const MU = 398600.4418;
const orbit = (id, radiusKm, phase = 0, tilt = 0, group = "test") => ({
  id, name: id, group, r: radiusKm, phase, tilt,
  periKm: radiusKm, apoKm: radiusKm,
});
const step = (o, when) => {
  const t = when.getTime() / 1000;
  const a = Math.sqrt(MU / o.r ** 3) * t + o.phase;
  return {
    x: o.r * Math.cos(a),
    y: o.r * Math.sin(a) * Math.cos(o.tilt),
    z: o.r * Math.sin(a) * Math.sin(o.tilt),
  };
};
const epoch = new Date(0);

{
  const mine = orbit("mine", 6928);
  const pool = [mine, orbit("same", 6928), orbit("just-above", 6970), orbit("far", 7400), orbit("geo", 42164)];
  const kept = reachable(mine, pool, 50);
  ok("itself is never screened against itself", !kept.includes(mine));
  ok("an orbit in the same shell is kept", kept.some((o) => o.id === "same"));
  ok("one just inside the pad is kept", kept.some((o) => o.id === "just-above"));
  ok("one outside it is dropped", !kept.some((o) => o.id === "far"));
  ok("and geostationary is not screened against low orbit", !kept.some((o) => o.id === "geo"));
  ok("so the pool is a fraction of the catalogue", kept.length === 2, String(kept.length));

  const ellipse = shell({ no: 0.0637, ecco: 0.06 });
  ok("perigee and apogee come off the mean elements", ellipse.periKm < ellipse.a && ellipse.apoKm > ellipse.a);
}

{
  const mine = orbit("mine", 6928, 0, 0);
  const other = orbit("other", 6928, 0.0002, 1.4);
  const began = new Date(epoch.getTime() + 17_000);
  const track = [];
  for (let s = 0; s <= 120; s += 1) {
    const when = new Date(began.getTime() + s * 60000);
    track.push({ when, p: step(mine, when) });
  }
  const sampled = track.map((row) => Math.hypot(...["x", "y", "z"].map((k) => step(other, row.when)[k] - row.p[k])));
  const lowest = Math.min(...sampled);
  const dips = passes(track, other, step);
  ok("the samples never get near the real approach", lowest > 50, `${lowest.toFixed(0)} km at best`);
  ok("but the dips are found anyway", dips.length > 0, `${dips.length} found`);

  const best = refine(mine, other, dips[0].around, step);
  ok("and refining one gives the real minimum", best.km < 2, `${best.km.toFixed(3)} km`);
  ok("of the order the orbits were built with", best.km > 0.5 && best.km < 0.0002 * 6928 * 1.5, best.km.toFixed(4));
  ok("so the sampled value is wrong by orders of magnitude", dips[0].sampled / best.km > 30, `${dips[0].sampled.toFixed(0)} km sampled, ${best.km.toFixed(3)} km real`);
  ok("and the time comes back with it", best.at instanceof Date);
}

{
  const fit = (miss, speed, stepS, offset = 0) => {
    const at = (t) => Math.hypot(miss, speed * (t - offset));
    return guess(at(-stepS), at(0), at(stepS), stepS);
  };

  const head = fit(3, 15, 90);
  ok("a fast head-on pass is recovered", near(head.km, 3, 0.01), head.km.toFixed(3));
  ok("even though the samples are 1350 km out", Math.hypot(3, 15 * 90) > 1300);

  const slow = fit(40, 0.4, 90);
  ok("a slow one is too", near(slow.km, 40, 0.01), slow.km.toFixed(3));

  const offset = fit(2, 12, 90, 30);
  ok("and one whose minimum is between samples", near(offset.km, 2, 0.05), offset.km.toFixed(3));
  ok("with where it is, so the search starts in the right place", near(offset.offsetS, 30, 1), offset.offsetS.toFixed(1));

  const flat = guess(10, 10, 10, 90);
  ok("a shape it cannot fit falls back to the sample", flat.km === 10 && flat.offsetS === 0);
  const wild = guess(1000, 1, 1, 90);
  ok("and an extrapolated minimum is not trusted", Math.abs(wild.offsetS) <= 90);
}

{
  const fleet = [orbit("a", 6928, 0, 0), orbit("b", 6928, 1.1, 0.02)];
  const catalogue = [
    ...fleet,
    orbit("grazer", 6928, 0.0004, 0.9),
    orbit("neighbour", 6968, 2, 0.3),
    orbit("elsewhere", 7600, 1, 0.1),
  ];
  const opts = { hours: 4, from: epoch, coarseS: 60, keepKm: 400 };

  const many = screenMany(fleet, catalogue, step, opts);
  const one = screen(fleet[0], catalogue, step, opts);
  const mineOnly = many.encounters.filter((row) => row.mine === "a");

  ok("every encounter names a craft from the fleet", many.encounters.every((r) => r.mine === "a" || r.mine === "b"));
  ok("and there are some", many.encounters.length > 0, String(many.encounters.length));
  ok("the far orbit is still never propagated", !many.encounters.some((r) => r.other === "elsewhere"));
  ok("and it agrees with the one-at-a-time version", mineOnly.length === one.encounters.length, `${mineOnly.length} vs ${one.encounters.length}`);
  ok("to the metre", near(mineOnly[0].km, one.encounters[0].km, 0.001), `${mineOnly[0]?.km.toFixed(4)} vs ${one.encounters[0]?.km.toFixed(4)}`);
  ok("the shared pool is counted once, not once per craft", many.pool === 4, String(many.pool));
  ok("while the pairs watched are per craft", many.pairs === 6, String(many.pairs));
  ok("results carry which craft they belong to", many.encounters.every((row) => row.mineName));
  ok("and come back closest first", many.encounters.every((row, i, all) => !i || all[i - 1].km <= row.km));

  const quiet = screenMany([orbit("lonely", 8000)], [orbit("far", 9200)], step, opts);
  ok("nothing in range screens to nothing", quiet.encounters.length === 0 && quiet.pairs === 0);
}

{
  const mine = orbit("mine", 6928, 0, 0);
  const catalogue = [
    mine,
    orbit("grazer", 6928, 0.0003, 0.6),
    orbit("neighbour", 6968, 2, 0.3),
    orbit("elsewhere", 7600, 1, 0.1),
  ];
  const r = screen(mine, catalogue, step, { hours: 3, from: epoch, alertKm: 10 });

  ok("the catalogue size is reported, not just the pool", r.catalogue === 4 && r.screened === 2, `${r.screened} of ${r.catalogue}`);
  ok("the far orbit was never propagated", !r.encounters.some((e) => e.other === "elsewhere"));
  ok("encounters come back closest first", r.encounters.every((row, i, all) => !i || all[i - 1].km <= row.km));
  ok("the closest is the grazer", r.encounters[0].other === "grazer", r.encounters[0]?.other);
  ok("under two kilometres", r.encounters[0].km < 2, r.encounters[0].km.toFixed(3));
  ok("flagged, because it is under the alert distance", r.encounters[0].alert === true);
  ok("and timed in hours from the start", r.encounters[0].inHours >= 0 && r.encounters[0].inHours <= 3);
  const loose = r.encounters.filter((row) => row.other === "neighbour");
  ok("a pass well clear of the threshold is not flagged", loose.every((row) => !row.alert), loose.map((row) => row.km.toFixed(1)).join(", "));

  const quiet = screen(orbit("lonely", 8000), [orbit("other", 9000)], step, { hours: 2, from: epoch });
  ok("a clear sky screens to nothing, without error", quiet.encounters.length === 0 && quiet.screened === 0);

  const flaky = (o, when) => (o.id === "broken" ? null : step(o, when));
  const survived = screen(mine, [orbit("broken", 6928), orbit("grazer", 6928, 0.0003, 0.6)], flaky, { hours: 2, from: epoch });
  ok("an object that will not propagate is skipped, not fatal", survived.encounters.every((row) => row.other !== "broken"));
  ok("while the rest still come back", survived.encounters.length > 0);
}

{
  const rows = [
    { mine: "a", km: 0.8 }, { mine: "a", km: 14 }, { mine: "b", km: 3.2 },
    { mine: "b", km: 2.0 }, { mine: "c", km: 180 },
  ];
  const worst = byCraft({ encounters: rows });
  ok("each craft keeps only its worst encounter", worst.size === 3 && worst.get("b").km === 2.0);

  const bins = histogram(rows);
  ok("the histogram bins by distance", bins.find((b) => b.to === 1).n === 1 && bins.find((b) => b.to === 200).n === 1);
  ok("and every encounter lands in exactly one bin", bins.reduce((sum, b) => sum + b.n, 0) === rows.length);

  ok("risk bands read as operators talk", risk(0.4) === "critical" && risk(3) === "high" && risk(8) === "watch" && risk(40) === "clear");

  ok("the caveat says it carries no covariance", /covariance/.test(CAVEAT));
  ok("and that it says what to look at, not what to do", /what to look at/.test(CAVEAT));
  ok("the defaults are the ones the panel shows", DEFAULTS.hours === 24 && DEFAULTS.alertKm === 10);
}

console.log(failures ? `\n${failures} failed` : "\nall green");
process.exit(failures ? 1 : 0);
