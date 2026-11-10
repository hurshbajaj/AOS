
import { angleBetween, centuries, geocentric, heliocentric, julianDay, longitude } from "../src/orbital/ephemeris.js";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

{
  ok("J2000 is JD 2451545", Math.abs(julianDay(new Date("2000-01-01T12:00:00Z")) - 2451545) < 1e-6, julianDay(new Date("2000-01-01T12:00:00Z")).toFixed(4));
  ok("and zero centuries from it", Math.abs(centuries(new Date("2000-01-01T12:00:00Z"))) < 1e-9);
  ok("a century later is one", Math.abs(centuries(new Date("2100-01-01T12:00:00Z")) - 1) < 0.0003, centuries(new Date("2100-01-01T12:00:00Z")).toFixed(6));
}

{
  const seasons = [
    ["2026-03-20T14:46:00Z", 0],
    ["2026-06-21T08:25:00Z", 90],
    ["2026-09-23T00:06:00Z", 180],
    ["2026-12-21T20:50:00Z", 270],
  ];
  const errors = seasons.map(([iso, expected]) => {
    const measured = longitude(geocentric(new Date(iso)).sun.direction);
    return ((measured - expected + 540) % 360) - 180;
  });
  const worst = Math.max(...errors.map(Math.abs));
  ok("the Sun is where the seasons say it is", worst < 0.5, `worst ${worst.toFixed(3)} degrees`);
  const spread = Math.max(...errors) - Math.min(...errors);
  ok("and the error is a constant offset, not noise", spread < 0.05, `${spread.toFixed(4)} degrees of spread`);

  const rate = (iso) => {
    const from = longitude(geocentric(new Date(iso)).sun.direction);
    const to = longitude(geocentric(new Date(new Date(iso).getTime() + 10 * 86400000)).sun.direction);
    return (((to - from) % 360) + 360) % 360 / 10;
  };
  const fast = rate("2026-01-01T00:00:00Z");
  const slow = rate("2026-07-01T00:00:00Z");
  ok("the Sun advances about a degree a day", fast > 0.9 && fast < 1.1 && slow > 0.9 && slow < 1.1, `${fast.toFixed(4)} and ${slow.toFixed(4)}`);
  ok("faster at perihelion than at aphelion", fast - slow > 0.05, `${(fast - slow).toFixed(4)} degrees a day apart`);

  let travelled = 0;
  for (let i = 0; i < 365; i += 1) {
    const from = longitude(geocentric(new Date(Date.UTC(2026, 0, 1) + i * 86400000)).sun.direction);
    const to = longitude(geocentric(new Date(Date.UTC(2026, 0, 1) + (i + 1) * 86400000)).sun.direction);
    travelled += (((to - from) % 360) + 360) % 360;
  }
  ok("and a full circuit in a year", Math.abs(travelled - 360) < 1.5, `${travelled.toFixed(2)} degrees over 365 days`);

  const samples = Array.from({ length: 365 }, (_, i) => geocentric(new Date(Date.UTC(2026, 0, 1) + i * 86400000)).sun.distance);
  ok("Earth stays about an au away", Math.min(...samples) > 0.98 && Math.max(...samples) < 1.02, `${Math.min(...samples).toFixed(4)} to ${Math.max(...samples).toFixed(4)}`);
  const closest = samples.indexOf(Math.min(...samples));
  ok("perihelion is in early January", closest < 10, `day ${closest + 1}`);
}

{
  let worst = 0;
  let closest = Infinity;
  let furthest = 0;
  for (let i = 0; i < 4000; i += 1) {
    const sky = geocentric(new Date(Date.UTC(2024, 0, 1) + i * 86400000));
    worst = Math.max(worst, sky.venus.elongation);
    closest = Math.min(closest, sky.venus.distance);
    furthest = Math.max(furthest, sky.venus.distance);
  }
  ok("Venus never leaves the Sun's neighbourhood", worst > 45 && worst < 48, `greatest elongation ${worst.toFixed(2)} degrees`);
  ok("and its distance swings the right way", closest > 0.25 && closest < 0.3 && furthest > 1.7 && furthest < 1.75, `${closest.toFixed(3)} to ${furthest.toFixed(3)} au`);

  let mercury = 0;
  for (let i = 0; i < 4000; i += 1) {
    mercury = Math.max(mercury, geocentric(new Date(Date.UTC(2024, 0, 1) + i * 86400000)).mercury.elongation);
  }
  ok("Mercury stays closer still", mercury > 26 && mercury < 29, `greatest elongation ${mercury.toFixed(2)} degrees`);

  const ORBITS = { mercury: 0.387, venus: 0.723, mars: 1.524, jupiter: 5.203, saturn: 9.537, uranus: 19.189, neptune: 30.07 };
  const drift = Object.entries(ORBITS).map(([name, expected]) => {
    const body = heliocentric(name, new Date("2026-11-04T00:00:00Z"));
    return [name, Math.abs(Math.hypot(body.x, body.y, body.z) - expected) / expected];
  });
  const worstOrbit = drift.reduce((best, next) => (next[1] > best[1] ? next : best));
  ok("every orbit is the right size", worstOrbit[1] < 0.22, `worst ${worstOrbit[0]} off by ${(worstOrbit[1] * 100).toFixed(1)}%`);

  const tilts = Object.keys(ORBITS).map((name) => {
    const body = heliocentric(name, new Date("2026-11-04T00:00:00Z"));
    return Math.abs(Math.asin(body.z / Math.hypot(body.x, body.y, body.z)) * (180 / Math.PI));
  });
  ok("and lies near the ecliptic plane", Math.max(...tilts) < 7.5, `worst ${Math.max(...tilts).toFixed(2)} degrees`);

  const venus = heliocentric("venus", new Date("2026-11-04T00:00:00Z"));
  const radius = Math.hypot(venus.x, venus.y, venus.z);
  ok("Venus orbits at 0.72 au", Math.abs(radius - 0.7233) < 0.006, radius.toFixed(4));

  const tilt = Math.abs(Math.asin(venus.z / radius) * (180 / Math.PI));
  ok("barely out of the ecliptic plane", tilt < 3.5, `${tilt.toFixed(2)} degrees`);
}

{
  const sky = geocentric(new Date("2026-11-04T00:00:00Z"));
  const lengths = Object.entries(sky).map(([name, body]) => {
    const vector = body.direction;
    return [name, Math.abs(Math.hypot(vector.x, vector.y, vector.z) - 1)];
  });
  const worstLength = lengths.reduce((best, next) => (next[1] > best[1] ? next : best));
  ok("every direction is a unit vector", worstLength[1] < 1e-12, `worst ${worstLength[0]} off by ${worstLength[1].toExponential(1)}`);
  ok("and there is one for every body", lengths.length === 8, `${lengths.length} bodies`);
  ok("elongation agrees with the vectors", Math.abs(angleBetween(sky.sun.direction, sky.venus.direction) - sky.venus.elongation) < 1e-9);
  ok("a vector against itself is zero degrees", angleBetween(sky.sun.direction, sky.sun.direction) < 1e-4, angleBetween(sky.sun.direction, sky.sun.direction).toExponential(1));
  const opposite = angleBetween(sky.sun.direction, { x: -sky.sun.direction.x, y: -sky.sun.direction.y, z: -sky.sun.direction.z });
  ok("and against its opposite is 180", Math.abs(opposite - 180) < 1e-4, opposite.toFixed(9));
  ok("an out-of-range dot product cannot escape the clamp", Number.isFinite(angleBetween({ x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 0 })));

  ok("longitude wraps into 0..360", [0, 90, 180, 270, 359].every((_, i) => {
    const angle = (i * 73) % 360;
    const radians = (angle * Math.PI) / 180;
    return Math.abs(longitude({ x: Math.cos(radians), y: Math.sin(radians), z: 0 }) - angle) < 1e-9;
  }));

  ok("an unknown body is refused", (() => {
    try {
      heliocentric("pluto", new Date());
      return false;
    } catch {
      return true;
    }
  })());
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
