
import { readFileSync } from "node:fs";
import { chooseProvider } from "./llm.mjs";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch {
}

const provider = chooseProvider();
if (!provider) {
  console.log("No API key set. See the README for which ones are accepted.");
  process.exit(1);
}
console.log(`${provider.id}, currently configured for ${provider.model}\n`);

const key = process.env[provider.env];
const listing = {
  gemini: ["https://generativelanguage.googleapis.com/v1beta/models?key=" + key, {}],
  openai: ["https://api.openai.com/v1/models", { authorization: `Bearer ${key}` }],
  groq: ["https://api.groq.com/openai/v1/models", { authorization: `Bearer ${key}` }],
  openrouter: ["https://openrouter.ai/api/v1/models", { authorization: `Bearer ${key}` }],
  anthropic: ["https://api.anthropic.com/v1/models", { "x-api-key": key, "anthropic-version": "2023-06-01" }],
}[provider.id];

const response = await fetch(listing[0], { headers: listing[1] });
const body = await response.json();
const names = (body.models ?? body.data ?? [])
  .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes("generateContent"))
  .map((model) => (model.name ?? model.id ?? "").replace("models/", ""))
  .filter((name) => !/tts|image|embedding|transcribe|nano-banana|veo|imagen/.test(name));

console.log(`${names.length} usable:`);
names.forEach((name) => console.log(`  ${name}`));
console.log("\nSet one with AOS_MODEL, or edit scripts/llm.mjs.");
