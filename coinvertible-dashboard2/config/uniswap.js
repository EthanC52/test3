// @ts-check
/**
 * Uniswap pools — whitelisted only, never discovered at runtime.
 * - Amount of each asset: token.balanceOf(pool) on-chain (v3).
 * - Volume 24 h: GeckoTerminal (CoinGecko's DEX API), in USD.
 * token0 / token1, their symbols and decimals are read on-chain once and cached.
 */
export const UNISWAP = {
  chain: "ethereum",
  network: "eth", // GeckoTerminal network id
  pools: [
    { version: "v3", address: "0x6d074d42d50399581cc3d303b8024000a7897290", label: "EURCV/EURC 0.01%" },
    { version: "v3", address: "0x1f195908f2ee7a6fc15d33b30c82298f568e805c", label: "EURCV/USDC 0.05%" },
    { version: "v3", address: "0x27848b0c260961826c4135e69e6cdd45cfba8257", label: "USDCV/USDC 0.01%" },
  ],
};
