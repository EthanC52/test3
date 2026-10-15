// @ts-check
/**
 * Chains and their endpoints.
 *
 * Endpoint fields:
 *   id                short name shown in diagnostics
 *   url               endpoint URL (public endpoints only: this file is readable by anyone who can open the site)
 *   maxRps            max requests per second sent to this endpoint (token bucket)
 *   weight            share of the load relative to the other endpoints of the chain
 *   capabilities      EVM only: "calls" (eth_call) and/or "logs" (eth_getLogs)
 *   maxMulticallSize  EVM only: max sub-calls in one Multicall3 eth_call
 *   maxLogRange       EVM only: max blocks per eth_getLogs
 *   logDepth          EVM only: how far back (in blocks from head) the endpoint serves logs. Omit = unlimited.
 *
 * Limits below were measured on 2026-10-15. The pool also learns tighter limits at runtime
 * when an endpoint answers "range too large" or "archive required".
 *
 * Users can override the endpoints of a chain from the settings button (stored in their browser only).
 */
export const CHAINS = {
  ethereum: {
    type: "evm",
    label: "Ethereum",
    chainId: 1,
    enabled: true,
    explorer: { tx: "https://etherscan.io/tx/", address: "https://etherscan.io/address/" },
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    confirmations: 0, // eth_call reads at head - confirmations
    logConfirmations: 2, // eth_getLogs stops at head - 2 (protects against 1-2 block reorgs)
    endpoints: [
      { id: "publicnode", url: "https://ethereum-rpc.publicnode.com", maxRps: 3, weight: 2,
        capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 9500, logDepth: 9500 },
      { id: "tenderly", url: "https://gateway.tenderly.co/public/mainnet", maxRps: 2, weight: 1,
        capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 10000 },
      { id: "mevblocker", url: "https://rpc.mevblocker.io", maxRps: 2, weight: 1,
        capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 10000 },
      { id: "drpc", url: "https://eth.drpc.org", maxRps: 2, weight: 1,
        capabilities: ["calls"], maxMulticallSize: 150 },
    ],
  },

  solana: {
    type: "solana",
    label: "Solana",
    enabled: true,
    explorer: { tx: "https://solscan.io/tx/", address: "https://solscan.io/account/" },
    // api.mainnet-beta.solana.com is NOT usable here: it answers 403 to any request sent from a web page (Origin header).
    endpoints: [
      { id: "publicnode", url: "https://solana-rpc.publicnode.com", maxRps: 2, weight: 2 },
      { id: "tatum", url: "https://solana-mainnet.gateway.tatum.io", maxRps: 1, weight: 1 },
      { id: "solanavibestation", url: "https://public.rpc.solanavibestation.com", maxRps: 1, weight: 1 },
    ],
  },

  stellar: {
    type: "stellar",
    label: "Stellar",
    enabled: true,
    explorer: { tx: "https://stellar.expert/explorer/public/tx/", address: "https://stellar.expert/explorer/public/account/" },
    endpoints: [
      { id: "sdf-horizon", url: "https://horizon.stellar.org", maxRps: 2, weight: 1 },
    ],
  },

  xrpl: {
    type: "xrpl",
    label: "XRP Ledger",
    enabled: true,
    explorer: { tx: "https://livenet.xrpl.org/transactions/", address: "https://livenet.xrpl.org/accounts/" },
    // s1/s2.ripple.com answer but send no CORS header, so a browser cannot read them.
    endpoints: [
      { id: "xrplcluster", url: "https://xrplcluster.com", maxRps: 2, weight: 1 },
      { id: "xrpl.link", url: "https://xrpl.link", maxRps: 2, weight: 1 },
    ],
  },

  // Pending:
  // base:   { type: "evm", label: "Base", chainId: 8453, enabled: false, multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11", ... },
  // canton: no public RPC.
};

/** Non-chain HTTP APIs, rate-limited through the same pool mechanism. */
export const APIS = {
  morpho: { id: "morpho-api", url: "https://api.morpho.org/graphql", maxRps: 1 },
  geckoterminal: { id: "geckoterminal", url: "https://api.geckoterminal.com/api/v2", maxRps: 0.5 },
};

/** Timeout of one request before failing over to the next endpoint (ms). */
export const REQUEST_TIMEOUT_MS = 8000;
