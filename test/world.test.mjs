import { HAZARD_LIMITS, World } from "../src/orbital/world.js";

let fails = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`  ok   ${name}${detail && "  " + detail}`); }
  else { console.log(`  FAIL ${name}  ${detail}`); fails++; }
};

const w = new World();
check("fleet built", w.satellites.length === 6*4 + 8*9 + 6, `${w.satellites.length} craft`);
check("ground stations", w.stations.length === 8);
check("links present", w.links.length > 40, `${w.links.length} links`);

const kinds = new Set(w.links.map(l => l.kind));
check("isl links", kinds.has("isl"));
check("nav links", kinds.has("nav"));
check("feeder links", kinds.has("feeder"));

const base = w.summary();
check("clean baseline", base.degraded === 0 && base.atRisk === 0, `q=${base.capacity.toFixed(2)} nav=${base.navCoverage.toFixed(2)}`);

const before = w.satellites[0].u;
for (let i = 0; i < 60; i++) w.tick(1/60 * 60);
const swept = Math.abs(w.satellites[0].u - before);
check("orbits advance", swept > 0.1, `${swept.toFixed(1)}deg in 1s of frames`);
check("rate is sane (<1 orbit/sec)", swept < 360, `${swept.toFixed(1)}deg`);

const flare = w.addHazard({ kind: "flare", lat: 10, lon: 80, severity: 0.9, radius: 1.2 });
w.tick(0);
const hit = w.summary();
check("flare degrades links", hit.degraded > 0, `${hit.degraded} degraded`);
check("quality drops", hit.capacity < base.capacity, `${base.capacity.toFixed(2)} -> ${hit.capacity.toFixed(2)}`);

const outage = w.addHazard({ kind: "outage", lat: 13.03, lon: 77.51, severity: 0.9, radius: 0.4 });
w.tick(0);
check("outage downs a gateway", w.summary().offline > 0, `${w.summary().offline} offline`);

const debris = w.addHazard({ kind: "debris", lat: 0, lon: 0, severity: 0.8, radius: 1.5 });
w.tick(0);
check("debris puts craft at risk", w.summary().atRisk > 0, `${w.summary().atRisk} craft`);

[flare, outage, debris].forEach(h => w.removeHazard(h.id));
w.tick(0);
const back = w.summary();
check("clears cleanly", back.degraded === 0 && back.offline === 0 && back.atRisk === 0);

w.setFilter({ links: new Set(["nav"]) });
w.tick(0);
check("link filter applies", w.links.every(l => l.kind === "nav"), `${w.links.length} nav-only`);
w.setFilter({ links: new Set(["isl","feeder","nav"]), constellations: new Set(["gnss"]) });
w.tick(0);
check("fleet filter applies", w.links.every(l => l.a.constellation === "gnss" || l.b.constellation === "gnss"));

w.setFilter({ constellations: new Set(["gnss","mesh","geo"]) });
w.tick(0);
const through = w.links.filter(l => {
  const a = l.a.position, b = l.b.position;
  const ab = {x:b.x-a.x, y:b.y-a.y, z:b.z-a.z};
  const t = Math.max(0, Math.min(1, -(a.x*ab.x+a.y*ab.y+a.z*ab.z)/(ab.x**2+ab.y**2+ab.z**2)));
  const c = {x:a.x+ab.x*t, y:a.y+ab.y*t, z:a.z+ab.z*t};
  return Math.hypot(c.x,c.y,c.z) < 0.995;
});
check("no links clip through Earth", through.length === 0, `${through.length} offenders`);

{
  const world = new World();
  const wild = world.addHazard({ kind: "storm", radius: 45, severity: 9, lat: 500, lon: -900, durationMin: -4 });
  const within = (value, [low, high]) => value >= low && value <= high;
  check(
    "absurd hazard parameters are clamped",
    within(wild.radius, HAZARD_LIMITS.radius) &&
      within(wild.severity, HAZARD_LIMITS.severity) &&
      within(wild.lat, HAZARD_LIMITS.lat) &&
      within(wild.lon, HAZARD_LIMITS.lon) &&
      within(wild.durationMin, HAZARD_LIMITS.durationMin),
    `radius ${wild.radius}, severity ${wild.severity}`,
  );
  check("updates are clamped too", world.updateHazard(wild.id, { radius: 99 }).radius === HAZARD_LIMITS.radius[1]);
  const plain = world.addHazard({ kind: "flare" });
  check("defaults are left alone", plain.radius === 0.9 && plain.severity === 0.6, `${plain.radius}, ${plain.severity}`);
  check("a non-numeric value is ignored, not coerced", world.addHazard({ kind: "jam", severity: "loud" }).severity === 0.55);
}

{
  const { capture, restore } = await import("../src/orbital/instances.js");

  const scene = new World();
  scene.addHazard({ kind: "flare", lat: 34, lon: -135, severity: 0.6, origin: "injected" });
  scene.addHazard({ kind: "flare", lat: -12, lon: 80, severity: 0.3, origin: "injected" });
  scene.addHazard({ kind: "jam", lat: 16, lon: 44, origin: "observed", label: "Uplink interference" });
  scene.addHazard({ kind: "storm", lat: 60, lon: 10, origin: "forecast", confidence: 0.7 });
  scene.setFilter({ density: 0.42, orbits: false, links: new Set(["isl"]) });

  const state = capture(scene);
  check("only the operator's own hazards are captured", state.hazards.length === 2, `${state.hazards.length} of ${scene.hazards.length}`);
  check("the live ones are left out", !state.hazards.some((h) => h.kind === "jam" || h.kind === "storm"));
  check("labels travel with them", state.hazards[0].label === "Solar flare");
  check("so do the layer settings", state.filters.density === 0.42 && state.filters.orbits === false);
  check("sets are captured as arrays, so this can be JSON", Array.isArray(state.filters.links) && Array.isArray(state.filters.constellations));
  check("and it survives a round trip through JSON", JSON.parse(JSON.stringify(state)).hazards.length === 2);

  const reopened = new World();
  reopened.addHazard({ kind: "jam", lat: 0, lon: 0, origin: "observed", label: "Live one" });
  restore(reopened, state);
  const injected = reopened.hazards.filter((h) => h.origin === "injected");
  check("both hazards come back", injected.length === 2, String(injected.length));
  check("in the right places", Math.abs(injected[0].lat - 34) < 0.001 && Math.abs(injected[0].lon + 135) < 0.001);
  check("with their severities", Math.abs(injected[0].severity - 0.6) < 0.001);
  check("and their names", injected[0].label === "Solar flare" && injected[1].label === "Solar flare (#2)");
  check("the filters come back too", reopened.filters.density === 0.42 && reopened.filters.orbits === false);
  check("links came back as a Set, not an array", reopened.filters.links instanceof Set && reopened.filters.links.has("isl"));
  check("a hazard that was already live is untouched", reopened.hazards.some((h) => h.label === "Live one"));

  restore(reopened, { hazards: [{ kind: "jam", lat: 5, lon: 5, severity: 0.2 }] });
  const after = reopened.hazards.filter((h) => h.origin === "injected");
  check("opening another replaces, not appends", after.length === 1 && after[0].kind === "jam", String(after.length));
  check("and still leaves the live hazard alone", reopened.hazards.some((h) => h.label === "Live one"));

  restore(reopened, { hazards: [{ kind: "flare", lat: 400, lon: -900, severity: 40, radius: 99 }, { kind: "wormhole", lat: 0, lon: 0 }, { kind: "jam", lat: 1, lon: 1 }] });
  const bounded = reopened.hazards.filter((h) => h.origin === "injected");
  check("a bad kind is skipped, not fatal", bounded.length === 2, String(bounded.length));
  check("and the rest are clamped on the way in", bounded[0].lat === 90 && bounded[0].severity === 1 && bounded[0].radius <= 2);

  restore(reopened, { hazards: [] });
  check("an empty scenario clears the operator's hazards", reopened.hazards.filter((h) => h.origin === "injected").length === 0);
  restore(reopened, undefined);
  check("and a missing one does not throw", true);
}

{
  const { conversational } = await import("../src/orbital/instances.js");

  const stale = [
    { who: "aos", text: "Console live. Ask me anything about the network." },
    { who: "aos", text: "Catalogue loaded: 126 tracked objects, propagated with SGP4." },
    { who: "aos", text: "Conditions: Kp 1.7 (quiet)." },
    { who: "you", text: "hi" },
    { who: "aos", text: "thinking…" },
    { who: "aos", text: "Hello. What would you like to look at today?" },
  ];
  const kept = conversational(stale);
  check("the exchange survives", kept.length === 2, `${kept.length} kept`);
  check("starting with what the operator said", kept[0].who === "you" && kept[0].text === "hi");
  check("and ending with the answer", kept[1].text.startsWith("Hello."));
  check("the opening line is dropped", !kept.some((e) => e.text.includes("Console live")));
  check("so are the figures read on the day", !kept.some((e) => e.text.includes("126 tracked")));
  check("and the working line", !kept.some((e) => e.text === "thinking…"));

  const answered = conversational([
    { who: "you", text: "worst affected" },
    { who: "aos", text: "Three craft are degraded." },
    { who: "aos", text: "I could not reach the model: timeout" },
  ]);
  check("an answer after the operator speaks is kept", answered.length === 3);

  check("nothing in, nothing out", conversational([]).length === 0);
  check("and a missing one does not throw", conversational(undefined).length === 0);
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall green");process.exit(fails ? 1 : 0);
