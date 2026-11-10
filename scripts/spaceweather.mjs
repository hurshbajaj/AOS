
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SOURCE = "https://kp.gfz.de/app/files/Kp_ap_Ap_SN_F107_since_1932.txt";
const FULL = "scratch/kp-full.json";
const RECENT = "assets/data/kp-recent.json";
const RECENT_DAYS = 140;

export function parse(text) {
  const days = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const f = line.trim().split(/\s+/);
    if (f.length < 28) {
      continue;
    }
    const kp = f.slice(7, 15).map(Number);
    if (kp.some((value) => value < 0)) {
      continue;
    }
    const f107 = Number(f[25]);
    days.push({
      date: `${f[0]}-${f[1].padStart(2, "0")}-${f[2].padStart(2, "0")}`,
      kpMax: Math.max(...kp),
      kpMean: kp.reduce((sum, value) => sum + value, 0) / 8,
      ap: Number(f[23]),
      sunspots: Number(f[24]) < 0 ? null : Number(f[24]),
      f107: f107 < 0 ? (Number(f[26]) < 0 ? null : Number(f[26])) : f107,
    });
  }
  return days;
}

async function main() {
  process.stdout.write(`fetching ${SOURCE}\n`);
  const response = await fetch(SOURCE);
  if (!response.ok) {
    throw new Error(`GFZ returned ${response.status}`);
  }
  const days = parse(await response.text());
  if (days.length < 20000) {
    throw new Error(`only ${days.length} usable days -- the format has probably changed`);
  }

  const complete = days.filter((day) => day.f107 !== null);
  const span = `${days[0].date} to ${days[days.length - 1].date}`;
  process.stdout.write(`${days.length} days, ${span}\n`);
  process.stdout.write(
    `${complete.length} with solar flux, from ${complete[0]?.date} ` +
      `(${(complete[0] ? Math.round((complete.length / days.length) * 100) : 0)}% of the record)\n`,
  );
  const flux = complete.map((day) => day.f107);
  process.stdout.write(`F10.7 ranges ${Math.min(...flux)} to ${Math.max(...flux)} sfu\n`);
  const storms = days.filter((day) => day.kpMax >= 5).length;
  process.stdout.write(`${storms} storm days (Kp >= 5), ${((storms / days.length) * 100).toFixed(1)}%\n`);

  for (const [path, payload] of [
    [FULL, { source: SOURCE, span, days }],
    [RECENT, { source: SOURCE, generated: new Date().toISOString().slice(0, 10), days: days.slice(-RECENT_DAYS) }],
  ]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload));
    process.stdout.write(`wrote ${path}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
