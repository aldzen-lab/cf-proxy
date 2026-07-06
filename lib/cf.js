// Upstream Cloudflare Workers AI calls via native fetch.
// Three call shapes share one account-pool rotation strategy:
//   - chat (OpenAI /v1/chat/completions)        -> non-stream + stream, usage in body/SSE
//   - embeddings (OpenAI /v1/embeddings)        -> no usage in response (CF omits it)
//   - run (CF generic /ai/run/{model})          -> {result:{...usage}} for any task
//
// Non-chat responses may carry usage as result.usage (run) or not at all
// (embeddings). extractUsage() handles all three.

const CF_BASE = "https://api.cloudflare.com/client/v4/accounts";

export function chatUrl(accountId) {
  return `${CF_BASE}/${accountId}/ai/v1/chat/completions`;
}
export function embeddingsUrl(accountId) {
  return `${CF_BASE}/${accountId}/ai/v1/embeddings`;
}
/** Generic CF endpoint for ANY task/model (image, speech, translation, ...). */
export function runUrl(accountId, model) {
  return `${CF_BASE}/${accountId}/ai/run/${model}`;
}

/** Best-effort usage extraction across the three response shapes. */
function extractUsage(json) {
  if (!json) return null;
  if (json.usage) return json.usage; // OpenAI-compat chat
  if (json.result?.usage) return json.result.usage; // /ai/run generic
  return null; // embeddings: CF returns none
}

/**
 * Parse a CF error body into { errorCode, message }. CF returns errors as
 * `{errors:[{code, message}]}` (Workers AI) or OpenAI-shape `{error:{...}}`.
 */
function extractError(text) {
  if (!text) return {};
  try {
    const j = JSON.parse(text);
    const e = j.errors?.[0] ?? j.error;
    if (e) return { errorCode: e.code ?? null, message: e.message ?? "" };
  } catch {
    /* non-JSON error body */
  }
  return {};
}

/** Scan one or more SSE text fragments for the last `usage` object (chat stream). */
function scanUsage(buffer) {
  let usage = null;
  for (const line of buffer.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (payload === "[DONE]" || !payload.startsWith("{")) continue;
    try {
      const obj = JSON.parse(payload);
      if (obj.usage) usage = obj.usage;
    } catch {
      /* partial chunk; ignore */
    }
  }
  return usage;
}

/**
 * Non-streaming call to an upstream URL. Returns the parsed JSON plus extracted
 * usage so the pool can estimate neurons (when CF provides it).
 */
export async function callNormal(url, apiKey, body, { timeoutMs = 120000 } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const status = res.status;
  if (status >= 400) {
    const text = await res.text();
    const { errorCode, message } = extractError(text);
    return { status, headers: res.headers, text, errorCode, errorMessage: message };
  }
  const json = await res.json();
  return { status, headers: res.headers, json, usage: extractUsage(json) };
}

/**
 * Streaming call (chat only). Pipes chunks to `write(chunk)` and resolves with
 * the parsed usage once the upstream stream ends.
 * @param {(chunk: Uint8Array) => Promise<void>|void} write
 */
export async function callStream(url, apiKey, body, write, { timeoutMs = 300000 } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 400) {
    const text = await res.text();
    const { errorCode, message } = extractError(text);
    return { status: res.status, headers: res.headers, text, errorCode, errorMessage: message };
  }

  const decoder = new TextDecoder();
  let tail = "";
  let usage = null;

  for await (const chunk of res.body) {
    await write(chunk);
    tail += decoder.decode(chunk, { stream: true });
    const nl = tail.lastIndexOf("\n");
    if (nl >= 0) {
      const found = scanUsage(tail.slice(0, nl));
      if (found) usage = found;
      tail = tail.slice(nl + 1);
    }
  }
  const found = scanUsage(tail);
  if (found) usage = found;

  return { status: res.status, headers: res.headers, usage };
}
