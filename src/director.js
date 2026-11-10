const JUMP_RATE = 1.6;

export class Director extends EventTarget {
  constructor({ holds, stage, reducedMotion }) {
    super();
    this.holds = holds;
    this.stage = stage;
    this.reducedMotion = reducedMotion;
    this.index = 0;
    this.busy = false;
  }

  get hold() {
    return this.holds[this.index];
  }

  indexOf(id) {
    return this.holds.findIndex((hold) => hold.id === id);
  }

  step(direction) {
    return this.goTo(this.index + direction);
  }

  async goTo(target) {
    if (this.busy || target === this.index || target < 0 || target >= this.holds.length) {
      return;
    }
    this.busy = true;
    this.#emit("leave");
    const direction = Math.sign(target - this.index);
    const rate = Math.abs(target - this.index) > 1 ? JUMP_RATE : 1;
    while (this.index !== target) {
      const next = this.holds[this.index + direction];
      if (this.reducedMotion) {
        await this.stage.fade(next.id);
      } else {
        const before = this.hold.loop ? () => this.stage.settleAmbient() : null;
        await this.stage.travel(this.hold.id, next.id, { rate, before });
      }
      this.index += direction;
      this.#emit("pass");
    }
    this.busy = false;
    this.wake();
    this.#emit("arrive");
  }

  wake() {
    if (this.hold.loop && !this.reducedMotion) {
      this.stage.startAmbient(this.hold.id);
    }
  }

  #emit(type) {
    this.dispatchEvent(new CustomEvent(type, { detail: { hold: this.hold, index: this.index } }));
  }
}
