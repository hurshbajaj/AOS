
import { aim, compass, pick, posture } from "../src/orbital/gestures.js";
import { features } from "../src/orbital/tracking.js";
import { POSTURES, Rig, hand } from "./hand-fixture.mjs";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const geometry = (digits) => features(hand({ digits })).geometry;
const NAMES = ["open", "fist", "point", "thumb", "both"];

{
  for (const name of NAMES) {
    const scores = geometry(POSTURES[name]());
    const winner = Object.entries(scores).reduce((best, next) => (next[1] > best[1] ? next : best));
    const rest = Math.max(...Object.entries(scores).filter(([k]) => k !== name).map(([, v]) => v));
    ok(`${name} scores as ${name}`, winner[0] === name && winner[1] > 0.9 && rest < 0.1, `${winner[1].toFixed(2)} vs ${rest.toFixed(2)} next`);
  }

  const turned = (name, extra = {}) =>
    [0, 45, 90, 135, 180, -135, -90, -45].map(
      (angle) => features(hand({ digits: POSTURES[name](), rotate: angle, ...extra })).geometry[name],
    );
  const everyWay = turned("point");
  ok("pointing any direction still reads as pointing", Math.min(...everyWay) > 0.9, `worst ${Math.min(...everyWay).toFixed(2)}`);

  const thumbEveryWay = turned("thumb");
  ok("a thumb in any direction reads as a thumb", Math.min(...thumbEveryWay) > 0.9, `worst ${Math.min(...thumbEveryWay).toFixed(2)}`);

  const bothEveryWay = turned("both");
  ok("an L in any direction reads as an L", Math.min(...bothEveryWay) > 0.9, `worst ${Math.min(...bothEveryWay).toFixed(2)}`);

  const near = features(hand({ digits: POSTURES.point(), scale: 0.3 })).geometry.point;
  const far = features(hand({ digits: POSTURES.point(), scale: 0.06 })).geometry.point;
  ok("posture is scale-free", Math.abs(near - far) < 0.02, `${near.toFixed(3)} and ${far.toFixed(3)}`);

  const broken = hand({ digits: POSTURES.open() });
  broken[16] = { x: 0.95, y: 0.02, z: 0 };
  ok("one broken landmark does not flip the posture", pick(posture(features(broken).geometry)).name === "open", pick(posture(features(broken).geometry)).name);
}

{
  const bare = posture(geometry(POSTURES.thumb()));
  const helped = posture(geometry(POSTURES.thumb()), [{ categoryName: "Thumb_Up", score: 0.9 }]);
  ok("the classifier adds confidence", helped.thumb > bare.thumb, `${bare.thumb.toFixed(2)} to ${helped.thumb.toFixed(2)}`);

  const wrong = posture(geometry(POSTURES.point()), [{ categoryName: "Closed_Fist", score: 0.8 }]);
  ok("geometry still wins against a wrong label", pick(wrong).name === "point", pick(wrong).name);

  ok("an unknown label is ignored", posture(geometry(POSTURES.open()), [{ categoryName: "Nonsense", score: 1 }]).open === bare.open + geometry(POSTURES.open()).open - bare.open);

  for (const name of NAMES) {
    if (pick(posture(geometry(POSTURES[name]()))).name !== name) {
      ok(`${name} works with no classifier`, false, pick(posture(geometry(POSTURES[name]()))).name);
    }
  }
  ok("every posture works with no classifier at all", true);

  ok("nothing recognisable is idle", pick({ open: 0.04, fist: 0.03, point: 0, thumb: 0, both: 0 }).name === "idle");
  ok("a tie is idle", pick({ open: 0.6, fist: 0.58, point: 0, thumb: 0, both: 0 }).name === "idle");
  ok("a weak winner is idle", pick({ open: 0, fist: 0.33, point: 0, thumb: 0, both: 0 }).name === "idle");
  ok("a clear winner is not", pick({ open: 0, fist: 0.9, point: 0, thumb: 0, both: 0 }).name === "fist");
}

{
  const direction = (digits) => features(hand({ digits })).direction;

  for (const angle of [0, 45, 90, 135, 180, -135, -90, -45]) {
    const vector = aim("point", direction(POSTURES.point(angle)));
    const read = (Math.atan2(vector.y, vector.x) * 180) / Math.PI;
    const delta = ((read - angle + 540) % 360) - 180;
    if (Math.abs(delta) > 1) {
      ok(`index at ${angle} reads as ${angle}`, false, `${read.toFixed(1)}`);
    }
  }
  ok("the index points where it points, in all eight directions", true);

  const thumbVector = aim("thumb", direction(POSTURES.thumb(-90)));
  ok("the thumb points where it points", Math.abs(thumbVector.y + 1) < 0.01 && Math.abs(thumbVector.x) < 0.01, `${thumbVector.x.toFixed(2)}, ${thumbVector.y.toFixed(2)}`);

  const l = aim("both", direction(POSTURES.both(-135, -45)));
  const bisector = (Math.atan2(l.y, l.x) * 180) / Math.PI;
  ok("an L points between its two digits", Math.abs(bisector + 90) < 1, `${bisector.toFixed(1)} degrees, expected -90`);

  const skew = aim("both", direction(POSTURES.both(180, -90)));
  ok("and on an asymmetric L too", Math.abs((Math.atan2(skew.y, skew.x) * 180) / Math.PI + 135) < 1, `${((Math.atan2(skew.y, skew.x) * 180) / Math.PI).toFixed(1)} degrees, expected -135`);

  ok("zoom postures have no direction", aim("open", direction(POSTURES.open())) === null && aim("fist", direction(POSTURES.fist())) === null);
}

{
  const inward = new Rig({ seed: 1 });
  inward.hold(POSTURES.open(), 30).coast();
  ok("an open palm zooms in", inward.total.scale < 0.75, `scale ${inward.total.scale.toFixed(3)}`);

  const outward = new Rig({ seed: 2 });
  outward.hold(POSTURES.fist(), 30).coast();
  ok("a fist zooms out", outward.total.scale > 1.3, `scale ${outward.total.scale.toFixed(3)}`);
  ok("in and out are reciprocal", Math.abs(inward.total.scale * outward.total.scale - 1) < 0.02, (inward.total.scale * outward.total.scale).toFixed(4));
  ok("zooming does not turn", Math.abs(inward.total.dx) < 1e-9 && Math.abs(inward.total.dy) < 1e-9);

  const brief = new Rig({ seed: 3 });
  brief.hold(POSTURES.open(), 12).coast();
  ok("holding longer zooms further", inward.total.scale < brief.total.scale * 0.8, `${brief.total.scale.toFixed(3)} then ${inward.total.scale.toFixed(3)}`);
}

{
  const errors = [];
  for (const angle of [0, 30, 60, 90, 120, 150, 180, -150, -120, -90, -60, -30]) {
    const rig = new Rig({ seed: 40 + angle });
    rig.hold(POSTURES.point(-90), 24, { rotate: angle + 90 }).coast();
    const read = (Math.atan2(rig.total.dy, rig.total.dx) * 180) / Math.PI;
    errors.push(Math.abs(((read - angle + 540) % 360) - 180));
  }
  const worst = Math.max(...errors);
  ok("the view turns the way the finger points", worst < 3, `worst ${worst.toFixed(1)} degrees over 12 angles`);

  const up = new Rig({ seed: 5 });
  up.hold(POSTURES.point(-90), 24).coast();
  ok("pointing up turns up", up.total.dy < -0.05 && Math.abs(up.total.dx) < 0.01, `${up.total.dx.toFixed(3)}, ${up.total.dy.toFixed(3)}`);

  const diagonal = new Rig({ seed: 6 });
  diagonal.hold(POSTURES.both(-135, -45), 24).coast();
  ok("an L turns along its bisector", diagonal.total.dy < -0.05 && Math.abs(diagonal.total.dx) < 0.01, `${diagonal.total.dx.toFixed(3)}, ${diagonal.total.dy.toFixed(3)}`);

  const thumbRig = new Rig({ seed: 7 });
  thumbRig.hold(POSTURES.thumb(-90), 24, { rotate: 90 }).coast();
  ok("a thumb turns the way it points", thumbRig.total.dx > 0.05 && Math.abs(thumbRig.total.dy) < 0.01, `${thumbRig.total.dx.toFixed(3)}, ${thumbRig.total.dy.toFixed(3)}`);

  ok("turning does not zoom", Math.abs(up.total.scale - 1) < 1e-9, up.total.scale.toFixed(6));
}

{
  const empty = new Rig({ seed: 8 });
  for (let i = 0; i < 30; i += 1) {
    empty.frame([]);
  }
  ok("no hands does nothing", empty.reader.mode === "idle" && Math.abs(empty.total.dx) < 1e-9 && Math.abs(empty.total.scale - 1) < 1e-9);

  const arriving = new Rig({ seed: 9 });
  arriving.hold(POSTURES.point(-90), 2);
  ok("a hand arriving waits before acting", arriving.reader.mode === "warming" && Math.abs(arriving.total.dy) < 1e-9, arriving.reader.mode);

  const vague = new Rig({ seed: 10 });
  for (let i = 0; i < 30; i += 1) {
    vague.frame({ digits: { ring: -90, pinky: -90 }, x: 0.4 + (i % 5) * 0.03 });
  }
  ok("an unrecognised shape does nothing", vague.reader.mode === "idle", vague.reader.mode);

  const waving = new Rig({ seed: 11 });
  for (let i = 0; i < 30; i += 1) {
    waving.frame({ digits: {}, x: 0.3 + Math.sin(i / 3) * 0.15, y: 0.5 + Math.cos(i / 3) * 0.1 });
  }
  ok("waving a fist around only zooms out, never turns", Math.abs(waving.total.dx) < 1e-9 && Math.abs(waving.total.dy) < 1e-9 && waving.total.scale > 1.1, `scale ${waving.total.scale.toFixed(3)}`);
}

{
  const rig = new Rig({ seed: 12 });
  rig.hold(POSTURES.point(0), 20);
  const moving = rig.reader.sample(1 / 60).dx;
  rig.hold(POSTURES.fist(), 20);
  const after = rig.reader.sample(1 / 60).dx;
  ok("releasing a posture winds the turn down", moving > 1e-4 && Math.abs(after) < moving / 10, `${moving.toExponential(1)} to ${after.toExponential(1)}`);

  const swap = new Rig({ seed: 13 });
  swap.hold(POSTURES.open(), 20);
  const zoomingIn = swap.reader.zoomRate;
  swap.hold(POSTURES.fist(), 20);
  ok("open to fist reverses the zoom", zoomingIn > 0.5 && swap.reader.zoomRate < -0.5, `${zoomingIn.toFixed(2)} then ${swap.reader.zoomRate.toFixed(2)}`);

  const flaky = new Rig({ seed: 14 });
  flaky.hold(POSTURES.point(-90), 20);
  flaky.frame({ digits: POSTURES.open() });
  ok("one stray frame does not drop the posture", flaky.reader.mode === "point", flaky.reader.mode);
  flaky.hold(POSTURES.open(), 6);
  ok("four of them do", flaky.reader.mode === "open", flaky.reader.mode);

  const dropped = new Rig({ seed: 15 });
  dropped.hold(POSTURES.point(-90), 20);
  dropped.frame([]);
  dropped.frame([]);
  ok("the gesture survives dropped frames", dropped.reader.mode === "point", dropped.reader.mode);
}

{
  const two = new Rig({ seed: 16 });
  for (let i = 0; i < 24; i += 1) {
    two.frame([
      { digits: POSTURES.point(-90), x: 0.35, scale: 0.14, handedness: "Right" },
      { digits: POSTURES.open(), x: 0.7, scale: 0.1, handedness: "Left" },
    ]);
  }
  ok("the nearer hand decides", two.reader.mode === "point", two.reader.mode);
  ok("and the other one is ignored", Math.abs(two.total.scale - 1) < 1e-9, two.total.scale.toFixed(4));
}

{
  ok("compass names right", compass({ x: 1, y: 0 }) === "right");
  ok("compass names up", compass({ x: 0, y: -1 }) === "up");
  ok("compass names down-left", compass({ x: -0.7, y: 0.7 }) === "down-left");

  const rig = new Rig({ seed: 17, spend: false });
  rig.hold(POSTURES.point(0), 10);
  rig.time -= 1000;
  rig.frame({ digits: POSTURES.point(0) });
  const out = rig.reader.sample(1 / 60);
  ok("a backwards timestamp stays finite", Number.isFinite(out.dx) && Number.isFinite(out.scale), `${out.dx}, ${out.scale}`);
  ok("a huge dt is clamped", Number.isFinite(rig.reader.sample(10).dx));
  ok("scale stays positive", rig.reader.sample(1 / 60).scale > 0);
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
