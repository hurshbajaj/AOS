
import { STORM, describeKp } from "./forecast.js";

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

export const severityFromKp = (kp) => clamp((kp - 4) / 5, 0.05, 1);

export function stormPosition(kp, date = new Date()) {
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
  const midnight = (((180 - 15 * hours) + 180 + 540) % 360) - 180;
  return { lat: clamp(67 - (kp - 3) * 2.4, 48, 70), lon: midnight };
}

export function flarePosition(date = new Date()) {
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
  const subsolar = (((180 - 15 * hours) + 540) % 360) - 180;
  const doy = Math.floor((date - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
  const declination = -23.44 * Math.cos((2 * Math.PI * (doy + 10)) / 365.25);
  return { lat: declination, lon: subsolar };
}

export function severityFromFlares(flares) {
  if (!flares) {
    return 0;
  }
  if (flares.x > 0) return clamp(0.72 + flares.x * 0.06, 0, 1);
  if (flares.m > 0) return clamp(0.4 + flares.m * 0.04, 0, 0.7);
  if (flares.c > 0) return clamp(0.16 + flares.c * 0.01, 0, 0.38);
  return 0;
}

export function describeFlares({ c = 0, m = 0, x = 0 } = {}) {
  const [count, letter, effect] = x
    ? [x, "X", "strong shortwave blackout"]
    : m
      ? [m, "M", "shortwave fade, sunlit side"]
      : [c, "C", "minor absorption"];
  return `${letter}-class${count > 1 ? ` \u00d7${count}` : ""} — ${effect}`;
}

export function applyLive(world, { weather, prediction }, date = new Date()) {
  const made = [];

  const kp = weather?.now?.kp ?? null;
  if (kp !== null && kp >= 4) {
    const where = stormPosition(kp, date);
    made.push(
      world.addHazard({
        kind: "storm",
        ...where,
        severity: severityFromKp(kp),
        origin: "observed",
        label: `Kp ${kp.toFixed(1)} — ${describeKp(kp)}`,
      }),
    );
  }

  const flareSeverity = severityFromFlares(weather?.flares);
  if (flareSeverity > 0.3) {
    const where = flarePosition(date);
    const { c, m, x } = weather.flares;
    made.push(
      world.addHazard({
        kind: "flare",
        ...where,
        severity: flareSeverity,
        origin: "observed",
        label: describeFlares({ c, m, x }),
      }),
    );
  }

  if (prediction && prediction.kp >= 4) {
    const where = stormPosition(prediction.kp, new Date(`${prediction.date}T00:00:00Z`));
    made.push(
      world.addHazard({
        kind: "storm",
        ...where,
        severity: severityFromKp(prediction.kp),
        origin: "forecast",
        label: `Kp ${prediction.kp.toFixed(1)} forecast for ${prediction.date}`,
        confidence: prediction.probability,
      }),
    );
  }

  return made;
}

export function describeConditions({ weather, prediction }) {
  const parts = [];
  if (weather?.now) {
    parts.push(`Kp ${weather.now.kp.toFixed(1)} (${describeKp(weather.now.kp)})`);
  }
  if (weather?.flares) {
    const { c, m, x } = weather.flares;
    parts.push(x || m || c ? `flares today C${c} M${m} X${x}` : "no flares today");
  }
  if (prediction) {
    parts.push(
      `tomorrow Kp ${prediction.kp.toFixed(1)}, storm probability ${(prediction.probability * 100).toFixed(0)}%`,
    );
  }
  return parts.join(" · ") || "no live space weather";
}

export { STORM };
