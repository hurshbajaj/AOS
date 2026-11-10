
const KEY = "aos:ambient:3";
const HANDOFF_KEY = "aos:handoff";
const BASENAME = "assets/audio/idea10";
const FADE_IN_MS = 1400;
const FADE_OUT_MS = 620;
const CROSSFADE_S = 3.2;
const VOLUME = 0.32;

const FORMATS = [
  { ext: "ogg", type: 'audio/ogg; codecs="opus"' },
  { ext: "mp3", type: "audio/mpeg" },
];

function pickFormat() {
  const probe = document.createElement("audio");
  const supported = FORMATS.find(({ type }) => probe.canPlayType(type) === "probably");
  return (supported ?? FORMATS[1]).ext;
}

const read = () => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
};

const write = (state) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
  }
};

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

export function markHandoff() {
  try {
    sessionStorage.setItem(HANDOFF_KEY, "1");
  } catch {
  }
  window.dispatchEvent(new CustomEvent("aos:handoff"));
}

export function ambient({ src, mount } = {}) {
  const saved = read();
  const url = src ?? `${BASENAME}.${pickFormat()}`;

  const voices = [new Audio(url), new Audio(url)];
  for (const voice of voices) {
    voice.loop = false;
    voice.preload = "auto";
    voice.volume = 0;
  }

  let current = 0;
  let handing = false;
  let master = 0;
  const handoff = sessionStorage.getItem(HANDOFF_KEY) === "1";
  sessionStorage.removeItem(HANDOFF_KEY);
  let muted = handoff ? Boolean(saved.muted) : true;
  let available = true;
  let started = false;
  let fade = 0;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ambient";
  button.hidden = true;
  button.innerHTML = '<span class="ambient__bars" aria-hidden="true"><i></i><i></i><i></i></span>';
  mount?.append(button);

  const blocked = () => !muted && !started;

  const label = () => {
    const state = muted ? "Unmute background music" : blocked() ? "Start background music" : "Mute background music";
    button.setAttribute("aria-label", state);
    button.classList.toggle("is-muted", muted);
    button.classList.toggle("is-blocked", blocked());
  };

  const SHAPE = {
    out: (t) => 1 - (1 - t) ** 2,
    in: (t) => t * t,
  };

  function glide(to) {
    cancelAnimationFrame(fade);
    const from = master;
    const down = to < from;
    const span = down ? FADE_OUT_MS : FADE_IN_MS;
    const shape = down ? SHAPE.out : SHAPE.in;
    const begun = performance.now();
    const step = (now) => {
      const t = Math.min((now - begun) / span, 1);
      master = from + (to - from) * shape(t);
      if (t < 1) {
        fade = requestAnimationFrame(step);
      } else {
        master = to;
      }
    };
    fade = requestAnimationFrame(step);
  }

  function tick() {
    requestAnimationFrame(tick);
    const voice = voices[current];
    const other = voices[1 - current];
    if (!Number.isFinite(voice.duration)) {
      return;
    }

    const remaining = voice.duration - voice.currentTime;

    if (!handing && remaining <= CROSSFADE_S) {
      handing = true;
      other.currentTime = 0;
      other.volume = 0;
      other.play().catch(() => undefined);
    }

    if (handing) {
      const t = clamp(1 - remaining / CROSSFADE_S, 0, 1);
      voice.volume = master * (1 - t);
      other.volume = master * t;
      if (remaining <= 0.06 || voice.ended) {
        voice.pause();
        voice.currentTime = 0;
        voice.volume = 0;
        current = 1 - current;
        handing = false;
      }
    } else {
      voice.volume = master;
    }
  }

  async function attempt() {
    if (muted) {
      return;
    }
    const voice = voices[current];
    await voice.play().catch(() => undefined);
    glide(VOLUME);
  }

  const WAKE = ["pointerdown", "keydown", "wheel", "touchstart"];
  const wake = async () => {
    if (muted) {
      return;
    }
    if (!voices[current].paused && started) {
      for (const type of WAKE) {
        window.removeEventListener(type, wake);
      }
      return;
    }
    await voices[current].play().catch(() => undefined);
    glide(VOLUME);
  };
  for (const type of WAKE) {
    window.addEventListener(type, wake, { passive: true });
  }

  for (const voice of voices) {
    voice.addEventListener("playing", () => {
      started = true;
      label();
    });
    voice.addEventListener("pause", label);
  }

  voices[0].addEventListener("error", () => {
    available = false;
    button.hidden = true;
  });

  if (handoff && !muted) {
    voices[0].addEventListener("canplay", () => {
      if (!muted && voices[current].paused) {
        attempt();
      }
    });
  }

  voices[0].addEventListener("loadedmetadata", () => {
    button.hidden = false;
    label();
    if (handoff && typeof saved.time === "number" && Number.isFinite(voices[0].duration)) {
      const elapsed = saved.at ? (Date.now() - saved.at) / 1000 : 0;
      const resume = (saved.time + elapsed) % voices[0].duration;
      voices[0].currentTime = resume > voices[0].duration - CROSSFADE_S - 1 ? 0 : resume;
    }
    attempt();
  }, { once: true });

  button.addEventListener("click", () => {
    if (blocked()) {
      voices[current].play().then(() => glide(VOLUME)).catch(() => undefined);
      label();
      return;
    }
    muted = !muted;
    label();
    if (muted) {
      glide(0);
      setTimeout(() => {
        if (muted) {
          voices.forEach((voice) => voice.pause());
          started = false;
        }
      }, FADE_OUT_MS + 40);
    } else {
      voices[current].play().then(() => {
        started = true;
        glide(VOLUME);
      }).catch(() => undefined);
    }
    checkpoint();
  });

  function checkpoint() {
    if (!available) {
      return;
    }
    write({ time: voices[current].currentTime, muted, at: Date.now() });
  }

  setInterval(checkpoint, 1000);
  window.addEventListener("aos:handoff", checkpoint);
  window.addEventListener("pagehide", checkpoint);
  document.addEventListener("visibilitychange", checkpoint);
  requestAnimationFrame(tick);

  return { voices, button, checkpoint };
}
