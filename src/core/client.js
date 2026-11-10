
const ask = async (path, options) => {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const first = body.errors ? Object.values(body.errors)[0] : null;
    const error = new Error(first ?? body.error ?? `Server said ${response.status}`);
    error.fields = body.errors ?? null;
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
};

const post = (path, body) =>
  ask(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

const of = (instance) => `/api/instances/${instance}`;

export const consoles = () => ask("/api/instances").then((body) => body.instances);
export const makeConsole = (name, note) => post("/api/instances", { name, note });
export const renameConsole = (id, name, note) => post(`${of(id)}`, { name, note });
export const dropConsole = (id) => post(`${of(id)}/delete`);

export const scripts = (instance) => ask(`${of(instance)}/scripts`);

export const script = (instance, id) =>
  ask(`${of(instance)}/scripts/${id}`).then((body) => body.script);

export const upload = (instance, { name, source, manifest = "" }) =>
  post(`${of(instance)}/scripts`, { name, source, manifest });

export const save = (instance, id, { name, source, manifest = "" }) =>
  post(`${of(instance)}/scripts/${id}`, { name, source, manifest });

export const enable = (instance, id, on) => post(`${of(instance)}/scripts/${id}`, { enabled: on });

export const reorder = (instance, order) => post(`${of(instance)}/scripts`, { order });

export const remove = (instance, id) => post(`${of(instance)}/scripts/${id}/delete`);

export const build = (instance) => post(`${of(instance)}/build`);

export const bundleUrl = (instance) => `${of(instance)}/bundle`;
