
const ENDPOINT = "/api/documents";

const ask = async (path, options) => {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? body.errors?.name ?? body.errors?.body ?? `Server said ${response.status}`);
  }
  return body;
};

const post = (path, body) =>
  ask(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const list = () => ask(ENDPOINT).then((body) => body.documents);
export const fetchOne = (id) => ask(`${ENDPOINT}/${id}`).then((body) => body.document);
export const create = (name, text, kind) => post(ENDPOINT, { name, body: text, kind });
export const update = (id, name, text, kind) => post(`${ENDPOINT}/${id}`, { name, body: text, kind });
export const remove = (id) => post(`${ENDPOINT}/${id}/delete`);

export class Library {
  #index = [];
  #bodies = new Map();

  get documents() {
    return this.#index;
  }

  async refresh() {
    try {
      this.#index = await list();
      const live = new Set(this.#index.map((row) => row.id));
      for (const [id, held] of this.#bodies) {
        const row = this.#index.find((entry) => entry.id === id);
        if (!live.has(id) || row.updated !== held.updated) {
          this.#bodies.delete(id);
        }
      }
    } catch {
      this.#index = [];
    }
    return this.#index;
  }

  find(which) {
    const key = String(which ?? "").trim().toLowerCase();
    return (
      this.#index.find((row) => row.id.toLowerCase() === key) ??
      this.#index.find((row) => row.name.toLowerCase() === key) ??
      this.#index.find((row) => row.name.toLowerCase().includes(key)) ??
      null
    );
  }

  async body(which) {
    const row = this.find(which);
    if (!row) {
      return null;
    }
    const held = this.#bodies.get(row.id);
    if (held?.updated === row.updated) {
      return held.text;
    }
    const full = await fetchOne(row.id);
    this.#bodies.set(row.id, { text: full.body ?? "", updated: full.updated });
    return full.body ?? "";
  }

  cached(which) {
    const row = this.find(which);
    return row ? this.#bodies.get(row.id)?.text ?? null : null;
  }

  async load() {
    for (const row of this.#index) {
      try {
        await this.body(row.id);
      } catch {
      }
    }
    return this;
  }
}

export const lines = (text) => String(text ?? "").split(/\r?\n/);

export function search(text, query, limit = 12) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const rows = lines(text);
  const hits = [];
  for (let index = 0; index < rows.length && hits.length < limit; index += 1) {
    if (rows[index].toLowerCase().includes(needle)) {
      hits.push({
        line: index + 1,
        text: rows[index].slice(0, 300),
        before: index > 0 ? rows[index - 1].slice(0, 160) : null,
        after: index + 1 < rows.length ? rows[index + 1].slice(0, 160) : null,
      });
    }
  }
  return hits;
}
