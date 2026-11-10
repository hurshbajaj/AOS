
import { existsSync, readFileSync } from "node:fs";
import { parseTle, propagateAt, sample } from "../src/orbital/catalogue.js";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const TLE = `GPS BIIR-2  (PRN 13)
1 24876U 97035A   26307.51607742 -.00000040  00000+0  00000+0 0  9993
2 24876  55.9318 118.2214 0066478  53.4878 307.1649  2.00564063214184
GPS BIIR-4  (PRN 20)
1 26360U 00025A   26307.14094907 -.00000073  00000+0  00000+0 0  9998
2 26360  53.5190 299.7049 0051186  61.3639 299.2113  2.00568857187882
`;

{
  const sets = parseTle(TLE);
  ok("both elements parse", sets.length === 2, `${sets.length} sets`);
  ok("the name line is picked up", sets[0].name === "GPS BIIR-2  (PRN 13)", sets[0].name);
  ok("line one is line one", sets[0].one.startsWith("1 24876U"));
  ok("line two is line two", sets[0].two.startsWith("2 24876"));

  const bare = parseTle(TLE.split("\n").filter((line) => /^[12] /.test(line)).join("\n"));
  ok("a nameless file still parses", bare.length === 2, `${bare.length} sets`);
  ok("and falls back to the catalogue number", bare[0].name.includes("24876"), bare[0].name);

  ok("junk parses to nothing rather than throwing", parseTle("not a tle\nat all\n").length === 0);
  ok("an empty file is empty", parseTle("").length === 0);
}

{
  const many = Array.from({ length: 1000 }, (_, i) => i);
  const few = sample(many, 50);
  ok("sampling hits the limit", few.length === 50, `${few.length}`);
  ok("it keeps the first", few[0] === 0);
  ok("it spans the file", few[few.length - 1] > 950, String(few[few.length - 1]));
  ok("it is evenly spaced", new Set(few.slice(1).map((value, i) => value - few[i])).size <= 2);
  ok("a short list is returned whole", sample([1, 2, 3], 50).length === 3);
  ok("sampling is deterministic", JSON.stringify(sample(many, 7)) === JSON.stringify(sample(many, 7)));
}

const LOCAL = "scratch/satellite.mjs";
if (!existsSync(LOCAL)) {
  console.log("  --   propagation skipped: no scratch/satellite.mjs");
  console.log("       curl -s https://esm.sh/satellite.js@5.0.0/es2022/satellite.mjs -o scratch/satellite.mjs");
} else {
  const engine = await import(`../${LOCAL}`);
  const sets = parseTle(TLE);
  const satrec = engine.twoline2satrec(sets[0].one, sets[0].two);
  const epoch = new Date(Date.UTC(2026, 0, 1) + (307.51607742 - 1) * 86400000);

  const state = propagateAt({ satrec }, epoch, engine);
  ok("a GPS satellite propagates", state !== null);
  ok("at GPS altitude", state.altitudeKm > 19000 && state.altitudeKm < 21500, `${state.altitudeKm.toFixed(0)} km`);
  ok("at GPS speed", state.velocityKms > 3.7 && state.velocityKms < 4.1, `${state.velocityKms.toFixed(2)} km/s`);
  ok("within its inclination", Math.abs(state.latitude) <= 56.5, `${state.latitude.toFixed(1)} degrees`);
  ok("longitude is a longitude", state.longitude >= -180 && state.longitude <= 180, state.longitude.toFixed(1));
  ok("the scene radius follows the altitude", state.radius > 1 && state.radius < 5, state.radius.toFixed(3));

  const sidereal = 86164.0905 * 1000;
  const shift = (ms) => {
    const later = propagateAt({ satrec }, new Date(epoch.getTime() + ms), engine);
    return Math.abs(((later.longitude - state.longitude + 540) % 360) - 180);
  };
  ok("half a sidereal day puts it on the far side", Math.abs(shift(sidereal / 2) - 180) < 2.5, `${shift(sidereal / 2).toFixed(2)} degrees`);
  ok("a full sidereal day brings the ground track back", shift(sidereal) < 2.5, `${shift(sidereal).toFixed(2)} degrees of drift`);

  const hour = propagateAt({ satrec }, new Date(epoch.getTime() + 3600000), engine);
  const moved = Math.abs(hour.latitude - state.latitude) + Math.abs(hour.longitude - state.longitude);
  ok("and moves between samples", moved > 5, `${moved.toFixed(1)} degrees`);

  const other = propagateAt({ satrec: engine.twoline2satrec(sets[1].one, sets[1].two) }, epoch, engine);
  ok("different elements give different positions", Math.abs(other.longitude - state.longitude) > 5, `${state.longitude.toFixed(1)} against ${other.longitude.toFixed(1)}`);

  const broken = engine.twoline2satrec(
    "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753",
    "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667",
  );
  const far = propagateAt({ satrec: broken }, new Date("2026-11-04T00:00:00Z"), engine);
  ok("a long-dead element set does not produce a plausible position", far === null || far.altitudeKm > 100 || far.altitudeKm < 0, far ? `${far.altitudeKm.toFixed(0)} km` : "null");
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
