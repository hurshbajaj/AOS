
import { OneEuro, median, normalise, smoothstep } from "./filters.js";

const WRIST = 0;
const PALM = [0, 1, 5, 9, 13, 17];
const FRAME_BONES = [[0, 5], [0, 9], [0, 13], [0, 17]];

const TIPS = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };

const DIGITS = {
  thumb: [2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};
const AXIS = {
  thumb: [2, 4],
  index: [5, 8],
  middle: [9, 12],
  ring: [13, 16],
  pinky: [17, 20],
};

const STRAIGHT_LOW = 0.7;
const STRAIGHT_HIGH = 0.9;

const REACH_LOW = 0.6;
const REACH_HIGH = 1;
const THUMB_REACH_LOW = 0.5;
const THUMB_REACH_HIGH = 0.8;
const REACH_WEIGHT = 0.65;
const STRAIGHT_WEIGHT = 0.35;
const THUMB_LOW = 0.8;
const THUMB_HIGH = 0.94;

const GATE = 2.5;
const COAST_S = 0.26;
const USURP_RATIO = 1.18;
const USURP_FRAMES = 5;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const distance3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

function centroid(points, indices) {
  let x = 0;
  let y = 0;
  for (const index of indices) {
    x += points[index].x;
    y += points[index].y;
  }
  return { x: x / indices.length, y: y / indices.length };
}

const frameSize = (points) => Math.max(median(FRAME_BONES.map(([a, b]) => distance(points[a], points[b]))), 1e-5);

export function straightness(points, chain) {
  let walked = 0;
  for (let i = 1; i < chain.length; i += 1) {
    walked += distance3(points[chain[i - 1]], points[chain[i]]);
  }
  return walked > 1e-9 ? distance3(points[chain[0]], points[chain[chain.length - 1]]) / walked : 0;
}

export function features(landmarks, world = null) {
  const palm = centroid(landmarks, PALM);
  const scale = frameSize(landmarks);
  const shape = world ?? landmarks;

  const hub = centroid(shape, PALM);
  const unit = Math.max(median(FRAME_BONES.map(([a, b]) => distance3(shape[a], shape[b]))), 1e-9);

  const raw = {};
  const reach = {};
  const out = {};
  for (const [name, chain] of Object.entries(DIGITS)) {
    const thumb = name === "thumb";
    raw[name] = straightness(shape, chain);
    reach[name] = distance3(shape[TIPS[name]], hub) / unit;
    const far = smoothstep(reach[name], thumb ? THUMB_REACH_LOW : REACH_LOW, thumb ? THUMB_REACH_HIGH : REACH_HIGH);
    const straight = smoothstep(raw[name], thumb ? THUMB_LOW : STRAIGHT_LOW, thumb ? THUMB_HIGH : STRAIGHT_HIGH);
    out[name] = REACH_WEIGHT * far + STRAIGHT_WEIGHT * straight;
  }

  const direction = {};
  for (const [name, [base, tip]] of Object.entries(AXIS)) {
    direction[name] = normalise(landmarks[tip].x - landmarks[base].x, landmarks[tip].y - landmarks[base].y);
  }

  const trio = (out.middle + out.ring + out.pinky) / 3;

  return {
    palm,
    scale,
    straight: out,
    raw,
    reach,
    direction,
    geometry: {
      open: out.index * trio,
      fist: (1 - out.index) * (1 - trio) * (1 - out.thumb),
      point: out.index * (1 - trio) * (1 - out.thumb),
      thumb: out.thumb * (1 - out.index) * (1 - trio),
      both: out.thumb * out.index * (1 - trio),
    },
  };
}

let nextId = 1;

class Track {
  misses = 0;
  age = 0;
  rival = 0;

  constructor(detection, now) {
    this.id = nextId;
    nextId += 1;
    this.handedness = detection.handedness ?? "Unknown";
    this.feature = features(detection.landmarks, detection.world);
    this.ml = detection.gestures ?? [];
    this.seen = now;

    this.scaleFilter = new OneEuro({ minCutoff: 0.8, beta: 1.5 });
    this.scaleFilter.filter(this.feature.scale, 0);
    this.scale = this.feature.scale;

    this.aim = { x: new OneEuro({ minCutoff: 1.1, beta: 1.2 }), y: new OneEuro({ minCutoff: 1.1, beta: 1.2 }) };
    this.direction = null;
  }

  absorb(detection, now, dt) {
    this.feature = features(detection.landmarks, detection.world);
    this.ml = detection.gestures ?? [];
    if (detection.handedness) {
      this.handedness = detection.handedness;
    }
    this.scale = this.scaleFilter.filter(this.feature.scale, dt);
    this.seen = now;
    this.misses = 0;
    this.age += 1;
  }

  aimAt(vector, dt) {
    if (!vector) {
      this.aim.x.reset();
      this.aim.y.reset();
      this.direction = null;
      return null;
    }
    const x = this.aim.x.filter(vector.x, dt);
    const y = this.aim.y.filter(vector.y, dt);
    this.direction = normalise(x, y) ?? vector;
    return this.direction;
  }

  get position() {
    return this.feature.palm;
  }

  get tracked() {
    return this.misses === 0;
  }
}

export class HandTracks {
  tracks = [];
  primary = null;

  #time = 0;

  update(detections, nowMs) {
    const now = nowMs / 1000;
    const dt = this.#time ? Math.min(Math.max(now - this.#time, 1e-4), 0.2) : 0;
    this.#time = now;
    this.dt = dt;

    const pairs = [];
    detections.forEach((detection, d) => {
      const palm = centroid(detection.landmarks, PALM);
      const scale = frameSize(detection.landmarks);
      this.tracks.forEach((track, t) => {
        const gap = distance(palm, track.position) / scale;
        const mismatch =
          detection.handedness && track.handedness !== "Unknown" && detection.handedness !== track.handedness
            ? GATE * 0.8
            : 0;
        pairs.push({ d, t, cost: gap + mismatch });
      });
    });
    pairs.sort((a, b) => a.cost - b.cost);

    const takenDetection = new Set();
    const takenTrack = new Set();
    for (const pair of pairs) {
      if (pair.cost > GATE || takenDetection.has(pair.d) || takenTrack.has(pair.t)) {
        continue;
      }
      takenDetection.add(pair.d);
      takenTrack.add(pair.t);
      this.tracks[pair.t].absorb(detections[pair.d], now, dt || 1 / 30);
    }

    for (let t = 0; t < this.tracks.length; t += 1) {
      if (!takenTrack.has(t)) {
        this.tracks[t].misses += 1;
      }
    }
    detections.forEach((detection, d) => {
      if (!takenDetection.has(d)) {
        this.tracks.push(new Track(detection, now));
      }
    });

    this.tracks = this.tracks.filter((track) => now - track.seen <= COAST_S);
    this.#elect();
    return this.tracks;
  }

  reset() {
    this.tracks = [];
    this.primary = null;
    this.#time = 0;
  }

  #elect() {
    if (!this.tracks.length) {
      this.primary = null;
      return;
    }
    if (!this.primary || !this.tracks.includes(this.primary)) {
      this.primary = this.tracks.reduce((best, next) => (next.scale > best.scale ? next : best));
      this.primary.rival = 0;
      return;
    }
    const challenger = this.tracks.reduce((best, next) => (next.scale > best.scale ? next : best));
    if (challenger === this.primary || challenger.scale < this.primary.scale * USURP_RATIO) {
      for (const track of this.tracks) {
        track.rival = 0;
      }
      return;
    }
    challenger.rival += 1;
    if (challenger.rival >= USURP_FRAMES) {
      this.primary = challenger;
      challenger.rival = 0;
    }
  }
}
