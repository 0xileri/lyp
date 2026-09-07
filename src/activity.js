/**
 * Rolling-window activity counter.
 *
 * Backs the activity-rate rule. Kept in memory on purpose: this counts what
 * *this instance* has been asked to approve, which is the quantity that matters
 * for detecting a caller stuck in a loop. A shared store would make the number
 * more globally accurate and considerably less useful as a circuit breaker,
 * since it would also make the guardrail fail when the store does.
 */
export class ActivityLog {
  #byActor = new Map();

  /** Actions recorded for `actor` within the window ending at `now`. */
  count(actor, windowMs, now = Date.now()) {
    const events = this.#byActor.get(actor);
    if (!events) return 0;
    const cutoff = now - windowMs;
    // Timestamps are appended in order, so the live tail starts at the first
    // index inside the window.
    let i = 0;
    while (i < events.length && events[i] < cutoff) i += 1;
    if (i > 0) events.splice(0, i);
    return events.length;
  }

  record(actor, now = Date.now()) {
    const events = this.#byActor.get(actor);
    if (events) events.push(now);
    else this.#byActor.set(actor, [now]);
  }

  reset() {
    this.#byActor.clear();
  }
}
