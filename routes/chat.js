import { Router } from "express";
import { chatUrl, embeddingsUrl, runUrl, callNormal, callStream } from "../lib/cf.js";
import { resolveModel } from "../lib/models.js";

// CF rejects multipart content — collapse OpenAI content arrays to a string.
function flattenContent(messages) {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      msg.content = msg.content
        .map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : ""))
        .join("");
    }
  }
  return messages;
}

/**
 * Run one request across the pool, retrying on 429/network errors.
 * `buildUrl(accountId)` picks the upstream URL per attempt.
 */
async function withPool({ pool, maxRetries, res, buildUrl, body, stream, model, log }) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const account = pool.getAvailable();
    if (!account) {
      return res.status(503).json({ error: "No available accounts", pool: pool.stats() });
    }
    const url = buildUrl(account.account_id);

    let released = false;
    const release = () => {
      if (!released) { released = true; pool.release(account.id); }
    };
    try {
      if (stream) {
        let prepared = false;
        const result = await callStream(url, account.api_key, body, (chunk) => {
          if (!prepared) {
            res.status(200);
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("X-CF-Proxy-Account", account.name || String(account.id));
            prepared = true;
          }
          // Backpressure: wait for drain before pulling the next chunk.
          if (!res.write(chunk)) return new Promise((r) => res.once("drain", r));
        });

        if (result.status === 429) { pool.mark429(account.id, result.errorCode); continue; }
        if (result.status >= 400) {
          log.warn?.(`Account ${account.name} stream -> ${result.status}: ${result.text?.slice(0, 200)}`);
          return res.status(result.status).type("application/json").send(result.text);
        }
        pool.markSuccess(account.id, model, result.usage);
        return res.end();
      }

      const result = await callNormal(url, account.api_key, body);
      if (result.status === 429) { pool.mark429(account.id, result.errorCode); continue; }
      if (result.status >= 400) {
        log.warn?.(`Account ${account.name} -> ${result.status}: ${result.text?.slice(0, 200)}`);
        return res.status(result.status).type("application/json").send(result.text);
      }
      pool.markSuccess(account.id, model, result.usage);
      return res.json(result.json);
    } catch (e) {
      // Mid-stream: destroy so the client sees an aborted read, not a clean EOF.
      log.warn?.(`Account ${account.name} error: ${e.message}`);
      if (res.headersSent) return res.destroy(e);
      continue;
    } finally {
      release();
    }
  }
  if (res.headersSent) return res.end();
  return res.status(502).json({ error: "All retries failed", pool: pool.stats() });
}

export function openaiRouter({ pool, maxRetries, log, pick }) {
  const router = Router();

  router.post("/chat/completions", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object") return res.status(400).json({ error: "Invalid JSON" });
    if (!body.model) return res.status(400).json({ error: "model required" });
    const r = await resolveModel(body.model, pick, log.warn);
    if (r.error) return res.status(r.status).json({ error: r.error, ...(r.candidates ? { candidates: r.candidates } : {}) });
    body.model = r.id;
    if (Array.isArray(body.messages)) body.messages = flattenContent(body.messages);
    return withPool({
      pool, maxRetries, res, log,
      buildUrl: (id) => chatUrl(id),
      body, model: r.id, stream: body.stream === true,
    });
  });

  router.post("/embeddings", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object") return res.status(400).json({ error: "Invalid JSON" });
    if (!body.model) return res.status(400).json({ error: "model required" });
    const r = await resolveModel(body.model, pick, log.warn);
    if (r.error) return res.status(r.status).json({ error: r.error, ...(r.candidates ? { candidates: r.candidates } : {}) });
    body.model = r.id;
    return withPool({
      pool, maxRetries, res, log,
      buildUrl: (id) => embeddingsUrl(id),
      body, model: r.id, stream: false,
    });
  });

  return router;
}

export function runRouter({ pool, maxRetries, log, pick }) {
  const router = Router();
  // Model ids contain slashes (@cf/meta/m2m100-1.2b) — wildcard matches the
  // whole remaining path. Short ids are resolved to full first.
  router.post("/run/*", async (req, res) => {
    const model = req.params[0];
    if (!model) return res.status(400).json({ error: "model required in path" });
    const r = await resolveModel(model, pick, log.warn);
    if (r.error) return res.status(r.status).json({ error: r.error, ...(r.candidates ? { candidates: r.candidates } : {}) });
    const body = req.body ?? {};
    return withPool({
      pool, maxRetries, res, log,
      buildUrl: (id) => runUrl(id, r.id),
      body, model: r.id, stream: false,
    });
  });
  return router;
}
