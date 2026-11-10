export class Navigation {
  constructor(rail, stops) {
    this.stops = stops.map((stop) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rail__stop";
      button.classList.toggle("is-pending", Boolean(stop.pending));
      button.innerHTML = '<span class="rail__label"></span><span class="rail__tick" aria-hidden="true"></span>';
      button.querySelector(".rail__label").textContent = stop.title;
      if (stop.go) {
        button.addEventListener("click", stop.go);
      } else {
        button.disabled = true;
      }
      item.append(button);
      return { button, item, index: stop.index };
    });
    rail.replaceChildren(...this.stops.map(({ item }) => item));
  }

  update(current) {
    for (const { button, index } of this.stops) {
      if (index === current) {
        button.setAttribute("aria-current", "step");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }
}
