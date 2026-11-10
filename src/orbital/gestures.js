
import { approach, clamp, normalise } from "./filters.js";

const ML_POSTURES = {
  Open_Palm: "open",
  Closed_Fist: "fist",
  Pointing_Up: "point",
  Thumb_Up: "thumb",
};
const ML_WEIGHT = 0.45;
const GEO_WEIGHT = 1;
const POSTURE_MARGIN = 0.1;
const POSTURE_FLOOR = 0.45;
const ENTER_FRAMES = 2;
const LEAVE_FRAMES = 4;
const WARMUP_FRAMES = 3;

const TURN_RATE = 0.3;
const ZOOM_RATE = 0.7;
const RAMP_TAU = 0.16;
const SOFT_FLOOR = 0.45;

const DT_MAX = 0.1;

export function posture(geometry, ml = []) {
  const scores = { open: 0, fist: 0, point: 0, thumb: 0, both: 0 };
  for (const name of Object.keys(scores)) {
    scores[name] = GEO_WEIGHT * (geometry?.[name] ?? 0);
  }
  for (const { categoryName, score } of ml) {
    const mapped = ML_POSTURES[categoryName];
    if (mapped) {
      scores[mapped] += ML_WEIGHT * score;
    }
  }
  return scores;
}

export function pick(scores) {
  let best = "idle";
  let top = 0;
  let second = 0;
  for (const [name, score] of Object.entries(scores)) {
    if (score > top) {
      second = top;
      top = score;
      best = name;
    } else if (score > second) {
      second = score;
    }
  }
  if (top < POSTURE_FLOOR || top - second < POSTURE_MARGIN) {
    return { name: "idle", confidence: 0 };
  }
  return { name: best, confidence: clamp((top - second) / 0.5, 0, 1) };
}

export function aim(name, direction) {
  switch (name) {
    case "point":
      return direction.index ?? null;
    case "thumb":
      return direction.thumb ?? null;
    case "both": {
      if (!direction.index || !direction.thumb) {
        return direction.index ?? direction.thumb ?? null;
      }
      return (
        normalise(direction.index.x + direction.thumb.x, direction.index.y + direction.thumb.y) ?? direction.index
      );
    }
    default:
      return null;
  }
}

export class GestureReader {
  velocity = { x: 0, y: 0 };
  zoomRate = 0;
  mode = "idle";
  hands = 0;
  confidence = 0;
  direction = null;
  digits = null;
  reach = null;
  scores = null;

  #time = 0;
  #mode = "idle";
  #candidate = "idle";
  #agree = 0;
  #track = null;

  read(primary, count, nowMs) {
    const now = nowMs / 1000;
    const dt = this.#time ? clamp(now - this.#time, 1e-4, DT_MAX) : 1 / 30;
    this.#time = now;
    this.hands = count;

    if (!primary || primary.age < WARMUP_FRAMES) {
      this.#settle("idle");
      this.mode = primary ? "warming" : "idle";
      this.confidence = 0;
      this.direction = null;
      this.digits = primary?.feature.straight ?? null;
      this.reach = primary?.feature.reach ?? null;
      this.scores = null;
      primary?.aimAt(null, dt);
      this.#track = primary?.id ?? null;
      this.#coast(dt);
      return this.status();
    }

    if (this.#track !== primary.id) {
      this.#track = primary.id;
      this.#mode = "idle";
      this.#candidate = "idle";
      this.#agree = 0;
    }

    this.scores = posture(primary.feature.geometry, primary.ml);
    this.digits = primary.feature.straight;
    this.reach = primary.feature.reach;
    const chosen = pick(this.scores);
    this.#settle(chosen.name);
    this.mode = this.#mode;
    this.confidence = this.#mode === chosen.name ? chosen.confidence : 0;

    const strength = SOFT_FLOOR + (1 - SOFT_FLOOR) * this.confidence;
    const pointing = aim(this.#mode, primary.feature.direction);
    this.direction = primary.aimAt(pointing, dt);

    const turn = this.direction ? { x: this.direction.x * TURN_RATE * strength, y: this.direction.y * TURN_RATE * strength } : { x: 0, y: 0 };
    const zoom = this.#mode === "open" ? ZOOM_RATE * strength : this.#mode === "fist" ? -ZOOM_RATE * strength : 0;

    this.velocity.x = approach(this.velocity.x, turn.x, dt, RAMP_TAU);
    this.velocity.y = approach(this.velocity.y, turn.y, dt, RAMP_TAU);
    this.zoomRate = approach(this.zoomRate, zoom, dt, RAMP_TAU);
    return this.status();
  }

  sample(dtSeconds) {
    const dt = clamp(dtSeconds, 0, DT_MAX);
    return {
      dx: this.velocity.x * dt,
      dy: this.velocity.y * dt,
      scale: Math.exp(-this.zoomRate * dt),
      mode: this.mode,
      hands: this.hands,
    };
  }

  reset() {
    this.velocity = { x: 0, y: 0 };
    this.zoomRate = 0;
    this.mode = "idle";
    this.hands = 0;
    this.confidence = 0;
    this.direction = null;
    this.digits = null;
    this.reach = null;
    this.scores = null;
    this.#time = 0;
    this.#mode = "idle";
    this.#candidate = "idle";
    this.#agree = 0;
    this.#track = null;
  }

  status() {
    return {
      mode: this.mode,
      hands: this.hands,
      confidence: this.confidence,
      direction: this.direction,
      digits: this.digits,
      reach: this.reach,
      scores: this.scores,
      speed: Math.hypot(this.velocity.x, this.velocity.y),
      zoomRate: this.zoomRate,
    };
  }

  #coast(dt) {
    this.velocity.x = approach(this.velocity.x, 0, dt, RAMP_TAU);
    this.velocity.y = approach(this.velocity.y, 0, dt, RAMP_TAU);
    this.zoomRate = approach(this.zoomRate, 0, dt, RAMP_TAU);
  }

  #settle(next) {
    if (next === this.#mode) {
      this.#candidate = next;
      this.#agree = 0;
      return;
    }
    if (next !== this.#candidate) {
      this.#candidate = next;
      this.#agree = 1;
      return;
    }
    this.#agree += 1;
    const needed = this.#mode === "idle" ? ENTER_FRAMES : LEAVE_FRAMES;
    if (this.#agree >= needed) {
      this.#mode = next;
      this.#agree = 0;
    }
  }
}

const POINTS = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"];

export function compass({ x, y }) {
  const angle = Math.atan2(y, x);
  const index = Math.round((angle / (Math.PI * 2)) * 8 + 8) % 8;
  return POINTS[index];
}
