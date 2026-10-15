// @ts-check
/**
 * EVM adapter.
 *
 * beginTick() → one eth_blockNumber, then a TickContext pinned to that block:
 *   ctx.call(calls)  — sub-calls from every module of the tick are de-duplicated, merged and cut into
 *                      Multicall3 batches sent in parallel across endpoints, all at the same block.
 *   ctx.logs(filter, from, to) — log requests of the tick with the same range and topic0-only filters
 *                      are merged into one eth_getLogs (union of addresses and topic0), then routed back.
 *                      Ranges are split by the endpoints' maxLogRange; deep ranges only go to
 *                      endpoints whose logDepth allows it. Limits are learned from "range"/"depth" errors.
 */
import { SIG, call, encodeAggregate3, decodeAggregate3, dec, toHexQty } from "./abi.js";
import { RpcError } from "../../core/rpc-pool.js";
import { storage } from "../../core/storage.js";

export class EvmAdapter {
  /** @param {string} key @param {any} cfg chain config @param {import("../../core/rpc-pool.js").RpcPool} pool */
  constructor(key, cfg, pool) {
    this.key = key;
    this.cfg = cfg;
    this.pool = pool;
    this.type = "evm";
    /** @type {Record<string, number>} block → timestamp */
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
    let size = pool.minOf("maxLogRange", canDepth);
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

export { SIG };
