
const MAX_REPLY_TOKENS = 1200;

export const PROVIDERS = [
  {
    id: "anthropic",
    env: "ANTHROPIC_API_KEY",
    model: process.env.AOS_MODEL ?? "claude-sonnet-4-5",
    url: "https://api.anthropic.com/v1/messages",
    shape: "anthropic",
  },
  {
    id: "openai",
    env: "OPENAI_API_KEY",
    model: process.env.AOS_MODEL ?? "gpt-4.1",
    url: "https://api.openai.com/v1/chat/completions",
    shape: "openai",
  },
  {
    id: "groq",
    env: "GROQ_API_KEY",
    model: process.env.AOS_MODEL ?? "llama-3.3-70b-versatile",
    url: "https://api.groq.com/openai/v1/chat/completions",
    shape: "openai",
  },
  {
    id: "gemini",
    env: "GEMINI_API_KEY",
    model: process.env.AOS_MODEL ?? "gemini-3.1-flash-lite",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    shape: "openai",
  },
  {
    id: "openrouter",
    env: "OPENROUTER_API_KEY",
    model: process.env.AOS_MODEL ?? "anthropic/claude-sonnet-4.5",
    url: "https://openrouter.ai/api/v1/chat/completions",
    shape: "openai",
  },
];

export function chooseProvider(env = process.env) {
  const wanted = env.AOS_PROVIDER;
  const list = wanted ? PROVIDERS.filter((provider) => provider.id === wanted) : PROVIDERS;
  return list.find((provider) => env[provider.env]) ?? null;
}

export function toAnthropic(request, model) {
  return {
    model,
    max_tokens: MAX_REPLY_TOKENS,
    system: request.system,
    messages: strip(request.messages),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema,
    })),
  };
}

export function fromAnthropic(body) {
  return {
    content: (body.content ?? []).map((block) =>
      block.type === "tool_use"
        ? { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} }
        : { type: "text", text: block.text ?? "" },
    ),
  };
}

const strip = (messages) =>
  messages.map((message) =>
    Array.isArray(message.content)
      ? {
          ...message,
          content: message.content.map(({ signature, ...block }) => block),
        }
      : message,
  );

export function toOpenAI(request, model) {
  const messages = [{ role: "system", content: request.system }];

  for (const message of request.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const results = message.content.filter((block) => block.type === "tool_result");
    if (results.length) {
      for (const result of results) {
        messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.content });
      }
      continue;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const calls = message.content.filter((block) => block.type === "tool_use");
    messages.push({
      role: message.role,
      content: text || null,
      ...(calls.length
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
              ...(call.signature ? { extra_content: { google: { thought_signature: call.signature } } } : {}),
            })),
          }
        : {}),
    });
  }

  return {
    model,
    messages,
    max_tokens: MAX_REPLY_TOKENS,
    tools: request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.schema },
    })),
  };
}

export function fromOpenAI(body) {
  const message = body.choices?.[0]?.message ?? {};
  const content = [];
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      input = { __malformed: call.function?.arguments ?? "" };
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name,
      input,
      ...(call.extra_content?.google?.thought_signature
        ? { signature: call.extra_content.google.thought_signature }
        : {}),
    });
  }
  return { content };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const ATTEMPTS = 4;
const BASE_DELAY_MS = 700;
const MAX_DELAY_MS = 20000;

export function nextDelay(attempt, retryAfter, random = Math.random) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
    const when = Date.parse(retryAfter);
    if (Number.isFinite(when)) {
      return Math.min(Math.max(when - Date.now(), 0), MAX_DELAY_MS);
    }
  }
  const backoff = BASE_DELAY_MS * 2 ** attempt;
  return Math.min(backoff + random() * backoff * 0.4, MAX_DELAY_MS);
}

export const isRetryable = (status) => RETRYABLE.has(status);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function relay(request, provider, { onRetry = () => {} } = {}) {
  const anthropic = provider.shape === "anthropic";
  const body = anthropic ? toAnthropic(request, provider.model) : toOpenAI(request, provider.model);
  const headers = anthropic
    ? {
        "content-type": "application/json",
        "x-api-key": process.env[provider.env],
        "anthropic-version": "2023-06-01",
      }
    : {
        "content-type": "application/json",
        authorization: `Bearer ${process.env[provider.env]}`,
      };

  const payload = JSON.stringify(body);
  let last = null;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let response;
    let text;
    try {
      response = await fetch(provider.url, { method: "POST", headers, body: payload });
      text = await response.text();
    } catch (error) {
      last = new Error(`${provider.id} unreachable: ${error.message ?? error}`);
      if (attempt === ATTEMPTS - 1) {
        break;
      }
      const delay = nextDelay(attempt);
      onRetry({ attempt: attempt + 1, delay, reason: "network" });
      await wait(delay);
      continue;
    }

    if (response.ok) {
      const parsed = JSON.parse(text);
      return anthropic ? fromAnthropic(parsed) : fromOpenAI(parsed);
    }

    last = new Error(`${provider.id} ${response.status}: ${text.slice(0, 400)}`);
    last.status = response.status;
    if (!isRetryable(response.status) || attempt === ATTEMPTS - 1) {
      break;
    }
    const delay = nextDelay(attempt, response.headers.get("retry-after"));
    onRetry({ attempt: attempt + 1, delay, reason: response.status });
    await wait(delay);
  }

  throw last;
}
