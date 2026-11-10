export class Loader {
  constructor(root, label = "Loading") {
    this.root = root;
    this.label = label;
    this.fill = root.querySelector("[data-loader-fill]");
    this.status = root.querySelector("[data-loader-status]");
  }

  progress(value) {
    const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
    this.fill.style.transform = `scaleX(${percent / 100})`;
    this.root.setAttribute("aria-valuenow", String(percent));
    this.status.textContent = `${this.label} ${percent}%`;
  }

  done() {
    this.root.classList.add("is-done");
  }

  fail(message) {
    this.root.classList.add("is-failed");
    this.status.textContent = message;
  }
}
