
import { FormulaError, dependencies, evaluate, parse } from "./formula.js";

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
export const LIMITS = { facts: 64, models: 32, formula: 400, note: 300, unit: 24 };

export const checkName = (name) => {
  const clean = String(name ?? "").trim().toLowerCase();
  if (!NAME.test(clean)) {
    return { error: "A name is 1 to 48 characters: letters, digits and underscores, starting with a letter." };
  }
  return { name: clean };
};

export class Operator {
  #facts = new Map();
  #models = new Map();
  #quiet = false;

  constructor({ readings = () => undefined, onChange = () => {} } = {}) {
    this.readings = readings;
    this.onChange = onChange;
  }

  get size() {
    return { facts: this.#facts.size, models: this.#models.size };
  }

  setFact({ name, value, unit = "", source = "", note = "" }) {
    const checked = checkName(name);
    if (checked.error) {
      throw new Error(checked.error);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`"${value}" is not a number.`);
    }
    if (this.#models.has(checked.name)) {
      throw new Error(`There is already a model called ${checked.name}. One name, one meaning.`);
    }
    if (!this.#facts.has(checked.name) && this.#facts.size >= LIMITS.facts) {
      throw new Error(`That is more than ${LIMITS.facts} facts. Clear some first.`);
    }
    const entry = {
      name: checked.name,
      value: number,
      unit: String(unit).slice(0, LIMITS.unit),
      source: String(source).slice(0, LIMITS.note),
      note: String(note).slice(0, LIMITS.note),
      at: new Date().toISOString(),
    };
    this.#facts.set(entry.name, entry);
    this.#changed();
    return entry;
  }

  setModel({ name, formula, unit = "", source = "", note = "" }) {
    const checked = checkName(name);
    if (checked.error) {
      throw new Error(checked.error);
    }
    const text = String(formula ?? "").trim();
    if (!text) {
      throw new Error("A model needs a formula.");
    }
    if (text.length > LIMITS.formula) {
      throw new Error(`A formula is at most ${LIMITS.formula} characters.`);
    }
    if (this.#facts.has(checked.name)) {
      throw new Error(`There is already a fact called ${checked.name}. One name, one meaning.`);
    }
    if (!this.#models.has(checked.name) && this.#models.size >= LIMITS.models) {
      throw new Error(`That is more than ${LIMITS.models} models. Clear some first.`);
    }
    const tree = parse(text);
    const entry = {
      name: checked.name,
      formula: text,
      tree,
      needs: dependencies(tree),
      unit: String(unit).slice(0, LIMITS.unit),
      source: String(source).slice(0, LIMITS.note),
      note: String(note).slice(0, LIMITS.note),
      at: new Date().toISOString(),
    };
    this.#models.set(entry.name, entry);
    const missing = entry.needs.filter((need) => !this.has(need) && this.readings(need) === undefined);
    this.#changed();
    return { ...this.describeModel(entry), missing };
  }

  has(name) {
    return this.#facts.has(name) || this.#models.has(name);
  }

  forget(name) {
    const clean = String(name ?? "").trim().toLowerCase();
    const gone = this.#facts.delete(clean) || this.#models.delete(clean);
    if (gone) {
      this.#changed();
    }
    return gone;
  }

  clear() {
    this.#facts.clear();
    this.#models.clear();
  }

  #changed() {
    if (!this.#quiet) {
      this.onChange();
    }
  }

  value(name, seen = []) {
    const clean = String(name ?? "").trim().toLowerCase();
    if (this.#facts.has(clean)) {
      return this.#facts.get(clean).value;
    }
    if (!this.#models.has(clean)) {
      return this.readings(clean);
    }
    if (seen.includes(clean)) {
      throw new FormulaError(`${[...seen, clean].join(" depends on ")} — that is a circle.`);
    }
    const model = this.#models.get(clean);
    return evaluate(model.tree, (need) => {
      const found = this.value(need, [...seen, clean]);
      return found === undefined ? this.readings(need) : found;
    });
  }

  tryValue(name) {
    try {
      const value = this.value(name);
      return value === undefined ? { error: `Nothing is called "${name}".` } : { value };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }

  describeModel(entry) {
    const { tree, ...rest } = entry;
    return rest;
  }

  list() {
    return {
      facts: [...this.#facts.values()],
      models: [...this.#models.values()].map((entry) => ({
        ...this.describeModel(entry),
        ...this.tryValue(entry.name),
      })),
    };
  }

  entry(name) {
    const clean = String(name ?? "").trim().toLowerCase();
    return this.#facts.get(clean) ?? this.#models.get(clean) ?? null;
  }

  capture() {
    return {
      facts: [...this.#facts.values()],
      models: [...this.#models.values()].map((entry) => this.describeModel(entry)),
    };
  }

  restore(state) {
    this.#quiet = true;
    this.clear();
    for (const fact of state?.facts ?? []) {
      try {
        this.setFact(fact);
      } catch {
      }
    }
    for (const model of state?.models ?? []) {
      try {
        this.setModel(model);
      } catch {
      }
    }
    this.#quiet = false;
  }
}

export function prefer(operator, name, modelled, unit = "") {
  const entry = operator?.entry(name);
  if (!entry) {
    return { value: modelled, unit, source: "modelled" };
  }
  const worth = operator.tryValue(name);
  if (worth.error) {
    return { value: modelled, unit, source: "modelled", note: `An operator model for ${name} is broken: ${worth.error}` };
  }
  return {
    value: worth.value,
    unit: entry.unit || unit,
    source: "operator",
    from: entry.source || null,
    modelled,
  };
}
