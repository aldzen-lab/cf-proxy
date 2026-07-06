import { Router } from "express";
import { importFrom9router } from "../lib/importer.js";
import { NEURON_FREE_DAILY, todayUTC } from "../lib/neurons.js";
import { getModels, invalidateModels } from "../lib/models.js";

function shapeAccount(row) {
  const today = todayUTC();
  const usedToday = row.neurons_day === today ? row.neurons_today : 0;
  const reqsToday = row.neurons_day === today ? row.requests_today : 0;
  const now = Date.now() / 1000;
  const inCooldown = row.cooldown_until > now;
  let status = "available";
  if (!row.is_active) status = "inactive";
  else if (usedToday >= NEURON_FREE_DAILY) status = "exhausted";
  else if (inCooldown) status = "cooldown";
  return {
    id: row.id,
    name: row.name,
    account_id: row.account_id.slice(0, 8),
    is_active: !!row.is_active,
    status,
    neurons_today: Math.round(usedToday),
    neurons_remaining: Math.max(0, Math.round(NEURON_FREE_DAILY - usedToday)),
    neurons_free_daily: NEURON_FREE_DAILY,
    requests_today: reqsToday,
    cooldown_seconds: inCooldown ? Math.round(row.cooldown_until - now) : 0,
  };
}

export function adminRouter({ db, pool, ninePath, log, pick }) {
  const router = Router();

  router.get("/health", (_req, res) => res.json({ status: "ok", pool: pool.stats() }));

  router.get("/v1/models", async (_req, res) => {
    try {
      const models = await getModels(pick, log.warn);
      res.json({
        object: "list",
        data: models.map((m) => {
          const i = m.id.lastIndexOf("/");
          const short = i >= 0 ? m.id.slice(i + 1) : m.id;
          return { id: m.id, short, object: "model", owned_by: "cloudflare" };
        }),
      });
    } catch (e) {
      log.error?.(`/v1/models failed: ${e.message}`);
      res.status(502).json({ error: "Failed to fetch model list" });
    }
  });

  router.get("/api/models", async (req, res) => {
    try {
      const fresh = req.query.fresh === "1";
      const models = await getModels(pick, log.warn, { fresh });
      res.json({ models });
    } catch (e) {
      log.error?.(`/api/models failed: ${e.message}`);
      res.status(502).json({ error: "Failed to fetch model list" });
    }
  });

  router.get("/api/stats", (_req, res) => res.json(pool.stats()));

  router.get("/api/accounts", (_req, res) => {
    const rows = db.prepare("SELECT * FROM accounts ORDER BY id").all();
    res.json({ accounts: rows.map(shapeAccount), stats: pool.stats() });
  });

  router.post("/api/import", (_req, res) => {
    try {
      const result = importFrom9router(db, ninePath, log);
      invalidateModels();
      res.json(result);
    } catch (e) {
      log.error?.(`import failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
