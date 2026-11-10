
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

const button = (className, label, onClick, { title } = {}) => {
  const node = el("button", className, label);
  node.type = "button";
  if (title) {
    node.title = title;
  }
  node.addEventListener("click", onClick);
  return node;
};

const ago = (at) => {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }
  return `${Math.round(seconds / 3600)}h ago`;
};

const bytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function badge(glyph, tint, { size = 28 } = {}) {
  const node = el("span", "badge");
  node.style.setProperty("--size", `${size}px`);
  if (tint) {
    node.style.setProperty("--tint", tint);
  }
  node.setAttribute("aria-hidden", "true");
  node.append(el("span", "badge__glyph", glyph || "◆"));
  return node;
}

export function renderBoard(root, { entries = [], state = "idle", detail = "" } = {}) {
  root.replaceChildren();
  root.dataset.state = state;

  const head = el("div", "board__head");
  head.append(el("h2", "board__title", "Board"));
  const note = el("p", "board__note");
  if (state === "running") {
    note.textContent = "Running the bundle…";
  } else if (state === "none") {
    note.textContent = detail || "No bundle yet. Build one to see what it posts.";
  } else if (state === "error") {
    note.textContent = detail || "The bundle would not run.";
  } else if (entries.length) {
    note.textContent = `${entries.length} from this console's scripts`;
  } else {
    note.textContent = "Nothing posted";
  }
  head.append(note);
  root.append(head);

  if (state === "running" || state === "none" || state === "error") {
    return;
  }

  if (!entries.length) {
    const quiet = el("div", "board__quiet");
    quiet.append(badge("◇", null, { size: 24 }));
    const words = el("div");
    words.append(
      el("h3", "board__quiet-title", "Nothing has anything to say"),
      el(
        "p",
        "board__quiet-note",
        "The board starts empty and stays empty. Nothing in AOS posts here on its own — a line " +
          "appears when a script calls out.notify, and not before.",
      ),
    );
    quiet.append(words);
    root.append(quiet);
    return;
  }

  const list = el("ol", "board__list");
  const order = { alarm: 0, warning: 1, notice: 2, info: 3, debug: 4 };
  for (const entry of [...entries].sort(
    (a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9) || b.at - a.at,
  )) {
    const row = el("li", `note note--${entry.level}`);
    row.append(badge(entry.glyph ?? "◆", entry.tint, { size: 22 }));
    const body = el("div", "note__body");
    const line = el("div", "note__line");
    line.append(el("span", "note__title", entry.title));
    if (entry.sticky) {
      line.append(el("span", "note__pin", "held"));
    }
    body.append(line);
    body.append(el("p", "note__detail", entry.detail));
    const foot = el("p", "note__foot");
    foot.append(el("span", "note__from", entry.from));
    foot.append(el("span", "note__age", ago(entry.at)));
    if (entry.subject?.id) {
      foot.append(el("span", "note__about", `about ${entry.subject.id}`));
    }
    body.append(foot);
    row.append(body);
    list.append(row);
  }
  root.append(list);
}

export { ago, badge, bytes, button, el };
