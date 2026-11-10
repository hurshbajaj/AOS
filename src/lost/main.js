
import { Sky } from "../profile/sky.js";

new Sky(document.querySelector("[data-sky]")).start();

const where = document.querySelector("[data-where]");
const asked = `${window.location.pathname}${window.location.search}`;
if (where && asked && !/^\/404(\.html)?$/.test(asked)) {
  where.textContent = asked.length > 64 ? `${asked.slice(0, 63)}…` : asked;
}
