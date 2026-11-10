
export class OneEuro {
  #value = null;
  #derivative = 0;

  constructor({ minCutoff = 1.5, beta = 2, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  static #alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, dt) {
    if (this.#value === null || !(dt > 0) || !Number.isFinite(value)) {
      if (Number.isFinite(value)) {
        this.#value = value;
      }
      return this.#value ?? value;
    }
    const rate = (value - this.#value) / dt;
    const dAlpha = OneEuro.#alpha(this.dCutoff, dt);
    this.#derivative += dAlpha * (rate - this.#derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.#derivative);
    const alpha = OneEuro.#alpha(cutoff, dt);
    this.#value += alpha * (value - this.#value);
    return this.#value;
  }

  get value() {
    return this.#value;
  }

  reset(value = null) {
    this.#value = value;
    this.#derivative = 0;
  }
}

export function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

export const approach = (from, to, dt, tau) => from + (to - from) * (1 - Math.exp(-dt / tau));

export const smoothstep = (value, low, high) => {
  if (high === low) {
    return value >= high ? 1 : 0;
  }
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
};

export function normalise(x, y, floor = 1e-6) {
  const length = Math.hypot(x, y);
  return length > floor ? { x: x / length, y: y / length } : null;
}
