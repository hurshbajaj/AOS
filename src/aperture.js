
const DURATION = 760;
const RINGS = 3;

const ease = (t) => 1 - (1 - t) ** 3;

function build() {
  const root = document.createElement("div");
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "500",
    pointerEvents: "none",
    background: "#000",
  });

  const marks = document.createElement("div");
  Object.assign(marks.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  const rings = Array.from({ length: RINGS }, () => {
    const ring = document.createElement("span");
    Object.assign(ring.style, {
      position: "absolute",
      borderRadius: "50%",
      border: "1px solid rgb(255 255 255 / 0.22)",
      transform: "translate(-50%, -50%)",
      pointerEvents: "none",
    });
    marks.append(ring);
    return ring;
  });

  document.body.append(root, marks);
  return { root, marks, rings };
}

function reach(x, y) {
  return Math.max(
    Math.hypot(x, y),
    Math.hypot(window.innerWidth - x, y),
    Math.hypot(x, window.innerHeight - y),
    Math.hypot(window.innerWidth - x, window.innerHeight - y),
  );
}

function run({ from, to, origin, duration = DURATION }) {
  return new Promise((resolve) => {
    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    const span = reach(x, y);
    const { root, marks, rings } = build();
    const started = performance.now();

    const step = (now) => {
      const t = Math.min((now - started) / duration, 1);
      const eased = ease(t);
      const radius = (from + (to - from) * eased) * span;

      root.style.clipPath = `circle(${span * 1.5}px at ${x}px ${y}px)`;
      root.style.maskImage = `radial-gradient(circle ${radius}px at ${x}px ${y}px, transparent 0 99%, #000 100%)`;
      root.style.webkitMaskImage = root.style.maskImage;

      rings.forEach((ring, index) => {
        const offset = radius + index * 26 * (1 - eased * 0.5);
        ring.style.left = `${x}px`;
        ring.style.top = `${y}px`;
        ring.style.width = `${offset * 2}px`;
        ring.style.height = `${offset * 2}px`;
        ring.style.opacity = String((1 - t) * 0.5);
      });

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        marks.remove();
        resolve(root);
      }
    };
    requestAnimationFrame(step);
  });
}

export function closeAperture(origin) {
  return run({ from: 1, to: 0, origin });
}

export async function openAperture(origin) {
  const plate = await run({ from: 0, to: 1, origin });
  plate.remove();
}
