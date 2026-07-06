import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { initDb } from "./lib/db.js";
import { AccountPool } from "./lib/pool.js";
import { openaiRouter, runRouter } from "./routes/chat.js";
import { adminRouter } from "./routes/admin.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.CF_PROXY_HOST || "0.0.0.0";
const PORT = parseInt(process.env.CF_PROXY_PORT || "8750", 10);
const NINE_DB = process.env.CF_PROXY_9ROUTER_DB || join(process.env.HOME || "", ".9router/db/data.sqlite");
const OWN_DB = process.env.CF_PROXY_DB || join(__dirname, "data", "accounts.db");
const API_KEY = process.env.CF_PROXY_API_KEY || "";
const COOLDOWN_429 = parseInt(process.env.CF_PROXY_COOLDOWN_429 || "3600", 10);
const MAX_RETRIES = parseInt(process.env.CF_PROXY_MAX_RETRIES || "5", 10);
const LOG_LEVEL = (process.env.CF_PROXY_LOG_LEVEL || "INFO").toUpperCase();

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const threshold = LEVELS[LOG_LEVEL] ?? 20;
const stamp = () => new Date().toISOString().slice(11, 19);
const log = {
  debug: (m) => threshold <= 10 && console.log(`${stamp()} [DEBUG] ${m}`),
  info: (m) => threshold <= 20 && console.log(`${stamp()} [INFO] ${m}`),
  warn: (m) => threshold <= 30 && console.warn(`${stamp()} [WARN] ${m}`),
  error: (m) => threshold <= 40 && console.error(`${stamp()} [ERROR] ${m}`),
};

const db = initDb(OWN_DB);
const pool = new AccountPool(db, { cooldown429: COOLDOWN_429, log });

const app = express();
app.use(express.json({ limit: "1mb" }));
// 4-arg handler: turn body-parser SyntaxError into JSON 400 (default returns HTML)
app.use((err, _req, res, next) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request too large" });
  }
  return next(err);
});

// Bearer auth on API/proxy paths only (skipped when empty). Dashboard stays open
// so the key can be entered; it's sent on /api and /health calls.
const PROTECTED = ["/v1", "/api", "/health", "/ai"];
app.use((req, res, next) => {
  if (!API_KEY) return next();
  // Express routes case-insensitively — match the same way or /V1/... slips past.
  const path = req.path.toLowerCase();
  const guarded = PROTECTED.some((p) => path === p || path.startsWith(p + "/"));
  if (!guarded) return next();
  if (req.headers.authorization === `Bearer ${API_KEY}`) return next();
  return res.status(401).json({ error: "Unauthorized" });
});

const pick = () => pool.peekAccount();
app.use("/v1", openaiRouter({ pool, maxRetries: MAX_RETRIES, log, pick }));
app.use("/ai", runRouter({ pool, maxRetries: MAX_RETRIES, log, pick }));
app.use("/", adminRouter({ db, pool, ninePath: NINE_DB, log, pick }));

const webDist = join(__dirname, "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(join(webDist, "index.html")));
} else {
  log.warn("web/dist not built — dashboard unavailable (run: npm run build)");
}

const stats = pool.stats();
app.listen(PORT, HOST, () => {
  log.info(`cf-proxy ready on ${HOST}:${PORT} — ${stats.total} accounts (${stats.available} available)`);
  if (stats.total === 0) log.info("pool empty — POST /api/import or click Import in the dashboard");
});
