
import { GestureReader, compass } from "./gestures.js";
import { HandTracks } from "./tracking.js";

const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const TINT = {
  open: "#9dff8f",
  fist: "#ffb067",
  point: "#7fd4ff",
  thumb: "#7fd4ff",
  both: "#c9a6ff",
  warming: "#ffffff",
};

export class HandTracker {
  reader = new GestureReader();
  tracks = new HandTracks();
  active = false;

  #model = null;
  #stream = null;
  #video = null;
  #raf = 0;
  #frameTime = -1;
  #lastStamp = 0;
  #starting = false;
  #hands = [];
  #frames = 0;
  #ticks = 0;
  #fps = 0;
  #lastFrame = 0;
  #watchdog = 0;
  #fault = null;

  constructor({ view, onStatus }) {
    this.view = view;
    this.onStatus = onStatus ?? (() => {});
    this.context = view?.getContext("2d") ?? null;
  }

  async toggle() {
    if (this.active || this.#starting) {
      this.stop();
      return false;
    }
    return this.start();
  }

  async start() {
    if (this.active || this.#starting) {
      return this.active;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.onStatus({ state: "error", text: "Needs https or localhost — serve the folder, don't open the file." });
      return false;
    }

    this.#starting = true;
    this.onStatus({ state: "loading", text: "Loading hand model…" });

    try {
      if (!this.#model) {
        const { FilesetResolver, GestureRecognizer } = await withTimeout(
          import(VISION),
          20000,
          "the library did not download",
        );
        const fileset = await withTimeout(
          FilesetResolver.forVisionTasks(WASM),
          20000,
          "the runtime did not download",
        );
        const options = (delegate) => ({
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.4,
          minHandPresenceConfidence: 0.4,
          minTrackingConfidence: 0.4,
        });
        try {
          this.#model = await withTimeout(
            GestureRecognizer.createFromOptions(fileset, options("GPU")),
            25000,
            "the model did not initialise on the GPU",
          );
        } catch (error) {
          console.warn("[aos] GPU delegate unavailable, falling back to CPU", error);
          this.onStatus({ state: "loading", text: "GPU unavailable — loading on CPU…" });
          this.#model = await withTimeout(
            GestureRecognizer.createFromOptions(fileset, options("CPU")),
            30000,
            "the model did not initialise on the CPU either",
          );
        }
      }
    } catch (error) {
      this.#starting = false;
      this.onStatus({ state: "error", text: `Model failed: ${error?.message ?? error}` });
      console.error("[aos] hand model failed to load", error);
      return false;
    }

    try {
      this.onStatus({ state: "loading", text: "Waiting for the camera…" });
      this.#stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: "user" },
        audio: false,
      });
    } catch (error) {
      this.#starting = false;
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      this.onStatus({
        state: "error",
        text: denied ? "Camera blocked. Allow it in the address bar." : "No camera available.",
      });
      return false;
    }

    this.#video = document.createElement("video");
    this.#video.srcObject = this.#stream;
    this.#video.muted = true;
    this.#video.playsInline = true;
    Object.assign(this.#video.style, {
      position: "fixed",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
      left: "-10px",
      top: "-10px",
    });
    this.#video.setAttribute("aria-hidden", "true");
    document.body.append(this.#video);

    try {
      await withTimeout(this.#video.play(), 8000, "the camera stream never started");
    } catch (error) {
      this.#starting = false;
      this.stop();
      this.onStatus({ state: "error", text: `Camera did not start: ${error?.message ?? error}` });
      return false;
    }

    this.active = true;
    this.#starting = false;
    this.#frameTime = -1;
    this.#frames = 0;
    this.#ticks = 0;
    this.#fps = 0;
    this.#lastFrame = 0;
    this.#fault = null;
    this.tracks.reset();
    this.reader.reset();
    this.onStatus({ state: "live", text: "Calibrating…" });
    this.#loop();
    return true;
  }

  stop() {
    this.active = false;
    this.#starting = false;
    cancelAnimationFrame(this.#raf);
    clearInterval(this.#watchdog);
    this.#raf = 0;
    this.#watchdog = 0;
    for (const track of this.#stream?.getTracks() ?? []) {
      track.stop();
    }
    this.#stream = null;
    if (this.#video) {
      this.#video.srcObject = null;
      this.#video.remove();
      this.#video = null;
    }
    this.tracks.reset();
    this.reader.reset();
    this.#hands = [];
    this.#clear();
    this.onStatus({ state: "off", text: "Off" });
  }

  #loop() {
    const poll = () => {
      this.#raf = requestAnimationFrame(poll);
      this.#ticks += 1;
      if (this.active && this.#video) {
        this.#guard();
      }
    };
    this.#raf = requestAnimationFrame(poll);

    clearInterval(this.#watchdog);
    let seen = { ticks: 0, frames: 0 };
    this.#watchdog = setInterval(() => {
      if (!this.active || this.#fault) {
        return;
      }
      const ticks = this.#ticks - seen.ticks;
      const frames = this.#frames - seen.frames;
      seen = { ticks: this.#ticks, frames: this.#frames };
      if (!this.#frames) {
        return;
      }
      if (!ticks) {
        this.onStatus({ state: "error", text: "Render loop stopped. Switch it off and on." });
      } else if (!frames) {
        this.onStatus({ state: "error", text: "Camera stopped sending frames." });
      }
    }, 1200);
  }

  #guard() {
    try {
      this.#process();
    } catch (error) {
      if (!this.#fault) {
        this.#fault = error;
        console.error("[aos] motion control fault", error);
        this.onStatus({ state: "error", text: `Tracking fault: ${error?.message ?? error}` });
      }
    }
  }

  #process() {
    if (this.#video.readyState < 2 || !this.#video.videoWidth) {
      return;
    }
    const media = this.#video.currentTime;
    if (media === this.#frameTime) {
      return;
    }
    this.#frameTime = media;

    const stamp = Math.max(Math.round(media * 1000), this.#lastStamp + 1);
    this.#lastStamp = stamp;

    this.#frames += 1;
    if (this.#lastFrame) {
      const interval = stamp - this.#lastFrame;
      this.#fps = this.#fps ? this.#fps * 0.9 + (1000 / Math.max(interval, 1)) * 0.1 : 1000 / Math.max(interval, 1);
    }
    this.#lastFrame = stamp;

    let result = null;
    try {
      result = this.#model.recognizeForVideo(this.#video, stamp);
    } catch (error) {
      if (!this.#fault) {
        this.#fault = error;
        console.error("[aos] recognise failed", error);
        this.onStatus({ state: "error", text: `Model rejected the frame: ${error?.message ?? error}` });
      }
      return;
    }

    const detections = (result?.landmarks ?? []).map((points, index) => ({
      landmarks: points.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })),
      world: result.worldLandmarks?.[index] ?? null,
      handedness: result.handedness?.[index]?.[0]?.categoryName ?? null,
      gestures: result.gestures?.[index] ?? [],
    }));

    const tracks = this.tracks.update(detections, stamp);
    const status = this.reader.read(this.tracks.primary, tracks.length, stamp);
    this.#hands = detections.map((d) => d.landmarks);
    this.#paint(status);
    this.onStatus({ state: "live", text: describe(status), status });
  }

  #clear() {
    if (!this.context) {
      return;
    }
    this.context.clearRect(0, 0, this.view.width, this.view.height);
  }

  #paint(status) {
    const context = this.context;
    if (!context || !this.#video) {
      return;
    }
    const { width, height } = this.view;

    const source = { w: this.#video.videoWidth || 4, h: this.#video.videoHeight || 3 };
    const cover = Math.max(width / source.w, height / source.h);
    const frame = { w: source.w * cover, h: source.h * cover };
    frame.x = (width - frame.w) / 2;
    frame.y = (height - frame.h) / 2;
    const to = (point) => ({ x: frame.x + point.x * frame.w, y: frame.y + point.y * frame.h });

    context.save();
    context.clearRect(0, 0, width, height);
    context.translate(width, 0);
    context.scale(-1, 1);
    context.globalAlpha = 0.72;
    context.drawImage(this.#video, frame.x, frame.y, frame.w, frame.h);
    context.restore();

    const tint = TINT[status.mode] ?? "#ffffff";
    context.lineWidth = 1.5;
    context.strokeStyle = tint;
    context.fillStyle = tint;

    for (const hand of this.#hands) {
      for (const [a, b] of BONES) {
        const from = to(hand[a]);
        const until = to(hand[b]);
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(until.x, until.y);
        context.stroke();
      }
      for (const point of hand) {
        const at = to(point);
        context.beginPath();
        context.arc(at.x, at.y, 2, 0, Math.PI * 2);
        context.fill();
      }
    }

    if (status.direction && this.#hands.length) {
      const hand = this.#hands[0];
      const from = to(hand[0]);
      const reach = Math.min(width, height) * 0.3;
      const tip = { x: from.x + status.direction.x * reach, y: from.y + status.direction.y * reach };
      context.save();
      context.lineWidth = 2;
      context.globalAlpha = 0.55 + 0.45 * status.confidence;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(tip.x, tip.y);
      const head = reach * 0.26;
      for (const sign of [-1, 1]) {
        context.moveTo(tip.x, tip.y);
        context.lineTo(
          tip.x - status.direction.x * head + status.direction.y * head * 0.55 * sign,
          tip.y - status.direction.y * head + status.direction.x * head * 0.55 * sign,
        );
      }
      context.stroke();
      context.restore();
    }

    if (status.zoomRate && Math.abs(status.zoomRate) > 0.05) {
      const inward = status.zoomRate > 0;
      const radius = Math.min(width, height) * (inward ? 0.2 : 0.33);
      context.save();
      context.globalAlpha = Math.min(Math.abs(status.zoomRate), 1) * 0.8;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }

    context.save();
    context.fillStyle = "#ffffff";
    context.globalAlpha = 0.72;
    context.font = '500 10px "AOS Console", ui-monospace, monospace';
    context.textBaseline = "alphabetic";
    context.shadowColor = "rgb(0 0 0 / 0.85)";
    context.shadowBlur = 3;
    context.fillText(`fps: ${Math.round(this.#fps)}  |  hands: ${status.hands}`, 6, height - 6);
    context.restore();
  }
}

function withTimeout(promise, ms, what) {
  let timer = 0;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} (${ms / 1000}s)`)), ms);
    }),
  ]);
}

function describe(status) {
  if (!status.hands) {
    return "No hands in frame";
  }
  const sure = status.confidence > 0.6 ? "" : " ?";
  switch (status.mode) {
    case "warming":
      return "Reading your hand…";
    case "open":
      return `Zooming in${sure}`;
    case "fist":
      return `Zooming out${sure}`;
    case "point":
    case "thumb":
    case "both":
      return `Turning ${status.direction ? compass(status.direction) : "…"}${sure}`;
    default:
      return "Hold a posture — palm, fist, finger or thumb";
  }
}
