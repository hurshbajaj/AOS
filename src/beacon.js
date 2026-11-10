
const VIEW_W = 100;
const VIEW_H = 50;
const RX = 44;
const RY = 16;
const CX = 50;
const CY = 25;
const TILT = -24 * (Math.PI / 180);
const PERIOD_MS = 9000;

export function beacon(wordmark) {
  const dot = wordmark?.querySelector("[data-beacon]");
  const ring = wordmark?.querySelector(".wordmark__orbit");
  if (!dot || !ring) {
    return;
  }

  const cos = Math.cos(TILT);
  const sin = Math.sin(TILT);
  let frame = null;
  let front = null;

  function measure() {
    const box = ring.getBoundingClientRect();
    const host = wordmark.getBoundingClientRect();
    if (!box.width || !host.width) {
      return null;
    }
    const scale = Math.min(box.width / VIEW_W, box.height / VIEW_H);
    return {
      left: box.left - host.left + (box.width - VIEW_W * scale) / 2,
      top: box.top - host.top + (box.height - VIEW_H * scale) / 2,
      scale,
    };
  }

  const place = (angle) => {
    frame = frame ?? measure();
    if (!frame) {
      return;
    }
    const dx = RX * Math.cos(angle);
    const dy = RY * Math.sin(angle);
    const x = CX + dx * cos - dy * sin;
    const y = CY + dx * sin + dy * cos;

    dot.style.left = `${frame.left + x * frame.scale}px`;
    dot.style.top = `${frame.top + y * frame.scale}px`;

    const near = y > CY;
    if (near !== front) {
      front = near;
      dot.style.zIndex = near ? "2" : "0";
      dot.classList.toggle("is-front", near);
    }
  };

  window.addEventListener("resize", () => {
    frame = null;
  }, { passive: true });
  document.fonts?.ready.then(() => {
    frame = null;
  });

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    place(Math.PI / 2);
    return;
  }

  const start = performance.now();
  const step = (now) => {
    place((((now - start) % PERIOD_MS) / PERIOD_MS) * Math.PI * 2);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
