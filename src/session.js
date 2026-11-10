
const ENDPOINT = "/api/me";

let cached = null;
let inflight = null;

export function whoami({ fresh = false } = {}) {
  if (!fresh && cached) {
    return Promise.resolve(cached);
  }
  if (!fresh && inflight) {
    return inflight;
  }
  inflight = fetch(ENDPOINT, { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((body) => {
      cached = body ?? { user: null, google: false, mail: false };
      inflight = null;
      return cached;
    });
  return inflight;
}

export const forget = () => {
  cached = null;
};

export function mark(body, status) {
  const user = status?.user ?? null;
  if (user) {
    body.dataset.user = user.verified ? "verified" : "unverified";
    body.dataset.org = user.org ?? "";
  } else {
    delete body.dataset.user;
    delete body.dataset.org;
  }
  return user;
}

export function tooltip(wordmark, text) {
  if (!wordmark) {
    return null;
  }
  let tip = wordmark.querySelector(".wordmark__tip");
  if (!text) {
    tip?.remove();
    return null;
  }
  if (!tip) {
    tip = document.createElement("span");
    tip.className = "wordmark__tip";
    tip.setAttribute("aria-hidden", "true");
    wordmark.append(tip);
  }
  tip.textContent = text;
  return tip;
}

export async function record(kind, summary, detail) {
  const status = await whoami();
  if (!status?.user) {
    return false;
  }
  return fetch("/api/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, summary, detail }),
  })
    .then((response) => response.ok)
    .catch(() => false);
}
