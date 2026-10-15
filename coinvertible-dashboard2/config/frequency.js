// @ts-check
/**
 * Refresh frequencies, in seconds.
 *
 * - chains: one tick per chain at this interval.
 * - apis:   interval of HTTP APIs that are not chains (GeckoTerminal…).
 * - modules: per module and per chain/api. `null` = same interval as the chain/api.
 *            Values are rounded UP to a multiple of the chain interval, so that every module
 *            due on the same tick shares one block pin and one Multicall batch.
 *
 * Live request counts per endpoint and per module are shown in the Diagnostics panel
 * (and in window.cvStats) to tune these values.
 */
export const FREQUENCY = {
  chains: {
    ethereum: 12, // ~1 block
    solana: 10,
    stellar: 20,
    xrpl: 20,
  },

  apis: {
    geckoterminal: 60, // free tier ~30 calls/min per IP, shared by everyone behind the same corporate IP
  },

  modules: {
    "monitoring.supply": { ethereum: null, solana: null, stellar: null, xrpl: null },
    "monitoring.mintburn": { ethereum: null },
    "morpho.vaults": { ethereum: null }, // whitelisted vaults
    "morpho.vaults.others": { ethereum: null }, // "Show more" vaults, only while expanded
    "morpho.markets": { ethereum: null }, // whitelisted markets
    "morpho.markets.others": { ethereum: null }, // "Show more" markets, only while expanded
    "uniswap.liquidity": { ethereum: null },
    "uniswap.volume": { geckoterminal: null },
  },

  /** Not data refresh: how long structural data is trusted before being re-read. */
  cacheTtl: {
    "morpho.discovery": 21600, // Morpho API lists (6 h)
    "morpho.structure": 900, // withdraw queues, adapters, adapter market ids
    "token.roles": 86400, // SmartCoin registrar / operations / technical
  },

  behaviour: {
    pauseWhenHidden: true, // no calls while the tab is in the background
    skipIfSameBlock: true, // EVM: if head has not moved since a module's last run, skip that module
    shareAcrossTabs: true, // one leader tab per page polls, the others listen
    staleAfterIntervals: 3, // a value older than 3 × its interval is shown as stale
  },

  /** Optional savings, off by default. */
  options: {
    // Ethereum supply only changes on mint/burn: re-read totalSupply() only when the mint/burn
    // module sees one (and every 300 s as a safety). Only effective when both run on the same page.
    supplyOnlyOnMintBurn: false,
  },
};
