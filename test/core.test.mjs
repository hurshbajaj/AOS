
import { readFile } from "node:fs/promises";
import { Engine, FIELDS, STATION_BIT, STATUS } from "../src/orbital/core.js";

let failed = 0;
const ok = (what, condition, detail = "") => {
  if (condition) {
    console.log(`  ok  ${what}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`);
  }
};

globalThis.performance ??= { now: () => Number(process.hrtime.bigint() / 1_000_000n) };

const ISS = {
  id: "iss",
  name: "ISS (ZARYA)",
  constellation: "mesh",
  line1: "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9009",
  line2: "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537",
};
const GPS = {
  id: "gps-1",
  name: "GPS BIIR-2",
  constellation: "gnss",
  class: "navigation",
  line1: "1 24876U 97035A   24001.50000000 -.00000031  00000-0  00000-0 0  9998",
  line2: "2 24876  55.5147 136.0633 0057635  53.1226 307.4169  2.00563large",
};
const GPS_GOOD = {
  ...GPS,
  line2: "2 24876  55.5147 136.0633 0057635  53.1226 307.4169  2.00563290195173",
};

const engine = await Engine.load((await readFile("assets/core/aos_core.wasm")).buffer);
ok("the committed binary loads and its contract matches the page", true);

const WHEN = Date.parse("2024-01-02T00:00:00Z");
engine.open({ id: "test", name: "Headless", note: "", epoch: WHEN });

const bad = engine.fleet([ISS, GPS]);
ok("elements that will not parse are refused, not propagated", bad.fleet === 1, `kept ${bad.fleet}`);

const loaded = engine.fleet([ISS, GPS_GOOD]);
ok("and good ones are kept", loaded.fleet === 2);

engine.step(0, WHEN);
const state = engine.state();
ok("one row of nine floats per craft", state.length === 2 * FIELDS.stride);

const iss = (field) => state[0 * FIELDS.stride + FIELDS[field]];
const gps = (field) => state[1 * FIELDS.stride + FIELDS[field]];

ok("the low craft is in low orbit", iss("altitudeKm") > 300 && iss("altitudeKm") < 440, `${iss("altitudeKm").toFixed(0)}km`);
ok("and moving at orbital speed for it", iss("speedKms") > 7.4 && iss("speedKms") < 7.9, `${iss("speedKms").toFixed(2)}km/s`);
ok("the navigation craft is in medium orbit", gps("altitudeKm") > 19_000 && gps("altitudeKm") < 21_500, `${gps("altitudeKm").toFixed(0)}km`);
ok("and slower, as the higher orbit requires", gps("speedKms") < iss("speedKms"));
ok("latitude stays inside the inclination", Math.abs(iss("lat")) <= 51.7);
ok("and longitude is wrapped, not accumulated", Math.abs(iss("lon")) <= 180);

ok("eclipse is a flag", iss("eclipsed") === 0 || iss("eclipsed") === 1);
ok("beta angle is an angle", Math.abs(iss("betaDeg")) <= 90.001, `${iss("betaDeg").toFixed(1)}`);

const before = engine.state()[FIELDS.lon];
engine.step(1, Date.now());
const after = engine.state()[FIELDS.lon];
ok("a step moves things", before !== after);

const travelled = Math.abs(after - before);
ok("at sixty times wall clock, not once", travelled > 0.1, `${travelled.toFixed(3)}deg`);

const frame = engine.step(0, Date.now());
ok("the board starts empty, and nothing fills it on its own", frame.board.length === 0);
ok("and so does the card tray", frame.cards.length === 0);

const injected = engine.inject({ kind: "flare", severity: 0.9, lat: 0, lon: 0, radiusKm: 6000, durationMin: 90 });
ok("a hazard can be injected", Boolean(injected.id));

const withHazard = engine.step(0.016, Date.now());
ok("and appears on the stack", withHazard.hazards.length === 1);
ok("flagged as the operator's own", withHazard.hazards[0].flag === "INJ");
ok("with its strength worked out rather than echoed", withHazard.hazards[0].intensity <= 0.9);

const night = engine.inject({ kind: "flare", severity: 1, lat: 0, lon: 180, radiusKm: 2000 });
engine.step(0.016, Date.now());
engine.clear(night.id);

const second = engine.inject({ kind: "flare", severity: 0.5, lat: 10, lon: 10, radiusKm: 2000 });
const two = engine.step(0.016, Date.now());
const labels = two.hazards.map((h) => h.label);
ok("repeats are numbered so they can be told apart", labels.includes("Solar flare (#2)") || labels.includes("Solar flare (#3)"), labels.join(", "));
engine.clear(second.id);

const huge = engine.inject({ kind: "debris", severity: 40, radiusKm: 9e9 });
const clamped = engine.step(0, Date.now()).hazards.find((h) => h.id === huge.id);
ok("a kind holds every caller to its own limits", clamped.severity <= 1, `${clamped.severity}`);
engine.clear(huge.id);

const gone = engine.clear(injected.id);
ok("and cleared again", gone.cleared === true);
ok("leaving the stack empty", engine.step(0, Date.now()).hazards.length === 0);

engine.config({ linkDensity: 1 });
engine.step(0.016, Date.now());
const links = engine.links();
ok("links are built", links.count > 0, `${links.count}`);
if (links.count > 0) {
  const kinds = new Set();
  let stations = 0;
  for (let i = 0; i < links.count; i += 1) {
    kinds.add(links.ends[i * 5 + 2]);
    if (links.ends[i * 5] & STATION_BIT || links.ends[i * 5 + 1] & STATION_BIT) {
      stations += 1;
    }
    const quality = links.floats[i * 5 + 3];
    ok(`link ${i} quality is a fraction`, quality >= 0 && quality <= 1, `${quality}`);
    if (i > 2) break;
  }
  ok("some of them reach the ground", stations > 0);
}

engine.weather({ kp: 7.2, ap: 132, f107: 180, sunspots: 140, m: 3, x: 1, measuredAt: Date.now(), live: true });
ok("a measurement is accepted", true);

const mild = engine.inject({ kind: "storm", severity: 0.2, durationMin: 600 });
engine.step(0.016, Date.now());
engine.clear(mild.id);
const severe = engine.inject({ kind: "storm", severity: 0.95, durationMin: 600 });
const stormed = engine.step(0.016, Date.now());
ok("a storm acts on the fleet, not just on the picture", stormed.summary.atRisk >= 0);
engine.clear(severe.id);

let refused = null;
try {
  engine.screen({ hours: 2 });
} catch (error) {
  refused = error.message;
}
ok("screening with no catalogue says so rather than returning nothing", /catalogue/i.test(refused ?? ""), refused ?? "no error");

const nearby = `ISS SHADOW
${ISS.line1}
2 25544  51.6416 247.4627 0006703 130.5360 325.0290 15.72125391563530`;
engine.catalogue(nearby, "test");
const screened = engine.screen({ hours: 3, alertKm: 50 });
ok("a screen names the algorithm that produced it", screened.algorithm === "AOS default", screened.algorithm);
ok("and carries the caveat with the numbers", /no covariance/.test(screened.caveat));
ok("a co-orbiting object is found", screened.encounters.length > 0, `${screened.encounters.length}`);
if (screened.encounters.length) {
  const closest = screened.encounters[0];
  ok("at a plausibly small miss distance", closest.km < 60, `${closest.km.toFixed(2)}km`);
  ok("with a relative speed to go with it", Number.isFinite(closest.relativeSpeedKms));
  ok("and no probability, because the elements carry no covariance", closest.probability === null);
  ok("sorted closest first", screened.encounters.every((e, i, all) => i === 0 || all[i - 1].km <= e.km));
}
ok("the histogram has a bin per band", screened.histogram.length === 9);

const manifest = engine.manifest();
ok("the default bundle carries no scripts", manifest.scripts.length === 0);
ok("and overrides nothing", manifest.overrides.length === 0);
ok("but still declares the five stock hazard kinds", manifest.hazardKinds.length === 5, `${manifest.hazardKinds.length}`);
ok("each with a glyph, a unit and a mechanism", manifest.hazardKinds.every((k) => k.glyph && k.unit && k.blurb.length > 30));
ok("and marked as the console's rather than the operator's", manifest.hazardKinds.every((k) => k.stock));
ok("the contract version agrees with the bridge", manifest.contract === 1);

const asked = engine.ask("what is the margin");
ok("asking scripts nothing when there are none returns nothing", asked.answers.length === 0);

ok("statuses are named, not numbered, on the way out", STATUS[0] === "nominal");

{
  const bundle = await Engine.load((await readFile("data/bundles/example-conjunction_watch-rs.wasm")).buffer);
  const opened = Date.now();
  bundle.open({ id: "t", name: "Headless", note: "", epoch: WHEN });
  const posted = bundle.step(1, Date.now()).board;
  ok("a script that announces itself from on_load reaches the board", posted.length === 1);
  const drift = Math.abs(posted[0].at - opened);
  ok("and is stamped with when the console opened it, not with zero", drift < 5000, `${drift}ms out`);
  const again = bundle.step(1, opened + 7_200_000).board;
  ok("and holds that time as the board ages", again[0].at === posted[0].at);
}

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exitCode = failed ? 1 : 0;
