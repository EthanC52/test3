// @ts-check
/**
 * Stellar through Horizon. A classic asset has no supply stored on-ledger: Horizon's /assets
 * aggregates every trustline, claimable balance, liquidity pool and SAC contract balance.
 */
import { parseUnits } from "../../core/decimal.js";

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
