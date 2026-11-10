
import { HandTracks } from "../src/orbital/tracking.js";
import { GestureReader } from "../src/orbital/gestures.js";

export const FPS = 30;
export const DT = 1 / FPS;
export const JITTER = 0.0035;

export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(random) {
  const u = Math.max(random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const KNUCKLE = {
  index: { base: 5, x: -0.33, y: -0.45, length: 1 },
  middle: { base: 9, x: -0.11, y: -0.5, length: 1.08 },
  ring: { base: 13, x: 0.11, y: -0.48, length: 1 },
  pinky: { base: 17, x: 0.33, y: -0.4, length: 0.8 },
};
const WRIST_Y = 0.55;
const THUMB_CMC = { x: -0.48, y: 0.28 };
const THUMB_MCP = { x: -0.68, y: 0.02 };
const THUMB_LENGTH = 0.78;

const MEASURED = (() => {
  const bones = Object.values(KNUCKLE).map((k) => Math.hypot(k.x, WRIST_Y - k.y));
  bones.sort((a, b) => a - b);
  return (bones[1] + bones[2]) / 2;
})();

const radians = (degrees) => (degrees * Math.PI) / 180;

export function hand({ x = 0.5, y = 0.5, scale = 0.12, digits = {}, rotate = 0, noise = 0, random = null } = {}) {
  const s = scale / MEASURED;
  const points = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  const at = (dx, dy) => ({ x: x + dx * s, y: y + dy * s, z: 0 });

  points[0] = at(0, WRIST_Y);

  for (const [name, knuckle] of Object.entries(KNUCKLE)) {
    const angle = digits[name];
    const base = knuckle.base;
    points[base] = at(knuckle.x, knuckle.y);
    if (angle === null || angle === undefined) {
      points[base + 1] = at(knuckle.x, knuckle.y - 0.46);
      points[base + 2] = at(knuckle.x + 0.06, knuckle.y - 0.28);
      points[base + 3] = at(knuckle.x + 0.04, knuckle.y + 0.14);
    } else {
      const dx = Math.cos(radians(angle)) * knuckle.length;
      const dy = Math.sin(radians(angle)) * knuckle.length;
      points[base + 1] = at(knuckle.x + dx * 0.42, knuckle.y + dy * 0.42);
      points[base + 2] = at(knuckle.x + dx * 0.73, knuckle.y + dy * 0.73);
      points[base + 3] = at(knuckle.x + dx, knuckle.y + dy);
    }
  }

  points[1] = at(THUMB_CMC.x, THUMB_CMC.y);
  points[2] = at(THUMB_MCP.x, THUMB_MCP.y);
  const thumb = digits.thumb;
  if (thumb === null || thumb === undefined) {
    points[3] = at(THUMB_MCP.x + 0.33, THUMB_MCP.y - 0.1);
    points[4] = at(THUMB_MCP.x + 0.35, THUMB_MCP.y + 0.08);
  } else {
    const dx = Math.cos(radians(thumb)) * THUMB_LENGTH;
    const dy = Math.sin(radians(thumb)) * THUMB_LENGTH;
    points[3] = at(THUMB_MCP.x + dx * 0.45, THUMB_MCP.y + dy * 0.45);
    points[4] = at(THUMB_MCP.x + dx, THUMB_MCP.y + dy);
  }

  if (rotate) {
    const cos = Math.cos(radians(rotate));
    const sin = Math.sin(radians(rotate));
    for (const point of points) {
      const dx = point.x - x;
      const dy = point.y - y;
      point.x = x + dx * cos - dy * sin;
      point.y = y + dx * sin + dy * cos;
    }
  }

  if (noise && random) {
    for (const point of points) {
      point.x += gaussian(random) * noise;
      point.y += gaussian(random) * noise;
    }
  }
  return points;
}

export const POSTURES = {
  open: (up = -90) => ({ index: up, middle: up, ring: up, pinky: up, thumb: up - 55 }),
  fist: () => ({}),
  point: (up = -90) => ({ index: up }),
  thumb: (up = -90) => ({ thumb: up }),
  both: (a = -135, b = -45) => ({ thumb: a, index: b }),
};

export const detection = (landmarks, { handedness = "Right", gestures = [] } = {}) => ({
  landmarks,
  handedness,
  gestures,
});

export class Rig {
  total = { dx: 0, dy: 0, scale: 1 };

  constructor({ seed = 1, noise = JITTER, spend = true } = {}) {
    this.tracks = new HandTracks();
    this.reader = new GestureReader();
    this.random = mulberry32(seed);
    this.noise = noise;
    this.spend = spend;
    this.time = 1000;
  }

  frame(hands) {
    const detections = (Array.isArray(hands) ? hands : [hands]).filter(Boolean).map((options) =>
      options.landmarks
        ? options
        : detection(hand({ ...options, noise: this.noise, random: this.random }), options),
    );
    const list = this.tracks.update(detections, this.time);
    const status = this.reader.read(this.tracks.primary, list.length, this.time);
    if (this.spend) {
      for (let i = 0; i < 2; i += 1) {
        const out = this.reader.sample(1 / 60);
        this.total.dx += out.dx;
        this.total.dy += out.dy;
        this.total.scale *= out.scale;
      }
    }
    this.time += DT * 1000;
    return status;
  }

  hold(digits, frames = 20, options = {}) {
    for (let i = 0; i < frames; i += 1) {
      this.status = this.frame({ ...options, digits });
    }
    return this;
  }

  coast(frames = 60) {
    for (let i = 0; i < frames; i += 1) {
      const out = this.reader.sample(1 / 60);
      this.total.dx += out.dx;
      this.total.dy += out.dy;
      this.total.scale *= out.scale;
    }
    return this;
  }
}
