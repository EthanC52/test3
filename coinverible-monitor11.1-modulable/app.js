// @ts-check
/*
 * CoinVertible Dashboard - application code (single ES module, no dependency, no build).
 * Configuration lives in config.js (loaded before this file) and known_addresses.json.
 *
 * Sections, in order:
 *    1. CORE: utilities
 *    2. CORE: exact decimals
 *    3. CORE: localStorage
 *    4. CORE: request accounting
 *    5. CORE: RPC pool
 *    6. CORE: config loader
 *    7. CORE: address labels
 *    8. CORE: results store
 *    9. CORE: cross-tab coordination
 *   10. CORE: scheduler
 *   11. CHAIN: EVM ABI codec
 *   12. CHAIN: EVM adapter
 *   13. CHAIN: Solana adapter
 *   14. CHAIN: Stellar adapter
 *   15. CHAIN: XRPL adapter
 *   16. MODULE: base class
 *   17. MODULE: monitoring.supply
 *   18. MODULE: monitoring.mintburn
 *   19. MODULE: Morpho math
 *   20. MODULE: Morpho discovery
 *   21. MODULE: Morpho
 *   22. MODULE: Uniswap
 *  22c. MODULE: Aggregators (EURCV through DEX aggregators, Uniswap page)
 *  22b. DATA: Coinwatch
 *   23. UI: formatting, icons, logos, tooltip
 *   24. UI: shell and pages
 *   25. MAIN: wiring and boot
 */

/* ================================================================================================
 * 1. CORE: utilities
 * ================================================================================================ */
/** Dashboard version (shown in Diagnostics). */
export const VERSION = "v12";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** +/-pct random jitter around ms. */
export const jitter = (ms, pct = 0.1) => ms * (1 + (Math.random() * 2 - 1) * pct);

export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._l = new Map();
  }
  /** @returns {() => void} unsubscribe */
  on(ev, fn) {
    if (!this._l.has(ev)) this._l.set(ev, new Set());
    this._l.get(ev).add(fn);
    return () => this._l.get(ev)?.delete(fn);
  }
  emit(ev, data) {
    for (const fn of this._l.get(ev) || []) {
      try { fn(data); } catch (e) { console.error(`[emitter] ${ev}`, e); }
    }
  }
}

/** Lowercase EVM addresses, keep other chains' addresses as they are (case-sensitive). */
export function normAddr(chainType, addr) {
  if (!addr) return addr;
  return chainType === "evm" ? String(addr).toLowerCase() : String(addr);
}

export const shortHex = (h, a = 6, b = 4) => (h && h.length > a + b + 2 ? `${h.slice(0, a)}\u2026${h.slice(-b)}` : h || "");

export const isHexAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
export const isHex32 = (a) => /^0x[0-9a-fA-F]{64}$/.test(a || "");

/* ================================================================================================
 * 2. CORE: exact decimals
 * ================================================================================================ */
/**
 * Exact decimal helpers on BigInt. Amounts are computed as integers ("raw" units) and
 * converted to decimal strings only at the edge. Floats are for rates and display only.
 */

/** raw integer -> decimal string, e.g. (1500000n, 6) -> "1.500000" */
export function formatUnits(raw, decimals) {
  const neg = raw < 0n;
  const v = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const int = v.slice(0, v.length - decimals);
  const frac = decimals > 0 ? v.slice(v.length - decimals) : "";
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

/**
 * Decimal string (also "1e7", "1.2E-3") -> raw integer with `decimals` decimals.
 * Digits beyond `decimals` are truncated toward zero.
 */
export function parseUnits(str, decimals) {
  let s = String(str).trim();
  let neg = false;
  if (s[0] === "-") { neg = true; s = s.slice(1); } else if (s[0] === "+") s = s.slice(1);
  const m = s.match(/^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`Invalid decimal: ${str}`);
  const ip = m[1] || "0";
  const fp = m[2] || "";
  const exp = m[3] ? parseInt(m[3], 10) : 0;
  const digits = (ip + fp).replace(/^0+(?=\d)/, "");
  // value = digits x 10^(exp - fp.length); we want value x 10^decimals
  const shift = decimals + exp - fp.length;
  let v = BigInt(digits || "0");
  v = shift >= 0 ? v * 10n ** BigInt(shift) : v / 10n ** BigInt(-shift);
  return neg ? -v : v;
}

/** Rescale a raw integer from one number of decimals to another (truncating). */
export function rescale(raw, fromDec, toDec) {
  if (toDec === fromDec) return raw;
  return toDec > fromDec ? raw * 10n ** BigInt(toDec - fromDec) : raw / 10n ** BigInt(fromDec - toDec);
}

/** raw -> float (display / ratios only). */
export function toNumber(raw, decimals) {
  if (raw == null) return null;
  return Number(formatUnits(raw, decimals));
}

/* ================================================================================================
 * 3. CORE: localStorage
 * ================================================================================================ */
/**
 * Safe, namespaced localStorage. Every access is wrapped: the app must work without storage
 * (private mode, blocked site data). BigInt values survive a round trip.
 */
const NS = "cv:v1:";

function replacer(_k, v) {
  return typeof v === "bigint" ? { __big: v.toString() } : v;
}
function reviver(_k, v) {
  return v && typeof v === "object" && typeof v.__big === "string" && Object.keys(v).length === 1 ? BigInt(v.__big) : v;
}

function ls() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = ls()?.getItem(NS + key);
      return raw == null ? fallback : JSON.parse(raw, reviver);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      ls()?.setItem(NS + key, JSON.stringify(value, replacer));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try { ls()?.removeItem(NS + key); } catch { /* ignore */ }
  },
  /** Keys (without namespace) starting with prefix. */
  keys(prefix = "") {
    try {
      const s = ls();
      if (!s) return [];
      const out = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(NS + prefix)) out.push(k.slice(NS.length));
      }
      return out;
    } catch {
      return [];
    }
  },
  /** Remove every key of this app (all versions of the namespace prefix "cv:"). */
  clearAll() {
    try {
      const s = ls();
      if (!s) return;
      const del = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith("cv:")) del.push(k);
      }
      del.forEach((k) => s.removeItem(k));
    } catch { /* ignore */ }
  },
};

/** For BroadcastChannel payloads (structured clone handles BigInt, but keep one format). */
export const serialize = (v) => JSON.stringify(v, replacer);
export const deserialize = (s) => JSON.parse(s, reviver);

/* ================================================================================================
 * 4. CORE: request accounting
 * ================================================================================================ */
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
    /** minute index -> count */
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

/* ================================================================================================
 * 5. CORE: RPC pool
 * ================================================================================================ */
/**
 * One pool per chain (or API). Spreads requests over every configured endpoint:
 * - token bucket per endpoint (maxRps): requests wait instead of being rejected
 * - smooth weighted round-robin among healthy endpoints that pass the request's filter
 * - failover to the next endpoint on timeout / HTTP error / rate limit / endpoint-side RPC error
 * - cooldown per failing endpoint (5 s -> 10 s -> ... -> 5 min), Retry-After and RateLimit-* headers honoured
 * - "execution reverted" is a real answer: returned to the caller, no failover
 */

export class RpcError extends Error {
  /**
   * @param {string} message
   * @param {{kind?: string, code?: number|string, endpoint?: string, retryAfterMs?: number}} [o]
   */
  constructor(message, o = {}) {
    super(message);
    this.name = "RpcError";
    /** revert | rate | range | depth | http | timeout | network | rpc | unavailable */
    this.kind = o.kind || "rpc";
    this.code = o.code;
    this.endpoint = o.endpoint;
    this.retryAfterMs = o.retryAfterMs;
  }
}

/** Classify a JSON-RPC error message from any provider. */
export function classifyRpcError(err) {
  const msg = String(err?.message || err || "");
  const code = err?.code;
  if (/revert/i.test(msg) || code === 3) return "revert";
  if (/archive|personal token|pruned|missing trie|historical|not available on this node/i.test(msg)) return "depth";
  if (/range|block range|too many blocks|too large|limit of \d+|max range|more than \d+ (results|logs)|response size|query returned more/i.test(msg)) return "range";
  if (/rate|too many requests|exceeded|usage limit|capacity|throttl|429|quota/i.test(msg) || code === -32005 || code === -32029 || code === 429) return "rate";
  return "rpc";
}

const COOLDOWN_BASE = 5000;
const COOLDOWN_MAX = 300000;

export class RpcPool {
  /**
   * @param {string} scope chain key or API name (for stats)
   * @param {Array<any>} endpoints
   * @param {{timeoutMs?: number, stats?: import("./stats.js").Stats}} [o]
   */
  constructor(scope, endpoints, o = {}) {
    this.scope = scope;
    this.timeoutMs = o.timeoutMs || 8000;
    this.stats = o.stats;
    this.eps = (endpoints || []).filter((e) => e && e.url).map((e, i) => ({
      id: e.id || `ep${i + 1}`,
      url: String(e.url).replace(/\/$/, ""),
      maxRps: e.maxRps > 0 ? e.maxRps : 2,
      weight: e.weight > 0 ? e.weight : 1,
      capabilities: new Set(e.capabilities || ["calls", "logs"]),
      maxMulticallSize: e.maxMulticallSize || 150,
      maxLogRange: e.maxLogRange || 5000,
      logDepth: e.logDepth == null ? Infinity : e.logDepth,
      // JSON-RPC batch: max requests per batch (0 or 1 = no batch). Learned downwards on errors.
      maxBatch: e.maxBatch == null ? 20 : e.maxBatch,
      // runtime state
      tokens: Math.max(1, e.maxRps || 2),
      lastRefill: Date.now(),
      cooldownUntil: 0,
      fails: 0,
      cw: 0,
      gate: Promise.resolve(),
      lastError: null,
    }));
  }

  /** Smallest value of a numeric endpoint field among endpoints passing filter. */
  minOf(field, filter = () => true) {
    let m = Infinity;
    for (const ep of this.eps) if (filter(ep)) m = Math.min(m, ep[field]);
    return m;
  }

  /** Largest value of a numeric endpoint field among endpoints passing filter (healthy ones first). */
  maxOf(field, filter = () => true) {
    const now = Date.now();
    let healthy = -Infinity, any = -Infinity;
    for (const ep of this.eps) {
      if (!filter(ep)) continue;
      any = Math.max(any, ep[field]);
      if (now >= ep.cooldownUntil) healthy = Math.max(healthy, ep[field]);
    }
    return Number.isFinite(healthy) ? healthy : any;
  }

  health() {
    const now = Date.now();
    return this.eps.map((ep) => ({ id: ep.id, url: ep.url, healthy: now >= ep.cooldownUntil, cooldownMs: Math.max(0, ep.cooldownUntil - now), lastError: ep.lastError }));
  }

  _refill(ep) {
    const now = Date.now();
    const cap = Math.max(1, ep.maxRps);
    ep.tokens = Math.min(cap, ep.tokens + ((now - ep.lastRefill) / 1000) * ep.maxRps);
    ep.lastRefill = now;
  }

  /** Wait for a token on ep. Acquisitions on one endpoint are serialised. */
  _acquire(ep) {
    const p = ep.gate.then(async () => {
      for (;;) {
        this._refill(ep);
        if (ep.tokens >= 1) { ep.tokens -= 1; return; }
        await sleep(Math.ceil(((1 - ep.tokens) / ep.maxRps) * 1000));
      }
    });
    ep.gate = p.catch(() => {});
    return p;
  }

  /** Pick the next endpoint (smooth weighted round-robin), preferring one with a free token. */
  _pick(filter, exclude) {
    const now = Date.now();
    const eligible = this.eps.filter((ep) => !exclude.has(ep) && now >= ep.cooldownUntil && filter(ep));
    if (!eligible.length) return null;
    eligible.forEach((ep) => this._refill(ep));
    const ready = eligible.filter((ep) => ep.tokens >= 1);
    const cands = ready.length ? ready : eligible;
    const total = cands.reduce((s, ep) => s + ep.weight, 0);
    let best = cands[0];
    for (const ep of cands) {
      ep.cw += ep.weight;
      if (ep.cw > best.cw) best = ep;
    }
    best.cw -= total;
    return best;
  }

  _cooldown(ep, err) {
    ep.fails++;
    const backoff = Math.min(COOLDOWN_MAX, COOLDOWN_BASE * 2 ** (ep.fails - 1));
    ep.cooldownUntil = Date.now() + Math.max(backoff, err?.retryAfterMs || 0);
  }

  /**
   * Run fn(ep) on endpoints until one succeeds.
   * @template T
   * @param {(ep:any) => Promise<T>} fn
   * @param {{method: string, module?: string, filter?: (ep:any)=>boolean, subcalls?: number, onError?: (ep:any, err:RpcError)=>void, info?: any, finalKinds?: string[]}} o
   * @returns {Promise<T>}
   */
  async send(fn, o) {
    const filter = o.filter || (() => true);
    const tried = new Set();
    let lastErr = null;
    for (let attempt = 0; attempt < this.eps.length; attempt++) {
      const ep = this._pick(filter, tried);
      if (!ep) break;
      tried.add(ep);
      await this._acquire(ep);
      const t0 = performance.now();
      try {
        const res = await fn(ep);
        ep.fails = 0;
        this.stats?.record({ scope: this.scope, endpoint: ep.id, method: o.method, module: o.module, ok: true, ms: performance.now() - t0, subcalls: o.subcalls });
        if (o.info) o.info.endpoint = ep.id;
        return res;
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError(String(e?.message || e), { kind: "network" });
        err.endpoint = ep.id;
        ep.lastError = `${err.kind}: ${err.message}`.slice(0, 200);
        this.stats?.record({ scope: this.scope, endpoint: ep.id, method: o.method, module: o.module, ok: false, ms: performance.now() - t0, kind: err.kind, error: ep.lastError, subcalls: o.subcalls });
        if (err.kind === "revert") throw err;
        // APIs with one endpoint (Coinwatch): an auth / not-found / bad-request answer is final, no cooldown
        if (o.finalKinds?.includes(err.kind)) throw err;
        o.onError?.(ep, err);
        if (["rate", "http", "timeout", "network", "rpc", "auth", "notfound", "bad"].includes(err.kind)) this._cooldown(ep, err);
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    throw new RpcError(`${this.scope}: no endpoint available (all cooling down or none matches)`, { kind: "unavailable" });
  }

  /** fetch with timeout + HTTP/RateLimit handling. */
  async _fetch(ep, url, init, timeoutMs) {
    const ctrl = new AbortController();
    const ms = timeoutMs || this.timeoutMs;
    const timer = setTimeout(() => ctrl.abort(), ms);
    let r;
    try {
      r = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (e?.name === "AbortError") throw new RpcError(`timeout after ${ms} ms`, { kind: "timeout" });
      throw new RpcError(`network/CORS error: ${e?.message || e}`, { kind: "network" });
    } finally {
      clearTimeout(timer);
    }
    // Pre-emptive slow-down when the endpoint exposes its remaining quota (Horizon does).
    const rem = Number(r.headers.get("ratelimit-remaining"));
    const lim = Number(r.headers.get("ratelimit-limit"));
    const reset = Number(r.headers.get("ratelimit-reset"));
    // RateLimit-Reset: seconds to wait (Horizon) or an absolute Unix time (Coinwatch)
    const resetMs = !Number.isFinite(reset) ? null : reset > 1e9 ? Math.max(0, reset * 1000 - Date.now()) : reset * 1000;
    if (Number.isFinite(rem) && Number.isFinite(lim) && lim > 0 && rem <= Math.max(1, lim * 0.02) && resetMs != null) {
      ep.cooldownUntil = Math.max(ep.cooldownUntil, Date.now() + resetMs);
    }
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after"));
      throw new RpcError("HTTP 429", { kind: "rate", code: 429, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : resetMs ?? undefined });
    }
    if (!r.ok) {
      // problem+json bodies (RFC 7807) carry a readable "detail"
      let detail = "";
      try { const j = await r.json(); detail = j?.detail || j?.title || ""; } catch { /* no body */ }
      const kind = r.status === 413 ? "range" : r.status === 401 || r.status === 403 ? "auth" : r.status === 404 ? "notfound" : r.status === 400 ? "bad" : "http";
      throw new RpcError(`HTTP ${r.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`, { kind, code: r.status });
    }
    try {
      return await r.json();
    } catch {
      throw new RpcError("invalid JSON response", { kind: "http" });
    }
  }

  /**
   * JSON-RPC 2.0 call.
   * @param {string} method
   * @param {any[]} params
   * @param {{module?: string, filter?: (ep:any)=>boolean, subcalls?: number, onError?: Function, info?: any, label?: string, timeoutMs?: number}} [o]
   */
  jsonRpc(method, params, o = {}) {
    return this.send(async (ep) => {
      const body = await this._fetch(ep, ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }, o.timeoutMs);
      if (body?.error) {
        const kind = classifyRpcError(body.error);
        throw new RpcError(body.error.message || JSON.stringify(body.error), { kind, code: body.error.code });
      }
      return body?.result;
    }, { ...o, method: o.label || method });
  }

  /**
   * JSON-RPC 2.0 batch: one HTTP request carrying paramsList.length calls of the same method.
   * Only endpoints whose maxBatch covers the size are used; an endpoint that refuses the batch (non-array
   * answer, HTTP 4xx/413) gets a smaller maxBatch and the batch goes to the next endpoint.
   * Resolves with one result per params (null for an item the endpoint did not answer: retry it later).
   * @param {string} method @param {any[][]} paramsList
   * @param {{module?: string, filter?: (ep:any)=>boolean, label?: string, timeoutMs?: number}} [o]
   */
  jsonRpcBatch(method, paramsList, o = {}) {
    const n = paramsList.length;
    const filter = o.filter || (() => true);
    return this.send(async (ep) => {
      let body;
      try {
        body = await this._fetch(ep, ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(paramsList.map((params, id) => ({ jsonrpc: "2.0", id, method, params }))),
        }, o.timeoutMs);
      } catch (e) {
        if (e instanceof RpcError && ["bad", "range", "http", "auth"].includes(e.kind)) throw new RpcError(`batch of ${n} refused: ${e.message}`, { kind: "batch", code: e.code });
        throw e;
      }
      if (!Array.isArray(body)) {
        const err = body?.error;
        const kind = err && classifyRpcError(err) === "rate" ? "rate" : "batch";
        throw new RpcError(`batch of ${n} refused: ${err?.message || "answer is not an array"}`, { kind, code: err?.code });
      }
      const out = new Array(n).fill(null);
      let rate = 0;
      for (const x of body) {
        if (!x || typeof x.id !== "number" || x.id < 0 || x.id >= n) continue;
        if (x.error) { if (classifyRpcError(x.error) === "rate") rate++; continue; }
        out[x.id] = x.result ?? null;
      }
      // every item refused for rate: the endpoint is saturated, let the pool cool it down
      if (rate && out.every((v) => v == null)) throw new RpcError(`batch of ${n}: rate limited`, { kind: "rate" });
      return out;
    }, {
      ...o, method: o.label || `${method} (batch)`, subcalls: n,
      filter: (ep) => filter(ep) && ep.maxBatch >= n,
      onError: (ep, err) => { if (err.kind === "batch") ep.maxBatch = n > 2 ? Math.floor(n / 2) : 0; },
    });
  }

  /** REST GET relative to the endpoint base URL. */
  getJson(path, o = {}) {
    return this.send((ep) => this._fetch(ep, ep.url + path, { method: "GET", headers: o.headers }), { ...o, method: o.label || "GET " + path.split("?")[0] });
  }

  /** REST POST JSON relative to the endpoint base URL. */
  postJson(path, payload, o = {}) {
    return this.send((ep) => this._fetch(ep, ep.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }), { ...o, method: o.label || "POST " + (path || "/") });
  }
}

/* ================================================================================================
 * 6. CORE: config loader
 * ================================================================================================ */
/**
 * Loads the config modules, the known addresses file and the per-user RPC overrides,
 * and validates everything once at startup.
 */

const SETTINGS_KEY = "settings";

/** Per-user overrides saved by the settings dialog: { rpc: { [chainKey]: string[] } } */
export function getSettings() {
  return storage.get(SETTINGS_KEY, { rpc: {} }) || { rpc: {} };
}
export function saveSettings(s) {
  return storage.set(SETTINGS_KEY, s);
}

/** Endpoints entered by a user: unknown limits, so conservative defaults (the pool learns tighter ones). */
function overrideEndpoint(url, i, type) {
  const ep = { id: `custom-${i + 1}`, url, maxRps: 3, weight: 1 };
  if (type === "evm") Object.assign(ep, { capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 5000 });
  return ep;
}

async function loadKnownAddresses() {
  try {
    const url = new URL("known_addresses.json", import.meta.url);
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { data: await r.json(), error: null };
  } catch (e) {
    return { data: {}, error: `known_addresses.json could not be loaded (${e?.message || e})` };
  }
}

export async function loadConfig() {
  const C = globalThis.CV_CONFIG;
  if (!C) throw new Error("config.js is not loaded (globalThis.CV_CONFIG is missing)");
  const CHAINS = C.chains, APIS = C.apis, REQUEST_TIMEOUT_MS = C.requestTimeoutMs || 8000;
  const FREQUENCY = C.frequency, UNISWAP = C.uniswap;
  // A deployment with an empty address (or mint / issuer) is a placeholder for a token not deployed yet on
  // that chain: it is dropped here, so the rest of the app only sees real deployments.
  const placeholder = (d) => !d || !(d.address || d.mint || d.code || d.currency);
  const TOKENS = Object.fromEntries(Object.entries(C.tokens).map(([sym, t]) => [sym, { ...t, deployments: Object.fromEntries(Object.entries(t.deployments || {}).filter(([, d]) => !placeholder(d))) }]));
  const errors = [];
  const warnings = [];
  const settings = getSettings();

  /** @type {Record<string, any>} */
  const chains = {};
  for (const [key, c] of Object.entries(CHAINS)) {
    const urls = (settings.rpc?.[key] || []).map((u) => String(u).trim()).filter(Boolean);
    const endpoints = urls.length ? urls.map((u, i) => overrideEndpoint(u, i, c.type)) : c.endpoints;
    chains[key] = { ...c, key, endpoints, overridden: urls.length > 0 };
    if (!c.enabled) continue;
    if (!["evm", "solana", "stellar", "xrpl"].includes(c.type)) errors.push(`chains.${key}: unknown type "${c.type}"`);
    if (!endpoints.length) errors.push(`chains.${key}: no endpoint`);
    for (const ep of endpoints) if (!/^https?:\/\//.test(ep.url || "")) errors.push(`chains.${key}: invalid endpoint URL "${ep.url}"`);
    if (c.type === "evm" && !isHexAddress(c.multicall3)) errors.push(`chains.${key}: invalid multicall3 address`);
    if (!(FREQUENCY.chains[key] > 0)) errors.push(`frequency.chains.${key}: missing or not > 0`);
  }

  for (const [mod, per] of Object.entries(FREQUENCY.modules)) {
    for (const [k, v] of Object.entries(per)) {
      if (v != null && !(v > 0)) errors.push(`frequency.modules["${mod}"].${k}: must be null or > 0`);
      if (!(k in FREQUENCY.chains) && !(k in FREQUENCY.apis)) warnings.push(`frequency.modules["${mod}"].${k}: unknown chain/api`);
    }
  }

  for (const [sym, t] of Object.entries(TOKENS)) {
    for (const [chain, d] of Object.entries(t.deployments)) {
      if (!CHAINS[chain]) { errors.push(`tokens.${sym}: unknown chain "${chain}"`); continue; }
      const type = CHAINS[chain].type;
      if (type === "evm" && !isHexAddress(d.address)) errors.push(`tokens.${sym}.${chain}: invalid address`);
      if (type === "solana" && !d.mint) errors.push(`tokens.${sym}.${chain}: missing mint`);
      if (type === "stellar" && !(d.code && d.issuer)) errors.push(`tokens.${sym}.${chain}: missing code/issuer`);
      if (type === "xrpl" && !(d.currency && d.issuer)) errors.push(`tokens.${sym}.${chain}: missing currency/issuer`);
    }
  }

  // Morpho: one entry per chain in morpho.chains (older configs: morpho.chain + morphoBlue + appUrl). A chain is
  // read when it is enabled and the asset is deployed on it; vaults / markets without "chain" are on the first one.
  const M0 = C.morpho;
  const mChains = M0.chains || (M0.chain ? { [M0.chain]: { morphoBlue: M0.morphoBlue, appUrl: M0.appUrl } } : {});
  const firstChain = Object.keys(mChains)[0];
  const MORPHO = {
    ...M0,
    chains: mChains,
    vaults: (M0.vaults || []).map((v) => ({ ...v, chain: v.chain || firstChain })),
    markets: (M0.markets || []).map((m) => ({ ...m, chain: m.chain || firstChain })),
    active: Object.keys(mChains).filter((c) => CHAINS[c]?.enabled && CHAINS[c].type === "evm" && TOKENS[M0.asset]?.deployments?.[c]),
  };
  for (const [c, x] of Object.entries(mChains)) {
    if (!CHAINS[c]) errors.push(`morpho.chains: unknown chain "${c}"`);
    else if (MORPHO.active.includes(c) && !isHexAddress(x.morphoBlue)) errors.push(`morpho.chains.${c}: invalid morphoBlue address`);
  }
  for (const v of MORPHO.vaults) {
    if (!isHexAddress(v.address)) errors.push(`morpho.vaults: invalid address ${v.address}`);
    if (!mChains[v.chain]) errors.push(`morpho.vaults: chain "${v.chain}" of ${v.address} is not in morpho.chains`);
  }
  for (const m of MORPHO.markets) {
    if (!isHex32(m.id)) errors.push(`morpho.markets: invalid market id ${m.id}`);
    if (!mChains[m.chain]) errors.push(`morpho.markets: chain "${m.chain}" of ${m.id} is not in morpho.chains`);
  }
  if (!MORPHO.active.length) warnings.push(`morpho: ${M0.asset} is deployed on no enabled chain of morpho.chains - the Morpho page stays empty`);
  for (const p of UNISWAP.pools) {
    const v = p.version || "v3";
    if (!["v2", "v3", "v4"].includes(v)) errors.push(`uniswap.pools: unknown version "${v}" for ${p.label}`);
    if (v === "v4" ? !isHex32(p.id) : !isHexAddress(p.address)) errors.push(`uniswap.pools: ${v === "v4" ? "invalid pool id (bytes32)" : "invalid address"} for ${p.label}`);
    if (v === "v4" && !(UNISWAP.v4?.stateView && UNISWAP.v4?.positionManager && UNISWAP.v4?.poolManager)) errors.push("uniswap.v4: stateView, positionManager and poolManager are needed for v4 pools");
    if (!/^[a-z0-9-]+$/.test(p.slug || "")) errors.push(`uniswap.pools: missing or invalid slug for ${p.label || p.address} (lowercase letters, digits, "-")`);
  }
  for (const k of ["npm", "tickLens"]) if (!isHexAddress(UNISWAP[k])) errors.push(`uniswap.${k}: invalid address`);

  const AGG = C.aggregators;
  if (AGG) {
    if (!CHAINS[AGG.chain] || CHAINS[AGG.chain].type !== "evm") errors.push(`aggregators.chain: "${AGG.chain}" is not an EVM chain of the config`);
    if (!TOKENS[AGG.token]?.deployments?.[AGG.chain]) errors.push(`aggregators.token: ${AGG.token} not deployed on ${AGG.chain}`);
    const seen = new Set();
    for (const g of AGG.list || []) {
      if (!g.id || seen.has(g.id)) errors.push(`aggregators.list: missing or duplicate id "${g.id}"`);
      seen.add(g.id);
      for (const a of g.contracts || []) if (!isHexAddress(a)) errors.push(`aggregators.list.${g.id}: invalid address ${a}`);
      if (g.registry && !isHexAddress(g.registry.address)) errors.push(`aggregators.list.${g.id}: invalid registry address`);
      if (![1, 2, 3].includes(g.layer ?? 2)) errors.push(`aggregators.list.${g.id}: layer must be 1, 2 or 3`);
    }
    if ((AGG.list || []).length > 8) warnings.push("aggregators.list: more than 8 aggregators - colours repeat after 8");
    for (const a of AGG.walletContracts || []) if (!isHexAddress(a)) errors.push(`aggregators.walletContracts: invalid address ${a}`);
  }

  const known = await loadKnownAddresses();
  if (known.error) warnings.push(known.error);

  return {
    chains,
    apis: APIS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    frequency: FREQUENCY,
    tokens: TOKENS,
    morpho: MORPHO,
    uniswap: UNISWAP,
    aggregators: AGG?.list?.length ? AGG : null,
    coinwatch: C.coinwatch || { tokens: {} },
    logos: C.logos || {},
    known: known.data,
    settings,
    errors,
    warnings,
  };
}

/* ================================================================================================
 * 7. CORE: address labels
 * ================================================================================================ */
/**
 * Address labels. Priority: known_addresses.json > on-chain roles > Morpho names > none.
 */

const PRIORITY = { file: 3, role: 2, morpho: 1 };

export class Labels extends Emitter {
  /** @param {Record<string, Record<string, {label:string, type?:string}>>} known @param {Record<string, any>} chains */
  constructor(known, chains) {
    super();
    this.chains = chains;
    /** @type {Map<string, {label:string, source:string, type?:string, roles?:Map<string,Set<string>>}>} */
    this.map = new Map();
    for (const [chain, entries] of Object.entries(known || {})) {
      for (const [addr, v] of Object.entries(entries || {})) {
        if (!v || !v.label) continue;
        this.map.set(this._k(chain, addr), { label: v.label, type: v.type, source: "file" });
      }
    }
  }
  _k(chain, addr) {
    return `${chain}|${normAddr(this.chains[chain]?.type, addr)}`;
  }
  /** Generic automatic label (Morpho names...). */
  setAuto(chain, addr, label, source = "morpho") {
    if (!addr || !label) return;
    const k = this._k(chain, addr);
    const cur = this.map.get(k);
    if (cur && PRIORITY[cur.source] >= PRIORITY[source]) return;
    this.map.set(k, { label, source });
    this.emit("change");
  }
  /** Role label merged across tokens: "Registrar (EURCV, USDCV)". */
  setRole(chain, addr, role, token) {
    if (!addr || /^0x0{40}$/i.test(addr)) return;
    const k = this._k(chain, addr);
    const cur = this.map.get(k);
    if (cur && cur.source === "file") return;
    const roles = cur?.source === "role" && cur.roles ? cur.roles : new Map();
    if (!roles.has(role)) roles.set(role, new Set());
    const before = roles.get(role).size;
    roles.get(role).add(token);
    const label = [...roles].map(([r, toks]) => `${r} (${[...toks].join(", ")})`).join(" \u00b7 ");
    this.map.set(k, { label, source: "role", roles });
    if (!cur || roles.get(role).size !== before) this.emit("change");
  }
  /** @returns {{address:string, label:string|null, source:string|null}} */
  resolve(chain, addr) {
    const v = this.map.get(this._k(chain, addr));
    return { address: addr, label: v?.label || null, source: v?.source || null };
  }
}

/* ================================================================================================
 * 8. CORE: results store
 * ================================================================================================ */
/**
 * Results of every module, keyed by store id. Results are cached in localStorage so a reload
 * shows the last known values (flagged `cached`) until the first tick refreshes them.
 */

const CACHE_EVERY_MS = 10000;

export class Store extends Emitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.results = new Map();
    this._cachedAt = new Map();
  }

  get(id) {
    return this.results.get(id) || null;
  }

  /**
   * @param {string} id
   * @param {any} envelope
   * @param {{remote?: boolean}} [o] remote = received from the leader tab
   */
  set(id, envelope, o = {}) {
    this.results.set(id, envelope);
    if (!o.remote) {
      const last = this._cachedAt.get(id) || 0;
      if (Date.now() - last > CACHE_EVERY_MS) {
        storage.set(`result:${id}`, envelope);
        this._cachedAt.set(id, Date.now());
      }
      this.emit("local", { id, envelope });
    }
    this.emit("change", id);
  }

  /** Load cached results (shown as cached until refreshed). */
  loadCached() {
    for (const k of storage.keys("result:")) {
      const env = storage.get(k);
      if (env && env.module) this.results.set(k.slice("result:".length), { ...env, cached: true });
    }
    this.emit("change", "*");
  }
}

/* ================================================================================================
 * 9. CORE: cross-tab coordination
 * ================================================================================================ */
/**
 * Cross-tab coordination.
 *
 * Leadership: one tab per page holds the Web Lock "cv:page:<page>" and polls. Other tabs on the
 * same page are followers: they receive results over a BroadcastChannel and make no request.
 * A hidden tab releases its lock (pauseWhenHidden), so a visible tab takes over.
 *
 * Gates: "Show more" sections are only polled while expanded. A tab with an expanded section sends
 * a heartbeat so the leader polls it even if the leader's own section is collapsed.
 */

const CHANNEL = "cv:v1";
const GATE_HEARTBEAT_MS = 10000;
const GATE_TTL_MS = 25000;

export class Tabs extends Emitter {
  /** @param {{shareAcrossTabs:boolean, pauseWhenHidden:boolean}} o */
  constructor(o) {
    super();
    this.share = !!o.shareAcrossTabs && typeof navigator !== "undefined" && !!navigator.locks && typeof BroadcastChannel !== "undefined";
    this.pauseWhenHidden = !!o.pauseWhenHidden;
    this.page = null;
    /** "leader" | "follower" | "hidden" | "idle" */
    this.role = "idle";
    this._abort = null;
    this._release = null;
    this._token = 0;
    this.channel = this.share ? new BroadcastChannel(CHANNEL) : null;
    this.channel?.addEventListener("message", (ev) => this.emit("message", ev.data));

    /** gates open locally / seen from other tabs */
    this.localGates = new Set();
    /** @type {Map<string, number>} */
    this.remoteGates = new Map();
    this.on("message", (m) => {
      if (m?.type === "gate" && m.open) { this.remoteGates.set(m.id, Date.now() + GATE_TTL_MS); this.emit("gates"); }
    });
    if (this.channel) setInterval(() => this.localGates.forEach((id) => this.post({ type: "gate", id, open: true })), GATE_HEARTBEAT_MS);

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (!this.pauseWhenHidden) return;
        if (document.hidden) this._setRole("hidden"), this._releaseLock();
        else this._acquire();
      });
    }
  }

  post(msg) {
    try { this.channel?.postMessage(msg); } catch { /* ignore */ }
  }

  setPage(page) {
    if (this.page === page) return;
    this.page = page;
    this._acquire();
  }

  _setRole(role) {
    if (this.role === role) return;
    this.role = role;
    this.emit("role", role);
  }

  _releaseLock() {
    this._token++;
    this._abort?.abort();
    this._abort = null;
    this._release?.();
    this._release = null;
  }

  _acquire() {
    this._releaseLock();
    if (!this.page) return;
    if (this.pauseWhenHidden && typeof document !== "undefined" && document.hidden) { this._setRole("hidden"); return; }
    if (!this.share) { this._setRole("leader"); return; }
    const token = this._token;
    const ctrl = new AbortController();
    this._abort = ctrl;
    this._setRole("follower");
    this.post({ type: "hello", page: this.page });
    navigator.locks
      .request(`cv:page:${this.page}`, { signal: ctrl.signal }, () => new Promise((resolve) => {
        if (token !== this._token) return resolve(undefined);
        this._release = () => resolve(undefined);
        this._setRole("leader");
      }))
      .catch(() => { /* aborted */ });
  }

  isLeader() {
    return this.role === "leader";
  }

  /** Open/close a gate locally. */
  setGate(id, open) {
    if (open) this.localGates.add(id); else this.localGates.delete(id);
    if (open) this.post({ type: "gate", id, open: true });
    this.emit("gates");
  }

  gateOpen(id) {
    if (this.localGates.has(id)) return true;
    const until = this.remoteGates.get(id);
    return !!until && until > Date.now();
  }
}

/* ================================================================================================
 * 10. CORE: scheduler
 * ================================================================================================ */
/**
 * One loop per chain (or API). On each tick it finds the module schedules of the visible page that
 * are due on this chain, opens one tick context (EVM: one eth_blockNumber + block pin), and runs
 * them together so their reads are coalesced.
 */

export class Scheduler {
  /** @param {any} app */
  constructor(app) {
    this.app = app;
    this.page = null;
    this.running = false;
    /** @type {Map<string, {timer:any, busy:boolean}>} */
    this.loops = new Map();
    /** key `${scheduleId}@${chain}` -> { at, block } */
    this.last = new Map();
  }

  /** Interval of a chain or "api:<name>" in seconds. */
  baseInterval(chain) {
    const f = this.app.config.frequency;
    if (chain.startsWith("api:")) return f.apis[chain.slice(4)] || 60;
    return f.chains[chain] || 60;
  }

  /** Interval of one schedule on one chain, rounded up to a multiple of the chain interval. */
  interval(scheduleId, chain) {
    const base = this.baseInterval(chain);
    const short = chain.startsWith("api:") ? chain.slice(4) : chain;
    const v = this.app.config.frequency.modules?.[scheduleId]?.[short];
    return v == null ? base : Math.ceil(v / base) * base;
  }

  setPage(page) {
    this.page = page;
    if (this.running) this._sync(true);
  }

  start() {
    this.running = true;
    this._sync(true);
  }

  stop() {
    this.running = false;
    for (const l of this.loops.values()) clearTimeout(l.timer);
    this.loops.clear();
  }

  /** Run a chain now (e.g. a "Show more" section was opened). */
  kick(chain) {
    if (!this.running) return;
    if (chain) this._run(chain, true);
    else this._sync(true);
  }

  _modulesOn(chain) {
    return this.app.modules.filter((m) => m.page === this.page && m.chains.includes(chain));
  }

  _activeChains() {
    const set = new Set();
    for (const m of this.app.modules) if (m.page === this.page) m.chains.forEach((c) => set.add(c));
    return [...set];
  }

  _sync(runNow) {
    const active = new Set(this._activeChains());
    for (const [chain, l] of this.loops) if (!active.has(chain)) { clearTimeout(l.timer); this.loops.delete(chain); }
    for (const chain of active) {
      if (!this.loops.has(chain)) this.loops.set(chain, { timer: null, busy: false });
      if (runNow) this._run(chain, true);
    }
  }

  _schedule(chain) {
    const l = this.loops.get(chain);
    if (!l || !this.running) return;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => this._run(chain, false), jitter(this.baseInterval(chain) * 1000, 0.1));
  }

  async _run(chain, force) {
    const l = this.loops.get(chain);
    if (!l || !this.running) return;
    if (l.busy) { this.app.stats.skippedTicks++; return; }
    l.busy = true;
    clearTimeout(l.timer);
    try {
      await this._tick(chain, force);
    } catch (e) {
      console.error(`[scheduler] ${chain}`, e);
    } finally {
      l.busy = false;
      this._schedule(chain);
    }
  }

  async _tick(chain) {
    const now = Date.now();
    const halfBase = this.baseInterval(chain) * 500;
    /** @type {{module:any, ids:string[]}[]} */
    let due = [];
    for (const m of this._modulesOn(chain)) {
      const ids = m.schedules
        .filter((s) => !s.chains || s.chains.includes(chain))
        .filter((s) => !s.gate || this.app.tabs.gateOpen(s.gate))
        .filter((s) => {
          const last = this.last.get(`${s.id}@${chain}`);
          return !last || now - last.at >= this.interval(s.id, chain) * 1000 - halfBase;
        })
        .map((s) => s.id);
      if (ids.length) due.push({ module: m, ids });
    }
    if (!due.length) return;

    const adapter = this.app.adapters[chain];
    let ctx = { chain };
    if (adapter?.beginTick) {
      try {
        ctx = await adapter.beginTick();
      } catch (e) {
        due.forEach((d) => d.module.fail(chain, e, d.ids));
        return;
      }
      if (this.app.config.frequency.behaviour.skipIfSameBlock) {
        due = due
          .map((d) => ({ ...d, ids: d.ids.filter((id) => this.last.get(`${id}@${chain}`)?.block !== ctx.head) }))
          .filter((d) => d.ids.length);
        if (!due.length) return;
      }
    }

    await Promise.all(due.map(async (d) => {
      try {
        await d.module.run(chain, ctx, d.ids);
      } catch (e) {
        console.warn(`[${d.module.id}] ${chain}:`, e);
        d.module.fail(chain, e, d.ids);
      } finally {
        for (const id of d.ids) this.last.set(`${id}@${chain}`, { at: Date.now(), block: ctx.head });
      }
    }));
  }
}

/* ================================================================================================
 * 11. CHAIN: EVM ABI codec
 * ================================================================================================ */
/**
 * Minimal ABI codec. Every call we make only uses static types (uint, int, address, bytes32,
 * static tuples), so no general ABI library is needed. Selectors and topics are precomputed
 * (keccak256 is not available in the browser without a dependency).
 */

export const SIG = {
  // ERC-20
  totalSupply: "0x18160ddd", // totalSupply()
  decimals: "0x313ce567", // decimals()
  symbol: "0x95d89b41", // symbol()
  name: "0x06fdde03", // name()
  balanceOf: "0x70a08231", // balanceOf(address)
  // ERC-4626
  asset: "0x38d52e0f", // asset()
  totalAssets: "0x01e1d114", // totalAssets()
  // Multicall3
  aggregate3: "0x82ad56cb", // aggregate3((address,bool,bytes)[])
  getCurrentBlockTimestamp: "0x0f28c97d", // getCurrentBlockTimestamp()
  // SmartCoin (EURCV / USDCV)
  registrar: "0x2b20e397", // registrar()
  operations: "0x8b33b4b2", // operations()
  technical: "0x9d8a4965", // technical()
  // Morpho Blue
  market: "0x5c60e39a", // market(bytes32)
  idToMarketParams: "0x2c3c9157", // idToMarketParams(bytes32)
  position: "0x93c52062", // position(bytes32,address)
  // IRM
  borrowRateView: "0x8c00bf6b", // borrowRateView((address,address,address,address,uint256),(uint128 x6))
  // MetaMorpho V1
  fee: "0xddca3f43", // fee()
  withdrawQueueLength: "0x33f91ebb", // withdrawQueueLength()
  withdrawQueue: "0x62518ddf", // withdrawQueue(uint256)
  // Morpho Vault V2
  _totalAssets: "0xce04bebb", // _totalAssets()
  maxRate: "0xece1d6e5", // maxRate()
  lastUpdate: "0xc0463711", // lastUpdate()
  performanceFee: "0x87788782", // performanceFee()
  managementFee: "0xa6f7f5d6", // managementFee()
  adaptersLength: "0x5aa22bc8", // adaptersLength()
  adapters: "0x4ef501ac", // adapters(uint256)
  // Vault V2 adapters
  realAssets: "0x56c07573", // realAssets()
  marketIdsLength: "0xace48b45", // marketIdsLength()            MorphoMarketV1AdapterV2
  marketIds: "0x779a9683", // marketIds(uint256)                  MorphoMarketV1AdapterV2
  marketParamsListLength: "0xb045ff5b", // marketParamsListLength() MorphoMarketV1Adapter (older)
  marketParamsList: "0x3e351242", // marketParamsList(uint256)     MorphoMarketV1Adapter (older)
  morphoVaultV1: "0xe4baaddf", // morphoVaultV1()                 MorphoVaultV1Adapter
  // Uniswap v3 pool
  token0: "0x0dfe1681", // token0()
  token1: "0xd21220a7", // token1()
  slot0: "0x3850c7bd", // slot0()
  liquidity: "0x1a686502", // liquidity()
  tickSpacing: "0xd0c93a7c", // tickSpacing()
  getPopulatedTicksInWord: "0x351fb478", // TickLens.getPopulatedTicksInWord(address,int16)
  npmPositions: "0x99fbab88", // NonfungiblePositionManager.positions(uint256)
  ownerOf: "0x6352211e", // ownerOf(uint256)
  // Uniswap v2 pair
  getReserves: "0x0902f1ac", // getReserves()
  // Uniswap v4
  getSlot0: "0xc815641c", // StateView.getSlot0(bytes32)
  getLiquidity: "0xfa6793d5", // StateView.getLiquidity(bytes32)
  getTickBitmap: "0x1c7ccb4c", // StateView.getTickBitmap(bytes32,int16)
  getTickLiquidity: "0xcaedab54", // StateView.getTickLiquidity(bytes32,int24)
  poolKeys: "0x86b6be7d", // PositionManager.poolKeys(bytes25)
  // Chainlink
  latestRoundData: "0xfeaf968c", // latestRoundData()
  // 0x Settler registry (Deployer, ERC721-like): ownerOf(feature) = current Settler, prev(feature) = previous one
  prev: "0xe2603dc2", // prev(uint128)
};

export const TOPIC = {
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  RedemptionStarted: "0x8c0cc6a0302d83caa04c8ad7d86864df08505193f7cb978c03d53a765b09696b",
  UniMint: "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",
  UniBurn: "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c",
  IncreaseLiquidity: "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f",
  ModifyLiquidity: "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec", // v4 PoolManager
  // Aggregators
  UniXFill: "0x78ad7ec0e9f89e74012afa58738b6b661c024cb0fd185ee2f616c0a28924bd66", // UniswapX Fill(bytes32,address,address,uint256)
  CowTrade: "0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17", // CoW Trade(address,address,address,uint256,uint256,uint256,bytes)
  V4Swap: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", // v4 Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
  UserOp: "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f", // ERC-4337 UserOperationEvent(bytes32,address,address,...)
  WethDeposit: "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", // WETH Deposit(address,uint256)
  WethWithdrawal: "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65", // WETH Withdrawal(address,uint256)
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_WORD = "0x" + "0".repeat(64);

const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);

/** Encoders for one 32-byte word (hex, no 0x). */
export const enc = {
  uint: (v) => BigInt(v).toString(16).padStart(64, "0"),
  int: (v) => { let b = BigInt(v); if (b < 0n) b += 1n << 256n; return b.toString(16).padStart(64, "0"); },
  addr: (a) => strip(a).toLowerCase().padStart(64, "0"),
  b32: (h) => strip(h).toLowerCase().padStart(64, "0"),
};

/**
 * Build a call. `sig` is a key of SIG, words are pre-encoded 32-byte words.
 * @returns {{target:string, data:string}}
 */
export const call = (target, sig, ...words) => {
  if (!SIG[sig]) throw new Error(`Unknown selector ${sig}`);
  return { target, data: SIG[sig] + words.join("") };
};

/** @typedef {{success:boolean, data:string}} CallResult */

const wordAt = (r, i) => {
  if (!r || !r.success) return null;
  const s = 2 + 64 * i;
  if (r.data.length < s + 64) return null;
  return r.data.slice(s, s + 64);
};

/** Decoders reading word i of a call result (null when the call failed or returned too little). */
export const dec = {
  uint: (r, i = 0) => { const w = wordAt(r, i); return w == null ? null : BigInt("0x" + w); },
  int: (r, i = 0) => {
    const w = wordAt(r, i);
    if (w == null) return null;
    const v = BigInt("0x" + w);
    return v >= 1n << 255n ? v - (1n << 256n) : v;
  },
  addr: (r, i = 0) => { const w = wordAt(r, i); return w == null ? null : "0x" + w.slice(24); },
  b32: (r, i = 0) => { const w = wordAt(r, i); return w == null ? null : "0x" + w; },
  bool: (r, i = 0) => { const w = wordAt(r, i); return w == null ? null : BigInt("0x" + w) !== 0n; },
  /** Dynamic string (or bytes32-encoded string for old tokens). */
  string: (r) => {
    if (!r || !r.success || r.data.length < 66) return null;
    const h = strip(r.data);
    try {
      if (h.length === 64) return bytesToText(h);
      const off = Number(BigInt("0x" + h.slice(0, 64)));
      const len = Number(BigInt("0x" + h.slice(off * 2, off * 2 + 64)));
      return bytesToText(h.slice(off * 2 + 64, off * 2 + 64 + len * 2));
    } catch {
      return null;
    }
  },
};

function bytesToText(hex) {
  const bytes = new Uint8Array((hex.match(/../g) || []).map((b) => parseInt(b, 16)));
  return new TextDecoder().decode(bytes).replace(/\u0000+$/g, "");
}

/** Read a hex word from a log's data field. */
export const logWord = (data, i) => BigInt("0x" + strip(data).slice(64 * i, 64 * (i + 1)));
/** Topic (32 bytes) -> address. */
export const topicAddr = (t) => "0x" + strip(t).slice(24).toLowerCase();

/** aggregate3((address target, bool allowFailure, bytes callData)[]) - allowFailure always true. */
export function encodeAggregate3(calls) {
  const tuples = calls.map((c) => {
    const data = strip(c.data);
    const len = data.length / 2;
    const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
    return enc.addr(c.target) + enc.uint(1) + enc.uint(0x60) + enc.uint(len) + padded;
  });
  let offset = tuples.length * 32;
  const heads = tuples.map((t) => {
    const o = offset;
    offset += t.length / 2;
    return enc.uint(o);
  });
  return SIG.aggregate3 + enc.uint(0x20) + enc.uint(tuples.length) + heads.join("") + tuples.join("");
}

/** Decode (bool success, bytes returnData)[]. */
export function decodeAggregate3(hex) {
  const h = strip(hex);
  const u = (byteOff) => Number(BigInt("0x" + h.slice(byteOff * 2, byteOff * 2 + 64)));
  const arr = u(0);
  const n = u(arr);
  const base = arr + 32;
  /** @type {CallResult[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + u(base + 32 * i);
    const success = u(t) !== 0;
    const d = t + u(t + 32);
    const len = u(d);
    out.push({ success, data: "0x" + h.slice((d + 32) * 2, (d + 32 + len) * 2) });
  }
  return out;
}

export const toHexQty = (n) => "0x" + BigInt(n).toString(16);

/* ================================================================================================
 * 12. CHAIN: EVM adapter
 * ================================================================================================ */
/**
 * EVM adapter.
 *
 * beginTick() -> one eth_blockNumber, then a TickContext pinned to that block:
 *   ctx.call(calls)  - sub-calls from every module of the tick are de-duplicated, merged and cut into
 *                      Multicall3 batches sent in parallel across endpoints, all at the same block.
 *   ctx.logs(filter, from, to) - log requests of the tick with the same range and topic0-only filters
 *                      are merged into one eth_getLogs (union of addresses and topic0), then routed back.
 *                      Ranges are split by the endpoints' maxLogRange; deep ranges only go to
 *                      endpoints whose logDepth allows it. Limits are learned from "range"/"depth" errors.
 */

export class EvmAdapter {
  /** @param {string} key @param {any} cfg chain config @param {import("../../core/rpc-pool.js").RpcPool} pool */
  constructor(key, cfg, pool) {
    this.key = key;
    this.cfg = cfg;
    this.pool = pool;
    this.type = "evm";
    /** @type {Record<string, number>} block -> timestamp */
    this._blockTimes = storage.get(`blocktimes:${key}`, {}) || {};
  }

  async beginTick() {
    const info = {};
    const hex = await this.pool.jsonRpc("eth_blockNumber", [], { module: "evm:head", filter: (ep) => ep.capabilities.has("calls"), info });
    const head = Number(BigInt(hex));
    return new TickContext(this, head, info.endpoint);
  }

  /** Block timestamp (seconds), cached in localStorage (bounded). */
  async blockTime(n, module) {
    if (this._blockTimes[n]) return this._blockTimes[n];
    const b = await this.pool.jsonRpc("eth_getBlockByNumber", [toHexQty(n), false], { module, filter: (ep) => ep.capabilities.has("calls") });
    const ts = Number(BigInt(b.timestamp));
    this._blockTimes[n] = ts;
    const keys = Object.keys(this._blockTimes);
    if (keys.length > 500) keys.slice(0, keys.length - 400).forEach((k) => delete this._blockTimes[k]);
    storage.set(`blocktimes:${this.key}`, this._blockTimes);
    return ts;
  }
}

export class TickContext {
  /** @param {EvmAdapter} adapter @param {number} head */
  constructor(adapter, head, endpoint) {
    this.adapter = adapter;
    this.chain = adapter.key;
    this.head = head;
    this.block = head - (adapter.cfg.confirmations || 0);
    this.logHead = head - (adapter.cfg.logConfirmations ?? 2);
    /** timestamp of the pinned block, known after the first ctx.call() */
    this.blockTime = null;
    /** endpoints that served this tick */
    this.endpoints = new Set(endpoint ? [endpoint] : []);
    this._callQ = [];
    this._callTimer = null;
    this._logQ = [];
    this._logTimer = null;
  }

  /** Source info for module.sourceOk(). */
  info() {
    return { block: this.block, blockTime: this.blockTime, endpoint: [...this.endpoints].join(", ") };
  }

  /**
   * Queue calls; resolved with one CallResult per call, all read at this.block.
   * @param {{target:string, data:string}[]} calls
   * @param {string} [module]
   * @returns {Promise<import("./abi.js").CallResult[]>}
   */
  call(calls, module = "-") {
    if (!calls.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this._callQ.push({ calls, module, resolve, reject });
      if (!this._callTimer) this._callTimer = setTimeout(() => this._flushCalls(), 0);
    });
  }

  async _flushCalls() {
    const items = this._callQ;
    this._callQ = [];
    this._callTimer = null;
    const idx = new Map();
    const uniq = [];
    for (const it of items) {
      it.keys = it.calls.map((c) => {
        const k = c.target.toLowerCase() + c.data;
        if (!idx.has(k)) { idx.set(k, uniq.length); uniq.push(c); }
        return idx.get(k);
      });
    }
    const pool = this.adapter.pool;
    const size = Math.max(10, Math.min(500, pool.minOf("maxMulticallSize", (ep) => ep.capabilities.has("calls")))) - 1;
    const modules = [...new Set(items.map((i) => i.module))].sort().join("+");
    const mc = this.adapter.cfg.multicall3;
    const tsCall = call(mc, "getCurrentBlockTimestamp");
    const chunks = [];
    for (let i = 0; i < uniq.length; i += size) chunks.push(uniq.slice(i, i + size));
    try {
      const parts = await Promise.all(chunks.map(async (chunk) => {
        const info = {};
        const hex = await pool.jsonRpc("eth_call", [{ to: mc, data: encodeAggregate3([tsCall, ...chunk]) }, toHexQty(this.block)], {
          module: modules, label: "eth_call(multicall)", subcalls: chunk.length, info,
          filter: (ep) => ep.capabilities.has("calls"),
        });
        if (info.endpoint) this.endpoints.add(info.endpoint);
        const res = decodeAggregate3(hex);
        if (res.length !== chunk.length + 1) throw new RpcError("multicall: unexpected result length", { kind: "rpc" });
        const ts = dec.uint(res[0]);
        if (ts != null && this.blockTime == null) this.blockTime = Number(ts);
        return res.slice(1);
      }));
      const all = parts.flat();
      for (const it of items) it.resolve(it.keys.map((k) => all[k]));
    } catch (e) {
      for (const it of items) it.reject(e);
    }
  }

  /** Make sure blockTime is known (costs one tiny multicall if no call was made yet). */
  async ensureBlockTime(module) {
    if (this.blockTime == null) await this.call([call(this.adapter.cfg.multicall3, "getCurrentBlockTimestamp")], module);
    return this.blockTime;
  }

  /**
   * Queue a log request over [from, to] (inclusive).
   * @param {{address: string[], topics: (string|string[]|null)[]}} filter
   * @returns {Promise<any[]>}
   */
  logs(filter, from, to, module = "-") {
    if (to < from) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this._logQ.push({ filter, from, to, module, resolve, reject });
      if (!this._logTimer) this._logTimer = setTimeout(() => this._flushLogs(), 0);
    });
  }

  async _flushLogs() {
    const items = this._logQ;
    this._logQ = [];
    this._logTimer = null;
    // Merge topic0-only requests that share the same range.
    const groups = new Map();
    const singles = [];
    for (const it of items) {
      const simple = it.filter.topics.length <= 1;
      if (!simple) { singles.push({ items: [it], filter: it.filter, from: it.from, to: it.to }); continue; }
      const k = `${it.from}-${it.to}`;
      if (!groups.has(k)) groups.set(k, { items: [], addr: new Set(), t0: new Set(), from: it.from, to: it.to });
      const g = groups.get(k);
      g.items.push(it);
      it.filter.address.forEach((a) => g.addr.add(a.toLowerCase()));
      const t0 = it.filter.topics[0];
      (Array.isArray(t0) ? t0 : t0 ? [t0] : []).forEach((t) => g.t0.add(t));
    }
    const reqs = [
      ...[...groups.values()].map((g) => ({ items: g.items, from: g.from, to: g.to, filter: { address: [...g.addr], topics: g.t0.size ? [[...g.t0]] : [] } })),
      ...singles,
    ];
    await Promise.all(reqs.map(async (r) => {
      try {
        const logs = await this._getLogsRange(r.filter, r.from, r.to, [...new Set(r.items.map((i) => i.module))].join("+"));
        for (const it of r.items) it.resolve(logs.filter((l) => matches(l, it.filter)));
      } catch (e) {
        for (const it of r.items) it.reject(e);
      }
    }));
  }

  async _getLogsRange(filter, from, to, module) {
    const pool = this.adapter.pool;
    const depth = this.head - from;
    const canDepth = (ep) => ep.capabilities.has("logs") && ep.logDepth >= this.head - from;
    // Chunks sized for the most capable endpoint: each chunk only goes to endpoints whose
    // maxLogRange covers it, so small-range endpoints still serve the per-block refresh.
    let size = pool.maxOf("maxLogRange", canDepth);
    if (!Number.isFinite(size)) {
      throw new RpcError(`no endpoint serves logs ${depth} blocks deep on ${this.chain} (add one with log history)`, { kind: "depth" });
    }
    size = Math.max(1, size);
    const out = [];
    const ranges = [];
    for (let a = from; a <= to; a += size) ranges.push([a, Math.min(to, a + size - 1)]);
    const parts = await Promise.all(ranges.map(([a, b]) => {
      const range = b - a + 1;
      const d = this.head - a;
      return pool.jsonRpc("eth_getLogs", [{ address: filter.address, topics: filter.topics, fromBlock: toHexQty(a), toBlock: toHexQty(b) }], {
        module,
        timeoutMs: range > 100000 ? 30000 : undefined, // very large ranges (LP history) take a few seconds
        filter: (ep) => ep.capabilities.has("logs") && ep.logDepth >= d && ep.maxLogRange >= range,
        onError: (ep, err) => {
          if (err.kind === "range") ep.maxLogRange = Math.max(10, Math.floor(range / 2));
          if (err.kind === "depth") ep.logDepth = Math.max(0, Math.min(ep.logDepth, d - 64));
        },
      });
    }));
    for (const p of parts) out.push(...(p || []));
    return out.filter((l) => !l.removed);
  }
}

function matches(log, filter) {
  const addr = log.address.toLowerCase();
  if (filter.address.length && !filter.address.some((a) => a.toLowerCase() === addr)) return false;
  for (let i = 0; i < filter.topics.length; i++) {
    const want = filter.topics[i];
    if (want == null) continue;
    const t = (log.topics[i] || "").toLowerCase();
    if (Array.isArray(want) ? !want.some((w) => w.toLowerCase() === t) : want.toLowerCase() !== t) return false;
  }
  return true;
}

/* ================================================================================================
 * 13. CHAIN: Solana adapter
 * ================================================================================================ */
/** Solana: supply of several mints in one getMultipleAccounts call (works for Token-2022). */

export class SolanaAdapter {
  /** @param {string} key @param {any} cfg @param {import("../../core/rpc-pool.js").RpcPool} pool */
  constructor(key, cfg, pool) {
    this.key = key;
    this.cfg = cfg;
    this.pool = pool;
    this.type = "solana";
  }

  /**
   * @param {string[]} mints
   * @returns {Promise<{slot:number, endpoint:string, supplies: Record<string, {raw: bigint, decimals: number}>}>}
   */
  async mintSupplies(mints, module) {
    const info = {};
    const r = await this.pool.jsonRpc("getMultipleAccounts", [mints, { encoding: "jsonParsed", commitment: "confirmed" }], { module, info });
    const supplies = {};
    (r?.value || []).forEach((acc, i) => {
      const p = acc?.data?.parsed;
      if (!p || p.type !== "mint") throw new RpcError(`Solana: ${mints[i]} is not a mint account`, { kind: "rpc" });
      supplies[mints[i]] = { raw: BigInt(p.info.supply), decimals: Number(p.info.decimals) };
    });
    return { slot: r?.context?.slot, endpoint: info.endpoint, supplies };
  }
}

/* ================================================================================================
 * 14. CHAIN: Stellar adapter
 * ================================================================================================ */
/**
 * Stellar through Horizon. A classic asset has no supply stored on-ledger: Horizon's /assets
 * aggregates every trustline, claimable balance, liquidity pool and SAC contract balance.
 */

export const STELLAR_DECIMALS = 7;

export class StellarAdapter {
  /** @param {string} key @param {any} cfg @param {import("../../core/rpc-pool.js").RpcPool} pool */
  constructor(key, cfg, pool) {
    this.key = key;
    this.cfg = cfg;
    this.pool = pool;
    this.type = "stellar";
  }

  /** All assets of one issuer (1 call). */
  async issuerAssets(issuer, module) {
    const info = {};
    const j = await this.pool.getJson(`/assets?asset_issuer=${encodeURIComponent(issuer)}&limit=200`, { module, info, label: "GET /assets" });
    return { records: j?._embedded?.records || [], endpoint: info.endpoint };
  }
}

/** Supply of one /assets record, in stroops (7 decimals). */
export function stellarSupplyRaw(rec) {
  const b = rec.balances || {};
  const parts = [
    b.authorized,
    b.authorized_to_maintain_liabilities,
    b.unauthorized,
    rec.claimable_balances_amount,
    rec.liquidity_pools_amount,
    rec.contracts_amount,
  ];
  return parts.reduce((s, x) => s + (x ? parseUnits(x, STELLAR_DECIMALS) : 0n), 0n);
}

/* ================================================================================================
 * 15. CHAIN: XRPL adapter
 * ================================================================================================ */
/** XRP Ledger: issued amount = gateway_balances obligations of the issuer, on a validated ledger. */

export class XrplAdapter {
  /** @param {string} key @param {any} cfg @param {import("../../core/rpc-pool.js").RpcPool} pool */
  constructor(key, cfg, pool) {
    this.key = key;
    this.cfg = cfg;
    this.pool = pool;
    this.type = "xrpl";
  }

  async gatewayBalances(issuer, module) {
    const info = {};
    const r = await this.pool.send(async (ep) => {
      const res = await this.pool._fetch(ep, ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "gateway_balances", params: [{ account: issuer, ledger_index: "validated", strict: true }] }),
      });
      const result = res?.result;
      if (!result || result.status !== "success") {
        const msg = result?.error_message || result?.error || "XRPL error";
        throw new RpcError(msg, { kind: /slow|busy|load/i.test(msg) ? "rate" : "rpc" });
      }
      return result;
    }, { method: "gateway_balances", module, info });
    return { ledger: r.ledger_index, obligations: r.obligations || {}, endpoint: info.endpoint };
  }
}

/** "4555524356000000..." -> "EURCV" (non-standard 160-bit currency code). */
export function hexCurrencyToAscii(hex) {
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) return null;
  let s = "";
  for (let i = 0; i < 40; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    if (c) s += String.fromCharCode(c);
  }
  return s;
}

/* ================================================================================================
 * 16. MODULE: base class
 * ================================================================================================ */
/**
 * Base class for data modules.
 *
 * A module declares:
 *   id        unique id
 *   storeId   key of its result in the store
 *   page      route it belongs to (only modules of the visible page run)
 *   chains    chain keys (or "api:<name>") it reads
 *   schedules [{ id, chains?, gate? }] - one entry per independently scheduled part (see frequency.js)
 * and implements run(chain, ctx, dueScheduleIds).
 *
 * It publishes one envelope: { module, schema, updatedAt, status, sources, warnings, data }.
 */
export class Module {
  /**
   * @param {any} app
   * @param {{id:string, storeId?:string, page:string, chains:string[], schedules:{id:string, chains?:string[], gate?:string}[]}} def
   */
  constructor(app, def) {
    this.app = app;
    this.id = def.id;
    this.storeId = def.storeId || def.id;
    this.page = def.page;
    this.chains = def.chains;
    this.schedules = def.schedules;
    /** @type {Record<string, any>} */
    this.sources = {};
    /** @type {Map<string, string>} */
    this.warnings = new Map();
    this.data = null;
  }

  /** Record a successful read on a chain. info: { block?, slot?, ledger?, blockTime?, endpoint? } */
  sourceOk(chain, info = {}) {
    this.sources[chain] = { ...info, status: "ok", at: Date.now(), okAt: Date.now(), error: null };
  }

  sourceFail(chain, err) {
    const prev = this.sources[chain] || {};
    this.sources[chain] = { ...prev, status: prev.okAt ? "stale" : "error", at: Date.now(), error: String(err?.message || err).slice(0, 300) };
  }

  warn(key, msg) {
    this.warnings.set(key, msg);
  }

  clearWarn(key) {
    this.warnings.delete(key);
  }

  /** Called by the scheduler when run() throws or the tick could not start. */
  fail(chain, err, _ids) {
    this.sourceFail(chain.startsWith("api:") ? chain.slice(4) : chain, err);
    this.publish(this.data);
  }

  publish(data) {
    this.data = data;
    const st = Object.values(this.sources).map((s) => s.status);
    const status = !st.length ? "pending" : st.every((s) => s === "ok") ? "ok" : st.every((s) => s === "error") ? "error" : "partial";
    this.app.store.set(this.storeId, {
      module: this.storeId,
      schema: 1,
      updatedAt: Date.now(),
      status,
      sources: structuredClone(this.sources),
      warnings: [...this.warnings.values()],
      data,
    });
  }
}

/* ================================================================================================
 * 17. MODULE: monitoring.supply
 * ================================================================================================ */
/**
 * monitoring.supply - issued supply of every token on every chain (everything counted).
 *   Ethereum: totalSupply()                 Solana: mint supply (getMultipleAccounts)
 *   Stellar:  Horizon /assets sum           XRPL:   gateway_balances obligations
 */

const XRPL_DECIMALS = 15; // IOU amounts have up to 15 significant digits; 15 decimals is enough to hold them exactly here
const TOTAL_DECIMALS = 18;

export class SupplyModule extends Module {
  constructor(app) {
    const { chains, tokens } = app.config;
    const used = Object.keys(chains).filter((k) => chains[k].enabled && Object.values(tokens).some((t) => t.deployments[k]));
    // TEMPORARY Canton: tokens with cantonFromForgeApi.url get a derived Canton row (Forge API total - on-chain chains)
    const forge = Object.entries(tokens).filter(([, t]) => t.cantonFromForgeApi?.url);
    super(app, { id: "monitoring.supply", page: "monitoring", chains: forge.length ? [...used, "api:forge"] : used, schedules: [{ id: "monitoring.supply" }] });
    /** token -> { pool, cfg } for the Forge API; token -> { value, at } its last total */
    this.forgeCfg = Object.fromEntries(forge.map(([sym, t]) => [sym, { cfg: t.cantonFromForgeApi, pool: new RpcPool("forge-api", [{ id: "forge-api", url: t.cantonFromForgeApi.url, maxRps: 0.5 }], { timeoutMs: app.config.timeoutMs, stats: app.stats }) }]));
    if (forge.length) app.apiPools["forge-api"] = Object.values(this.forgeCfg)[0].pool;
    this.forge = storage.get("supply:forge:v1", null) || {};
    /** values[token][chain] = { raw, decimals } */
    this.values = {};
    this.checkedDecimals = storage.get("imm:decimals", {}) || {};
    this.mintBurnDirty = true;
    this.lastFullEvm = 0;
    app.bus.on("mintburn:new", () => { this.mintBurnDirty = true; });
  }

  deps(chain) {
    return Object.entries(this.app.config.tokens)
      .filter(([, t]) => t.deployments[chain])
      .map(([sym, t]) => ({ sym, dep: t.deployments[chain] }));
  }

  set(sym, chain, raw, decimals) {
    (this.values[sym] ||= {})[chain] = { raw, decimals };
  }

  async run(chain, ctx) {
    if (chain === "api:forge") { await this.runForge(); this.publish(this.build()); return; }
    const type = this.app.config.chains[chain].type;
    if (type === "evm") await this.runEvm(chain, ctx);
    else if (type === "solana") await this.runSolana(chain);
    else if (type === "stellar") await this.runStellar(chain);
    else if (type === "xrpl") await this.runXrpl(chain);
    this.publish(this.build());
  }

  async runEvm(chain, ctx) {
    const list = this.deps(chain);
    const opt = this.app.config.frequency.options?.supplyOnlyOnMintBurn;
    const haveAll = list.every(({ sym }) => this.values[sym]?.[chain]);
    if (opt && haveAll && !this.mintBurnDirty && Date.now() - this.lastFullEvm < 300000) {
      // Supply cannot have changed without a mint/burn: keep the value, confirm it at this block.
      this.sourceOk(chain, { ...ctx.info(), skipped: true });
      return;
    }
    const needDec = list.filter(({ sym }) => !this.checkedDecimals[`${chain}:${sym}`]);
    const calls = [
      ...list.map(({ dep }) => call(dep.address, "totalSupply")),
      ...needDec.map(({ dep }) => call(dep.address, "decimals")),
    ];
    const res = await ctx.call(calls, this.id);
    needDec.forEach(({ sym, dep }, i) => {
      const d = dec.uint(res[list.length + i]);
      if (d == null) return;
      if (Number(d) !== dep.decimals) this.warn(`dec:${chain}:${sym}`, `${sym} on ${chain}: config says ${dep.decimals} decimals, chain says ${d}. Using the chain value.`);
      this.checkedDecimals[`${chain}:${sym}`] = Number(d);
    });
    storage.set("imm:decimals", this.checkedDecimals);
    list.forEach(({ sym, dep }, i) => {
      const raw = dec.uint(res[i]);
      if (raw == null) throw new Error(`${sym}.totalSupply() failed on ${chain}`);
      this.set(sym, chain, raw, this.checkedDecimals[`${chain}:${sym}`] ?? dep.decimals);
    });
    this.mintBurnDirty = false;
    this.lastFullEvm = Date.now();
    this.sourceOk(chain, ctx.info());
  }

  async runSolana(chain) {
    const list = this.deps(chain);
    const r = await this.app.adapters[chain].mintSupplies(list.map(({ dep }) => dep.mint), this.id);
    for (const { sym, dep } of list) {
      const s = r.supplies[dep.mint];
      if (s.decimals !== dep.decimals) this.warn(`dec:${chain}:${sym}`, `${sym} on ${chain}: config says ${dep.decimals} decimals, chain says ${s.decimals}. Using the chain value.`);
      this.set(sym, chain, s.raw, s.decimals);
    }
    this.sourceOk(chain, { slot: r.slot, endpoint: r.endpoint });
  }

  async runStellar(chain) {
    const list = this.deps(chain);
    const byIssuer = new Map();
    for (const it of list) byIssuer.set(it.dep.issuer, [...(byIssuer.get(it.dep.issuer) || []), it]);
    let endpoint = null;
    for (const [issuer, items] of byIssuer) {
      const r = await this.app.adapters[chain].issuerAssets(issuer, this.id);
      endpoint = r.endpoint;
      for (const { sym, dep } of items) {
        const rec = r.records.find((x) => x.asset_code === dep.code && x.asset_issuer === dep.issuer);
        if (!rec) throw new Error(`Stellar: asset ${dep.code}-${dep.issuer} not found on Horizon`);
        this.set(sym, chain, stellarSupplyRaw(rec), STELLAR_DECIMALS);
      }
    }
    this.sourceOk(chain, { endpoint });
  }

  async runXrpl(chain) {
    const list = this.deps(chain);
    const byIssuer = new Map();
    for (const it of list) byIssuer.set(it.dep.issuer, [...(byIssuer.get(it.dep.issuer) || []), it]);
    let ledger = null, endpoint = null;
    for (const [issuer, items] of byIssuer) {
      const r = await this.app.adapters[chain].gatewayBalances(issuer, this.id);
      ledger = r.ledger;
      endpoint = r.endpoint;
      for (const { sym, dep } of items) {
        const ob = r.obligations;
        const ascii = hexCurrencyToAscii(dep.currency);
        const v = ob[dep.currency] ?? ob[dep.currency.toUpperCase()] ?? (ascii ? ob[ascii] : undefined);
        this.set(sym, chain, v == null ? 0n : parseUnits(v, XRPL_DECIMALS), XRPL_DECIMALS);
      }
    }
    this.sourceOk(chain, { ledger, endpoint });
  }

  /** TEMPORARY Canton: total supply from the Forge API (one GET per token, the source changes once a day). */
  async runForge() {
    for (const [sym, f] of Object.entries(this.forgeCfg)) {
      const info = {};
      const j = await f.pool.getJson("", { module: this.id, info, label: "GET Forge API supply" });
      const v = forgeValue(j, f.cfg.field);
      if (v == null) throw new Error(`Forge API answer has no ${f.cfg.field ? `"${f.cfg.field}"` : "total supply"} field: set cantonFromForgeApi.field in config.js`);
      this.forge[sym] = { value: v / 10 ** (f.cfg.decimals || 0), at: Date.now() };
    }
    storage.set("supply:forge:v1", this.forge);
    this.sourceOk("forge", { endpoint: "forge-api", staleAfterSec: 3 * 86400 });
  }

  build() {
    const out = {};
    for (const [sym, t] of Object.entries(this.app.config.tokens)) {
      const chains = {};
      let total = 0n;
      let partial = false;
      for (const chain of Object.keys(t.deployments)) {
        if (!this.app.config.chains[chain]?.enabled) continue;
        const v = this.values[sym]?.[chain];
        const src = this.sources[chain];
        if (!v) { partial = true; chains[chain] = { amount: null, status: src?.status || "pending" }; continue; }
        if (src?.status === "error") partial = true;
        total += rescale(v.raw, v.decimals, TOTAL_DECIMALS);
        chains[chain] = { amount: formatUnits(v.raw, v.decimals), raw: v.raw.toString(), decimals: v.decimals, status: src?.status || "ok" };
      }
      // TEMPORARY Canton = Forge API total - every chain read on-chain (needs all of them)
      if (t.cantonFromForgeApi?.url) {
        const f = this.forge[sym];
        const onchain = Object.values(chains);
        if (f && onchain.length && onchain.every((c) => c.amount != null)) {
          const diff = f.value - Number(formatUnits(total, TOTAL_DECIMALS));
          const amt = Math.max(0, diff);
          chains.canton = { amount: amt.toFixed(6), derived: true, forgeTotal: f.value, forgeAt: f.at, negative: diff < 0 ? diff : null, status: "derived" };
          total += parseUnits(amt.toFixed(6), TOTAL_DECIMALS);
        } else {
          chains.canton = { amount: null, derived: true, forgeAt: f?.at || null, status: "pending" };
          partial = true;
        }
      }
      for (const c of Object.values(chains)) {
        c.share = c.amount != null && total > 0n ? Number(parseUnits(c.amount, TOTAL_DECIMALS)) / Number(total) : null;
      }
      out[sym] = { name: t.name, currency: t.currency, total: formatUnits(total, TOTAL_DECIMALS), partial, chains };
    }
    return out;
  }
}

/**
 * TEMPORARY Canton: the total supply in a Forge API answer. `field` = dotted path ("data.totalSupply");
 * empty = first numeric field named like totalSupply, then supply, then circulating (depth-first).
 */
export function forgeValue(json, field) {
  const num = (v) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.trim()) ? Number(v) : null);
  if (field) return num(field.split(".").reduce((o, k) => (o == null ? o : o[k]), json));
  if (num(json) != null) return num(json);
  for (const re of [/^total_?supply$/i, /total.?supply/i, /supply/i, /circulating/i]) {
    const stack = [json];
    while (stack.length) {
      const o = stack.shift();
      if (!o || typeof o !== "object") continue;
      for (const [k, v] of Object.entries(o)) { if (re.test(k) && num(v) != null) return num(v); if (v && typeof v === "object") stack.push(v); }
    }
  }
  return null;
}

/* ================================================================================================
 * 17b. MODULE: monitoring.supplyHistory
 * ================================================================================================ */
/**
 * monitoring.supplyHistory - daily issued supply per token, from DefiLlama's stablecoins API, so the
 * history costs no RPC call. Issued = DefiLlama "circulating" + "unreleased" (minted but held by the
 * issuer), which is what the on-chain total above counts. One GET per token (tokens.<sym>.defillamaId),
 * cached in the browser and re-fetched when older than frequency.cacheTtl["defillama.supply"].
 */
export class SupplyHistoryModule extends Module {
  constructor(app) {
    super(app, { id: "monitoring.supplyHistory", page: "monitoring", chains: ["api:defillama"], schedules: [{ id: "monitoring.supplyHistory" }] });
    this.cache = storage.get("supplyhistory:v1", null) || { at: 0, series: {} };
  }

  ttl() { return (this.app.config.frequency.cacheTtl?.["defillama.supply"] || 21600) * 1000; }

  async run() {
    const pool = this.app.apiPools.defillama;
    const ids = Object.entries(this.app.config.tokens).filter(([, t]) => t.defillamaId != null);
    if (pool && ids.length && Date.now() - this.cache.at >= this.ttl()) {
      const info = {};
      const series = {};
      for (const [sym, t] of ids) {
        const j = await pool.getJson(`/stablecoin/${t.defillamaId}`, { module: this.id, info, label: "GET stablecoin" });
        const pts = (j?.tokens || []).map((x) => {
          const sum = (o) => (o && typeof o === "object" ? Object.entries(o).filter(([k]) => k.startsWith("pegged")).reduce((a, [, v]) => a + (Number(v) || 0), 0) : 0);
          return [Number(x.date), sum(x.circulating) + sum(x.unreleased)];
        }).filter(([d, v]) => d > 0 && Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
        if (!pts.length) this.warn(`llama:${sym}`, `DefiLlama returned no history for ${sym} (id ${t.defillamaId})`); else this.clearWarn(`llama:${sym}`);
        series[sym] = pts;
      }
      this.cache = { at: Date.now(), series, endpoint: info.endpoint };
      storage.set("supplyhistory:v1", this.cache);
    }
    if (this.cache.at) this.sources.defillama = { status: "ok", at: Date.now(), okAt: this.cache.at, endpoint: "stablecoins.llama.fi", staleAfterSec: (this.ttl() / 1000) * 3, error: null };
    this.publish({ series: this.cache.series, fetchedAt: this.cache.at });
  }
}

/* ================================================================================================
 * 18. MODULE: monitoring.mintburn
 * ================================================================================================ */
/**
 * monitoring.mintburn - the 15 most recent mint/burn events across EURCV and USDCV on Ethereum.
 *
 * SmartCoin specifics (verified on mainnet, Oct 2026):
 * - mint = Transfer(0x0 -> to), burn = Transfer(registrar -> 0x0): `from` of a burn is always the registrar
 * - before a burn the holder's tokens reach the registrar:
 *     EURCV: RedemptionStarted(holder -> redemption address, value), then Transfer(holder -> registrar, value)
 *     USDCV: only Transfer(holder -> registrar, value) - no RedemptionStarted seen in 300k blocks
 * - a burn is attributed to the holder of the latest unmatched RedemptionStarted with the same token
 *   and value before it; if none, to the sender of the latest unmatched Transfer to the registrar
 *   with the same value; otherwise to the registrar itself.
 *
 * Reading:
 * - steady state: one merged eth_getLogs per tick over (cursor, logHead], topic0 in {Transfer, RedemptionStarted}
 * - empty cache or large gap: scan back from logHead in windows with targeted filters until enough
 *   events are found and their burns are matched (bounded by REDEMPTION_LOOKBACK).
 */

const SHOW = 15;
const KEEP_EVENTS = 60;
const KEEP_REDEMPTIONS = 400;
const WINDOW = 10000; // blocks per backward window (split further by the adapter if needed)
const REDEMPTION_LOOKBACK = 50000; // ~7 days
const MAX_WINDOWS = 12;

export class MintBurnModule extends Module {
  constructor(app) {
    super(app, { id: "monitoring.mintburn", page: "monitoring", chains: ["ethereum"], schedules: [{ id: "monitoring.mintburn" }] });
    this.chain = "ethereum";
    this.tokens = Object.entries(app.config.tokens)
      .filter(([, t]) => t.deployments[this.chain]?.address)
      .map(([sym, t]) => ({ sym, address: t.deployments[this.chain].address.toLowerCase(), decimals: t.deployments[this.chain].decimals }));
    this.addresses = this.tokens.map((t) => t.address);
    this.state = storage.get(`mintburn:${this.chain}`, null) || { cursor: null, events: [], redemptions: [], deposits: [], scannedFrom: null };
    this.state.deposits ||= [];
    this.roles = storage.get(`roles:${this.chain}`, null);
    if (this.roles) this.applyRoles();
    this.state.redemptions.forEach((r) => app.labels.setRole(this.chain, r.redemptionAddress, "Redemption", r.token));
  }

  tokenOf(addr) {
    return this.tokens.find((t) => t.address === addr.toLowerCase());
  }

  save() {
    storage.set(`mintburn:${this.chain}`, this.state);
  }

  applyRoles() {
    for (const [sym, r] of Object.entries(this.roles.byToken || {})) {
      this.app.labels.setRole(this.chain, r.registrar, "Registrar", sym);
      this.app.labels.setRole(this.chain, r.operations, "Operations", sym);
      this.app.labels.setRole(this.chain, r.technical, "Technical", sym);
    }
  }

  async loadRoles(ctx) {
    const ttl = (this.app.config.frequency.cacheTtl["token.roles"] || 86400) * 1000;
    if (this.roles && Date.now() - this.roles.at < ttl) return;
    const calls = this.tokens.flatMap((t) => [call(t.address, "registrar"), call(t.address, "operations"), call(t.address, "technical")]);
    const res = await ctx.call(calls, this.id);
    const byToken = {};
    this.tokens.forEach((t, i) => {
      byToken[t.sym] = { registrar: dec.addr(res[i * 3]), operations: dec.addr(res[i * 3 + 1]), technical: dec.addr(res[i * 3 + 2]) };
    });
    this.roles = { at: Date.now(), byToken };
    storage.set(`roles:${this.chain}`, this.roles);
    this.applyRoles();
  }

  /** Registrar address per token (lowercase), once roles are known. */
  registrars() {
    const out = {};
    for (const [sym, r] of Object.entries(this.roles?.byToken || {})) if (r.registrar) out[sym] = r.registrar.toLowerCase();
    return out;
  }

  /** Parse logs into events / redemptions / deposits to the registrar (deduplicated by key). */
  ingest(logs) {
    const evKeys = new Set(this.state.events.map((e) => e.key));
    const rdKeys = new Set(this.state.redemptions.map((r) => r.key));
    const dpKeys = new Set(this.state.deposits.map((r) => r.key));
    const regs = this.registrars();
    let newMintBurn = 0;
    for (const l of logs) {
      const tok = this.tokenOf(l.address);
      if (!tok) continue;
      const key = `${tok.sym}:${Number(BigInt(l.blockNumber))}:${Number(BigInt(l.logIndex))}`;
      const base = {
        key,
        token: tok.sym,
        block: Number(BigInt(l.blockNumber)),
        logIndex: Number(BigInt(l.logIndex)),
        txHash: l.transactionHash,
        ts: l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : null,
        value: logWord(l.data, 0),
      };
      const t0 = l.topics[0]?.toLowerCase();
      if (t0 === TOPIC.Transfer) {
        const from = l.topics[1]?.toLowerCase();
        const to = l.topics[2]?.toLowerCase();
        const isMint = from === ZERO_WORD;
        const isBurn = to === ZERO_WORD;
        if (!isMint && !isBurn) {
          const reg = regs[tok.sym];
          if (reg && topicAddr(to) === reg && !dpKeys.has(key)) {
            dpKeys.add(key);
            this.state.deposits.push({ ...base, holder: topicAddr(from) });
          }
          continue;
        }
        if (evKeys.has(key)) continue;
        evKeys.add(key);
        this.state.events.push({ ...base, type: isMint ? "mint" : "burn", from: topicAddr(from), to: topicAddr(to) });
        newMintBurn++;
      } else if (t0 === TOPIC.RedemptionStarted) {
        if (rdKeys.has(key)) continue;
        rdKeys.add(key);
        const r = { ...base, holder: topicAddr(l.topics[1]), redemptionAddress: topicAddr(l.topics[2]) };
        this.state.redemptions.push(r);
        this.app.labels.setRole(this.chain, r.redemptionAddress, "Redemption", r.token);
      }
    }
    const ord = (a, b) => b.block - a.block || b.logIndex - a.logIndex;
    this.state.events.sort(ord);
    this.state.redemptions.sort(ord);
    this.state.deposits.sort(ord);
    this.state.events = this.state.events.slice(0, KEEP_EVENTS);
    this.state.redemptions = this.state.redemptions.slice(0, KEEP_REDEMPTIONS);
    this.state.deposits = this.state.deposits.slice(0, KEEP_REDEMPTIONS);
    return newMintBurn;
  }

  /**
   * Match burns to their holder (deterministic, recomputed each time).
   * @returns {Map<string, {holder:string, via:string|null, attribution:string}>}
   */
  match() {
    const before = (x, b) => x.block < b.block || (x.block === b.block && x.logIndex < b.logIndex);
    const usedR = new Set();
    const usedD = new Set();
    const burns = this.state.events.filter((e) => e.type === "burn").sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    const out = new Map();
    for (const b of burns) {
      // lists are sorted newest first, so find() returns the latest candidate
      const r = this.state.redemptions.find((x) => !usedR.has(x.key) && x.token === b.token && x.value === b.value && before(x, b));
      const d = this.state.deposits.find((x) => !usedD.has(x.key) && x.token === b.token && x.value === b.value && before(x, b) && (!r || x.holder === r.holder));
      if (d) usedD.add(d.key);
      if (r) { usedR.add(r.key); out.set(b.key, { holder: r.holder, via: r.redemptionAddress, attribution: "redemption" }); }
      else if (d) out.set(b.key, { holder: d.holder, via: null, attribution: "transfer-to-registrar" });
    }
    return out;
  }

  topUnmatched() {
    const m = this.match();
    return this.state.events.slice(0, SHOW).filter((e) => e.type === "burn" && !m.has(e.key)).length;
  }

  /**
   * Scan back from `to` down to `stopAt` (exclusive), with targeted filters.
   * Stops when SHOW events newer than stopAt are known and burns are matched, or limits are hit.
   */
  async scanBack(ctx, to, stopAt) {
    const addr = this.addresses;
    let end = to;
    let windows = 0;
    let found = 0;
    for (;;) {
      const lowest = stopAt != null ? stopAt + 1 : 0;
      const start = Math.max(lowest, end - WINDOW + 1);
      const needEvents = found < SHOW;
      const regTopics = [...new Set(Object.values(this.registrars()))].map((a) => "0x" + a.slice(2).padStart(64, "0"));
      const reqs = [ctx.logs({ address: addr, topics: [TOPIC.RedemptionStarted] }, start, end, this.id)];
      if (regTopics.length) reqs.push(ctx.logs({ address: addr, topics: [TOPIC.Transfer, null, regTopics] }, start, end, this.id));
      if (needEvents) {
        reqs.push(ctx.logs({ address: addr, topics: [TOPIC.Transfer, ZERO_WORD] }, start, end, this.id));
        reqs.push(ctx.logs({ address: addr, topics: [TOPIC.Transfer, null, ZERO_WORD] }, start, end, this.id));
      }
      const parts = await Promise.all(reqs);
      found += this.ingest(parts.flat());
      this.state.scannedFrom = Math.min(this.state.scannedFrom ?? start, start);
      windows++;
      if (start <= lowest) break;
      if (found >= SHOW && this.topUnmatched() === 0) break;
      if (found >= SHOW && to - start >= REDEMPTION_LOOKBACK) break;
      if (windows >= MAX_WINDOWS) {
        this.warn("scan", `Stopped scanning after ${windows} windows of ${WINDOW} blocks.`);
        break;
      }
      end = start - 1;
    }
  }

  async run(chain, ctx) {
    await this.loadRoles(ctx).catch((e) => this.warn("roles", `Could not read token roles: ${e.message}`));
    const head = ctx.logHead;
    const s = this.state;
    let added = 0;
    const before = s.events.length;
    if (s.cursor == null || head - s.cursor > WINDOW) {
      const stopAt = s.cursor;
      try {
        await this.scanBack(ctx, head, stopAt);
        this.clearWarn("depth");
      } catch (e) {
        if (e?.kind !== "depth" || !s.events.length) throw e;
        this.warn("depth", `History limited by the endpoints' log depth: ${e.message}`);
      }
      s.cursor = head;
      added = s.events.length - before;
    } else if (head > s.cursor) {
      const logs = await ctx.logs({ address: this.addresses, topics: [[TOPIC.Transfer, TOPIC.RedemptionStarted]] }, s.cursor + 1, head, this.id);
      added = this.ingest(logs);
      s.cursor = head;
    }
    if (added > 0) this.app.bus.emit("mintburn:new", { count: added });

    // Timestamps for displayed events when the endpoint did not include blockTimestamp.
    const show = s.events.slice(0, SHOW);
    for (const e of show) if (e.ts == null) e.ts = await this.app.adapters[this.chain].blockTime(e.block, this.id);
    this.save();
    this.sourceOk(chain, { ...ctx.info(), block: head, cursor: s.cursor, scannedFrom: s.scannedFrom });
    this.publish(this.build());
  }

  build() {
    const m = this.match();
    const explorer = this.app.config.chains[this.chain].explorer;
    const events = this.state.events.slice(0, SHOW).map((e) => {
      const tok = this.tokens.find((t) => t.sym === e.token);
      const hit = m.get(e.key);
      const counterparty = e.type === "mint" ? e.to : hit ? hit.holder : e.from;
      return {
        timestamp: e.ts,
        chain: this.chain,
        token: e.token,
        type: e.type,
        counterparty: { address: counterparty, label: this.app.labels.resolve(this.chain, counterparty).label },
        via: hit?.via || null,
        attribution: e.type === "mint" ? "recipient" : hit ? hit.attribution : "registrar",
        amount: formatUnits(e.value, tok?.decimals ?? 18),
        block: e.block,
        txHash: e.txHash,
        txHashShort: shortHex(e.txHash),
        explorerUrl: explorer.tx + e.txHash,
      };
    });
    return { events, cursor: this.state.cursor, scannedFrom: this.state.scannedFrom };
  }
}

/* ================================================================================================
 * 19. MODULE: Morpho math
 * ================================================================================================ */
/**
 * Morpho math (pure functions, unit-tested).
 * Reproduces Morpho Blue's MathLib / SharesMathLib / MorphoBalancesLib and Vault V2 accrual.
 */

export const WAD = 10n ** 18n;
export const YEAR = 31_536_000;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

/** MathLib.wTaylorCompounded: e^(x-n) - 1 ~ x-n + (x-n)^2/2 + (x-n)^3/6, in WAD. */
export function wTaylorCompounded(x, n) {
  const first = x * n;
  const second = (first * first) / (2n * WAD);
  const third = (second * first) / (3n * WAD);
  return first + second + third;
}

/** SharesMathLib.toAssetsDown */
export function toAssetsDown(shares, totalAssets, totalShares) {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}

/**
 * MorphoBalancesLib.expectedMarketBalances (without fee shares, which do not change asset totals).
 * @param {{totalSupplyAssets:bigint,totalBorrowAssets:bigint,lastUpdate:bigint}} m
 * @param {bigint} borrowRate per second, WAD
 * @param {bigint} now block timestamp
 * @param {boolean} hasIrm
 */
export function accrue(m, borrowRate, now, hasIrm) {
  const elapsed = now > m.lastUpdate ? now - m.lastUpdate : 0n;
  if (!hasIrm || elapsed === 0n || m.totalBorrowAssets === 0n) {
    return { supply: m.totalSupplyAssets, borrow: m.totalBorrowAssets };
  }
  const interest = (m.totalBorrowAssets * wTaylorCompounded(borrowRate, elapsed)) / WAD;
  return { supply: m.totalSupplyAssets + interest, borrow: m.totalBorrowAssets + interest };
}

/** Per-second rate (float) -> APY. */
export const rateToApy = (perSec) => (perSec == null || !Number.isFinite(perSec) ? null : Math.expm1(perSec * YEAR));

/** WAD bigint -> float. */
export const wadToFloat = (w) => (w == null ? null : Number(w) / 1e18);

/**
 * Market rates from its state.
 * @returns {{utilization:number, borrowRate:number, supplyRate:number, borrowApy:number, supplyApy:number}}
 */
export function marketRates(supply, borrow, borrowRateWad, feeWad) {
  const utilization = supply === 0n ? 0 : Number((borrow * 10n ** 12n) / supply) / 1e12;
  const borrowRate = wadToFloat(borrowRateWad) || 0;
  const fee = wadToFloat(feeWad) || 0;
  const supplyRate = borrowRate * utilization * (1 - fee);
  return { utilization, borrowRate, supplyRate, borrowApy: rateToApy(borrowRate), supplyApy: rateToApy(supplyRate) };
}

/**
 * Utilization band, compared on the unrounded percentage.
 *   [0, 90[ yellow - [90, 91] green - ]91, 98[ orange - [98, 100] red
 */
export function utilizationBand(utilization) {
  const p = utilization * 100;
  if (p < 90) return "yellow";
  if (p <= 91) return "green";
  if (p < 98) return "orange";
  return "red";
}

/**
 * Vault V2: displayed and native rates, incentive buffer and runway.
 * All amounts as floats in asset units (display), rates per second.
 * @param {{realAssets:number, totalAssets:number, organicPerSec:number, maxRate:number, performanceFee:number, managementFee:number}} v
 */
export function vaultV2Rates(v) {
  const { realAssets: RA, totalAssets: TA, organicPerSec, maxRate, performanceFee, managementFee } = v;
  const buffer = Math.max(0, RA - TA);
  const nativeGross = TA > 0 ? Math.min(organicPerSec / TA, maxRate) : 0;
  const gross = buffer > 0 ? maxRate : nativeGross;
  const net = (r) => r * (1 - performanceFee) - managementFee;
  const apy = rateToApy(net(gross));
  const nativeApy = rateToApy(net(nativeGross));
  const capGrowth = TA * maxRate;
  const burnPerSec = capGrowth - organicPerSec;
  const runwaySec = buffer <= 0 ? 0 : burnPerSec > 0 ? buffer / burnPerSec : Infinity;
  return {
    buffer,
    nativeRateOnRealAssets: RA > 0 ? organicPerSec / RA : 0,
    apy,
    grossApy: rateToApy(gross),
    nativeGrossApy: rateToApy(nativeGross),
    nativeApy,
    incentiveApy: apy != null && nativeApy != null ? apy - nativeApy : null,
    capApy: rateToApy(maxRate),
    burnPerSec,
    runwaySec,
  };
}

/**
 * Observed burn of the buffer from samples [{t, buffer}] (seconds, asset units).
 * A jump up (donation) restarts the window. Returns burn per second over the window, or null.
 */
export function observedBurn(samples, minWindowSec = 600) {
  if (!samples || samples.length < 2) return { burnPerSec: null, windowSec: 0, donations: [] };
  const donations = [];
  let start = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].buffer - samples[i - 1].buffer;
    const threshold = Math.max(1, Math.abs(samples[i - 1].buffer) * 1e-4);
    if (d > threshold) { donations.push({ t: samples[i].t, amount: d }); start = i; }
  }
  const a = samples[start];
  const b = samples[samples.length - 1];
  const dt = b.t - a.t;
  if (dt < minWindowSec) return { burnPerSec: null, windowSec: dt, donations };
  return { burnPerSec: (a.buffer - b.buffer) / dt, windowSec: dt, donations };
}

/* ================================================================================================
 * 20. MODULE: Morpho discovery
 * ================================================================================================ */
/**
 * Morpho API discovery: lists of vaults and markets for the configured asset, plus names and logos.
 * Never used for numbers. Values are inlined in the query (each filter expects a different scalar
 * type, so GraphQL variables cannot be shared); addresses are validated hex before use.
 */

/** First curator (name + logo) of a vault, falling back to the vault image. */
function curatorOf(list, meta) {
  const c = (list || [])[0];
  if (c) return { name: c.name || null, image: c.image || meta?.image || null };
  return meta?.image ? { name: null, image: meta.image } : null;
}

/**
 * @param {import("../../core/rpc-pool.js").RpcPool} pool
 * @param {string} asset
 * @param {number} chainId
 */
export async function discover(pool, asset, chainId, module = "morpho.discovery") {
  if (!isHexAddress(asset)) throw new Error("invalid asset address");
  const a = JSON.stringify([asset]);
  const c = JSON.stringify([Number(chainId)]);
  const query = `{
    v1: vaults(first: 50, where: { assetAddress_in: ${a}, chainId_in: ${c} }) {
      items { address name symbol listed state { curators { name image } } metadata { image } }
    }
    v2: vaultV2s(first: 50, where: { assetAddress_in: ${a}, chainId_in: ${c} }) {
      items { address name symbol listed adapters { items { address type } } curators { items { name image } } metadata { image } }
    }
    markets: markets(first: 200, where: { loanAssetAddress_in: ${a}, chainId_in: ${c} }) {
      items { marketId listed lltv irmAddress oracle { address }
              collateralAsset { address symbol decimals logoURI } }
    }
  }`;
  const j = await pool.postJson("", { query }, { module, label: "POST graphql" });
  if (j?.errors?.length) throw new Error(`Morpho API: ${j.errors.map((e) => e.message).join("; ")}`);
  const d = j?.data;
  if (!d) throw new Error("Morpho API: empty response");
  return {
    at: Date.now(),
    v1: (d.v1?.items || []).map((v) => ({ address: v.address, name: v.name, symbol: v.symbol, listed: !!v.listed, version: 1, curator: curatorOf(v.state?.curators, v.metadata) })),
    v2: (d.v2?.items || []).map((v) => ({
      address: v.address, name: v.name, symbol: v.symbol, listed: !!v.listed, version: 2, curator: curatorOf(v.curators?.items, v.metadata),
      adapters: (v.adapters?.items || []).map((x) => ({ address: x.address, type: x.type })),
    })),
    markets: (d.markets?.items || []).map((m) => ({
      id: m.marketId.toLowerCase(),
      listed: !!m.listed,
      lltv: m.lltv,
      irm: m.irmAddress,
      oracle: m.oracle?.address || null,
      collateral: m.collateralAsset
        ? { address: m.collateralAsset.address, symbol: m.collateralAsset.symbol, decimals: m.collateralAsset.decimals, logoURI: m.collateralAsset.logoURI || null }
        : null,
    })),
  };
}

/* ================================================================================================
 * 21. MODULE: Morpho
 * ================================================================================================ */
/**
 * DeFi/Morpho - vaults and markets for one asset (EURCV), all numbers read on-chain, on every chain of
 * config.morpho.chains where the asset is deployed and the chain enabled (Ethereum today, Base ready).
 * One MorphoChain reader per chain (its own discovery, caches and outputs); MorphoModule runs the reader
 * of the chain being ticked and publishes one envelope merging every chain (keys "chain:address" / "chain:id").
 *
 * Schedules (see frequency.js):
 *   morpho.vaults / morpho.markets                 whitelisted items
 *   morpho.vaults.others / morpho.markets.others   "Show more" items, only while expanded
 *
 * Per tick:
 *   0. discovery (Morpho API, cached 6 h) and structure (queues, adapters, cached 15 min) when needed
 *   A. one coalesced multicall: market(id), vault state, positions, adapter realAssets, lengths
 *   B. one multicall: IRM.borrowRateView(params, market) per market (needs A's market tuples)
 */

class Batch {
  constructor() { this.calls = []; this.cbs = []; }
  add(c, cb) { this.calls.push(c); this.cbs.push(cb); }
  async run(ctx, module) {
    if (!this.calls.length) return;
    const res = await ctx.call(this.calls, module);
    res.forEach((r, i) => this.cbs[i](r));
  }
}

const lc = (a) => (a ? a.toLowerCase() : a);
const isZero = (a) => !a || /^0x0{40}$/i.test(a);
const SAMPLE_KEEP_SEC = 7200;

/** Morpho reader of one chain: discovery, structure, on-chain reads and outputs (keys = lowercase addresses / ids). */
class MorphoChain {
  /** @param {any} app @param {MorphoModule} mod @param {string} chain */
  constructor(app, mod, chain) {
    const M = app.config.morpho;
    this.app = app;
    this.mod = mod;
    this.id = mod.id; // request accounting
    this.chain = chain;
    const cc = M.chains[chain];
    this.cfg = { ...M, ...cc, vaults: M.vaults.filter((v) => v.chain === chain), markets: M.markets.filter((x) => x.chain === chain) };
    const dep = app.config.tokens[M.asset].deployments[chain];
    this.asset = lc(dep.address);
    this.assetSymbol = M.asset;
    this.assetDecimals = dep.decimals;
    this.morpho = cc.morphoBlue;
    this.chainId = app.config.chains[chain].chainId;
    this.disc = storage.get(this.sk("morpho:discovery:v2"), null);
    /** immutable: market params and token metadata */
    this.imm = storage.get(this.sk("morpho:imm"), null) || { params: {}, tokens: {} };
    /** structure per vault address */
    this.structs = storage.get(this.sk("morpho:struct"), null) || {};
    this.samples = storage.get(this.sk("morpho:buffers"), null) || {};
    this.lastVaults = new Map();
    this.lastMarkets = new Map();
    /** last outputs (kept across ticks so groups refreshed at different times can be published together) */
    this.outVaults = new Map();
    this.outMarkets = new Map();
    /** raw per market for totals */
    this.rawMarkets = new Map();
    this._discP = null;
    if (this.disc) this.labelVaults();
  }

  /** Storage key: Ethereum keeps the original keys (existing caches stay valid), other chains get a suffix. */
  sk(name) { return this.chain === "ethereum" ? name : `${name}:${this.chain}`; }

  /** Warnings go to the module, prefixed with the chain when several chains are read. */
  warn(key, msg) {
    const multi = this.app.config.morpho.active.length > 1;
    this.mod.warn(`${this.chain}:${key}`, multi ? `${this.app.config.chains[this.chain].label}: ${msg}` : msg);
  }
  clearWarn(key) { this.mod.clearWarn(`${this.chain}:${key}`); }

  /* ------------- lists ------------- */

  labelVaults() {
    for (const v of [...(this.disc?.v1 || []), ...(this.disc?.v2 || [])]) this.app.labels.setAuto(this.chain, v.address, v.name, "morpho");
    for (const v of this.cfg.vaults) if (v.label) this.app.labels.setAuto(this.chain, v.address, v.label, "morpho");
  }

  allVaults() {
    const m = new Map();
    for (const v of [...(this.disc?.v1 || []), ...(this.disc?.v2 || [])]) {
      m.set(lc(v.address), { address: v.address, key: lc(v.address), apiName: v.name, listed: v.listed, versionHint: v.version, whitelist: false, incentives: false, label: null, curator: v.curator || null });
    }
    for (const v of this.cfg.vaults) {
      const k = lc(v.address);
      m.set(k, { ...(m.get(k) || { address: v.address, key: k, apiName: null, listed: null, versionHint: null }), whitelist: !!v.whitelist, incentives: !!v.incentives, label: v.label || null });
    }
    return m;
  }

  allMarkets() {
    const m = new Map();
    for (const x of this.disc?.markets || []) m.set(x.id, { id: x.id, meta: x, whitelist: false, idle: !x.collateral });
    for (const x of this.cfg.markets) {
      const id = lc(x.id);
      const cur = m.get(id) || { id, meta: null, idle: false };
      m.set(id, { ...cur, whitelist: !!x.whitelist });
    }
    // Idle-ness from on-chain params when known.
    for (const v of m.values()) {
      const p = this.imm.params[v.id];
      if (p) v.idle = isZero(p.collateralToken);
    }
    return m;
  }

  /* ------------- discovery / immutable / structure ------------- */

  async ensureDiscovery() {
    const ttl = (this.app.config.frequency.cacheTtl["morpho.discovery"] || 21600) * 1000;
    if (this.disc && Date.now() - this.disc.at < ttl) return;
    if (this._discP) return this._discP;
    this._discP = (async () => {
      try {
        this.disc = await discover(this.app.apiPools.morpho, this.asset, this.chainId);
        storage.set(this.sk("morpho:discovery:v2"), this.disc);
        this.labelVaults();
        this.clearWarn("discovery");
      } catch (e) {
        this.warn("discovery", `Morpho API discovery failed (${e.message}); using ${this.disc ? "the cached list" : "the whitelist only"}.`);
        // retry in 5 minutes
        this.disc = { ...(this.disc || { v1: [], v2: [], markets: [] }), at: Date.now() - ttl + 300000 };
      } finally {
        this._discP = null;
      }
    })();
    return this._discP;
  }

  async ensureParams(ctx, ids) {
    const missing = [...new Set(ids)].filter((id) => !this.imm.params[id]);
    if (missing.length) {
      const b = new Batch();
      for (const id of missing) {
        b.add(call(this.morpho, "idToMarketParams", enc.b32(id)), (r) => {
          const loanToken = dec.addr(r, 0);
          if (!loanToken || isZero(loanToken)) return; // unknown market id
          this.imm.params[id] = { loanToken, collateralToken: dec.addr(r, 1), oracle: dec.addr(r, 2), irm: dec.addr(r, 3), lltv: dec.uint(r, 4) };
        });
      }
      await b.run(ctx, this.id);
    }
    // collateral token metadata (from discovery when available, on-chain otherwise)
    const discMeta = new Map((this.disc?.markets || []).filter((m) => m.collateral).map((m) => [lc(m.collateral.address), m.collateral]));
    const needTok = [...new Set(ids.map((id) => this.imm.params[id]?.collateralToken).filter((a) => a && !isZero(a)).map(lc))]
      .filter((a) => !this.imm.tokens[a]);
    const b2 = new Batch();
    for (const a of needTok) {
      const dm = discMeta.get(a);
      if (dm) { this.imm.tokens[a] = { symbol: dm.symbol, decimals: dm.decimals, logoURI: dm.logoURI }; continue; }
      const t = { symbol: null, decimals: null, logoURI: null };
      this.imm.tokens[a] = t;
      b2.add(call(a, "symbol"), (r) => { t.symbol = dec.string(r) || "?"; });
      b2.add(call(a, "decimals"), (r) => { const d = dec.uint(r); t.decimals = d == null ? null : Number(d); });
    }
    await b2.run(ctx, this.id);
    // refresh logos from discovery
    for (const [a, dm] of discMeta) if (this.imm.tokens[a] && !this.imm.tokens[a].logoURI) this.imm.tokens[a].logoURI = dm.logoURI;
    storage.set(this.sk("morpho:imm"), this.imm);
  }

  structFresh(key) {
    const s = this.structs[key];
    const ttl = (this.app.config.frequency.cacheTtl["morpho.structure"] || 900) * 1000;
    return s && !s.dirty && Date.now() - s.at < ttl;
  }

  /** Load version, queue / adapters and adapter markets for vaults whose structure is missing or stale. */
  async ensureStructure(ctx, keys, depth = 0) {
    const need = [...new Set(keys)].filter((k) => !this.structFresh(k));
    if (!need.length) return;
    // 1. version, asset, name, lengths
    const b1 = new Batch();
    const tmp = {};
    for (const k of need) {
      const t = (tmp[k] = {});
      b1.add(call(k, "asset"), (r) => { t.asset = dec.addr(r); });
      b1.add(call(k, "name"), (r) => { t.name = dec.string(r); });
      b1.add(call(k, "adaptersLength"), (r) => { t.adaptersLength = dec.uint(r); });
      b1.add(call(k, "withdrawQueueLength"), (r) => { t.queueLength = dec.uint(r); });
    }
    await b1.run(ctx, this.id);
    // 2. queue items / adapters
    const b2 = new Batch();
    for (const k of need) {
      const t = tmp[k];
      t.version = t.adaptersLength != null ? 2 : t.queueLength != null ? 1 : null;
      if (t.version === 1) { t.queue = []; for (let i = 0; i < Number(t.queueLength); i++) b2.add(call(k, "withdrawQueue", enc.uint(i)), (r) => { t.queue[i] = lc(dec.b32(r)); }); }
      if (t.version === 2) { t.adapters = []; for (let i = 0; i < Number(t.adaptersLength); i++) b2.add(call(k, "adapters", enc.uint(i)), (r) => { t.adapters[i] = { address: lc(dec.addr(r)) }; }); }
    }
    await b2.run(ctx, this.id);
    // 3. adapter type
    const b3 = new Batch();
    for (const k of need) for (const ad of tmp[k].adapters || []) {
      b3.add(call(ad.address, "marketIdsLength"), (r) => { ad.marketIdsLength = dec.uint(r); });
      b3.add(call(ad.address, "marketParamsListLength"), (r) => { ad.marketParamsListLength = dec.uint(r); });
      b3.add(call(ad.address, "morphoVaultV1"), (r) => { ad.vault = dec.addr(r); });
    }
    await b3.run(ctx, this.id);
    // 4. adapter markets
    const b4 = new Batch();
    let needParamsMatch = false;
    for (const k of need) for (const ad of tmp[k].adapters || []) {
      if (ad.marketIdsLength != null) {
        ad.type = "MorphoMarketV1AdapterV2"; ad.marketIds = [];
        for (let i = 0; i < Number(ad.marketIdsLength); i++) b4.add(call(ad.address, "marketIds", enc.uint(i)), (r) => { ad.marketIds[i] = lc(dec.b32(r)); });
      } else if (ad.marketParamsListLength != null) {
        ad.type = "MorphoMarketV1Adapter"; ad.paramsList = []; needParamsMatch = true;
        for (let i = 0; i < Number(ad.marketParamsListLength); i++) b4.add(call(ad.address, "marketParamsList", enc.uint(i)), (r) => {
          ad.paramsList[i] = { loanToken: dec.addr(r, 0), collateralToken: dec.addr(r, 1), oracle: dec.addr(r, 2), irm: dec.addr(r, 3), lltv: dec.uint(r, 4) };
        });
      } else if (ad.vault && !isZero(ad.vault)) {
        ad.type = "MorphoVaultV1Adapter"; ad.vault = lc(ad.vault);
      } else {
        ad.type = "unknown";
      }
    }
    await b4.run(ctx, this.id);
    // Older adapters list market params: map them to ids through the params of known markets.
    if (needParamsMatch) {
      await this.ensureParams(ctx, [...this.allMarkets().keys()]);
      const key = (p) => [p.loanToken, p.collateralToken, p.oracle, p.irm].map(lc).join("|") + "|" + String(p.lltv);
      const byParams = new Map(Object.entries(this.imm.params).map(([id, p]) => [key(p), id]));
      for (const k of need) for (const ad of tmp[k].adapters || []) {
        if (ad.type !== "MorphoMarketV1Adapter") continue;
        ad.marketIds = ad.paramsList.map((p) => byParams.get(key(p))).filter(Boolean);
        if (ad.marketIds.length !== ad.paramsList.length) this.warn(`adapter:${ad.address}`, `Adapter ${ad.address}: ${ad.paramsList.length - ad.marketIds.length} market(s) not matched to a known market id.`);
        delete ad.paramsList;
      }
    }
    const underlying = [];
    for (const k of need) {
      const t = tmp[k];
      if (!t.version) { this.warn(`version:${k}`, `${k}: not recognised as a Morpho vault (V1 or V2).`); continue; }
      if (t.asset && lc(t.asset) !== this.asset) this.warn(`asset:${k}`, `${k}: asset is ${t.asset}, not ${this.assetSymbol}.`);
      this.structs[k] = { at: Date.now(), version: t.version, name: t.name, queue: t.queue, adapters: t.adapters };
      for (const ad of t.adapters || []) if (ad.type === "MorphoVaultV1Adapter") underlying.push(ad.vault);
      for (const ad of t.adapters || []) if (ad.type === "unknown") this.warn(`adapter:${ad.address}`, `Vault ${t.name || k}: adapter ${ad.address} has an unknown type; its yield is not counted.`);
    }
    storage.set(this.sk("morpho:struct"), this.structs);
    if (underlying.length && depth < 2) await this.ensureStructure(ctx, underlying, depth + 1);
  }

  /** Market ids used by a vault (V1 queue, V2 adapters, recursively through V1 vault adapters). */
  vaultMarketIds(key, seen = new Set()) {
    if (seen.has(key)) return [];
    seen.add(key);
    const s = this.structs[key];
    if (!s) return [];
    if (s.version === 1) return s.queue || [];
    return (s.adapters || []).flatMap((ad) => ad.type === "MorphoVaultV1Adapter" ? this.vaultMarketIds(ad.vault, seen) : ad.marketIds || []);
  }

  /** V1 vaults needed to value V2 vault adapters. */
  auxVaults(keys) {
    const out = new Set();
    for (const k of keys) for (const ad of this.structs[k]?.adapters || []) if (ad.type === "MorphoVaultV1Adapter") out.add(ad.vault);
    return [...out];
  }

  /* ------------- tick ------------- */

  /** One tick on this chain: reads what is due, keeps the outputs (published by the module). */
  async read(ctx, dueIds) {
    const due = new Set(dueIds);
    await this.ensureDiscovery();
    const vaults = this.allVaults();
    const markets = this.allMarkets();

    const targetVaults = [...vaults.values()].filter((v) => (v.whitelist ? due.has("morpho.vaults") : due.has("morpho.vaults.others")));
    const targetMarkets = [...markets.values()].filter((m) => !m.idle && (m.whitelist ? due.has("morpho.markets") : due.has("morpho.markets.others")));

    await this.ensureStructure(ctx, targetVaults.map((v) => v.key));
    const vaultKeys = targetVaults.map((v) => v.key).filter((k) => this.structs[k]);
    const aux = this.auxVaults(vaultKeys).filter((k) => this.structs[k]);
    const allVaultKeys = [...new Set([...vaultKeys, ...aux])];
    const neededMarkets = [...new Set([...targetMarkets.map((m) => m.id), ...allVaultKeys.flatMap((k) => this.vaultMarketIds(k))])];
    await this.ensureParams(ctx, neededMarkets);
    const marketIds = neededMarkets.filter((id) => this.imm.params[id]);

    /* Phase A */
    const A = new Batch();
    const mstate = {};
    for (const id of marketIds) {
      A.add(call(this.morpho, "market", enc.b32(id)), (r) => {
        if (!r.success) return;
        mstate[id] = { totalSupplyAssets: dec.uint(r, 0), totalSupplyShares: dec.uint(r, 1), totalBorrowAssets: dec.uint(r, 2), totalBorrowShares: dec.uint(r, 3), lastUpdate: dec.uint(r, 4), fee: dec.uint(r, 5) };
      });
    }
    const vstate = {};
    for (const k of allVaultKeys) {
      const s = this.structs[k];
      const v = (vstate[k] = { positions: {}, adapters: {} });
      A.add(call(k, "totalAssets"), (r) => { v.totalAssets = dec.uint(r); });
      A.add(call(k, "totalSupply"), (r) => { v.totalSupply = dec.uint(r); });
      A.add(call(this.asset, "balanceOf", enc.addr(k)), (r) => { v.balance = dec.uint(r) ?? 0n; });
      if (s.version === 1) {
        A.add(call(k, "fee"), (r) => { v.fee = dec.uint(r) ?? 0n; });
        A.add(call(k, "withdrawQueueLength"), (r) => { v.queueLength = dec.uint(r); });
        for (const id of s.queue || []) A.add(call(this.morpho, "position", enc.b32(id), enc.addr(k)), (r) => { v.positions[id] = dec.uint(r, 0) ?? 0n; });
      } else {
        A.add(call(k, "maxRate"), (r) => { v.maxRate = dec.uint(r) ?? 0n; });
        A.add(call(k, "performanceFee"), (r) => { v.performanceFee = dec.uint(r) ?? 0n; });
        A.add(call(k, "managementFee"), (r) => { v.managementFee = dec.uint(r) ?? 0n; });
        A.add(call(k, "adaptersLength"), (r) => { v.adaptersLength = dec.uint(r); });
        for (const ad of s.adapters || []) {
          const a = (v.adapters[ad.address] = { positions: {} });
          A.add(call(ad.address, "realAssets"), (r) => { a.realAssets = dec.uint(r) ?? 0n; });
          if (ad.type === "MorphoMarketV1AdapterV2") A.add(call(ad.address, "marketIdsLength"), (r) => { a.length = dec.uint(r); });
          if (ad.type === "MorphoMarketV1Adapter") A.add(call(ad.address, "marketParamsListLength"), (r) => { a.length = dec.uint(r); });
          for (const id of ad.marketIds || []) A.add(call(this.morpho, "position", enc.b32(id), enc.addr(ad.address)), (r) => { a.positions[id] = dec.uint(r, 0) ?? 0n; });
        }
      }
    }
    await A.run(ctx, this.id);

    /* Phase B: borrow rates */
    const B = new Batch();
    const rates = {};
    for (const id of marketIds) {
      const p = this.imm.params[id];
      const m = mstate[id];
      if (!m || isZero(p.irm)) { rates[id] = 0n; continue; }
      const words = [enc.addr(p.loanToken), enc.addr(p.collateralToken), enc.addr(p.oracle), enc.addr(p.irm), enc.uint(p.lltv),
        enc.uint(m.totalSupplyAssets), enc.uint(m.totalSupplyShares), enc.uint(m.totalBorrowAssets), enc.uint(m.totalBorrowShares), enc.uint(m.lastUpdate), enc.uint(m.fee)];
      B.add(call(p.irm, "borrowRateView", ...words), (r) => { rates[id] = dec.uint(r) ?? 0n; });
    }
    await B.run(ctx, this.id);

    const now = BigInt(ctx.blockTime ?? Math.floor(Date.now() / 1000));

    /* Markets */
    const mk = {}; // id -> { supply, borrow, rates, shares }
    for (const id of marketIds) {
      const p = this.imm.params[id];
      const s = mstate[id];
      if (!s) continue;
      const acc = accrue(s, rates[id], now, !isZero(p.irm));
      const r = marketRates(acc.supply, acc.borrow, rates[id], s.fee);
      mk[id] = { ...acc, ...r, totalSupplyShares: s.totalSupplyShares, idle: isZero(p.collateralToken) };
    }
    for (const id of marketIds) {
      const m = markets.get(id);
      if (!m || m.idle || !mk[id]) continue;
      if (!(m.whitelist ? due.has("morpho.markets") : due.has("morpho.markets.others"))) continue;
      this.outMarkets.set(id, this.marketOut(id, m, mk[id], ctx.block));
      this.rawMarkets.set(id, { supply: mk[id].supply, borrow: mk[id].borrow });
    }

    /* Vaults */
    const v1Rates = {};
    for (const k of allVaultKeys) if (this.structs[k].version === 1) v1Rates[k] = this.computeV1(k, vstate[k], mk);
    for (const v of targetVaults) {
      const s = this.structs[v.key];
      if (!s) continue;
      const out = s.version === 1 ? this.v1Out(v, s, v1Rates[v.key]) : this.computeV2(v, s, vstate[v.key], mk, v1Rates, ctx);
      out.block = ctx.block;
      this.outVaults.set(v.key, out);
    }

    // Structure change detection -> reload next tick
    for (const k of allVaultKeys) {
      const s = this.structs[k];
      const st = vstate[k];
      let dirty = false;
      if (s.version === 1 && st.queueLength != null && Number(st.queueLength) !== (s.queue || []).length) dirty = true;
      if (s.version === 2 && st.adaptersLength != null && Number(st.adaptersLength) !== (s.adapters || []).length) dirty = true;
      for (const ad of s.adapters || []) {
        const a = st.adapters[ad.address];
        if (a?.length != null && Number(a.length) !== (ad.marketIds || []).length) dirty = true;
      }
      if (dirty) s.dirty = true;
    }
    this.lastVaults = vaults;
    this.lastMarkets = markets;
  }

  /** Link to the Morpho app page of a vault or market (base URL in config.js -> morpho.appUrl). */
  appUrl(kind, id, name) {
    const base = (this.cfg.appUrl || `https://app.morpho.org/${this.chain}`).replace(/\/$/, "");
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `${base}/${kind}/${id}/${slug}`;
  }

  /* ------------- computations ------------- */

  marketOut(id, m, x, block) {
    const p = this.imm.params[id];
    const tok = this.imm.tokens[lc(p.collateralToken)] || {};
    const d = this.assetDecimals;
    return {
      id,
      pair: `${tok.symbol || "?"}/${this.assetSymbol}`,
      url: this.appUrl("market", id, `${tok.symbol || "market"}-${this.assetSymbol}`),
      collateral: { address: p.collateralToken, symbol: tok.symbol || null, logoURI: tok.logoURI || m.meta?.collateral?.logoURI || null },
      lltv: wadToFloat(p.lltv),
      oracle: p.oracle,
      irm: p.irm,
      totalSupplied: formatUnits(x.supply, d),
      totalBorrowed: formatUnits(x.borrow, d),
      availableLiquidity: formatUnits(x.supply - x.borrow, d),
      utilization: x.utilization,
      utilizationBand: utilizationBand(x.utilization),
      borrowApy: x.borrowApy,
      supplyApy: x.supplyApy,
      whitelist: m.whitelist,
      listed: m.meta?.listed ?? null,
      block,
    };
  }

  /** Allocation of a holder (vault or adapter) across markets. */
  allocation(positions, mk) {
    const d = this.assetDecimals;
    let assets = 0n, idle = 0n, organic = 0;
    const rows = [];
    for (const [id, shares] of Object.entries(positions)) {
      const m = mk[id];
      if (!m) continue;
      const a = toAssetsDown(shares, m.supply, m.totalSupplyShares);
      assets += a;
      if (m.idle) idle += a;
      const af = toNumber(a, d);
      organic += af * (m.idle ? 0 : m.supplyRate);
      if (a > 0n) {
        const p = this.imm.params[id];
        const tok = this.imm.tokens[lc(p.collateralToken)] || {};
        rows.push({ marketId: id, pair: m.idle ? `Idle market` : `${tok.symbol || "?"}/${this.assetSymbol}`, lltv: wadToFloat(p.lltv), assets: formatUnits(a, d), supplyApy: m.idle ? 0 : m.supplyApy, idle: m.idle });
      }
    }
    rows.sort((x, y) => Number(y.assets) - Number(x.assets));
    return { assets, idle, organic, rows };
  }

  computeV1(k, st, mk) {
    const d = this.assetDecimals;
    const al = this.allocation(st.positions, mk);
    const ta = toNumber(al.assets, d);
    const fee = wadToFloat(st.fee) || 0;
    const gross = ta > 0 ? al.organic / ta : 0;
    const net = gross * (1 - fee);
    return { st, al, gross, net, fee };
  }

  v1Out(v, s, r) {
    const d = this.assetDecimals;
    const real = r.al.assets + (r.st.balance || 0n);
    const idle = r.al.idle + (r.st.balance || 0n);
    const apy = rateToApy(r.net);
    return {
      address: v.address, key: v.key, label: v.label || v.apiName || s.name || v.address, version: 1,
      url: this.appUrl("vault", v.address, v.apiName || s.name || v.label || "vault"),
      whitelist: v.whitelist, listed: v.listed, incentivesEnabled: false, curator: v.curator || null,
      totalDeposits: r.st.totalAssets != null ? formatUnits(r.st.totalAssets, d) : null,
      realAssets: formatUnits(real, d),
      idle: formatUnits(idle, d),
      idlePct: real > 0n ? toNumber(idle, d) / toNumber(real, d) : 0,
      apy, grossApy: rateToApy(r.gross), nativeGrossApy: rateToApy(r.gross), nativeApy: apy, incentiveApy: null,
      fees: { performance: r.fee, management: 0 },
      allocation: r.al.rows,
    };
  }

  computeV2(v, s, st, mk, v1Rates, ctx) {
    const d = this.assetDecimals;
    let organic = 0;
    let idle = st.balance || 0n;
    let real = st.balance || 0n;
    const rows = [];
    for (const ad of s.adapters || []) {
      const a = st.adapters[ad.address];
      if (!a) continue;
      real += a.realAssets || 0n;
      if (ad.type === "MorphoVaultV1Adapter") {
        const u = v1Rates[ad.vault];
        const af = toNumber(a.realAssets || 0n, d);
        organic += af * (u ? u.net : 0);
        const name = this.structs[ad.vault]?.name || ad.vault;
        rows.push({ marketId: null, vault: ad.vault, pair: `Vault: ${name}`, assets: formatUnits(a.realAssets || 0n, d), supplyApy: u ? rateToApy(u.net) : null, idle: false });
      } else if (ad.marketIds) {
        const al = this.allocation(a.positions, mk);
        organic += al.organic;
        idle += al.idle;
        rows.push(...al.rows);
      }
    }
    rows.sort((x, y) => Number(y.assets) - Number(x.assets));
    const RA = toNumber(real, d);
    const TA = toNumber(st.totalAssets ?? 0n, d);
    const r = vaultV2Rates({
      realAssets: RA, totalAssets: TA, organicPerSec: organic,
      maxRate: wadToFloat(st.maxRate) || 0, performanceFee: wadToFloat(st.performanceFee) || 0, managementFee: wadToFloat(st.managementFee) || 0,
    });
    const out = {
      address: v.address, key: v.key, label: v.label || v.apiName || s.name || v.address, version: 2,
      url: this.appUrl("vault", v.address, v.apiName || s.name || v.label || "vault"),
      whitelist: v.whitelist, listed: v.listed, incentivesEnabled: v.incentives, curator: v.curator || null,
      totalDeposits: st.totalAssets != null ? formatUnits(st.totalAssets, d) : null,
      realAssets: formatUnits(real, d),
      idle: formatUnits(idle, d),
      idlePct: real > 0n ? toNumber(idle, d) / RA : 0,
      apy: r.apy, grossApy: r.grossApy, nativeGrossApy: r.nativeGrossApy, nativeApy: r.nativeApy, incentiveApy: r.incentiveApy, capApy: r.capApy,
      fees: { performance: wadToFloat(st.performanceFee) || 0, management: (wadToFloat(st.managementFee) || 0) * YEAR },
      allocation: rows,
    };
    if (v.incentives) {
      const t = Number(ctx.blockTime ?? Math.floor(Date.now() / 1000));
      const arr = (this.samples[v.key] ||= []);
      if (!arr.length || arr[arr.length - 1].t !== t) arr.push({ t, buffer: r.buffer });
      while (arr.length > 2 && arr[0].t < t - SAMPLE_KEEP_SEC) arr.shift();
      if (arr.length > 800) arr.splice(0, arr.length - 800);
      storage.set(this.sk("morpho:buffers"), this.samples);
      const obs = observedBurn(arr);
      const projDay = r.burnPerSec * 86400;
      const obsDay = obs.burnPerSec == null ? null : obs.burnPerSec * 86400;
      if (obsDay != null && projDay > 0 && Math.abs(obsDay - projDay) / projDay > 0.2) {
        this.warn(`burn:${v.key}`, `${out.label}: observed incentive burn (${obsDay.toFixed(0)}/day over ${Math.round(obs.windowSec / 60)} min) differs from the projection (${projDay.toFixed(0)}/day) by more than 20%.`);
      } else this.clearWarn(`burn:${v.key}`);
      out.incentives = {
        buffer: r.buffer,
        burnPerDay: projDay,
        runwaySec: Number.isFinite(r.runwaySec) ? r.runwaySec : null,
        runwayInfinite: !Number.isFinite(r.runwaySec),
        depletionAt: Number.isFinite(r.runwaySec) && r.runwaySec > 0 ? (t + r.runwaySec) * 1000 : null,
        observedBurnPerDay: obsDay,
        observedWindowSec: obs.windowSec,
        donations: obs.donations.slice(-5),
      };
    }
    return out;
  }

  /**
   * Outputs of this chain (copies: keys become "chain:address" / "chain:id", chain added), raw market
   * totals (BigInt) for the module's per-chain and overall totals, and the "Show more" counts.
   */
  build() {
    const vaults = this.lastVaults, markets = this.lastMarkets, c = this.chain;
    const vs = [...this.outVaults.values()].filter((v) => vaults.has(v.key))
      .map((v) => ({ ...v, key: `${c}:${v.key}`, chain: c, whitelist: vaults.get(v.key).whitelist }));
    const ms = [...this.outMarkets.values()].filter((m) => markets.has(m.id))
      .map((m) => ({ ...m, key: `${c}:${m.id}`, chain: c, whitelist: markets.get(m.id).whitelist, raw: this.rawMarkets.get(m.id) || null }));
    return {
      vaults: vs,
      markets: ms,
      othersVaults: [...vaults.values()].filter((v) => !v.whitelist).length,
      othersMarkets: [...markets.values()].filter((m) => !m.whitelist && !m.idle).length,
      discoveryAt: this.disc?.at || null,
    };
  }
}

export class MorphoModule extends Module {
  constructor(app) {
    const cfg = app.config.morpho;
    super(app, {
      id: "morpho", page: "morpho", chains: cfg.active,
      schedules: [
        { id: "morpho.vaults" },
        { id: "morpho.vaults.others", gate: "morpho.vaults.others" },
        { id: "morpho.markets" },
        { id: "morpho.markets.others", gate: "morpho.markets.others" },
      ],
    });
    this.cfg = cfg;
    /** chain -> MorphoChain */
    this.readers = Object.fromEntries(cfg.active.map((c) => [c, new MorphoChain(app, this, c)]));
  }

  async run(chain, ctx, dueIds) {
    await this.readers[chain].read(ctx, dueIds);
    this.sourceOk(chain, ctx.info());
    this.publish(this.build());
  }

  /**
   * Every chain together. Per chain and for "all": totals of the whitelisted markets (overview) and of every
   * market read (overviewAll, while "Show more" is open), "Show more" counts, and the Main Vault = the
   * config.morpho.mainVault override when it is on that chain, else the whitelisted vault with the largest deposits.
   */
  build() {
    const per = Object.fromEntries(Object.entries(this.readers).map(([c, r]) => [c, r.build()]));
    const sortV = (a, b) => Number(b.whitelist) - Number(a.whitelist) || Number(b.totalDeposits || 0) - Number(a.totalDeposits || 0);
    const sortM = (a, b) => Number(b.whitelist) - Number(a.whitelist) || Number(b.totalSupplied) - Number(a.totalSupplied);
    const vaults = Object.values(per).flatMap((x) => x.vaults).sort(sortV);
    const markets = Object.values(per).flatMap((x) => x.markets).sort(sortM);
    const d = this.app.config.tokens[this.cfg.asset].deployments;
    const totals = (list) => {
      // amounts of different chains have the asset's decimals of their chain: summed as decimal strings
      let sup = 0, bor = 0, n = 0;
      for (const m of list) if (m.raw) { sup += toNumber(m.raw.supply, d[m.chain].decimals); bor += toNumber(m.raw.borrow, d[m.chain].decimals); n++; }
      return { totalSupplied: String(sup), totalBorrowed: String(bor), utilization: sup > 0 ? bor / sup : 0, markets: n };
    };
    const override = this.cfg.mainVault ? lc(this.cfg.mainVault) : null;
    const isOverride = (v) => override && (v.key === override || lc(v.address) === override);
    const mainOf = (list) => {
      const o = list.find(isOverride);
      const m = o || list.filter((v) => v.whitelist).reduce((a, v) => (!a || Number(v.totalDeposits || 0) > Number(a.totalDeposits || 0) ? v : a), null);
      return m ? { key: m.key, source: o ? "config" : "largest deposits" } : null;
    };
    const scopes = ["all", ...Object.keys(per)];
    const pick = (scope, list) => (scope === "all" ? list : list.filter((x) => x.chain === scope));
    const by = (fn) => Object.fromEntries(scopes.map((sc) => [sc, fn(sc)]));
    const main = by((sc) => mainOf(pick(sc, vaults)));
    return {
      asset: this.cfg.asset,
      chains: Object.keys(per),
      mainVault: main.all?.key || null,
      mainVaultSource: main.all?.source || null,
      main,
      overviewBy: by((sc) => totals(pick(sc, markets).filter((m) => m.whitelist))),
      overviewAllBy: by((sc) => totals(pick(sc, markets))),
      countsBy: by((sc) => ({
        othersVaults: (sc === "all" ? Object.values(per) : [per[sc]]).reduce((s2, x) => s2 + x.othersVaults, 0),
        othersMarkets: (sc === "all" ? Object.values(per) : [per[sc]]).reduce((s2, x) => s2 + x.othersMarkets, 0),
      })),
      vaults: vaults.map((v) => v),
      markets: markets.map(({ raw, ...m }) => m),
      discoveryAt: Math.min(...Object.values(per).map((x) => x.discoveryAt || 0)) || null,
    };
  }
}

/**
 * Daily deposits history of a vault (Morpho API historicalState.totalAssets, interval DAY), fetched
 * only when a vault card is shown (Main Vault, or a vault unfolded in the table): one GraphQL call per
 * vault, cached in the browser (shared by the tabs) for cacheTtl["morpho.history"]. No RPC.
 */
export class MorphoHistory extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.cache = storage.get("morpho:history:v3", null) || {};
    this.pending = new Set();
    /** vault -> time of the last failure (retry after 60 s) */
    this.failed = {};
  }

  ttl() { return (this.app.config.frequency.cacheTtl?.["morpho.history"] || 21600) * 1000; }

  /** Cached points (or null) and a background fetch when missing or old. key = "chain:address". */
  get(key, version) {
    const h = this.cache[key];
    if ((!h || Date.now() - h.at >= this.ttl()) && !this.pending.has(key) && !(Date.now() - (this.failed[key] || 0) < 60000)) this.fetch(key, version);
    return h?.points || null;
  }

  state(key) { return this.cache[key] ? "ok" : this.pending.has(key) ? "loading" : this.failed[key] ? "error" : "loading"; }

  async fetch(key, version) {
    const M = this.app.config.morpho;
    const [chain, address] = key.includes(":") ? key.split(":") : [M.active[0], key];
    const dep = this.app.config.tokens[M.asset].deployments[chain];
    const chainId = this.app.config.chains[chain].chainId;
    if (!isHexAddress(address)) return;
    const q = `{ v: ${version === 2 ? "vaultV2ByAddress" : "vaultByAddress"}(address: "${address}", chainId: ${chainId}) { historicalState { totalAssets(options: { interval: DAY }) { x y } } } }`;
    this.pending.add(key);
    try {
      const j = await this.app.apiPools.morpho.postJson("", { query: q }, { module: "morpho.history", label: "POST graphql (history)" });
      const rows = j?.data?.v?.historicalState?.totalAssets;
      if (!Array.isArray(rows)) throw new Error(j?.errors?.[0]?.message || "no history in the answer");
      const points = rows.map((r) => [Number(r.x), toNumber(BigInt(r.y), dep.decimals)]).filter(([t, v]) => t > 0 && Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
      this.cache = { ...(storage.get("morpho:history:v3", null) || this.cache), [key]: { at: Date.now(), points } };
      const keys = Object.keys(this.cache).sort((a, b) => this.cache[b].at - this.cache[a].at);
      for (const k of keys.slice(12)) delete this.cache[k]; // keep the 12 most recent vaults
      storage.set("morpho:history:v3", this.cache);
      delete this.failed[key];
    } catch (e) {
      this.failed[key] = Date.now();
      console.warn("[morpho.history]", key, e);
    } finally {
      this.pending.delete(key);
      this.emit("change");
    }
  }
}

/* ================================================================================================
 * 22. MODULE: Uniswap
 * ================================================================================================ */
/**
 * DeFi/Uniswap - whitelisted pools only, v2, v3 or v4 (config: version). Every version is reduced to the
 * same state (sqrt price, current tick, active liquidity, initialized ticks, balances) so that price, peg,
 * TVL, depth, sale impact, the chart and the positions share one code path:
 *   v3  pool contract: balanceOf x2, slot0, liquidity(), TickLens words
 *   v2  pair: getReserves(); seen as one full-range position of liquidity sqrt(r0 x r1)
 *   v4  PoolManager singleton through StateView: getSlot0, getLiquidity, getTickBitmap, getTickLiquidity;
 *       balances computed from the liquidity (no per-pool balance in v4); fee = LP fee + protocol fee
 * Schedules:
 *   uniswap.pools     (every block, one coalesced multicall): pools + Chainlink oracles
 *   uniswap.positions (every 60 s): LP history (one large eth_getLogs the first time, cached, then new
 *                     blocks only) - v3 Mint/Burn, v2 LP-token Transfer, v4 ModifyLiquidity - and owners
 *                     (v3 NFT ids via a few receipts; v4 NFT id = position salt; v2 LP balances).
 *   uniswap.volume    (GeckoTerminal): 24 h volume in USD, all pools in one call.
 * All amounts in the swap maths are floats in raw token units: precise enough for display.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const Q96 = 2 ** 96;
export const sqrtAtTick = (t) => Math.pow(1.0001, t / 2);
/** TickLens word of a tick: floor(floor(tick / spacing) / 256). */
export const tickWord = (tick, spacing) => Math.floor(Math.floor(tick / spacing) / 256);

const int256 = (v) => (v >= 1n << 255n ? v - (1n << 256n) : v);

/** TickLens.getPopulatedTicksInWord -> [{tick, net}] (net: BigInt), null if the call failed. */
export function decodePopulatedTicks(r) {
  if (!r || !r.success) return null;
  const h = strip(r.data);
  const w = (i) => BigInt("0x" + (h.slice(64 * i, 64 * i + 64) || "0"));
  if (h.length < 128) return [];
  const off = Number(w(0)) / 32;
  const n = Number(w(off));
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = off + 1 + 3 * i;
    out.push({ tick: Number(int256(w(b))), net: int256(w(b + 1)) });
  }
  return out;
}

/** Raw token amounts held by liquidity L between two ticks at the current sqrt price. */
export function rangeAmounts(L, sqrtP, tl, tu) {
  const a = sqrtAtTick(tl), b = sqrtAtTick(tu);
  if (sqrtP <= a) return [L * (1 / a - 1 / b), 0];
  if (sqrtP >= b) return [0, L * (b - a)];
  return [L * (1 / sqrtP - 1 / b), L * (sqrtP - a)];
}

/**
 * Exact-input swap through a v3 pool, walking the initialized ticks.
 * @param {{sqrtP:number, tick:number, L:number, fee:number, ticks:{tick:number, net:number}[]}} s
 *        fee in pips (100 = 0.01%), or [fee token0->1, fee token1->0] (v4 protocol fee); ticks sorted ascending
 * @param {boolean} zeroForOne token0 in (price goes down)
 * @param {{amountIn?:number, sqrtLimit?:number}} o raw input (fee included) and/or price limit
 * @returns {{amountIn:number, amountOut:number, sqrtEnd:number, exhausted:boolean, drained:boolean}}
 *          exhausted: the input could not be fully used; drained: no liquidity left at the end price
 */
export function v3Swap(s, zeroForOne, o = {}) {
  const ticks = s.ticks;
  const feePips = Array.isArray(s.fee) ? s.fee[zeroForOne ? 0 : 1] : s.fee;
  let sq = s.sqrtP, L = s.L;
  // float sums of liquidityNet leave a residue where the true liquidity is 0
  const eps = 1e-9 * ticks.reduce((m, x) => Math.max(m, Math.abs(x.net)), s.L);
  let rem = o.amountIn == null ? Infinity : o.amountIn * (1 - feePips / 1e6);
  let used = 0, out = 0, exhausted = false;
  let i;
  if (zeroForOne) { i = ticks.length - 1; while (i >= 0 && ticks[i].tick > s.tick) i--; }
  else { i = 0; while (i < ticks.length && ticks[i].tick <= s.tick) i++; }
  for (let guard = 0; guard < 100000 && rem > 0; guard++) {
    const next = zeroForOne ? (i >= 0 ? ticks[i] : null) : (i < ticks.length ? ticks[i] : null);
    const sNext = sqrtAtTick(next ? next.tick : zeroForOne ? MIN_TICK : MAX_TICK);
    const limited = o.sqrtLimit != null && (zeroForOne ? o.sqrtLimit >= sNext : o.sqrtLimit <= sNext);
    const sT = limited ? o.sqrtLimit : sNext;
    if (L > eps) {
      const need = zeroForOne ? L * (1 / sT - 1 / sq) : L * (sT - sq);
      if (rem <= need) {
        const sNew = zeroForOne ? 1 / (1 / sq + rem / L) : sq + rem / L;
        out += zeroForOne ? L * (sq - sNew) : L * (1 / sq - 1 / sNew);
        used += rem; rem = 0; sq = sNew;
        break;
      }
      out += zeroForOne ? L * (sq - sT) : L * (1 / sq - 1 / sT);
      used += need; rem -= need;
    }
    sq = sT;
    if (limited) break;
    if (!next) { exhausted = true; break; }
    L += zeroForOne ? -next.net : next.net;
    if (L < eps) L = 0;
    i += zeroForOne ? -1 : 1;
  }
  return { amountIn: used / (1 - feePips / 1e6), amountOut: out, sqrtEnd: sq, exhausted, drained: exhausted || L <= eps };
}

const HISTORY_RETRY_MS = 300000;
const HISTORY_MAX_CHUNKS = 10;
const RECEIPTS_PER_ROUND = 4;
const RECEIPTS_KEEP = 2000;
const DYNAMIC_FEE = 0x800000; // v4: fee flag of pools whose hook sets the fee

/** Integer square root (BigInt). */
export function isqrt(n) {
  if (n < 2n) return n;
  let x = BigInt(Math.ceil(Math.sqrt(Number(n)) * (1 + 1e-12))) + 2n;
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) break; x = y; }
  while (x * x > n) x--;
  return x;
}

/** v4 swap fee in pips for one direction: protocol fee (12 bits per direction) on top of the LP fee. */
export function v4SwapFee(protocolFee, lpFee, zeroForOne) {
  const pf = zeroForOne ? protocolFee & 0xfff : protocolFee >> 12;
  return pf === 0 ? lpFee : pf + lpFee - Math.floor((pf * lpFee) / 1e6);
}

/** Tick map check: every position's +L/-L pair is present (sum = 0) and it gives liquidity() at the current tick. */
export function ticksConsistent(ticks, tick, L) {
  let sum = 0n, below = 0n;
  for (const x of ticks) { sum += x.net; if (x.tick <= tick) below += x.net; }
  return sum === 0n && below === L;
}

/** Bounds [tl, tu] of the open positions known from a pool's LP history (any version). */
function historyRanges(P) {
  if (!P) return [];
  const out = [];
  for (const k of Object.keys(P.direct || {})) { const [, tl, tu] = k.split("|"); out.push([+tl, +tu]); }
  for (const k of Object.keys(P.ranges || {})) { const [tl, tu] = k.split("|"); out.push([+tl, +tu]); }
  for (const k of Object.keys(P.liq || {})) { const [, tl, tu] = k.split("|"); out.push([+tl, +tu]); }
  return out;
}

export class UniswapModule extends Module {
  constructor(app) {
    const cfg = app.config.uniswap;
    super(app, {
      id: "uniswap", page: "uniswap", chains: [cfg.chain, "api:geckoterminal"],
      schedules: [
        { id: "uniswap.pools", chains: [cfg.chain] },
        { id: "uniswap.positions", chains: [cfg.chain] },
        { id: "uniswap.volume", chains: ["api:geckoterminal"] },
      ],
    });
    this.cfg = cfg;
    this.chain = cfg.chain;
    this.npm = String(cfg.npm || "").toLowerCase();
    const v4 = cfg.v4 || {};
    this.v4c = { stateView: v4.stateView, positionManager: String(v4.positionManager || "").toLowerCase(), poolManager: v4.poolManager };
    /** pool key (address, or v4 pool id) -> { version, token0, token1, t0:{symbol,decimals}, t1, fee, spacing, hooks? } */
    this.meta = storage.get(`uniswap:meta:v2:${this.chain}`, null) || {};
    /** pool key -> live state of the last block: { b0, b1, sqrtP, tick, L, ticks, complete, block, fee:[0->1, 1->0] } */
    this.state = {};
    /** pool key -> extra tick words added after an incomplete tick map */
    this.extraWords = {};
    /** v4 pool -> { sig, ticks } liquidityNet of the initialized ticks, re-read when the bitmap changes */
    this.tickCache = {};
    /** oracle key -> { value, label, address, updatedAt, fallback, reason } */
    this.oracles = {};
    this.vol = {};
    /**
     * LP history per pool: { to, ...shape }
     *   v3: direct {"owner|tl|tu": L}, ranges {"tl|tu": {net, txs[]}} (liquidity minted through the NFT manager)
     *   v2: holders {address: LP balance}
     *   v4: liq {"sender|tl|tu|salt": L}
     */
    this.lp = storage.get(`uniswap:lp:v1:${this.chain}`, null) || { pools: {} };
    /** v3: tx hash -> NFT ids minted/increased in it (IncreaseLiquidity of the position manager) */
    this.receipts = storage.get(`uniswap:receipts:v1:${this.chain}`, null) || {};
    /** v3: NFT id -> { pool, owner, tl, tu, L } (current, from positions(id)) */
    this.nft = {};
    /** v4: NFT id -> owner */
    this.owners = {};
    /** v2: pair -> LP token totalSupply */
    this.lpSupply = {};
    this.history = { status: "pending", error: null, at: null };
    this._historyRetryAt = 0;
  }

  pools() {
    return this.cfg.pools.map((p) => ({ ...p, version: p.version || "v3", key: String(p.id || p.address).toLowerCase() }));
  }

  /* ---------------- static pool data (read once, cached) ---------------- */

  async ensureMeta(ctx) {
    const todo = this.pools().filter((p) => !this.meta[p.key]?.t1?.decimals || this.meta[p.key].spacing == null);
    if (!todo.length) return;
    const plans = todo.map((p) => {
      if (p.version === "v2") {
        return { p, calls: [call(p.key, "token0"), call(p.key, "token1")],
          parse: (r) => (dec.addr(r[0]) && dec.addr(r[1]) ? { token0: dec.addr(r[0]), token1: dec.addr(r[1]), fee: p.fee ?? this.cfg.v2?.defaultFee ?? 3000, spacing: 1 } : null) };
      }
      if (p.version === "v4") {
        // PoolKey from the position manager (any pool with at least one NFT position), else from config poolKey
        return { p, calls: [call(this.v4c.positionManager, "poolKeys", p.key.slice(2, 52).padEnd(64, "0"))],
          parse: (r) => {
            const c0 = dec.addr(r[0], 0), c1 = dec.addr(r[0], 1);
            const k = c0 && (c0 !== ZERO_ADDRESS || c1 !== ZERO_ADDRESS)
              ? { currency0: c0, currency1: c1, fee: Number(dec.uint(r[0], 2)), tickSpacing: Number(dec.int(r[0], 3)), hooks: dec.addr(r[0], 4) }
              : p.poolKey ? { ...p.poolKey, currency0: lc(p.poolKey.currency0), currency1: lc(p.poolKey.currency1), hooks: lc(p.poolKey.hooks || ZERO_ADDRESS) } : null;
            return k ? { token0: k.currency0, token1: k.currency1, fee: k.fee, spacing: k.tickSpacing, hooks: k.hooks } : null;
          } };
      }
      return { p, calls: [call(p.key, "token0"), call(p.key, "token1"), call(p.key, "fee"), call(p.key, "tickSpacing")],
        parse: (r) => {
          const t0 = dec.addr(r[0]), t1 = dec.addr(r[1]), fee = dec.uint(r[2]), sp = dec.int(r[3]);
          return t0 && t1 && fee != null && sp != null ? { token0: t0, token1: t1, fee: Number(fee), spacing: Number(sp) } : null;
        } };
    });
    const res = await ctx.call(plans.flatMap((x) => x.calls), this.id);
    const pairs = {};
    const tokens = new Set();
    let i = 0;
    for (const x of plans) {
      const pr = x.parse(res.slice(i, i + x.calls.length));
      i += x.calls.length;
      if (!pr) { this.warn(`pool:${x.p.key}`, `${x.p.label}: pool data could not be read - check its address/id and version (${x.p.version}) in config.js`); continue; }
      this.clearWarn(`pool:${x.p.key}`);
      pairs[x.p.key] = { ...pr, version: x.p.version };
      tokens.add(pr.token0); tokens.add(pr.token1);
    }
    const tl = [...tokens].filter((t) => t !== ZERO_ADDRESS);
    const r2 = await ctx.call(tl.flatMap((t) => [call(t, "symbol"), call(t, "decimals")]), this.id);
    const tm = { [ZERO_ADDRESS]: { symbol: this.app.config.chains[this.chain].nativeSymbol || "ETH", decimals: 18 } };
    tl.forEach((t, n) => { tm[t] = { symbol: dec.string(r2[n * 2]) || "?", decimals: Number(dec.uint(r2[n * 2 + 1]) ?? 18n) }; });
    // Assign complete entries only, so a concurrent build() never sees half-filled metadata.
    for (const [a, p] of Object.entries(pairs)) this.meta[a] = { ...p, t0: tm[p.token0], t1: tm[p.token1] };
    storage.set(`uniswap:meta:v2:${this.chain}`, this.meta);
  }

  async run(chain, ctx, ids = []) {
    if (chain === "api:geckoterminal") {
      await this.runVolume();
      this.publish(this.build());
      return;
    }
    if (ids.includes("uniswap.pools") || !Object.keys(this.state).length) {
      await this.runPools(chain, ctx, ids.includes("uniswap.positions"));
      this.publish(this.build());
    }
    if (ids.includes("uniswap.positions")) {
      await this.runPositions(ctx);
      await this.refreshTicks(ctx);
      this.publish(this.build());
    }
  }

  /* ---------------- per block: pools + oracles ---------------- */

  /** Tick words to read for a pool: around the price, every open position's bounds, extras. */
  wordsFor(a, tick) {
    const m = this.meta[a];
    const sp = m.spacing;
    const set = new Set();
    const w = tickWord(tick, sp);
    for (let d = -1; d <= 1; d++) set.add(w + d);
    // open positions from the LP history (also the copy cached from the last visit, before it is refreshed)
    const P = this.lp.pools[a];
    for (const [tl, tu] of historyRanges(P)) { set.add(tickWord(tl, sp)); set.add(tickWord(tu, sp)); }
    // full-range positions sit in the two extreme words: always read them (2 tiny sub-calls)
    set.add(tickWord(Math.ceil(MIN_TICK / sp) * sp, sp));
    set.add(tickWord(Math.floor(MAX_TICK / sp) * sp, sp));
    for (const e of this.extraWords[a] || []) set.add(w + e);
    return [...set].filter((x) => x >= -32768 && x <= 32767).sort((x, y) => x - y);
  }

  async runPools(chain, ctx, force) {
    await this.ensureMeta(ctx);
    const pools = this.pools().filter((p) => this.meta[p.key]);
    const feeds = Object.entries(this.cfg.oracles || {}).flatMap(([k, o]) => o.feeds.map((f, i) => ({ key: k, i, f })));
    // every first read is queued synchronously, so pools and oracles share one multicall
    const reads = pools.map((p) => (p.version === "v2" ? this.readV2(ctx, p) : p.version === "v4" ? this.readV4(ctx, p, force) : this.readV3(ctx, p)));
    const fres = await ctx.call(feeds.map((x) => call(x.f.address, "latestRoundData")), this.id);
    this.readOracles(feeds, fres, ctx.blockTime);
    await Promise.all(reads);
    this.sourceOk(chain, ctx.info());
  }

  /** v3: balances, slot0, liquidity(), initialized ticks through TickLens. */
  async readV3(ctx, p) {
    const a = p.key, m = this.meta[a], prev = this.state[a];
    const tickP = prev ? this.readTicksV3(ctx, a, this.wordsFor(a, prev.tick)) : null;
    const res = await ctx.call([call(m.token0, "balanceOf", enc.addr(a)), call(m.token1, "balanceOf", enc.addr(a)), call(a, "slot0"), call(a, "liquidity")], this.id);
    const b0 = dec.uint(res[0]), b1 = dec.uint(res[1]);
    const sqrtX96 = dec.uint(res[2]), tick = dec.int(res[2], 1), L = dec.uint(res[3]);
    if (sqrtX96 == null || tick == null || L == null) { this.warn(`slot0:${a}`, `${p.label}: slot0()/liquidity() failed`); return; }
    this.clearWarn(`slot0:${a}`);
    const t = Number(tick);
    let tk = await tickP;
    if (!tk || !this.wordsFor(a, t).every((w) => tk.words.includes(w))) tk = await this.readTicksV3(ctx, a, this.wordsFor(a, t));
    this.state[a] = { b0, b1, sqrtP: Number(sqrtX96) / Q96, tick: t, L, ticks: tk.ticks, complete: this.checkTicks(p, tk, t, L, ctx.block), block: ctx.block, fee: [m.fee, m.fee] };
  }

  async readTicksV3(ctx, a, words) {
    const lens = this.cfg.tickLens;
    const res = await ctx.call(words.map((w) => call(lens, "getPopulatedTicksInWord", enc.addr(a), enc.int(w))), this.id);
    const ticks = [];
    let ok = true;
    res.forEach((r) => { const t = decodePopulatedTicks(r); if (t == null) ok = false; else ticks.push(...t); });
    return { ok, ticks: ticks.sort((x, y) => x.tick - y.tick), words };
  }

  /**
   * v2: getReserves(). A constant-product pair behaves exactly like a v3 pool holding one full-range
   * position of liquidity sqrt(r0 x r1), so price, depth, impact and chart reuse the v3 maths.
   */
  async readV2(ctx, p) {
    const a = p.key, m = this.meta[a];
    const res = await ctx.call([call(a, "getReserves")], this.id);
    const r0 = dec.uint(res[0], 0), r1 = dec.uint(res[0], 1);
    if (!r0 || !r1) { this.warn(`slot0:${a}`, `${p.label}: getReserves() failed or the pair is empty`); return; }
    this.clearWarn(`slot0:${a}`);
    const L = isqrt(r0 * r1);
    const ratio = Number(r1) / Number(r0);
    this.state[a] = {
      b0: r0, b1: r1, sqrtP: Math.sqrt(ratio), tick: Math.floor(Math.log(ratio) / Math.log(1.0001)), L,
      ticks: [{ tick: MIN_TICK, net: L }, { tick: MAX_TICK, net: -L }], complete: true, block: ctx.block, fee: [m.fee, m.fee],
    };
  }

  /**
   * v4: every pool lives in the PoolManager; state through StateView (getSlot0, getLiquidity,
   * getTickBitmap, getTickLiquidity). No per-pool balance exists: the amounts are computed from the
   * liquidity of each tick range (they exclude fees not yet collected).
   */
  async readV4(ctx, p, force) {
    const sv = this.v4c.stateView, id = p.key, m = this.meta[id], prev = this.state[id];
    const words = prev ? this.wordsFor(id, prev.tick) : null;
    const bmP = words ? ctx.call(words.map((w) => call(sv, "getTickBitmap", enc.b32(id), enc.int(w))), this.id) : null;
    const res = await ctx.call([call(sv, "getSlot0", enc.b32(id)), call(sv, "getLiquidity", enc.b32(id))], this.id);
    const sqrtX96 = dec.uint(res[0], 0), tick = dec.int(res[0], 1), pf = dec.uint(res[0], 2), lpFee = dec.uint(res[0], 3), L = dec.uint(res[1]);
    if (!sqrtX96 || tick == null || L == null) { this.warn(`slot0:${id}`, `${p.label}: StateView getSlot0()/getLiquidity() failed or the pool is not initialized`); return; }
    this.clearWarn(`slot0:${id}`);
    const t = Number(tick);
    let ws = words, bm = await bmP;
    const need = this.wordsFor(id, t);
    if (!ws || !need.every((w) => ws.includes(w))) { ws = need; bm = await ctx.call(ws.map((w) => call(sv, "getTickBitmap", enc.b32(id), enc.int(w))), this.id); }
    let ok = true;
    const init = [];
    ws.forEach((w, i) => {
      const b = dec.uint(bm[i]);
      if (b == null) { ok = false; return; }
      for (let bit = 0; b >> BigInt(bit) > 0n; bit++) if ((b >> BigInt(bit)) & 1n) init.push((w * 256 + bit) * m.spacing);
    });
    init.sort((x, y) => x - y);
    const sig = init.join(",");
    const c = this.tickCache[id];
    let tk = !force && c && c.sig === sig && ticksConsistent(c.ticks, t, L) ? { ok, ticks: c.ticks, words: ws } : null;
    if (!tk) {
      const r = await ctx.call(init.map((x) => call(sv, "getTickLiquidity", enc.b32(id), enc.int(x))), this.id);
      const ticks = init.map((x, i) => ({ tick: x, net: dec.int(r[i], 1) ?? 0n }));
      tk = { ok: ok && r.every((x) => x.success), ticks, words: ws };
      this.tickCache[id] = { sig, ticks };
    }
    const sqrtP = Number(sqrtX96) / Q96;
    let a0 = 0, a1 = 0, cur = 0n;
    for (let i = 0; i < tk.ticks.length - 1; i++) {
      cur += tk.ticks[i].net;
      if (cur <= 0n) continue;
      const [x0, x1] = rangeAmounts(Number(cur), sqrtP, tk.ticks[i].tick, tk.ticks[i + 1].tick);
      a0 += x0; a1 += x1;
    }
    const pfN = Number(pf ?? 0n), lpN = Number(lpFee ?? 0n);
    this.state[id] = {
      b0: BigInt(Math.round(a0)), b1: BigInt(Math.round(a1)), balancesFromLiquidity: true,
      sqrtP, tick: t, L, ticks: tk.ticks, complete: this.checkTicks(p, tk, t, L, ctx.block), block: ctx.block,
      fee: [v4SwapFee(pfN, lpN, true), v4SwapFee(pfN, lpN, false)], lpFee: lpN, protocolFee: pfN,
    };
  }

  /**
   * The tick map is complete when every position's +L/-L pair is in it and it gives liquidity() at the
   * current tick. Otherwise more words are read (same block after the LP history arrives, else next block).
   */
  checkTicks(p, tk, t, L, block) {
    const a = p.key;
    const complete = tk.ok && ticksConsistent(tk.ticks, t, L);
    if (!complete) {
      const ex = this.extraWords[a] || [];
      const reach = ex.length ? Math.max(...ex.map(Math.abs)) : 1;
      if (reach < 16) this.extraWords[a] = Array.from({ length: reach * 4 + 1 }, (_, k) => k - reach * 2);
      this.warn(`ticks:${a}`, `${p.label}: tick map incomplete at block ${block}; depth, impact and chart are approximate.`);
    } else this.clearWarn(`ticks:${a}`);
    return complete;
  }

  /** Re-read the ticks of incomplete pools in the same block (e.g. once the LP history gave the position bounds). */
  async refreshTicks(ctx) {
    await Promise.all(this.pools().filter((p) => this.state[p.key] && !this.state[p.key].complete && this.state[p.key].block === ctx.block).map(async (p) => {
      if (p.version === "v4") return this.readV4(ctx, p, true);
      const st = this.state[p.key];
      const tk = await this.readTicksV3(ctx, p.key, this.wordsFor(p.key, st.tick));
      this.state[p.key] = { ...st, ticks: tk.ticks, complete: this.checkTicks(p, tk, st.tick, st.L, ctx.block) };
    }));
  }

  readOracles(feeds, res, now) {
    const groups = {};
    feeds.forEach((x, n) => {
      const r = res[n];
      const answer = dec.int(r, 1), updatedAt = dec.uint(r, 3);
      (groups[x.key] ||= [])[x.i] = { ...x.f, value: answer != null && answer > 0n ? Number(answer) / 10 ** (x.f.decimals ?? 8) : null, updatedAt: updatedAt == null ? null : Number(updatedAt) };
    });
    for (const [key, list] of Object.entries(groups)) {
      const o = this.cfg.oracles[key];
      const t = now || Date.now() / 1000;
      const fresh = (f) => f && f.value != null && f.updatedAt != null && t - f.updatedAt <= (o.maxAgeSec || 93600);
      let chosen = null, reason = "";
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!fresh(f)) { reason ||= `${f?.label || "feed"}: ${f?.value == null ? "no answer" : "stale"}`; continue; }
        const next = list.slice(i + 1).find(fresh);
        if (next && o.maxDeviation != null && Math.abs(f.value / next.value - 1) > o.maxDeviation) { reason ||= `${f.label}: ${pctTxt(f.value / next.value - 1)} away from ${next.label}`; continue; }
        chosen = { ...f, fallback: i > 0, reason: i > 0 ? reason : "" };
        break;
      }
      if (chosen) this.oracles[key] = chosen;
      if (!chosen) this.warn(`oracle:${key}`, `${key}: no usable Chainlink answer (${reason || "all feeds failed"})${this.oracles[key] ? "; showing the last value" : ""}`);
      else if (chosen.fallback) this.warn(`oracle:${key}`, `${key}: ${chosen.reason}; using ${chosen.label}`);
      else this.clearWarn(`oracle:${key}`);
    }
  }

  /* ---------------- every minute: LP positions ---------------- */

  async runPositions(ctx) {
    await this.updateHistory(ctx);
    await this.readPositions(ctx);
  }

  /** Log filter of the LP history of a group of pools of one version. */
  historyFilter(version, pools) {
    if (version === "v2") return { address: pools.map((p) => p.key), topics: [TOPIC.Transfer] };
    if (version === "v4") return { address: [this.v4c.poolManager], topics: [TOPIC.ModifyLiquidity, pools.map((p) => p.key)] };
    return { address: pools.map((p) => p.key), topics: [[TOPIC.UniMint, TOPIC.UniBurn]] };
  }

  /** Apply one LP history log to the pool state (shape depends on the version). */
  applyLog(version, P, l) {
    if (version === "v2") {
      const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]), v = logWord(l.data, 0);
      const H = (P.holders ||= {});
      if (from !== ZERO_ADDRESS) { const b = (H[from] || 0n) - v; if (b > 0n) H[from] = b; else delete H[from]; }
      if (to !== ZERO_ADDRESS) H[to] = (H[to] || 0n) + v;
      return;
    }
    if (version === "v4") {
      const sender = topicAddr(l.topics[2]);
      const tl = Number(int256(logWord(l.data, 0))), tu = Number(int256(logWord(l.data, 1)));
      const delta = int256(logWord(l.data, 2));
      const salt = "0x" + strip(l.data).slice(192, 256);
      const k = `${sender}|${tl}|${tu}|${salt}`;
      const Q = (P.liq ||= {});
      const v = (Q[k] || 0n) + delta;
      if (v > 0n) Q[k] = v; else delete Q[k];
      return;
    }
    const mint = l.topics[0].toLowerCase() === TOPIC.UniMint;
    const owner = topicAddr(l.topics[1]);
    const tl = Number(int256(BigInt(l.topics[2]))), tu = Number(int256(BigInt(l.topics[3])));
    const amt = logWord(l.data, mint ? 1 : 0);
    if (owner === this.npm) {
      const k = `${tl}|${tu}`;
      const r = ((P.ranges ||= {})[k] ||= { net: 0n, txs: [] });
      r.net += mint ? amt : -amt;
      if (mint && !r.txs.includes(l.transactionHash)) r.txs.push(l.transactionHash);
      if (r.net <= 0n) delete P.ranges[k]; // closed: its NFTs are empty, forget their txs
    } else {
      const k = `${owner}|${tl}|${tu}`;
      const D = (P.direct ||= {});
      const v = (D[k] || 0n) + (mint ? amt : -amt);
      if (v > 0n) D[k] = v; else delete D[k];
    }
  }

  async updateHistory(ctx) {
    if (this.history.status === "error" && Date.now() < this._historyRetryAt) return;
    const head = ctx.logHead;
    const jobs = [];
    for (const version of ["v2", "v3", "v4"]) {
      const pools = this.pools().filter((p) => p.version === version);
      const fresh = pools.filter((p) => !this.lp.pools[p.key]);
      const known = pools.filter((p) => this.lp.pools[p.key] && this.lp.pools[p.key].to < head);
      if (fresh.length) jobs.push({ version, pools: fresh, from: Math.min(...fresh.map((p) => p.createdBlock || 0)) });
      if (known.length) jobs.push({ version, pools: known, from: Math.min(...known.map((p) => this.lp.pools[p.key].to + 1)) });
    }
    const firstEver = !Object.keys(this.lp.pools).length;
    try {
      for (const j of jobs) {
        // Never split a long history into hundreds of small requests: without an endpoint serving large
        // ranges (NOWNodes), report the history as unavailable instead.
        const maxRange = this.app.adapters[this.chain].pool.maxOf("maxLogRange", (ep) => ep.capabilities.has("logs"));
        if ((head - j.from + 1) / maxRange > HISTORY_MAX_CHUNKS) throw new Error(`no endpoint serves eth_getLogs over ${num(head - j.from + 1)} blocks (largest range: ${num(maxRange)})`);
        const logs = await ctx.logs(this.historyFilter(j.version, j.pools), j.from, head, "uniswap.positions");
        logs.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)));
        for (const p of j.pools) this.lp.pools[p.key] ||= { to: 0 };
        for (const l of logs) {
          const key = j.version === "v4" ? l.topics[1].toLowerCase() : l.address.toLowerCase();
          const P = this.lp.pools[key];
          if (!P || Number(BigInt(l.blockNumber)) <= P.to) continue;
          this.applyLog(j.version, P, l);
        }
        for (const p of j.pools) this.lp.pools[p.key].to = head;
      }
      storage.set(`uniswap:lp:v1:${this.chain}`, this.lp);
      this.history = { status: "ok", error: null, at: Date.now() };
      this.clearWarn("history");
    } catch (e) {
      this.history = { status: firstEver || this.history.status !== "ok" ? "error" : "stale", error: String(e?.message || e).slice(0, 200), at: this.history.at };
      this._historyRetryAt = Date.now() + HISTORY_RETRY_MS;
      this.warn("history", `LP history unavailable (${this.history.error}). It needs an endpoint serving large eth_getLogs ranges (NOWNodes); retried in 5 min.`);
    }
  }

  async receipt(tx) {
    const r = await this.app.adapters[this.chain].pool.jsonRpc("eth_getTransactionReceipt", [tx], { module: "uniswap.positions", filter: (ep) => ep.capabilities.has("calls") });
    const ids = (r?.logs || []).filter((l) => l.address.toLowerCase() === this.npm && l.topics[0]?.toLowerCase() === TOPIC.IncreaseLiquidity).map((l) => BigInt(l.topics[1]).toString());
    this.receipts[tx] = [...new Set(ids)];
  }

  /**
   * Current owners and liquidity of the positions:
   *   v2: LP token totalSupply (holders' shares)     v4: ownerOf(id) of the NFTs (id = salt of the position)
   *   v3: positions(id) + ownerOf(id) of the NFT ids of the open ranges; more receipts when sums do not match.
   */
  async readPositions(ctx) {
    if (this.history.status === "pending") return;
    const pools = this.pools();
    const v2 = pools.filter((p) => p.version === "v2" && this.lp.pools[p.key]);
    const v4ids = [];
    for (const p of pools.filter((x) => x.version === "v4")) {
      for (const k of Object.keys(this.lp.pools[p.key]?.liq || {})) {
        const [sender, , , salt] = k.split("|");
        if (sender === this.v4c.positionManager) v4ids.push(BigInt(salt).toString());
      }
    }
    const extra = [...v2.map((p) => call(p.key, "totalSupply")), ...v4ids.map((id) => call(this.v4c.positionManager, "ownerOf", enc.uint(id)))];
    const xr = await ctx.call(extra, "uniswap.positions");
    v2.forEach((p, i) => { const s = dec.uint(xr[i]); if (s) this.lpSupply[p.key] = s; });
    v4ids.forEach((id, i) => { const o = dec.addr(xr[v2.length + i]); if (o) this.owners[id] = o; });

    const npm = this.cfg.npm;
    let fetched = false;
    for (let round = 0; round < 3; round++) {
      const ids = new Set();
      for (const P of Object.values(this.lp.pools)) for (const r of Object.values(P.ranges || {})) for (const tx of r.txs) for (const id of this.receipts[tx] || []) ids.add(id);
      const list = [...ids];
      const res = await ctx.call(list.flatMap((id) => [call(npm, "npmPositions", enc.uint(id)), call(npm, "ownerOf", enc.uint(id))]), "uniswap.positions");
      const nft = {};
      list.forEach((id, i) => {
        const r = res[i * 2];
        const L = dec.uint(r, 7);
        if (L == null || L === 0n) return;
        const t0 = dec.addr(r, 2), t1 = dec.addr(r, 3), fee = Number(dec.uint(r, 4));
        const pool = pools.find((p) => { const m = this.meta[p.key]; return p.version === "v3" && m && m.token0 === t0 && m.token1 === t1 && m.fee === fee; });
        if (!pool) return;
        nft[id] = { pool: pool.key, owner: dec.addr(res[i * 2 + 1]), tl: Number(dec.int(r, 5)), tu: Number(dec.int(r, 6)), L };
      });
      this.nft = nft;
      // Ranges whose NFTs do not add up to the liquidity seen in the logs: resolve older txs (newest first).
      const todo = [];
      for (const [a, P] of Object.entries(this.lp.pools)) {
        for (const [k, r] of Object.entries(P.ranges || {})) {
          const [tl, tu] = k.split("|").map(Number);
          const got = Object.values(nft).filter((n) => n.pool === a && n.tl === tl && n.tu === tu).reduce((s, n) => s + n.L, 0n);
          if (got >= r.net) continue;
          const next = [...r.txs].reverse().find((tx) => !this.receipts[tx]);
          if (next) todo.push(next);
        }
      }
      if (!todo.length) break;
      await Promise.all(todo.slice(0, RECEIPTS_PER_ROUND).map((tx) => this.receipt(tx).catch(() => {})));
      fetched = true;
    }
    if (fetched) {
      const keys = Object.keys(this.receipts);
      if (keys.length > RECEIPTS_KEEP) keys.slice(0, keys.length - RECEIPTS_KEEP).forEach((k) => delete this.receipts[k]);
      storage.set(`uniswap:receipts:v1:${this.chain}`, this.receipts);
    }
  }

  /* ---------------- GeckoTerminal ---------------- */

  async runVolume() {
    const pool = this.app.apiPools.geckoterminal;
    const addrs = this.pools().map((p) => p.key);
    const info = {};
    const j = await pool.getJson(`/networks/${this.cfg.network}/pools/multi/${addrs.join(",")}`, { module: this.id, info, label: "GET pools/multi" });
    const seen = new Set();
    for (const p of j?.data || []) {
      const a = String(p.attributes?.address || "").toLowerCase();
      const v = p.attributes?.volume_usd?.h24;
      seen.add(a);
      this.vol[a] = { volumeUsd24h: v == null ? null : Number(v), at: Date.now() };
    }
    const missing = addrs.filter((a) => !seen.has(a));
    if (missing.length) this.warn("gt-missing", `GeckoTerminal has no data for ${missing.join(", ")}`); else this.clearWarn("gt-missing");
    this.sourceOk("geckoterminal", { endpoint: info.endpoint });
  }

  /* ---------------- output ---------------- */

  /** USD value of one unit of a symbol (config usdValue / peg: oracle key or number). */
  usdOf(spec) {
    if (typeof spec === "number") return spec;
    if (typeof spec === "string") return this.oracles[spec]?.value ?? null;
    return null;
  }

  /** Open positions of a pool, as ranges of liquidity (every version maps to the same shape). */
  rawPositions(p, st) {
    const a = p.key, P = this.lp.pools[a];
    const raw = [];
    if (!P) return raw;
    if (p.version === "v2") {
      const ts = this.lpSupply[a];
      if (!ts) return raw;
      for (const [owner, bal] of Object.entries(P.holders || {})) raw.push({ kind: "lp", owner, tl: MIN_TICK, tu: MAX_TICK, L: (st.L * bal) / ts });
      return raw;
    }
    if (p.version === "v4") {
      for (const [k, L] of Object.entries(P.liq || {})) {
        const [sender, tl, tu, salt] = k.split("|");
        const isNft = sender === this.v4c.positionManager;
        const id = isNft ? BigInt(salt).toString() : null;
        raw.push({ kind: isNft ? "nft" : "direct", tokenId: id, owner: isNft ? this.owners[id] || sender : sender, unresolved: isNft && !this.owners[id], tl: +tl, tu: +tu, L });
      }
      return raw;
    }
    for (const [key, L] of Object.entries(P.direct || {})) { const [owner, tl, tu] = key.split("|"); raw.push({ kind: "direct", owner, tl: +tl, tu: +tu, L }); }
    for (const [id, n] of Object.entries(this.nft)) if (n.pool === a) raw.push({ kind: "nft", tokenId: id, owner: n.owner, tl: n.tl, tu: n.tu, L: n.L });
    for (const [key, r] of Object.entries(P.ranges || {})) {
      const [tl, tu] = key.split("|").map(Number);
      const got = Object.values(this.nft).filter((n) => n.pool === a && n.tl === tl && n.tu === tu).reduce((s, n) => s + n.L, 0n);
      if (r.net > got) raw.push({ kind: "npm", owner: this.npm, tl, tu, L: r.net - got, unresolved: true });
    }
    return raw;
  }

  build() {
    const C = this.cfg;
    const cvSyms = new Set(Object.keys(this.app.config.tokens));
    let tvl = 0, tvlOk = true, vol = 0, volOk = true;
    const pools = this.pools().map((p) => {
      const a = p.key, m = this.meta[a], st = this.state[a], v = this.vol[a];
      const base = { slug: p.slug, address: p.id || p.address, label: p.label, version: p.version, volumeUsd24h: v?.volumeUsd24h ?? null };
      if (v?.volumeUsd24h != null) vol += v.volumeUsd24h; else volOk = false;
      if (!m?.t0 || !m?.t1 || !st) { tvlOk = false; return { ...base, ready: false }; }
      const cvIs0 = cvSyms.has(m.t0.symbol) || !cvSyms.has(m.t1.symbol);
      const cv = cvIs0 ? m.t0 : m.t1, ct = cvIs0 ? m.t1 : m.t0;
      const dCv = cv.decimals, dCt = ct.decimals;
      const d0 = m.t0.decimals, d1 = m.t1.decimals;
      const sqrtP = st.sqrtP;
      const p01 = sqrtP * sqrtP * 10 ** (d0 - d1); // token1 per token0
      const mid = cvIs0 ? p01 : 1 / p01; // counter per CoinVertible
      const usdCt = this.usdOf(C.usdValue?.[ct.symbol]);
      const usdCv = this.usdOf(C.usdValue?.[cv.symbol]);
      const target = this.usdOf(C.peg?.[cv.symbol]);
      const pegPrice = target != null && usdCt ? target / usdCt : null;
      const deviation = pegPrice ? mid / pegPrice - 1 : null;

      const amt0 = Number(formatUnits(st.b0 ?? 0n, d0)), amt1 = Number(formatUnits(st.b1 ?? 0n, d1));
      const usd0 = this.usdOf(C.usdValue?.[m.t0.symbol]), usd1 = this.usdOf(C.usdValue?.[m.t1.symbol]);
      const val0 = usd0 != null ? amt0 * usd0 : null, val1 = usd1 != null ? amt1 * usd1 : null;
      const poolTvl = val0 != null && val1 != null ? val0 + val1 : null;
      if (poolTvl != null && st.b0 != null && st.b1 != null) tvl += poolTvl; else tvlOk = false;
      const composition = [[m.t0, amt0, val0], [m.t1, amt1, val1]]
        .map(([t, amount, usd]) => ({ symbol: t.symbol, amount, usd, share: poolTvl ? usd / poolTvl : null, cv: t === cv }))
        .sort((x, y) => Number(y.cv) - Number(x.cv));

      // ---- swap maths (raw units), same for every version ----
      const ticks = st.ticks.map((x) => ({ tick: x.tick, net: Number(x.net) }));
      const S = { sqrtP, tick: st.tick, L: Number(st.L), fee: st.fee, ticks };
      const sellCv = cvIs0; // zeroForOne when the CoinVertible is token0
      const k = 10 ** (d0 - d1);
      // sqrt price at which the CoinVertible price (counter per CV) equals `price`
      const sqrtForCvPrice = (price) => Math.sqrt((cvIs0 ? price : 1 / price) / k);
      const usdCvEq = usdCv ?? (target ?? null);
      const depth = (C.depthBps || []).map((bps) => {
        const x = bps / 1e4;
        const s1 = v3Swap(S, sellCv, { sqrtLimit: sqrtForCvPrice(mid * (1 - x)) });
        const s2 = v3Swap(S, !sellCv, { sqrtLimit: sqrtForCvPrice(mid * (1 + x)) });
        const sold = s1.amountIn / 10 ** dCv, bought = s2.amountOut / 10 ** dCv, paid = s2.amountIn / 10 ** dCt;
        return {
          bps,
          sell: { amount: sold, usd: usdCvEq != null ? sold * usdCvEq : null, drained: s1.drained },
          buy: { amount: bought, cost: paid, usd: usdCt != null ? paid * usdCt : null, drained: s2.drained },
        };
      });
      const maxSale = v3Swap(S, sellCv, {});
      const maxIn = maxSale.exhausted ? maxSale.amountIn / 10 ** dCv : null;
      const impact = (C.impactSizes || []).map((size) => {
        const r = v3Swap(S, sellCv, { amountIn: size * 10 ** dCv });
        if (r.exhausted) return { size, exceeds: true, max: maxIn, maxOut: maxSale.amountOut / 10 ** dCt };
        const out = r.amountOut / 10 ** dCt;
        const avg = out / size;
        const after = (() => { const q = r.sqrtEnd * r.sqrtEnd * k; return cvIs0 ? q : 1 / q; })();
        return { size, exceeds: false, out, usd: usdCt != null ? out * usdCt : null, avgPrice: avg, impact: avg / mid - 1, priceAfter: after, moveAfter: after / mid - 1 };
      });

      // ---- LP positions ----
      const priceOfTick = (t) => { const q = 1.0001 ** t * k; return cvIs0 ? q : 1 / q; };
      const activeL = Number(st.L);
      // positions worth less than 1 unit of the CoinVertible (dust) are left out
      const positions = this.rawPositions(p, st).map((q) => {
        const [r0, r1] = rangeAmounts(Number(q.L), sqrtP, q.tl, q.tu);
        const a0 = r0 / 10 ** d0, a1 = r1 / 10 ** d1;
        const amtCv = cvIs0 ? a0 : a1, amtCt = cvIs0 ? a1 : a0;
        const inRange = q.tl <= st.tick && st.tick < q.tu;
        const valueCv = usdCt != null && usdCvEq ? amtCv + (amtCt * usdCt) / usdCvEq : null;
        const lo = priceOfTick(q.tl), hi = priceOfTick(q.tu);
        return {
          kind: q.kind, tokenId: q.tokenId || null, owner: q.owner, unresolved: !!q.unresolved,
          tickLower: q.tl, tickUpper: q.tu, fullRange: q.tl <= MIN_TICK + m.spacing && q.tu >= MAX_TICK - m.spacing,
          priceLower: Math.min(lo, hi), priceUpper: Math.max(lo, hi),
          inRange, amountCv: amtCv, amountCounter: amtCt, valueCv, liquidity: String(q.L),
          shareActive: inRange && activeL > 0 ? Number(q.L) / activeL : 0,
        };
      }).filter((q) => q.valueCv == null || q.valueCv >= 1).sort((x, y) => (y.valueCv ?? 0) - (x.valueCv ?? 0));

      const hooks = m.hooks && m.hooks !== ZERO_ADDRESS ? m.hooks : null;
      const dynamicFee = p.version === "v4" && m.fee === DYNAMIC_FEE;
      const feePips = p.version === "v4" ? st.lpFee ?? m.fee : m.fee;
      return {
        ...base, ready: true, block: st.block, fee: feePips, feePct: feePips / 1e4, swapFee: st.fee, tickSpacing: m.spacing,
        hooks, dynamicFee, balancesFromLiquidity: !!st.balancesFromLiquidity,
        cv: { symbol: cv.symbol, address: cvIs0 ? m.token0 : m.token1, decimals: dCv },
        counter: { symbol: ct.symbol, address: cvIs0 ? m.token1 : m.token0, decimals: dCt },
        cvIs0, decimals: [d0, d1],
        price: mid, pegPrice, deviation, deviationBps: deviation == null ? null : deviation * 1e4,
        tvlUsd: poolTvl, composition,
        depth, impact, maxSale: maxIn, ticksComplete: st.complete, approximate: !st.complete || !!hooks || dynamicFee,
        chart: { tick: st.tick, sqrtP, L: activeL, spacing: m.spacing, ticks: ticks.map((x) => [x.tick, x.net]) },
        positions,
      };
    });
    const ref = (key) => { const o = this.oracles[key]; return o ? { value: o.value, label: o.label, address: o.address, updatedAt: o.updatedAt, fallback: o.fallback, reason: o.reason } : null; };
    return {
      pools,
      totals: { tvlUsd: tvl, tvlPartial: !tvlOk, volumeUsd24h: vol, volumePartial: !volOk },
      oracles: Object.fromEntries(Object.keys(C.oracles || {}).map((k) => [k, ref(k)])),
      history: { ...this.history, positions: Object.values(this.lp.pools).length },
      thresholdsBps: C.pegThresholdsBps || [10, 50],
    };
  }
}

const pctTxt = (x) => `${(x * 100).toFixed(2)}%`;

/* ================================================================================================
 * 22c. MODULE: Aggregators (EURCV volume routed through DEX aggregators, Uniswap page)
 * ================================================================================================ */
/**
 * uniswap.aggregators - every transfer of the token on the chain (eth_getLogs), then the receipt of each
 * transaction (JSON-RPC batches), classified by the aggregators taking part in it (config.js -> aggregators):
 *   involved  an aggregator contract is the tx target, emits a log in the tx, or sends / receives any token
 *   entry     the aggregator the tx was sent to; otherwise the involved one of the lowest layer
 *             (1 intents / solvers: UniswapX, CoW - 2 routers: 1inch, Velora, KyberSwap, 0x - 3 RFQ liquidity: Bebop)
 *   sources   the other involved aggregators: liquidity the entry routed the trade to (CoW -> Bebop)
 *   ext       the tx was sent to a contract that is neither an aggregator nor the trader's wallet
 *             (another router, a solver...): "other route"
 * Volume = the trader's EURCV: net EURCV of the taker (UniswapX swapper, ERC-4337 account, tx sender or the
 * wallet it called), for CoW the EURCV legs of its Trade events; with no taker found, the largest net EURCV
 * flow of the tx (side unknown: gasless order, EURCV used as an intermediate hop...).
 * Only trades are kept (hash, block, time, entry, sources, amount, side, counter token, our pools).
 * Venues: each trade's EURCV is split into "RFQ" (exchanged with a market maker: volume no pool counts) and "our
 * pools" (already in the pools' own volume: shown apart, never added), plus other pools if any.
 * History: back to historyDays (default 7, config) one day per step, then new blocks every minute. All of it runs
 * in a background worker (own log contexts) so the per-block pool refresh of the page never waits for it.
 */

const AGG_DAY_BLOCKS = 7200;
const AGG_STEP_BLOCKS = 7200; // one day of blocks per worker step
const AGG_RETRY_MS = 60000;
/** native ETH as CoW writes it (buyToken), and the marker used when the taker got ETH through WETH */
/** executor bucket of legs no tracked aggregator executed */
export const AGG_OTHER = "_other";
export const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** Swap events of other AMMs (Uniswap v2 / v3 pools, Curve): such a counterparty is a pool, not an RFQ maker. */
const AMM_SWAP = new Set([
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822", // Uniswap v2 Swap
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", // Uniswap v3 Swap
  "0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140", // Curve TokenExchange
]);
const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";

/** Run fn over items with at most n in flight. */
async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

const absBig = (v) => (v < 0n ? -v : v);

/**
 * Classification context from the config: aggregators (address sets, layer, order), our pools, wallet infrastructure.
 * @param {any} cfg config.aggregators  @param {any} uni config.uniswap  @param {string} token token address
 * @param {Record<string, string[]>} [found] addresses discovered on-chain per aggregator (0x Settlers)
 */
export function aggContext(cfg, uni, token, found = {}) {
  const lc = (a) => String(a || "").toLowerCase();
  const aggs = (cfg.list || []).map((g, index) => ({
    id: g.id, label: g.label || g.id, layer: g.layer ?? 2, index,
    addrs: new Set([...(g.contracts || []), ...(found[g.id] || [])].map(lc)),
  }));
  const pools = [], v4ids = new Map();
  for (const p of uni?.pools || []) {
    if ((p.version || "v3") === "v4") v4ids.set(lc(p.id), p.slug);
    else pools.push({ slug: p.slug, addr: lc(p.address) });
  }
  return { token: lc(token), aggs, pools, v4ids, poolManager: lc(uni?.v4?.poolManager), walletInfra: new Set((cfg.walletContracts || []).map(lc)) };
}

/**
 * One transaction -> one trade record, or null when no tracked aggregator handled the token in it.
 * An aggregator handled the token when: the tx was sent to it; one of its contracts sends or receives the token;
 * one of its events names the token (Kyber Swapped, CoW Trade...) or is the swapper's (UniswapX Fill); or one of
 * its events comes right after a transfer of the token (RFQ fills: the order's transfers, then the order event),
 * with no other aggregator's log in between. That keeps a CoW batch where Bebop filled another pair out of Bebop.
 * Fallback: the sender (or the wallet it called) traded the token and a router moved only the other token.
 * @param {{hash:string, from:string, to:string|null, block:number, ts:number|null, logs:{address:string, topics:string[], data:string}[]}} rx
 * @param {ReturnType<typeof aggContext>} A
 * @param {number} decimals token decimals
 */
export function classifyTrade(rx, A, decimals) {
  const lc = (x) => String(x || "").toLowerCase();
  const tok = A.token, tokHex = tok.slice(2), tokWord = tokHex.padStart(64, "0");
  const from = lc(rx.from), to = lc(rx.to);
  const L = (rx.logs || []).map((l) => ({ a: lc(l.address), t: (l.topics || []).map(lc), d: lc(l.data || "0x") }));
  /** @type {Map<string, any>} */
  const aggOf = new Map();
  for (const g of A.aggs) for (const x of g.addrs) aggOf.set(x, g);
  /** token net per address; other tokens: address -> token -> net */
  const net = new Map(), flows = new Map(), eParties = new Set(), oParties = new Set();
  const isTok = new Array(L.length).fill(false);
  /** transfers of the token / of other tokens: { i: log index, f: from, r: to } */
  const tTok = [], tOther = [];
  let weth = false;
  L.forEach((l, i) => {
    const t0 = l.t[0] || "";
    if (t0 === TOPIC.WethDeposit || t0 === TOPIC.WethWithdrawal) weth = true;
    if (t0 !== TOPIC.Transfer || l.t.length !== 3) return;
    let v;
    try { v = BigInt(l.d === "0x" ? 0 : "0x" + strip(l.d).slice(0, 64)); } catch { return; }
    const f = topicAddr(l.t[1]), r = topicAddr(l.t[2]);
    (l.a === tok ? tTok : tOther).push({ i, f, r });
    if (l.a === tok) {
      isTok[i] = true;
      eParties.add(f); eParties.add(r);
      if (f !== ZERO_ADDRESS) net.set(f, (net.get(f) || 0n) - v);
      if (r !== ZERO_ADDRESS) net.set(r, (net.get(r) || 0n) + v);
    } else {
      oParties.add(f); oParties.add(r);
      for (const [who, dv] of [[f, -v], [r, v]]) {
        if (who === ZERO_ADDRESS) continue;
        const m = flows.get(who) || new Map();
        m.set(l.a, (m.get(l.a) || 0n) + dv);
        flows.set(who, m);
      }
    }
  });
  if (!isTok.some(Boolean)) return null;

  const linked = new Set();
  for (const g of A.aggs) if (g.addrs.has(to)) linked.add(g);
  for (const p of eParties) { const g = aggOf.get(p); if (g) linked.add(g); }
  // CoW: the token legs of the Trade events give the traders' amounts exactly (batches included)
  let sold = 0n, bought = 0n, cowCounter = null, cowBig = 0n, cowTrades = 0;
  /** CoW order owners (traders) */
  const owners = [];
  /** taker candidates: UniswapX swapper, ERC-4337 account, tx sender, the wallet it called */
  const cand = [];
  L.forEach((l, i) => {
    const t0 = l.t[0] || "";
    if (t0 === TOPIC.UserOp && A.walletInfra.has(l.a) && l.t[2]) cand.push(topicAddr(l.t[2]));
    const g = aggOf.get(l.a);
    if (!g) return;
    if (t0 === TOPIC.UniXFill && l.t[3]) { const s = topicAddr(l.t[3]); cand.push(s); if (net.get(s)) linked.add(g); }
    if (t0 === TOPIC.CowTrade) {
      cowTrades++;
      if (l.t[1]) owners.push(topicAddr(l.t[1]));
      const d = strip(l.d);
      const sell = "0x" + d.slice(24, 64), buy = "0x" + d.slice(88, 128);
      const sa = BigInt("0x" + (d.slice(128, 192) || "0")), ba = BigInt("0x" + (d.slice(192, 256) || "0"));
      if (sell === tok) { sold += sa; if (sa > cowBig) { cowBig = sa; cowCounter = buy; } }
      if (buy === tok) { bought += ba; if (ba > cowBig) { cowBig = ba; cowCounter = sell; } }
    }
    if (l.t.slice(1).some((x) => x.endsWith(tokHex)) || strip(l.d).includes(tokWord)) linked.add(g);
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const pg = aggOf.get(L[j].a);
      if (pg && pg !== g) break;
      if (isTok[j]) { linked.add(g); break; }
    }
  });
  let involved = A.aggs.filter((g) => linked.has(g));
  if (!involved.length && [from, to].some((x) => x && net.get(x))) involved = A.aggs.filter((g) => [...g.addrs].some((x) => oParties.has(x)));
  if (!involved.length) return null;
  const byLayer = (x, y) => x.layer - y.layer || x.index - y.index;
  let entry = involved.find((g) => g.addrs.has(to));
  const direct = !!entry;
  if (!entry) entry = [...involved].sort(byLayer)[0];
  const sources = involved.filter((g) => g !== entry).sort(byLayer).map((g) => g.id);
  const aggAddr = new Set(A.aggs.flatMap((g) => [...g.addrs]));
  cand.push(from);
  if (to && !aggAddr.has(to)) cand.push(to);

  let vol = 0n, side = null, counter = null, taker = null, route = null, mixedSold = 0n;
  if (sold + bought > 0n) {
    vol = sold + bought;
    side = sold && bought ? "mixed" : sold ? "sell" : "buy";
    counter = cowCounter;
    if (side === "mixed") mixedSold = sold;
  } else {
    taker = cand.find((c) => net.get(c)) || null;
    if (taker) {
      const n = net.get(taker);
      vol = absBig(n);
      side = n < 0n ? "sell" : "buy";
      // counter token: what the taker received when selling (paid when buying)
      let best = null, bestN = 0;
      for (const [tk, v] of flows.get(taker) || []) {
        if (v === 0n || (v > 0n) !== (n < 0n)) continue;
        const cnt = L.filter((l) => l.a === tk).length;
        if (cnt > bestN) { best = tk; bestN = cnt; }
      }
      counter = best || (weth ? NATIVE_TOKEN : null);
    } else {
      for (const v of net.values()) if (absBig(v) > vol) vol = absBig(v);
      // the token only passed through: the trader swapped other tokens (CoW orders on other pairs, a wallet
      // swapping USDC for EURC through the EURCV pools...). Otherwise unknown (gasless RFQ order...).
      const trader = cand.find((c) => [...(flows.get(c)?.values() || [])].some((v) => v !== 0n));
      side = cowTrades > 0 || trader ? "route" : null;
      // the pair the trader actually swapped (USDC -> EURC), when the sender's flows show it
      if (trader) {
        const pick = (sign) => {
          let best = null, bestN = 0;
          for (const [tk, v] of flows.get(trader)) {
            if (v === 0n || (v > 0n) !== sign) continue;
            const cnt = L.filter((l) => l.a === tk).length;
            if (cnt > bestN) { best = tk; bestN = cnt; }
          }
          return best;
        };
        const tin = pick(false), tout = pick(true) || (weth ? NATIVE_TOKEN : null);
        if (tin || tout) route = [tin, tout];
      }
      // otherwise (CoW batch, solver...): the hop's two ends - what the venue that gave the token received,
      // and what the venue that took it gave back (pool EURC/EURCV gets EURC, pool EURCV/USDC gives USDC)
      if (!route && side === "route") {
        let neg = null, pos = null;
        for (const [a, v] of net) { if (v < 0n && (!neg || v < net.get(neg))) neg = a; if (v > 0n && (!pos || v > net.get(pos))) pos = a; }
        const top = (who, sign) => {
          let best = null, bestN = 0;
          for (const [tk, v] of flows.get(who) || []) {
            if (v === 0n || (v > 0n) !== sign) continue;
            const cnt = L.filter((l) => l.a === tk).length;
            if (cnt > bestN) { best = tk; bestN = cnt; }
          }
          return best;
        };
        const tin = neg ? top(neg, true) : null, tout = pos ? top(pos, false) : null;
        if (tin || tout) route = [tin, tout];
      }
    }
  }
  if (vol === 0n) return null;

  // "other route": sent to a contract that is not an aggregator, not the trader's wallet, not wallet infrastructure
  // (intents / solvers are always called by their solvers or fillers: never "other route")
  const ext = !direct && entry.layer > 1 && to && to !== from && to !== taker && !net.get(to) && !A.walletInfra.has(to) ? to : null;

  // Where the EURCV was exchanged (one leg per venue, as each venue counts its own volume):
  //   our pools  EURCV in / out of our whitelisted pools - already in the pools' own volume
  //   RFQ        a counterparty that swapped EURCV against another token outside any pool: market makers
  //              (Bebop's, 0x RFQ, solvers' private inventory...) - volume no pool counts
  //   other pools any other AMM (non-whitelisted Uniswap pool, v4 PoolManager, Curve, Balancer)
  // The trader, the aggregators and plain destinations (Morpho Blue receiving a vault deposit: no token back) are no venue.
  // Each leg has one EXECUTOR, the aggregator whose contract made that exchange (never two): pool legs go to the
  // aggregator trading with the pool, RFQ legs to the one that filled the order (CoW -> Bebop: the RFQ leg is Bebop's,
  // the pool leg CoW's). null = no tracked aggregator executed it ("other contracts").
  const cpOf = (list, addr) => list.map((t) => (t.f === addr ? t.r : t.r === addr ? t.f : null)).filter(Boolean);
  const routers = involved.filter((g) => g.layer < 3).sort((x, y) => y.layer - x.layer || x.index - y.index);
  const poolExec = (addr) => {
    for (const cp of [...cpOf(tTok, addr), ...cpOf(tOther, addr)]) { const g = aggOf.get(cp); if (g && g.layer < 3) return g.id; }
    return routers[0]?.id ?? null;
  };
  const rfqExec = (addr) => {
    // the order event right after one of the maker's transfers (Bebop, 1inch limit orders...)
    for (const t of tTok) {
      if (addr && t.f !== addr && t.r !== addr) continue;
      for (let j = t.i + 1; j <= Math.min(L.length - 1, t.i + 4); j++) { const g = aggOf.get(L[j].a); if (g) return g.id; }
    }
    const rfq = involved.find((g) => g.layer === 3);
    if (rfq) return rfq.id;
    for (const cp of addr ? cpOf(tTok, addr) : []) { const g = aggOf.get(cp); if (g) return g.id; }
    return entry.id;
  };

  const pools = {};
  /** legs: [kind "r" RFQ | "p" our pool | "x" other pool, raw amount, executor id | null, pool slug | maker] */
  const legs = [];
  let vp = 0n, vr = 0n, vx = 0n, maker = null, makerV = 0n;
  const poolAddr = new Set(A.pools.map((p) => p.addr));
  for (const p of A.pools) {
    const n = net.get(p.addr);
    if (n) { pools[p.slug] = absBig(n); vp += absBig(n); legs.push(["p", absBig(n), poolExec(p.addr), p.slug]); }
  }
  let v4ours = false;
  if (A.poolManager && A.v4ids.size) {
    for (const l of L) {
      if (l.a !== A.poolManager || l.t[0] !== TOPIC.V4Swap) continue;
      const slug = A.v4ids.get(l.t[1] || "");
      const n = net.get(A.poolManager);
      if (slug && n) { pools[slug] = absBig(n); vp += absBig(n); v4ours = true; legs.push(["p", absBig(n), poolExec(A.poolManager), slug]); break; }
    }
  }
  const notVenue = new Set([ZERO_ADDRESS, from, to, ...cand, ...owners, ...aggAddr, ...A.walletInfra, ...poolAddr]);
  const amm = new Set();
  for (const l of L) if (AMM_SWAP.has(l.t[0] || "")) amm.add(l.a);
  const rfqLegs = [];
  for (const [a, n] of net) {
    if (n === 0n || notVenue.has(a)) continue;
    if ((a === A.poolManager && !v4ours) || a === BALANCER_VAULT || amm.has(a)) { vx += absBig(n); legs.push(["x", absBig(n), poolExec(a), a]); continue; }
    if (a === A.poolManager) continue;
    // a swap counterparty gives another token back (receives EURCV -> sends something, and the reverse)
    const swapped = [...(flows.get(a)?.values() || [])].some((v) => v !== 0n && (v > 0n) === (n < 0n));
    if (!swapped) continue;
    rfqLegs.push(["r", absBig(n), rfqExec(a), a]);
    if (absBig(n) > makerV) { makerV = absBig(n); maker = a; }
  }
  // trader not identified (gasless RFQ order): the trader and the maker both look like counterparties
  if (side == null && rfqLegs.length > 1) for (const g of rfqLegs) g[1] /= 2n;
  // nothing else: EURCV exchanged directly between two parties (limit order, RFQ paid in ETH...)
  if (!vp && !vx && !rfqLegs.length) rfqLegs.push(["r", vol, rfqExec(null), null]);
  for (const g of rfqLegs) { vr += g[1]; legs.push(g); }
  const f = (x) => Number(formatUnits(x, decimals));
  return {
    h: rx.hash, b: rx.block, t: rx.ts, e: entry.id, d: direct ? 1 : 0, s: sources, x: ext,
    v: f(vol), side, ct: counter, rp: route, ...(mixedSold ? { sv: f(mixedSold) } : {}),
    vp: f(vp), vr: f(vr), ...(vx ? { vx: f(vx) } : {}), ...(maker ? { mk: maker } : {}),
    p: Object.fromEntries(Object.entries(pools).map(([k, x]) => [k, f(x)])),
    lg: legs.map(([k, x, ex, ref]) => [k, f(x), ex, ref]),
  };
}

/** Days of history read and kept (config aggregators.historyDays, 1 to 30). */
export function aggDays(cfg) {
  return Math.max(1, Math.min(30, Math.round(cfg?.historyDays || 7)));
}

/** Periods shown: 24h, 7d when the history reaches it, and the whole history when it is another length. */
export function aggPeriods(days) {
  const out = [["24h", 86400]];
  if (days >= 7) out.push(["7d", 7 * 86400]);
  if (days > 1 && days !== 7) out.push([`${days}d`, days * 86400]);
  return out;
}

/** Keys of a trade's breakdown in the card of aggregator `id`: direct, other route, routed to / via another aggregator. */
export function aggSegKey(t, id) {
  if (t.e !== id) return `via:${t.e}`;
  if (t.s.length) return `to:${t.s.join("+")}`;
  return t.x ? "ext" : "direct";
}

export class AggregatorsModule extends Module {
  constructor(app) {
    const cfg = app.config.aggregators;
    super(app, { id: "aggregators", page: "uniswap", chains: [cfg.chain], schedules: [{ id: "uniswap.aggregators", chains: [cfg.chain] }] });
    this.cfg = cfg;
    this.chain = cfg.chain;
    const dep = app.config.tokens[cfg.token].deployments[cfg.chain];
    this.token = dep.address.toLowerCase();
    this.decimals = dep.decimals;
    this.key = `aggregators:v1:${this.chain}`;
    const fresh = () => ({ v: 2, token: this.token, trades: {}, cursor: null, start: null, found: {}, registryAt: 0 });
    /** trades {hash: record}; blocks [start, cursor] are done; found: addresses read from registries (0x Settlers) */
    this.state = storage.get(this.key, null) || fresh();
    // state format 2: trades carry their legs (venue + executor); any other format is read again
    if (this.state.token !== this.token || this.state.v !== 2) this.state = { ...fresh(), found: this.state.found || {}, v: 2 };
    /** token address -> symbol (counter tokens) */
    this.symbols = storage.get(`aggregators:symbols:${this.chain}`, null) || {};
    this.symbols[NATIVE_TOKEN] = "ETH";
    for (const [sym, t] of Object.entries(app.config.tokens)) { const a = t.deployments?.[this.chain]?.address; if (a) this.symbols[a.toLowerCase()] = sym; }
    this.unknown = new Set(Object.values(this.state.trades).flatMap((t) => [t.ct, ...(t.rp || [])]).filter((a) => a && !this.symbols[a]));
    this.head = null;
    this.chainHead = null;
    this.worker = null;
    this.retryAt = 0;
    this.history = { status: Object.keys(this.state.trades).length || this.state.cursor ? "ok" : "pending", error: null, loading: false };
  }

  context() {
    return aggContext(this.cfg, this.app.config.uniswap, this.token, this.state.found);
  }

  save() {
    storage.set(this.key, this.state);
  }

  async run(chain, ctx) {
    this.head = ctx.logHead;
    this.chainHead = ctx.head;
    try { await this.refreshRegistry(ctx); this.clearWarn("registry"); } catch (e) {
      this.warn("registry", `0x Settler registry could not be read (${String(e?.message || e).slice(0, 160)}): trades through a Settler not seen yet may be missed.`);
    }
    try { await this.resolveSymbols(ctx); } catch { /* symbols are cosmetic: retried next minute */ }
    this.sourceOk(chain, ctx.info());
    if (Date.now() >= this.retryAt) this.startWorker();
    this.publish(this.build());
  }

  /** Addresses published by on-chain registries (0x Deployer: ownerOf / prev per feature), every cacheTtl. */
  async refreshRegistry(ctx) {
    const ttl = (this.app.config.frequency.cacheTtl?.["aggregators.registry"] ?? 21600) * 1000;
    if (Date.now() - (this.state.registryAt || 0) < ttl) return;
    const calls = [], who = [];
    for (const g of this.cfg.list) {
      const r = g.registry;
      if (!r?.address) continue;
      for (const f of r.features || []) { calls.push(call(r.address, "ownerOf", enc.uint(f)), call(r.address, "prev", enc.uint(f))); who.push(g.id, g.id); }
    }
    if (calls.length) {
      const res = await ctx.call(calls, this.id);
      if (res.every((r) => !r?.success)) throw new Error("every registry call failed");
      res.forEach((r, i) => {
        const a = dec.addr(r);
        if (!a || a === ZERO_ADDRESS) return;
        const L = (this.state.found[who[i]] ||= []);
        if (!L.includes(a)) L.push(a);
      });
    }
    this.state.registryAt = Date.now();
    this.save();
  }

  /** symbol() of counter tokens seen in trades (one multicall, at most 40 a minute). */
  async resolveSymbols(ctx) {
    const todo = [...this.unknown].filter((a) => !this.symbols[a] && a !== NATIVE_TOKEN).slice(0, 40);
    if (!todo.length) return;
    const res = await ctx.call(todo.map((a) => call(a, "symbol")), this.id);
    todo.forEach((a, i) => { this.symbols[a] = dec.string(res[i]) || shortHex(a); this.unknown.delete(a); });
    storage.set(`aggregators:symbols:${this.chain}`, this.symbols);
  }

  /** Only the leader tab of this page reads; the worker stops as soon as the page or the role changes. */
  active() {
    return this.app.scheduler?.running && this.app.scheduler.page === this.page && this.app.tabs.isLeader();
  }

  startWorker() {
    if (this.worker || this.head == null) return;
    this.worker = this.work()
      .catch((e) => {
        this.history = { ...this.history, status: "error", error: String(e?.message || e).slice(0, 200), loading: false };
        this.retryAt = Date.now() + AGG_RETRY_MS;
        this.warn("history", `Aggregator trades: ${this.history.error}. Retried in 1 min.`);
        this.publish(this.build());
      })
      .finally(() => { this.worker = null; });
  }

  async work() {
    const S = this.state;
    const adapter = this.app.adapters[this.chain];
    const C = this.cfg;
    for (let guard = 0; guard < 5000; guard++) {
      if (!this.active()) break;
      const head = this.head;
      const target = head - aggDays(C) * AGG_DAY_BLOCKS;
      // first visit, or away longer than the history: start again from the head
      if (S.cursor == null || S.cursor < target) { S.trades = {}; S.cursor = head; S.start = head + 1; }
      let from, to, fwd;
      if (S.cursor < head) { fwd = true; from = S.cursor + 1; to = Math.min(head, S.cursor + AGG_STEP_BLOCKS); }
      else if (S.start > target) { fwd = false; to = S.start - 1; from = Math.max(target, S.start - AGG_STEP_BLOCKS); }
      else break;
      this.history = { ...this.history, loading: !fwd || to - from > 50 };
      if (guard === 0) this.publish(this.build());
      try { await this.step(adapter, from, to); } catch { await sleep(5000); if (!this.active()) break; await this.step(adapter, from, to); }
      if (fwd) S.cursor = to; else S.start = from;
      // names of the new counter tokens right away (otherwise at the next minute's run)
      if (this.unknown.size) { try { await this.resolveSymbols(new TickContext(adapter, this.chainHead ?? this.head)); } catch { /* retried next minute */ } }
      for (const [h, t] of Object.entries(S.trades)) if (t.b < target - AGG_DAY_BLOCKS) delete S.trades[h];
      this.save();
      this.history = { status: "ok", error: null, loading: true, at: Date.now() };
      this.clearWarn("history");
      this.publish(this.build());
      // beyond the first days, leave room to the page's own reads
      if (!fwd && S.start <= head - Math.min(7, aggDays(C)) * AGG_DAY_BLOCKS) await sleep(C.backfillPauseMs ?? 2000);
    }
    this.history = { ...this.history, loading: false };
    this.publish(this.build());
  }

  /** One block range: token transfers, then the receipt of every new transaction, then classification. */
  async step(adapter, from, to) {
    const logs = await this.logsSplit(adapter, from, to, 0);
    /** @type {Map<string, {block:number, ts:number|null}>} */
    const txs = new Map();
    for (const l of logs) {
      const h = String(l.transactionHash).toLowerCase();
      if (!txs.has(h)) txs.set(h, { block: Number(BigInt(l.blockNumber)), ts: l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : null });
    }
    const todo = [...txs.keys()].filter((h) => !this.state.trades[h]);
    const rx = await this.receipts(todo);
    const A = this.context();
    for (const h of todo) {
      const r = rx.get(h), m = txs.get(h);
      const t = classifyTrade({ hash: h, from: r.from, to: r.to, block: m.block, ts: m.ts, logs: r.logs }, A, this.decimals);
      if (!t) continue;
      if (t.t == null) t.t = await adapter.blockTime(t.b, this.id);
      this.state.trades[h] = t;
      for (const a of [t.ct, ...(t.rp || [])]) if (a && !this.symbols[a]) this.unknown.add(a);
    }
  }

  /**
   * Token transfers over [from, to]. Endpoints answer "range too large" with limits that vary from node to node
   * (Pocket: 10,000 or 1,000 blocks): a failed range is cut in two and retried, down to ~900 blocks.
   */
  async logsSplit(adapter, from, to, depth) {
    const ctx = new TickContext(adapter, this.chainHead ?? this.head);
    try {
      return await ctx.logs({ address: [this.token], topics: [TOPIC.Transfer] }, from, to, "uniswap.aggregators");
    } catch (e) {
      if (to - from < 1800 || depth >= 4) throw e;
      const mid = Math.floor((from + to) / 2);
      const a = await this.logsSplit(adapter, from, mid, depth + 1);
      const b = await this.logsSplit(adapter, mid + 1, to, depth + 1);
      return a.concat(b);
    }
  }

  /** Receipts by JSON-RPC batch (size from the endpoints' maxBatch), 2 batches in flight, missing ones retried. */
  async receipts(hashes) {
    const pool = this.app.adapters[this.chain].pool;
    const filter = (ep) => ep.capabilities.has("calls");
    const out = new Map();
    let todo = hashes, lastErr = null;
    for (let round = 0; round < 5 && todo.length; round++) {
      const size = Math.max(1, Math.min(this.cfg.receiptBatch || 20, pool.maxOf("maxBatch", filter)));
      const groups = [];
      for (let i = 0; i < todo.length; i += size) groups.push(todo.slice(i, i + size));
      await mapLimit(groups, 2, async (g) => {
        try {
          const res = g.length > 1
            ? await pool.jsonRpcBatch("eth_getTransactionReceipt", g.map((h) => [h]), { module: "uniswap.aggregators", filter, label: "eth_getTransactionReceipt (batch)", timeoutMs: 20000 })
            : [await pool.jsonRpc("eth_getTransactionReceipt", [g[0]], { module: "uniswap.aggregators", filter })];
          g.forEach((h, i) => {
            const r = res[i];
            if (r && Array.isArray(r.logs)) out.set(h, { from: String(r.from || "").toLowerCase(), to: String(r.to || "").toLowerCase(), logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) });
          });
        } catch (e) { lastErr = e; }
      });
      todo = todo.filter((h) => !out.has(h));
      if (todo.length) await sleep(1000 * (round + 1));
    }
    if (todo.length) throw new Error(`${todo.length} receipt(s) could not be read${lastErr ? ` (${String(lastErr.message || lastErr).slice(0, 120)})` : ""}`);
    return out;
  }

  /* ---------------- output ---------------- */

  build() {
    const C = this.cfg, S = this.state;
    const now = Date.now() / 1000;
    const days = aggDays(C);
    const ids = C.list.map((g) => g.id);
    const keys = [...ids, AGG_OTHER];
    const trades = Object.values(S.trades).filter((t) => Array.isArray(t.lg)).sort((x, y) => y.b - x.b || (x.h < y.h ? -1 : 1));
    const sym = (a) => (a ? this.symbols[a] || shortHex(a) : null);
    // blocks done -> seconds of history (12 s a block)
    const covered = S.cursor != null && S.start != null ? Math.min(days * 86400, Math.max(0, S.cursor - S.start + 1) * 12) : 0;
    const FAM = { r: "rfq", p: "pools", x: "other" };
    const v3 = () => ({ rfq: 0, pools: 0, other: 0 });
    /** sells / buys / pivot / unknown shares of a trade (CoW batch with both: its two legs) */
    const sides = (t) => t.side === "mixed" ? { sell: (t.sv || 0) / (t.v || 1), buy: 1 - (t.sv || 0) / (t.v || 1) }
      : { [t.side === "buy" || t.side === "sell" ? t.side : t.side === "route" ? "pivot" : "unk"]: 1 };
    const blank = () => ({ n: 0, ...v3(), pivotPools: 0, sides: { sell: 0, buy: 0, pivot: 0, unk: 0 }, origin: {}, delegated: {}, counters: {} });
    const execOf = (ex) => (ex && ids.includes(ex) ? ex : AGG_OTHER);
    const periods = {};
    const problems = [];
    for (const [key, sec] of aggPeriods(days)) {
      // every leg counted once, under its executor; origin (who brought it) and delegation are views of the same legs
      const tot = { ...blank(), byExec: {}, poolsBy: {}, makers: {} };
      const aggs = Object.fromEntries(keys.map((id) => [id, blank()]));
      for (const t of trades) {
        if (t.t < now - sec) continue;
        tot.n++;
        const sd = sides(t), cs = sym(t.ct), seen = new Set();
        for (const [k, v, ex, ref] of t.lg) {
          const id = execOf(ex), fam = FAM[k], a = aggs[id];
          const ok = t.e === id ? (t.x ? "ext" : "direct") : `via:${t.e}`;
          for (const o of [tot, a]) {
            o[fam] += v;
            for (const [sk, x] of Object.entries(sd)) o.sides[sk] += v * x;
            if (k === "p" && t.side === "route") o.pivotPools += v;
            if (cs) o.counters[cs] = (o.counters[cs] || 0) + v;
          }
          (tot.byExec[id] ||= { ...v3(), n: 0 })[fam] += v;
          const og = (a.origin[ok] ||= { ...v3(), n: 0 });
          og[fam] += v;
          if (!seen.has(id)) { seen.add(id); og.n++; tot.byExec[id].n++; a.n++; }
          if (t.e !== id && aggs[t.e]) (aggs[t.e].delegated[id] ||= v3())[fam] += v;
          if (k === "p" && ref) tot.poolsBy[ref] = (tot.poolsBy[ref] || 0) + v;
          if (k === "r" && ref) tot.makers[ref] = (tot.makers[ref] || 0) + v;
        }
      }
      // the cards partition the total: checked on every build
      for (const fam of ["rfq", "pools", "other"]) {
        const sum = keys.reduce((x, id) => x + aggs[id][fam], 0);
        if (Math.abs(sum - tot[fam]) > 1) problems.push(`${key} ${fam}: cards ${Math.round(sum)} vs total ${Math.round(tot[fam])}`);
      }
      periods[key] = { sec, complete: covered >= sec - 1800, total: tot, aggs };
    }
    if (problems.length) this.warn("check", `Aggregator figures do not add up (${problems.join("; ")}). Please report it.`); else this.clearWarn("check");
    // daily volume (UTC days): each leg once, grouped by executor or by entry aggregator, RFQ and pools apart
    const day0 = Math.floor(now / 86400) - (days - 1);
    const grid = () => ({ rfq: Object.fromEntries(keys.map((id) => [id, new Array(days).fill(0)])), pools: Object.fromEntries(keys.map((id) => [id, new Array(days).fill(0)])) });
    const exec = grid(), entry = grid();
    for (const t of trades) {
      const i = Math.floor(t.t / 86400) - day0;
      if (i < 0 || i >= days) continue;
      for (const [k, v, ex] of t.lg) {
        if (k === "x") continue;
        exec[FAM[k]][execOf(ex)][i] += v;
        entry[FAM[k]][ids.includes(t.e) ? t.e : AGG_OTHER][i] += v;
      }
    }
    // latest trades: the newest overall, plus the newest of each aggregator (entry, route or executor)
    const n = C.tradesShown || 50;
    const touches = (t, id) => t.e === id || t.s.includes(id) || t.lg.some((l) => l[2] === id);
    const keep = new Set(trades.slice(0, n).map((t) => t.h));
    for (const id of ids) trades.filter((t) => touches(t, id)).slice(0, n).forEach((t) => keep.add(t.h));
    const recent = trades.filter((t) => keep.has(t.h)).map((t) => ({ ...t, cts: sym(t.ct), rps: t.rp ? t.rp.map(sym) : null }));
    return {
      token: C.token,
      periods,
      check: !problems.length,
      daily: { day0: day0 * 86400, days, exec, entry },
      trades: recent,
      history: {
        ...this.history, coveredSec: covered, targetDays: days,
        cursor: S.cursor, start: S.start, trades: trades.length,
        settlers: Object.values(S.found).reduce((x, L) => x + L.length, 0),
      },
    };
  }
}

/* ================================================================================================
 * 22b. DATA: Coinwatch (market makers / exchanges, API with a personal key)
 * ================================================================================================ */
/**
 * Coinwatch is not polled by the scheduler: the Coinwatch page asks this service for exactly the charts
 * it shows (cw.get), and nothing is requested for what is not on screen.
 *   - Cache: every answer is kept in the browser (localStorage) and shown at once on the next visit;
 *     it is re-fetched when older than coinwatch.cacheTtlSec (6 h). The page refresh button forces it.
 *   - Rate: one RpcPool endpoint at coinwatch.maxRps (the key allows 120 requests/min); RateLimit-*
 *     headers are honoured (the pool pauses before the quota runs out).
 *   - Key: config.js coinwatch.apiKey, else the key a user typed on the page (kept in this browser only,
 *     localStorage "cv-coinwatch-key", not removed by "Clear local cache").
 *   - Company / dashboard: tried in order (coinwatch.tokens.<sym>, then coinwatch.fallbacks) with a cheap
 *     chart; the first that answers is remembered (localStorage), so the slug question settles itself.
 * Answers are normalised to { category, datasets: [{ label, points: [[ms, value], ...] }] }.
 */
const CW_KEY_STORE = "cv-coinwatch-key";

export class CoinwatchService extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.cfg = app.config.coinwatch || {};
    this.pool = new RpcPool("coinwatch", [{ id: "coinwatch", url: this.cfg.url || "https://coinwatch.co/api/v1", maxRps: this.cfg.maxRps || 1.8 }], { timeoutMs: 20000, stats: app.stats });
    app.apiPools.coinwatch = this.pool;
    /** request key -> { at, data } (memory copy of the localStorage cache) */
    this.mem = {};
    /** request key -> Promise */
    this.pending = new Map();
    /** request key -> { at, error, kind } */
    this.errors = {};
    /** token -> { company, dashboard } once found */
    this.targets = storage.get("coinwatch:targets:v1", null) || {};
    this._resolving = {};
    this.forceBefore = 0;
    this.authError = null;
  }

  ttl() { return (this.cfg.cacheTtlSec || 21600) * 1000; }

  /* ---------------- key ---------------- */

  configKey() { const k = String(this.cfg.apiKey || "").trim(); return /^cw_/.test(k) ? k : ""; }
  userKey() { try { return localStorage.getItem(CW_KEY_STORE) || ""; } catch { return ""; } }
  key() { return this.configKey() || this.userKey() || this._memKey || ""; }
  hasKey() { return !!this.key(); }
  setKey(k) {
    try { localStorage.setItem(CW_KEY_STORE, String(k).trim()); } catch { /* storage blocked: kept for this visit only */ this._memKey = String(k).trim(); }
    this.authError = null; this.errors = {}; this.emit("change");
  }
  forgetKey() { try { localStorage.removeItem(CW_KEY_STORE); } catch { /* ignore */ } this._memKey = ""; this.emit("change"); }

  /* ---------------- requests ---------------- */

  /** Refresh button: everything shown is fetched again. */
  refresh() { this.forceBefore = Date.now(); this.errors = {}; this.emit("change"); }

  candidates(token) {
    const t = this.cfg.tokens?.[token] || {};
    const sub = (x) => (x == null ? null : String(x).replace("{token}", token.toLowerCase()));
    const list = [{ company: sub(t.company), dashboard: sub(t.dashboard) }, ...(this.cfg.fallbacks || []).map((f) => ({ company: sub(f.company), dashboard: sub(f.dashboard) }))];
    return list.filter((c, i) => c.company && list.findIndex((d) => d.company === c.company && d.dashboard === c.dashboard) === i);
  }

  async fetchJson(path, label) {
    const k = this.key();
    if (!k) throw new RpcError("no API key", { kind: "auth" });
    return this.pool.getJson(path, { headers: { Authorization: `Bearer ${k}` }, module: "coinwatch", label, finalKinds: ["auth", "notfound", "bad"] });
  }

  /** Company / dashboard of a token: first candidate that answers a cheap chart. */
  resolve(token) {
    const cands = this.candidates(token);
    const known = this.targets[token];
    // a remembered slug only counts while it is still one of the configured candidates
    if (known && cands.some((c) => c.company === known.company && c.dashboard === known.dashboard)) return Promise.resolve(known);
    // a single candidate: nothing to choose, no check request
    if (cands.length === 1) { this.targets[token] = cands[0]; storage.set("coinwatch:targets:v1", this.targets); return Promise.resolve(cands[0]); }
    if (this._resolving[token]) return this._resolving[token];
    this._resolving[token] = (async () => {
      const tried = [];
      for (const c of this.candidates(token)) {
        try {
          await this.fetchJson(this.chartPath(c, "total-volume", { chart_duration: "24h" }), "GET charts (slug check)");
          this.targets[token] = c;
          storage.set("coinwatch:targets:v1", this.targets);
          return c;
        } catch (e) {
          if (e.code === 401) throw e; // key refused: no point trying other slugs
          tried.push(`${c.company}${c.dashboard ? ` / ${c.dashboard}` : ""} (${e.code || e.kind})`);
        }
      }
      throw new RpcError(`no Coinwatch company/dashboard answered for ${token}: tried ${tried.join(", ")}`, { kind: "notfound" });
    })().finally(() => { delete this._resolving[token]; });
    return this._resolving[token];
  }

  chartPath(target, category, params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== "") q.set(k, String(v));
    if (target.dashboard) q.set("dashboard_slug", target.dashboard);
    return `/companies/${encodeURIComponent(target.company)}/charts/${encodeURIComponent(category)}?${q}`;
  }

  /**
   * Cached chart (stale allowed) and a background fetch when missing / older than the TTL.
   * spec: { token, category, params } or { ref: "exchanges" | "market_makers" }
   * @returns {{ data: any, at: number|null, error: string|null, loading: boolean }}
   */
  get(spec) {
    const id = spec.ref ? `ref:${spec.ref}` : `${spec.token}:${spec.category}:${Object.entries(spec.params || {}).sort().map(([k, v]) => `${k}=${v}`).join("&")}`;
    let c = this.mem[id];
    if (!c) { c = storage.get(`coinwatch:${id}`, null); if (c) this.mem[id] = c; }
    const err = this.errors[id];
    const stale = !c || Date.now() - c.at >= this.ttl() || c.at < this.forceBefore;
    const retryOk = !err || Date.now() - err.at > (err.kind === "rate" ? 30000 : err.kind === "notfound" || err.kind === "bad" ? this.ttl() : 120000);
    if (stale && this.hasKey() && !this.pending.has(id) && retryOk && !(this.authError && Date.now() - this.authError.at < 3600000)) this.load(id, spec);
    return { data: c?.data ?? null, at: c?.at ?? null, error: err?.error || null, kind: err?.kind || null, loading: this.pending.has(id) || (stale && this.hasKey() && !err) };
  }

  load(id, spec) {
    const p = (async () => {
      try {
        let raw;
        if (spec.ref) raw = await this.fetchJson(`/${spec.ref}`, `GET ${spec.ref}`);
        else {
          const target = await this.resolve(spec.token);
          raw = await this.fetchJson(this.chartPath(target, spec.category, spec.params), `GET charts/${spec.category}`);
        }
        const data = spec.ref ? raw : cwNormalise(raw);
        const entry = { at: Date.now(), data };
        this.mem[id] = entry;
        storage.set(`coinwatch:${id}`, entry);
        delete this.errors[id];
        this.authError = null;
      } catch (e) {
        const msg = String(e?.message || e);
        this.errors[id] = { at: Date.now(), error: msg, kind: e?.kind || "http" };
        if (e?.code === 401) this.authError = { at: Date.now(), error: msg };
        console.warn("[coinwatch]", id, msg);
      } finally {
        this.pending.delete(id);
        this.emit("change");
      }
    })();
    this.pending.set(id, p);
  }

  /** Every cached answer (Diagnostics: shapes, to check the parsing against the real API). */
  inventory() {
    return Object.entries(this.mem).map(([id, c]) => ({ id, at: c.at, datasets: c.data?.datasets?.map((d) => ({ label: d.label, n: d.points.length, step: cwStepSec(d.points), min: Math.min(...d.points.map((p) => p[1])), max: Math.max(...d.points.map((p) => p[1])) })) || null }));
  }
}

/** API answer -> { category, datasets: [{ label, points: [[ms, value]] }] } (points sorted, invalid ones dropped). */
export function cwNormalise(raw) {
  const datasets = (raw?.datasets || []).map((d) => ({
    label: String(d?.label ?? ""),
    points: (d?.data || []).map((p) => [Date.parse(p.timestamp), Number(p.value)]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)).sort((a, b) => a[0] - b[0]),
  })).filter((d) => d.label);
  return { category: raw?.category || null, datasets };
}

/** Median step between points, in seconds. */
export function cwStepSec(pts) {
  if (pts.length < 2) return null;
  const d = [];
  for (let i = 1; i < pts.length; i++) d.push(pts[i][0] - pts[i - 1][0]);
  d.sort((a, b) => a - b);
  return Math.round(d[d.length >> 1] / 1000);
}

/** Points of the last 24 h of a series (relative to its last point). */
function cwLast24(pts) {
  if (!pts.length) return [];
  const end = pts[pts.length - 1][0];
  return pts.filter(([t]) => t > end - 86400000 + 1);
}

/**
 * 24 h volume of a series: sum of the buckets of the last 24 h when they are intraday (hourly...),
 * the last point when the series is daily. coinwatch.volume24h = "last" forces the latter.
 */
export function cwVolume24h(pts, mode) {
  if (!pts?.length) return null;
  const step = cwStepSec(pts);
  if (mode === "last" || step == null || step >= 20 * 3600) return pts[pts.length - 1][1];
  return cwLast24(pts).reduce((s, [, v]) => s + v, 0);
}

/** Mean of the last 24 h (spreads, depth). */
export function cwAvg24h(pts) {
  const w = cwLast24(pts || []);
  return w.length ? w.reduce((s, [, v]) => s + v, 0) / w.length : null;
}

/** Spread value -> bps, per coinwatch.spreadUnit ("ratio" 0.0005 = 5 bps, "percent", "bps"). */
export function cwBps(v, unit) {
  if (v == null || !Number.isFinite(v)) return null;
  return unit === "bps" ? v : unit === "percent" ? v * 100 : v * 1e4;
}

/** Sum of several series, point by point (same timestamps). */
export function cwSumSeries(datasets) {
  const m = new Map();
  for (const d of datasets) for (const [t, v] of d.points) m.set(t, (m.get(t) || 0) + v);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

/** Name matching between dataset labels and reference lists (case, spaces, punctuation ignored). */
export const cwNorm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

/* ================================================================================================
 * 23. UI: formatting, icons, logos, tooltip
 * ================================================================================================ */

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DASH = "\u2014";
/** A Vault V2 maxRate above this APY is "no cap" in practice: not shown in the APY hover. */
const CAP_MEANINGFUL = 0.15;
const DOT = " \u00b7 ";
const nf = (max, min = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: max, minimumFractionDigits: min });

/** Decimal string -> "1,234,567.89" */
export function amount(str, max = 2, min = 0) {
  if (str == null || str === "") return DASH;
  const n = Number(str);
  return Number.isFinite(n) ? nf(max, min).format(n) : esc(str);
}
/** Compact: 1.23M */
export function compact(str) {
  if (str == null) return DASH;
  const n = Number(str);
  return Number.isFinite(n) ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(n) : DASH;
}
export const usd = (n) => (n == null || !Number.isFinite(n) ? DASH : "$" + nf(0).format(n));
export const pct = (x, dp = 2) => (x == null || !Number.isFinite(x) ? DASH : nf(dp, dp).format(x * 100) + "%");
export const num = (n) => (n == null ? DASH : nf(0).format(n));
/** Price with fixed decimals (pool prices are close to 1). */
export const fmtP = (x, dp = 5) => (x == null || !Number.isFinite(x) ? DASH : nf(dp, dp).format(x));
/** Compact USD: $5.63M */
export const usdC = (n) => (n == null || !Number.isFinite(n) ? DASH : "$" + compact(n));
/** Compact without forced decimals: 100K, 1M */
export const compactInt = (n) => (n == null ? DASH : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n));
/** Short compact: 4.2M, 170K, 898 (one decimal at most) */
export const compact1 = (n) => (n == null || !Number.isFinite(n) ? DASH : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: n >= 1e6 ? 1 : 0 }).format(n));
/** Relative change as bps below 1%, as % above. */
export function bpsTxt(x) {
  if (x == null || !Number.isFinite(x)) return DASH;
  const sign = x > 0 ? "+" : x < 0 ? "\u2212" : "";
  const a = Math.abs(x);
  return a < 0.01 ? `${sign}${nf(2, 2).format(a * 1e4)} bps` : `${sign}${nf(2, 2).format(a * 100)}%`;
}
export function age(ms) {
  if (ms == null) return DASH;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function dateTime(tsSec) {
  if (!tsSec) return DASH;
  return new Date(tsSec * 1000).toLocaleString("en-GB", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
export function duration(sec) {
  if (sec == null) return DASH;
  if (!Number.isFinite(sec)) return "\u221e";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h ${Math.floor((sec % 3600) / 60)}m`;
}
const tipAttr = (text) => (text ? ` data-tip="${esc(text)}"` : "");

/** Lucide icons (ISC licence), 16 px, stroke 2. */
const LUCIDE = {
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  sliders: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  zoomIn: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  layout: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  grip: '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  fold: '<path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/>',
};
const icon = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${LUCIDE[name]}</svg>`;

/**
 * Logo slot: <img> fitted in a fixed box (any size or ratio). A missing file falls back to a
 * monogram; failed URLs are remembered so re-renders do not request them again.
 */
const BAD_LOGOS = new Set();
/** configured path -> file that actually loaded (after trying the other extensions) */
const GOOD_LOGOS = new Map();
const LOGO_EXT = [".svg", ".png", ".webp", ".jpg", ".jpeg"];
/**
 * Files to try for a configured logo: the path as written, then the same name with the other usual
 * extensions (logos/flowdesk.png also finds logos/flowdesk.svg; "logos/flowdesk" works too). Local files only.
 */
export function logoCandidates(src) {
  if (!src || /^(https?:|data:)/i.test(src)) return src ? [src] : [];
  const m = /^(.*?)(\.(svg|png|webp|jpe?g|gif))?$/i.exec(src);
  const base = m[1];
  return [...new Set([...(m[2] ? [src] : []), ...LOGO_EXT.map((e) => base + e)])];
}
if (typeof window !== "undefined") {
  // @ts-ignore
  window.cvLogoFail = (img) => {
    BAD_LOGOS.add(img.getAttribute("src"));
    const alts = (img.dataset.alts || "").split("|").filter(Boolean);
    if (alts.length) { img.dataset.alts = alts.slice(1).join("|"); img.setAttribute("src", alts[0]); return; }
    const p = img.parentNode; p.classList.remove("ok"); p.textContent = p.dataset.m;
  };
  // @ts-ignore
  window.cvLogoOk = (img) => { if (img.dataset.key) GOOD_LOGOS.set(img.dataset.key, img.getAttribute("src")); };
}
function logo(src, text, cls = "") {
  const m = esc(String(text || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase());
  const good = src ? GOOD_LOGOS.get(src) : null;
  const list = good ? [good] : logoCandidates(src).filter((u) => !BAD_LOGOS.has(u));
  if (!list.length) return `<span class="logo ${cls}" data-m="${m}">${m}</span>`;
  return `<span class="logo ok ${cls}" data-m="${m}"><img src="${esc(list[0])}" alt="" data-key="${esc(src)}" data-alts="${esc(list.slice(1).join("|"))}" onload="cvLogoOk(this)" onerror="cvLogoFail(this)"></span>`;
}

/* ---------------- name matching (Coinwatch labels, logos, the market list of config.js) ---------------- */

/** Words of a name, lower case, accents and punctuation removed. */
export function nameWords(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}
/** Assets of a trading pair label: "EURCV/USDT", "EURCV-USDT", "eurcv_usdt" -> ["EURCV", "USDT"]. */
export function pairParts(label) {
  return String(label || "").split(/[\/\-_:\s]+/).filter(Boolean).map((x) => x.toUpperCase());
}
/** Our tokens found in a pair label, in the order of `syms` ("EURCV/USDCV" -> both). */
export function pairTokens(label, syms) {
  const w = nameWords(label);
  return syms.filter((t) => w.includes(String(t).toLowerCase()));
}
/** Visibility of the Coinwatch "Trading pairs" tab: "public" | "private" (default) | "hidden". */
export function pairsTabMode(cfg) {
  const v = String(cfg?.pairsTab || "private").toLowerCase();
  return v === "public" || v === "hidden" ? v : "private";
}
/**
 * Position (in words) where `key` appears in `label` as whole words, spaces and punctuation ignored;
 * -1 if absent. "Uniswap v3 - Ethereum" contains "Uniswap" at 0 and "Ethereum" at 2; "Flow Traders" contains "FlowTraders".
 */
export function namePos(label, key) {
  const w = nameWords(label), k = nameWords(key).join("");
  if (!k) return -1;
  for (let i = 0; i < w.length; i++) {
    let acc = "";
    for (let j = i; j < w.length && acc.length < k.length; j++) { acc += w[j]; if (acc === k) return i; }
  }
  return -1;
}
/** Same name, whatever the case, spaces and punctuation, or one contained in the other as whole words. */
export function sameName(a, b) {
  const x = nameWords(a).join(""), y = nameWords(b).join("");
  return !!x && (x === y || namePos(a, b) >= 0 || namePos(b, a) >= 0);
}
/** Best key for a label: the earliest one in the label, then the longest. null if none. */
export function bestName(label, keys) {
  let best = null;
  for (const k of keys) {
    const p = namePos(label, k);
    if (p < 0) continue;
    const len = nameWords(k).join("").length;
    if (!best || p < best.p || (p === best.p && len > best.len)) best = { k, p, len };
  }
  return best ? best.k : null;
}

/** One tooltip element for the whole page (fixed position, so tables and cards never clip it). */
class Tooltip {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "tooltip";
    document.body.appendChild(this.el);
    this.target = null;
    this.x = -1; this.y = -1;
    document.addEventListener("mousemove", (e) => { this.x = e.clientX; this.y = e.clientY; }, { passive: true });
    document.addEventListener("mouseover", (e) => this.show(/** @type {HTMLElement} */ (e.target)?.closest?.("[data-tip]")));
    document.addEventListener("focusin", (e) => this.show(/** @type {HTMLElement} */ (e.target)?.closest?.("[data-tip]")));
    document.addEventListener("scroll", () => this.hide(), true);
  }
  show(t) {
    if (!t && this.manual) return;
    if (!t) return this.hide();
    this.manual = false;
    this.target = t;
    this.el.textContent = t.getAttribute("data-tip");
    this.el.classList.add("on");
    const r = t.getBoundingClientRect();
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    let top = r.top - h - 8;
    if (top < 8) top = r.bottom + 8;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
  hide() { this.target = null; this.manual = false; this.el.classList.remove("on"); }
  /** Tooltip at a point (charts drive it themselves). */
  showAt(x, y, text) {
    this.manual = true;
    this.target = null;
    this.el.textContent = text;
    this.el.classList.add("on");
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    const left = Math.min(Math.max(8, x - w / 2), innerWidth - w - 8);
    let top = y - h - 12;
    if (top < 8) top = y + 12;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
  /** After a re-render the hovered node is new: re-attach to whatever is under the pointer. */
  refresh() {
    if (this.manual || !this.target) return;
    const t = this.x >= 0 ? document.elementFromPoint(this.x, this.y)?.closest?.("[data-tip]") : null;
    if (t) this.show(t); else this.hide();
  }
}

/** Evenly spaced samples in time (nearest real point), first and last kept. */
export function samplePoints(pts, n) {
  if (pts.length <= n) return pts;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + ((t1 - t0) * k) / (n - 1);
    while (j < pts.length - 1 && Math.abs(pts[j + 1][0] - t) <= Math.abs(pts[j][0] - t)) j++;
    if (!out.length || out[out.length - 1] !== pts[j]) out.push(pts[j]);
  }
  return out;
}

/** Smooth SVG path through points (monotone cubic, Fritsch-Carlson: no overshoot). */
export function monotonePath(p) {
  const n = p.length;
  if (n < 3) return p.map(([x, y], k) => `${k ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const dx = [], sl = [], m = [];
  for (let k = 0; k < n - 1; k++) { dx[k] = p[k + 1][0] - p[k][0] || 1e-9; sl[k] = (p[k + 1][1] - p[k][1]) / dx[k]; }
  m[0] = sl[0]; m[n - 1] = sl[n - 2];
  for (let k = 1; k < n - 1; k++) m[k] = sl[k - 1] * sl[k] <= 0 ? 0 : (sl[k - 1] + sl[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (sl[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
    const a = m[k] / sl[k], b = m[k + 1] / sl[k], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[k] = t * a * sl[k]; m[k + 1] = t * b * sl[k]; }
  }
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let k = 0; k < n - 1; k++) {
    const h = dx[k] / 3;
    d += `C${(p[k][0] + h).toFixed(1)},${(p[k][1] + m[k] * h).toFixed(1)} ${(p[k + 1][0] - h).toFixed(1)},${(p[k + 1][1] - m[k + 1] * h).toFixed(1)} ${p[k + 1][0].toFixed(1)},${p[k + 1][1].toFixed(1)}`;
  }
  return d;
}

/* ================================================================================================
 * 23b. UI: widget grid (customisable layout, kept per browser)
 * ================================================================================================ */
/**
 * Every page is a set of widgets placed on a column grid. The layout is chosen by the user (Customize
 * button of the top bar) and kept in localStorage["cv-layout"], one layout per page and per grid size:
 *   lg  grid >= 1000 px wide: 12 columns      md  600-999 px: 6 columns      sm  < 600 px: 2 columns
 * A size without its own layout is derived from another one (columns scaled), else from the page default.
 * Saved item: { id, x, w, y, h }: x / w in columns, y = top in px (only used to order the widgets),
 * h = height in px, or null = height of the content ("auto").
 * Packing (gravity up): widgets sorted by (y, x); each one is placed right below the lowest widget already
 * placed on its columns. Widgets never overlap and never jump over one another.
 * Responsive: a widget is never narrower than its minimum width (minPx): it widens, and moves down when
 * the columns it needs are taken.
 */
export const LAYOUT_KEY = "cv-layout";
export const GRID_BPS = [
  { id: "lg", min: 1000, cols: 12, gap: 20, label: "Wide screens" },
  { id: "md", min: 600, cols: 6, gap: 20, label: "Medium screens" },
  { id: "sm", min: 0, cols: 2, gap: 16, label: "Small screens" },
];

/** Grid size for a grid width in px. */
export function gridBp(width) {
  return GRID_BPS.find((b) => width >= b.min) || GRID_BPS[GRID_BPS.length - 1];
}

/** Width of one column (px) for a grid width. */
export function colWidth(width, bp) {
  return Math.max(1, (width - bp.gap * (bp.cols - 1)) / bp.cols);
}

/** Columns needed to give a widget at least minPx. */
export function minCols(minPx, colW, bp) {
  return Math.min(bp.cols, Math.max(1, Math.ceil(((minPx || 0) + bp.gap) / (colW + bp.gap) - 1e-9)));
}

/** Default layout of a page: widgets in the order given, left to right on 12 columns. */
export function defaultLayout(defs) {
  let x = 0;
  return defs.map((d, i) => {
    const w = Math.min(12, Math.max(1, d.w || 12));
    if (x + w > 12) x = 0;
    const it = { id: d.id, x, w, y: i, h: null };
    x = (x + w) % 12;
    return it;
  });
}

/**
 * Effective layout of the visible widgets for a grid size: saved layout of that size, else derived from
 * another size, else the default; then the minimum widths applied.
 * @param {{id:string, w?:number, minPx?:number, minH?:number}[]} defs widgets of the page, in default order
 * @param {any} saved saved layout of the page ({ lg, md, sm, hidden })
 * @returns {{id:string, x:number, w:number, key:number, h:number|null}[]}
 */
export function resolveLayout(defs, saved, bp, colW) {
  const hidden = new Set(saved?.hidden || []);
  let src = saved?.[bp.id], from = bp.cols;
  if (!Array.isArray(src) || !src.length) {
    // nearest size with a layout of its own: larger sizes first
    const order = [...GRID_BPS].sort((a, b) => (a.cols >= bp.cols ? 0 : 1) - (b.cols >= bp.cols ? 0 : 1) || Math.abs(a.cols - bp.cols) - Math.abs(b.cols - bp.cols));
    const o = order.find((b) => b.id !== bp.id && Array.isArray(saved?.[b.id]) && saved[b.id].length);
    src = o ? saved[o.id] : null;
    from = o ? o.cols : 12;
  }
  const def = new Map(defaultLayout(defs).map((x) => [x.id, x]));
  const byId = new Map((src || []).filter((x) => x && typeof x.id === "string").map((x) => [x.id, x]));
  const out = [];
  let extra = 0;
  defs.forEach((d) => {
    if (hidden.has(d.id)) return;
    const s = byId.get(d.id);
    // a widget missing from the saved layout (new, or shown again) goes to the bottom
    const it = s ? { x: +s.x || 0, w: +s.w || 1, key: Number.isFinite(+s.y) ? +s.y : 0, h: s.h, f: from }
      : src ? { x: 0, w: def.get(d.id).w, key: 1e9 + extra++, h: null, f: 12 }
      : { x: def.get(d.id).x, w: def.get(d.id).w, key: def.get(d.id).y, h: null, f: 12 };
    let w = it.f === bp.cols ? it.w : Math.max(1, Math.round((it.w * bp.cols) / it.f));
    let x = it.f === bp.cols ? it.x : Math.round((it.x * bp.cols) / it.f);
    w = Math.min(bp.cols, Math.max(w, minCols(d.minPx, colW, bp)));
    x = Math.max(0, Math.min(x, bp.cols - w));
    const h = Number.isFinite(it.h) && it.h > 0 ? Math.max(it.h, d.minH || 80) : null;
    out.push({ id: d.id, x, w, key: it.key, h });
  });
  return out;
}

/**
 * Pack (gravity up). heights: id -> px. Returns id -> { x, w, top, h } in columns / px, and the total height.
 * @param {{id:string, x:number, w:number, key:number}[]} items
 */
export function packLayout(items, heights, gap) {
  const sorted = [...items].sort((a, b) => a.key - b.key || a.x - b.x);
  const placed = [];
  const pos = new Map();
  let bottom = 0;
  for (const it of sorted) {
    let top = 0;
    for (const p of placed) if (p.x < it.x + it.w && it.x < p.x + p.w) top = Math.max(top, p.top + p.h + gap);
    const h = Math.max(1, heights[it.id] || 0);
    const p = { id: it.id, x: it.x, w: it.w, top, h };
    placed.push(p);
    pos.set(it.id, p);
    bottom = Math.max(bottom, top + h);
  }
  return { pos, height: bottom };
}

/** Saved layouts of every page (localStorage, kept by "Clear local cache" like the theme). */
export function readLayouts() {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (v && v.v === 1 && v.pages && typeof v.pages === "object") return v;
  } catch { /* storage blocked or bad JSON: default layouts */ }
  return { v: 1, pages: {} };
}
export function writeLayouts(all) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(all)); return true; } catch { return false; }
}

/* ================================================================================================
 * 24. UI: shell and pages
 * ================================================================================================ */

const NAV = [
  ["CoinVertible", [["monitoring", "#/coinvertible/monitoring", "Monitoring", "activity"], ["coinwatch", "#/coinvertible/coinwatch", "Coinwatch", "chart"]]],
  ["DeFi", [["morpho", "#/defi/morpho", "Morpho", "layers"], ["uniswap", "#/defi/uniswap", "Uniswap", "swap"]]],
];
const MODULE_NAMES = { "monitoring.supply": "Supply", "monitoring.supplyHistory": "Supply history", "monitoring.mintburn": "Mint & burn", morpho: "Morpho", uniswap: "Uniswap", aggregators: "Aggregators" };
const SOURCE_LABELS = { geckoterminal: "GeckoTerminal", defillama: "DefiLlama", morpho: "Morpho API", forge: "Forge API" };
const STATUS_RANK = { ok: 0, cached: 1, stale: 2, partial: 2, pending: 2, error: 3 };

export class UI {
  /** @param {any} app @param {HTMLElement|null} root */
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.page = "monitoring";
    /** sub-page (Uniswap pool slug) */
    this.sub = null;
    this._raf = 0;
    this.logos = app.config.logos || {};
    /** saved layouts of every page (localStorage "cv-layout") */
    this.layouts = readLayouts();
    this.renderShell();
    this.bindChart();
    this.bindLayout();
    this.tip = new Tooltip();
    app.store.on("change", () => this.renderSoon());
    setInterval(() => this.renderSoon(), 5000);
  }

  get gates() { return this.app.tabs.localGates; }

  /* ---------------- shell ---------------- */

  renderShell() {
    const L = this.logos;
    let collapsed = false;
    try { collapsed = localStorage.getItem("cv:v1:sidebar") === "collapsed"; } catch { /* ignore */ }
    if (L.favicon) {
      const link = document.querySelector('link[rel="icon"]') || document.head.appendChild(Object.assign(document.createElement("link"), { rel: "icon" }));
      link.setAttribute("href", L.favicon);
    }
    const navItem = ([id, href, label, ic]) => {
      const custom = L.nav?.[id];
      const slot = custom && !BAD_LOGOS.has(custom)
        ? `<img src="${esc(custom)}" alt="" onerror="this.outerHTML=this.dataset.fb" data-fb="${esc(icon(ic))}">`
        : icon(ic);
      return `<a class="nav" href="${href}" data-page="${id}" data-tip-collapsed="${esc(label)}"><span class="slot">${slot}</span><span class="label" data-text="${esc(label)}">${esc(label)}</span></a>`;
    };
    // brand logos: one file per theme ({ dark, light }) or a single file for both
    const themed = (src, cls, fallback) => {
      const one = (file, th) => file
        ? `<img class="${cls}${th}" src="${esc(file)}" alt="" onerror="this.outerHTML='${fallback.replace("CLS", cls + th).replace(/"/g, "&quot;")}'">`
        : fallback.replace("CLS", cls + th);
      if (src && typeof src === "object") return one(src.dark, " th-dark") + one(src.light, " th-light");
      return one(src, "");
    };
    const brand = themed(L.brand, "brand-full", '<span class="wordmark CLS">CoinVertible</span>');
    const mark = themed(L.brandMark, "brand-mark", '<span class="logo CLS">CV</span>');
    this.root.innerHTML = `
      <div class="app${collapsed ? " collapsed" : ""}" id="shell">
        <div class="side-col"><aside class="sidebar">
          <a class="side-head" href="#/coinvertible/monitoring">${brand}${mark}</a>
          <nav class="side-nav">${NAV.map(([g, items]) => `<div class="group"><div class="group-label">${esc(g)}</div>${items.map(navItem).join("")}</div>`).join("")}</nav>
          <div class="side-foot">
            <button class="icon-btn" id="btn-theme"></button>
            <button class="icon-btn" id="btn-settings" data-tip="RPC settings">${icon("sliders")}</button>
            <button class="icon-btn" id="btn-diag" data-tip="Diagnostics">${icon("gauge")}<span class="badge" id="diag-badge" hidden></span></button>
          </div>
        </aside></div>
        <div class="main">
          <header class="topbar">
            <button class="icon-btn" id="btn-toggle" data-tip="Toggle sidebar">${icon("panel")}</button>
            <span class="vsep"></span>
            <div class="crumbs" id="crumbs"></div>
            <div class="status" id="status"></div>
            <button class="icon-btn" id="btn-layout" aria-pressed="false">${icon("layout")}</button>
          </header>
          <div class="content" id="content"></div>
        </div>
      </div>
      <div class="edit-bar" id="edit-bar" role="toolbar" aria-label="Customize layout" hidden></div>
      <dialog id="dlg-settings"></dialog>
      <dialog id="dlg-diag" class="wide"></dialog>`;
    const shell = this.root.querySelector("#shell");
    this.content = this.root.querySelector("#content");
    this.root.querySelector("#btn-toggle").addEventListener("click", () => {
      if (matchMedia("(max-width: 760px)").matches) { shell.classList.toggle("drawer"); return; }
      shell.classList.toggle("collapsed");
      try { localStorage.setItem("cv:v1:sidebar", shell.classList.contains("collapsed") ? "collapsed" : "open"); } catch { /* ignore */ }
    });
    this.root.querySelectorAll(".nav").forEach((a) => a.addEventListener("click", () => shell.classList.remove("drawer")));
    this.root.querySelector("#btn-settings").addEventListener("click", () => this.openSettings());
    this.themeButton();
    this.root.querySelector("#btn-theme").addEventListener("click", () => {
      const light = document.documentElement.getAttribute("data-theme") !== "light";
      if (light) document.documentElement.setAttribute("data-theme", "light"); else document.documentElement.removeAttribute("data-theme");
      try { localStorage.setItem("cv-theme", light ? "light" : "dark"); } catch { /* storage blocked: the choice lasts for this visit */ }
      this.themeButton();
      this.tip?.hide();
      this.renderSoon();
    });
    this.root.querySelector("#btn-diag").addEventListener("click", () => this.openDiag());
    this.content.addEventListener("click", (e) => this.onClick(e));
    this.content.addEventListener("submit", (e) => {
      const f = /** @type {HTMLElement} */ (e.target);
      if (f?.id !== "cw-key-form") return;
      e.preventDefault();
      const input = /** @type {HTMLInputElement|null} */ (f.querySelector("#cw-key-input"));
      const k = (input?.value || "").trim();
      if (!/^cw_[A-Za-z0-9_-]{8,}$/.test(k)) { input?.setCustomValidity("A Coinwatch key starts with cw_"); input?.reportValidity(); return; }
      this.app.coinwatch.setKey(k);
      this.render();
    });
    // Aggregators trades filters (native selects)
    this.content.addEventListener("change", (e) => {
      const sel = /** @type {HTMLSelectElement} */ (e.target);
      const ak = sel?.getAttribute?.("data-aggsel");
      if (ak) this.setAggPref(ak, sel.value);
    });
    this.content.addEventListener("input", (e) => { /** @type {HTMLInputElement} */ (e.target)?.setCustomValidity?.(""); });
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      if (this._editing) { if (this._ebMenu) { this._ebMenu = false; this.renderEditBar(); } else if (!this._wdrag) this.setEditing(false); return; }
      if (this._dd) { this._dd = null; this.render(); return; }
      if (this.openVault) this.foldVault();
      else if (this.cwOpen) { this.cwOpen = null; this.render(); }
    });
    // Collapsed rail: nav labels become tooltips.
    shell.addEventListener("mouseover", (e) => {
      const a = /** @type {HTMLElement} */ (e.target)?.closest?.(".nav");
      if (!a) return;
      if (shell.classList.contains("collapsed")) a.setAttribute("data-tip", a.getAttribute("data-tip-collapsed")); else a.removeAttribute("data-tip");
    });
  }

  /** Switch page (and sub-page): rendering only, from data already in the store. */
  /** Theme switch (bottom left): dark "Graphite" by default, light "Paper"; remembered per browser (localStorage "cv-theme"). */
  themeButton() {
    const b = this.root.querySelector("#btn-theme");
    const light = document.documentElement.getAttribute("data-theme") === "light";
    b.innerHTML = icon(light ? "moon" : "sun");
    b.setAttribute("data-tip", light ? "Dark mode" : "Light mode");
    b.setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
  }

  setPage(page, sub = null) {
    const changed = page !== this.page || sub !== this.sub;
    if (changed) { this.areaLeave(); this.tip?.hide(); if (this._editing) this.setEditing(false, false); }
    this.page = page;
    this.sub = sub;
    this.root.querySelectorAll(".nav").forEach((a) => a.classList.toggle("active", a.getAttribute("data-page") === page));
    const g = NAV.find(([, items]) => items.some((i) => i[0] === page));
    const item = g?.[1].find((i) => i[0] === page);
    const subLabel = !sub ? null : page === "coinwatch" ? (sub === "pairs" ? "Trading pairs" : sub.toUpperCase()) : this.app.config.uniswap.pools.find((p) => p.slug === sub)?.label;
    this.root.querySelector("#crumbs").innerHTML = subLabel
      ? `${esc(g?.[0] || "")} / <a class="link" href="${esc(item?.[1] || "#")}">${esc(item?.[2] || "")}</a> / <b>${esc(subLabel.replace("/", " / "))}</b>`
      : `${esc(g?.[0] || "")} / <b>${esc(item?.[2] || "")}</b>`;
    this.render();
    if (changed) scrollTo(0, 0);
  }

  renderSoon() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  /**
   * Rebuild the page from the store. While the layout is being edited the page is frozen (the widgets
   * being arranged do not change under the pointer); force = rebuild anyway (widget hidden / shown, reset).
   */
  render(force = false) {
    if (!this.content) return;
    this.renderStatus();
    if (this._wdrag) return;
    const p = this.page;
    const frozen = this._editing && !force && !!this.content.querySelector(".wgrid");
    if (!frozen) {
      // keep the scroll position of scrollable lists and widget bodies across re-renders
      const keep = {};
      this.content.querySelectorAll("[data-keep]").forEach((el) => { keep[el.getAttribute("data-keep")] = [el.scrollTop, el.scrollLeft]; });
      this.content.querySelectorAll(".w-item").forEach((it) => it.querySelectorAll(".w-body, .card, .tbl").forEach((el, i) => {
        if (el.scrollTop || el.scrollLeft) keep[`w:${it.getAttribute("data-wid")}:${i}`] = [el.scrollTop, el.scrollLeft];
      }));
      this._wdefs = null;
      const html = p === "monitoring" ? this.monitoring() : p === "morpho" ? this.morpho() : p === "uniswap" ? this.uniswap() : this.coinwatch();
      if (html !== this._lastHtml || this.content.childElementCount === 0) {
        this.content.innerHTML = html;
        this._lastHtml = html;
        this._wdefsDom = this._wdefs;
        this._wpageDom = this._wdefs ? this._wpage : null;
      }
      this.applyLayout();
      const put = (el, v) => { if (!v) return; el.scrollTop = v[0]; el.scrollLeft = v[1]; };
      this.content.querySelectorAll("[data-keep]").forEach((el) => put(el, keep[el.getAttribute("data-keep")]));
      this.content.querySelectorAll(".w-item").forEach((it) => it.querySelectorAll(".w-body, .card, .tbl").forEach((el, i) => put(el, keep[`w:${it.getAttribute("data-wid")}:${i}`])));
      this.layoutButton();
    }
    if (p === "uniswap") this.drawCharts();
    this.drawAreas();
    this._vaultAnim = null;
    this._cwAnim = false;
    if (this._lineHover) { if (this.content.querySelector(`[data-lc="${CSS.escape(this._lineHover.id)}"]`)) this.lineHover(this._lineHover.id, this._lineHover.x); else this._lineHover = null; }
    this.root.querySelector("#diag-badge").hidden = !this.problems().length;
    this.tip?.refresh();
  }

  /** Top-right status: last update of the page's data, overall health dot, manual refresh. */
  renderStatus() {
    const el = this.root.querySelector("#status");
    if (this.page === "coinwatch") {
      const st = this._cwStatus;
      if (!this.app.coinwatch.hasKey() || !st) { el.innerHTML = ""; return; }
      const dotCls = st.cls === "ok" ? "ok" : st.cls === "error" ? "error" : "warn";
      const text = st.oldest ? `Updated ${age(st.oldest)}` : st.loading ? "Loading\u2026" : "";
      el.innerHTML = `<span class="status-txt"${tipAttr(`Coinwatch data, cached in this browser and refreshed every ${Math.round((this.app.config.coinwatch.cacheTtlSec || 21600) / 3600)} h.${st.err ? `\n${st.err.error}` : ""}`)}><i class="dot ${dotCls}"></i>${esc(text)}</span>
        <button class="icon-btn sm" id="btn-refresh"${tipAttr("Fetch the Coinwatch data again")}>${icon("refresh")}</button>`;
      el.querySelector("#btn-refresh")?.addEventListener("click", (e) => {
        const b = /** @type {HTMLElement} */ (e.currentTarget);
        b.classList.add("spin"); setTimeout(() => b.classList.remove("spin"), 700);
        this.app.coinwatch.refresh();
      });
      return;
    }
    const ids = this.app.modules.filter((m) => m.page === this.page).map((m) => m.storeId);
    if (!ids.length) { el.innerHTML = ""; return; }
    let last = 0, worst = "ok";
    for (const id of ids) {
      const env = this.env(id);
      for (const [k, s] of Object.entries(env?.sources || {})) {
        last = Math.max(last, s.okAt || 0);
        const st = this.srcStatus(k, s, env);
        if (STATUS_RANK[st] > STATUS_RANK[worst]) worst = st;
      }
      if (!env) worst = STATUS_RANK.pending > STATUS_RANK[worst] ? "pending" : worst;
    }
    const role = this.app.tabs.role;
    const roleTip = role === "follower" ? "Data shared by another open tab of this page (only one tab polls)." : role === "hidden" ? "Paused while the tab is hidden." : "This tab reads the chains on the schedule set in config.js.";
    const stateTip = { ok: "All sources up to date.", stale: "Some sources are late or failing: see the source line and Diagnostics.", error: "Some sources cannot be read: see the source line and Diagnostics.", cached: "Showing values from your last visit while refreshing.", pending: "Waiting for the first reads." }[worst] || "";
    const dotCls = worst === "ok" ? "ok" : worst === "error" ? "error" : "warn";
    const text = last ? `Updated ${age(last)}` : "Connecting\u2026";
    el.innerHTML = `<span class="status-txt"${tipAttr(`${stateTip}\n${roleTip}`)}><i class="dot ${dotCls}"></i>${esc(text)}</span>
      <button class="icon-btn sm" id="btn-refresh"${tipAttr(role === "leader" ? "Refresh now" : "Refreshing is done by the tab that polls")}${role === "leader" ? "" : " disabled"}>${icon("refresh")}</button>`;
    el.querySelector("#btn-refresh")?.addEventListener("click", (e) => {
      const b = /** @type {HTMLElement} */ (e.currentTarget);
      b.classList.add("spin");
      setTimeout(() => b.classList.remove("spin"), 700);
      this.app.scheduler.kick();
    });
  }

  onClick(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    // Customize mode: the widgets' content does not react, only their frame does
    if (this._editing) {
      const id = t?.closest?.(".w-item")?.getAttribute("data-wid");
      if (id && t.closest("[data-whide]")) this.hideWidget(id);
      else if (id && t.closest("[data-wfit]")) this.fitWidget(id);
      return;
    }
    // Coinwatch: tabs, unfold a market maker x exchange row, forget the key
    const tb = t?.closest?.("[data-cwtab]");
    if (tb) { this.cwTab = tb.getAttribute("data-cwtab"); this.cwOpen = null; try { localStorage.setItem("cv:v1:cwtab", this.cwTab); } catch { /* ignore */ } this.tip?.hide(); this.render(); return; }
    if (t?.closest?.("[data-cw-close]")) { this.cwOpen = null; this.tip?.hide(); this.render(); return; }
    if (t?.closest?.("[data-cw-forget]")) { this.app.coinwatch.forgetKey(); this.render(); return; }
    if (t?.closest?.("[data-cwf-clear]")) { this._dd = null; this.setPairFilter({ ex: "", mm: "", tk: "" }); return; }
    // Trading pairs filter menus
    const ddv = t?.closest?.("[data-ddv]");
    if (ddv) {
      if (ddv.hasAttribute("disabled")) return;
      this._dd = null;
      const k = ddv.getAttribute("data-ddv"), v = ddv.getAttribute("data-v");
      if (ddv.getAttribute("data-ddset") === "agg") this.setAggPref(k, v);
      else this.setPairFilter({ ...this.pairFilter(), [k]: v });
      return;
    }
    const dd = t?.closest?.("[data-dd]");
    if (dd) { const k = dd.getAttribute("data-dd"); this._dd = this._dd === k ? null : k; this.tip?.hide(); this.render(); return; }
    if (this._dd && !t?.closest?.(".dd")) { this._dd = null; this.render(); }
    const cr = t?.closest?.("tr[data-cwrow]");
    if (cr && !t.closest("a, button")) { this.cwOpen = cr.getAttribute("data-cwrow"); this._cwAnim = true; this.tip?.hide(); this.render(); this.scrollOpenIntoView(".vault-x"); return; }
    // Morpho: unfold a vault row (one at a time), fold it back with its Close button
    if (t?.closest?.("[data-close-vault]")) { this.foldVault(); return; }
    const row = t?.closest?.("tr[data-vault]");
    if (row && !t.closest("a, button")) { this.unfoldVault(row.getAttribute("data-vault")); return; }
    // Uniswap / aggregators: period and chart view
    const ap = t?.closest?.("[data-aggp]");
    if (ap) { this._aggPeriod = ap.getAttribute("data-aggp"); try { localStorage.setItem("cv:v1:aggperiod", this._aggPeriod); } catch { /* ignore */ } this.tip?.hide(); this.render(); return; }
    const as = t?.closest?.("[data-aggset]");
    if (as) { this.setAggPref(as.getAttribute("data-aggset"), as.getAttribute("data-v")); return; }
    const ms = t?.closest?.("[data-mscope]");
    if (ms) {
      const which = ms.getAttribute("data-mscope"), v = ms.getAttribute("data-v");
      this[`_mscope_${which}`] = v;
      try { localStorage.setItem(`cv:v1:morpho:${which}`, v); } catch { /* ignore */ }
      if (which === "vaults") this.openVault = null;
      this.tip?.hide(); this.render(); return;
    }
    const z = t?.closest?.("[data-zoom]");
    if (z) { this.zoom(z.getAttribute("data-slug"), z.getAttribute("data-zoom")); return; }
    const el = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-gate]");
    if (!el) return;
    const id = el.getAttribute("data-gate");
    this.app.tabs.setGate(id, !this.gates.has(id));
    for (const c of this.app.config.morpho.active) this.app.scheduler.kick(c);
    this.render();
  }

  unfoldVault(key) {
    this.openVault = key;
    this._vaultAnim = key;
    this.tip?.hide();
    this.render();
    this.scrollOpenIntoView(".vault-x");
  }

  /** Bring an unfolded card fully into view (under the sticky top bar). */
  scrollOpenIntoView(sel) {
    requestAnimationFrame(() => {
      const el = this.content.querySelector(sel);
      if (!el) return;
      // inside a widget of fixed height the card scrolls in the widget first (scroll-margin: under the top bar)
      const sc = el.closest(".w-item.fixed .tbl");
      if (sc) { const r = el.getBoundingClientRect(), b = sc.getBoundingClientRect(); sc.scrollBy({ top: r.top - b.top - 42, behavior: "smooth" }); }
      const r = el.getBoundingClientRect();
      const top = 64 + 16, bottom = innerHeight - 16;
      const dy = r.top < top || r.height > bottom - top ? r.top - top : r.bottom > bottom ? r.bottom - bottom : 0;
      if (dy && !sc) scrollBy({ top: dy, behavior: "smooth" });
    });
  }

  foldVault() {
    if (!this.openVault) return;
    this.openVault = null;
    this.tip?.hide();
    this.render();
  }

  /* ---------------- widget grid: rendering, layout, Customize mode ---------------- */

  /**
   * A page made of widgets: head (source pills, page navigation: not movable) + grid + foot.
   * Widget: { id, label, w (default width on 12 columns), minPx (narrowest width, px), minH (lowest fixed
   * height, px), title / sub / tools (header above the body, as a section title) or head (custom header), body }.
   */
  gridPage(page, head, widgets, foot = "") {
    const ws = widgets.filter(Boolean);
    this._wpage = page;
    this._wdefs = ws.map(({ id, label, w, minPx, minH }) => ({ id, label, w, minPx, minH }));
    const hidden = new Set(this.layouts.pages[page]?.hidden || []);
    return `${head || ""}<div class="wgrid settling" data-grid="${esc(page)}">${ws.filter((w) => !hidden.has(w.id)).map((w) => this.widgetHtml(w)).join("")}</div>${foot || ""}`;
  }

  widgetHtml(w) {
    const head = w.head ?? (w.title ? `<div class="sec-head w-head"><h2>${w.title}</h2>${w.sub ? `<span>${w.sub}</span>` : ""}${w.tools || ""}</div>` : "");
    const ov = this._editing ? `<div class="w-ov" tabindex="0" role="group" aria-label="${esc(w.label)}: drag to move; arrow keys move, Shift + arrow keys resize">
        <span class="w-chip">${icon("grip")}<b>${esc(w.label)}</b><span class="w-size"></span></span>
        <span class="w-acts"><button class="w-act w-fit" data-wfit${tipAttr("Fit the height to the content")}>${icon("fold")}</button><button class="w-act" data-whide${tipAttr("Hide (Hidden menu below to show it again)")}>${icon("eyeOff")}</button></span>
        <span class="w-rs e" data-wrs="e"></span><span class="w-rs s" data-wrs="s"></span><span class="w-rs se" data-wrs="se"></span></div>` : "";
    return `<div class="w-item${head ? " has-head" : ""}" data-wid="${esc(w.id)}"><div class="w-in">${head}<div class="w-body">${w.body}</div></div>${ov}</div>`;
  }

  /**
   * Place the widgets: widths from the columns, heights from the content (or the user's fixed height),
   * then packed. Runs after every render and whenever the grid or a widget changes size; it only sets
   * styles (no re-render), so open menus, scroll positions and hovers stay.
   */
  applyLayout() {
    const grid = /** @type {HTMLElement|null} */ (this.content.querySelector(".wgrid"));
    const defs = grid ? this._wdefsDom : null;
    if (!grid || !defs) { this._grid = null; this.observeLayout(null); return; }
    const W = grid.clientWidth;
    if (!W) return;
    const page = this._wpageDom;
    const bp = gridBp(W), colW = colWidth(W, bp), step = colW + bp.gap;
    const L = (x) => Math.round(x * step);
    const wpx = (x, w) => Math.round((x + w) * step - bp.gap) - L(x);
    const els = new Map([...grid.querySelectorAll(":scope > .w-item")].map((el) => [el.getAttribute("data-wid"), /** @type {HTMLElement} */ (el)]));
    const present = defs.filter((d) => els.has(d.id));
    const items = resolveLayout(present, this.layouts.pages[page], bp, colW);
    const set = (el, k, v) => { if (el.style[k] !== v) el.style[k] = v; };
    for (const it of items) {
      const el = els.get(it.id);
      set(el, "width", `${wpx(it.x, it.w)}px`);
      el.classList.toggle("fixed", it.h != null);
      set(el, "height", it.h != null ? `${it.h}px` : "");
    }
    const heights = {};
    for (const it of items) heights[it.id] = it.h ?? els.get(it.id).offsetHeight;
    const P = packLayout(items, heights, bp.gap);
    for (const it of items) { const p = P.pos.get(it.id); set(els.get(it.id), "transform", `translate(${L(p.x)}px, ${p.top}px)`); }
    set(grid, "height", `${P.height}px`);
    grid.style.setProperty("--colw", `${colW.toFixed(2)}px`);
    grid.style.setProperty("--gap", `${bp.gap}px`);
    const prevBp = this._grid?.bp.id;
    this._grid = { page, grid, bp, colW, W, L, wpx, items, heights, pos: P.pos, height: P.height, els, defs: present };
    if (this._editing) { this.sizeLabels(); if (prevBp !== bp.id) this.renderEditBar(); }
    if (grid.classList.contains("settling")) requestAnimationFrame(() => requestAnimationFrame(() => grid.classList.remove("settling")));
    this.observeLayout(grid);
    // the liquidity chart is drawn at its box size: redraw it when the widget size changed
    const ch = /** @type {HTMLElement|null} */ (grid.querySelector("[data-chart]"));
    if (ch) { const k = `${ch.clientWidth}x${ch.clientHeight}`; if (k !== this._chartKey) { this._chartKey = k; this.drawCharts(); } }
  }

  /** Re-place the widgets when the grid width (window, sidebar) or a widget's content changes size. */
  observeLayout(grid) {
    if (typeof ResizeObserver === "undefined") return;
    if (!this._ro) this._ro = new ResizeObserver(() => this.layoutSoon());
    if (grid && this._roGrid === grid) return;
    this._ro.disconnect();
    this._roGrid = grid;
    if (!grid) return;
    this._ro.observe(grid);
    grid.querySelectorAll(":scope > .w-item > .w-in").forEach((el) => this._ro.observe(el));
  }

  layoutSoon() {
    if (this._wdrag || this._layRaf) return;
    this._layRaf = requestAnimationFrame(() => { this._layRaf = 0; if (!this._wdrag) this.applyLayout(); });
  }

  /** Top bar button: Customize layout (on pages made of widgets). */
  layoutButton() {
    const b = this.root.querySelector("#btn-layout");
    if (!b) return;
    const can = !!this._wdefsDom && !!this.content.querySelector(".wgrid");
    b.disabled = !can && !this._editing;
    b.classList.toggle("on", !!this._editing);
    b.setAttribute("aria-pressed", String(!!this._editing));
    b.setAttribute("data-tip", this._editing ? "Done" : can ? "Customize layout: move, resize and hide the widgets of this page" : "Nothing to arrange on this page");
  }

  /** Customize mode: the page is frozen, every widget gets a frame with handles, a toolbar shows at the bottom. */
  setEditing(on, doRender = true) {
    if (on && !this._wdefsDom) return;
    this._editing = on;
    this._ebMenu = false;
    this._wdrag = null;
    this._dd = null;
    this.root.querySelector("#shell").classList.toggle("editing", on);
    this.tip?.hide();
    this.areaLeave();
    this.renderEditBar();
    this.layoutButton();
    if (doRender) { this._lastHtml = null; this.render(true); }
  }

  renderEditBar() {
    const bar = /** @type {HTMLElement} */ (this.root.querySelector("#edit-bar"));
    if (!this._editing) { bar.hidden = true; bar.innerHTML = ""; return; }
    const page = this._wpageDom;
    const defs = this._wdefsDom || [];
    const hidden = (this.layouts.pages[page]?.hidden || []).map((id) => defs.find((d) => d.id === id)).filter(Boolean);
    const bp = this._grid?.bp || GRID_BPS[0];
    const custom = !!this.layouts.pages[page];
    const menu = this._ebMenu && hidden.length
      ? `<div class="dd-menu" role="listbox" aria-label="Hidden widgets">${hidden.map((d) => `<button class="dd-item" data-wshow="${esc(d.id)}">${icon("eye")}<span class="t">${esc(d.label)}</span></button>`).join("")}</div>` : "";
    bar.innerHTML = `<span class="eb-title"${tipAttr(`The layout is kept in this browser, one per screen size.\nThis is the layout for ${bp.label.toLowerCase()} (${bp.cols} columns).`)}>${icon("layout")}<span><b>Customize layout</b><small>${esc(bp.label)}${DOT}${bp.cols} columns</small></span></span>
      <span class="eb-hint">Drag to move${DOT}drag an edge to resize${DOT}double-click an edge to fit</span>
      <span class="eb-tools">
        <div class="dd${this._ebMenu ? " open" : ""}"><button class="btn" data-ebhidden aria-expanded="${!!this._ebMenu}"${hidden.length ? "" : " disabled"}${this._ebMenu ? "" : tipAttr(hidden.length ? "Show a hidden widget again" : "No hidden widget")}>${icon("eyeOff")}<span class="eb-l">Hidden</span><span class="eb-n">${hidden.length}</span></button>${menu}</div>
        <button class="btn" data-ebreset${custom ? "" : " disabled"}${tipAttr("Back to the default layout of this page (every screen size)")}>${icon("reset")}<span class="eb-l">Reset</span></button>
        <button class="btn primary" data-ebdone>${icon("check")}Done</button>
      </span>`;
    bar.hidden = false;
  }

  /** Size shown in the frame of each widget while customizing: columns and height. */
  sizeLabels(only) {
    const G = this._grid;
    if (!G) return;
    for (const it of G.items) {
      if (only && it.id !== only.id) continue;
      const x = only || it;
      const s = G.els.get(it.id)?.querySelector(".w-size");
      if (s) s.textContent = `${x.w}/${G.bp.cols}${DOT}${x.h != null ? `${Math.round(x.h)} px` : "auto"}`;
    }
  }

  /** Save the layout shown for the current screen size (items: x / w in columns, h fixed or null). */
  commitLayout(items, heights) {
    const G = this._grid;
    if (!G) return;
    const P = packLayout(items, heights, G.bp.gap);
    const pg = (this.layouts.pages[G.page] ||= {});
    const others = (pg[G.bp.id] || []).filter((x) => !items.some((i) => i.id === x.id));
    pg[G.bp.id] = [...items.map((i) => ({ id: i.id, x: i.x, w: i.w, y: P.pos.get(i.id).top, h: i.h ?? null })), ...others];
    writeLayouts(this.layouts);
    this.renderEditBar();
  }

  /** Current items with their top as order key (same packing, and comparable with a pointer position). */
  layoutItems() {
    const G = this._grid;
    return G.items.map((x) => ({ ...x, key: G.pos.get(x.id).top }));
  }

  hideWidget(id) {
    const pg = (this.layouts.pages[this._wpageDom] ||= {});
    pg.hidden = [...new Set([...(pg.hidden || []), id])];
    writeLayouts(this.layouts);
    this.tip?.hide();
    this.renderEditBar();
    this._lastHtml = null;
    this.render(true);
  }

  showWidget(id) {
    const pg = this.layouts.pages[this._wpageDom];
    if (pg) pg.hidden = (pg.hidden || []).filter((x) => x !== id);
    writeLayouts(this.layouts);
    this._ebMenu = false;
    this.renderEditBar();
    this._lastHtml = null;
    this.render(true);
    requestAnimationFrame(() => this.content.querySelector(`[data-wid="${CSS.escape(id)}"] .w-ov`)?.focus({ preventScroll: true }));
  }

  /** Height back to the content (auto), or width back to its default (e). */
  fitWidget(id, what = "h") {
    const G = this._grid;
    if (!G) return;
    const items = this.layoutItems();
    const it = items.find((x) => x.id === id);
    if (!it) return;
    if (what === "w") {
      const d = G.defs.find((x) => x.id === id);
      it.w = Math.min(G.bp.cols, Math.max(minCols(d?.minPx, G.colW, G.bp), Math.round(((d?.w || 12) * G.bp.cols) / 12)));
      it.x = Math.min(it.x, G.bp.cols - it.w);
    } else it.h = null;
    this.commitLayout(items, G.heights);
    this.applyLayout();
  }

  resetLayout() {
    delete this.layouts.pages[this._wpageDom];
    writeLayouts(this.layouts);
    this._ebMenu = false;
    this._lastHtml = null;
    this.render(true);
    this.renderEditBar();
  }

  /** Keyboard, on a focused widget frame: arrows move (left / right: one column; up / down: past the neighbour), Shift resizes. */
  nudge(id, key, shift) {
    const G = this._grid;
    if (!G) return;
    const items = this.layoutItems();
    const it = items.find((x) => x.id === id), p = G.pos.get(id);
    if (!it || !p) return;
    const d = G.defs.find((x) => x.id === id);
    const minC = minCols(d?.minPx, G.colW, G.bp);
    const over = (o) => o.id !== id && o.x < it.x + it.w && it.x < o.x + o.w;
    if (shift) {
      if (key === "ArrowRight") it.w = Math.min(G.bp.cols - it.x, it.w + 1);
      else if (key === "ArrowLeft") it.w = Math.max(minC, it.w - 1);
      else it.h = Math.max(d?.minH || 80, Math.round((it.h ?? p.h) / 8) * 8 + (key === "ArrowDown" ? 24 : -24));
    } else if (key === "ArrowRight" || key === "ArrowLeft") {
      it.x = Math.max(0, Math.min(G.bp.cols - it.w, it.x + (key === "ArrowRight" ? 1 : -1)));
    } else {
      const ns = items.filter(over);
      if (key === "ArrowUp") { const a = ns.filter((o) => o.key < p.top).sort((a2, b2) => b2.key - a2.key)[0]; if (a) it.key = a.key - 1; }
      else { const b = ns.filter((o) => o.key > p.top).sort((a2, b2) => a2.key - b2.key)[0]; if (b) it.key = b.key + 1; }
    }
    const heights = { ...G.heights };
    if (it.h != null) heights[id] = it.h;
    this.commitLayout(items, heights);
    this.applyLayout();
    G.els.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /** Pointer and keyboard handling of the Customize mode (pointer events: mouse, pen and touch). */
  bindLayout() {
    this.root.querySelector("#btn-layout").addEventListener("click", () => this.setEditing(!this._editing));
    const bar = /** @type {HTMLElement} */ (this.root.querySelector("#edit-bar"));
    bar.addEventListener("click", (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.closest("[data-ebdone]")) return this.setEditing(false);
      if (t.closest("[data-ebreset]")) return this.resetLayout();
      const sh = t.closest("[data-wshow]");
      if (sh) return this.showWidget(sh.getAttribute("data-wshow"));
      if (t.closest("[data-ebhidden]")) { this._ebMenu = !this._ebMenu; this.tip?.hide(); this.renderEditBar(); }
    });
    document.addEventListener("pointerdown", (e) => {
      if (this._ebMenu && !bar.contains(/** @type {Node} */ (e.target))) { this._ebMenu = false; this.renderEditBar(); }
    });
    this.content.addEventListener("pointerdown", (e) => {
      if (!this._editing || e.button !== 0 || this._wdrag) return;
      const t = /** @type {HTMLElement} */ (e.target);
      if (t.closest("button")) return;
      const ov = t.closest(".w-ov");
      if (!ov) return;
      const rs = t.closest("[data-wrs]");
      // touch: the page scrolls, unless the drag starts on the label or a resize handle
      if (e.pointerType === "touch" && !rs && !t.closest(".w-chip")) return;
      e.preventDefault();
      /** @type {HTMLElement} */ (ov).focus({ preventScroll: true });
      this.startDrag(ov.closest(".w-item").getAttribute("data-wid"), rs ? rs.getAttribute("data-wrs") : "move", e);
    });
    document.addEventListener("pointermove", (e) => {
      const g = this._wdrag;
      if (!g || e.pointerId !== g.pointerId) return;
      g.cx = e.clientX; g.cy = e.clientY;
      this.dragFrame();
    });
    const end = (e) => { if (this._wdrag && e.pointerId === this._wdrag.pointerId) this.endDrag(e.type === "pointercancel"); };
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
    this.content.addEventListener("dblclick", (e) => {
      if (!this._editing) return;
      const rs = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-wrs]");
      const id = rs?.closest(".w-item")?.getAttribute("data-wid");
      if (id) this.fitWidget(id, rs.getAttribute("data-wrs") === "e" ? "w" : "h");
    });
    this.content.addEventListener("keydown", (e) => {
      if (!this._editing) return;
      const ov = /** @type {HTMLElement} */ (e.target)?.closest?.(".w-ov");
      if (!ov || e.target !== ov || !e.key.startsWith("Arrow")) return;
      e.preventDefault();
      this.nudge(ov.closest(".w-item").getAttribute("data-wid"), e.key, e.shiftKey);
    });
    // another tab changed the layouts
    addEventListener("storage", (e) => {
      if (e.key !== LAYOUT_KEY) return;
      this.layouts = readLayouts();
      if (this._wdrag) return;
      this._lastHtml = null;
      this.render(true);
      this.renderEditBar();
    });
  }

  startDrag(id, mode, e) {
    const G = this._grid;
    const p = G?.pos.get(id);
    if (!p) return;
    const items = this.layoutItems();
    const it = items.find((x) => x.id === id);
    const el = G.els.get(id);
    const ph = document.createElement("div");
    ph.className = "w-ph";
    this._wdrag = { id, mode, el, ph, items, it: { ...it }, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, s0: scrollY, cx: e.clientX, cy: e.clientY,
      left0: G.L(p.x), top0: p.top, w0: G.wpx(p.x, p.w), h0: p.h, maxTop: Math.max(0, G.height - Math.min(p.h, 120)), moved: false, cur: null, raf: 0 };
  }

  dragFrame() {
    const g = this._wdrag, G = this._grid;
    if (!g || !G) return;
    const dx = g.cx - g.x0, dy = g.cy - g.y0 + (scrollY - g.s0);
    if (!g.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      g.moved = true;
      g.el.classList.add("active");
      G.grid.classList.add("dragging");
      G.grid.appendChild(g.ph);
      this.tip?.hide();
    }
    const { bp } = G, step = G.colW + bp.gap;
    const d = G.defs.find((x) => x.id === g.id);
    const minC = minCols(d?.minPx, G.colW, bp);
    const it = { ...g.it };
    let gl = g.left0, gt = g.top0, gw = g.w0, gh = g.h0;
    if (g.mode === "move") {
      gl = Math.max(0, Math.min(G.W - g.w0, g.left0 + dx));
      gt = Math.max(0, Math.min(g.maxTop, g.top0 + dy));
      it.x = Math.max(0, Math.min(bp.cols - it.w, Math.round(gl / step)));
      // dropped before a widget when the top of the dragged one is above that widget's top + 40 px
      it.key = gt - 40;
    } else {
      if (g.mode.includes("e")) {
        gw = Math.max(G.wpx(0, minC), Math.min(G.W - g.left0, g.w0 + dx));
        it.w = Math.max(minC, Math.min(bp.cols - it.x, Math.round((gw + bp.gap) / step)));
        g.el.style.width = `${Math.round(gw)}px`;
      }
      if (g.mode.includes("s")) {
        gh = it.h = Math.max(d?.minH || 80, Math.round((g.h0 + dy) / 4) * 4);
        g.el.classList.add("fixed");
        g.el.style.height = `${gh}px`;
      } else if (it.h == null) gh = g.el.offsetHeight;
    }
    const heights = { ...G.heights, [g.id]: it.h ?? (g.mode === "move" ? g.h0 : gh) };
    const items = g.items.map((x) => (x.id === g.id ? it : x));
    const P = packLayout(items, heights, bp.gap);
    for (const x of items) {
      if (x.id === g.id) continue;
      const p = P.pos.get(x.id);
      G.els.get(x.id).style.transform = `translate(${G.L(p.x)}px, ${p.top}px)`;
    }
    const me = P.pos.get(g.id);
    g.el.style.transform = `translate(${Math.round(gl)}px, ${Math.round(gt)}px)`;
    Object.assign(g.ph.style, { transform: `translate(${G.L(me.x)}px, ${me.top}px)`, width: `${G.wpx(me.x, me.w)}px`, height: `${heights[g.id]}px` });
    G.grid.style.height = `${Math.max(P.height, gt + gh)}px`;
    g.cur = { items, heights };
    this.sizeLabels(it);
    // near the top / bottom of the window: scroll
    const edge = 72, top = 64;
    const sp = g.cy < top + edge ? -Math.ceil((top + edge - g.cy) / 5) : g.cy > innerHeight - edge ? Math.ceil((g.cy - innerHeight + edge) / 5) : 0;
    const room = sp < 0 ? scrollY > 0 : scrollY + innerHeight < document.documentElement.scrollHeight - 1;
    if (sp && room && !g.raf) g.raf = requestAnimationFrame(() => { g.raf = 0; if (this._wdrag !== g) return; scrollBy(0, sp); this.dragFrame(); });
  }

  endDrag(cancel) {
    const g = this._wdrag;
    this._wdrag = null;
    if (!g) return;
    if (g.raf) cancelAnimationFrame(g.raf);
    g.ph.remove();
    g.el.classList.remove("active");
    this._grid?.grid.classList.remove("dragging");
    if (g.moved && g.cur && !cancel) this.commitLayout(g.cur.items, g.cur.heights);
    if (g.moved) this.applyLayout();
  }

  /* ---------------- shared pieces ---------------- */

  env(id) { return this.app.store.get(id); }

  /** Effective status of a source (ok / stale / error / cached), with age-based staleness. */
  srcStatus(key, s, env) {
    if (env?.cached) return "cached";
    if (!s) return "pending";
    const f = this.app.config.frequency;
    const interval = this.app.scheduler.baseInterval(key in f.chains ? key : `api:${key}`);
    const maxAge = s.staleAfterSec ? s.staleAfterSec * 1000 : interval * 1000 * (f.behaviour.staleAfterIntervals || 3);
    if (s.status === "ok" && s.okAt && Date.now() - s.okAt > maxAge) return "stale";
    return s.status;
  }

  /** Source line at the top of a page: one entry per chain/API, endpoint and errors in the tooltip. */
  sources(moduleIds) {
    const order = [...Object.keys(this.app.config.chains), "forge", "geckoterminal", "defillama", "morpho"];
    const merged = new Map();
    for (const id of moduleIds) {
      const env = this.env(id);
      for (const [k, s] of Object.entries(env?.sources || {})) {
        const st = this.srcStatus(k, s, env);
        const m = merged.get(k) || { status: "ok", okAt: 0, ref: "", lines: [] };
        if (STATUS_RANK[st] > STATUS_RANK[m.status]) m.status = st;
        if ((s.okAt || 0) >= m.okAt) {
          m.okAt = s.okAt || m.okAt;
          m.ref = s.block ? `block ${num(s.block)}` : s.slot ? `slot ${num(s.slot)}` : s.ledger ? `ledger ${num(s.ledger)}` : m.ref;
        }
        const ep = s.endpoint ? `via ${s.endpoint}` : "";
        const err = s.error && st !== "ok" ? `\n  ${s.error}` : "";
        m.lines.push(`${MODULE_NAMES[id] || id}${DOT}${st}${s.endpoint ? DOT + s.endpoint : ""}${err}`);
        merged.set(k, m);
      }
    }
    if (!merged.size) return `<div class="sources"><span class="src pending"><i></i>Connecting\u2026</span></div>`;
    const items = [...merged.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([k, m]) => {
      const label = this.app.config.chains[k]?.label || SOURCE_LABELS[k] || k;
      // the block / slot / ledger number is in the tooltip only
      const tip = (m.ref ? `${label}${DOT}${m.ref}\n` : "") + (m.status === "cached" ? "Values from your last visit, refreshing\u2026\n" : "") + m.lines.join("\n");
      return `<span class="src ${m.status}"${tipAttr(tip)}><i></i><b>${esc(label)}</b><span>${age(m.okAt || null)}</span></span>`;
    });
    return `<div class="sources">${items.join("")}</div>`;
  }

  chainCell(chain, problem) {
    const c = this.app.config.chains[chain];
    const dot = problem ? `<span class="err-dot"${tipAttr(problem)}></span>` : "";
    return `<span class="cell">${logo(this.logos.chains?.[chain], c?.label || chain)}<span>${esc(c?.label || chain)}</span>${dot}</span>`;
  }

  tokenCell(sym) {
    return `<span class="cell">${logo(this.logos.tokens?.[sym], sym)}<span>${esc(sym)}</span></span>`;
  }

  addrLink(chain, address, label) {
    if (!address) return DASH;
    const ex = this.app.config.chains[chain].explorer;
    const text = label ? `<span>${esc(label)}</span>` : `<span class="mono">${esc(shortHex(address))}</span>`;
    return `<a class="link" href="${esc(ex.address + address)}" target="_blank" rel="noopener"${tipAttr(address)}>${text}</a>`;
  }

  txLink(chain, hash) {
    if (!hash) return DASH;
    const ex = this.app.config.chains[chain].explorer;
    return `<a class="link" href="${esc(ex.tx + hash)}" target="_blank" rel="noopener"${tipAttr(hash)}><span class="mono">${esc(shortHex(hash))}</span>${icon("ext", "ext")}</a>`;
  }

  waiting(cols, text = "Loading\u2026") {
    return `<tr><td colspan="${cols}" class="empty">${esc(text)}</td></tr>`;
  }

  /* ---------------- pages ---------------- */

  monitoring() {
    const sup = this.env("monitoring.supply");
    const mb = this.env("monitoring.mintburn");
    const hist = this.env("monitoring.supplyHistory");
    const chains = this.app.config.chains;
    const cards = Object.entries(sup?.data || this.app.config.tokens).map(([sym, t]) => {
      const rows = Object.entries(t.chains || {}).map(([c, v]) => {
        if (v.derived) return this.cantonRow(sym, v);
        const s = sup?.sources?.[c];
        const st = this.srcStatus(c, s, sup);
        const problem = v.amount == null || st === "error" || st === "stale"
          ? (s?.error ? `Could not read ${chains[c]?.label || c}: ${s.error}` : st === "stale" ? `No fresh value from ${chains[c]?.label || c} for ${age(s?.okAt)}; showing the last value.` : `Waiting for the first read of ${chains[c]?.label || c}.`)
          : "";
        return `<tr><td>${this.chainCell(c, problem && st !== "pending" ? problem : "")}</td><td class="r num">${amount(v.amount, 0)}</td>
          <td class="r"><span class="meter"><span class="track"><span style="width:${((v.share || 0) * 100).toFixed(2)}%"></span></span><span class="w">${pct(v.share)}</span></span></td></tr>`;
      }).join("");
      const partial = t.partial ? `<span class="err-dot"${tipAttr("Partial total: at least one chain could not be read and is not included.")}></span>` : "";
      return { id: `supply.${sym}`, label: `${sym} supply`, w: 6, minPx: 300, minH: 160, body: `<div class="card">
        <div class="card-body">
          <div class="card-head">${logo(this.logos.tokens?.[sym], sym, "lg")}<span>${esc(sym)}</span><span class="muted">${esc(t.name || "")}</span></div>
          <div class="hero">${t.total != null ? amount(t.total, 0) : DASH}<small>${esc(sym)}</small>${partial}</div>
          ${this.areaChart(`supply:${sym}`, hist?.data?.series?.[sym], { unit: sym, height: 64, compact: true, label: "Issued supply history (DefiLlama, daily)" })}
        </div>
        <div class="tbl"><table><thead><tr><th>Chain</th><th class="r">Supply</th><th class="r">Share</th></tr></thead>
        <tbody>${rows || this.waiting(3)}</tbody></table></div>
      </div>` };
    });

    const evs = mb?.data?.events || [];
    const mbRows = evs.map((e) => {
      const label = this.app.labels.resolve(e.chain, e.counterparty.address).label;
      const note = e.attribution === "redemption" ? `<span class="note"${tipAttr(`RedemptionStarted to ${e.via}`)}>via redemption</span>`
        : e.attribution === "transfer-to-registrar" ? `<span class="note"${tipAttr("Matched on a transfer to the registrar with the same amount")}>via registrar</span>`
        : e.attribution === "registrar" ? `<span class="note"${tipAttr("No matching redemption or transfer to the registrar found")}>registrar</span>` : "";
      return `<tr><td>${dateTime(e.timestamp)}</td><td>${this.chainCell(e.chain)}</td><td>${this.tokenCell(e.token)}</td>
        <td class="${e.type}">${e.type === "mint" ? "Mint" : "Burn"}</td>
        <td>${this.addrLink(e.chain, e.counterparty.address, label)}${note}</td>
        <td class="r num">${amount(e.amount, 2, 2)}</td><td>${this.txLink(e.chain, e.txHash)}</td></tr>`;
    }).join("");

    return this.gridPage("monitoring", this.sources(["monitoring.supply", "monitoring.supplyHistory", "monitoring.mintburn"]), [
      ...cards,
      { id: "mintburn", label: "Mints & burns", w: 12, minPx: 560, minH: 200, title: "Recent mints &amp; burns", sub: `Ethereum, last ${evs.length || 15}`,
        body: `<div class="card"><div class="tbl list" data-keep="mintburn"><table>
          <thead><tr><th>Date</th><th>Chain</th><th>Token</th><th>Type</th><th>Recipient / sender</th><th class="r">Amount</th><th>Tx</th></tr></thead>
          <tbody>${mbRows || this.waiting(7, mb ? "No event found yet" : "Loading\u2026")}</tbody>
        </table></div></div>` },
    ]);
  }

  /** TEMPORARY Canton row: derived amount, orange dot explaining the daily source. */
  cantonRow(sym, v) {
    const others = Object.keys(this.app.config.tokens[sym].deployments).map((c) => this.app.config.chains[c]?.label || c).join(" - ");
    const tip = `Canton (temporary method): Forge API total supply - ${others} (read on-chain).\nThe Forge API is updated once a day${v.forgeAt ? `; fetched ${age(v.forgeAt)}` : ""}${v.forgeTotal != null ? `\nForge API total: ${amount(v.forgeTotal, 0)} ${sym}` : ""}${v.negative != null ? `\nThe difference is negative (${amount(v.negative, 0)}): the daily figure is behind the chains, shown as 0.` : ""}`;
    const cell = `<span class="cell">${logo(this.logos.chains?.canton, "Canton")}<span>Canton</span><span class="err-dot warn"${tipAttr(tip)}></span></span>`;
    return `<tr><td>${cell}</td><td class="r num">${v.amount != null ? amount(v.amount, 0) : `<span class="subtle">\u2026</span>`}</td>
      <td class="r"><span class="meter"><span class="track"><span style="width:${((v.share || 0) * 100).toFixed(2)}%"></span></span><span class="w">${pct(v.share)}</span></span></td></tr>`;
  }

  /**
   * "Show more" footer inside a card. While the extra rows are being read (opened, nothing to show yet),
   * the footer says so with a small spinner and a thin progress line; a click still folds it back.
   */
  moreBtn(gate, open, count, loading = false, what = "") {
    if (open && loading) return `<button class="card-more open loading" data-gate="${gate}"${tipAttr("Read on-chain at the next block; click to cancel")}><span class="spin-ring" aria-hidden="true"></span><span>Fetching ${count ? `${count} ` : ""}more ${esc(what)}\u2026</span></button>`;
    return `<button class="card-more${open ? " open" : ""}" data-gate="${gate}"><span>${open ? "Show less" : `Show ${count ?? ""} more`.replace("  ", " ")}</span>${icon("chevron")}</button>`;
  }

  /** Small chain logo placed before a vault / market (tooltip: chain name). */
  chainMark(chain) {
    const c = this.app.config.chains[chain];
    return `<span class="chain-mark"${tipAttr(c?.label || chain)}>${logo(this.logos.chains?.[chain], c?.label || chain, "sm")}</span>`;
  }

  /** Chain filter of a Morpho section ("vaults" / "markets"): All + one button per chain read; kept per browser. */
  morphoScope(which, chains) {
    const k = `_mscope_${which}`;
    if (this[k] == null) { try { this[k] = localStorage.getItem(`cv:v1:morpho:${which}`) || "all"; } catch { this[k] = "all"; } }
    if (this[k] !== "all" && !chains.includes(this[k])) this[k] = "all";
    return this[k];
  }

  morphoScopeSeg(which, chains, scope) {
    if (chains.length < 2) return "";
    const btn = (v, label, lg) => `<a role="button" data-mscope="${which}" data-v="${esc(v)}"${v === scope ? ' class="on"' : ""}>${lg || ""}${esc(label)}</a>`;
    return `<div class="sec-tools"><div class="seg chain-seg">${btn("all", "All")}${chains.map((c) => btn(c, this.app.config.chains[c]?.label || c, logo(this.logos.chains?.[c], c, "sm"))).join("")}</div></div>`;
  }

  /** Vault name with its curator logo (Morpho API), linked to the Morpho app. */
  vaultName(v, big) {
    const cur = v.curator;
    const tip = `${cur?.name ? `Curator: ${cur.name}\n` : ""}Open on Morpho\n${v.address}`;
    return `<span class="cell">${big ? "" : this.chainMark(v.chain)}${logo(cur?.image, cur?.name || v.label, big ? "xl" : "")}<a class="link${big ? " big" : ""}" href="${esc(v.url)}" target="_blank" rel="noopener"${tipAttr(tip)}>${esc(v.label)}</a><span class="tag">V${v.version}</span></span>`;
  }

  /**
   * Hover of the net APY (the net itself is already on screen). Everything in the hover is before fees,
   * so that Native + Incentives = Gross; the net on screen is that gross after the vault's fees.
   *   Gross APY      only when the vault charges a fee (otherwise gross = net)
   *   Native         always: yield of the markets the vault lends to
   *   Incentives     when native < gross, whatever their origin and whatever the config flag:
   *                  Gross - Native (on-chain: Vault V2 donations paid out up to maxRate)
   *   Cap (maxRate)  only for vaults with incentives: true, and only when the cap is a real target
   *                  (<= CAP_MEANINGFUL; curators leave it far higher when they do not use it);
   *                  marked "reached" when the vault already grows at the cap
   */
  apyTip(v) {
    const fees = (v.fees?.performance || 0) > 0 || (v.fees?.management || 0) > 0;
    const bf = fees ? " (before fees)" : "";
    const gross = v.grossApy, native = v.nativeGrossApy ?? v.nativeApy;
    const incent = gross != null && native != null && gross - native > 0.00005 ? gross - native : null;
    const cap = v.incentivesEnabled && v.capApy != null && v.capApy <= CAP_MEANINGFUL ? v.capApy : null;
    // with fees but no incentives, gross = native: one line instead of two identical ones
    if (fees && incent == null && native != null) return [`Native = gross APY ${pct(native)}${bf}`, cap != null ? `Cap (maxRate) ${pct(cap)}` : null].filter(Boolean).join("\n");
    return [
      fees && gross != null ? `Gross APY ${pct(gross)}${bf}` : null,
      native != null ? `Native ${pct(native)}${bf}` : null,
      incent != null ? `Incentives ${pct(incent)}${bf}` : null,
      cap != null ? `Cap (maxRate) ${pct(cap)}${gross != null && gross >= cap - 0.00005 ? DOT + "reached" : ""}` : null,
    ].filter(Boolean).join("\n");
  }

  /** Net APY value, with the hover style only when there is something to show on hover. */
  apyCell(v, cls = "") {
    const tip = this.apyTip(v);
    return `<span class="${tip ? "hover " : ""}${cls}"${tipAttr(tip)}>${pct(v.apy)}</span>`;
  }

  /** Vault fees read on-chain (fee() / performanceFee() / managementFee()), shown under the APY when any. */
  feesTxt(v) {
    const f = v.fees || {};
    const parts = [];
    if (f.performance > 0) parts.push(`perf. fee ${pct(f.performance, f.performance * 1000 % 10 ? 1 : 0)}`);
    if (f.management > 0) parts.push(`mgmt fee ${pct(f.management, 2)}`);
    return parts.join(DOT);
  }

  /** Incentives as "55,971 EURCV - 5d 12h" with burn rate and depletion date underneath. */
  incentives(v, asset) {
    const inc = v.incentives;
    if (!inc) return null;
    const runway = inc.runwayInfinite ? "\u221e" : duration(inc.runwaySec);
    const until = inc.depletionAt ? new Date(inc.depletionAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
    return {
      main: `${amount(String(inc.buffer), 0)} ${esc(asset)} \u2013 ${runway}`,
      sub: `burn ${amount(String(inc.burnPerDay), 0)}/day${until ? `${DOT}until ${esc(until)}` : ""}`,
      tip: `Donated ${asset} not yet distributed, and how long it lasts at the current size and rates.\nBurn = totalAssets x maxRate - organic yield of the allocations.`,
    };
  }

  /**
   * Large vault card: the Main Vault (fixed) or a vault unfolded from the table (closable).
   * The deposits chart comes from the Morpho API, fetched once when the card is shown.
   */
  vaultCard(v, asset, o = {}) {
    const inc = this.incentives(v, asset);
    const metric = (label, value, sub, tip, cls = "") => `<div class="mv-metric${cls}"><div class="mv-label">${esc(label)}</div><div class="mv-value"${tipAttr(tip)}>${value}</div>${sub ? `<div class="mv-sub">${sub}</div>` : ""}</div>`;
    const hist = this.app.morphoHistory.get(v.key, v.version);
    const st = this.app.morphoHistory.state(v.key);
    const chart = hist?.length > 1
      ? this.areaChart(`deposits:${v.key}`, hist, { unit: asset, height: 140, title: "Total deposits (Morpho API, daily)", label: "Total deposits history" })
      : `<div class="area-ph">${st === "error" ? "Deposits history unavailable (Morpho API)" : "Loading the deposits history\u2026"}</div>`;
    const close = o.closable ? `<button class="x-close" data-close-vault${tipAttr("Fold back into the table")}>Close${icon("x")}</button>` : "";
    return `<div class="${o.closable ? `vault-x${o.anim ? " anim" : ""}` : "card main-vault"}"${o.closable ? ` data-open-vault="${esc(v.key)}"` : ""}>
      <div class="mv-head"><span class="mv-title">${esc(o.title || "Vault")}</span>${close}</div>
      <div class="mv-body">
        <div class="mv-id">${this.vaultName(v, true)}<div class="mv-sub mv-chain">${v.chain ? `${logo(this.logos.chains?.[v.chain], v.chain, "sm")}<span>${esc(this.app.config.chains[v.chain]?.label || v.chain)}</span>` : ""}${v.curator?.name ? `${v.chain ? `<span class="sep">${DOT.trim()}</span>` : ""}<span>Curated by ${esc(v.curator.name)}</span>` : ""}</div></div>
        <div class="mv-metrics">
          ${metric(`Total deposits`, `${amount(v.totalDeposits, 0)}<small>${esc(asset)}</small>`, "", "", " wide")}
          ${metric("Net APY", this.apyCell(v), this.feesTxt(v) || `native ${pct(v.nativeGrossApy ?? v.nativeApy)}`, "")}
          ${metric("Idle", pct(v.idlePct), `${amount(v.idle, 0)} ${esc(asset)}`, "Assets not deployed in a lending market (vault balance + idle market).")}
          ${inc ? metric("Incentives", inc.main, inc.sub, inc.tip, " wide") : ""}
        </div>
      </div>
      <div class="mv-chart">${chart}</div>
    </div>`;
  }

  morpho() {
    const env = this.env("morpho");
    const d = env?.data;
    const asset = d?.asset || this.app.config.morpho.asset;
    const chains = d?.chains || this.app.config.morpho.active;
    const vScope = this.morphoScope("vaults", chains), mScope = this.morphoScope("markets", chains);
    const inScope = (scope) => (x) => scope === "all" || x.chain === scope;
    const vOpen = this.gates.has("morpho.vaults.others");
    const mOpen = this.gates.has("morpho.markets.others");
    // Main Vault = the largest whitelisted deposits of the chain selected (or the config override on it)
    const main = (d?.vaults || []).find((v) => v.key === d?.main?.[vScope]?.key);
    const vAll = (d?.vaults || []).filter(inScope(vScope));
    const mAll = (d?.markets || []).filter(inScope(mScope));
    const vaults = vAll.filter((v) => v !== main && (v.whitelist || vOpen));
    const markets = mAll.filter((m) => m.whitelist || mOpen);
    const ov = mOpen && d?.overviewAllBy?.[mScope]?.markets > (d?.overviewBy?.[mScope]?.markets || 0) ? d.overviewAllBy[mScope] : d?.overviewBy?.[mScope];
    const vCount = d?.countsBy?.[vScope]?.othersVaults, mCount = d?.countsBy?.[mScope]?.othersMarkets;
    // "Show more" opened but nothing extra read yet: loading
    const vLoading = vOpen && (vCount || 0) > 0 && !vAll.some((v) => !v.whitelist);
    const mLoading = mOpen && (mCount || 0) > 0 && !mAll.some((m) => !m.whitelist);
    const scopeLabel = (sc) => (sc === "all" ? "" : `${DOT}${this.app.config.chains[sc]?.label || sc}`);
    // empty table: say why (nothing whitelisted on the chain selected yet, or loading)
    const none = (sc, list, open, loading, what) => !d ? "Loading\u2026" : loading ? `Fetching the other ${what}s\u2026`
      : !list.some((x) => x.whitelist) && !open && sc !== "all" ? `No whitelisted ${what} on ${this.app.config.chains[sc]?.label || sc} (config.js morpho.${what}s): "Show more" lists the others`
      : `No other ${what}`;

    const vaultRow = (v) => {
      if (this.openVault === v.key) return `<tr class="xrow"><td colspan="5">${this.vaultCard(v, asset, { closable: true, anim: this._vaultAnim === v.key })}</td></tr>`;
      const inc = this.incentives(v, asset);
      const fees = this.feesTxt(v);
      return `<tr class="vrow ${v.whitelist ? "" : "other"}${inc || fees ? " tall" : ""}" data-vault="${esc(v.key)}"${tipAttr("")}>
        <td>${this.vaultName(v)}</td>
        <td class="r num">${amount(v.totalDeposits, 0)}</td>
        <td class="r">${pct(v.idlePct)}</td>
        <td class="r">${this.apyCell(v, "num")}${fees ? `<span class="two">${fees}</span>` : ""}</td>
        <td>${inc ? `<span class="num"${tipAttr(inc.tip)}>${inc.main}</span><span class="two">${inc.sub}</span>` : `<span class="subtle">${DASH}</span>`}</td></tr>`;
    };
    const marketRow = (m) => `<tr class="tall ${m.whitelist ? "" : "other"}">
      <td><span class="cell">${this.chainMark(m.chain)}${logo(m.collateral.logoURI, m.collateral.symbol)}<span>
        <a class="link num" href="${esc(m.url)}" target="_blank" rel="noopener"${tipAttr("Open on Morpho")}>${esc(m.pair.replace("/", " / "))}</a><span class="lltv">${pct(m.lltv, Math.round(m.lltv * 1000) % 10 ? 1 : 0)} LLTV</span>
        <span class="two mono"${tipAttr(m.id)}>${esc(m.id.slice(0, 10))}\u2026</span></span></span></td>
      <td class="c num">${pct(m.borrowApy)}</td>
      <td><span class="meter util"><span class="track"><span class="f-${m.utilizationBand}" style="width:${Math.min(100, m.utilization * 100).toFixed(2)}%"></span></span><span class="w">${pct(m.utilization)}</span></span></td>
      <td class="r">${compact(m.totalSupplied)}</td><td class="r">${compact(m.totalBorrowed)}</td></tr>`;

    const where = mScope === "all" ? (chains.length > 1 ? "on every chain" : "") : `on ${this.app.config.chains[mScope]?.label || mScope}`;
    const kpiTip = (fn) => `Sum of ${fn} of the ${mOpen ? "whitelisted and non-whitelisted" : "whitelisted"} ${asset} markets${where ? ` ${where}` : ""} (${ov?.markets ?? 0} markets), read on-chain from Morpho Blue market(id) at the block shown above, with interest accrued to that block's timestamp.\nOpening "Show more" adds the non-whitelisted markets to the total.`;

    const mainPh = `<div class="card main-vault"><div class="mv-head"><span class="mv-title">Main Vault</span></div><div class="mv-body"><span class="muted">${!d ? "Loading\u2026" : `No whitelisted vault${scopeLabel(vScope) ? ` on ${esc(this.app.config.chains[vScope]?.label || vScope)}` : ""}`}</span></div></div>`;
    return this.gridPage("morpho", this.sources(["morpho"]), [
      { id: "morpho.main", label: "Main vault", w: 12, minPx: 460, minH: 160, body: main ? this.vaultCard(main, asset, { title: "Main Vault" }) : mainPh },
      { id: "morpho.vaults", label: "Vaults", w: 12, minPx: 560, minH: 200, title: "Vaults", sub: `${esc(asset)}${scopeLabel(vScope)}`, tools: this.morphoScopeSeg("vaults", chains, vScope),
        body: `<div class="card"><div class="tbl"><table>
          <colgroup><col><col style="width:18%"><col style="width:10%"><col style="width:10%"><col style="width:24%"></colgroup>
          <thead><tr><th>Vault</th><th class="r">Total deposits (${esc(asset)})</th><th class="r">Idle</th><th class="r">Net APY</th><th>Incentives</th></tr></thead>
          <tbody>${vaults.map(vaultRow).join("") || this.waiting(5, none(vScope, vAll, vOpen, vLoading, "vault"))}</tbody></table></div>
          ${this.moreBtn("morpho.vaults.others", vOpen, vCount, vLoading, vCount === 1 ? "vault" : "vaults")}</div>` },
      { id: "morpho.supplied", label: "Total supplied", w: 6, minPx: 150, minH: 100, body: `<div class="card card-body"><div class="kpi-label">Total supplied<span class="tip-i"${tipAttr(kpiTip("totalSupplyAssets"))}>${icon("info")}</span></div><div class="kpi">${amount(ov?.totalSupplied, 0)}<small>${esc(asset)}</small></div></div>` },
      { id: "morpho.borrowed", label: "Total borrowed", w: 6, minPx: 150, minH: 100, body: `<div class="card card-body"><div class="kpi-label">Total borrowed<span class="tip-i"${tipAttr(kpiTip("totalBorrowAssets"))}>${icon("info")}</span></div><div class="kpi">${amount(ov?.totalBorrowed, 0)}<small>${esc(asset)}</small></div></div>` },
      { id: "morpho.markets", label: "Markets", w: 12, minPx: 560, minH: 200, title: "Markets", sub: `${esc(asset)} lent${scopeLabel(mScope)}`, tools: this.morphoScopeSeg("markets", chains, mScope),
        body: `<div class="card"><div class="tbl"><table>
          <colgroup><col style="width:30%"><col><col style="width:220px"><col style="width:12%"><col style="width:12%"></colgroup>
          <thead><tr><th>Market</th><th class="c">Borrow APY</th><th>Utilization</th><th class="r">Supplied</th><th class="r">Borrowed</th></tr></thead>
          <tbody>${markets.map(marketRow).join("") || this.waiting(5, none(mScope, mAll, mOpen, mLoading, "market").replace("No other market", "No market"))}</tbody></table></div>
          ${this.moreBtn("morpho.markets.others", mOpen, mCount, mLoading, mCount === 1 ? "market" : "markets")}</div>` },
    ]);
  }

  /* ---------------- area chart (one series: line + fading fill, crosshair + tooltip) ---------------- */

  /**
   * History chart. The SVG uses a fixed 1000-wide viewBox stretched to the container (strokes keep
   * their width), so it is drawn directly in the page HTML and follows any width change.
   * o.compact: at rest a narrower, smoothed curve (~36 points); it unfolds to the full daily curve,
   * with its dates, when the pointer enters it.
   * @param {string} id unique id  @param {[number, number][]|null|undefined} points [[unix seconds, value], ...] ascending
   */
  areaChart(id, points, o = {}) {
    if (!points || points.length < 2) return "";
    const H = o.height || 80, VW = 1000, pad = 4;
    const t0 = points[0][0], t1 = points[points.length - 1][0];
    let lo = Infinity, hi = -Infinity;
    for (const [, v] of points) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || Math.abs(hi) || 1;
    lo -= span * 0.08; hi += span * 0.08;
    const X = (t) => ((t - t0) / (t1 - t0 || 1)) * VW;
    const Y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad);
    (this._areas ||= {})[id] = { points, unit: o.unit || "", t0, t1, Y };
    const gid = `g-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
    const layer = (cls, d) => `<g class="lyr ${cls}"><path d="${d}L${VW},${H}L0,${H}Z" fill="url(#${gid})"/><path d="${d}" class="area-line" vector-effect="non-scaling-stroke"/></g>`;
    const full = points.map(([t, v], k) => `${k ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const smooth = o.compact ? layer("lyr-smooth", monotonePath(samplePoints(points, 36).map(([t, v]) => [X(t), Y(v)]))) : "";
    const fmtD = (t) => new Date(t * 1000).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    const open = this._areaOpen === id;
    return `<div class="area-wrap${o.compact ? " compact" : ""}${open ? " open" : ""}" data-area-wrap="${esc(id)}">
      <div class="area" data-area="${esc(id)}" style="height:${H}px" role="img" aria-label="${esc(o.label || "History")}">
        <svg viewBox="0 0 ${VW} ${H}" preserveAspectRatio="none" height="${H}" aria-hidden="true">
          <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--primary)" stop-opacity="0.32"/><stop offset="1" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>
          ${layer(o.compact ? "lyr-full" : "", full)}${smooth}</svg>
        <span class="area-x"></span><span class="area-pt"></span></div>
      <div class="area-foot"><span>${esc(fmtD(t0))}</span>${o.title ? `<span>${esc(o.title)}</span>` : ""}<span>Today</span></div></div>`;
  }

  /** After a re-render: put the crosshair back if the pointer is still on a chart. */
  drawAreas() {
    const h = this._areaHover;
    if (!h) return;
    if (this.content.querySelector(`[data-area="${CSS.escape(h.id)}"]`)) this.areaHover(h.id, h.x); else this.areaLeave();
  }

  /** Crosshair on the nearest day + tooltip with the date and the amount. */
  areaHover(id, clientX) {
    const el = /** @type {HTMLElement|null} */ (this.content.querySelector(`[data-area="${CSS.escape(id)}"]`));
    const a = this._areas?.[id];
    if (!el || !a) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    const pts = a.points;
    const t = a.t0 + f * (a.t1 - a.t0);
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] < t) lo = m; else hi = m; }
    const [pt, pv] = Math.abs(pts[lo][0] - t) <= Math.abs(pts[hi][0] - t) ? pts[lo] : pts[hi];
    const fx = (pt - a.t0) / (a.t1 - a.t0 || 1), y = a.Y(pv);
    el.classList.add("hov");
    const ln = /** @type {HTMLElement} */ (el.querySelector(".area-x")), dot = /** @type {HTMLElement} */ (el.querySelector(".area-pt"));
    ln.style.left = `${(fx * 100).toFixed(3)}%`;
    dot.style.left = `${(fx * 100).toFixed(3)}%`;
    dot.style.top = `${y.toFixed(1)}px`;
    this._areaHover = { id, x: clientX };
    const day = new Date(pt * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    this.tip.showAt(r.left + fx * r.width, r.top + y, `${day}\n${amount(pv, 0)} ${a.unit}`);
  }

  areaLeave() {
    if (this._areaOpen) this.content.querySelector(`[data-area-wrap="${CSS.escape(this._areaOpen)}"]`)?.classList.remove("open");
    this._areaOpen = null;
    if (!this._areaHover) return;
    this.content.querySelector(`[data-area="${CSS.escape(this._areaHover.id)}"]`)?.classList.remove("hov");
    this._areaHover = null;
    this.tip.hide();
  }

  /* ---------------- Uniswap ---------------- */

  uniData() { return this.env("uniswap")?.data; }

  pairLogos(p, cls = "") {
    const a = p.cv?.symbol, b = p.counter?.symbol;
    const [x, y] = a ? [a, b] : p.label.split("/");
    return `<span class="pair ${cls}">${logo(this.logos.tokens?.[x], x, cls)}${logo(this.logos.tokens?.[y], y, cls)}</span>`;
  }

  pairName(p) { return esc(p.label.replace("/", " / ")); }

  feeTag(p) {
    if (p.dynamicFee) return `<span class="tag"${tipAttr("Dynamic fee set by the hook")}>dyn. fee</span>`;
    return p.feePct != null ? `<span class="tag">${esc(nf(2).format(p.feePct))}%</span>` : "";
  }

  /** Version tag, plus a hooks tag for v4 pools with a hook. */
  versionTags(p) {
    const v = `<span class="tag">${esc(p.version || "v3")}</span>`;
    return p.hooks ? `${v}<span class="tag"${tipAttr(`Hook contract ${p.hooks}\nThe hook can change fees or pricing: depth and impact assume a plain pool.`)}>hooks</span>` : v;
  }

  /** Uniswap app link of a pool (v2/v3: address, v4: pool id). */
  poolUrl(p) {
    const C = this.app.config.uniswap;
    return `${C.appUrl}/explore/pools/${C.chain === "ethereum" ? "ethereum" : C.chain}/${p.address}`;
  }

  /** Oracle reference under a price: what the peg price is made of. part: "peg" | "oracles" | both. */
  pegRef(p, d, part) {
    if (!p.ready) return "";
    const C = this.app.config.uniswap;
    const pegSpec = C.peg?.[p.cv.symbol], ctSpec = C.usdValue?.[p.counter.symbol];
    const peg = `Peg ${fmtP(p.pegPrice)} ${esc(p.counter.symbol)}`;
    const ora = [];
    if (pegSpec === ctSpec) ora.push(`1 ${esc(p.counter.symbol)} = 1 ${esc(this.app.config.tokens[p.cv.symbol]?.currency || "")}`);
    else for (const spec of [pegSpec, ctSpec]) {
      if (typeof spec !== "string") continue;
      const o = d?.oracles?.[spec];
      ora.push(`${esc((o?.label || spec).replace(/^Chainlink /, ""))} ${o ? nf(5, 5).format(o.value) : DASH}`);
    }
    return part === "peg" ? peg : part === "oracles" ? ora.join(DOT) : [peg, ...ora].join(DOT);
  }

  pegTip(p, d) {
    if (!p.ready || p.deviation == null) return "Peg deviation: waiting for the pool price and the oracles.";
    const C = this.app.config.uniswap;
    const [g, r] = d?.thresholdsBps || [10, 50];
    const lines = [`Pool price ${fmtP(p.price, 6)} ${p.counter.symbol} per ${p.cv.symbol}`, `Peg price ${fmtP(p.pegPrice, 6)} ${p.counter.symbol}`,
      `Deviation = pool price x USD value of ${p.counter.symbol} / peg of ${p.cv.symbol} - 1`];
    for (const spec of new Set([C.peg?.[p.cv.symbol], C.usdValue?.[p.counter.symbol]])) {
      if (typeof spec !== "string") { if (spec != null) lines.push(`Fixed value: ${spec} USD`); continue; }
      const o = d?.oracles?.[spec];
      if (o) lines.push(`${o.label} ${o.value}${DOT}updated ${age(o.updatedAt * 1000)}${o.fallback ? `\n  fallback: ${o.reason}` : ""}`);
    }
    lines.push(`Green below ${g} bps, amber ${g}-${r}, red above ${r}.`);
    return lines.join("\n");
  }

  pegBadge(p, d) {
    const bps = p.deviationBps;
    const [g, r] = d?.thresholdsBps || [10, 50];
    const a = bps == null ? null : Math.abs(bps);
    const cls = a == null ? "" : a < g ? "ok" : a <= r ? "warn" : "bad";
    return `<span class="peg ${cls}"${tipAttr(this.pegTip(p, d))}><i></i>${bps == null ? DASH : `${bps >= 0 ? "+" : "\u2212"}${nf(1, 1).format(a)} bps`}</span>`;
  }

  composition(p) {
    if (!p.ready) return `<div class="comp"><div class="comp-bar"></div></div>`;
    const [c, t] = p.composition;
    const w = (x) => `${((x.share || 0) * 100).toFixed(2)}%`;
    const tip = (x) => `${x.symbol}: ${amount(x.amount, 0)} (${usd(x.usd)})`;
    return `<div class="comp"${tipAttr(`Balances held by the pool, valued with the oracles\n${tip(c)}\n${tip(t)}`)}>
      <div class="comp-bar"><span class="c-cv" style="width:${w(c)}"></span><span class="c-ct" style="width:${w(t)}"></span></div>
      <div class="comp-legend"><span><i class="c-cv"></i>${esc(c.symbol)} ${compact(c.amount)}<b>${pct(c.share, 1)}</b></span><span><i class="c-ct"></i>${esc(t.symbol)} ${compact(t.amount)}<b>${pct(t.share, 1)}</b></span></div>
    </div>`;
  }

  tvlTip(d) {
    const C = this.app.config.uniswap;
    const val = Object.entries(C.usdValue || {}).map(([s, spec]) => `${s} ${typeof spec === "number" ? `= ${spec} USD` : `at ${d?.oracles?.[spec]?.label || spec}`}`).join(", ");
    return `Sum over the ${C.pools.length} pools of the tokens each pool holds (balanceOf, on-chain), valued with the oracles: ${val}.`;
  }

  uniswap() {
    if (this.sub) return this.uniswapPool(this.sub);
    const d = this.uniData();
    const pools = d?.pools || this.app.config.uniswap.pools.map((p) => ({ ...p, ready: false }));
    const kpiPartial = (x) => (x ? `<span class="err-dot"${tipAttr("Partial: at least one pool could not be read.")}></span>` : "");
    const n = pools.length;
    const card = (p) => ({ id: `uni.pool.${p.slug}`, label: p.label.replace("/", " / "), w: n >= 3 ? 4 : 12 / n, minPx: 300, minH: 160, body: `<a class="card pool-card" href="#/defi/uniswap/${esc(p.slug)}">
        <div class="pc-head">${this.pairLogos(p)}<span class="pc-name">${this.pairName(p)}</span>${this.feeTag(p)}${this.versionTags(p)}${this.pegBadge(p, d)}</div>
        <div class="pc-price">${p.ready ? fmtP(p.price) : DASH}<small>${p.ready ? `${esc(p.counter.symbol)} per ${esc(p.cv.symbol)}` : ""}</small></div>
        <div class="pc-ref">${this.pegRef(p, d) || "&nbsp;"}</div>
        <div class="pc-metrics"><div><span>TVL</span><b>${usdC(p.tvlUsd)}</b></div><div><span>Volume 24h</span><b>${usdC(p.volumeUsd24h)}</b></div></div>
        ${this.composition(p)}
      </a>` });
    return this.gridPage("uniswap", this.sources(this.app.config.aggregators ? ["uniswap", "aggregators"] : ["uniswap"]), [
      { id: "uni.tvl", label: "TVL of the pools", w: 6, minPx: 150, minH: 100, body: `<div class="card card-body"><div class="kpi-label">TVL of the pools<span class="tip-i"${tipAttr(this.tvlTip(d))}>${icon("info")}</span></div><div class="kpi">${d ? usd(d.totals.tvlUsd) : DASH}${kpiPartial(d?.totals.tvlPartial)}</div></div>` },
      { id: "uni.volume", label: "Volume 24h", w: 6, minPx: 150, minH: 100, body: `<div class="card card-body"><div class="kpi-label">Volume 24h<span class="tip-i"${tipAttr("Sum of the 24 h volume of the pools, in USD, from GeckoTerminal (CoinGecko's DEX API), refreshed every minute.")}>${icon("info")}</span></div><div class="kpi">${d ? usd(d.totals.volumeUsd24h) : DASH}${kpiPartial(d?.totals.volumePartial)}</div></div>` },
      ...pools.map(card),
      ...this.aggregatorsWidgets(),
    ]);
  }

  /* ---------------- Uniswap: aggregators ---------------- */

  /** Period shown by the Aggregators section ("24h" | "7d" | "<historyDays>d"), kept per browser. */
  aggPeriod(keys) {
    let p = this._aggPeriod;
    if (!p) { try { p = localStorage.getItem("cv:v1:aggperiod") || ""; } catch { p = ""; } }
    if (!keys.includes(p)) p = keys[keys.length - 1];
    this._aggPeriod = p;
    return p;
  }

  /** UI settings of the section kept per browser: chart venue / grouping, trades filters. */
  aggPref(key, allowed, def) {
    const k = `_agg_${key}`;
    if (this[k] == null) { let v = def; try { v = localStorage.getItem(`cv:v1:agg${key}`) ?? def; } catch { /* ignore */ } this[k] = v; }
    if (!allowed.includes(this[k])) this[k] = def;
    return this[k];
  }

  setAggPref(key, v) {
    this[`_agg_${key}`] = v;
    try { localStorage.setItem(`cv:v1:agg${key}`, v); } catch { /* ignore */ }
    this.tip?.hide();
    this.render();
  }

  /** Aggregator meta for the UI: label, colour (config order), plus the "other contracts" bucket in grey. */
  aggMeta() {
    const list = this.app.config.aggregators?.list || [];
    const m = Object.fromEntries(list.map((g, i) => [g.id, { id: g.id, label: g.label || g.id, color: `var(--s${(i % 8) + 1})`, layer: g.layer ?? 2 }]));
    m[AGG_OTHER] = { id: AGG_OTHER, label: "Other contracts", color: "var(--bar-ct)", layer: 2 };
    return m;
  }

  aggLogo(id, cls = "") {
    const m = this.aggMeta()[id];
    return logo(this.logos.aggregators?.[id], m?.label || id, cls);
  }

  /** Legend lines that partition `total` (at most 4, the rest summed). */
  aggLegend(caption, lines, total, loading) {
    if (!total) return `<div class="agg-legend"><span class="agg-empty">${loading ? "Loading\u2026" : "No trade in this period"}</span></div>`;
    lines = lines.filter((x) => x.v > 0.5).sort((x, y) => y.v - x.v);
    const shown = lines.length > 4 ? lines.slice(0, 3) : lines;
    const rest = lines.slice(shown.length);
    if (rest.length) shown.push({ label: `${rest.length} more`, v: rest.reduce((x, l) => x + l.v, 0), color: "var(--bar-ct)", tip: rest.map((l) => `${l.label}: ${amount(l.v, 0)}`).join("\n") });
    const line = (l) => `<span${tipAttr(l.tip)}><i style="background:${l.color}"></i><em>${esc(l.label)}</em><b>${compact1(l.v)}</b><small>${pct(l.v / total, 0)}</small></span>`;
    return `<div class="agg-legend"><div class="agg-cap">${esc(caption)}</div>${shown.map(line).join("")}</div>`;
  }

  /** RFQ / our pools executed, side by side, then the split bar. */
  aggVenues(a, color, wait, poolsTip) {
    const tok = esc(this.app.config.aggregators.token);
    const tot = a ? a.rfq + a.pools + a.other : 0;
    const v = (x) => (wait ? `<span class="subtle">\u2026</span>` : `${compact1(x)}<small>${tok}</small>`);
    const w = (x) => `${tot ? ((x / tot) * 100).toFixed(2) : 0}%`;
    const other = a?.other > 0.5 ? `<span class="agg-vo"${tipAttr("Non-whitelisted pools (Curve, other Uniswap pools...).")}>+ ${compact1(a.other)} in other pools</span>` : "";
    return `<div class="agg-kpis">
        <div${tipAttr("Traded with market makers, outside any pool.\nExtra volume.")}><span><i style="background:${color}"></i>RFQ</span><b>${v(a?.rfq || 0)}</b></div>
        <div class="pool"${tipAttr(poolsTip || "Traded in our pools.\nAlready in their volume: not added.")}><span><i class="c-ct"></i>Our pools</span><b>${v(a?.pools || 0)}</b></div>
      </div>
      <div class="comp-bar agg-vbar"><span style="width:${w(a?.rfq || 0)};background:${color}"></span><span class="c-ct" style="width:${w(a?.pools || 0)}"></span>${a?.other ? `<span style="width:${w(a.other)};background:var(--muted-foreground)"></span>` : ""}</div>${other}`;
  }

  /** Foot: pivot share, tokens against. */
  aggFoot(a) {
    const tot = a ? a.rfq + a.pools + a.other : 0;
    const S = a?.sides || {};
    const pivotTip = `EURCV only used as a pivot (USDC \u2192 EURCV \u2192 EURC).${tot ? `\nSells ${pct(S.sell / tot, 0)}${DOT}buys ${pct(S.buy / tot, 0)}${DOT}pivot ${pct(S.pivot / tot, 0)}` : ""}`;
    const list = Object.entries(a?.counters || {}).sort((x, y) => y[1] - x[1]);
    const ctTip = `Traded against EURCV:\n${list.slice(0, 6).map(([s2, x]) => `${s2}: ${compact1(x)}`).join("\n") || "none"}`;
    return `<div class="agg-foot"><div class="pc-metrics">
        <div><span>EURCV as pivot</span><b${tipAttr(pivotTip)}>${tot ? pct(S.pivot / tot, 0) : DASH}</b></div>
        <div><span>Against</span><b class="agg-ct"${tipAttr(ctTip)}>${list.length ? esc(list.slice(0, 2).map(([x]) => x).join(", ")) : DASH}</b></div></div></div>`;
  }

  /** Aggregators section as three widgets: the cards (with the period switch), the daily chart, the latest trades. */
  aggregatorsWidgets() {
    const C = this.app.config.aggregators;
    if (!C) return [];
    const env = this.env("aggregators"), d = env?.data;
    const M = this.aggMeta();
    const days = aggDays(C);
    const keys = aggPeriods(days).map(([k]) => k);
    const per = this.aggPeriod(keys);
    const P = d?.periods?.[per];
    const H = d?.history;
    const loadedDays = H ? Math.min(days, H.coveredSec / 86400) : 0;
    const wait = !P || !P.total || (!P.complete && !!H?.loading);
    const check = d && d.check === false ? `<span class="err-dot warn"${tipAttr("Totals do not add up: see Diagnostics.")}></span>` : "";
    const status = !H ? `<span class="agg-note">Loading\u2026</span>`
      : H.status === "error" ? `<span class="agg-note"><span class="err-dot"${tipAttr(`${H.error || "error"}\nRetried every minute.`)}></span> history error</span>`
      : loadedDays < days - 0.05 ? `<span class="agg-note"${tipAttr(`Read on-chain, kept in this browser.\nMax ${days} days (config historyDays).`)}>history ${nf(loadedDays < 1 ? 1 : 0).format(loadedDays)} / ${days} days${H.loading ? "\u2026" : ""}</span>` : "";
    const seg = `<div class="seg">${keys.map((k) => `<a role="button" data-aggp="${esc(k)}"${k === per ? ' class="on"' : ""}>${esc(k)}</a>`).join("")}</div>`;
    const info = "Two venues: RFQ (extra volume) and our pools (already in their volume). Never added.\nEach EURCV counted once, under the aggregator that executed it.";
    const sub = `EURCV traded through DEX aggregators${DOT}${esc(this.app.config.chains[C.chain]?.label || "")}<span class="tip-i agg-i"${tipAttr(info)}>${icon("info")}</span>${check}`;

    const T = P?.total;
    // share of the EURCV pools' 24 h volume (GeckoTerminal, USD), 24 h only
    let poolsTip = "Traded in our pools.\nAlready in their volume: not added.";
    if (T?.pivotPools) poolsTip += `\nPivot: ${compact1(T.pivotPools)}`;
    if (per === "24h" && T?.pools) {
      const u = this.uniData();
      const eur = u?.oracles?.EURUSD?.value;
      const volUsd = (u?.pools || []).filter((p) => p.cv?.symbol === C.token && p.volumeUsd24h != null).reduce((x, p) => x + p.volumeUsd24h, 0);
      if (eur && volUsd) poolsTip += `\n\u2248 ${pct(Math.min(1, (T.pools * eur) / volUsd), 0)} of the pools' 24h volume`;
    }
    const totT = T ? T.rfq + T.pools + T.other : 0;
    const execLines = T ? Object.entries(T.byExec).map(([id, o]) => ({ label: M[id]?.label || id, color: M[id]?.color, v: o.rfq + o.pools + o.other,
      tip: `${id === AGG_OTHER ? "Executed by untracked contracts" : `Executed by ${M[id]?.label || id}`}\nRFQ ${compact1(o.rfq)}${DOT}pools ${compact1(o.pools)}` })) : [];
    const totalCard = `<div class="card card-body agg-card agg-total">
        <div class="agg-head"><span class="logo">${icon("swap")}</span><span>All aggregators</span><span class="agg-n">${T && !wait ? `${num(T.n)} trades` : ""}</span></div>
        ${this.aggVenues(T, "var(--primary)", wait, poolsTip)}
        ${this.aggLegend("Executed by", execLines, totT, wait)}
        ${this.aggFoot(T)}
      </div>`;
    const cards = C.list.map((g) => {
      const a = P?.aggs?.[g.id];
      const me = M[g.id];
      const tot = a ? a.rfq + a.pools + a.other : 0;
      const origin = a ? Object.entries(a.origin).map(([k, o]) => {
        const [kind, from] = k.includes(":") ? k.split(":") : [k, ""];
        const vv = o.rfq + o.pools + o.other;
        const tip = kind === "direct" ? `Sent to ${me.label} directly` : kind === "ext" ? "Sent by an untracked contract" : `Brought by ${M[from]?.label || from}`;
        return { label: kind === "direct" ? "Direct" : kind === "ext" ? "Other contracts" : `Via ${M[from]?.label || from}`, color: kind === "direct" ? me.color : kind === "ext" ? "var(--bar-ct)" : M[from]?.color, v: vv, tip: `${tip}\n${amount(vv, 0)} EURCV${DOT}${o.n} trade${o.n === 1 ? "" : "s"}` };
      }) : [];
      const dlg = a ? Object.entries(a.delegated).map(([id, o]) => ({ id, ...o })).filter((o) => o.rfq + o.pools + o.other > 0.5).sort((x, y) => (y.rfq + y.pools) - (x.rfq + x.pools)) : [];
      const passed = !wait && dlg.length ? `<div class="agg-pass">${dlg.slice(0, 2).map((o) => {
        const parts = [o.rfq > 0.5 ? `${compact1(o.rfq)} RFQ` : "", o.pools > 0.5 ? `${compact1(o.pools)} pools` : ""].filter(Boolean).join(" + ");
        return `<span${tipAttr(`Passed on to ${M[o.id]?.label || o.id}.\nCounted in its card, not here.`)}>\u2192 ${esc(M[o.id]?.label || o.id)}: ${parts}</span>`;
      }).join("")}</div>` : "";
      return `<div class="card card-body agg-card${a && !a.n && !dlg.length ? " idle" : ""}">
        <div class="agg-head">${this.aggLogo(g.id)}<span>${esc(me.label)}</span><span class="agg-n"${tipAttr("Trades it executed")}>${a && !wait ? `${num(a.n)} trade${a.n === 1 ? "" : "s"}` : ""}</span></div>
        ${this.aggVenues(a, me.color, wait)}
        ${this.aggLegend("Origin", origin, tot, wait)}${passed}
        ${this.aggFoot(a)}
      </div>`;
    }).join("");

    const tr = this.aggTrades(d);
    return [
      { id: "agg.cards", label: "Aggregators", w: 12, minPx: 300, minH: 220, title: "Aggregators", sub, tools: `<div class="sec-tools">${status}${seg}</div>`,
        body: `<div class="grid g4 agg-cards">${totalCard}${cards}</div>` },
      { id: "agg.chart", label: "Daily volume", w: 12, minPx: 420, minH: 200, body: this.aggChart(d) },
      { id: "agg.trades", label: "Latest trades", w: 12, minPx: 560, minH: 200, title: "Latest trades", sub: tr.sub, tools: tr.tools, body: tr.body },
    ];
  }

  /** Daily volume, each leg once: RFQ or our pools, grouped by executor or by entry. */
  aggChart(d) {
    const C = this.app.config.aggregators, M = this.aggMeta();
    const venue = this.aggPref("venue", ["rfq", "pools"], "rfq");
    const group = this.aggPref("group", ["exec", "entry"], "exec");
    const D = d?.daily;
    const sg = (k, val, label, tip, cur) => `<a role="button" data-aggset="${k}" data-v="${val}"${val === cur ? ' class="on"' : ""}${tipAttr(tip)}>${label}</a>`;
    const tools = `<div class="seg">${sg("venue", "rfq", "RFQ", "Extra volume", venue)}${sg("venue", "pools", "Our pools", "Already in the pools' volume", venue)}</div>
      <div class="seg">${sg("group", "exec", "Executed by", "Who made the trade", group)}${sg("group", "entry", "Brought by", "Who sent the trader", group)}</div>`;
    const keys = [...C.list.map((g) => g.id), AGG_OTHER];
    const days = D?.days || aggDays(C);
    const series = D?.[group]?.[venue];
    const ids = series ? keys.filter((id) => series[id]?.some((x) => x > 0.5)) : [];
    const legend = `<span class="legend lc-legend">${ids.map((id) => `<span><i style="background:${M[id].color}"></i>${esc(M[id].label)}</span>`).join("")}</span>`;
    const head = `<div class="chart-head"><span class="chart-title">Daily ${venue === "rfq" ? "RFQ" : "pool"} volume<span class="muted">${esc(C.token)}${DOT}${group === "exec" ? "by executor" : "by entry"}</span></span>${legend}<span class="zoom">${tools}</span></div>`;
    if (!series) return `<div class="card chart-card agg-chart">${head}<div class="area-ph short">Loading\u2026</div></div>`;
    const totals = Array.from({ length: D.days }, (_, i) => ids.reduce((x, id) => x + series[id][i], 0));
    const max = Math.max(...totals, 1e-9);
    const hi = max * 1.08;
    const H = 180, VW = 1000, top = 6, bw = VW / D.days, gap = Math.min(D.days <= 10 ? 40 : 6, bw * 0.25);
    const Y = (v) => top + (1 - v / hi) * (H - top);
    const firstDay = d.history?.coveredSec ? Math.floor((Date.now() / 1000 - d.history.coveredSec) / 86400) * 86400 : Infinity;
    const bars = totals.map((tot, i) => {
      const t = D.day0 + i * 86400;
      const x = i * bw + gap / 2, w = bw - gap;
      const day = new Date(t * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      if (t + 86400 <= firstDay) return `<g class="bar"${tipAttr(`${day}: not loaded yet`)}><rect class="gap" x="${x.toFixed(1)}" y="${top}" width="${w.toFixed(1)}" height="${H - top}"/></g>`;
      let y = H;
      const rects = ids.map((id) => {
        const v = series[id][i];
        if (!(v > 0)) return "";
        const h = (v / hi) * (H - top);
        y -= h;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" style="fill:${M[id].color}"/>`;
      }).join("");
      const rows = ids.filter((id) => series[id][i] > 0.5).sort((a, b) => series[b][i] - series[a][i]).map((id) => `${M[id].label}: ${compact1(series[id][i])}`);
      return `<g class="bar"${tipAttr(`${day}${i === D.days - 1 ? " (so far)" : ""}${DOT}total ${compact1(tot)}\n${rows.join("\n")}`)}><rect class="hit" x="${(i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}"/>${rects}</g>`;
    }).join("");
    const gridL = [0, 0.5, 1].map((f) => { const y = Y(max * f).toFixed(1); return `<line class="lc-grid" x1="0" x2="${VW}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`; }).join("");
    const ticks = [0, 0.5, 1].map((f) => `<span class="lc-y" style="top:${Y(max * f).toFixed(1)}px">${esc(max * f > 1e-6 ? compact1(max * f) : "0")}</span>`).join("");
    const fmtD = (t) => new Date(t * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    return `<div class="card chart-card agg-chart">${head}
      <div class="cw-chart-body"><div class="bc" style="height:${H}px" role="img" aria-label="Daily volume through aggregators">
        <svg viewBox="0 0 ${VW} ${H}" preserveAspectRatio="none" height="${H}" aria-hidden="true">${gridL}${bars}</svg>${ticks}</div>
        <div class="area-foot bc-foot"><span>${esc(fmtD(D.day0))}</span><span>Each EURCV counted once${DOT}UTC days</span><span>Today</span></div></div></div>`;
  }

  /** Latest trades, newest first, filterable by aggregator and by venue. */
  aggTrades(d) {
    const C = this.app.config.aggregators, M = this.aggMeta();
    const U = this.app.config.uniswap;
    const f = this.aggPref("filter", ["", ...C.list.map((g) => g.id)], "");
    const fv = this.aggPref("fvenue", ["", "r", "p", "pivot"], "");
    const touches = (t, id) => t.e === id || t.s.includes(id) || (t.lg || []).some((l) => l[2] === id);
    const venueOk = (t) => !fv || (fv === "pivot" ? t.side === "route" : (t.lg || []).some((l) => l[0] === fv));
    const rows = (d?.trades || []).filter((t) => (!f || touches(t, f)) && venueOk(t)).slice(0, C.tradesShown || 50);
    const tok = C.token;
    // filter menus in the DA (same component as the Coinwatch Trading pairs filters)
    const sels = this.ddMenu("filter", "Aggregator", "All aggregators", C.list.map((g) => ({ v: g.id, t: M[g.id].label, lg: this.aggLogo(g.id) })), f, null, "agg")
      + this.ddMenu("fvenue", "Executed on", "All venues", [{ v: "r", t: "RFQ" }, { v: "p", t: "Our pools" }, { v: "pivot", t: "Pivot trades" }], fv, null, "agg");
    const sideCell = (t) => t.side === "buy" ? `<span class="mint">Buy</span>` : t.side === "sell" ? `<span class="burn">Sell</span>`
      : t.side === "mixed" ? `<span>Buy + sell</span>`
      : t.side === "route" ? `<span class="hover"${tipAttr("EURCV only used as a pivot")}>Pivot</span>`
      : `<span class="subtle"${tipAttr("Trader not identified")}>${DASH}</span>`;
    const pairCell = (t) => {
      const ct = t.cts ? esc(t.cts) : null;
      if (t.side === "sell" && ct) return `${esc(tok)} \u2192 ${ct}`;
      if (t.side === "buy" && ct) return `${ct} \u2192 ${esc(tok)}`;
      if (t.side === "mixed" && ct) return `${esc(tok)} \u2194 ${ct}`;
      if (t.side === "route" && t.rps && (t.rps[0] || t.rps[1])) return `${esc(t.rps[0] || "?")} \u2192 ${esc(t.rps[1] || "?")}<span class="two">${esc(tok)} as pivot</span>`;
      return `<span class="subtle">${DASH}</span>`;
    };
    const routeCell = (t) => {
      const src = t.s.map((id) => `<span class="cell">${this.aggLogo(id)}<span>${esc(M[id]?.label || id)}</span></span>`).join(`<span class="subtle agg-arrow">\u2192</span>`);
      const ext = t.x ? `<span class="two">sent by ${this.addrLink(C.chain, t.x, this.app.labels.resolve(C.chain, t.x).label)}</span>` : "";
      return `<span class="agg-route"><span class="cell">${this.aggLogo(t.e)}<span>${esc(M[t.e]?.label || t.e)}</span></span>${src ? `<span class="subtle agg-arrow">\u2192</span>${src}` : ""}</span>${ext}`;
    };
    const name = (slug) => U.pools.find((p) => p.slug === slug)?.label || slug;
    const venueCell = (t) => (t.lg || []).map(([k, v, ex, ref]) => {
      const who = M[ex || AGG_OTHER]?.label || ex;
      const label = k === "r" ? "RFQ" : k === "p" ? `Pool ${name(ref)}` : "Other pool";
      const tip = k === "r" ? `Market maker${ref ? ` ${shortHex(ref)}` : ""}` : k === "p" ? "Already in the pool's volume" : shortHex(ref || "");
      return `<span class="agg-tv${k === "p" ? " pool" : ""}"${tipAttr(tip)}><i style="background:${k === "r" ? M[ex || AGG_OTHER]?.color : k === "p" ? "var(--bar-ct)" : "var(--muted-foreground)"}"></i>${esc(label)} ${amount(v, 0)}<em>${esc(who)}</em></span>`;
    }).join("") || `<span class="subtle">${DASH}</span>`;
    const body = rows.map((t) => `<tr class="tall"><td>${dateTime(t.t)}</td><td>${routeCell(t)}</td><td>${sideCell(t)}</td>
        <td class="r num">${amount(t.v, 0)}</td><td>${pairCell(t)}</td><td class="agg-venue">${venueCell(t)}</td><td>${this.txLink(C.chain, t.h)}</td></tr>`).join("");
    const empty = !d ? "Loading\u2026" : d.history?.loading ? "Reading the history\u2026" : "No trade matches";
    return { sub: rows.length ? `${rows.length} newest` : "", tools: `<div class="sec-tools">${sels}</div>`,
      body: `<div class="card"><div class="tbl list" data-keep="aggtrades"><table>
        <thead><tr><th>Date</th><th>Route</th><th>Type</th><th class="r"${tipAttr("EURCV of the trader (pivot: EURCV routed)")}>Amount (${esc(tok)})</th><th>Pair</th><th${tipAttr("Venue, amount, executor")}>Executed on</th><th>Tx</th></tr></thead>
        <tbody>${body || this.waiting(7, empty)}</tbody></table></div></div>` };
  }

  uniswapPool(slug) {
    const d = this.uniData();
    const cfgPools = this.app.config.uniswap.pools;
    const p = d?.pools.find((x) => x.slug === slug) || { ...cfgPools.find((x) => x.slug === slug), ready: false };
    const C = this.app.config.uniswap;
    const chain = this.app.config.chains[C.chain];
    const nav = `<div class="pool-nav">
        <a class="btn" href="#/defi/uniswap">${icon("back")}All pools</a>
        <div class="seg">${cfgPools.map((x) => `<a href="#/defi/uniswap/${esc(x.slug)}"${x.slug === slug ? ' class="on"' : ""}>${esc(x.label.replace("/", " / "))}</a>`).join("")}</div>
        <span class="links"><a class="link" href="${esc(this.poolUrl(p))}" target="_blank" rel="noopener"${tipAttr(p.address)}>Uniswap${icon("ext", "ext")}</a>${p.version === "v4" ? "" : `<a class="link" href="${esc(chain.explorer.address + p.address)}" target="_blank" rel="noopener"${tipAttr(p.address)}>Etherscan${icon("ext", "ext")}</a>`}</span>
      </div>`;
    const metric = (label, value, sub, tip) => `<div class="ph-m"><div class="mv-label">${esc(label)}</div><div class="mv-value"${tipAttr(tip)}>${value}</div>${sub ? `<div class="mv-sub">${sub}</div>` : ""}</div>`;
    const hero = { id: "pool.hero", label: "Pool", w: 12, minPx: 420, minH: 160, body: `<div class="card pool-hero">
        <div class="ph-head">${this.pairLogos(p, "xl")}<span class="link big">${this.pairName(p)}</span>${this.feeTag(p)}${this.versionTags(p)}</div>
        <div class="ph-metrics">
          ${metric("Price", p.ready ? fmtP(p.price) : DASH, p.ready ? `${esc(p.counter.symbol)} per ${esc(p.cv.symbol)}${DOT}peg ${fmtP(p.pegPrice)}` : "", "")}
          ${metric("Peg deviation", this.pegBadge(p, d), this.pegRef(p, d, "oracles"), "")}
          ${metric("TVL", usdC(p.tvlUsd), p.balancesFromLiquidity ? "liquidity x oracles" : "on-chain balances x oracles", p.balancesFromLiquidity ? "v4 pools have no balance of their own: amounts computed from the liquidity of each tick range (fees not yet collected excluded), valued with the oracles." : this.tvlTip(d))}
          ${metric("Volume 24h", usdC(p.volumeUsd24h), "GeckoTerminal", "")}
        </div>
        <div class="hero-comp">${this.composition(p)}</div>
      </div>` };
    if (!p.ready) return this.gridPage("pool", `${this.sources(["uniswap"])}${nav}`, [hero]);
    const approx = !p.ticksComplete ? `<span class="err-dot"${tipAttr("The tick map could not be fully read at this block: values are approximate.")}></span>`
      : p.hooks || p.dynamicFee ? `<span class="err-dot warn"${tipAttr("Pool with a hook / dynamic fee: computed as a plain pool, the hook may change the result.")}></span>` : "";
    const cv = esc(p.cv.symbol), ct = esc(p.counter.symbol);

    const depthRows = p.depth.map((x) => `<tr class="tall"><td class="num">\u00b1${x.bps} bps</td>
        <td class="r"><span class="num">${amount(x.sell.amount, 0)} ${cv}</span><span class="two">${usd(x.sell.usd)}${x.sell.drained ? `${DOT}all liquidity` : ""}</span></td>
        <td class="r"><span class="num">${amount(x.buy.amount, 0)} ${cv}</span><span class="two">for ${amount(x.buy.cost, 0)} ${ct}${x.buy.drained ? `${DOT}all liquidity` : ""}</span></td></tr>`).join("");
    const impactRows = p.impact.map((x) => x.exceeds
      ? `<tr class="tall"><td class="num">${compactInt(x.size)} ${cv}</td><td colspan="3" class="r"><span class="warn-txt"${tipAttr(`Selling more than ~${amount(x.max, 0)} ${p.cv.symbol} uses up all the ${p.counter.symbol} of the pool (~${amount(x.maxOut, 0)} ${p.counter.symbol}).`)}>Exceeds the pool (max \u2248 ${compact(x.max)} ${cv})</span></td></tr>`
      : `<tr class="tall"><td class="num">${compactInt(x.size)} ${cv}</td>
          <td class="r"><span class="num">${amount(x.out, 2, 2)} ${ct}</span><span class="two">${usd(x.usd)}</span></td>
          <td class="r">${fmtP(x.avgPrice)}</td>
          <td class="r"><span class="num ${Math.abs(x.impact) * 1e4 > (d?.thresholdsBps?.[1] ?? 50) ? "warn-txt" : ""}"${tipAttr(`Average price vs pool price, fee included.\nPrice after the sale: ${fmtP(x.priceAfter)} (${bpsTxt(x.moveAfter)})`)}>${bpsTxt(x.impact)}</span></td></tr>`).join("");

    const h = d.history;
    const appUrl = C.appUrl;
    const posRows = p.positions.map((q) => {
      const label = this.app.labels.resolve(C.chain, q.owner).label;
      const pos = q.kind === "nft" ? `<a class="link" href="${esc(`${appUrl}/positions/${p.version}/ethereum/${q.tokenId}`)}" target="_blank" rel="noopener"${tipAttr("NFT position (position manager)")}>#${esc(q.tokenId)}${icon("ext", "ext")}</a>`
        : q.kind === "lp" ? `<span class="hover"${tipAttr("Holder of the pair's LP token (v2): owns this share of the reserves")}>LP token</span>`
        : q.kind === "direct" ? `<span class="hover"${tipAttr("Minted directly on the pool by this contract (no NFT)")}>Direct</span>`
        : `<span class="subtle"${tipAttr("NFT liquidity whose id is still being resolved")}>NFT\u2026</span>`;
      return `<tr class="tall"><td>${this.addrLink(C.chain, q.owner, label)}</td><td>${pos}</td>
        <td>${q.fullRange ? `<span class="num">Full range</span><span class="two">0 \u2013 \u221e</span>` : `<span class="num">${fmtP(q.priceLower)} \u2013 ${fmtP(q.priceUpper)}</span><span class="two">ticks ${q.tickLower} / ${q.tickUpper}</span>`}</td>
        <td>${q.inRange ? `<span class="state ok"><i></i>In range</span>` : `<span class="state"><i></i>Out of range</span>`}</td>
        <td class="r">${amount(q.amountCv, 0)}</td><td class="r">${amount(q.amountCounter, 0)}</td><td class="r num">${amount(q.valueCv, 0)}</td>
        <td class="r"><span class="meter"><span class="track"><span style="width:${(q.shareActive * 100).toFixed(2)}%"></span></span><span class="w">${pct(q.shareActive, 1)}</span></span></td></tr>`;
    }).join("");
    const posEmpty = h.status === "error" ? `History unavailable${DOT}${h.error || ""}` : h.status === "pending" ? "Loading the LP history\u2026" : "No open position";
    const posNote = h.status === "stale" ? `<span class="err-dot"${tipAttr(`History not updated since ${age(h.at)}: ${h.error || ""}`)}></span>` : "";

    return this.gridPage("pool", `${this.sources(["uniswap"])}${nav}`, [hero,
      { id: "pool.liquidity", label: "Liquidity distribution", w: 12, minPx: 420, minH: 240, body: `<div class="card chart-card">
        <div class="chart-head"><span class="chart-title">Liquidity distribution${approx}</span>
          <span class="legend"><span><i class="c-cv"></i>${cv}</span><span><i class="c-ct"></i>${ct}</span><span><i class="ln cur"></i>Current</span><span><i class="ln peg"></i>Peg</span></span>
          <span class="zoom"><span class="subtle hint">Scroll to zoom${DOT}drag to pan</span>
            <button class="icon-btn sm" data-zoom="out" data-slug="${esc(slug)}"${tipAttr("Zoom out")}>${icon("zoomOut")}</button>
            <button class="icon-btn sm" data-zoom="in" data-slug="${esc(slug)}"${tipAttr("Zoom in")}>${icon("zoomIn")}</button>
            <button class="icon-btn sm" data-zoom="reset" data-slug="${esc(slug)}"${tipAttr("Reset view")}>${icon("reset")}</button></span></div>
        <div class="chart" data-chart="${esc(slug)}"></div>
      </div>` },
      { id: "pool.depth", label: "Depth", w: 6, minPx: 380, minH: 160, title: "Depth", sub: `amount that moves the price${approx}`,
        body: `<div class="card"><div class="tbl"><table><thead><tr><th>Band</th><th class="r">Sell ${cv} (price \u2212)</th><th class="r">Buy ${cv} (price +)</th></tr></thead><tbody>${depthRows}</tbody></table></div></div>` },
      { id: "pool.impact", label: "Sale impact", w: 6, minPx: 380, minH: 160, title: "Sale impact", sub: `selling ${cv} for ${ct}, fee included${approx}`,
        body: `<div class="card"><div class="tbl"><table><thead><tr><th>Sale</th><th class="r">Receive</th><th class="r">Avg price</th><th class="r">Impact</th></tr></thead><tbody>${impactRows}</tbody></table></div></div>` },
      { id: "pool.lp", label: "LP positions", w: 12, minPx: 560, minH: 200, title: "LP positions", sub: `${p.positions.length || ""} open${posNote}`,
        body: `<div class="card"><div class="tbl"><table>
          <thead><tr><th>Owner</th><th>Position</th><th>Price range (${ct} per ${cv})</th><th>Status</th><th class="r">${cv}</th><th class="r">${ct}</th><th class="r">Value (${cv} eq.)</th><th class="r">Share of active liquidity</th></tr></thead>
          <tbody>${posRows || this.waiting(8, posEmpty)}</tbody></table></div></div>` },
    ]);
  }

  /* ---------------- liquidity chart (SVG, redrawn alone on zoom/pan) ---------------- */

  /** Segments [u0, u1) with liquidity L, in "u" units: ticks oriented so the CoinVertible price grows left to right. */
  chartModel(p) {
    const c = p.chart;
    const sgn = p.cvIs0 ? 1 : -1;
    const segs = [];
    let L = 0;
    const t = c.ticks;
    const eps = 1e-9 * t.reduce((m, x) => Math.max(m, Math.abs(x[1])), 0);
    for (let i = 0; i < t.length - 1; i++) {
      L += t[i][1];
      if (L > eps) { const a = t[i][0] * sgn, b = t[i + 1][0] * sgn; segs.push({ u0: Math.min(a, b), u1: Math.max(a, b), L }); }
    }
    const k = 10 ** (p.decimals[0] - p.decimals[1]);
    const priceU = (u) => (p.cvIs0 ? 1.0001 ** u * k : 1.0001 ** u / k);
    const uOfPrice = (x) => Math.log(p.cvIs0 ? x / k : x * k) / Math.log(1.0001);
    return { segs, sgn, priceU, uOfPrice, uCur: c.tick * sgn, spacing: c.spacing };
  }

  defaultView(p, M) {
    const max = Math.max(0, ...M.segs.map((s) => s.L));
    const sig = M.segs.filter((s) => s.L >= max * 0.01);
    let lo = Math.min(M.uCur, ...sig.map((s) => s.u0)), hi = Math.max(M.uCur + M.spacing, ...sig.map((s) => s.u1));
    if (p.pegPrice) { const up = M.uOfPrice(p.pegPrice); if (Number.isFinite(up) && Math.abs(up - M.uCur) < (hi - lo) * 3 + 50 * M.spacing) { lo = Math.min(lo, up); hi = Math.max(hi, up); } }
    if (hi - lo > 40000) { lo = M.uCur - 1000; hi = M.uCur + 1000; } // full-range liquidity (v2, wide v3/v4): +/- ~10%
    const span = Math.max(hi - lo, 20 * M.spacing);
    const mid = (lo + hi) / 2;
    return { lo: mid - span * 0.65, hi: mid + span * 0.65 };
  }

  chartView(p, M) {
    this._views ||= {};
    return this._views[p.slug] || this.defaultView(p, M);
  }

  setChartView(slug, v) {
    const d = this.uniData();
    const p = d?.pools.find((x) => x.slug === slug);
    if (!p?.ready) return;
    const M = this.chartModel(p);
    const minSpan = 8 * M.spacing, maxSpan = 2 * MAX_TICK;
    let span = Math.min(maxSpan, Math.max(minSpan, v.hi - v.lo));
    let lo = (v.lo + v.hi) / 2 - span / 2;
    lo = Math.max(MIN_TICK, Math.min(MAX_TICK - span, lo));
    this._views ||= {};
    this._views[slug] = { lo, hi: lo + span };
    this.drawCharts();
  }

  drawCharts() {
    const d = this.uniData();
    this.content.querySelectorAll("[data-chart]").forEach((el) => {
      const p = d?.pools.find((x) => x.slug === el.getAttribute("data-chart"));
      el.innerHTML = p?.ready ? this.chartSvg(p, el.clientWidth || 900, Math.max(160, el.clientHeight || 260)) : "";
    });
    this.tip?.refresh();
  }

  chartSvg(p, W, H = 260) {
    const M = this.chartModel(p);
    const v = this.chartView(p, M);
    const top = 22, bottom = 26, side = 8;
    const ih = H - top - bottom, iw = W - side * 2;
    const span = v.hi - v.lo;
    const x = (u) => side + ((u - v.lo) / span) * iw;
    // bucket width: a multiple of the tick spacing giving ~70 bars over the view
    const step = Math.max(1, Math.ceil(span / 70 / M.spacing)) * M.spacing;
    const first = Math.floor(v.lo / step) * step;
    const [d0, d1] = p.decimals;
    const sqrtP = p.chart.sqrtP;
    const bars = [];
    for (let b = first; b < v.hi; b += step) {
      let a0 = 0, a1 = 0;
      for (const s of M.segs) {
        const u0 = Math.max(b, s.u0), u1 = Math.min(b + step, s.u1);
        if (u1 <= u0) continue;
        const tl = Math.min(u0 * M.sgn, u1 * M.sgn), tu = Math.max(u0 * M.sgn, u1 * M.sgn);
        const [r0, r1] = rangeAmounts(s.L, sqrtP, tl, tu);
        a0 += r0 / 10 ** d0; a1 += r1 / 10 ** d1;
      }
      const cvAmt = p.cvIs0 ? a0 : a1, ctAmt = p.cvIs0 ? a1 : a0;
      bars.push({ b, cvAmt, ctAmt, val: cvAmt + ctAmt / p.price });
    }
    const maxV = Math.max(1e-9, ...bars.map((r) => r.val));
    const cv = p.cv.symbol, ct = p.counter.symbol;
    const prec = span / M.spacing < 400 ? 5 : 4;
    const g = bars.map((r) => {
      const x0 = x(Math.max(r.b, v.lo)), x1 = x(Math.min(r.b + step, v.hi));
      const w = Math.max(1, x1 - x0 - (x1 - x0 > 4 ? 1 : 0));
      const hCv = (r.cvAmt / maxV) * ih, hCt = (r.ctAmt / p.price / maxV) * ih;
      const tip = `${fmtP(M.priceU(r.b), prec)} \u2013 ${fmtP(M.priceU(r.b + step), prec)} ${ct} per ${cv}\n${cv}: ${amount(r.cvAmt, 0)}\n${ct}: ${amount(r.ctAmt, 0)}`;
      const y0 = top + ih;
      return `<g class="bar"${r.val > 0 ? tipAttr(tip) : ""}><rect class="hit" x="${x0.toFixed(1)}" y="${top}" width="${(x1 - x0).toFixed(1)}" height="${ih}"/>`
        + (hCt > 0.2 ? `<rect class="b-ct" x="${x0.toFixed(1)}" y="${(y0 - hCt).toFixed(1)}" width="${w.toFixed(1)}" height="${hCt.toFixed(1)}"/>` : "")
        + (hCv > 0.2 ? `<rect class="b-cv" x="${x0.toFixed(1)}" y="${(y0 - hCt - hCv).toFixed(1)}" width="${w.toFixed(1)}" height="${hCv.toFixed(1)}"/>` : "")
        + `</g>`;
    }).join("");
    const labels = [];
    for (let i = 0; i <= 4; i++) {
      const u = v.lo + (span * (i + 0.5)) / 5;
      labels.push(`<text class="ax" x="${x(u).toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtP(M.priceU(u), prec)}</text>`);
    }
    const line = (u, cls, text, right) => {
      if (u < v.lo || u > v.hi) return "";
      const X = x(u);
      const anchor = right ? "start" : "end";
      return `<line class="${cls}-halo" x1="${X.toFixed(1)}" x2="${X.toFixed(1)}" y1="${top - 4}" y2="${top + ih}"/><line class="${cls}" x1="${X.toFixed(1)}" x2="${X.toFixed(1)}" y1="${top - 4}" y2="${top + ih}"/><text class="lbl ${cls}" x="${(X + (right ? 5 : -5)).toFixed(1)}" y="${top - 8}" text-anchor="${anchor}">${esc(text)}</text>`;
    };
    // current price from sqrtP (between ticks), peg from the oracles
    const uCurExact = M.uOfPrice(p.price);
    const uPeg = p.pegPrice ? M.uOfPrice(p.pegPrice) : null;
    const curRight = uPeg == null || uCurExact >= uPeg;
    return `<svg class="lchart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Liquidity distribution">
      <line class="base" x1="${side}" x2="${W - side}" y1="${top + ih + 0.5}" y2="${top + ih + 0.5}"/>
      ${g}${labels.join("")}
      ${uPeg != null ? line(uPeg, "peg", `Peg ${fmtP(p.pegPrice, prec)}`, !curRight) : ""}
      ${line(uCurExact, "cur", `Current ${fmtP(p.price, prec)}`, curRight)}
    </svg>`;
  }

  /** Wheel zoom (around the pointer), drag to pan, double-click to reset; area chart hover. */
  bindChart() {
    this.content.addEventListener("mousemove", (e) => {
      const lc = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-lc]");
      if (lc) this.lineHover(lc.getAttribute("data-lc"), e.clientX); else this.lineLeave();
      const w = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-area-wrap]");
      if (!w) { this.areaLeave(); return; }
      const id = w.getAttribute("data-area-wrap");
      if (this._areaOpen && this._areaOpen !== id) this.areaLeave();
      if (w.classList.contains("compact") && !w.classList.contains("open")) { w.classList.add("open"); this._areaOpen = id; }
      this.areaHover(id, e.clientX);
    });
    // leaving the page area (also after a re-render under the pointer, when "mouseleave" may not fire)
    document.addEventListener("mousemove", (e) => {
      if (this.content.contains(/** @type {Node} */ (e.target))) return;
      if (this._areaOpen || this._areaHover) this.areaLeave();
      if (this._lineHover) this.lineLeave();
    }, { passive: true });
    document.documentElement.addEventListener("mouseleave", () => { this.areaLeave(); this.lineLeave(); });
    const frac = (el, clientX) => { const r = el.getBoundingClientRect(); return Math.min(1, Math.max(0, (clientX - r.left - 8) / Math.max(1, r.width - 16))); };
    const viewOf = (slug) => { const p = this.uniData()?.pools.find((x) => x.slug === slug); if (!p?.ready) return null; return this.chartView(p, this.chartModel(p)); };
    this.content.addEventListener("wheel", (e) => {
      const el = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-chart]");
      if (!el) return;
      e.preventDefault();
      const slug = el.getAttribute("data-chart"), v = viewOf(slug);
      if (!v) return;
      const f = frac(el, e.clientX), u = v.lo + f * (v.hi - v.lo);
      const span = (v.hi - v.lo) * (e.deltaY > 0 ? 1.25 : 0.8);
      this.setChartView(slug, { lo: u - f * span, hi: u - f * span + span });
    }, { passive: false });
    this.content.addEventListener("mousedown", (e) => {
      const el = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-chart]");
      if (!el || e.button !== 0) return;
      const slug = el.getAttribute("data-chart"), v = viewOf(slug);
      if (!v) return;
      e.preventDefault();
      this._drag = { slug, x: e.clientX, v, w: Math.max(1, el.getBoundingClientRect().width - 16) };
      el.classList.add("grabbing");
    });
    document.addEventListener("mousemove", (e) => {
      const g = this._drag;
      if (!g) return;
      const du = (-(e.clientX - g.x) / g.w) * (g.v.hi - g.v.lo);
      if (this._dragRaf) return;
      this._dragRaf = requestAnimationFrame(() => { this._dragRaf = 0; this.setChartView(g.slug, { lo: g.v.lo + du, hi: g.v.hi + du }); });
    });
    document.addEventListener("mouseup", () => { if (!this._drag) return; this._drag = null; this.content.querySelectorAll(".grabbing").forEach((el) => el.classList.remove("grabbing")); });
    this.content.addEventListener("dblclick", (e) => {
      const el = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-chart]");
      if (el) { delete this._views?.[el.getAttribute("data-chart")]; this.drawCharts(); }
    });
    addEventListener("resize", () => this.renderSoon());
  }

  zoom(slug, mode) {
    if (mode === "reset") { delete this._views?.[slug]; this.drawCharts(); return; }
    const p = this.uniData()?.pools.find((x) => x.slug === slug);
    if (!p?.ready) return;
    const v = this.chartView(p, this.chartModel(p));
    const c = (v.lo + v.hi) / 2, span = (v.hi - v.lo) * (mode === "in" ? 0.6 : 1 / 0.6);
    this.setChartView(slug, { lo: c - span / 2, hi: c + span / 2 });
  }

  /* ---------------- multi-series line chart (Coinwatch: depth by venue, spread by pair) ---------------- */

  /**
   * Line chart, one line per series, colours from the categorical palette (--s1..--s8, slot = entity
   * order given by the caller, never by rank). Same mechanics as areaChart: fixed 1000-wide viewBox
   * stretched to its box, HTML overlay for labels, crosshair and dots; tooltip lists every series.
   * @param {{label:string, slot:number, points:[number, number][]}[]} series  points in ms
   */
  lineChart(id, series, o = {}) {
    const S = series.filter((x) => x.points?.length);
    if (!S.length) return `<div class="area-ph short">${esc(o.empty || "No data")}</div>`;
    const H = o.height || 200, VW = 1000, top = 6;
    let t0 = Infinity, t1 = -Infinity, hi = 0;
    for (const x of S) for (const [t, v] of x.points) { if (t < t0) t0 = t; if (t > t1) t1 = t; if (v > hi) hi = v; }
    hi = hi > 0 ? hi * 1.08 : 1;
    const X = (t) => ((t - t0) / (t1 - t0 || 1)) * VW;
    const Y = (v) => top + (1 - v / hi) * (H - top);
    (this._lines ||= {})[id] = { S, t0, t1, Y, fmt: o.fmt || ((v) => amount(v, 0)) };
    const path = (pts) => pts.map(([t, v], k) => `${k ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const ticks = [0, 0.5, 1].map((f) => { const v = (hi / 1.08) * f; return `<span class="lc-y" style="top:${Y(v).toFixed(1)}px">${esc((o.yfmt || ((x) => (x ? compact(x) : "0")))(v))}</span>`; }).join("");
    const lines = S.map((x) => `<path d="${path(x.points)}" class="lc-line" style="stroke:var(--s${x.slot})" vector-effect="non-scaling-stroke"/>`).join("");
    const fmtD = (t) => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    return `<div class="lc-wrap">
      ${S.length > 1 || o.legend ? `<div class="legend lc-legend">${S.map((x) => `<span><i style="background:var(--s${x.slot})"></i>${esc(x.label)}</span>`).join("")}</div>` : ""}
      <div class="lc" data-lc="${esc(id)}" style="height:${H}px" role="img" aria-label="${esc(o.label || "Chart")}">
        <svg viewBox="0 0 ${VW} ${H}" preserveAspectRatio="none" height="${H}" aria-hidden="true">${[0, 0.5, 1].map((f) => { const y = Y((hi / 1.08) * f).toFixed(1); return `<line class="lc-grid" x1="0" x2="${VW}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`; }).join("")}${lines}</svg>
        ${ticks}<span class="area-x"></span>${S.map((x, k) => `<span class="lc-pt" data-k="${k}" style="background:var(--s${x.slot})"></span>`).join("")}</div>
      <div class="area-foot"><span>${esc(fmtD(t0))}</span>${o.title ? `<span>${esc(o.title)}</span>` : ""}<span>${esc(fmtD(t1))}</span></div></div>`;
  }

  lineHover(id, clientX) {
    const el = /** @type {HTMLElement|null} */ (this.content.querySelector(`[data-lc="${CSS.escape(id)}"]`));
    const L = this._lines?.[id];
    if (!el || !L) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    const t = L.t0 + f * (L.t1 - L.t0);
    // nearest timestamp among all series
    let best = null;
    for (const x of L.S) for (const p of x.points) if (!best || Math.abs(p[0] - t) < Math.abs(best - t)) best = p[0];
    const fx = (best - L.t0) / (L.t1 - L.t0 || 1);
    el.classList.add("hov");
    /** @type {HTMLElement} */ (el.querySelector(".area-x")).style.left = `${(fx * 100).toFixed(3)}%`;
    const rows = [];
    L.S.forEach((x, k) => {
      const p = x.points.find((q) => q[0] === best);
      const dot = /** @type {HTMLElement} */ (el.querySelector(`.lc-pt[data-k="${k}"]`));
      if (!p) { dot.style.display = "none"; return; }
      dot.style.display = "block"; dot.style.left = `${(fx * 100).toFixed(3)}%`; dot.style.top = `${L.Y(p[1]).toFixed(1)}px`;
      rows.push([x.label, p[1]]);
    });
    rows.sort((a, b) => b[1] - a[1]);
    this._lineHover = { id, x: clientX };
    const day = new Date(best).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", ...(L.t1 - L.t0 < 3 * 86400000 ? { hour: "2-digit", minute: "2-digit" } : {}) });
    this.tip.showAt(r.left + fx * r.width, r.top + 8, `${day}\n${rows.map(([l, v]) => `${l}: ${L.fmt(v)}`).join("\n")}`);
  }

  lineLeave() {
    if (!this._lineHover) return;
    const el = this.content.querySelector(`[data-lc="${CSS.escape(this._lineHover.id)}"]`);
    el?.classList.remove("hov");
    this._lineHover = null;
    this.tip.hide();
  }

  /* ---------------- Coinwatch ---------------- */

  /** One Coinwatch chart for the token shown (24 h unless params say otherwise), noted for the status line. */
  cwGet(token, category, params = {}) {
    const r = this.app.coinwatch.get({ token, category, params: { chart_duration: "24h", ...params } });
    this._cwSeen.push(r);
    return r;
  }

  cwRef(ref) {
    const r = this.app.coinwatch.get({ ref });
    this._cwSeen.push(r);
    return r;
  }

  /** Logo of an exchange ("ex") or market maker ("mm"): config key found in the name as whole words, earliest first. */
  cwLogo(name, kind, cls = "") {
    const L = this.logos;
    const map = kind === "mm" ? L.marketMakers || {} : { ...(L.nav || {}), ...(L.exchanges || {}) };
    const k = bestName(name, Object.keys(map));
    return logo(k ? map[k] : null, name, cls);
  }

  /**
   * Everything the token page needs, read from the cache; what is not on screen is not asked for.
   * Sources, in this order: the markets list of config.js (coinwatch.markets.<token>), then whatever
   * Coinwatch reports that the list does not have. Labels such as "Remaining Depth" are not market makers:
   * they are what the market makers do not provide, so they only count in the venue totals.
   */
  cwModel(token, tab) {
    const C = this.app.config.coinwatch;
    const bp = C.depthBps || 100;
    const unit = C.spreadUnit || "percent";
    const ignored = (label) => (C.ignoreLabels || []).some((p) => namePos(label, p) === 0);
    const real = (d) => d && !ignored(d.label);
    const base = { denomination: "baseAsset" };
    const vol = (d) => cwVolume24h(d?.points, C.volume24h);
    const pick = (ds) => (!ds?.length ? null : ds.length === 1 ? ds[0] : ds.find((d) => /total/i.test(d.label)) || null);
    const totalOf = (ds, fn) => { const one = pick(ds); if (one) return fn(one); const v = (ds || []).filter(real).map(fn).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };

    // the user's list: exchange -> pair -> market makers
    const known = C.markets?.[token] || {};
    const knownEx = Object.keys(known);
    const hasList = knownEx.length > 0;
    const knownMmsOn = (ex) => [...new Set(Object.values(known[ex] || {}).flat())];
    const knownMms = [...new Set(knownEx.flatMap(knownMmsOn))];
    const ourNames = C.ourMarketMakers?.length ? C.ourMarketMakers : knownMms;

    const exRef = this.cwRef("exchanges"), mmRef = this.cwRef("market_makers");
    const A = this.cwGet(token, "total-volume", base);
    const A30 = this.cwGet(token, "total-volume", { ...base, chart_duration: "30d" });
    const B = this.cwGet(token, "volume-weighted-bid-ask-spread-ratio");
    const D = this.cwGet(token, "volume-by-exchange", base);
    const C24 = this.cwGet(token, "depth-by-exchange", { ...base, basis_points_from_mid: bp });

    const refEx = exRef.data?.exchanges || [], refMm = mmRef.data?.market_makers || [];
    const slugIn = (ref, label) => !label ? null : (ref.find((e) => cwNorm(e.name) === cwNorm(label) || cwNorm(e.slug) === cwNorm(label)) || ref.find((e) => sameName(e.name, label)))?.slug || null;
    const mmSlugOf = (label) => slugIn(refMm, label);
    const isOurs = (label) => !ourNames.length || ourNames.some((n) => sameName(label, n) || sameName(mmSlugOf(label) || "", n));

    // exchanges = Coinwatch's (volume / depth charts) merged with the list (names matched as whole words)
    const exchanges = [];
    for (const label of new Set([...(D.data?.datasets || []), ...(C24.data?.datasets || [])].filter(real).map((d) => d.label))) {
      exchanges.push({ label, known: knownEx.find((k) => sameName(label, k)) || null, inCw: true });
    }
    for (const k of knownEx) if (!exchanges.some((e) => e.known === k)) exchanges.push({ label: k, known: k, inCw: false });
    for (const e of exchanges) {
      e.slug = slugIn(refEx, e.label) || slugIn(refEx, e.known);
      e.volume = vol(D.data?.datasets.find((d) => d.label === e.label));
      e.depth = cwAvg24h(C24.data?.datasets.find((d) => d.label === e.label)?.points);
    }
    exchanges.sort((a, b) => Number(b.inCw) - Number(a.inCw) || (b.volume || 0) - (a.volume || 0) || (b.depth || 0) - (a.depth || 0));

    // per exchange: market makers' volume and depth (KPIs and both tabs), spread (market makers tab).
    // Coinwatch first: only venues Coinwatch reports. Then the list: a listed venue with no market maker
    // on any of its pairs (a DEX: Coinwatch answers 404 there) is not asked.
    for (const e of exchanges) {
      e.depthTotal = e.depth; e.volumeTotal = e.volume;
      e.noMm = hasList && !!e.known && !knownMmsOn(e.known).length;
      if (!e.slug || !e.inCw || e.noMm) continue;
      e.mmVol = this.cwGet(token, "market-maker-volume-for-exchange", { ...base, exchange: e.slug });
      e.mmDepth = this.cwGet(token, "market-maker-depth-for-exchange", { ...base, exchange: e.slug, basis_points_from_mid: bp });
      if (tab === "mm") e.mmSpread = this.cwGet(token, "market-maker-bid-ask-spread-ratio-for-exchange", { exchange: e.slug });
      // venue totals: market makers + "Remaining ..." when Coinwatch gives it (same chart, so shares stay <= 100 %), else the venue chart
      const sum = (r, fn) => { const ds = r?.data?.datasets || []; return ds.some((d) => ignored(d.label)) ? ds.reduce((s, d) => s + (fn(d) || 0), 0) : null; };
      e.depthTotal = sum(e.mmDepth, (d) => cwAvg24h(d.points)) ?? e.depth;
      e.volumeTotal = sum(e.mmVol, vol) ?? e.volume;
    }

    // market maker x exchange rows: Coinwatch's, merged with the list
    const rows = [];
    for (const e of exchanges) {
      const ds = (r) => (r?.data?.datasets || []).filter(real);
      const labels = [...new Set([...ds(e.mmVol), ...ds(e.mmDepth)].map((d) => d.label))];
      const listed = e.known ? knownMmsOn(e.known) : [];
      const add = (mm, inCw) => {
        const v = vol(e.mmVol?.data?.datasets.find((d) => d.label === mm));
        const dp = cwAvg24h(e.mmDepth?.data?.datasets.find((d) => d.label === mm)?.points);
        const sp = cwBps(cwAvg24h(e.mmSpread?.data?.datasets.find((d) => d.label === mm)?.points), unit);
        rows.push({ mm, mmSlug: mmSlugOf(mm), exchange: e.label, exSlug: e.slug, volume: v, spreadBps: sp, depth: dp,
          depthShare: dp != null && e.depthTotal ? Math.min(1, dp / e.depthTotal) : null,
          inList: !hasList || listed.some((n) => sameName(mm, n)), inCw, listedPairs: e.known ? Object.entries(known[e.known] || {}).filter(([, mms]) => mms.some((n) => sameName(mm, n))).map(([pair]) => pair) : [] });
      };
      for (const mm of labels) add(mm, true);
      for (const n of listed) if (!labels.some((l) => sameName(l, n))) add(n, false);
    }
    rows.sort((a, b) => Number(b.inCw) - Number(a.inCw) || (b.volume || 0) - (a.volume || 0) || (b.depth || 0) - (a.depth || 0));
    const active = [...new Set(rows.filter((r) => r.inCw && ((r.volume || 0) > 0 || (r.depth || 0) > 0)).map((r) => r.mm))].sort();
    const mmPending = exchanges.some((e) => e.slug && ((!e.mmVol?.data && e.mmVol?.loading) || (!e.mmDepth?.data && e.mmDepth?.loading)));

    // share of the depth provided by our market makers (KPI), share of the volume (Exchanges tab)
    let ourDepth = 0, allDepth = 0;
    for (const e of exchanges) {
      if (!e.mmDepth?.data || !e.depthTotal) continue;
      allDepth += e.depthTotal;
      for (const d of e.mmDepth.data.datasets.filter(real)) if (isOurs(d.label)) ourDepth += cwAvg24h(d.points) || 0;
    }
    let E = null, C30 = null;
    if (tab === "ex") {
      E = this.cwGet(token, "bid-ask-spread-ratio-by-exchange");
      C30 = this.cwGet(token, "depth-by-exchange", { ...base, basis_points_from_mid: bp, chart_duration: "30d" });
      for (const e of exchanges) {
        e.spreadBps = cwBps(cwAvg24h(E.data?.datasets.find((d) => d.label === e.label)?.points), unit);
        const ours = (e.mmVol?.data?.datasets || []).filter(real).filter((d) => isOurs(d.label)).reduce((s, d) => s + (vol(d) || 0), 0);
        e.oursShare = e.mmVol?.data && e.volumeTotal ? Math.min(1, ours / e.volumeTotal) : null;
      }
    }
    // daily volume bars (Volume card)
    const days = C.volumeBarsDays || 15;
    const vday = pick(A30.data?.datasets) || null;
    const bars = vday ? vday.points.slice(-days) : (A30.data?.datasets?.length ? cwSumSeries(A30.data.datasets.filter(real)).slice(-days) : null);

    const spreadKpi = totalOf(B.data?.datasets, (d) => cwAvg24h(d.points));
    this._cwUnitWarn = spreadKpi != null && cwBps(spreadKpi, unit) > 500 ? `Coinwatch spread values look too large for "${unit}": check coinwatch.spreadUnit in config.js (raw 24 h average ${spreadKpi}).` : null;
    return {
      bp, unit, exchanges, rows, active, mmPending, C30, hasList, bars, ourNames,
      kpi: {
        volume: totalOf(A.data?.datasets, (d) => vol(d)),
        spreadBps: cwBps(spreadKpi, unit),
        depth: exchanges.some((e) => e.depth != null) ? exchanges.reduce((s, e) => s + (e.depth || 0), 0) : null,
        ourDepthShare: allDepth > 0 ? Math.min(1, ourDepth / allDepth) : null,
      },
      loading: { A: !A.data && !A.error, A30: !A30.data && !A30.error, B: !B.data && !B.error, D: !D.data && !D.error, C24: !C24.data && !C24.error },
      errors: [A, B, D, C24, exRef, mmRef].filter((x) => x.error && !x.data).map((x) => x.error),
    };
  }

  /** Small daily bars (Volume card): hover gives the day and the amount. */
  miniBars(points, unit) {
    if (!points?.length) return `<div class="minibars empty"></div>`;
    const max = Math.max(...points.map((p) => p[1]), 1e-9);
    return `<div class="minibars" role="img" aria-label="Daily volume, last ${points.length} days">${points.map(([t, v], k) => {
      const day = new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
      return `<span class="mb${k === points.length - 1 ? " last" : ""}"${tipAttr(`${day}\n${amount(v, 0)} ${unit}`)}><i style="height:${Math.max(4, (v / max) * 100).toFixed(1)}%"></i></span>`;
    }).join("")}</div>`;
  }

  coinwatch() {
    const cw = this.app.coinwatch, C = this.app.config.coinwatch || {};
    const tokens = Object.keys(C.tokens || {});
    if (!tokens.length) return `<section><div class="card card-body muted">Coinwatch is not configured (config.js -> coinwatch).</div></section>`;
    const pairsOk = this.cwPairsVisible();
    const isPairs = this.sub === "pairs" && pairsOk;
    const token = isPairs ? null : tokens.find((t) => t.toLowerCase() === this.sub) || tokens[0];
    // breadcrumb follows what is shown (a private Trading pairs tab without key shows the first token)
    const crumb = this.root.querySelector("#crumbs b");
    const want = isPairs ? "Trading pairs" : token;
    if (crumb && crumb.textContent !== want) crumb.textContent = want;
    this._cwSeen = [];
    const seg = `<div class="seg">${tokens.map((t) => `<a href="#/coinvertible/coinwatch/${t.toLowerCase()}"${t === token ? ' class="on"' : ""}><span class="cell">${logo(this.logos.tokens?.[t], t)}${esc(t)}</span></a>`).join("")}${pairsOk ? `<a href="#/coinvertible/coinwatch/pairs"${isPairs ? ' class="on"' : ""}><span class="cell">${icon("list")}Trading pairs</span></a>` : ""}</div>`;
    if (isPairs) return this.cwPairsPage(seg);
    if (!cw.hasKey() || cw.authError) return `<div class="pool-nav">${seg}</div>${this.cwKeyCard(cw)}`;

    let tab = this.cwTab;
    if (!tab) { try { tab = localStorage.getItem("cv:v1:cwtab") || "mm"; } catch { tab = "mm"; } this.cwTab = tab; }
    const M = this.cwModel(token, tab);
    const unitTok = esc(token);
    const wait = (cond) => (cond ? `<span class="subtle">\u2026</span>` : DASH);
    const card = (id, label, tip, value, foot) => ({ id, label, w: 3, minPx: 220, minH: 140, body: `<div class="card card-body cw-kpi"><div class="kpi-label">${esc(label)}${tip ? `<span class="tip-i"${tipAttr(tip)}>${icon("info")}</span>` : ""}</div><div class="kpi">${value}</div><div class="kpi-foot">${foot}</div></div>` });
    const ourTxt = M.ourNames.length ? M.ourNames.join(", ") : "every market maker on the dashboard";
    const kpis = [
      card("cw.volume", "Volume 24h", "Traded volume of the last 24 h on the venues Coinwatch tracks, in the token. Bars: daily volume.",
        M.kpi.volume != null ? `${amount(M.kpi.volume, 0)}<small>${unitTok}</small>` : wait(M.loading.A),
        M.bars ? this.miniBars(M.bars, token) : `<div class="minibars empty"></div>`),
      card("cw.depth", `Depth \u00b1${M.bp} bps`, `Order-book depth within ${M.bp} bps of mid, summed over venues, average of the last 24 h. Bar: part provided by our market makers (${ourTxt}).`,
        M.kpi.depth != null ? `${amount(M.kpi.depth, 0)}<small>${unitTok}</small>` : wait(M.loading.C24),
        `<div class="kpi-meter"><span class="track"><span style="width:${((M.kpi.ourDepthShare || 0) * 100).toFixed(2)}%"></span></span><span>${M.kpi.ourDepthShare != null ? `${pct(M.kpi.ourDepthShare, 1)} by our market makers` : M.mmPending ? "\u2026" : DASH}</span></div>`),
      card("cw.spread", "Average spread 24h", "",
        M.kpi.spreadBps != null ? `${nf(2, 2).format(M.kpi.spreadBps)}<small>bps</small>` : wait(M.loading.B),
        `<span class="kpi-note">Bid-ask spread of each venue weighted by its volume, averaged over the last 24 h.</span>`),
      card("cw.mms", "Active market makers", "Market makers with volume or depth in the last 24 h on at least one venue.",
        M.active.length || M.mmPending ? `${M.active.length}${M.mmPending ? `<small>\u2026</small>` : ""}` : M.exchanges.length ? "0" : wait(M.loading.D),
        `<span class="kpi-note">${M.active.length ? M.active.map((n) => `<span class="cell">${this.cwLogo(n, "mm")}${esc(n)}</span>`).join("") : ""}</span>`),
    ];
    const tabs = `<div class="tabs" role="tablist"><button role="tab" data-cwtab="mm"${tab === "mm" ? ' class="on" aria-selected="true"' : ""}>Market makers</button><button role="tab" data-cwtab="ex"${tab === "ex" ? ' class="on" aria-selected="true"' : ""}>Exchanges</button></div>`;
    const errs = M.errors.length ? `<div class="card card-body cw-err"><span class="err-dot"></span><span>${esc(M.errors[0])}</span></div>` : "";
    const body = tab === "ex" ? this.cwExchanges(token, M) : this.cwMarketMakers(token, M);
    const forget = cw.configKey() ? "" : `<button class="link-btn" data-cw-forget>Forget the API key on this browser</button>`;
    return this.gridPage("coinwatch", `<div class="pool-nav">${seg}${this.cwStatusPill()}</div>${errs}`, [
      ...kpis,
      { id: "cw.tabs", label: "Market makers / Exchanges", w: 12, minPx: 520, minH: 220, head: tabs, body },
    ], `<div class="cw-foot"><span class="subtle">Coinwatch data is confidential: keep it within the team.</span>${forget}</div>`);
  }

  /** Source pill of the Coinwatch page: oldest data shown + state. */
  cwStatusPill() {
    const seen = this._cwSeen || [];
    const ats = seen.map((r) => r.at).filter(Boolean);
    const loading = seen.some((r) => r.loading);
    const err = seen.find((r) => r.error);
    const cls = err ? (ats.length ? "stale" : "error") : loading && !ats.length ? "pending" : "ok";
    const oldest = ats.length ? Math.min(...ats) : null;
    const tip = `${seen.length} Coinwatch charts on this view, refreshed every ${Math.round((this.app.config.coinwatch.cacheTtlSec || 21600) / 3600)} h${loading ? "\nloading\u2026" : ""}${err ? `\n${err.error}` : ""}`;
    this._cwStatus = { cls, oldest, loading, err };
    return `<span class="links"><span class="src ${cls}"${tipAttr(tip)}><i></i><b>Coinwatch</b>${oldest ? `<span>${age(oldest)}</span>` : `<span>${loading ? "loading\u2026" : DASH}</span>`}</span></span>`;
  }

  cwKeyCard(cw) {
    const refused = cw.authError ? `<p class="err-txt">Key refused: ${esc(cw.authError.error)}${cw.configKey() ? " (key from config.js: fix it there)" : ""}</p>` : "";
    return `<section><div class="card cw-key"><div class="card-body">
      <h3>Coinwatch API key</h3>
      <p class="muted">The Coinwatch page reads the Coinwatch API with your personal key (it starts with <span class="mono">cw_</span>). Create one on <a class="link" href="https://coinwatch.co/settings/api_keys" target="_blank" rel="noopener">coinwatch.co/settings/api_keys${icon("ext", "ext")}</a>.</p>
      ${refused}
      <form id="cw-key-form" autocomplete="off"><input id="cw-key-input" type="password" placeholder="cw_..." spellcheck="false" aria-label="Coinwatch API key"><button class="btn primary" type="submit">Save</button></form>
      <p class="subtle">Kept in this browser only (local storage), sent only to coinwatch.co. The data is confidential: keep the dashboard within the team.</p>
    </div></div></section>`;
  }

  /** "not in list" / "no Coinwatch data" marks, only once the user has filled coinwatch.markets. */
  cwMark(x, M) {
    if (!M.hasList) return "";
    if (!x.inCw) return `<span class="note"${tipAttr("In your list (config.js coinwatch.markets), but Coinwatch has no data for it in the last 24 h")}>no Coinwatch data</span>`;
    if (x.inList === false || x.known === null) return `<span class="note"${tipAttr("Reported by Coinwatch, not in your list (config.js coinwatch.markets)")}>not in list</span>`;
    return "";
  }

  /**
   * Market makers tab: one sub-section per market maker (its totals), then one row per exchange it is
   * on (click to unfold). Groups ordered by total volume, rows by volume.
   */
  cwMarketMakers(token, M) {
    const cols = 4;
    const groups = new Map();
    for (const r of M.rows) { const k = nameWords(r.mm).join(""); if (!groups.has(k)) groups.set(k, { mm: r.mm, rows: [] }); groups.get(k).rows.push(r); }
    const sum = (rows, f) => { const v = rows.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
    const list = [...groups.values()].map((g) => {
      const vol = sum(g.rows, (r) => r.volume);
      const wsum = sum(g.rows, (r) => (r.spreadBps != null && r.volume ? r.spreadBps * r.volume : null));
      const wvol = sum(g.rows, (r) => (r.spreadBps != null && r.volume ? r.volume : null));
      return { ...g, volume: vol, spreadBps: wvol ? wsum / wvol : null, depth: sum(g.rows, (r) => r.depth), inCw: g.rows.some((r) => r.inCw) };
    }).sort((a, b) => Number(b.inCw) - Number(a.inCw) || (b.volume || 0) - (a.volume || 0) || (b.depth || 0) - (a.depth || 0));
    const rowsHtml = list.map((g) => {
      const head = `<tr class="grp${g.inCw ? "" : " other"}">
        <td><span class="cell">${this.cwLogo(g.mm, "mm", "lg")}<span class="grp-name">${esc(g.mm)}</span><span class="grp-n">${g.rows.length} ${g.rows.length > 1 ? "exchanges" : "exchange"}</span></span></td>
        <td class="r num">${g.volume != null ? `${amount(g.volume, 0)} <span class="muted">${esc(token)}</span>` : DASH}</td>
        <td class="r num"${tipAttr("Average of its venues weighted by its volume on each")}>${g.spreadBps != null ? `${nf(2, 2).format(g.spreadBps)} bps` : DASH}</td>
        <td class="r"><span class="muted"${tipAttr(`Total depth it provides within ${M.bp} bps, all its venues (24 h average)`)}>${g.depth != null ? `${amount(g.depth, 0)} ${esc(token)}` : DASH}</span></td></tr>`;
      const rows = g.rows.map((r) => {
        const key = `${token}|${r.exSlug || r.exchange}|${r.mm}`;
        if (this.cwOpen === key) return `<tr class="xrow"><td colspan="${cols}">${this.cwDetail(token, r, M)}</td></tr>`;
        return `<tr class="vrow sub${r.inCw ? "" : " other"}" data-cwrow="${esc(key)}">
          <td><span class="cell">${this.cwLogo(r.exchange, "ex")}<span>${esc(r.exchange)}</span>${this.cwMark(r, M)}</span></td>
          <td class="r num">${r.volume != null ? `${amount(r.volume, 0)} <span class="muted">${esc(token)}</span>` : DASH}</td>
          <td class="r">${r.spreadBps != null ? `${nf(2, 2).format(r.spreadBps)} bps` : DASH}</td>
          <td class="r"><span class="meter"><span class="track"><span style="width:${((r.depthShare || 0) * 100).toFixed(2)}%"></span></span><span class="w">${pct(r.depthShare, 1)}</span></span></td></tr>`;
      }).join("");
      return head + rows;
    }).join("");
    const empty = M.mmPending || M.loading.D ? "Loading\u2026" : M.exchanges.length && M.exchanges.every((e) => !e.slug) ? "Exchange names could not be matched with GET /exchanges" : "No market maker activity in the last 24 h";
    return `<div class="card"><div class="tbl"><table class="cw-mm">
      <colgroup><col><col style="width:20%"><col style="width:16%"><col style="width:250px"></colgroup>
      <thead><tr><th>Market maker / exchange</th><th class="r">Volume 24h</th><th class="r">Avg spread 24h</th><th class="r"${tipAttr(`Per exchange: the market maker's depth within ${M.bp} bps / the venue's total depth within ${M.bp} bps (24 h averages). Per market maker: its total depth.`)}>Share of venue depth</th></tr></thead>
      <tbody>${rowsHtml || this.waiting(cols, empty)}</tbody></table></div></div>`;
  }

  /** Unfolded market maker x exchange: depth chart, spread by pair, pairs table (5 charts, fetched now). */
  cwDetail(token, r, M) {
    const C = this.app.config.coinwatch;
    const close = `<button class="x-close" data-cw-close${tipAttr("Fold back into the table")}>Close${icon("x")}</button>`;
    const head = `<div class="cw-x-head"><span class="cell">${this.cwLogo(r.mm, "mm", "xl")}<span class="big">${esc(r.mm)}</span><span class="cw-on">on</span>${this.cwLogo(r.exchange, "ex", "xl")}<span class="big">${esc(r.exchange)}</span>${this.cwMark(r, M)}</span>${close}</div>`;
    if (!r.mmSlug || !r.exSlug) {
      const why = [!r.mmSlug ? `"${r.mm}" was not found in GET /market_makers` : "", !r.exSlug ? `"${r.exchange}" was not found in GET /exchanges` : ""].filter(Boolean).join("; ");
      return `<div class="vault-x${this._cwAnim ? " anim" : ""}" data-open-cw>${head}<div class="card-body muted">${esc(why)}: no detail can be requested.</div></div>`;
    }
    const p = { exchange: r.exSlug, market_maker_company_slug: r.mmSlug };
    const base = { denomination: "baseAsset" };
    const dd = this.cwGet(token, "market-maker-depth-for-market-maker-and-exchange", { ...p, ...base, basis_points_from_mid: M.bp, chart_duration: "30d" });
    const sp30 = this.cwGet(token, "market-maker-bid-ask-spread-ratio-for-market-maker-and-exchange-by-asset-pair", { ...p, chart_duration: "30d" });
    const sp24 = this.cwGet(token, "market-maker-bid-ask-spread-ratio-for-market-maker-and-exchange-by-asset-pair", p);
    const vp = this.cwGet(token, "market-maker-volume-for-market-maker-and-exchange-by-asset-pair", { ...p, ...base });
    const vx = this.cwGet(token, "volume-for-exchange-by-asset-pair", { exchange: r.exSlug, ...base });
    const vol = (d) => cwVolume24h(d?.points, C.volume24h);
    const ignored = (label) => (C.ignoreLabels || []).some((x) => namePos(label, x) === 0);
    const pairEq = (a, b) => nameWords(a).join("") === nameWords(b).join("");
    // pairs: the list first (pairs where this market maker is listed), then Coinwatch's
    const cwPairs = [...new Set([...(vp.data?.datasets || []), ...(sp24.data?.datasets || [])].filter((d) => !ignored(d.label)).map((d) => d.label))];
    const labels = [...cwPairs];
    for (const lp of r.listedPairs) if (!labels.some((l) => pairEq(l, lp))) labels.push(lp);
    const find = (x, label) => x.data?.datasets.find((d) => pairEq(d.label, label));
    const pairs = labels.map((label) => {
      const v = vol(find(vp, label));
      const all = vol(find(vx, label));
      return { label, inCw: cwPairs.includes(label), inList: !M.hasList || r.listedPairs.some((lp) => pairEq(lp, label)), volume: v, share: v != null && all ? Math.min(1, v / all) : null, spreadBps: cwBps(cwAvg24h(find(sp24, label)?.points), C.spreadUnit) };
    }).sort((a, b) => Number(b.inCw) - Number(a.inCw) || (b.volume || 0) - (a.volume || 0));
    // colours follow the pair (alphabetical order), max 8 lines: the pairs with the most volume
    const order = [...cwPairs].sort();
    const keep = new Set(pairs.filter((x) => x.inCw).slice(0, 8).map((x) => x.label));
    const spreadSeries = (sp30.data?.datasets || []).filter((d) => !ignored(d.label) && (keep.has(d.label) || !keep.size)).slice(0, 8)
      .map((d) => ({ label: d.label, slot: (order.indexOf(d.label) % 8) + 1 || 1, points: d.points.map(([t, v]) => [t, cwBps(v, C.spreadUnit)]) }));
    const depthSeries = (dd.data?.datasets || []).filter((d) => !ignored(d.label)).slice(0, 8).map((d, k) => ({ label: d.label, slot: k + 1, points: d.points }));
    const ph = (x, txt) => (x.error && !x.data ? `<div class="area-ph short">${esc(x.error)}</div>` : !x.data ? `<div class="area-ph short">${txt}</div>` : null);
    const pairRows = pairs.map((x) => `<tr${x.inCw ? "" : ' class="other"'}><td><span class="num">${esc(x.label)}</span>${this.cwMark(x, M)}</td><td class="r num">${x.volume != null ? `${amount(x.volume, 0)} <span class="muted">${esc(token)}</span>` : DASH}</td>
      <td class="r"><span class="meter"><span class="track"><span style="width:${((x.share || 0) * 100).toFixed(2)}%"></span></span><span class="w">${pct(x.share, 1)}</span></span></td>
      <td class="r">${x.spreadBps != null ? `${nf(2, 2).format(x.spreadBps)} bps` : DASH}</td></tr>`).join("");
    return `<div class="vault-x${this._cwAnim ? " anim" : ""}" data-open-cw>${head}
      <div class="cw-detail grid g2">
        <div><div class="chart-title">Depth \u00b1${M.bp} bps (30d, ${esc(token)})</div>${ph(dd, "Loading\u2026") || this.lineChart(`cwd:${token}:${r.exSlug}:${r.mmSlug}`, depthSeries, { height: 180, fmt: (v) => `${amount(v, 0)} ${token}`, label: "Depth provided by this market maker on this venue", legend: depthSeries.length > 1 })}</div>
        <div><div class="chart-title">Average spread by pair (30d, bps)</div>${ph(sp30, "Loading\u2026") || this.lineChart(`cws:${token}:${r.exSlug}:${r.mmSlug}`, spreadSeries, { height: 180, fmt: (v) => `${nf(2, 2).format(v)} bps`, yfmt: (v) => nf(1, 1).format(v), label: "Average spread by pair (bps)", legend: true })}</div>
      </div>
      <div class="tbl cw-pairs"><table><thead><tr><th>Pair</th><th class="r">Volume 24h</th><th class="r"${tipAttr("This market maker's volume on the pair / the pair's total volume on this venue (24 h)")}>Share of pair volume</th><th class="r">Avg spread 24h</th></tr></thead>
        <tbody>${pairRows || this.waiting(4, vp.loading || sp24.loading ? "Loading\u2026" : "No pair data")}</tbody></table></div>
    </div>`;
  }

  cwExchanges(token, M) {
    const rows = M.exchanges.map((e) => `<tr${e.inCw ? "" : ' class="other"'}>
      <td><span class="cell">${this.cwLogo(e.label, "ex")}<span class="num">${esc(e.label)}</span>${this.cwMark(e, M)}</span></td>
      <td class="r num">${e.volume != null ? `${amount(e.volume, 0)} <span class="muted">${esc(token)}</span>` : DASH}</td>
      <td class="r">${e.spreadBps != null ? `${nf(2, 2).format(e.spreadBps)} bps` : DASH}</td>
      <td class="r">${e.depth != null ? `${amount(e.depth, 0)} <span class="muted">${esc(token)}</span>` : DASH}</td>
      <td class="r">${e.noMm ? `<span class="subtle"${tipAttr("No market maker on this venue in your list (config.js coinwatch.markets): not asked to Coinwatch")}>none listed</span>` : `<span class="meter"><span class="track"><span style="width:${((e.oursShare || 0) * 100).toFixed(2)}%"></span></span><span class="w">${pct(e.oursShare, 1)}</span></span>`}</td></tr>`).join("");
    // depth by venue: colour follows the exchange (alphabetical), 8 lines max: smaller venues summed as "Other"
    const C = this.app.config.coinwatch;
    const ds = (M.C30?.data?.datasets || []).filter((d) => !(C.ignoreLabels || []).some((x) => namePos(d.label, x) === 0));
    const rank = [...ds].sort((a, b) => (cwAvg24h(b.points) || 0) - (cwAvg24h(a.points) || 0));
    const shown = ds.length > 8 ? rank.slice(0, 7) : rank;
    const alpha = [...shown].map((d) => d.label).sort();
    const series = shown.map((d) => ({ label: d.label, slot: alpha.indexOf(d.label) + 1, points: d.points }));
    if (ds.length > 8) series.push({ label: `Other (${rank.length - 7})`, slot: 8, points: cwSumSeries(rank.slice(7)) });
    const chart = M.C30?.error && !M.C30?.data ? `<div class="area-ph short">${esc(M.C30.error)}</div>` : !M.C30?.data ? `<div class="area-ph short">Loading\u2026</div>`
      : this.lineChart(`cwx:${token}`, series, { height: 240, fmt: (v) => `${amount(v, 0)} ${token}`, label: `Depth +/-${M.bp} bps by venue, 30 days`, legend: true });
    return `<div class="card"><div class="tbl"><table>
      <colgroup><col style="width:26%"><col><col style="width:14%"><col style="width:18%"><col style="width:230px"></colgroup>
      <thead><tr><th>Exchange</th><th class="r">Volume 24h</th><th class="r">Spread 24h</th><th class="r">Depth \u00b1${M.bp} bps</th><th class="r"${tipAttr(`Volume traded by our market makers (${M.ourNames.length ? M.ourNames.join(", ") : "every market maker on the dashboard"}) on the venue / the venue's total volume (24 h)`)}>Our market makers</th></tr></thead>
      <tbody>${rows || this.waiting(5, M.loading.D ? "Loading\u2026" : "No exchange data")}</tbody></table></div></div>
      <div class="card chart-card cw-chart"><div class="chart-head"><span class="chart-title">Depth \u00b1${M.bp} bps by venue (30d)</span><span class="muted">${esc(token)}</span></div><div class="cw-chart-body">${chart}</div></div>`;
  }

  /** Trading pairs tab: config.js coinwatch.pairsTab = public (everyone) | private (once a key is entered) | hidden. */
  cwPairsVisible() {
    const mode = pairsTabMode(this.app.config.coinwatch);
    const cw = this.app.coinwatch;
    return mode === "public" || (mode === "private" && cw.hasKey() && !cw.authError);
  }

  pairFilter() {
    if (!this.cwPf) { try { this.cwPf = JSON.parse(localStorage.getItem("cv:v1:cwpairs") || "null"); } catch { this.cwPf = null; } }
    if (!this.cwPf || typeof this.cwPf !== "object") this.cwPf = { ex: "", mm: "", tk: "" };
    return this.cwPf;
  }

  setPairFilter(f) {
    this.cwPf = { ex: f.ex || "", mm: f.mm || "", tk: f.tk || "" };
    try { localStorage.setItem("cv:v1:cwpairs", JSON.stringify(this.cwPf)); } catch { /* ignore */ }
    this.tip?.hide();
    this.render();
  }

  /**
   * Every trading pair of the markets list (config.js coinwatch.markets), all tokens, grouped by exchange.
   * Only the list: no Coinwatch request. A pair's tokens are found in its name ("EURCV/USDCV" counts for both);
   * a pair listed under two tokens, or twice, is shown once with the union of its market makers.
   */
  cwPairsModel() {
    const C = this.app.config.coinwatch;
    const syms = Object.keys(C.tokens || {});
    const pk = (x) => nameWords(x).join("");
    const exchanges = [];
    for (const tok of syms) {
      for (const [exName, pairs] of Object.entries(C.markets?.[tok] || {})) {
        let e = exchanges.find((x) => pk(x.label) === pk(exName));
        if (!e) { e = { label: exName, pairs: [] }; exchanges.push(e); }
        for (const [label, mms] of Object.entries(pairs || {})) {
          let p = e.pairs.find((x) => x.key === pk(label));
          if (!p) { p = { key: pk(label), label, parts: pairParts(label), tokens: [], mms: [] }; e.pairs.push(p); }
          for (const m of Array.isArray(mms) ? mms : [mms]) if (m && !p.mms.some((x) => sameName(x, m))) p.mms.push(String(m));
          const t = pairTokens(label, syms);
          for (const x of t.length ? t : [tok]) if (!p.tokens.includes(x)) p.tokens.push(x);
        }
      }
    }
    // pairs by token (EURCV, USDCV, then pairs of two of our tokens), then by name; exchanges by number of pairs
    const tk = (p) => (p.tokens.length > 1 ? syms.length : Math.max(0, syms.indexOf(p.tokens[0])));
    for (const e of exchanges) e.pairs.sort((a, b) => tk(a) - tk(b) || a.label.localeCompare(b.label));
    exchanges.sort((a, b) => b.pairs.length - a.pairs.length || a.label.localeCompare(b.label));
    return { syms, exchanges: exchanges.filter((e) => e.pairs.length), pk };
  }

  /**
   * Filter menu in the DA (replaces a native <select>): a button "Label  Value", and when open a card-like
   * list with logos, the number of pairs each choice gives (choices giving none are disabled) and a check
   * on the current one. Open state in this._dd; closes on choice, outside click or Esc.
   */
  ddMenu(k, label, allTxt, opts, cur, count, set = "pairs") {
    const open = this._dd === k;
    const selOpt = opts.find((o) => o.v === cur);
    const item = (o) => {
      const n = count ? count(k, o.v) : null;
      const sel = o.v === cur;
      return `<button class="dd-item${sel ? " sel" : ""}" role="option" aria-selected="${sel}" data-ddv="${k}" data-ddset="${set}" data-v="${esc(o.v)}"${n == null || n || sel || !o.v ? "" : " disabled"}>
        ${o.lg || ""}<span class="t">${esc(o.t)}</span>${n == null ? "" : `<span class="n">${n}</span>`}<span class="ck">${sel ? icon("check") : ""}</span></button>`;
    };
    const menu = open ? `<div class="dd-menu" role="listbox" aria-label="${esc(label)}">${item({ v: "", t: allTxt })}<div class="dd-sep"></div>${opts.map(item).join("")}</div>` : "";
    return `<div class="dd${open ? " open" : ""}${cur ? " on" : ""}"><button class="dd-btn" data-dd="${k}" aria-haspopup="listbox" aria-expanded="${open}">
      <span class="k">${esc(label)}</span>${selOpt?.lg || ""}<span class="v">${esc(selOpt ? selOpt.t : allTxt)}</span>${icon("chevron")}</button>${menu}</div>`;
  }

  cwPairsPage(seg) {
    const M = this.cwPairsModel();
    const pk = M.pk;
    const F = { ...this.pairFilter() };

    const all = M.exchanges.flatMap((e) => e.pairs.map((p) => ({ e, p })));
    const mmNames = [];
    for (const { p } of all) for (const m of p.mms) if (!mmNames.some((x) => pk(x) === pk(m))) mmNames.push(m);
    mmNames.sort((a, b) => a.localeCompare(b));
    const cross = all.some(({ p }) => p.tokens.length > 1);
    const tokOpts = M.syms.filter((t) => all.some(({ p }) => p.tokens.includes(t))).map((t) => ({ v: t, t, lg: logo(this.logos.tokens?.[t], t, "sm") }));
    if (cross) tokOpts.push({ v: "cross", t: M.syms.length === 2 ? `${M.syms[0]} / ${M.syms[1]} pairs` : "Pairs of two of our tokens",
      lg: `<span class="tk-stack">${M.syms.slice(0, 2).map((t) => logo(this.logos.tokens?.[t], t, "sm")).join("")}</span>` });
    const exOpts = M.exchanges.map((e) => ({ v: pk(e.label), t: e.label, lg: this.cwLogo(e.label, "ex", "sm") }));
    const mmOpts = mmNames.map((m) => ({ v: pk(m), t: m, lg: this.cwLogo(m, "mm", "sm") }));
    // a filter value that no longer exists (list changed) is dropped
    if (F.ex && !exOpts.some((o) => o.v === F.ex)) F.ex = "";
    if (F.mm && !mmOpts.some((o) => o.v === F.mm)) F.mm = "";
    if (F.tk && !tokOpts.some((o) => o.v === F.tk)) F.tk = "";
    const ok = (e, p, f) => (!f.ex || pk(e.label) === f.ex) && (!f.mm || p.mms.some((m) => pk(m) === f.mm)) && (!f.tk || (f.tk === "cross" ? p.tokens.length > 1 : p.tokens.includes(f.tk)));
    const count = (k, v) => all.filter(({ e, p }) => ok(e, p, { ...F, [k]: v })).length;

    const shown = M.exchanges.map((e) => ({ e, pairs: e.pairs.filter((p) => ok(e, p, F)) })).filter((g) => g.pairs.length);
    const nPairs = shown.reduce((s2, g) => s2 + g.pairs.length, 0);
    const active = F.ex || F.mm || F.tk;
    const filters = all.length ? `<div class="cw-filters">
      ${this.ddMenu("ex", "Exchange", "All exchanges", exOpts, F.ex, count)}${this.ddMenu("mm", "Market maker", "All market makers", mmOpts, F.mm, count)}${this.ddMenu("tk", "Token", "All tokens", tokOpts, F.tk, count)}
      ${active ? `<button class="link-btn" data-cwf-clear>Clear filters</button>` : ""}
      <span class="sum">${nPairs} ${nPairs === 1 ? "pair" : "pairs"} on ${shown.length} ${shown.length === 1 ? "exchange" : "exchanges"}</span></div>` : "";

    const mmCell = (p) => p.mms.length
      ? `<span class="chips">${p.mms.map((m) => `<span class="chip${F.mm && pk(m) === F.mm ? " hl" : ""}">${this.cwLogo(m, "mm")}${esc(m)}</span>`).join("")}</span>`
      : `<span class="subtle"${tipAttr("No market maker on this pair in the list")}>None</span>`;
    const rows = shown.map(({ e, pairs }) => `<tr class="grp">
        <td colspan="2"><span class="cell">${this.cwLogo(e.label, "ex", "lg")}<span class="grp-name">${esc(e.label)}</span><span class="grp-n">${pairs.length} ${pairs.length === 1 ? "pair" : "pairs"}</span></span></td></tr>` +
      pairs.map((p) => `<tr class="sub">
        <td><span class="cell"><span class="tk-stack">${p.tokens.map((t) => logo(this.logos.tokens?.[t], t)).join("")}</span><span class="pair">${p.parts.map(esc).join("<i>/</i>")}</span></span></td>
        <td>${mmCell(p)}</td></tr>`).join("")).join("");

    const body = !all.length
      ? `<div class="card cw-key"><div class="card-body"><h3>No trading pairs yet</h3>
        <p class="muted">List them in <span class="mono">config.js</span> -> <span class="mono">coinwatch.markets</span>: exchange -> pair -> market makers.</p></div></div>`
      : `${filters}<div class="card"><div class="tbl"><table class="cw-mm cw-pr">
        <colgroup><col style="width:42%"><col></colgroup>
        <thead><tr><th>Exchange / pair</th><th>Market makers</th></tr></thead>
        <tbody>${rows || this.waiting(2, "No pair matches these filters")}</tbody></table></div></div>`;
    const pill = `<span class="links"><span class="src ok"${tipAttr("Your markets list: config.js -> coinwatch.markets")}><i></i><b>Markets list</b><span>config.js</span></span></span>`;
    return `<div class="pool-nav">${seg}${pill}</div><section class="cw-pairs-page">${body}</section>
      <div class="cw-foot"><span class="subtle">From the markets list of config.js (coinwatch.markets).</span></div>`;
  }

  /** Diagnostics: shape of every Coinwatch answer in cache (to check the parsing against the real API). */
  cwInventory() {
    const inv = this.app.coinwatch?.inventory() || [];
    if (!inv.length) return "";
    const t = this.app.coinwatch.targets;
    return `<h4>Coinwatch answers in cache</h4><p class="muted">Company / dashboard found: ${esc(Object.entries(t).map(([k, v]) => `${k} = ${v.company}${v.dashboard ? ` / ${v.dashboard}` : ""}`).join(", ") || "not yet")}</p>
      <div class="card"><div class="tbl"><table class="dense"><thead><tr><th>Request</th><th class="r">Age</th><th>Datasets (label: points, step, min - max)</th></tr></thead><tbody>
      ${inv.map((x) => `<tr><td class="mono">${esc(x.id)}</td><td class="r">${age(x.at)}</td><td class="note">${esc((x.datasets || []).slice(0, 6).map((d) => `${d.label}: ${d.n} pts, ${d.step ?? "-"} s, ${d.min} - ${d.max}`).join(" | "))}${(x.datasets?.length || 0) > 6 ? ` | +${x.datasets.length - 6} more` : ""}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  }

  /* ---------------- dialogs ---------------- */

  /** Everything that used to be a banner: config errors/warnings, module warnings, failing sources. */
  problems() {
    const out = [];
    const c = this.app.config;
    c.errors.forEach((e) => out.push(["Config error", e]));
    c.warnings.forEach((e) => out.push(["Config", e]));
    const cw = this.app.coinwatch;
    if (cw?.authError) out.push(["Coinwatch", cw.authError.error]);
    for (const msg of new Set(Object.values(cw?.errors || {}).map((x) => x.error))) out.push(["Coinwatch", msg]);
    if (this._cwUnitWarn) out.push(["Coinwatch", this._cwUnitWarn]);
    for (const m of this.app.modules) {
      const env = this.env(m.storeId);
      (env?.warnings || []).forEach((w) => out.push([MODULE_NAMES[m.storeId] || m.storeId, w]));
      for (const [k, s] of Object.entries(env?.sources || {})) if (s.status === "error" || s.status === "stale") out.push([`${MODULE_NAMES[m.storeId] || m.storeId} \u00b7 ${c.chains[k]?.label || SOURCE_LABELS[k] || k}`, s.error || s.status]);
    }
    return out;
  }

  dialog(id, title, desc, body, foot) {
    const dlg = /** @type {HTMLDialogElement} */ (document.getElementById(id));
    dlg.innerHTML = `<div class="dlg-h"><span>${esc(title)}</span><button class="icon-btn" data-close>${icon("x")}</button></div>
      ${desc ? `<div class="dlg-d">${desc}</div>` : ""}<div class="dlg-b">${body}</div>${foot ? `<div class="dlg-f">${foot}</div>` : ""}`;
    dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
    if (!dlg.open) dlg.showModal();
    return dlg;
  }

  openSettings() {
    const settings = getSettings();
    const chains = Object.entries(this.app.config.chains).filter(([, c]) => c.enabled);
    const dlg = this.dialog("dlg-settings", "RPC settings",
      `Endpoints entered here replace those of <span class="mono">config.js</span> for that chain, in this browser only. One URL per line. Leave empty to use the config.`,
      chains.map(([k, c]) => `<label class="field">${esc(c.label)}<textarea name="${esc(k)}" rows="2" placeholder="${esc(c.endpoints.map((e) => e.url).join("\n"))}">${esc((settings.rpc?.[k] || []).join("\n"))}</textarea></label>`).join(""),
      `<div><button class="btn" id="s-clear"${tipAttr("Clears cached results, history and learned endpoint limits")}>Clear local cache</button><button class="btn" id="s-reset">Reset to config</button><button class="btn" id="s-layout"${tipAttr("Every page back to its default layout, on every screen size")}>Reset layouts</button></div>
       <div><button class="btn" data-close>Cancel</button><button class="btn primary" id="s-save">Save &amp; reload</button></div>`);
    dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
    dlg.querySelector("#s-save").addEventListener("click", () => {
      const rpc = {};
      for (const [k] of chains) {
        const ta = /** @type {HTMLTextAreaElement|null} */ (dlg.querySelector(`textarea[name="${k}"]`));
        const urls = (ta?.value || "").split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
        if (urls.length) rpc[k] = urls;
      }
      saveSettings({ ...settings, rpc });
      location.reload();
    });
    dlg.querySelector("#s-reset").addEventListener("click", () => { saveSettings({ ...settings, rpc: {} }); location.reload(); });
    dlg.querySelector("#s-layout").addEventListener("click", () => {
      try { localStorage.removeItem(LAYOUT_KEY); } catch { /* ignore */ }
      this.layouts = readLayouts();
      dlg.close();
      this._lastHtml = null;
      this.render(true);
      this.renderEditBar();
    });
    dlg.querySelector("#s-clear").addEventListener("click", () => { const keep = getSettings(); storage.clearAll(); saveSettings(keep); location.reload(); });
  }

  openDiag() {
    const draw = () => {
      const s = this.app.stats;
      const probs = this.problems();
      const table = (rows, title) => `<h4>${esc(title)}</h4><div class="card"><div class="tbl"><table class="dense">
        <thead><tr><th>Key</th><th class="r">Last hour</th><th class="r">Total</th><th class="r">Sub-calls</th><th class="r">Errors</th><th class="r">429</th><th class="r">p50 ms</th><th class="r">p95 ms</th><th>Last error</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="mono">${esc(r.key)}</td><td class="r">${num(r.lastHour)}</td><td class="r">${num(r.total)}</td><td class="r">${num(r.subcalls)}</td><td class="r">${num(r.errors)}</td><td class="r">${num(r.rateLimited)}</td><td class="r">${r.p50 ?? DASH}</td><td class="r">${r.p95 ?? DASH}</td><td class="err-txt">${esc(r.lastError || "")}</td></tr>`).join("") || this.waiting(9, "No request yet")}</tbody></table></div></div>`;
      const health = Object.entries(this.app.adapters).flatMap(([k, a]) => a.pool.health().map((h) => ({ scope: k, ...h })))
        .concat(Object.entries(this.app.apiPools).flatMap(([k, p]) => p.health().map((h) => ({ scope: k, ...h }))));
      return `<p class="muted">Dashboard ${esc(VERSION)}${DOT}tab role: <b>${esc(this.app.tabs.role)}</b>${DOT}counting since ${esc(new Date(s.startedAt).toLocaleTimeString("en-GB"))}${DOT}skipped ticks: ${num(s.skippedTicks)}</p>
        <h4>Warnings</h4>${probs.length ? `<ul class="probs">${probs.map(([w, m]) => `<li><b>${esc(w)}</b><span>${esc(m)}</span></li>`).join("")}</ul>` : `<p class="muted">None.</p>`}
        <h4>Endpoints</h4><div class="card"><div class="tbl"><table class="dense"><thead><tr><th>Scope</th><th>Endpoint</th><th>Status</th><th>Last error</th></tr></thead><tbody>
        ${health.map((h) => `<tr><td>${esc(h.scope)}</td><td class="mono"${tipAttr(h.url)}>${esc(h.id)}</td><td>${h.healthy ? '<span class="ok-txt">ok</span>' : `<span class="warn-txt">cooldown ${Math.ceil(h.cooldownMs / 1000)}s</span>`}</td><td class="err-txt">${esc(h.lastError || "")}</td></tr>`).join("")}
        </tbody></table></div></div>
        ${table(s.rows("endpoint"), "Requests by endpoint")}${table(s.rows("module"), "Requests by module")}${table(s.rows("method"), "Requests by method")}
        ${this.cwInventory()}`;
    };
    const dlg = this.dialog("dlg-diag", "Diagnostics", "", draw(), "");
    const body = dlg.querySelector(".dlg-b");
    // redrawn every 3 s: keep both the vertical and the horizontal scroll positions
    const t = setInterval(() => {
      if (!dlg.open) return clearInterval(t);
      const top = body.scrollTop;
      const lefts = [...body.querySelectorAll(".tbl")].map((e) => e.scrollLeft);
      body.innerHTML = draw();
      body.scrollTop = top;
      body.querySelectorAll(".tbl").forEach((e, i) => { e.scrollLeft = lefts[i] || 0; });
    }, 3000);
  }
}

/* ================================================================================================
 * 25. MAIN: wiring and boot
 * ================================================================================================ */
/**
 * Entry point: loads config, builds pools/adapters/modules, wires the router, tabs and scheduler.
 */

const ADAPTERS = { evm: EvmAdapter, solana: SolanaAdapter, stellar: StellarAdapter, xrpl: XrplAdapter };

export const ROUTES = {
  "#/coinvertible/monitoring": "monitoring",
  "#/coinvertible/coinwatch": "coinwatch",
  "#/defi/morpho": "morpho",
  "#/defi/uniswap": "uniswap",
};

/** "#/defi/uniswap/eurcv-eurc" -> { page: "uniswap", sub: "eurcv-eurc" }; null if unknown. */
export function parseRoute(hash, config) {
  if (ROUTES[hash]) return { page: ROUTES[hash], sub: null };
  const m = /^#\/defi\/uniswap\/([a-z0-9-]+)$/.exec(hash || "");
  if (m && config.uniswap.pools.some((p) => p.slug === m[1])) return { page: "uniswap", sub: m[1] };
  const w = /^#\/coinvertible\/coinwatch\/([a-z0-9-]+)$/.exec(hash || "");
  if (w && Object.keys(config.coinwatch?.tokens || {}).some((t) => t.toLowerCase() === w[1])) return { page: "coinwatch", sub: w[1] };
  // Trading pairs: whether it is shown (public / private / hidden) is decided by the page (first token otherwise)
  if (w && w[1] === "pairs") return { page: "coinwatch", sub: "pairs" };
  return null;
}

/** Build the app (no DOM needed: also used by the Node smoke test). */
export async function createApp() {
  const config = await loadConfig();
  const stats = new Stats();
  const store = new Store();
  const bus = new Emitter();
  const labels = new Labels(config.known, config.chains);

  /** @type {Record<string, any>} */
  const adapters = {};
  for (const [key, c] of Object.entries(config.chains)) {
    if (!c.enabled) continue;
    const pool = new RpcPool(key, c.endpoints, { timeoutMs: config.timeoutMs, stats });
    adapters[key] = new ADAPTERS[c.type](key, c, pool);
  }
  const apiPools = Object.fromEntries(Object.entries(config.apis).map(([k, a]) => [k, new RpcPool(k, [a], { timeoutMs: config.timeoutMs, stats })]));
  const tabs = new Tabs(config.frequency.behaviour);

  const app = { config, stats, store, bus, labels, adapters, apiPools, tabs, modules: /** @type {any[]} */ ([]), scheduler: /** @type {any} */ (null), morphoHistory: /** @type {any} */ (null), coinwatch: /** @type {any} */ (null) };
  app.morphoHistory = new MorphoHistory(app);
  app.coinwatch = new CoinwatchService(app);
  app.modules = [new SupplyModule(app), new SupplyHistoryModule(app), new MintBurnModule(app), new MorphoModule(app), new UniswapModule(app)];
  if (config.aggregators && !config.errors.some((e) => e.startsWith("aggregators"))) app.modules.push(new AggregatorsModule(app));
  app.scheduler = new Scheduler(app);
  return app;
}

async function boot() {
  const app = await createApp();
  // @ts-ignore
  window.cvApp = app;
  // @ts-ignore
  window.cvStats = app.stats;
  app.store.loadCached();

  const ui = new UI(app, document.getElementById("root"));
  const { tabs, scheduler, store } = app;

  tabs.on("role", (role) => {
    if (role === "leader") scheduler.start(); else scheduler.stop();
    ui.renderSoon();
  });
  tabs.on("message", (m) => {
    if (!m || typeof m !== "object") return;
    if (m.type === "result" && !tabs.isLeader()) store.set(m.id, deserialize(m.env), { remote: true });
    if (m.type === "hello" && tabs.isLeader() && m.page === tabs.page) {
      for (const mod of app.modules) if (mod.page === tabs.page) {
        const env = store.get(mod.storeId);
        if (env) tabs.post({ type: "result", id: mod.storeId, env: serialize(env) });
      }
    }
  });
  store.on("local", ({ id, envelope }) => { if (tabs.isLeader()) tabs.post({ type: "result", id, env: serialize(envelope) }); });
  tabs.on("gates", () => scheduler.kick());
  app.labels.on("change", () => ui.renderSoon());
  app.morphoHistory.on("change", () => ui.renderSoon());
  app.coinwatch.on("change", () => ui.renderSoon());

  // Sub-pages (one per Uniswap pool) only re-render: the scheduler and the tab leadership are per page,
  // so switching pool is as fast as switching back and forth between two pages already loaded.
  let current = null;
  const route = () => {
    let r = parseRoute(location.hash, app.config);
    if (!r) { history.replaceState(null, "", "#/coinvertible/monitoring"); r = { page: "monitoring", sub: null }; }
    if (r.page !== current) {
      current = r.page;
      scheduler.setPage(r.page);
      tabs.setPage(r.page);
    }
    ui.setPage(r.page, r.sub);
  };
  window.addEventListener("hashchange", route);
  route();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  boot().catch((e) => {
    console.error(e);
    const el = document.getElementById("root");
    if (el) el.innerHTML = `<p class="boot-error">Startup error: ${String(e?.message || e).replace(/[<&]/g, "")}</p>`;
  });
}
