const CELL = 26;
const DURATION = 620;

function shuffledCells(cols, rows) {
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      cells.push([x, y]);
    }
  }
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells;
}

function buildCanvas(dpr) {
  const canvas = document.createElement("canvas");
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.zIndex = "500";
  canvas.style.pointerEvents = "none";
  canvas.width = Math.ceil(window.innerWidth * dpr);
  canvas.height = Math.ceil(window.innerHeight * dpr);
  document.body.appendChild(canvas);
  return canvas;
}

export function coverWithPixels({ cell = CELL, duration = DURATION, color = "#000000" } = {}) {
  return new Promise((resolve) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = buildCanvas(dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = color;
    const cols = Math.ceil(window.innerWidth / cell);
    const rows = Math.ceil(window.innerHeight / cell);
    const cells = shuffledCells(cols, rows);
    const start = performance.now();
    let drawn = 0;
    const step = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const target = Math.floor(t * cells.length);
      for (; drawn < target; drawn++) {
        const [x, y] = cells[drawn];
        ctx.fillRect(x * cell, y * cell, cell + 1, cell + 1);
      }
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve(canvas);
      }
    };
    requestAnimationFrame(step);
  });
}

export function revealFromPixels({ cell = CELL, duration = DURATION, color = "#000000" } = {}) {
  return new Promise((resolve) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = buildCanvas(dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    const cols = Math.ceil(window.innerWidth / cell);
    const rows = Math.ceil(window.innerHeight / cell);
    const cells = shuffledCells(cols, rows);
    const start = performance.now();
    let cleared = 0;
    const step = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const target = Math.floor(t * cells.length);
      for (; cleared < target; cleared++) {
        const [x, y] = cells[cleared];
        ctx.clearRect(x * cell - 1, y * cell - 1, cell + 2, cell + 2);
      }
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        canvas.remove();
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}
