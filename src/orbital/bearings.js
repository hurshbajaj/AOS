
import * as THREE from "https://esm.sh/three@0.169.0";
import { SUN } from "./globe.js";
import { alignedSky } from "./ephemeris.js";

const INSET = 19;
const LABEL = 21;
const REFRESH_MS = 600000;

const BODIES = {
  sun: { label: "SUN", colour: "#ffd24a", size: 1 },
  mercury: { label: "MER", colour: "#c9c3bb", size: 0.62 },
  venus: { label: "VEN", colour: "#ff9a3c", size: 0.84 },
  mars: { label: "MAR", colour: "#ff6b4a", size: 0.72 },
  jupiter: { label: "JUP", colour: "#e8c48a", size: 0.82 },
  saturn: { label: "SAT", colour: "#f0dfa8", size: 0.76 },
  uranus: { label: "URA", colour: "#9fe8e0", size: 0.6 },
  neptune: { label: "NEP", colour: "#7fa6ff", size: 0.6 },
};

const ARROW = "M12 2.4 21 21.2Q12 16.4 3 21.2Z";

export class Bearings {
  #raf = 0;
  #marks = new Map();
  #directions = new Map();
  #timer = 0;

  constructor(host, globe) {
    this.globe = globe;
    this.root = document.createElement("div");
    this.root.className = "bearings";

    for (const [id, body] of Object.entries(BODIES)) {
      const mark = document.createElement("span");
      mark.className = `bearing bearing--${id}`;
      mark.style.setProperty("--tint", body.colour);
      mark.style.setProperty("--size", String(body.size));
      mark.innerHTML = `
        <svg class="bearing__arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="${ARROW}"/></svg>
        <span class="bearing__name"></span>`;
      mark.querySelector(".bearing__name").textContent = body.label;
      mark.setAttribute("role", "img");
      this.root.append(mark);
      this.#marks.set(id, {
        ...body,
        node: mark,
        arrow: mark.querySelector(".bearing__arrow"),
        name: mark.querySelector(".bearing__name"),
      });
    }
    (host ?? document.body).append(this.root);

    this.refresh();
    this.#timer = setInterval(() => this.refresh(), REFRESH_MS);
    this.#tick();
  }

  refresh(date = new Date()) {
    const sky = alignedSky(SUN, date);
    for (const [name, body] of Object.entries(sky)) {
      this.#directions.set(name, new THREE.Vector3(body.scene.x, body.scene.y, body.scene.z).normalize());
      const mark = this.#marks.get(name);
      if (mark) {
        mark.node.setAttribute(
          "aria-label",
          name === "sun" ? "Sun" : `${name[0].toUpperCase() + name.slice(1)}, ${body.distance.toFixed(2)} astronomical units away`,
        );
      }
    }
    this.sky = sky;
  }

  stop() {
    cancelAnimationFrame(this.#raf);
    clearInterval(this.#timer);
    this.root.remove();
  }

  #tick = () => {
    this.#raf = requestAnimationFrame(this.#tick);
    const camera = this.globe?.camera;
    if (!camera) {
      return;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    const facingInverse = camera.quaternion.clone().invert();

    for (const [id, mark] of this.#marks) {
      const direction = this.#directions.get(id);
      if (!direction) {
        continue;
      }
      const view = direction.clone().applyQuaternion(facingInverse);

      let x = view.x;
      let y = -view.y;
      const spread = Math.hypot(x, y);
      if (spread < 1e-6) {
        x = 0;
        y = -1;
      } else {
        x /= spread;
        y /= spread;
      }

      const half = { w: width / 2 - INSET, h: height / 2 - INSET };
      const toSide = Math.abs(x) > 1e-6 ? half.w / Math.abs(x) : Infinity;
      const toCap = Math.abs(y) > 1e-6 ? half.h / Math.abs(y) : Infinity;
      const reach = Math.min(toSide, toCap);

      const node = mark.node;
      node.style.left = `${width / 2 + x * reach}px`;
      node.style.top = `${height / 2 + y * reach}px`;
      mark.arrow.style.transform = `rotate(${(Math.atan2(y, x) * 180) / Math.PI + 90}deg)`;
      mark.name.style.transform = `translate(-50%, -50%) translate(${-x * LABEL}px, ${-y * LABEL}px)`;
    }
  };
}
