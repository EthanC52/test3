// @ts-check
/**
 * One pool per chain (or API). Spreads requests over every configured endpoint:
 * - token bucket per endpoint (maxRps): requests wait instead of being rejected
 * - smooth weighted round-robin among healthy endpoints that pass the request's filter
 * - failover to the next endpoint on timeout / HTTP error / rate limit / endpoint-side RPC error
 * - cooldown per failing endpoint (5 s → 10 s → … → 5 min), Retry-After and RateLimit-* headers honoured
 * - "execution reverted" is a real answer: returned to the caller, no failover
 */
import { sleep } from "./util.js";

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
  async _fetch(ep, url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let r;
    try {
      r = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (e?.name === "AbortError") throw new RpcError(`timeout after ${this.timeoutMs} ms`, { kind: "timeout" });
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
   * @param {{module?: string, filter?: (ep:any)=>boolean, subcalls?: number, onError?: Function, info?: any, label?: string}} [o]
   */
  jsonRpc(method, params, o = {}) {
    return this.send(async (ep) => {
      const body = await this._fetch(ep, ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
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
