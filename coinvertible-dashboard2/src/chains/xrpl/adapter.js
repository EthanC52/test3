// @ts-check
/** XRP Ledger: issued amount = gateway_balances obligations of the issuer, on a validated ledger. */
import { RpcError } from "../../core/rpc-pool.js";

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

/** "4555524356000000…" → "EURCV" (non-standard 160-bit currency code). */
export function hexCurrencyToAscii(hex) {
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) return null;
  let s = "";
  for (let i = 0; i < 40; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    if (c) s += String.fromCharCode(c);
  }
  return s;
}
