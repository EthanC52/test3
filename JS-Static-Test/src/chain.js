/**
 * Lecture on-chain sans librairie : JSON-RPC brut + encodage/décodage ABI minimal.
 * - EVM    : un seul eth_call Multicall3.aggregate3 par cycle (lecture atomique au même bloc)
 * - Solana : getTokenSupply
 * - Stellar: Horizon /assets
 * - XRPL   : gateway_balances (obligations de l'émetteur)
 */

/* ───────────────────────────── Transport ───────────────────────────── */

export class RpcClient {
  constructor(urls, timeoutMs = 8000) {
    this.urls = (urls || []).filter(Boolean);
    this.idx = 0;
    this.timeoutMs = timeoutMs;
    this.lastLatency = null;
  }
  get current() {
    return this.urls[this.idx] || null;
  }
  /** Exécute fn(url) en basculant sur les URL de secours si besoin. */
  async withFallback(fn) {
    if (!this.urls.length) throw new Error("Aucune URL RPC configurée");
    let lastErr;
    for (let a = 0; a < this.urls.length; a++) {
      const url = this.urls[this.idx];
      const t0 = performance.now();
      try {
        const res = await fn(url);
        this.lastLatency = Math.round(performance.now() - t0);
        return res;
      } catch (e) {
        lastErr = e;
        this.idx = (this.idx + 1) % this.urls.length;
      }
    }
    throw lastErr;
  }
  async fetchJson(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Timeout RPC");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Appel JSON-RPC 2.0 */
  async jsonRpc(method, params) {
    return this.withFallback(async (url) => {
      const body = await this.fetchJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
      return body.result;
    });
  }
  /** GET REST (Horizon) */
  async get(path) {
    return this.withFallback((url) => this.fetchJson(url.replace(/\/$/, "") + path));
  }
}

/* ───────────────────────────── ABI ───────────────────────────── */

export const SEL = {
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
  balanceOf: "0x70a08231",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  asset: "0x38d52e0f",
  totalAssets: "0x01e1d114",
  convertToAssets: "0x07a2d13a",
  // Morpho Vault V2
  _totalAssets: "0xce04bebb",
  lastUpdate: "0xc0463711",
  maxRate: "0xece1d6e5",
  adaptersLength: "0x5aa22bc8",
  adapters: "0x4ef501ac",
  realAssets: "0x56c07573",
  performanceFee: "0x87788782",
  managementFee: "0xa6f7f5d6",
  // Morpho Vault V1 (MetaMorpho)
  withdrawQueueLength: "0x33f91ebb",
  lastTotalAssets: "0x568efc07",
  fee: "0xddca3f43",
  // Multicall3
  aggregate3: "0x82ad56cb",
  getBlockNumber: "0x42cbb15c",
  getCurrentBlockTimestamp: "0x0f28c97d",
};

const strip = (h) => h.replace(/^0x/, "");
export const encUint = (v) => BigInt(v).toString(16).padStart(64, "0");
export const encAddr = (a) => strip(a).toLowerCase().padStart(64, "0");

/** Construit un appel { target, data } */
export const callOf = (target, selector, ...words) => ({ target, data: selector + words.join("") });

/** aggregate3((address target, bool allowFailure, bytes callData)[]) */
export function encodeAggregate3(calls) {
  const tuples = calls.map((c) => {
    const data = strip(c.data);
    const len = data.length / 2;
    const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
    return encAddr(c.target) + encUint(1) + encUint(0x60) + encUint(len) + padded;
  });
  let offset = tuples.length * 32;
  const heads = tuples.map((t) => {
    const o = offset;
    offset += t.length / 2;
    return encUint(o);
  });
  return SEL.aggregate3 + encUint(0x20) + encUint(tuples.length) + heads.join("") + tuples.join("");
}

/** Décode (bool success, bytes returnData)[] */
export function decodeAggregate3(hex) {
  const h = strip(hex);
  const u = (byteOff) => BigInt("0x" + h.slice(byteOff * 2, byteOff * 2 + 64));
  const arr = Number(u(0));
  const n = Number(u(arr));
  const base = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + Number(u(base + 32 * i));
    const success = u(t) !== 0n;
    const d = t + Number(u(t + 32));
    const len = Number(u(d));
    out.push({ success, data: "0x" + h.slice((d + 32) * 2, (d + 32 + len) * 2) });
  }
  return out;
}

export const decUint = (r) => (r && r.success && r.data.length >= 66 ? BigInt(r.data.slice(0, 66)) : null);
export const decAddr = (r) => (r && r.success && r.data.length >= 66 ? "0x" + r.data.slice(26, 66) : null);
export function decString(r) {
  if (!r || !r.success || r.data.length < 130) return null;
  const h = strip(r.data);
  const off = Number(BigInt("0x" + h.slice(0, 64)));
  const len = Number(BigInt("0x" + h.slice(off * 2, off * 2 + 64)));
  const bytes = h.slice(off * 2 + 64, off * 2 + 64 + len * 2);
  return new TextDecoder().decode(new Uint8Array(bytes.match(/../g)?.map((b) => parseInt(b, 16)) || []));
}

/** Exécute un lot d'appels via Multicall3 (un seul eth_call). */
export async function multicall(client, multicallAddr, calls, blockTag = "latest") {
  const data = encodeAggregate3(calls);
  const res = await client.jsonRpc("eth_call", [{ to: multicallAddr, data }, blockTag]);
  return decodeAggregate3(res);
}

/* ───────────────────────────── Nombres ───────────────────────────── */

/** BigInt (unités brutes) → Number (précision 1e-6, suffisante pour l'affichage) */
export function toNum(raw, decimals) {
  if (raw == null) return null;
  const d = Number(decimals);
  if (d <= 6) return Number(raw) / 10 ** d;
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const v = Number(abs / 10n ** BigInt(d - 6)) / 1e6;
  return neg ? -v : v;
}

/* ───────────────────────────── Readers non-EVM ───────────────────────────── */

export async function readSolanaSupply(client, mint) {
  const r = await client.jsonRpc("getTokenSupply", [mint, { commitment: "confirmed" }]);
  const v = r.value;
  return { amount: Number(v.uiAmountString ?? v.uiAmount), decimals: v.decimals, slot: r.context?.slot };
}

export async function readStellarSupply(client, code, issuer) {
  const j = await client.get(`/assets?asset_code=${encodeURIComponent(code)}&asset_issuer=${issuer}`);
  const rec = j?._embedded?.records?.[0];
  if (!rec) throw new Error("Asset Stellar introuvable");
  const b = rec.balances || {};
  const parts = [
    b.authorized,
    b.authorized_to_maintain_liabilities,
    b.unauthorized,
    rec.claimable_balances_amount,
    rec.liquidity_pools_amount,
    rec.contracts_amount,
  ];
  const amount = parts.reduce((s, x) => s + (x ? Number(x) : 0), 0);
  return { amount };
}

export async function readXrplSupply(client, currency, issuer) {
  const r = await client.jsonRpc("gateway_balances", [{ account: issuer, ledger_index: "validated", strict: true }]);
  if (r.status && r.status !== "success") throw new Error(r.error_message || r.error || "Erreur XRPL");
  const ob = r.obligations || {};
  const ascii = hexCurrencyToAscii(currency);
  const v = ob[currency] ?? ob[currency.toUpperCase()] ?? (ascii ? ob[ascii] : undefined);
  return { amount: v ? Number(v) : 0, ledger: r.ledger_index };
}

function hexCurrencyToAscii(hex) {
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) return null;
  let s = "";
  for (let i = 0; i < 40; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    if (c) s += String.fromCharCode(c);
  }
  return s;
}
