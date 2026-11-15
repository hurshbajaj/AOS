const FLIP_AT = 68;

export class Hotspots {
  constructor(layer, { labelFor, onSelect }) {
    this.layer = layer;
    this.labelFor = labelFor;
    this.onSelect = onSelect;
    this.spots = [];
  }

  get shown() {
    return this.layer.classList.contains("is-shown");
  }

  render(hold) {
    this.layerRect = null;
    this.spots = hold.hotspots.map((spot) => {
      const label = this.labelFor(spot);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hotspot";
      button.classList.toggle("is-flipped", spot.x > FLIP_AT);
      button.classList.toggle("is-standing", Boolean(spot.enters || spot.pending) && !spot.bare);
      button.classList.toggle("is-bare", Boolean(spot.bare));
      button.classList.toggle("is-pending", Boolean(spot.pending));
      button.style.setProperty("--x", spot.x);
      button.style.setProperty("--y", spot.y);
      button.setAttribute("aria-label", label);
      button.innerHTML = '<span class="hotspot__ping" aria-hidden="true"></span><span class="hotspot__ring" aria-hidden="true"></span><span class="hotspot__label" aria-hidden="true"></span>';
      button.querySelector(".hotspot__label").textContent = label;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.onSelect(spot);
      });
      return { spot, button, pos: { x: spot.x, y: spot.y } };
    });
    this.layer.replaceChildren(...this.spots.map(({ button }) => button));
  }

  show() {
    this.layer.classList.add("is-shown");
  }

  hide() {
    this.layer.classList.remove("is-shown");
  }

  follow(frame) {
    let moved = false;
    for (const { spot, button, pos } of this.spots) {
      if (!spot.track) {
        continue;
      }
      const [x, y, seen] = spot.track[frame % spot.track.length];
      button.style.setProperty("--x", x);
      button.style.setProperty("--y", y);
      button.classList.toggle("is-flipped", x > FLIP_AT);
      button.classList.toggle("is-occluded", !seen);
      pos.x = x;
      pos.y = y;
      moved = true;
    }
    void moved;
  }

}
