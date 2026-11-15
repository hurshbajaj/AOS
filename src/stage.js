const MAX_RATE = 16;
const SETTLE_SECONDS = 0.16;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const once = (target, type) => new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));

function firstFrame(video) {
  return new Promise((resolve) => {
    if ("requestVideoFrameCallback" in video) {
      video.requestVideoFrameCallback(() => resolve());
      return;
    }
    video.addEventListener("playing", () => requestAnimationFrame(() => resolve()), { once: true });
  });
}

function setRate(video, rate) {
  try {
    video.playbackRate = rate;
  } catch {
    video.playbackRate = Math.min(rate, 4);
  }
}

export class Stage {
  #ambientRun = 0;

  constructor(root, media, { fps }) {
    this.still = root.querySelector("[data-still]");
    this.ambient = root.querySelector("[data-ambient]");
    this.clip = root.querySelector("[data-clip]");
    this.media = media;
    this.fps = fps;
    this.onAmbientFrame = null;
  }

  get ambientLive() {
    return this.ambient.classList.contains("is-live");
  }

  async show(id) {
    const src = this.media.still(id);
    if (this.still.getAttribute("src") === src) {
      return;
    }
    this.still.src = src;
    await this.still.decode().catch(() => undefined);
  }

  async startAmbient(id) {
    const src = this.media.loop(id);
    if (!src) {
      return;
    }
    const run = ++this.#ambientRun;
    const ambient = this.ambient;
    ambient.loop = true;
    if (ambient.getAttribute("src") !== src) {
      const loaded = once(ambient, "loadeddata");
      ambient.src = src;
      await loaded;
    } else {
      ambient.currentTime = 0;
    }
    ambient.defaultPlaybackRate = 1;
    setRate(ambient, 1);
    const presented = firstFrame(ambient);
    try {
      await ambient.play();
    } catch {
      return;
    }
    await presented;
    if (run !== this.#ambientRun) {
      return;
    }
    ambient.classList.add("is-live");
    this.#follow(run);
  }

  settleAmbient() {
    const ambient = this.ambient;
    if (!this.ambientLive || ambient.ended) {
      return Promise.resolve();
    }
    ambient.loop = false;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        done = true;
        resolve();
      };
      ambient.addEventListener("ended", finish, { once: true });
      const steer = () => {
        if (done) {
          return;
        }
        const remaining = ambient.duration - ambient.currentTime;
        const rate = Math.min(Math.max(remaining / SETTLE_SECONDS, 1), MAX_RATE);
        if (Math.abs(ambient.playbackRate - rate) > 0.25) {
          setRate(ambient, rate);
        }
        requestAnimationFrame(steer);
      };
      steer();
      setTimeout(finish, (ambient.duration - ambient.currentTime) * 1000 + 1500);
    });
  }

  stopAmbient() {
    this.#ambientRun += 1;
    this.ambient.pause();
    this.ambient.classList.remove("is-live");
  }

  async travel(from, to, { rate = 1, before = null } = {}) {
    const src = this.media.clip(from, to);
    const clip = this.clip;
    if (src) {
      clip.classList.remove("is-live", "is-leaving");
      const loaded = once(clip, "loadeddata");
      clip.src = src;
      await loaded;
    }
    if (before) {
      await before();
    }
    if (!src) {
      this.stopAmbient();
      await this.fade(to);
      return;
    }
    clip.defaultPlaybackRate = rate;
    setRate(clip, rate);
    const presented = firstFrame(clip);
    try {
      await clip.play();
    } catch {
      this.stopAmbient();
      await this.fade(to);
      return;
    }
    await presented;
    clip.classList.add("is-live");
    this.stopAmbient();
    await Promise.race([once(clip, "ended"), wait((clip.duration / rate) * 1000 + 2500)]);
    await this.show(to);
    clip.classList.add("is-leaving");
    await wait(170);
    clip.classList.remove("is-live", "is-leaving");
  }

  async fade(to) {
    this.still.classList.add("is-dimmed");
    await wait(420);
    await this.show(to);
    this.still.classList.remove("is-dimmed");
    await wait(420);
  }

  #follow(run) {
    const ambient = this.ambient;
    const last = Math.max(Math.round(ambient.duration * this.fps) - 1, 0);
    const report = (time) => this.onAmbientFrame?.(Math.min(Math.floor(time * this.fps + 0.01), last));
    if ("requestVideoFrameCallback" in ambient) {
      const tick = (_now, meta) => {
        if (run !== this.#ambientRun) {
          return;
        }
        report(meta.mediaTime);
        ambient.requestVideoFrameCallback(tick);
      };
      ambient.requestVideoFrameCallback(tick);
      return;
    }
    const poll = () => {
      if (run !== this.#ambientRun) {
        return;
      }
      report(ambient.currentTime);
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }
}
