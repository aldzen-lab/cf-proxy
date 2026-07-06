// Live model list from Cloudflare, cached in-memory. CF's `per_page` pagination is
// unreliable (total_count says 268 but page 2 is empty), so we page defensively
// until an empty page. Third-party/partner models are excluded.

const CF_BASE = "https://api.cloudflare.com/client/v4/accounts";
const TTL_MS = 10 * 60 * 1000;
const PER_PAGE = 100;

let cache = { at: 0, models: null, byShort: null, byMid: null };

export async function getModels(pickAccount, logWarn, { fresh = false } = {}) {
  if (!fresh && cache.models && Date.now() - cache.at < TTL_MS) return cache.models;

  const account = pickAccount();
  if (!account) return cache.models || [];

  try {
    const raw = [];
    for (let page = 1; page <= 10; page++) {
      const url = `${CF_BASE}/${account.account_id}/ai/models/search?per_page=${PER_PAGE}&page=${page}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${account.api_key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        logWarn?.(`model list fetch page ${page} -> ${res.status}`);
        break;
      }
      const body = await res.json();
      const rows = body.result || [];
      raw.push(...rows);
      if (rows.length < PER_PAGE) break;
    }

    const models = raw
      .filter((m) => !isPartner(m))
      .map((m) => ({
        id: m.name,
        name: m.name,
        description: m.description || "",
        task: m.task?.name || "",
        tags: m.tags || [],
        created_at: m.created_at || "",
        partner: false,
        capabilities: capabilityFlags(m),
      }))
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

    // short = last path segment; mid = vendor/model (disambiguates short collisions)
    const byShort = new Map();
    const byMid = new Map();
    for (const m of models) {
      const i = m.name.lastIndexOf("/");
      const short = i >= 0 ? m.name.slice(i + 1) : m.name;
      (byShort.get(short) ?? byShort.set(short, []).get(short)).push(m.name);
      const mid = m.name.startsWith("@cf/") ? m.name.slice(4) : m.name;
      (byMid.get(mid) ?? byMid.set(mid, []).get(mid)).push(m.name);
    }
    cache = { at: Date.now(), models, byShort, byMid };
    return models;
  } catch (e) {
    logWarn?.(`model list fetch error: ${e.message}; serving ${cache.models ? "stale cache" : "empty"}`);
    return cache.models || [];
  }
}

/**
 * Resolve a client-supplied model id to a full CF id ("@cf/vendor/model").
 * Accepts: full id (with "/"), short id (last segment, needs cache), or mid.
 * @returns {{id:string}|{error:string, candidates?:string[], status:number}}
 */
export async function resolveModel(input, pickAccount, logWarn) {
  if (!input || typeof input !== "string") return { error: "model required", status: 400 };
  const s = input.trim();
  if (!s) return { error: "model required", status: 400 };

  if (s.includes("/")) {
    return { id: s.startsWith("@cf/") ? s : `@cf/${s}` };
  }

  if (!cache.byShort) await getModels(pickAccount, logWarn);
  if (!cache.byShort) {
    return { error: "model list unavailable — import accounts first", status: 503 };
  }

  const hits = cache.byShort.get(s);
  if (!hits || hits.length === 0) {
    return { error: `unknown model "${s}"`, status: 404 };
  }
  if (hits.length === 1) return { id: hits[0] };
  return {
    error: `ambiguous model "${s}" — ${hits.length} matches, use vendor/model`,
    candidates: hits,
    status: 409,
  };
}

function isPartner(m) {
  return (m.properties || []).some((p) => p.property_id === "partner" && p.value === true);
}

function capabilityFlags(m) {
  const ids = new Set((m.properties || []).map((p) => p.property_id));
  const flags = [];
  if (ids.has("vision")) flags.push("vision");
  if (ids.has("reasoning")) flags.push("reasoning");
  if (ids.has("function_calling")) flags.push("tools");
  if (ids.has("realtime")) flags.push("realtime");
  if (ids.has("lora")) flags.push("lora");
  if (ids.has("async_queue")) flags.push("async");
  return flags;
}

export function invalidateModels() {
  cache = { at: 0, models: null };
}
