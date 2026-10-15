// @ts-check

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ±pct random jitter around ms. */
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

export const shortHex = (h, a = 6, b = 4) => (h && h.length > a + b + 2 ? `${h.slice(0, a)}…${h.slice(-b)}` : h || "");

export const isHexAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
export const isHex32 = (a) => /^0x[0-9a-fA-F]{64}$/.test(a || "");
