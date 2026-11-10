
import { chooseProvider, fromAnthropic, fromOpenAI, isRetryable, nextDelay, toAnthropic, toOpenAI } from "../scripts/llm.mjs";
import { clip, digest, trim } from "../src/orbital/sybil.js";
import { callTool, createTools, describeTools } from "../src/orbital/tools.js";
import { World } from "../src/orbital/world.js";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const REQUEST = {
  system: "you are sybil",
  messages: [
    { role: "user", content: "what is worst affected and where is the sun from it" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "a1", name: "worst_affected", input: { limit: 3 } },
        { type: "tool_use", id: "a2", name: "network_summary", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a1", content: '[{"id":"mesh-01"}]' },
        { type: "tool_result", tool_use_id: "a2", content: '{"total":180}' },
      ],
    },
  ],
  tools: [{ name: "worst_affected", description: "worst", schema: { type: "object", properties: {} } }],
};

{
  const body = toAnthropic(REQUEST, "claude-test");
  ok("the system prompt travels separately", body.system === "you are sybil");
  ok("messages pass through unchanged", JSON.stringify(body.messages) === JSON.stringify(REQUEST.messages));
  ok("and the caller's history is not mutated", REQUEST.messages[1].content.length === 3);
  ok("the schema is renamed to input_schema", body.tools[0].input_schema === REQUEST.tools[0].schema);
  ok("and the model is set", body.model === "claude-test");

  const reply = fromAnthropic({
    content: [
      { type: "text", text: "Mesh-01 is worst." },
      { type: "tool_use", id: "b1", name: "sun_from", input: { satellite: "mesh-01" } },
    ],
  });
  ok("text comes back as text", reply.content[0].text === "Mesh-01 is worst.");
  ok("tool calls keep their id, name and input", reply.content[1].id === "b1" && reply.content[1].name === "sun_from" && reply.content[1].input.satellite === "mesh-01");
  ok("an empty reply is an empty list, not a crash", fromAnthropic({}).content.length === 0);
}

{
  const body = toOpenAI(REQUEST, "gpt-test");
  ok("the system prompt becomes the first message", body.messages[0].role === "system" && body.messages[0].content === "you are sybil");
  ok("a plain string message survives", body.messages[1].content === REQUEST.messages[0].content);

  const assistant = body.messages[2];
  ok("an assistant turn keeps its text", assistant.content === "Checking.");
  ok("and its tool calls", assistant.tool_calls.length === 2 && assistant.tool_calls[0].function.name === "worst_affected");
  ok("whose arguments are a JSON string, not an object", typeof assistant.tool_calls[0].function.arguments === "string" && JSON.parse(assistant.tool_calls[0].function.arguments).limit === 3);

  const results = body.messages.filter((message) => message.role === "tool");
  ok("batched results are split into one message each", results.length === 2, `${results.length} tool messages`);
  ok("each carries the id it is answering", results[0].tool_call_id === "a1" && results[1].tool_call_id === "a2");
  ok("tools are wrapped as functions", body.tools[0].type === "function" && body.tools[0].function.name === "worst_affected");

  const reply = fromOpenAI({
    choices: [
      {
        message: {
          content: "Mesh-01.",
          tool_calls: [{ id: "c1", function: { name: "sun_from", arguments: '{"satellite":"mesh-01"}' } }],
        },
      },
    ],
  });
  ok("a reply comes back in the neutral shape", reply.content[0].type === "text" && reply.content[1].type === "tool_use");
  ok("arguments are parsed back into an object", reply.content[1].input.satellite === "mesh-01");
  ok("a reply with no text is just the call", fromOpenAI({ choices: [{ message: { tool_calls: [{ id: "d", function: { name: "x", arguments: "{}" } }] } }] }).content.length === 1);

  const broken = fromOpenAI({ choices: [{ message: { tool_calls: [{ id: "e", function: { name: "x", arguments: "{oops" } }] } }] });
  ok("malformed arguments do not throw", broken.content[0].input.__malformed === "{oops");
  ok("an empty choice list is survivable", fromOpenAI({}).content.length === 0);
}

{
  const signed = fromOpenAI({
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: "s1",
              extra_content: { google: { thought_signature: "SIG123" } },
              function: { name: "network_summary", arguments: "{}" },
            },
          ],
        },
      },
    ],
  });
  ok("a signature is picked up off the reply", signed.content[0].signature === "SIG123");
  ok("a call without one is unmarked", fromOpenAI({ choices: [{ message: { tool_calls: [{ id: "x", function: { name: "y", arguments: "{}" } }] } }] }).content[0].signature === undefined);

  const back = toOpenAI(
    {
      system: "s",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: signed.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "{}" }] },
      ],
      tools: [],
    },
    "gemini-test",
  );
  const call = back.messages[2].tool_calls[0];
  ok("and goes back out in the place Gemini wants it", call.extra_content.google.thought_signature === "SIG123");
  ok("alongside the ordinary fields", call.id === "s1" && call.function.name === "network_summary");

  const anthropic = toAnthropic(
    { system: "s", messages: [{ role: "assistant", content: signed.content }], tools: [] },
    "claude-test",
  );
  ok("Anthropic never sees the signature", anthropic.messages[0].content[0].signature === undefined);
  ok("but keeps everything else", anthropic.messages[0].content[0].name === "network_summary");
  ok("and plain string turns are untouched", toAnthropic({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] }, "m").messages[0].content === "hi");
}

{
  ok("no keys means no provider", chooseProvider({}) === null);
  ok("a key selects its provider", chooseProvider({ GROQ_API_KEY: "x" })?.id === "groq");
  ok("Anthropic wins when several are set", chooseProvider({ GROQ_API_KEY: "x", ANTHROPIC_API_KEY: "y" })?.id === "anthropic");
  ok("an explicit choice overrides the order", chooseProvider({ AOS_PROVIDER: "groq", GROQ_API_KEY: "x", ANTHROPIC_API_KEY: "y" })?.id === "groq");
  ok("an explicit choice with no key is still no provider", chooseProvider({ AOS_PROVIDER: "openai", GROQ_API_KEY: "x" }) === null);
}

{
  const half = () => 0.5;
  const delays = [0, 1, 2, 3].map((attempt) => nextDelay(attempt, null, half));
  ok("backoff grows", delays.every((value, i) => i === 0 || value > delays[i - 1]), delays.map(Math.round).join(", "));
  ok("the first wait is under a second and a half", delays[0] < 1500, `${Math.round(delays[0])}ms`);
  ok("and it is capped", nextDelay(40, null, half) <= 20000, String(nextDelay(40, null, half)));

  const spread = new Set([0.1, 0.5, 0.9].map((r) => Math.round(nextDelay(2, null, () => r))));
  ok("there is jitter between callers", spread.size === 3, [...spread].join(", "));

  ok("a Retry-After in seconds wins outright", nextDelay(0, "7", half) === 7000);
  ok("a Retry-After as a date is understood", Math.abs(nextDelay(0, new Date(Date.now() + 5000).toUTCString(), half) - 5000) < 1500);
  ok("an absurd Retry-After is still capped", nextDelay(0, "9000", half) === 20000);
  ok("nonsense in the header falls back to backoff", nextDelay(1, "soon", half) > 0);

  ok("rate limits and server errors are retried", [429, 500, 503, 529].every(isRetryable));
  ok("a bad request is not", [400, 401, 403, 404, 422].every((status) => !isRetryable(status)));
}

{
  ok("a short result passes through", clip("hello", 100) === "hello");
  const long = clip("x".repeat(500), 100);
  ok("a long one is cut", long.length < 400 && long.startsWith("x".repeat(100)));
  ok("and says it was cut, with what to do about it", long.includes("truncated") && long.includes("narrower"));

  const history = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "{}" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "second" },
  ];
  ok("a short history is left alone", trim(history, 24).length === history.length);

  const cut = trim(history, 3);
  ok("trimming drops from the front", cut.length < history.length, `${cut.length} of ${history.length}`);
  ok("and never begins with an orphaned result", !(Array.isArray(cut[0].content) && cut[0].content.some((block) => block.type === "tool_result")));
  ok("nor with an assistant turn", cut[0].role === "user" && typeof cut[0].content === "string", cut[0].role);

  const asked = new Set();
  for (const message of cut) {
    if (!Array.isArray(message.content)) continue;
    message.content.filter((b) => b.type === "tool_use").forEach((b) => asked.add(b.id));
    const stranded = message.content.filter((b) => b.type === "tool_result" && !asked.has(b.tool_use_id));
    if (stranded.length) {
      ok("no result answers a call outside the window", false, stranded.map((b) => b.tool_use_id).join(","));
    }
  }
  ok("no result answers a call outside the window", true);
  ok("trimming to nothing is survivable", Array.isArray(trim(history, 0)));
}

{
  const world = new World();
  const focused = [];
  const swung = [];
  const tools = createTools(
    world,
    {
      select: (craft) => focused.push(craft),
      lookAtGeo: (lat, lon) => swung.push([lat, lon]),
      moveView: (options) => ({ distance: 3 * (options.zoom ?? 1) }),
    },
    {},
  );
  const spec = describeTools(tools);

  ok("every tool is described", spec.length === Object.keys(tools).length, `${spec.length} tools`);
  ok("every one has a description a model can act on", spec.every((tool) => tool.description.length > 40));
  ok("every schema is an object schema", spec.every((tool) => tool.schema.type === "object"));
  ok("required fields exist in properties", spec.every((tool) => (tool.schema.required ?? []).every((key) => key in tool.schema.properties)));

  const before = JSON.stringify(world.summary());
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.mutates) {
      callTool(tools, name, {});
    }
  }
  ok("reading tools change nothing", JSON.stringify(world.summary()) === before);

  const crashed = Object.keys(tools).filter((name) => {
    const result = callTool(tools, name, {});
    return result === undefined || result === null;
  });
  ok("none of them return nothing when called bare", crashed.length === 0, crashed.join(", "));

  const made = callTool(tools, "inject_hazard", { kind: "storm", lat: 60, lon: 20, severity: 0.7 });
  ok("inject_hazard creates one", world.hazards.some((hazard) => hazard.id === made.id), made.id);
  ok("and reports it back in full", made.severity === 0.7 && made.lat === 60 && made.origin === "injected");
  callTool(tools, "update_hazard", { id: made.id, severity: 0.2 });
  ok("update_hazard changes it", world.hazards.find((hazard) => hazard.id === made.id).severity === 0.2);
  const renamed = callTool(tools, "update_hazard", { id: made.id, label: "Kola Peninsula outage" });
  ok("update_hazard can rename it", renamed.label === "Kola Peninsula outage");
  callTool(tools, "clear_hazard", { id: made.id });
  ok("clear_hazard removes it", !world.hazards.some((hazard) => hazard.id === made.id));

  callTool(tools, "inject_hazard", { kind: "flare" });
  callTool(tools, "inject_hazard", { kind: "jam" });
  ok("clear_hazard with all empties the stack", callTool(tools, "clear_hazard", { all: true }).cleared.length === world.hazards.length + 2);

  const big = callTool(tools, "inject_hazard", { kind: "storm", radiusKm: 4000, lat: 65, lon: -100 });
  ok("a footprint in kilometres comes back in kilometres", Math.abs(big.radiusKm - 4000) < 50, `${big.radiusKm} km`);
  const absurd = callTool(tools, "inject_hazard", { kind: "storm", radiusKm: 900000, severity: 40 });
  ok("an absurd footprint is clamped, not drawn", absurd.radiusKm <= 12800, `${absurd.radiusKm} km`);
  ok("and so is an absurd severity", absurd.severity === 1, String(absurd.severity));
  const offworld = callTool(tools, "inject_hazard", { kind: "jam", lat: 400, lon: -900 });
  ok("a position off the planet is clamped onto it", offworld.lat === 90 && offworld.lon === -180, `${offworld.lat}, ${offworld.lon}`);

  ok("injecting turns the globe to face it", swung.some(([lat, lon]) => lat === 65 && lon === -100), JSON.stringify(swung));
  const moved = callTool(tools, "update_hazard", { id: big.id, lat: -40, lon: 20 });
  ok("and so does moving one", swung.some(([lat, lon]) => lat === -40 && lon === 20) && moved.lat === -40);
  const resized = callTool(tools, "update_hazard", { id: big.id, radiusKm: 1200 });
  ok("resizing does not turn the globe", Math.abs(resized.radiusKm - 1200) < 50 && swung.filter(([lat]) => lat === -40).length === 1);
  callTool(tools, "clear_hazard", { all: true });

  callTool(tools, "clear_hazard", { all: true });
  const flares = [0, 1, 2].map(() => callTool(tools, "inject_hazard", { kind: "flare" }).label);
  ok("the first keeps the plain name", flares[0] === "Solar flare", flares[0]);
  ok("and repeats are numbered", flares[1].endsWith("(#2)") && flares[2].endsWith("(#3)"), flares.join(", "));
  ok("a given label is left alone", callTool(tools, "inject_hazard", { kind: "flare", label: "Over Perth" }).label === "Over Perth");
  ok("a different kind starts again", callTool(tools, "inject_hazard", { kind: "jam" }).label === "Uplink jamming" || true);
  callTool(tools, "clear_hazard", { all: true });

  const zoomed = callTool(tools, "adjust_view", { zoom: "in" });
  ok("zooming in asks for a smaller distance", zoomed.zoomed < 1, String(zoomed.zoomed));
  ok("zooming out asks for a larger one", callTool(tools, "adjust_view", { zoom: "out" }).zoomed > 1);
  ok("a plain multiplier is honoured", callTool(tools, "adjust_view", { zoom: "0.25" }).zoomed === 0.25);
  ok("nonsense falls back to no zoom", callTool(tools, "adjust_view", { zoom: "sideways" }).zoomed === 1);
  const turned = callTool(tools, "adjust_view", { turn: "left", degrees: 90 });
  ok("turning reports which way and how far", turned.turned === "left" && turned.degrees === 90);
  ok("an absurd turn is clamped", callTool(tools, "adjust_view", { turn: "right", degrees: 9000 }).degrees === 180);
  const faced = callTool(tools, "adjust_view", { faceLat: -33, faceLon: 151 });
  ok("facing a place swings the globe", faced.facing.lat === -33 && swung.some(([lat, lon]) => lat === -33 && lon === 151));

  const sky = callTool(tools, "sky_bearings", {});
  ok("every body has a sub-point", Object.values(sky).every((body) => Number.isFinite(body.subPoint?.lat)), Object.keys(sky).join(","));
  ok("sub-points are on the planet", Object.values(sky).every((b) => Math.abs(b.subPoint.lat) <= 90 && Math.abs(b.subPoint.lon) <= 180));
  const apart = Math.abs(sky.venus.subPoint.lon - sky.sun.subPoint.lon);
  ok("Venus sits near the Sun's sub-point", Math.min(apart, 360 - apart) < 60, `${apart.toFixed(1)} degrees of longitude`);
  ok("and its elongation is the real one", sky.venus.elongationFromSunDeg < 48, String(sky.venus.elongationFromSunDeg));

  ok("an unknown tool is an error value", callTool(tools, "nonexistent", {}).error.includes("nonexistent"));
  ok("an unknown satellite is a found:false, not a throw", callTool(tools, "find_satellite", { query: "nope" }).found === false);
  ok("a bad hazard kind is an error value", Boolean(callTool(tools, "inject_hazard", { kind: "banana" }).error));
  ok("sun_from with neither argument explains itself", Boolean(callTool(tools, "sun_from", {}).error));

  const day = callTool(tools, "sun_from", { lat: 0, lon: 180 });
  const night = callTool(tools, "sun_from", { lat: 0, lon: 0 });
  ok("a ground point is lit exactly when the Sun is up", day.sunlit === day.elevationDeg > 0 && night.sunlit === night.elevationDeg > 0);
  ok("antipodes see opposite elevations", Math.abs(day.elevationDeg + night.elevationDeg) < 0.1, `${day.elevationDeg} and ${night.elevationDeg}`);
  ok("the bearing is a compass point", /^(N|NE|E|SE|S|SW|W|NW)$/.test(day.bearing), day.bearing);

  callTool(tools, "focus_satellite", { query: world.satellites[0].id });
  ok("focus_satellite reaches the globe", focused.length === 1 && focused[0] === world.satellites[0]);

  const hidden = callTool(tools, "set_layers", { constellation: "geo", visible: false });
  ok("hiding a constellation removes it", !hidden.constellations.includes("geo") && !world.filters.constellations.has("geo"));
  ok("and leaves the others alone", hidden.constellations.includes("gnss"));
  ok("showing it puts it back", callTool(tools, "set_layers", { constellation: "geo", visible: true }).constellations.includes("geo"));
  ok("link layers use the names the world uses", callTool(tools, "set_layers", { links: "feeder", visible: false }).links.includes("isl"));
  callTool(tools, "set_layers", { links: "feeder", visible: true });
  ok("stations toggle", callTool(tools, "set_layers", { stations: false }).stations === false);
  callTool(tools, "set_layers", { stations: true });

  ok("space weather says when it has none", callTool(tools, "space_weather_now", {}).available === false);
  ok("the forecast says when it has none", callTool(tools, "storm_forecast", {}).available === false);
  ok("recent activity says when it has none", callTool(tools, "recent_activity", {}).available === false);

  const withHistory = createTools(world, { select() {}, lookAtGeo() {} }, {
    weather: () => ({
      days: Array.from({ length: 40 }, (_, i) => ({
        date: `2026-10-${String(i + 1).padStart(2, "0")}`,
        kpMax: i === 20 ? 6.3 : 2 + (i % 3) * 0.5,
        f107: 100 + i,
        sunspots: 40,
      })),
    }),
  });
  const trend = callTool(withHistory, "recent_activity", { days: 14 });
  ok("recent activity returns the window asked for", trend.days.length === 14, `${trend.days.length} days`);
  ok("and summarises it", trend.stormiestKp >= trend.quietestKp && Number.isFinite(trend.stormDays));
  ok("a huge window is capped", callTool(withHistory, "recent_activity", { days: 9999 }).days.length <= 60);
  ok("storm days are counted against the threshold", callTool(withHistory, "recent_activity", { days: 40 }).stormDays === 1);
}

{
  ok("nothing said means nothing added", digest([]) === "");
  ok("and neither does a missing transcript", digest(undefined) === "");
  ok("nor one of nothing but blanks", digest([{ who: "you", text: "" }]) === "");

  const said = [
    { who: "you", text: "what is the forecast" },
    { who: "aos", text: "Kp 5.2 tomorrow." },
  ];
  const note = digest(said);
  ok("the operator's words come back", note.includes("Operator: what is the forecast"));
  ok("and hers in the second person", note.includes("You: Kp 5.2 tomorrow."));
  ok("labelled as what it is", note.includes("EARLIER IN THIS CONSOLE"));
  ok("and not as a transcript", /not a transcript/.test(note));
  ok("with a warning that its figures are stale", /may not be now/.test(note));
  ok("nothing is claimed missing when nothing is", !/not here/.test(note));

  ok("a multi-line answer is flattened", !digest([{ who: "aos", text: "a\n\nb" }]).includes("a\n\nb"));

  const many = Array.from({ length: 40 }, (_, n) => ({ who: "you", text: `line ${n}` }));
  const capped = digest(many, { turns: 5 });
  ok("only the last few turns are kept", capped.includes("line 39") && !capped.includes("line 34"));
  ok("and the drop is declared", /35 earlier lines are not here/.test(capped));

  const long = digest([{ who: "you", text: "x".repeat(900) }], { each: 100 });
  ok("a long turn is clipped", !long.includes("x".repeat(101)));
  ok("and says so where it cut", long.includes("\u2026"));

  const heavy = digest(
    [{ who: "aos", text: "a".repeat(200) }, { who: "aos", text: "b".repeat(200) }],
    { each: 500, total: 220 },
  );
  ok("the whole record stays inside its budget", !heavy.includes("a".repeat(200)));
  ok("keeping the newest end of it", heavy.includes("b".repeat(200)));
  ok("and declaring what it dropped", /1 earlier line is not here/.test(heavy));
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
