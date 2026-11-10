
const ENDPOINT = "/api/instances";

export const WORKING = "thinking…";

const ask = async (path, options) => {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? body.errors?.name ?? `Server said ${response.status}`);
  }
  return body;
};

const post = (path, body) =>
  ask(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

export const list = () => ask(ENDPOINT).then((body) => body.instances);
export const create = (name, note) => post(ENDPOINT, { name, note });
export const rename = (id, name, note) => post(`${ENDPOINT}/${id}`, { name, note });
export const remove = (id) => post(`${ENDPOINT}/${id}/delete`);
export const store = (id, state) => post(`${ENDPOINT}/${id}`, { state });

const CHAT = { messages: 30, bytes: 8000 };

export function capture(world, operator, chat) {
  return {
    v: 1,
    ...(chat ? { chat: trimChat(chat.transcript()) } : {}),
    ...(operator ? { operator: operator.capture() } : {}),
    hazards: world.hazards
      .filter((hazard) => hazard.origin === "injected")
      .map((hazard) => ({
        kind: hazard.kind,
        label: hazard.label,
        lat: hazard.lat,
        lon: hazard.lon,
        severity: hazard.severity,
        radius: hazard.radius,
        durationMin: hazard.durationMin,
      })),
    filters: {
      constellations: [...world.filters.constellations],
      links: [...world.filters.links],
      orbits: world.filters.orbits,
      stations: world.filters.stations,
      density: world.filters.density,
    },
  };
}

function trimChat(said) {
  const kept = [];
  let bytes = 0;
  for (let at = said.length - 1; at >= 0 && kept.length < CHAT.messages; at -= 1) {
    const entry = said[at];
    const size = (entry.text?.length ?? 0) + (entry.meta?.length ?? 0) + 40;
    if (bytes + size > CHAT.bytes) {
      break;
    }
    bytes += size;
    kept.unshift(entry);
  }
  return kept;
}

export function conversational(said) {
  const out = [];
  let spoken = false;
  for (const entry of said ?? []) {
    if (entry?.who === "you") {
      spoken = true;
      out.push(entry);
      continue;
    }
    if (!spoken || entry?.text === WORKING) {
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function restore(world, state, operator, chat, agent) {
  operator?.restore(state?.operator);
  const said = conversational(state?.chat);
  chat?.replay(said);
  agent?.recall(said);
  for (const hazard of world.hazards.filter((item) => item.origin === "injected")) {
    world.removeHazard(hazard.id);
  }
  for (const spec of state?.hazards ?? []) {
    try {
      world.addHazard({ ...spec, origin: "injected" });
    } catch {
    }
  }
  const filters = state?.filters;
  if (filters) {
    world.setFilter({
      ...(filters.constellations ? { constellations: new Set(filters.constellations) } : {}),
      ...(filters.links ? { links: new Set(filters.links) } : {}),
      ...(typeof filters.orbits === "boolean" ? { orbits: filters.orbits } : {}),
      ...(typeof filters.stations === "boolean" ? { stations: filters.stations } : {}),
      ...(Number.isFinite(filters.density) ? { density: filters.density } : {}),
    });
  }
}

export function saver({ onWrite, onDirty } = {}) {
  let queued = null;
  let busy = false;
  let dirty = null;

  const settle = (id) => {
    if (dirty !== id) {
      dirty = id;
      onDirty?.(id);
    }
  };

  const flush = async () => {
    if (busy || !queued) {
      return;
    }
    const { id, state } = queued;
    queued = null;
    busy = true;
    try {
      await store(id, state);
      if (!queued) {
        settle(null);
      }
      onWrite?.();
    } catch (error) {
      queued = queued ?? { id, state };
      settle(id);
      throw error;
    } finally {
      busy = false;
      if (queued && !busy) {
      }
    }
  };

  return {
    get pending() {
      return dirty;
    },

    touch(id, state) {
      if (!id) {
        return;
      }
      queued = { id, state };
      settle(id);
    },

    save(id, state) {
      if (id) {
        queued = { id, state };
        settle(id);
      }
      return flush();
    },
  };
}
