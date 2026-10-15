// @ts-check
/**
 * Request accounting: per endpoint, per method and per module, with a rolling 1-hour count.
 * Exposed as window.cvStats and shown in the Diagnostics panel.
 */

class Counter {
  constructor() {
    this.count = 0;
    this.errors = 0;
    this.rateLimited = 0;
    this.subcalls = 0;
    this.lastError = null;
    this.lastErrorAt = 0;
    /** @type {number[]} */
    this.lat = [];
    /** minute index → count */
    this.minutes = new Map();
  }
  add(e) {
    this.count++;
    this.subcalls += e.subcalls || 0;
    if (!e.ok) {
      this.errors++;
      this.lastError = e.error || "error";
      this.lastErrorAt = Date.now();
    }
    if (e.kind === "rate") this.rateLimited++;
    if (e.ms != null) {
      this.lat.push(e.ms);
      if (this.lat.length > 200) this.lat.shift();
    }
    const m = Math.floor(Date.now() / 60000);
    this.minutes.set(m, (this.minutes.get(m) || 0) + 1);
    for (const k of this.minutes.keys()) if (k < m - 60) this.minutes.delete(k);
  }
  lastHour() {
    const m = Math.floor(Date.now() / 60000);
    let n = 0;
    for (const [k, v] of this.minutes) if (k > m - 60) n += v;
    return n;
  }
  pct(p) {
    if (!this.lat.length) return null;
    const s = [...this.lat].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
  }
}

export class Stats {
  constructor() {
    /** @type {Map<string, Counter>} */
    this.map = new Map();
    this.startedAt = Date.now();
    this.skippedTicks = 0;
  }
  _c(key) {
    if (!this.map.has(key)) this.map.set(key, new Counter());
    return this.map.get(key);
  }
  /**
   * @param {{scope:string, endpoint:string, method:string, module?:string, ok:boolean, ms?:number, kind?:string, error?:string, subcalls?:number}} e
   */
  record(e) {
    this._c(`endpoint|${e.scope}|${e.endpoint}`).add(e);
    this._c(`method|${e.scope}|${e.method}`).add(e);
    this._c(`module|${e.module || "-"}`).add(e);
  }
  /** @param {"endpoint"|"method"|"module"} kind */
  rows(kind) {
    const out = [];
    for (const [k, c] of this.map) {
      if (!k.startsWith(kind + "|")) continue;
      out.push({
        key: k.slice(kind.length + 1),
        total: c.count,
        lastHour: c.lastHour(),
        subcalls: c.subcalls,
        errors: c.errors,
        rateLimited: c.rateLimited,
        p50: c.pct(50),
        p95: c.pct(95),
        lastError: c.lastError,
      });
    }
    return out.sort((a, b) => b.lastHour - a.lastHour || b.total - a.total);
  }
  summary() {
    return { since: new Date(this.startedAt).toISOString(), skippedTicks: this.skippedTicks, endpoints: this.rows("endpoint"), methods: this.rows("method"), modules: this.rows("module") };
  }
}
