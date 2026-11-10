import scene from "./data/scene.js";
import { Director } from "./director.js";
import { listen } from "./input.js";
import { MediaLibrary, videoFormat } from "./media.js";
import { Stage } from "./stage.js";
import { Hotspots } from "./ui/hotspots.js";
import { Loader } from "./ui/loader.js";
import { Navigation } from "./ui/navigation.js";
import { closeAperture } from "./aperture.js";
import { ambient, markHandoff } from "./ambient.js";
import { beacon } from "./beacon.js";
import { UpdatePanel } from "./updates.js";
import { mark, tooltip, whoami } from "./session.js";
import { ROUTES } from "./routes.js";

const $ = (selector) => document.querySelector(selector);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const holds = scene.holds;

ambient({ mount: document.querySelector("[data-ambient-mount]") });
beacon(document.querySelector("[data-wordmark]"));

whoami().then((status) => {
  const user = mark(document.body, status);
  tooltip(document.querySelector("[data-wordmark]"), user?.org || null);
});

async function start() {
  const returnTo = sessionStorage.getItem("aos:return");
  sessionStorage.removeItem("aos:return");
  const startIndex = Math.max(holds.findIndex((hold) => hold.id === returnTo), 0);

  const loader = new Loader($("[data-loader]"), "Loading the deck");
  const media = new MediaLibrary({
    root: "media",
    holds: holds.map(({ id }) => id),
    loops: holds.filter(({ loop }) => loop).map(({ id }) => id),
    format: videoFormat(),
  });
  try {
    await media.load((value) => loader.progress(value));
  } catch (error) {
    loader.fail(`${error.message}. Render and encode the deck, then reload.`);
    return;
  }

  const stage = new Stage($("[data-stage]"), media, { fps: scene.fps });
  await stage.show(holds[startIndex].id);

  const director = new Director({ holds, stage, reducedMotion });
  director.index = startIndex;
  const hint = $("[data-hint]");
  new UpdatePanel($("[data-updates]"));

  const stops = [
    ...holds.map((hold, index) => ({ title: hold.title, go: () => director.goTo(index), index })),
    { title: "Profile", go: () => enter("profile") },
    { title: "Core", go: () => enter("core") },
    { title: "Orbital", go: () => enter("orbital") },
  ];
  const navigation = new Navigation($("[data-rail]"), stops);
  const hotspots = new Hotspots($("[data-hotspots]"), {
    labelFor: (spot) => spot.label,
    onSelect: (spot) => {
      if (spot.enters) {
        const layer = $("[data-hotspots]").getBoundingClientRect();
        enter(spot.enters, {
          x: layer.left + (spot.x / 100) * layer.width,
          y: layer.top + (spot.y / 100) * layer.height,
        });
      } else if (spot.goes) {
        director.goTo(director.indexOf(spot.goes));
      }
    },
  });

  async function enter(page, origin) {
    hotspots.hide();
    sessionStorage.setItem("aos:return", director.hold.id);
    markHandoff();
    sessionStorage.setItem(`${page}:enter`, JSON.stringify(origin ?? null));
    await closeAperture(origin);
    window.location.href = ROUTES[page];
  }

  function arrive(hold) {
    document.body.classList.remove("is-moving");
    document.body.dataset.hold = hold.id;
    navigation.update(director.index);
    hotspots.render(hold);
    hotspots.show();
    hint.classList.toggle("is-hidden", director.index > 0);
  }

  $("[data-wordmark]").addEventListener("click", () => director.goTo(0));

  stage.onAmbientFrame = (frame) => hotspots.follow(frame);
  director.addEventListener("leave", () => {
    document.body.classList.add("is-moving");
    hotspots.hide();
    hint.classList.add("is-hidden");
  });
  director.addEventListener("pass", ({ detail }) => navigation.update(detail.index));
  director.addEventListener("arrive", ({ detail }) => arrive(detail.hold));

  listen({
    onStep: (direction) => director.step(direction),
    onEscape: () => undefined,
    isBusy: () => director.busy,
  });

  arrive(holds[startIndex]);
  loader.done();
  director.wake();
}

start();
