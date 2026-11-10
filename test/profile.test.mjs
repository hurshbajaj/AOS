
import { El, flush, install, textOf } from "./dom-shim.mjs";

install();

const { complain, gate, sheet } = await import("../src/profile/ui.js");

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const find = (node, className) => node.querySelector(`.${className}`);

const hovered = (clock) => {
  clock.dispatch("pointerenter");
  const words = document.body.querySelector(".clock__tip")?.textContent ?? null;
  clock.dispatch("pointerleave");
  flush();
  return words;
};
const all = (node, className) => {
  const out = [];
  const walk = (n) => {
    for (const child of n.children) {
      if (child._cls.has(className)) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
};

{
  let mode = null;
  let sent = null;
  const view = gate({ mode: "in", google: true, onMode: (next) => (mode = next), onSubmit: (values) => (sent = values) });
  ok("the sign-in card builds", Boolean(view.card));
  ok("with two fields and no more", Object.keys(view.fields).join(",") === "email,password");
  ok("a Google button is offered when the server has one", Boolean(find(view.card, "oauth")));
  ok("the password can be revealed", Boolean(find(view.card, "field__reveal")));

  find(view.card, "toggle").children[1].dispatch("click");
  ok("the other tab switches mode", mode === "up");

  view.fields.email.input.value = "mira@example.com";
  view.fields.password.input.value = "a long enough password";
  view.form.dispatch("submit");
  ok("submitting hands back what was typed", sent?.email === "mira@example.com");

  complain(view.fields, { email: "Already taken." });
  ok("a complaint lands on its own field", view.fields.email.error.textContent === "Already taken.");
  ok("and marks the input", view.fields.email.input.classList.contains("is-wrong"));
  ok("while leaving the others alone", view.fields.password.error.hidden === true);
  complain(view.fields, {});
  ok("and clears again", view.fields.email.error.hidden === true && !view.fields.email.input.classList.contains("is-wrong"));

  const up = gate({ mode: "up", google: false, onMode() {}, onSubmit() {} });
  ok("sign-up asks for all six", Object.keys(up.fields).length === 6, Object.keys(up.fields).join(","));
  ok("the two optional ones are folded away", Boolean(find(up.card, "more")));
  ok("and no Google button when the server has none", !find(up.card, "oauth"));

  const more = find(up.card, "more");
  const lid = find(more, "more__head");
  ok("the fold is a button, not a details element", lid.tagName === "BUTTON" && lid.type === "button");
  ok("closed to begin with", !more.classList.contains("is-open") && lid.getAttribute("aria-expanded") === "false");
  lid.dispatch("click");
  ok("and opens on being pressed", more.classList.contains("is-open") && lid.getAttribute("aria-expanded") === "true");

  const notes = up.fields.notes;
  ok("the notes box is one that grows", notes.wrap.classList.contains("field--grow"));
  ok("and shows a dash, not instructions", notes.input.placeholder === "\u2014", notes.input.placeholder);
  ok("it starts the same height as the phone", notes.input.rows === 1 && up.fields.phone.input.tagName === "INPUT");
  ok("the fields inside do not repeat the word optional", !find(more, "field__optional"));
  ok("while a required field would still carry its own labels", Boolean(find(up.fields.email.wrap, "field__label")));
  notes.input.dispatch("focus");
  ok("writing in it stretches it", notes.wrap.classList.contains("is-writing"));
  notes.input.dispatch("blur");
  ok("and it settles back afterwards", !notes.wrap.classList.contains("is-writing"));
  const stack = find(up.card, "gate__stack");
  ok("opening the panel folds the fields above away", stack.classList.contains("is-expanded"));
  ok("email and password are what folds", Boolean(find(find(up.card, "gate__main"), "field__input")));
  ok("while the name row stays outside it", !find(find(up.card, "gate__main"), "form__pair"));
  ok("and is still on the card", Boolean(find(up.card, "form__pair")));
  ok("and pins the height the exchange happens in", /px$/.test(stack.style.height ?? ""), String(stack.style.height));
  const inner = find(up.card, "more__body");
  notes.input.dispatch("focus");
  ok("and writing the notes folds the phone away inside it", inner.classList.contains("is-writing"));
  const phoneFold = find(up.card, "more__first");
  ok("the phone is folded by its height", phoneFold.style.height === "0px", String(phoneFold.style.height));
  ok("with the gap under it inside the clip", phoneFold.children.length === 1 && phoneFold.children[0] === up.fields.phone.wrap);
  ok("the box is told its height as a length", /px$/.test(notes.input.style.height ?? ""), String(notes.input.style.height));
  notes.input.dispatch("blur");
  ok("which comes back when the notes are done", !inner.classList.contains("is-writing"));
  ok("and the length is given up, so it travels back to one line", !notes.input.style.height, String(notes.input.style.height));
  ok("while the phone travels back to its own", phoneFold.style.height === `${phoneFold.offsetHeight}px`, String(phoneFold.style.height));
  flush();
  ok("and is let go once it is there, so a long number can still grow it", !phoneFold.style.height, String(phoneFold.style.height));

  notes.input.dispatch("focus");
  lid.dispatch("click");
  ok("closing the fold puts the box back too", !more.classList.contains("is-open") && !notes.wrap.classList.contains("is-writing"));
  ok("and unfolds the fields above it", !stack.classList.contains("is-expanded"));
  flush();
  ok("the rows are held for the retraction", stack.classList.contains("is-folding") === false && Boolean(stack.style.height));
  flush();
  ok("letting the height go once it has got there", !stack.style.height, String(stack.style.height));
  ok("and the phone with them", !inner.classList.contains("is-writing"));

  const held = up.card;
  const body = find(up.card, "gate__body");
  up.become("in");
  ok("the resize starts on the click, not after it", /px$/.test(body.style.height ?? ""), String(body.style.height));
  ok("with the old form still there, out of the flow", Boolean(find(body, "gate__layer--ghost")));
  flush();
  ok("and gone once it has faded", !find(body, "gate__layer--ghost"));
  ok("switching mode keeps the same card", up.card === held);
  ok("and the same body to morph inside", find(up.card, "gate__body") === body);
  ok("with the other form in it", Object.keys(up.fields).join(",") === "email,password", Object.keys(up.fields).join(","));
  ok("the tab follows", find(up.card, "toggle").children[0].classList.contains("is-on"));
  ok("and the heading does too", textOf(find(up.card, "gate__head")).some((line) => /Sign in/.test(line)));
  ok("asking for the mode it is already in does nothing", (up.become("in"), up.card === held));
}

const user = {
  id: "usr_1",
  name: "Mira Vance",
  org: "Orbital Ltd",
  email: "mira@example.com",
  phone: "",
  notes: "",
  verified: true,
  joined: "2026-11-05T10:00:00.000Z",
};
const consoles = [
  { id: "cns_1", name: "Pacific flare", note: "GPS drill", state: { hazards: [{ kind: "flare" }] }, updated: "2026-11-05T12:00:00.000Z" },
  { id: "cns_2", name: "Clear sky baseline", note: "", state: { hazards: [] }, updated: "2026-11-04T12:00:00.000Z" },
];

{
  const calls = { saved: null, password: null, opened: null, out: 0 };
  const view = sheet({
    user: { ...user },
    consoles,
    mail: true,
    onSave: (values) => (calls.saved = values),
    onPassword: (values, ui) => (calls.password = { values, ui }),
    onResend() {},
    onLogout: () => (calls.out += 1),
    onOpenConsole: (row) => (calls.opened = row),
  });

  ok("the sheet builds", Boolean(view.card));
  ok("the monogram is the initials", find(view.card, "monogram").textContent === "MV");
  ok("sign out is in the crown", Boolean(find(view.card, "signout")));
  find(view.card, "signout").dispatch("click");
  ok("and works", calls.out === 1);

  ok("the record has four changeable cells", all(view.card, "cell").length === 4, String(all(view.card, "cell").length));
  ok("none of them is an input until you ask", all(view.card, "cell__input").every((i) => i.hidden === true));
  const pens = all(view.card, "cell__pen");
  ok("each has a pen", pens.length === 4, String(pens.length));
  ok("notes gets the full width", Boolean(find(view.card, "cell--wide")));

  const text = textOf(view.card);
  ok("the email is a fact, not a cell", text.includes("mira@example.com") && all(view.card, "fact").length >= 2);
  ok("and so is the joining date", text.some((line) => line.startsWith("Joined ")));
  ok("neither of them has a pen", all(view.card, "fact").every((f) => !f.querySelector(".cell__pen")));
  ok("an empty value reads as a dash", text.includes("—"));
  ok("a second address can be offered", Boolean(find(view.card, "fact--add")));
  const slot = find(view.card, "swap");
  const offer = find(slot, "fact--add");
  const entryForm = find(slot, "fact--form");
  ok("the form is there behind it, not built on demand", Boolean(entryForm));
  ok("with the offer showing", !offer.classList.contains("is-away") && entryForm.classList.contains("is-away"));
  offer.dispatch("click");
  ok("clicking crosses them over", offer.classList.contains("is-away") && !entryForm.classList.contains("is-away"));
  ok("and the field has a rule to sweep", Boolean(find(entryForm, "fact__shell")));
  find(entryForm, "fact__drop").dispatch("click");
  ok("cancelling crosses back", !offer.classList.contains("is-away") && entryForm.classList.contains("is-away"));

  const nameRow = view.fields.name;
  ok("save starts disabled, with nothing changed yet", view.save.disabled === true);
  pens[0].dispatch("click");
  ok("the pen opens the field", nameRow.input.hidden === false && nameRow.text.hidden === true);
  ok("seeded with the current value", nameRow.input.value === "Mira Vance");
  ok("with the value selected", nameRow.input._caret?.[0] === 0 && nameRow.input._caret[1] === "Mira Vance".length);

  nameRow.input.value = "  M. Vance  ";
  nameRow.input.dispatch("keydown", { key: "Enter" });
  ok("Enter commits, trimmed", nameRow.text.textContent === "M. Vance");
  ok("and puts the text back", nameRow.text.hidden === false);
  ok("the field retracts rather than vanishing", nameRow.line.classList.contains("is-closing") && nameRow.input.hidden === false);
  flush();
  ok("and is gone once it has", nameRow.input.hidden === true && !nameRow.line.classList.contains("is-closing"));
  ok("save wakes up once something differs", view.save.disabled === false);

  pens[1].dispatch("click");
  view.fields.org.input.value = "Nonsense Ltd";
  view.fields.org.input.dispatch("keydown", { key: "Escape" });
  view.fields.org.input.dispatch("blur");
  ok("Escape discards", view.fields.org.text.textContent === "Orbital Ltd");
  pens[1].dispatch("click");
  ok("reopening clears the retract", !view.fields.org.line.classList.contains("is-closing"));
  flush();
  ok("and no stale timer closes it", view.fields.org.input.hidden === false);
  view.fields.org.input.dispatch("keydown", { key: "Escape" });
  flush();

  const body = find(view.card, "pane__body");
  const notes = view.fields.notes;
  pens[3].dispatch("click");
  ok("the notes pen opens it", notes.input.hidden === false);
  ok("and the notes are not selected outright", notes.input._caret?.[0] === notes.input.value.length);
  ok("and the pane makes room", body.classList.contains("is-expanded"));
  ok("the short cells fold rather than disappear", all(view.card, "fold").length === 2 && all(view.card, "fold").every((f) => f.parentNode));
  ok("the pane holds its height while it rearranges", body.style.height !== "");
  notes.input.value = "first line";
  notes.input.dispatch("keydown", { key: "Enter", shiftKey: true });
  ok("shift+Enter does not commit", notes.text.textContent !== "first line" && notes.input.hidden === false);
  ok("and the pane stays open", body.classList.contains("is-expanded"));
  notes.input.value = "Shift lead, nights.";
  notes.input.dispatch("keydown", { key: "Enter" });
  ok("plain Enter commits", notes.text.textContent === "Shift lead, nights.");
  ok("and the pane goes back to normal", !body.classList.contains("is-expanded"));
  ok("the height is still held while it folds back", body.style.height !== "");
  ok("and the rows stay stretched while they reopen", body.classList.contains("is-folding"));
  flush();
  ok("the fold-back state is let go once it has", !body.classList.contains("is-folding"));
  ok("and the record travels to the height it now wants", body.style.height !== "");
  flush();
  ok("before giving the height back entirely", body.style.height === "");

  pens[3].dispatch("click");
  notes.input.dispatch("keydown", { key: "Escape" });
  ok("Escape also puts the pane back", !body.classList.contains("is-expanded"));
  ok("and discards", notes.text.textContent === "Shift lead, nights.");
  flush();

  const phone = view.fields.phone;
  pens[2].dispatch("click");
  phone.input.value = "+44 20/7946 abc";
  phone.input.dispatch("input");
  ok("letters never reach the phone field", phone.input.value === "+44 20/7946 ", phone.input.value);
  phone.input.value = "+44 (20) 7946-0958";
  phone.input.dispatch("input");
  ok("while the marks people actually write survive", phone.input.value === "+44 (20) 7946-0958");
  phone.input.dispatch("keydown", { key: "Enter" });
  flush();

  view.save.dispatch("click");
  ok("saving sends the whole record", calls.saved?.name === "M. Vance" && calls.saved?.org === "Orbital Ltd" && calls.saved?.notes === "Shift lead, nights." && calls.saved?.phone === "+44 (20) 7946-0958");
  view.onSaved({ ...user, name: "M. Vance" });
  ok("and the heading follows the name", view.heading.textContent === "M. Vance");
  ok("save goes back to sleep once it matches", view.save.disabled === true);

  const tabs = all(view.card, "tabs__tab");
  ok("there are two tabs", tabs.length === 2 && tabs[0].textContent.startsWith("Profile"));
  ok("profile is the one showing", find(view.card, "pane").hidden === false);
  const stage = find(view.card, "stage");
  tabs[1].dispatch("click");
  ok("the consoles tab switches pane", tabs[1].classList.contains("is-on"));
  ok("the card is given a height to travel to", stage.classList.contains("is-sliding") && stage.style.height !== "");
  flush();
  ok("and gives it back once it has arrived", stage.style.height === "" && !stage.classList.contains("is-sliding"));
  ok("the consoles are listed", all(view.card, "row--go").length === 2);
  ok("with their notes", textOf(view.card).includes("GPS drill"));
  ok("and a hazard count", textOf(view.card).some((line) => line === "1 hazard"));
  ok("singular and plural are right", textOf(view.card).some((line) => line === "0 hazards"));
  all(view.card, "row--go")[0].dispatch("click");
  ok("opening one reports which", calls.opened?.id === "cns_1");
  ok("there is no activity log any more", !textOf(view.card).some((line) => /Asked Sybil/.test(line)));
}

{
  let asked = null;
  const view = sheet({
    user: { ...user },
    consoles: [],
    mail: true,
    onSave() {},
    onPassword: (values, ui) => (asked = { values, ui }),
    onResend() {},
    onLogout() {},
    onOpenConsole() {},
  });

  const body = find(view.card, "pane__body");
  ok("the record is showing to begin with", Boolean(find(body, "cells")));

  const quiet = all(view.card, "button--quiet")[0];
  ok("the button is beside save", Boolean(quiet) && quiet.textContent === "Change password");
  quiet.dispatch("click");
  ok("the section fades before it swaps", body.classList.contains("is-fading"));
  ok("and has not swapped yet", Boolean(find(body, "cells")));
  flush();
  ok("then the password form is there instead", Boolean(find(body, "backlink")));
  ok("and the pane is given a height to shrink to", body.style.height !== "" && body.style.height !== "auto");
  ok("and the heading says what it is now", find(view.card, "pane__title").textContent === "Change password");
  ok("and the record is gone", !find(body, "cells"));
  ok("the rail is untouched by the swap", Boolean(find(view.card, "rail")));
  flush();
  ok("the height is released once the swap settles", body.style.height === "");

  const form = body.children.find((child) => child.tagName === "FORM");
  form.children.find((c) => c._cls.has("form__row"));
  const fields = all(body, "field__input");
  ok("it asks for the current password and a new one", fields.length === 2, String(fields.length));
  fields[0].value = "old one";
  fields[1].value = "a brand new password";
  form.dispatch("submit");
  ok("submitting hands over both", asked?.values.current === "old one" && asked?.values.password === "a brand new password");
  ok("and the controls to report back on", Boolean(asked.ui.fields && asked.ui.notice && asked.ui.button));

  asked.ui.back();
  flush();
  flush();
  ok("and the heading goes back with it", find(view.card, "pane__title").textContent === "Profile");
  ok("going back brings the record", Boolean(find(body, "cells")) && !find(body, "backlink"));
}

{
  const view = sheet({
    user: { ...user, hasPassword: false },
    consoles: [],
    mail: false,
    onSave() {},
    onPassword() {},
    onResend() {},
    onLogout() {},
    onOpenConsole() {},
  });
  const body = find(view.card, "pane__body");
  all(view.card, "button--quiet")[0].dispatch("click");
  flush();
  ok("it is not asked for a password it does not have", all(body, "field__input").length === 1);
}

{
  let resent = 0;
  let confirmed = null;
  const view = sheet({
    onConfirm: (code, kind, ui) => (confirmed = { code, kind, ui }),
    user: { ...user, verified: false },
    consoles: [],
    mail: false,
    pending: { verify: new Date(Date.now() + 5 * 60_000).toISOString() },
    onSave() {},
    onPassword() {},
    onResend: () => (resent += 1),
    onLogout() {},
    onOpenConsole() {},
  });
  ok("an unverified account says so", textOf(view.card).includes("Unverified"));
  const banner = find(view.card, "banner");
  ok("and gets a banner", Boolean(banner));
  ok("which is honest about where the code went", textOf(banner).some((line) => /terminal/.test(line)));
  const again = find(banner, "code__again");
  ok("the resend carries dots, not a changing label", Boolean(find(again, "dots")) && find(again, "dots").children.length === 3);
  ok("with the word to hide while they run", Boolean(find(again, "sends__label")));
  again.dispatch("click");
  ok("and can ask for another", resent === 1);

  const entry = find(banner, "code");
  ok("the code carries a clock", Boolean(find(entry, "clock")));
  const box = find(entry, "code__input");
  ok("there is a code box, not a link to follow", Boolean(box));
  ok("it asks the browser for the one-time code", box.autocomplete === "one-time-code");
  box.value = "12ab34";
  box.dispatch("input");
  ok("letters are stripped as they are typed", box.value === "1234");
  ok("and nothing is submitted on four digits", confirmed === null);
  box.value = "123456";
  box.dispatch("input");
  ok("the sixth digit submits it", confirmed?.code === "123456" && confirmed.kind === "verify");
  ok("with its own controls to report back through", typeof confirmed.ui.busy === "function" && typeof confirmed.ui.wrong === "function");
  ok("and no redundant submit button", !find(entry, "code__go"));
  confirmed.ui.busy(true);
  ok("checking disables the field and shows the spinner", box.disabled === true && find(entry, "code__status").classList.contains("is-busy"));
  confirmed.ui.busy(false);
  confirmed.ui.wrong("That is not the code.");
  ok("a refusal marks the field", box.classList.contains("is-wrong"));
  ok("and says so in the status line", find(entry, "code__word").textContent === "That is not the code.");
  ok("with the text selected, ready to be typed over", box._caret?.[1] === box.value.length);
  box.value = "999";
  box.dispatch("input");
  ok("and typing clears the complaint", !box.classList.contains("is-wrong"));

  confirmed.ui.right();
  ok("the code box reports success", find(entry, "code__status").classList.contains("code__status--good"));
  ok("with a tick to draw", Boolean(find(entry, "code__tick")));
  ok("and the field marked right, not wrong", box.classList.contains("is-right") && !box.classList.contains("is-wrong"));

  view.onEmail({ ...user, verified: true });
  const leaving = find(view.card, "banner");
  ok("the banner collapses rather than vanishing", Boolean(leaving) && leaving.classList.contains("is-going"));
  flush();
  ok("and is gone once it has", !find(view.card, "banner"));
  ok("and the badge flips", textOf(view.card).includes("Verified") && !textOf(view.card).includes("Unverified"));
}

{
  const { inscribe } = await import("../src/profile/ui.js");
  const node = new El("p");
  inscribe(node, "Verification mail sent", "good");
  ok("the message is marked as good news", node.className.includes("form__notice--good"));
  const letters = [];
  const walk = (n) => n.children.forEach((c) => (c._cls.has("ink") ? letters.push(c) : walk(c)));
  walk(node);
  ok("every character is its own stroke", letters.length === "Verification mail sent".length + 1, String(letters.length));
  ok("each a beat behind the one before", letters[0]._style?.["--i"] === "0" && letters[5]._style?.["--i"] === "5");
  ok("whole words stay together, so nothing reflows mid-reveal", node.children.filter((c) => c._cls.has("ink__word")).length === 3);
  inscribe(node, null);
  ok("and an empty message leaves nothing behind", node.hidden === true && node.children.length === 0);
}

{
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  const view = sheet({
    user: { ...user, verified: false },
    consoles: [], mail: true, pending: { verify: soon },
    onSave() {}, onPassword() {}, onResend() {}, onLogout() {}, onOpenConsole() {}, onAddEmail() {}, onDropEmail() {}, onConfirm() {},
  });
  const clock = find(view.card, "clock");
  ok("it starts running when there is a code outstanding", clock.hidden === false);
  const words = hovered(clock);
  ok("and says how long in words on hover", /^\d:\d\d left on this code$/.test(words), String(words));
  ok("which is what it is announced as too", clock.getAttribute("aria-label") === words);
  ok("the face is drawn, not animated as a gauge", Boolean(clock.querySelector(".clock__face")) && !clock.querySelector(".clock__left"));
  ok("not warning yet, with five minutes on it", !clock.classList.contains("is-low") && !clock.classList.contains("is-dead"));

  view.codes.verify.until(new Date(Date.now() + 30_000).toISOString());
  ok("under a minute it warns", clock.classList.contains("is-low"));
  const box = find(view.card, "code__input");
  view.codes.verify.until(new Date(Date.now() - 1).toISOString());
  ok("expired it says so", clock.classList.contains("is-dead"));
  ok("and the tooltip says what to do about it", /send another/.test(hovered(clock)), String(hovered(clock)));
  ok("and the field stops taking a code", box.disabled === true);

  const none = sheet({
    user: { ...user, verified: false },
    consoles: [], mail: true, pending: {},
    onSave() {}, onPassword() {}, onResend() {}, onLogout() {}, onOpenConsole() {}, onAddEmail() {}, onDropEmail() {}, onConfirm() {},
  });
  const stale = find(none.card, "clock");
  ok("a code that has run out still shows its clock", stale.hidden === false);
  ok("reading as expired", stale.classList.contains("is-dead"));
  ok("and saying what to do about it", /send another/.test(hovered(stale)));
  ok("with the field no longer taking a code", find(none.card, "code__input").disabled === true);

  const row = find(view.card, "code");
  const order = [...row.children].map((child) => child.className.split(" ")[0]);
  ok("the row reads input, clock, status, resend", order.join(" ") === "code__input clock code__status fact__go", order.join(" "));
  ok("and the resend wears the same coat as Add", find(row, "code__again").classList.contains("fact__go"));
}

{
  let asked = null;
  const view = sheet({
    user: { ...user, altEmail: "mira@work.example", altVerified: false },
    consoles: [],
    mail: true,
    pending: { alt: new Date(Date.now() + 5 * 60_000).toISOString() },
    onSave() {},
    onPassword() {},
    onResend() {},
    onLogout() {},
    onOpenConsole() {},
    onAddEmail() {},
    onDropEmail() {},
    onConfirm: (code, kind, ui) => (asked = { code, kind, ui }),
  });
  ok("a pending second address is marked", textOf(view.card).includes("Unconfirmed"));
  ok("and gets its own code box", Boolean(find(view.card, "code--inset")));
  const box = find(find(view.card, "code--inset"), "code__input");
  box.value = "654321";
  box.dispatch("input");
  ok("which confirms the second one, not the first", asked?.kind === "alt" && asked.code === "654321");

  const added = sheet({
    user: { ...user, altEmail: "", altVerified: false },
    consoles: [], mail: true, pending: {},
    onSave() {}, onPassword() {}, onResend() {}, onLogout() {}, onOpenConsole() {}, onAddEmail() {}, onDropEmail() {}, onConfirm() {},
  });
  const soon = new Date(Date.now() + 5 * 60_000).toISOString();
  added.onEmail({ ...user, altEmail: "mira@work.example", altVerified: false }, { alt: soon });
  flush();
  const fresh = find(find(added.card, "code--inset"), "clock");
  ok("a freshly added address gets a running clock", fresh.hidden === false);
  ok("set from the code the server just issued", /^\d:\d\d left/.test(hovered(fresh)), String(hovered(fresh)));

  added.onSaved({ ...user, altEmail: "mira@work.example", altVerified: false });
  flush();
  ok("and it survives the pane being redrawn", find(find(added.card, "code--inset"), "clock").hidden === false);

  const done = sheet({
    user: { ...user, altEmail: "mira@work.example", altVerified: true },
    consoles: [], mail: true,
    onSave() {}, onPassword() {}, onResend() {}, onLogout() {}, onOpenConsole() {}, onAddEmail() {}, onDropEmail() {}, onConfirm() {},
  });
  ok("once confirmed it is just an address", !find(done.card, "code") && textOf(done.card).includes("Secondary"));
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
