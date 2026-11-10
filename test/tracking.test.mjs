
import { HandTracks, features, straightness } from "../src/orbital/tracking.js";
import { DT, JITTER, POSTURES, detection, gaussian, hand, mulberry32 } from "./hand-fixture.mjs";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const run = (frames, { noise = 0, seed = 1 } = {}) => {
  const tracks = new HandTracks();
  const random = mulberry32(seed);
  let time = 1000;
  const history = [];
  for (const frame of frames) {
    const detections = frame.map((options) =>
      options.landmarks ? options : detection(hand({ ...options, noise, random }), options),
    );
    tracks.update(detections, time);
    history.push({ ids: tracks.tracks.map((t) => t.id), primary: tracks.primary?.id ?? null });
    time += DT * 1000;
  }
  return { tracks, history };
};

const hold = (frame, count) => Array.from({ length: count }, () => frame);

{
  const small = features(hand({ scale: 0.07 }));
  const large = features(hand({ scale: 0.26 }));
  ok("scale tracks apparent size", Math.abs(large.scale / small.scale - 0.26 / 0.07) < 0.02, `${small.scale.toFixed(3)} and ${large.scale.toFixed(3)}`);
  ok("scale is what was asked for", Math.abs(small.scale - 0.07) < 1e-9, small.scale.toFixed(4));

  const points = hand({});
  points[13] = { x: 0.9, y: 0.05, z: 0 };
  ok("one broken landmark does not move the scale", Math.abs(features(points).scale - 0.12) < 0.01, features(points).scale.toFixed(4));
}

{
  const aimed = [0, 45, 90, 135, 180, -135, -90, -45].map(
    (angle) => features(hand({ digits: { index: angle } })).raw.index,
  );
  ok("straightness is rotation invariant", Math.min(...aimed) > 0.99, `worst ${Math.min(...aimed).toFixed(3)}`);

  const turned = [0, 45, 90, 135, 180, -135, -90, -45].map(
    (angle) => features(hand({ digits: POSTURES.point(-90), rotate: angle })).straight.index,
  );
  ok("a turned hand still has its finger out", Math.min(...turned) > 0.99, `worst ${Math.min(...turned).toFixed(3)}`);

  const curled = features(hand({ digits: {} }));
  ok("a curled finger is not straight", curled.straight.index < 0.01, curled.raw.index.toFixed(3));
  ok("extension is continuous, not boolean", features(hand({ digits: { index: -90 } })).straight.index <= 1);

  const out = features(hand({ digits: POSTURES.point() })).reach;
  ok("an extended tip reaches well past the palm", out.index > 1.1, out.index.toFixed(2));
  ok("and the curled ones do not", Math.max(out.middle, out.ring, out.pinky) < 0.5, `${out.middle.toFixed(2)} ${out.ring.toFixed(2)} ${out.pinky.toFixed(2)}`);
  ok("a tucked thumb stays inside the circle", features(hand({ digits: POSTURES.fist() })).reach.thumb < 0.45, features(hand({ digits: POSTURES.fist() })).reach.thumb.toFixed(2));
  ok("an extended thumb clears it", features(hand({ digits: POSTURES.thumb() })).reach.thumb > 0.75, features(hand({ digits: POSTURES.thumb() })).reach.thumb.toFixed(2));

  const points = hand({ digits: { index: -90 } });
  points[8] = { x: points[6].x + 0.02, y: points[6].y + 0.03, z: 0 };
  const half = straightness(points, [5, 6, 7, 8]);
  ok("a half-bent finger lands between", half > 0.1 && half < 0.95, half.toFixed(3));
}

{
  const towards = (random) => {
    const points = hand({ digits: { index: -90 } });
    [5, 6, 7, 8].forEach((landmark, i) => {
      points[landmark] = {
        x: 0.5 + gaussian(random) * JITTER,
        y: 0.45 + gaussian(random) * JITTER,
        z: -i * 0.03,
      };
    });
    return points;
  };

  const flat = (points) => points.map((p) => ({ x: p.x, y: p.y, z: 0 }));
  const spread = (values) => Math.max(...values) - Math.min(...values);

  const deep = [];
  const shallow = [];
  for (let seed = 1; seed <= 12; seed += 1) {
    const points = towards(mulberry32(seed));
    deep.push(straightness(points, [5, 6, 7, 8]));
    shallow.push(straightness(flat(points), [5, 6, 7, 8]));
  }
  ok("in 3D a finger aimed at the lens is straight", Math.min(...deep) > 0.88, `worst ${Math.min(...deep).toFixed(3)}`);
  ok("and stays straight whatever the jitter does", spread(deep) < 0.1, `${spread(deep).toFixed(3)} spread over 12 seeds`);
  ok(
    "from the projection alone it is unusable",
    spread(shallow) > spread(deep) * 4,
    `${spread(shallow).toFixed(3)} spread, mean ${(shallow.reduce((a, b) => a + b, 0) / shallow.length).toFixed(3)}`,
  );

  const points = hand({ digits: POSTURES.point(-90) });
  const wrecked = points.map((p, i) => (i >= 9 && i <= 20 ? { x: 0.5, y: 0.1, z: 0 } : p));
  ok(
    "metric landmarks override the projection",
    Math.abs(features(wrecked, points).straight.middle - features(points).straight.middle) < 1e-9,
    features(wrecked, points).straight.middle.toFixed(3),
  );
}

{
  const up = features(hand({ digits: POSTURES.point(-90) })).direction;
  ok("the index direction is a unit vector", Math.abs(Math.hypot(up.index.x, up.index.y) - 1) < 1e-9);
  ok("pointing up is negative y", up.index.y < -0.99, up.index.y.toFixed(3));

  const near = features(hand({ digits: POSTURES.point(37), scale: 0.3 })).direction.index;
  const far = features(hand({ digits: POSTURES.point(37), scale: 0.05 })).direction.index;
  ok("direction is scale-free", Math.abs(near.x - far.x) < 1e-9 && Math.abs(near.y - far.y) < 1e-9);

  ok("every digit reports some axis", Object.keys(features(hand({})).direction).length === 5);
}

{
  const { tracks, history } = run(hold([{ x: 0.5 }], 20), { noise: JITTER });
  ok("one hand gives one track", tracks.tracks.length === 1, `${tracks.tracks.length} tracks`);
  ok("the track keeps its identity", new Set(history.map((h) => h.primary)).size === 1, `${new Set(history.map((h) => h.primary)).size} ids`);
  ok("it is the primary", tracks.primary === tracks.tracks[0]);
  ok("age accumulates", tracks.tracks[0].age >= 19, String(tracks.tracks[0].age));
}

{
  const frames = Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    return [
      { x: 0.3 + t * 0.4, y: 0.5, scale: 0.13, handedness: "Right" },
      { x: 0.7 - t * 0.4, y: 0.52, scale: 0.1, handedness: "Left" },
    ];
  });
  const shuffled = frames.map((frame, i) => (i % 2 ? [...frame].reverse() : frame));
  const { tracks } = run(shuffled, { noise: JITTER });
  ok("two hands give two tracks", tracks.tracks.length === 2, `${tracks.tracks.length} tracks`);

  const right = tracks.tracks.find((t) => t.handedness === "Right");
  ok("handedness survives the crossing", Boolean(right), tracks.tracks.map((t) => t.handedness).join(","));
  ok("the right hand ended on the right", right && right.position.x > 0.6, right?.position.x.toFixed(2));
  ok("neither track was restarted", tracks.tracks.every((t) => t.age > 20), tracks.tracks.map((t) => t.age).join(","));
}

{
  const frames = [...hold([{ x: 0.4 }], 10), ...hold([], 3), ...hold([{ x: 0.45 }], 10)];
  const { tracks, history } = run(frames, { noise: JITTER });
  ok("a short dropout keeps the track", new Set(history.map((h) => h.primary).filter(Boolean)).size === 1, `${new Set(history.map((h) => h.primary).filter(Boolean)).size} ids`);
  ok("and it is detected again afterwards", tracks.tracks[0].tracked && tracks.tracks[0].age > 15);

  const long = [...hold([{ x: 0.4 }], 10), ...hold([], 30), ...hold([{ x: 0.4 }], 5)];
  const after = run(long, { noise: JITTER });
  ok("a long dropout retires the track", after.tracks.tracks.length === 1 && after.tracks.tracks[0].age < 6, `age ${after.tracks.tracks[0].age}`);
  ok("and the hand that returns is a new one", new Set(after.history.map((h) => h.primary).filter(Boolean)).size === 2);
}

{
  const frames = [
    ...hold([{ x: 0.3, scale: 0.1, handedness: "Right" }], 10),
    ...hold([
      { x: 0.3, scale: 0.1, handedness: "Right" },
      { x: 0.7, scale: 0.2, handedness: "Left" },
    ], 12),
  ];
  const { tracks, history } = run(frames, { noise: JITTER });
  const handover = history.findIndex((h, i) => i > 10 && h.primary !== history[10].primary);
  ok("a clearly nearer hand takes over", tracks.primary.handedness === "Left", tracks.primary.handedness);
  ok("but not on the first frame", handover > 11, `frame ${handover}`);

  const noisy = Array.from({ length: 40 }, (_, i) => [
    { x: 0.35, scale: 0.12 + Math.sin(i / 3) * 0.004, handedness: "Right" },
    { x: 0.65, scale: 0.12 - Math.sin(i / 3) * 0.004, handedness: "Left" },
  ]);
  const flapping = run(noisy, { noise: JITTER });
  const changes = flapping.history.filter((h, i) => i > 6 && h.primary !== flapping.history[i - 1].primary).length;
  ok("similar hands do not trade control", changes === 0, `${changes} handovers`);
}

{
  const tracks = new HandTracks();
  const random = mulberry32(3);
  let time = 1000;
  let direction = null;
  const readings = [];
  for (let i = 0; i < 40; i += 1) {
    tracks.update([detection(hand({ digits: POSTURES.point(-90), noise: JITTER, random }))], time);
    const track = tracks.primary;
    direction = track.aimAt(track.feature.direction.index, DT);
    if (i > 15) readings.push((Math.atan2(direction.y, direction.x) * 180) / Math.PI);
    time += DT * 1000;
  }
  const spread = Math.max(...readings) - Math.min(...readings);
  ok("a smoothed aim stays steady under jitter", spread < 6, `${spread.toFixed(1)} degrees of wobble`);
  ok("and stays a unit vector", Math.abs(Math.hypot(direction.x, direction.y) - 1) < 1e-9);

  const dropped = tracks.primary.aimAt(null, DT);
  ok("letting go of the aim clears it", dropped === null && tracks.primary.direction === null);
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
