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
 *   23. UI: formatting, icons, logos, tooltip
 *   24. UI: shell and pages
 *   25. MAIN: wiring and boot
 */

/* ================================================================================================
 * 1. CORE: utilities
 * ================================================================================================ */
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
   * @param {{method: string, module?: string, filter?: (ep:any)=>boolean, subcalls?: number, onError?: (ep:any, err:RpcError)=>void, info?: any}} o
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
        o.onError?.(ep, err);
        if (["rate", "http", "timeout", "network", "rpc"].includes(err.kind)) this._cooldown(ep, err);
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
    if (Number.isFinite(rem) && Number.isFinite(lim) && lim > 0 && rem <= Math.max(1, lim * 0.02) && Number.isFinite(reset)) {
      ep.cooldownUntil = Math.max(ep.cooldownUntil, Date.now() + reset * 1000);
    }
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after"));
      throw new RpcError("HTTP 429", { kind: "rate", code: 429, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : undefined });
    }
    if (!r.ok) throw new RpcError(`HTTP ${r.status}`, { kind: r.status === 413 ? "range" : "http", code: r.status });
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

  /** REST GET relative to the endpoint base URL. */
  getJson(path, o = {}) {
    return this.send((ep) => this._fetch(ep, ep.url + path, { method: "GET" }), { ...o, method: o.label || "GET " + path.split("?")[0] });
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
  const FREQUENCY = C.frequency, TOKENS = C.tokens, MORPHO = C.morpho, UNISWAP = C.uniswap;
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

  for (const v of MORPHO.vaults) if (!isHexAddress(v.address)) errors.push(`morpho.vaults: invalid address ${v.address}`);
  for (const m of MORPHO.markets) if (!isHex32(m.id)) errors.push(`morpho.markets: invalid market id ${m.id}`);
  if (!TOKENS[MORPHO.asset]?.deployments?.[MORPHO.chain]) errors.push(`morpho.asset: ${MORPHO.asset} not deployed on ${MORPHO.chain}`);
  for (const p of UNISWAP.pools) {
    if (!isHexAddress(p.address)) errors.push(`uniswap.pools: invalid address ${p.address}`);
    if (!/^[a-z0-9-]+$/.test(p.slug || "")) errors.push(`uniswap.pools: missing or invalid slug for ${p.label || p.address} (lowercase letters, digits, "-")`);
  }
  for (const k of ["npm", "tickLens"]) if (!isHexAddress(UNISWAP[k])) errors.push(`uniswap.${k}: invalid address`);

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
  // Chainlink
  latestRoundData: "0xfeaf968c", // latestRoundData()
};

export const TOPIC = {
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  RedemptionStarted: "0x8c0cc6a0302d83caa04c8ad7d86864df08505193f7cb978c03d53a765b09696b",
  UniMint: "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",
  UniBurn: "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c",
  IncreaseLiquidity: "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f",
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
    this.sourceFail(chain, err);
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
    super(app, { id: "monitoring.supply", page: "monitoring", chains: used, schedules: [{ id: "monitoring.supply" }] });
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
      for (const c of Object.values(chains)) {
        c.share = c.amount != null && total > 0n ? Number(parseUnits(c.amount, TOTAL_DECIMALS)) / Number(total) : null;
      }
      out[sym] = { name: t.name, currency: t.currency, total: formatUnits(total, TOTAL_DECIMALS), partial, chains };
    }
    return out;
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
 * DeFi/Morpho - vaults and markets for one asset (EURCV), all numbers read on-chain.
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

export class MorphoModule extends Module {
  constructor(app) {
    const cfg = app.config.morpho;
    super(app, {
      id: "morpho", page: "morpho", chains: [cfg.chain],
      schedules: [
        { id: "morpho.vaults" },
        { id: "morpho.vaults.others", gate: "morpho.vaults.others" },
        { id: "morpho.markets" },
        { id: "morpho.markets.others", gate: "morpho.markets.others" },
      ],
    });
    this.cfg = cfg;
    this.chain = cfg.chain;
    const dep = app.config.tokens[cfg.asset].deployments[cfg.chain];
    this.asset = lc(dep.address);
    this.assetSymbol = cfg.asset;
    this.assetDecimals = dep.decimals;
    this.morpho = cfg.morphoBlue;
    this.chainId = app.config.chains[cfg.chain].chainId;
    this.disc = storage.get("morpho:discovery:v2", null);
    /** immutable: market params and token metadata */
    this.imm = storage.get("morpho:imm", null) || { params: {}, tokens: {} };
    /** structure per vault address */
    this.structs = storage.get("morpho:struct", null) || {};
    this.samples = storage.get("morpho:buffers", null) || {};
    /** last outputs (kept across ticks so groups refreshed at different times can be published together) */
    this.outVaults = new Map();
    this.outMarkets = new Map();
    /** raw per market for totals */
    this.rawMarkets = new Map();
    this._discP = null;
    if (this.disc) this.labelVaults();
  }

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
        storage.set("morpho:discovery:v2", this.disc);
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
    storage.set("morpho:imm", this.imm);
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
    storage.set("morpho:struct", this.structs);
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

  async run(chain, ctx, dueIds) {
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

    this.sourceOk(chain, ctx.info());
    this.publish(this.build(vaults, markets));
  }

  /** Link to the Morpho app page of a vault or market (base URL in config.js -> morpho.appUrl). */
  appUrl(kind, id, name) {
    const base = (this.cfg.appUrl || "https://app.morpho.org/ethereum").replace(/\/$/, "");
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
      apy, nativeApy: apy, incentiveApy: null,
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
      apy: r.apy, nativeApy: r.nativeApy, incentiveApy: r.incentiveApy, capApy: r.capApy,
      fees: { performance: wadToFloat(st.performanceFee) || 0, management: (wadToFloat(st.managementFee) || 0) * YEAR },
      allocation: rows,
    };
    if (v.incentives) {
      const t = Number(ctx.blockTime ?? Math.floor(Date.now() / 1000));
      const arr = (this.samples[v.key] ||= []);
      if (!arr.length || arr[arr.length - 1].t !== t) arr.push({ t, buffer: r.buffer });
      while (arr.length > 2 && arr[0].t < t - SAMPLE_KEEP_SEC) arr.shift();
      if (arr.length > 800) arr.splice(0, arr.length - 800);
      storage.set("morpho:buffers", this.samples);
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

  build(vaults, markets) {
    const vs = [...this.outVaults.values()].filter((v) => vaults.has(v.key));
    vs.forEach((v) => { v.whitelist = vaults.get(v.key).whitelist; });
    vs.sort((a, b) => Number(b.whitelist) - Number(a.whitelist) || Number(b.totalDeposits || 0) - Number(a.totalDeposits || 0));
    const ms = [...this.outMarkets.values()].filter((m) => markets.has(m.id));
    ms.forEach((m) => { m.whitelist = markets.get(m.id).whitelist; });
    ms.sort((a, b) => Number(b.whitelist) - Number(a.whitelist) || Number(b.totalSupplied) - Number(a.totalSupplied));
    const d = this.assetDecimals;
    // Totals over whitelisted markets, and over every market currently read (whitelisted + "Show more").
    const totals = (pick) => {
      let sup = 0n, bor = 0n, n = 0;
      for (const m of ms) if (pick(m)) { const r = this.rawMarkets.get(m.id); if (r) { sup += r.supply; bor += r.borrow; n++; } }
      return { totalSupplied: formatUnits(sup, d), totalBorrowed: formatUnits(bor, d), utilization: sup > 0n ? Number((bor * 10n ** 12n) / sup) / 1e12 : 0, markets: n };
    };
    const othersVaults = [...vaults.values()].filter((v) => !v.whitelist).length;
    const othersMarkets = [...markets.values()].filter((m) => !m.whitelist && !m.idle).length;
    const override = this.cfg.mainVault ? lc(this.cfg.mainVault) : null;
    const main = (override && vs.find((v) => v.key === override)) || vs.filter((v) => v.whitelist).reduce((a, v) => (!a || Number(v.totalDeposits || 0) > Number(a.totalDeposits || 0) ? v : a), null);
    return {
      asset: this.assetSymbol,
      mainVault: main ? main.key : null,
      mainVaultSource: main ? (override && main.key === override ? "config" : "largest deposits") : null,
      overview: totals((m) => m.whitelist),
      overviewAll: totals(() => true),
      vaults: vs,
      markets: ms,
      counts: { othersVaults, othersMarkets },
      discoveryAt: this.disc?.at || null,
    };
  }
}

/* ================================================================================================
 * 22. MODULE: Uniswap
 * ================================================================================================ */
/**
 * DeFi/Uniswap - whitelisted v3 pools only.
 *   uniswap.pools     (every block, one coalesced multicall): token balances, slot0, liquidity(),
 *                     initialized ticks (TickLens) and the Chainlink oracles. Peg, TVL, depth, sale
 *                     impact and the liquidity distribution are computed locally from these.
 *   uniswap.positions (every 60 s): LP positions. Mint/Burn history of the pools (one large eth_getLogs
 *                     the first time, cached; then only the new blocks). Liquidity minted through the
 *                     NonfungiblePositionManager is resolved to NFT ids with a few tx receipts (only for
 *                     ranges that still hold liquidity), then positions(id) / ownerOf(id) each run.
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
 *        fee in pips (100 = 0.01%), ticks sorted ascending
 * @param {boolean} zeroForOne token0 in (price goes down)
 * @param {{amountIn?:number, sqrtLimit?:number}} o raw input (fee included) and/or price limit
 * @returns {{amountIn:number, amountOut:number, sqrtEnd:number, exhausted:boolean, drained:boolean}}
 *          exhausted: the input could not be fully used; drained: no liquidity left at the end price
 */
export function v3Swap(s, zeroForOne, o = {}) {
  const fee = s.fee / 1e6;
  const ticks = s.ticks;
  let sq = s.sqrtP, L = s.L;
  // float sums of liquidityNet leave a residue where the true liquidity is 0
  const eps = 1e-9 * ticks.reduce((m, x) => Math.max(m, Math.abs(x.net)), s.L);
  let rem = o.amountIn == null ? Infinity : o.amountIn * (1 - fee);
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
  return { amountIn: used / (1 - fee), amountOut: out, sqrtEnd: sq, exhausted, drained: exhausted || L <= eps };
}

const HISTORY_RETRY_MS = 300000;
const RECEIPTS_PER_ROUND = 4;
const RECEIPTS_KEEP = 2000;

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
    this.npm = cfg.npm.toLowerCase();
    /** pool -> { token0, token1, t0:{symbol,decimals}, t1:{...}, fee, spacing } */
    this.meta = storage.get(`uniswap:meta:v2:${this.chain}`, null) || {};
    /** pool -> live state of the last block */
    this.state = {};
    /** pool -> extra TickLens words added after an incomplete tick map */
    this.extraWords = {};
    /** oracle key -> { value, label, address, updatedAt, fallback, reason } */
    this.oracles = {};
    this.vol = {};
    /** LP history: { pools: { [pool]: { to, direct: {"owner|tl|tu": L}, ranges: {"tl|tu": {net, txs[]}} } } } */
    this.lp = storage.get(`uniswap:lp:v1:${this.chain}`, null) || { pools: {} };
    /** tx hash -> NFT ids minted/increased in it (IncreaseLiquidity of the position manager) */
    this.receipts = storage.get(`uniswap:receipts:v1:${this.chain}`, null) || {};
    /** NFT id -> { pool, owner, tl, tu, L } (current, from positions(id)) */
    this.nft = {};
    this.history = { status: "pending", error: null, at: null };
    this._historyRetryAt = 0;
  }

  pools() {
    return this.cfg.pools.map((p) => ({ ...p, key: p.address.toLowerCase() }));
  }

  async ensureMeta(ctx) {
    const pools = this.pools().map((p) => p.key).filter((a) => !this.meta[a]?.t1?.decimals || this.meta[a].spacing == null);
    if (!pools.length) return;
    const res = await ctx.call(pools.flatMap((a) => [call(a, "token0"), call(a, "token1"), call(a, "fee"), call(a, "tickSpacing")]), this.id);
    const tokens = new Set();
    const pairs = {};
    pools.forEach((a, i) => {
      const t0 = dec.addr(res[i * 4]), t1 = dec.addr(res[i * 4 + 1]), fee = dec.uint(res[i * 4 + 2]), sp = dec.int(res[i * 4 + 3]);
      if (!t0 || !t1 || fee == null || sp == null) { this.warn(`pool:${a}`, `${a}: token0()/token1()/fee()/tickSpacing() failed - is it a Uniswap v3 pool?`); return; }
      this.clearWarn(`pool:${a}`);
      pairs[a] = { token0: t0, token1: t1, fee: Number(fee), spacing: Number(sp) };
      tokens.add(t0); tokens.add(t1);
    });
    const tl = [...tokens];
    const r2 = await ctx.call(tl.flatMap((t) => [call(t, "symbol"), call(t, "decimals")]), this.id);
    const tm = {};
    tl.forEach((t, i) => { tm[t] = { symbol: dec.string(r2[i * 2]) || "?", decimals: Number(dec.uint(r2[i * 2 + 1]) ?? 18n) }; });
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
      await this.runPools(chain, ctx);
      this.publish(this.build());
    }
    if (ids.includes("uniswap.positions")) {
      await this.runPositions(ctx);
      await this.refreshTicks(ctx);
      this.publish(this.build());
    }
  }

  /* ---------------- per block: pools + oracles ---------------- */

  /** TickLens words to read for a pool: around the price, every open position's bounds, extras. */
  wordsFor(a, tick) {
    const m = this.meta[a];
    const sp = m.spacing;
    const set = new Set();
    const w = tickWord(tick, sp);
    for (let d = -1; d <= 1; d++) set.add(w + d);
    // open positions from the LP history (also the copy cached from the last visit, before it is refreshed)
    const P = this.lp.pools[a];
    if (P) {
      for (const k of Object.keys(P.direct)) { const [, tl, tu] = k.split("|"); set.add(tickWord(+tl, sp)); set.add(tickWord(+tu, sp)); }
      for (const k of Object.keys(P.ranges)) { const [tl, tu] = k.split("|"); set.add(tickWord(+tl, sp)); set.add(tickWord(+tu, sp)); }
    }
    if (!P || this.history.status !== "ok") {
      set.add(tickWord(Math.ceil(MIN_TICK / sp) * sp, sp));
      set.add(tickWord(Math.floor(MAX_TICK / sp) * sp, sp));
    }
    for (const e of this.extraWords[a] || []) set.add(w + e);
    return [...set].filter((x) => x >= -32768 && x <= 32767).sort((x, y) => x - y);
  }

  async readTicks(ctx, a, words) {
    const lens = this.cfg.tickLens;
    const res = await ctx.call(words.map((w) => call(lens, "getPopulatedTicksInWord", enc.addr(a), enc.int(w))), this.id);
    const ticks = [];
    let ok = true;
    res.forEach((r) => { const t = decodePopulatedTicks(r); if (t == null) ok = false; else ticks.push(...t); });
    return { ok, ticks: ticks.sort((x, y) => x.tick - y.tick), words };
  }

  async runPools(chain, ctx) {
    await this.ensureMeta(ctx);
    const pools = this.pools().filter((p) => this.meta[p.key]);
    const feeds = Object.entries(this.cfg.oracles || {}).flatMap(([k, o]) => o.feeds.map((f, i) => ({ key: k, i, f })));
    const calls = [];
    for (const p of pools) {
      const m = this.meta[p.key];
      calls.push(call(m.token0, "balanceOf", enc.addr(p.key)), call(m.token1, "balanceOf", enc.addr(p.key)), call(p.key, "slot0"), call(p.key, "liquidity"));
    }
    // Ticks with the words of the previous block's price (re-read below if the price changed word).
    const tickReads = pools.map((p) => (this.state[p.key] ? this.readTicks(ctx, p.key, this.wordsFor(p.key, this.state[p.key].tick)) : null));
    const [res, fres] = await Promise.all([ctx.call(calls, this.id), ctx.call(feeds.map((x) => call(x.f.address, "latestRoundData")), this.id)]);
    this.readOracles(feeds, fres, ctx.blockTime);

    await Promise.all(pools.map(async (p, i) => {
      const a = p.key;
      const b0 = dec.uint(res[i * 4]), b1 = dec.uint(res[i * 4 + 1]);
      const sqrtX96 = dec.uint(res[i * 4 + 2]), tick = dec.int(res[i * 4 + 2], 1), L = dec.uint(res[i * 4 + 3]);
      if (sqrtX96 == null || tick == null || L == null) { this.warn(`slot0:${a}`, `${p.label}: slot0()/liquidity() failed`); return; }
      this.clearWarn(`slot0:${a}`);
      const t = Number(tick);
      let tk = await tickReads[i];
      if (!tk || !this.wordsFor(a, t).every((w) => tk.words.includes(w))) tk = await this.readTicks(ctx, a, this.wordsFor(a, t));
      this.state[a] = { b0, b1, sqrtX96, tick: t, L, ticks: tk.ticks, complete: this.checkTicks(p, tk, t, L, ctx.block), block: ctx.block };
    }));
    this.sourceOk(chain, ctx.info());
  }

  /**
   * The tick map is complete when every position's +L/-L pair is in it (sum of net = 0) and the
   * liquidity it gives at the current tick equals liquidity(). Otherwise more words are read
   * (same block after the LP history arrives, else next block).
   */
  checkTicks(p, tk, t, L, block) {
    const a = p.key;
    let sum = 0n, below = 0n;
    for (const x of tk.ticks) { sum += x.net; if (x.tick <= t) below += x.net; }
    const complete = tk.ok && sum === 0n && below === L;
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
      const st = this.state[p.key];
      const tk = await this.readTicks(ctx, p.key, this.wordsFor(p.key, st.tick));
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
    await this.resolveNfts(ctx);
  }

  async updateHistory(ctx) {
    if (this.history.status === "error" && Date.now() < this._historyRetryAt) return;
    const head = ctx.logHead;
    const pools = this.pools();
    const fresh = pools.filter((p) => !this.lp.pools[p.key]);
    const known = pools.filter((p) => this.lp.pools[p.key] && this.lp.pools[p.key].to < head);
    const jobs = [];
    if (fresh.length) jobs.push({ pools: fresh, from: Math.min(...fresh.map((p) => p.createdBlock || 0)) });
    if (known.length) jobs.push({ pools: known, from: Math.min(...known.map((p) => this.lp.pools[p.key].to + 1)) });
    const HISTORY_MAX_CHUNKS = 10;
    try {
      for (const j of jobs) {
        // Never split a long history into hundreds of small requests: without an endpoint serving large
        // ranges (NOWNodes), report the history as unavailable instead.
        const maxRange = this.app.adapters[this.chain].pool.maxOf("maxLogRange", (ep) => ep.capabilities.has("logs"));
        if ((head - j.from + 1) / maxRange > HISTORY_MAX_CHUNKS) throw new Error(`no endpoint serves eth_getLogs over ${num(head - j.from + 1)} blocks (largest range: ${num(maxRange)})`);
        const logs = await ctx.logs({ address: j.pools.map((p) => p.key), topics: [[TOPIC.UniMint, TOPIC.UniBurn]] }, j.from, head, "uniswap.positions");
        logs.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)));
        for (const p of j.pools) this.lp.pools[p.key] ||= { to: 0, direct: {}, ranges: {} };
        for (const l of logs) {
          const P = this.lp.pools[l.address.toLowerCase()];
          if (!P || Number(BigInt(l.blockNumber)) <= P.to) continue;
          const mint = l.topics[0].toLowerCase() === TOPIC.UniMint;
          const owner = topicAddr(l.topics[1]);
          const tl = Number(int256(BigInt(l.topics[2]))), tu = Number(int256(BigInt(l.topics[3])));
          const amt = logWord(l.data, mint ? 1 : 0);
          if (owner === this.npm) {
            const k = `${tl}|${tu}`;
            const r = (P.ranges[k] ||= { net: 0n, txs: [] });
            r.net += mint ? amt : -amt;
            if (mint && !r.txs.includes(l.transactionHash)) r.txs.push(l.transactionHash);
            if (r.net <= 0n) delete P.ranges[k]; // closed: its NFTs are empty, forget their txs
          } else {
            const k = `${owner}|${tl}|${tu}`;
            const v = (P.direct[k] || 0n) + (mint ? amt : -amt);
            if (v > 0n) P.direct[k] = v; else delete P.direct[k];
          }
        }
        for (const p of j.pools) this.lp.pools[p.key].to = head;
      }
      storage.set(`uniswap:lp:v1:${this.chain}`, this.lp);
      this.history = { status: "ok", error: null, at: Date.now() };
      this.clearWarn("history");
    } catch (e) {
      const first = fresh.length > 0 && !Object.keys(this.lp.pools).length;
      this.history = { status: first || this.history.status !== "ok" ? "error" : "stale", error: String(e?.message || e).slice(0, 200), at: this.history.at };
      this._historyRetryAt = Date.now() + HISTORY_RETRY_MS;
      this.warn("history", `LP history unavailable (${this.history.error}). It needs an endpoint serving large eth_getLogs ranges (NOWNodes); retried in 5 min.`);
    }
  }

  async receipt(tx) {
    const r = await this.app.adapters[this.chain].pool.jsonRpc("eth_getTransactionReceipt", [tx], { module: "uniswap.positions", filter: (ep) => ep.capabilities.has("calls") });
    const ids = (r?.logs || []).filter((l) => l.address.toLowerCase() === this.npm && l.topics[0]?.toLowerCase() === TOPIC.IncreaseLiquidity).map((l) => BigInt(l.topics[1]).toString());
    this.receipts[tx] = [...new Set(ids)];
  }

  /** Read positions(id) + ownerOf(id) for the NFT ids of the open ranges; resolve more txs when sums do not match. */
  async resolveNfts(ctx) {
    if (this.history.status === "pending") return;
    const npm = this.cfg.npm;
    let fetched = false;
    for (let round = 0; round < 3; round++) {
      const ids = new Set();
      for (const P of Object.values(this.lp.pools)) for (const r of Object.values(P.ranges)) for (const tx of r.txs) for (const id of this.receipts[tx] || []) ids.add(id);
      const list = [...ids];
      const res = await ctx.call(list.flatMap((id) => [call(npm, "npmPositions", enc.uint(id)), call(npm, "ownerOf", enc.uint(id))]), "uniswap.positions");
      const nft = {};
      list.forEach((id, i) => {
        const r = res[i * 2];
        const L = dec.uint(r, 7);
        if (L == null || L === 0n) return;
        const t0 = dec.addr(r, 2), t1 = dec.addr(r, 3), fee = Number(dec.uint(r, 4));
        const pool = this.pools().find((p) => { const m = this.meta[p.key]; return m && m.token0 === t0 && m.token1 === t1 && m.fee === fee; });
        if (!pool) return;
        nft[id] = { pool: pool.key, owner: dec.addr(res[i * 2 + 1]), tl: Number(dec.int(r, 5)), tu: Number(dec.int(r, 6)), L };
      });
      this.nft = nft;
      // Ranges whose NFTs do not add up to the liquidity seen in the logs: resolve older txs (newest first).
      const todo = [];
      for (const [a, P] of Object.entries(this.lp.pools)) {
        for (const [k, r] of Object.entries(P.ranges)) {
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

  /** The scheduler reports failures with the chain key; map the API key to the source name. */
  fail(chain, err, ids) {
    super.fail(chain === "api:geckoterminal" ? "geckoterminal" : chain, err, ids);
  }

  /* ---------------- output ---------------- */

  /** USD value of one unit of a symbol (config usdValue / peg: oracle key or number). */
  usdOf(spec) {
    if (typeof spec === "number") return spec;
    if (typeof spec === "string") return this.oracles[spec]?.value ?? null;
    return null;
  }

  build() {
    const C = this.cfg;
    const cvSyms = new Set(Object.keys(this.app.config.tokens));
    let tvl = 0, tvlOk = true, vol = 0, volOk = true;
    const pools = this.pools().map((p) => {
      const a = p.key, m = this.meta[a], st = this.state[a], v = this.vol[a];
      const base = { slug: p.slug, address: p.address, label: p.label, version: p.version || "v3", volumeUsd24h: v?.volumeUsd24h ?? null };
      if (v?.volumeUsd24h != null) vol += v.volumeUsd24h; else volOk = false;
      if (!m?.t0 || !m?.t1 || !st) { tvlOk = false; return { ...base, ready: false }; }
      const cvIs0 = cvSyms.has(m.t0.symbol) || !cvSyms.has(m.t1.symbol);
      const cv = cvIs0 ? m.t0 : m.t1, ct = cvIs0 ? m.t1 : m.t0;
      const dCv = cv.decimals, dCt = ct.decimals;
      const d0 = m.t0.decimals, d1 = m.t1.decimals;
      const sqrtP = Number(st.sqrtX96) / Q96;
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

      // ---- swap maths (raw units) ----
      const ticks = st.ticks.map((x) => ({ tick: x.tick, net: Number(x.net) }));
      const S = { sqrtP, tick: st.tick, L: Number(st.L), fee: m.fee, ticks };
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
        const after = (() => { const p = r.sqrtEnd * r.sqrtEnd * k; return cvIs0 ? p : 1 / p; })();
        return { size, exceeds: false, out, usd: usdCt != null ? out * usdCt : null, avgPrice: avg, impact: avg / mid - 1, priceAfter: after, moveAfter: after / mid - 1 };
      });

      // ---- LP positions ----
      const P = this.lp.pools[a];
      const raw = [];
      if (P) {
        for (const [key, L] of Object.entries(P.direct)) { const [owner, tl, tu] = key.split("|"); raw.push({ kind: "direct", owner, tl: +tl, tu: +tu, L }); }
        for (const [id, n] of Object.entries(this.nft)) if (n.pool === a) raw.push({ kind: "nft", tokenId: id, owner: n.owner, tl: n.tl, tu: n.tu, L: n.L });
        for (const [key, r] of Object.entries(P.ranges)) {
          const [tl, tu] = key.split("|").map(Number);
          const got = Object.values(this.nft).filter((n) => n.pool === a && n.tl === tl && n.tu === tu).reduce((s, n) => s + n.L, 0n);
          if (r.net > got) raw.push({ kind: "npm", owner: this.npm, tl, tu, L: r.net - got, unresolved: true });
        }
      }
      const priceOfTick = (t) => { const p = 1.0001 ** t * k; return cvIs0 ? p : 1 / p; };
      const activeL = Number(st.L);
      // positions worth less than 1 unit of the CoinVertible (dust) are left out
      const positions = raw.map((q) => {
        const [r0, r1] = rangeAmounts(Number(q.L), sqrtP, q.tl, q.tu);
        const a0 = r0 / 10 ** d0, a1 = r1 / 10 ** d1;
        const amtCv = cvIs0 ? a0 : a1, amtCt = cvIs0 ? a1 : a0;
        const inRange = q.tl <= st.tick && st.tick < q.tu;
        const valueCv = usdCt != null && usdCvEq ? amtCv + (amtCt * usdCt) / usdCvEq : null;
        const lo = priceOfTick(q.tl), hi = priceOfTick(q.tu);
        return {
          kind: q.kind, tokenId: q.tokenId || null, owner: q.owner, unresolved: !!q.unresolved,
          tickLower: q.tl, tickUpper: q.tu, priceLower: Math.min(lo, hi), priceUpper: Math.max(lo, hi),
          inRange, amountCv: amtCv, amountCounter: amtCt, valueCv, liquidity: String(q.L),
          shareActive: inRange && activeL > 0 ? Number(q.L) / activeL : 0,
        };
      }).filter((q) => q.valueCv == null || q.valueCv >= 1).sort((x, y) => (y.valueCv ?? 0) - (x.valueCv ?? 0));

      return {
        ...base, ready: true, block: st.block, fee: m.fee, feePct: m.fee / 1e4, tickSpacing: m.spacing,
        cv: { symbol: cv.symbol, address: cvIs0 ? m.token0 : m.token1, decimals: dCv },
        counter: { symbol: ct.symbol, address: cvIs0 ? m.token1 : m.token0, decimals: dCt },
        cvIs0, decimals: [d0, d1],
        price: mid, pegPrice, deviation, deviationBps: deviation == null ? null : deviation * 1e4,
        tvlUsd: poolTvl, composition,
        depth, impact, maxSale: maxIn, ticksComplete: st.complete,
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
 * 23. UI: formatting, icons, logos, tooltip
 * ================================================================================================ */

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DASH = "\u2014";
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
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  zoomIn: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
};
const icon = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${LUCIDE[name]}</svg>`;

/**
 * Logo slot: <img> fitted in a fixed box (any size or ratio). A missing file falls back to a
 * monogram; failed URLs are remembered so re-renders do not request them again.
 */
const BAD_LOGOS = new Set();
if (typeof window !== "undefined") {
  // @ts-ignore
  window.cvLogoFail = (img) => { BAD_LOGOS.add(img.getAttribute("src")); const p = img.parentNode; p.classList.remove("ok"); p.textContent = p.dataset.m; };
}
function logo(src, text, cls = "") {
  const m = esc(String(text || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase());
  if (!src || BAD_LOGOS.has(src)) return `<span class="logo ${cls}" data-m="${m}">${m}</span>`;
  return `<span class="logo ok ${cls}" data-m="${m}"><img src="${esc(src)}" alt="" onerror="cvLogoFail(this)"></span>`;
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
    if (!t) return this.hide();
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
  hide() { this.target = null; this.el.classList.remove("on"); }
  /** After a re-render the hovered node is new: re-attach to whatever is under the pointer. */
  refresh() {
    if (!this.target) return;
    const t = this.x >= 0 ? document.elementFromPoint(this.x, this.y)?.closest?.("[data-tip]") : null;
    if (t) this.show(t); else this.hide();
  }
}

/* ================================================================================================
 * 24. UI: shell and pages
 * ================================================================================================ */

const NAV = [
  ["CoinVertible", [["monitoring", "#/coinvertible/monitoring", "Monitoring", "activity"], ["coinwatch", "#/coinvertible/coinwatch", "Coinwatch", "chart"]]],
  ["DeFi", [["morpho", "#/defi/morpho", "Morpho", "layers"], ["uniswap", "#/defi/uniswap", "Uniswap", "swap"]]],
];
const MODULE_NAMES = { "monitoring.supply": "Supply", "monitoring.mintburn": "Mint & burn", morpho: "Morpho", uniswap: "Uniswap" };
const SOURCE_LABELS = { geckoterminal: "GeckoTerminal" };
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
    this.renderShell();
    this.bindChart();
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
      return `<a class="nav" href="${href}" data-page="${id}" data-tip-collapsed="${esc(label)}"><span class="slot">${slot}</span><span class="label">${esc(label)}</span></a>`;
    };
    const brand = L.brand
      ? `<img class="brand-full" src="${esc(L.brand)}" alt="" onerror="this.outerHTML='<span class=&quot;wordmark brand-full&quot;>CoinVertible</span>'">`
      : `<span class="wordmark brand-full">CoinVertible</span>`;
    const mark = L.brandMark
      ? `<img class="brand-mark" src="${esc(L.brandMark)}" alt="" onerror="this.outerHTML='<span class=&quot;logo brand-mark&quot;>CV</span>'">`
      : `<span class="logo brand-mark">CV</span>`;
    this.root.innerHTML = `
      <div class="app${collapsed ? " collapsed" : ""}" id="shell">
        <div class="side-col"><aside class="sidebar">
          <a class="side-head" href="#/coinvertible/monitoring">${brand}${mark}</a>
          <nav class="side-nav">${NAV.map(([g, items]) => `<div class="group"><div class="group-label">${esc(g)}</div>${items.map(navItem).join("")}</div>`).join("")}</nav>
          <div class="side-foot">
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
          </header>
          <div class="content" id="content"></div>
        </div>
      </div>
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
    this.root.querySelector("#btn-diag").addEventListener("click", () => this.openDiag());
    this.content.addEventListener("click", (e) => this.onClick(e));
    // Collapsed rail: nav labels become tooltips.
    shell.addEventListener("mouseover", (e) => {
      const a = /** @type {HTMLElement} */ (e.target)?.closest?.(".nav");
      if (!a) return;
      if (shell.classList.contains("collapsed")) a.setAttribute("data-tip", a.getAttribute("data-tip-collapsed")); else a.removeAttribute("data-tip");
    });
  }

  /** Switch page (and sub-page): rendering only, from data already in the store. */
  setPage(page, sub = null) {
    const changed = page !== this.page || sub !== this.sub;
    this.page = page;
    this.sub = sub;
    this.root.querySelectorAll(".nav").forEach((a) => a.classList.toggle("active", a.getAttribute("data-page") === page));
    const g = NAV.find(([, items]) => items.some((i) => i[0] === page));
    const item = g?.[1].find((i) => i[0] === page);
    const subLabel = sub ? this.app.config.uniswap.pools.find((p) => p.slug === sub)?.label : null;
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

  render() {
    if (!this.content) return;
    this.renderStatus();
    // keep the scroll position of scrollable lists across re-renders
    const keep = {};
    this.content.querySelectorAll("[data-keep]").forEach((el) => { keep[el.getAttribute("data-keep")] = el.scrollTop; });
    const p = this.page;
    this.content.innerHTML = p === "monitoring" ? this.monitoring() : p === "morpho" ? this.morpho() : p === "uniswap" ? this.uniswap() : this.coinwatch();
    this.content.querySelectorAll("[data-keep]").forEach((el) => { const v = keep[el.getAttribute("data-keep")]; if (v) el.scrollTop = v; });
    if (p === "uniswap") this.drawCharts();
    this.root.querySelector("#diag-badge").hidden = !this.problems().length;
    this.tip?.refresh();
  }

  /** Top-right status: last update of the page's data, overall health dot, manual refresh. */
  renderStatus() {
    const el = this.root.querySelector("#status");
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
    const z = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-zoom]");
    if (z) { this.zoom(z.getAttribute("data-slug"), z.getAttribute("data-zoom")); return; }
    const el = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-gate]");
    if (!el) return;
    const id = el.getAttribute("data-gate");
    this.app.tabs.setGate(id, !this.gates.has(id));
    this.app.scheduler.kick(this.app.config.morpho.chain);
    this.render();
  }

  /* ---------------- shared pieces ---------------- */

  env(id) { return this.app.store.get(id); }

  /** Effective status of a source (ok / stale / error / cached), with age-based staleness. */
  srcStatus(key, s, env) {
    if (env?.cached) return "cached";
    if (!s) return "pending";
    const f = this.app.config.frequency;
    const interval = this.app.scheduler.baseInterval(key in f.chains ? key : `api:${key}`);
    if (s.status === "ok" && s.okAt && Date.now() - s.okAt > interval * 1000 * (f.behaviour.staleAfterIntervals || 3)) return "stale";
    return s.status;
  }

  /** Source line at the top of a page: one entry per chain/API, endpoint and errors in the tooltip. */
  sources(moduleIds) {
    const order = [...Object.keys(this.app.config.chains), "geckoterminal"];
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
      const tip = (m.status === "cached" ? "Values from your last visit, refreshing\u2026\n" : "") + m.lines.join("\n");
      return `<span class="src ${m.status}"${tipAttr(tip)}><i></i><b>${esc(label)}</b>${m.ref ? `<span>${esc(m.ref)}</span>` : ""}<span>${age(m.okAt || null)}</span></span>`;
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
    const chains = this.app.config.chains;
    const cards = Object.entries(sup?.data || this.app.config.tokens).map(([sym, t]) => {
      const rows = Object.entries(t.chains || {}).map(([c, v]) => {
        const s = sup?.sources?.[c];
        const st = this.srcStatus(c, s, sup);
        const problem = v.amount == null || st === "error" || st === "stale"
          ? (s?.error ? `Could not read ${chains[c]?.label || c}: ${s.error}` : st === "stale" ? `No fresh value from ${chains[c]?.label || c} for ${age(s?.okAt)}; showing the last value.` : `Waiting for the first read of ${chains[c]?.label || c}.`)
          : "";
        return `<tr><td>${this.chainCell(c, problem && st !== "pending" ? problem : "")}</td><td class="r num">${amount(v.amount, 0)}</td>
          <td class="r"><span class="meter"><span class="track"><span style="width:${((v.share || 0) * 100).toFixed(2)}%"></span></span><span class="w">${pct(v.share)}</span></span></td></tr>`;
      }).join("");
      const partial = t.partial ? `<span class="err-dot"${tipAttr("Partial total: at least one chain could not be read and is not included.")}></span>` : "";
      return `<div class="card">
        <div class="card-body">
          <div class="card-head">${logo(this.logos.tokens?.[sym], sym, "lg")}<span>${esc(sym)}</span><span class="muted">${esc(t.name || "")}</span></div>
          <div class="hero">${t.total != null ? amount(t.total, 0) : DASH}<small>${esc(sym)}</small>${partial}</div>
        </div>
        <div class="tbl"><table><thead><tr><th>Chain</th><th class="r">Supply</th><th class="r">Share</th></tr></thead>
        <tbody>${rows || this.waiting(3)}</tbody></table></div>
      </div>`;
    }).join("");

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

    return `${this.sources(["monitoring.supply", "monitoring.mintburn"])}
      <section><div class="sec-head"><h2>Total supply</h2></div><div class="grid g2">${cards}</div></section>
      <section><div class="sec-head"><h2>Recent mints &amp; burns</h2><span>Ethereum, last ${evs.length || 15}</span></div>
        <div class="card"><div class="tbl list" data-keep="mintburn"><table>
          <thead><tr><th>Date</th><th>Chain</th><th>Token</th><th>Type</th><th>Recipient / sender</th><th class="r">Amount</th><th>Tx</th></tr></thead>
          <tbody>${mbRows || this.waiting(7, mb ? "No event found yet" : "Loading\u2026")}</tbody>
        </table></div></div>
      </section>`;
  }

  /** "Show more" footer inside a card. */
  moreBtn(gate, open, count) {
    return `<button class="card-more${open ? " open" : ""}" data-gate="${gate}"><span>${open ? "Show less" : `Show ${count ?? ""} more`.replace("  ", " ")}</span>${icon("chevron")}</button>`;
  }

  /** Vault name with its curator logo (Morpho API), linked to the Morpho app. */
  vaultName(v, big) {
    const cur = v.curator;
    const tip = `${cur?.name ? `Curator: ${cur.name}\n` : ""}Open on Morpho\n${v.address}`;
    return `<span class="cell">${logo(cur?.image, cur?.name || v.label, big ? "xl" : "")}<a class="link${big ? " big" : ""}" href="${esc(v.url)}" target="_blank" rel="noopener"${tipAttr(tip)}>${esc(v.label)}</a><span class="tag">V${v.version}</span></span>`;
  }

  apyTip(v) {
    return [`Native ${pct(v.nativeApy)}`, v.incentiveApy != null ? `Incentives ${pct(v.incentiveApy)}` : null, v.capApy != null ? `Cap (maxRate) ${pct(v.capApy)}` : null,
      v.fees?.performance ? `Performance fee ${pct(v.fees.performance)}` : null].filter(Boolean).join("\n");
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

  mainVault(v, asset) {
    const inc = this.incentives(v, asset);
    const metric = (label, value, sub, tip, cls = "") => `<div class="mv-metric${cls}"><div class="mv-label">${esc(label)}</div><div class="mv-value"${tipAttr(tip)}>${value}</div>${sub ? `<div class="mv-sub">${sub}</div>` : ""}</div>`;
    return `<div class="card main-vault">
      <div class="mv-head"><span class="mv-title">Main Vault</span></div>
      <div class="mv-body">
        <div class="mv-id">${this.vaultName(v, true)}${v.curator?.name ? `<div class="mv-sub">Curated by ${esc(v.curator.name)}</div>` : ""}</div>
        <div class="mv-metrics">
          ${metric(`Total deposits`, `${amount(v.totalDeposits, 0)}<small>${esc(asset)}</small>`, "", "", " wide")}
          ${metric("APY", `<span class="hover">${pct(v.apy)}</span>`, `native ${pct(v.nativeApy)}`, this.apyTip(v))}
          ${metric("Idle", pct(v.idlePct), `${amount(v.idle, 0)} ${esc(asset)}`, "Assets not deployed in a lending market (vault balance + idle market).")}
          ${inc ? metric("Incentives", inc.main, inc.sub, inc.tip, " wide") : ""}
        </div>
      </div>
    </div>`;
  }

  morpho() {
    const env = this.env("morpho");
    const d = env?.data;
    const asset = d?.asset || this.app.config.morpho.asset;
    const vOpen = this.gates.has("morpho.vaults.others");
    const mOpen = this.gates.has("morpho.markets.others");
    const main = (d?.vaults || []).find((v) => v.key === d?.mainVault);
    const vaults = (d?.vaults || []).filter((v) => v !== main && (v.whitelist || vOpen));
    const markets = (d?.markets || []).filter((m) => m.whitelist || mOpen);
    const ov = mOpen && d?.overviewAll?.markets > (d?.overview?.markets || 0) ? d.overviewAll : d?.overview;

    const vaultRow = (v) => {
      const inc = this.incentives(v, asset);
      return `<tr class="${v.whitelist ? "" : "other"}${inc ? " tall" : ""}">
        <td>${this.vaultName(v)}</td>
        <td class="r num">${amount(v.totalDeposits, 0)}</td>
        <td class="r">${pct(v.idlePct)}</td>
        <td class="r"><span class="hover num"${tipAttr(this.apyTip(v))}>${pct(v.apy)}</span></td>
        <td>${inc ? `<span class="num"${tipAttr(inc.tip)}>${inc.main}</span><span class="two">${inc.sub}</span>` : `<span class="subtle">${DASH}</span>`}</td></tr>`;
    };
    const marketRow = (m) => `<tr class="tall ${m.whitelist ? "" : "other"}">
      <td><span class="cell">${logo(m.collateral.logoURI, m.collateral.symbol)}<span>
        <a class="link num" href="${esc(m.url)}" target="_blank" rel="noopener"${tipAttr("Open on Morpho")}>${esc(m.pair.replace("/", " / "))}</a><span class="lltv">${pct(m.lltv, Math.round(m.lltv * 1000) % 10 ? 1 : 0)} LLTV</span>
        <span class="two mono"${tipAttr(m.id)}>${esc(m.id.slice(0, 10))}\u2026</span></span></span></td>
      <td class="c num">${pct(m.borrowApy)}</td>
      <td><span class="meter util"><span class="track"><span class="f-${m.utilizationBand}" style="width:${Math.min(100, m.utilization * 100).toFixed(2)}%"></span></span><span class="w">${pct(m.utilization)}</span></span></td>
      <td class="r">${compact(m.totalSupplied)}</td><td class="r">${compact(m.totalBorrowed)}</td></tr>`;

    const kpiTip = (fn) => `Sum of ${fn} of the ${mOpen ? "whitelisted and non-whitelisted" : "whitelisted"} ${asset} markets (${ov?.markets ?? 0} markets), read on-chain from Morpho Blue market(id) at the block shown above, with interest accrued to that block's timestamp.\nOpening "Show more" adds the non-whitelisted markets to the total.`;

    return `${this.sources(["morpho"])}
      <section><div class="sec-head"><h2>Vaults</h2><span>${esc(asset)}</span></div>
        ${main ? this.mainVault(main, asset) : ""}
        <div class="card"><div class="tbl"><table>
          <colgroup><col><col style="width:18%"><col style="width:10%"><col style="width:10%"><col style="width:24%"></colgroup>
          <thead><tr><th>Vault</th><th class="r">Total deposits (${esc(asset)})</th><th class="r">Idle</th><th class="r">APY</th><th>Incentives</th></tr></thead>
          <tbody>${vaults.map(vaultRow).join("") || this.waiting(5, d ? "No other vault" : "Loading\u2026")}</tbody></table></div>
          ${this.moreBtn("morpho.vaults.others", vOpen, d?.counts?.othersVaults)}</div>
      </section>
      <section><div class="sec-head"><h2>Markets</h2><span>${esc(asset)} lent</span></div>
        <div class="grid g2 kpis">
          <div class="card card-body"><div class="kpi-label">Total supplied<span class="tip-i"${tipAttr(kpiTip("totalSupplyAssets"))}>${icon("info")}</span></div><div class="kpi">${amount(ov?.totalSupplied, 0)}<small>${esc(asset)}</small></div></div>
          <div class="card card-body"><div class="kpi-label">Total borrowed<span class="tip-i"${tipAttr(kpiTip("totalBorrowAssets"))}>${icon("info")}</span></div><div class="kpi">${amount(ov?.totalBorrowed, 0)}<small>${esc(asset)}</small></div></div>
        </div>
        <div class="card"><div class="tbl"><table>
          <colgroup><col style="width:30%"><col><col style="width:220px"><col style="width:12%"><col style="width:12%"></colgroup>
          <thead><tr><th>Market</th><th class="c">Borrow APY</th><th>Utilization</th><th class="r">Supplied</th><th class="r">Borrowed</th></tr></thead>
          <tbody>${markets.map(marketRow).join("") || this.waiting(5)}</tbody></table></div>
          ${this.moreBtn("morpho.markets.others", mOpen, d?.counts?.othersMarkets)}</div>
      </section>`;
  }

  /* ---------------- Uniswap ---------------- */

  uniData() { return this.env("uniswap")?.data; }

  pairLogos(p, cls = "") {
    const a = p.cv?.symbol, b = p.counter?.symbol;
    const [x, y] = a ? [a, b] : p.label.split("/");
    return `<span class="pair ${cls}">${logo(this.logos.tokens?.[x], x, cls)}${logo(this.logos.tokens?.[y], y, cls)}</span>`;
  }

  pairName(p) { return esc(p.label.replace("/", " / ")); }

  feeTag(p) { return p.feePct != null ? `<span class="tag">${esc(nf(2).format(p.feePct))}%</span>` : ""; }

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
    const card = (p) => `<a class="card pool-card" href="#/defi/uniswap/${esc(p.slug)}">
        <div class="pc-head">${this.pairLogos(p)}<span class="pc-name">${this.pairName(p)}</span>${this.feeTag(p)}<span class="tag">${esc(p.version || "v3")}</span>${this.pegBadge(p, d)}</div>
        <div class="pc-price">${p.ready ? fmtP(p.price) : DASH}<small>${p.ready ? `${esc(p.counter.symbol)} per ${esc(p.cv.symbol)}` : ""}</small></div>
        <div class="pc-ref">${this.pegRef(p, d) || "&nbsp;"}</div>
        <div class="pc-metrics"><div><span>TVL</span><b>${usdC(p.tvlUsd)}</b></div><div><span>Volume 24h</span><b>${usdC(p.volumeUsd24h)}</b></div></div>
        ${this.composition(p)}
      </a>`;
    return `${this.sources(["uniswap"])}
      <section>
        <div class="grid g2 kpis">
          <div class="card card-body"><div class="kpi-label">TVL of the pools<span class="tip-i"${tipAttr(this.tvlTip(d))}>${icon("info")}</span></div><div class="kpi">${d ? usd(d.totals.tvlUsd) : DASH}${kpiPartial(d?.totals.tvlPartial)}</div></div>
          <div class="card card-body"><div class="kpi-label">Volume 24h<span class="tip-i"${tipAttr("Sum of the 24 h volume of the pools, in USD, from GeckoTerminal (CoinGecko's DEX API), refreshed every minute.")}>${icon("info")}</span></div><div class="kpi">${d ? usd(d.totals.volumeUsd24h) : DASH}${kpiPartial(d?.totals.volumePartial)}</div></div>
        </div>
      </section>
      <section><div class="sec-head"><h2>Pools</h2><span>Uniswap v3${DOT}${esc(this.app.config.chains[this.app.config.uniswap.chain]?.label || "")}</span></div>
        <div class="grid g3">${pools.map(card).join("")}</div>
      </section>`;
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
        <span class="links"><a class="link" href="${esc(`${C.appUrl}/explore/pools/ethereum/${p.address}`)}" target="_blank" rel="noopener">Uniswap${icon("ext", "ext")}</a><a class="link" href="${esc(chain.explorer.address + p.address)}" target="_blank" rel="noopener"${tipAttr(p.address)}>Etherscan${icon("ext", "ext")}</a></span>
      </div>`;
    const metric = (label, value, sub, tip) => `<div class="ph-m"><div class="mv-label">${esc(label)}</div><div class="mv-value"${tipAttr(tip)}>${value}</div>${sub ? `<div class="mv-sub">${sub}</div>` : ""}</div>`;
    const hero = `<div class="card pool-hero">
        <div class="ph-head">${this.pairLogos(p, "xl")}<span class="link big">${this.pairName(p)}</span>${this.feeTag(p)}<span class="tag">${esc(p.version || "v3")}</span></div>
        <div class="ph-metrics">
          ${metric("Price", p.ready ? fmtP(p.price) : DASH, p.ready ? `${esc(p.counter.symbol)} per ${esc(p.cv.symbol)}${DOT}peg ${fmtP(p.pegPrice)}` : "", "")}
          ${metric("Peg deviation", this.pegBadge(p, d), this.pegRef(p, d, "oracles"), "")}
          ${metric("TVL", usdC(p.tvlUsd), "on-chain balances x oracles", this.tvlTip(d))}
          ${metric("Volume 24h", usdC(p.volumeUsd24h), "GeckoTerminal", "")}
        </div>
        <div class="hero-comp">${this.composition(p)}</div>
      </div>`;
    if (!p.ready) return `${this.sources(["uniswap"])}${nav}${hero}`;
    const approx = p.ticksComplete ? "" : `<span class="err-dot"${tipAttr("The tick map could not be fully read at this block: values are approximate.")}></span>`;
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
      const pos = q.kind === "nft" ? `<a class="link" href="${esc(`${appUrl}/positions/v3/ethereum/${q.tokenId}`)}" target="_blank" rel="noopener"${tipAttr("NFT position (NonfungiblePositionManager)")}>#${esc(q.tokenId)}${icon("ext", "ext")}</a>`
        : q.kind === "direct" ? `<span class="hover"${tipAttr("Minted directly on the pool by this contract (no NFT)")}>Direct</span>`
        : `<span class="subtle"${tipAttr("NFT liquidity whose id is still being resolved")}>NFT\u2026</span>`;
      return `<tr class="tall"><td>${this.addrLink(C.chain, q.owner, label)}</td><td>${pos}</td>
        <td><span class="num">${fmtP(q.priceLower)} \u2013 ${fmtP(q.priceUpper)}</span><span class="two">ticks ${q.tickLower} / ${q.tickUpper}</span></td>
        <td>${q.inRange ? `<span class="state ok"><i></i>In range</span>` : `<span class="state"><i></i>Out of range</span>`}</td>
        <td class="r">${amount(q.amountCv, 0)}</td><td class="r">${amount(q.amountCounter, 0)}</td><td class="r num">${amount(q.valueCv, 0)}</td>
        <td class="r"><span class="meter"><span class="track"><span style="width:${(q.shareActive * 100).toFixed(2)}%"></span></span><span class="w">${pct(q.shareActive, 1)}</span></span></td></tr>`;
    }).join("");
    const posEmpty = h.status === "error" ? `History unavailable${DOT}${h.error || ""}` : h.status === "pending" ? "Loading the LP history\u2026" : "No open position";
    const posNote = h.status === "stale" ? `<span class="err-dot"${tipAttr(`History not updated since ${age(h.at)}: ${h.error || ""}`)}></span>` : "";

    return `${this.sources(["uniswap"])}${nav}${hero}
      <section><div class="card chart-card">
        <div class="chart-head"><span class="chart-title">Liquidity distribution${approx}</span>
          <span class="legend"><span><i class="c-cv"></i>${cv}</span><span><i class="c-ct"></i>${ct}</span><span><i class="ln cur"></i>Current</span><span><i class="ln peg"></i>Peg</span></span>
          <span class="zoom"><span class="subtle hint">Scroll to zoom${DOT}drag to pan</span>
            <button class="icon-btn sm" data-zoom="out" data-slug="${esc(slug)}"${tipAttr("Zoom out")}>${icon("zoomOut")}</button>
            <button class="icon-btn sm" data-zoom="in" data-slug="${esc(slug)}"${tipAttr("Zoom in")}>${icon("zoomIn")}</button>
            <button class="icon-btn sm" data-zoom="reset" data-slug="${esc(slug)}"${tipAttr("Reset view")}>${icon("reset")}</button></span></div>
        <div class="chart" data-chart="${esc(slug)}"></div>
      </div></section>
      <section><div class="grid g2">
        <div><div class="sec-head"><h2>Depth</h2><span>amount that moves the price${approx}</span></div>
          <div class="card"><div class="tbl"><table><thead><tr><th>Band</th><th class="r">Sell ${cv} (price \u2212)</th><th class="r">Buy ${cv} (price +)</th></tr></thead><tbody>${depthRows}</tbody></table></div></div></div>
        <div><div class="sec-head"><h2>Sale impact</h2><span>selling ${cv} for ${ct}, fee included${approx}</span></div>
          <div class="card"><div class="tbl"><table><thead><tr><th>Sale</th><th class="r">Receive</th><th class="r">Avg price</th><th class="r">Impact</th></tr></thead><tbody>${impactRows}</tbody></table></div></div></div>
      </div></section>
      <section><div class="sec-head"><h2>LP positions</h2><span>${p.positions.length || ""} open${posNote}</span></div>
        <div class="card"><div class="tbl"><table>
          <thead><tr><th>Owner</th><th>Position</th><th>Price range (${ct} per ${cv})</th><th>Status</th><th class="r">${cv}</th><th class="r">${ct}</th><th class="r">Value (${cv} eq.)</th><th class="r">Share of active liquidity</th></tr></thead>
          <tbody>${posRows || this.waiting(8, posEmpty)}</tbody></table></div></div>
      </section>`;
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
      el.innerHTML = p?.ready ? this.chartSvg(p, el.clientWidth || 900) : "";
    });
    this.tip?.refresh();
  }

  chartSvg(p, W) {
    const M = this.chartModel(p);
    const v = this.chartView(p, M);
    const H = 260, top = 22, bottom = 26, side = 8;
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
      return `<line class="${cls}" x1="${X.toFixed(1)}" x2="${X.toFixed(1)}" y1="${top - 4}" y2="${top + ih}"/><text class="lbl ${cls}" x="${(X + (right ? 5 : -5)).toFixed(1)}" y="${top - 8}" text-anchor="${anchor}">${esc(text)}</text>`;
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

  /** Wheel zoom (around the pointer), drag to pan, double-click to reset. */
  bindChart() {
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

  coinwatch() {
    return `<section><div class="sec-head"><h2>Coinwatch</h2></div><div class="card card-body muted">To be defined.</div></section>`;
  }

  /* ---------------- dialogs ---------------- */

  /** Everything that used to be a banner: config errors/warnings, module warnings, failing sources. */
  problems() {
    const out = [];
    const c = this.app.config;
    c.errors.forEach((e) => out.push(["Config error", e]));
    c.warnings.forEach((e) => out.push(["Config", e]));
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
      `<div><button class="btn" id="s-clear"${tipAttr("Clears cached results, history and learned endpoint limits")}>Clear local cache</button><button class="btn" id="s-reset">Reset to config</button></div>
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
      return `<p class="muted">Tab role: <b>${esc(this.app.tabs.role)}</b>${DOT}counting since ${esc(new Date(s.startedAt).toLocaleTimeString("en-GB"))}${DOT}skipped ticks: ${num(s.skippedTicks)}</p>
        <h4>Warnings</h4>${probs.length ? `<ul class="probs">${probs.map(([w, m]) => `<li><b>${esc(w)}</b><span>${esc(m)}</span></li>`).join("")}</ul>` : `<p class="muted">None.</p>`}
        <h4>Endpoints</h4><div class="card"><div class="tbl"><table class="dense"><thead><tr><th>Scope</th><th>Endpoint</th><th>Status</th><th>Last error</th></tr></thead><tbody>
        ${health.map((h) => `<tr><td>${esc(h.scope)}</td><td class="mono"${tipAttr(h.url)}>${esc(h.id)}</td><td>${h.healthy ? '<span class="ok-txt">ok</span>' : `<span class="warn-txt">cooldown ${Math.ceil(h.cooldownMs / 1000)}s</span>`}</td><td class="err-txt">${esc(h.lastError || "")}</td></tr>`).join("")}
        </tbody></table></div></div>
        ${table(s.rows("endpoint"), "Requests by endpoint")}${table(s.rows("module"), "Requests by module")}${table(s.rows("method"), "Requests by method")}`;
    };
    const dlg = this.dialog("dlg-diag", "Diagnostics", "", draw(), "");
    const body = dlg.querySelector(".dlg-b");
    const t = setInterval(() => { if (!dlg.open) return clearInterval(t); const top = body.scrollTop; body.innerHTML = draw(); body.scrollTop = top; }, 3000);
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

  const app = { config, stats, store, bus, labels, adapters, apiPools, tabs, modules: /** @type {any[]} */ ([]), scheduler: /** @type {any} */ (null) };
  app.modules = [new SupplyModule(app), new MintBurnModule(app), new MorphoModule(app), new UniswapModule(app)];
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
