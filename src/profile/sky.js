
const STARS = 2600;
const DRIFT = 0.0045;
const METEORS = { gap: [2600, 9000], life: 1100, length: [90, 260], speed: [0.5, 0.95] };

const rand = (low, high) => low + Math.random() * (high - low);

export class Sky {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.stars = [];
    this.meteors = [];
    this.next = rand(600, 2000);
    this.last = 0;
    this.offset = 0;
    this.still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.#size();
    window.addEventListener("resize", () => this.#size(), { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !this.still) {
        this.last = performance.now();
      }
    });
  }

  #size() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { clientWidth: width, clientHeight: height } = this.canvas;
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.width = width;
    this.height = height;

    this.stars = Array.from({ length: STARS }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: rand(0.25, 1.15),
      a: rand(0.18, 0.85),
      speed: rand(0.0004, 0.0013),
      phase: Math.random() * Math.PI * 2,
    }));
    this.draw(0);
  }

  #spawn() {
    const fromLeft = Math.random() < 0.5;
    const angle = rand(0.35, 0.75) * (fromLeft ? 1 : -1);
    return {
      x: fromLeft ? rand(-80, this.width * 0.6) : rand(this.width * 0.4, this.width + 80),
      y: rand(-60, this.height * 0.55),
      dx: Math.cos(angle) * (fromLeft ? 1 : -1),
      dy: Math.sin(Math.abs(angle)),
      length: rand(...METEORS.length),
      speed: rand(...METEORS.speed),
      age: 0,
    };
  }

  draw(elapsed) {
    const { context: c, width, height } = this;
    c.clearRect(0, 0, width, height);

    for (const star of this.stars) {
      const y = (star.y + this.offset) % (height + 2);
      const twinkle = this.still ? 1 : 0.72 + 0.28 * Math.sin(star.phase + elapsed * star.speed);
      c.globalAlpha = Math.min(1, star.a * twinkle);
      c.beginPath();
      c.arc(star.x, y, star.r, 0, Math.PI * 2);
      c.fillStyle = "#fff";
      c.fill();
    }

    c.globalAlpha = 1;
    c.lineCap = "round";
    for (const streak of this.meteors) {
      const life = streak.age / METEORS.life;
      const travelled = streak.age * streak.speed;
      const hx = streak.x + streak.dx * travelled;
      const hy = streak.y + streak.dy * travelled;
      const tx = hx - streak.dx * streak.length;
      const ty = hy - streak.dy * streak.length;
      const fade = life < 0.12 ? life / 0.12 : 1 - (life - 0.12) / 0.88;
      const gradient = c.createLinearGradient(tx, ty, hx, hy);
      gradient.addColorStop(0, "rgba(255,255,255,0)");
      gradient.addColorStop(1, `rgba(255,255,255,${Math.max(0, fade) * 0.85})`);
      c.strokeStyle = gradient;
      c.lineWidth = 1.4;
      c.beginPath();
      c.moveTo(tx, ty);
      c.lineTo(hx, hy);
      c.stroke();
    }
  }

  start() {
    if (this.still) {
      this.draw(0);
      return;
    }
    this.last = performance.now();
    const step = (now) => {
      requestAnimationFrame(step);
      if (document.hidden) {
        return;
      }
      const delta = Math.min(now - this.last, 50);
      this.last = now;

      this.offset = (this.offset + delta * DRIFT) % (this.height + 2);
      this.next -= delta;
      if (this.next <= 0) {
        this.meteors.push(this.#spawn());
        this.next = rand(...METEORS.gap);
      }
      for (const streak of this.meteors) {
        streak.age += delta;
      }
      this.meteors = this.meteors.filter((streak) => streak.age < METEORS.life);

      this.draw(now);
    };
    requestAnimationFrame(step);
  }
}
