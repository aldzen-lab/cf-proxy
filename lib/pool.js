// AccountPool — round-robin rotation with 429 cooldown and per-account daily
// neuron budgeting. Mirrors the Python AccountPool, plus neuron accounting.

import { estimate, todayUTC, NEURON_FREE_DAILY } from "./neurons.js";

export class AccountPool {
  constructor(db, { cooldown429 = 90, log = console, reserveNeurons = 250 } = {}) {
    this.db = db;
    this.cooldown429 = cooldown429; // seconds — used for rate-limit 429s
    this.log = log;
    this._cursor = 0;

    // In-flight neuron reservations (id -> neurons reserved for `_reservedDay`).
    // getAvailable() runs synchronously and reserves on the picked account before
    // returning, so concurrent requests straddling the upstream `await` see each
    // other's provisional usage — closing the check-then-commit race and spreading
    // a burst across accounts instead of piling onto one near-full account.
    this._reserved = new Map();
    this._reservedDay = todayUTC();
    this.reserveNeurons = reserveNeurons;

    this._selAvail = db.prepare(
      // Candidates: active, not in cooldown. The neuron-budget filter is applied
      // in JS below so it can include in-flight reservations, not just committed
      // usage. Stale counters (previous UTC day) are treated as 0 there.
      `SELECT * FROM accounts
       WHERE is_active = 1 AND cooldown_until < ?
       ORDER BY id`
    );
    // Same candidate set as _selAvail but only the columns needed for counting.
    this._candidates = db.prepare(
      `SELECT id, neurons_today, neurons_day FROM accounts
       WHERE is_active = 1 AND cooldown_until < ?`
    );
    this._get = db.prepare("SELECT * FROM accounts WHERE id = ?");
    this._peek = db.prepare(
      "SELECT account_id, api_key FROM accounts WHERE is_active = 1 ORDER BY id LIMIT 1"
    );
    this._mark429 = db.prepare(
      "UPDATE accounts SET cooldown_until = ?, error_count = error_count + 1 WHERE id = ?"
    );
    this._countTotal = db.prepare("SELECT COUNT(*) AS c FROM accounts WHERE is_active = 1");
  }

  /**
   * Return one account's credentials for read-only metadata calls (e.g. listing
   * models). Does NOT rotate or reserve budget — inference must use getAvailable.
   */
  peekAccount() {
    return this._peek.get() || null;
  }

  /** Roll the reservation map over at the UTC day boundary. */
  _rollReservations(today) {
    if (this._reservedDay !== today) {
      this._reserved.clear();
      this._reservedDay = today;
    }
  }

  /** Committed (today) + in-flight reserved neurons for an account. */
  _effectiveNeurons(row, today) {
    const committed = row.neurons_day === today ? row.neurons_today : 0;
    return committed + (this._reserved.get(row.id) || 0);
  }

  /**
   * Round-robin over accounts under their daily budget (committed + in-flight),
   * reserving a provisional amount on the chosen account. Returns null if none.
   * Runs fully synchronously — no await — so the reservation lands before any
   * concurrent request can pick the same near-full account.
   */
  getAvailable() {
    const today = todayUTC();
    this._rollReservations(today);
    const rows = this._selAvail
      .all(Date.now() / 1000)
      .filter((r) => this._effectiveNeurons(r, today) < NEURON_FREE_DAILY);
    if (rows.length === 0) return null;
    const row = rows[this._cursor % rows.length];
    this._cursor++;
    this._reserved.set(row.id, (this._reserved.get(row.id) || 0) + this.reserveNeurons);
    return row;
  }

  /** Release an account's in-flight reservation (call once per getAvailable). */
  release(id) {
    const cur = this._reserved.get(id);
    if (cur === undefined) return;
    const next = cur - this.reserveNeurons;
    if (next > 0) this._reserved.set(id, next);
    else this._reserved.delete(id);
  }

  /** Count accounts under budget (committed + in-flight reservations). */
  _countAvailable() {
    const today = todayUTC();
    this._rollReservations(today);
    return this._candidates
      .all(Date.now() / 1000)
      .filter((r) => this._effectiveNeurons(r, today) < NEURON_FREE_DAILY).length;
  }

  /**
   * Cooldown an account after a 429. CF returns two distinct 429s:
   *   - error code 4006: daily free neuron allocation exhausted → reset at 00:00 UTC
   *   - other 429: per-minute rate limit → short cooldown (cooldown429, ~90s)
   * The flat `cooldown429` is wrong for 4006 (it would re-try an exhausted
   * account every hour, wasting a slot). So compute the cooldown from the code.
   */
  mark429(id, errorCode) {
    const now = Date.now() / 1000;
    let until;
    let reason;
    if (errorCode === 4006) {
      // Next 00:00 UTC. Compute seconds remaining to that boundary.
      const d = new Date();
      const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0) / 1000;
      until = next;
      reason = "daily limit 4006 -> cool until 00:00 UTC";
      // Also pin neurons_today to the cap so it shows as "exhausted" in the
      // dashboard even before markSuccess would have caught it.
      const today = todayUTC();
      this.db
        .prepare("UPDATE accounts SET neurons_today = ?, neurons_day = ? WHERE id = ?")
        .run(NEURON_FREE_DAILY, today, id);
    } else {
      until = now + this.cooldown429;
      reason = `rate-limit -> cool ${this.cooldown429}s`;
    }
    this._mark429.run(until, id);
    const remaining = this._countAvailable();
    this.log.info?.(`429 -> account #${id} ${reason}, ${remaining} remaining`);
  }

  /**
   * Record a successful call: reset error_count, bump last_used, and add the
   * estimated neurons for `model`+`usage` to today's per-account counter
   * (lazily resetting the counter when the UTC day rolls over).
   */
  markSuccess(id, model, usage) {
    const today = todayUTC();
    const prompt = usage?.prompt_tokens ?? 0;
    const completion = usage?.completion_tokens ?? 0;
    const neurons = estimate(model, prompt, completion, (m) => this.log.warn?.(m));

    const row = this._get.get(id);
    if (!row) return;
    const sameDay = row.neurons_day === today;
    const nextNeurons = (sameDay ? row.neurons_today : 0) + neurons;
    const nextReqs = (sameDay ? row.requests_today : 0) + 1;

    this.db
      .prepare(
        `UPDATE accounts
         SET last_used = ?, error_count = 0,
             neurons_today = ?, neurons_day = ?, requests_today = ?
         WHERE id = ?`
      )
      .run(Date.now() / 1000, nextNeurons, today, nextReqs, id);
  }

  stats() {
    const today = todayUTC();
    const total = this._countTotal.get().c;
    const available = this._countAvailable();
    const agg = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN neurons_day = ? THEN neurons_today ELSE 0 END), 0) AS used,
                COALESCE(SUM(CASE WHEN neurons_day = ? THEN requests_today ELSE 0 END), 0) AS reqs
         FROM accounts WHERE is_active = 1`
      )
      .get(today, today);
    const capacity = total * NEURON_FREE_DAILY;
    return {
      total,
      available,
      cooldown: total - available,
      neurons_used_today: Math.round(agg.used),
      neurons_capacity_today: capacity,
      neurons_remaining_today: Math.max(0, Math.round(capacity - agg.used)),
      requests_today: agg.reqs,
    };
  }
}
