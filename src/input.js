const THRESHOLD = 50;
const SETTLE_MS = 260;
const GESTURE_GAP_MS = 220;
const SWIPE_MIN = 44;
const KEY_STEPS = { ArrowDown: 1, PageDown: 1, ArrowUp: -1, PageUp: -1 };

function pixels(event) {
  if (event.deltaMode === 1) {
    return event.deltaY * 16;
  }
  if (event.deltaMode === 2) {
    return event.deltaY * window.innerHeight;
  }
  return event.deltaY;
}

export function listen({ onStep, onEscape, isBusy }) {
  let sum = 0;
  let last = 0;
  let quietUntil = 0;
  let touch = null;

  window.addEventListener("wheel", (event) => {
    event.preventDefault();
    const now = performance.now();
    const gap = now - last;
    last = now;
    if (isBusy() || now < quietUntil) {
      quietUntil = now + SETTLE_MS;
      sum = 0;
      return;
    }
    if (gap > GESTURE_GAP_MS) {
      sum = 0;
    }
    sum += pixels(event);
    if (Math.abs(sum) < THRESHOLD) {
      return;
    }
    const direction = Math.sign(sum);
    sum = 0;
    quietUntil = now + SETTLE_MS;
    onStep(direction);
  }, { passive: false });

  window.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "Escape") {
      onEscape();
      return;
    }
    const onControl = event.target instanceof Element && event.target.closest("button, a");
    if (event.key === " " && !onControl) {
      event.preventDefault();
      onStep(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key in KEY_STEPS) {
      event.preventDefault();
      onStep(KEY_STEPS[event.key]);
    }
  });

  window.addEventListener("touchstart", (event) => {
    const point = event.touches[0];
    touch = { x: point.clientX, y: point.clientY };
  }, { passive: true });

  window.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });

  window.addEventListener("touchend", (event) => {
    if (!touch) {
      return;
    }
    const point = event.changedTouches[0];
    const dx = touch.x - point.clientX;
    const dy = touch.y - point.clientY;
    touch = null;
    if (Math.abs(dy) >= SWIPE_MIN && Math.abs(dy) > Math.abs(dx)) {
      onStep(Math.sign(dy));
    }
  }, { passive: true });
}
