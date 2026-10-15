// @ts-check
/**
 * Morpho API discovery: lists of vaults and markets for the configured asset, plus names and logos.
 * Never used for numbers. Values are inlined in the query (each filter expects a different scalar
 * type, so GraphQL variables cannot be shared); addresses are validated hex before use.
 */
import { isHexAddress } from "../../core/util.js";

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
    v1: vaults(first: 200, where: { assetAddress_in: ${a}, chainId_in: ${c} }) {
      items { address name symbol listed }
    }
    v2: vaultV2s(first: 200, where: { assetAddress_in: ${a}, chainId_in: ${c} }) {
      items { address name symbol listed adapters { items { address type } } }
    }
    markets: markets(first: 500, where: { loanAssetAddress_in: ${a}, chainId_in: ${c} }) {
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
    v1: (d.v1?.items || []).map((v) => ({ address: v.address, name: v.name, symbol: v.symbol, listed: !!v.listed, version: 1 })),
    v2: (d.v2?.items || []).map((v) => ({
      address: v.address, name: v.name, symbol: v.symbol, listed: !!v.listed, version: 2,
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
