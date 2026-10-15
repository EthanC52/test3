// @ts-check
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
};

export const TOPIC = {
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  RedemptionStarted: "0x8c0cc6a0302d83caa04c8ad7d86864df08505193f7cb978c03d53a765b09696b",
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_WORD = "0x" + "0".repeat(64);

const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);

/** Encoders for one 32-byte word (hex, no 0x). */
export const enc = {
  uint: (v) => BigInt(v).toString(16).padStart(64, "0"),
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
/** Topic (32 bytes) → address. */
export const topicAddr = (t) => "0x" + strip(t).slice(24).toLowerCase();

/** aggregate3((address target, bool allowFailure, bytes callData)[]) — allowFailure always true. */
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
