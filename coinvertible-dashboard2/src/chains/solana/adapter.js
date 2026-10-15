// @ts-check
/** Solana: supply of several mints in one getMultipleAccounts call (works for Token-2022). */
import { RpcError } from "../../core/rpc-pool.js";

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
