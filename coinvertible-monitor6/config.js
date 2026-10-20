/*
 * CoinVertible Dashboard - configuration.
 * With known_addresses.json, this is the only file you normally edit.
 * Loaded as a classic script before app.js; it defines globalThis.CV_CONFIG.
 * Everything here is readable by anyone who can open the site: public endpoints only.
 */
globalThis.CV_CONFIG = {
  /** Timeout of one request before failing over to the next endpoint (ms). */
  requestTimeoutMs: 8000,

  /* ------------------------------------------------------------------------------------------
   * CHAINS AND ENDPOINTS
   * Endpoint fields:
   *   id                short name shown in diagnostics
   *   url               endpoint URL
   *   maxRps            max requests per second sent to this endpoint (token bucket)
   *   weight            share of the load relative to the other endpoints of the chain
   *   capabilities      EVM only: "calls" (eth_call) and/or "logs" (eth_getLogs)
   *   maxMulticallSize  EVM only: max sub-calls in one Multicall3 eth_call
   *   maxLogRange       EVM only: max blocks per eth_getLogs
   *   logDepth          EVM only: how far back (blocks from head) the endpoint serves logs. Omit = unlimited.
   * Endpoint list = the RPCs that pass the corporate proxy (tested 2026-10-15), without API keys.
   * Capabilities and limits measured the same day. The pool also learns tighter limits at runtime.
   * Users can override the endpoints of a chain with the settings button (stored in their browser only).
   * Not used, on purpose:
   *   Ethereum: Alchemy demo key, RPCFast (API keys) - Fullsend (no CORS) - Tatum (eth_call paid only,
   *             logs limited to 100 blocks) - Flashbots Protect (no eth_call, returns empty logs instead of
   *             an error on old blocks) - MeowRPC (no eth_call, no eth_getLogs) - PublicNode, dRPC (blocked
   *             by the proxy).
   *   Solana:   Uniblock (no CORS) - api.mainnet(-beta).solana.com (blocked by the proxy; also refuses web pages).
   * ------------------------------------------------------------------------------------------ */
  chains: {
    ethereum: {
      type: "evm",
      label: "Ethereum",
      chainId: 1,
      enabled: true,
      explorer: { tx: "https://etherscan.io/tx/", address: "https://etherscan.io/address/" },
      multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
      nativeSymbol: "ETH",
      confirmations: 0, // eth_call reads at head - confirmations
      logConfirmations: 2, // eth_getLogs stops at head - 2 (protects against 1-2 block reorgs)
      endpoints: [
        // eth_call + eth_getLogs with full history.
        // NOWNodes serves very large ranges (2.8M blocks in one call, 1.6 s, tested 2026-10-19): it is the
        // only endpoint used for the Uniswap LP history. If it is down, the LP positions show "history unavailable".
        { id: "nownodes", url: "https://public-eth.nownodes.io", maxRps: 2, weight: 2,
          capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 3000000 },
        { id: "pocket", url: "https://eth.api.pocket.network", maxRps: 2, weight: 2,
          capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 10000 },
        { id: "swiftnodes", url: "https://rpc.swiftnodes.io/rpc/eth", maxRps: 2, weight: 2,
          capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 100 },
        { id: "blockmachine", url: "https://rpc-eth.blockmachine.io", maxRps: 2, weight: 1,
          capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 9999 },
        // eth_call + eth_getLogs limited to 50 blocks (enough for the per-block refresh, not for history)
        { id: "nodies", url: "https://ethereum-public.nodies.app", maxRps: 1, weight: 1,
          capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 50 },
        { id: "nodies-pokt", url: "https://eth-pokt.nodies.app", maxRps: 1, weight: 1,
          capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 50 },
        // eth_call only (eth_getLogs not available or unreliable without an account)
        { id: "bloxroute", url: "https://eth.rpc.blxrbdn.com/", maxRps: 1, weight: 1, capabilities: ["calls"], maxMulticallSize: 150 },
        { id: "bloxroute-sg", url: "https://singapore.rpc.blxrbdn.com/", maxRps: 1, weight: 1, capabilities: ["calls"], maxMulticallSize: 150 },
        { id: "bloxroute-uk", url: "https://uk.rpc.blxrbdn.com/", maxRps: 1, weight: 1, capabilities: ["calls"], maxMulticallSize: 150 },
        { id: "bloxroute-va", url: "https://virginia.rpc.blxrbdn.com/", maxRps: 1, weight: 1, capabilities: ["calls"], maxMulticallSize: 150 },
        // stakely: small free quota, sometimes answers "not available for unregistered accounts"; the pool backs off.
        { id: "stakely", url: "https://ethereum-json-rpc.stakely.io", maxRps: 1, weight: 1, capabilities: ["calls"], maxMulticallSize: 150 },
        { id: "blockpi", url: "https://ethereum.public.blockpi.network/v1/rpc/public", maxRps: 1, weight: 1, capabilities: ["calls"], maxMulticallSize: 150 },
      ],
    },

    solana: {
      type: "solana",
      label: "Solana",
      enabled: true,
      explorer: { tx: "https://solscan.io/tx/", address: "https://solscan.io/account/" },
      endpoints: [
        { id: "solanavibestation", url: "https://public.rpc.solanavibestation.com", maxRps: 1, weight: 1 },
        { id: "solanatracker", url: "https://rpc.solanatracker.io/public", maxRps: 1, weight: 1 },
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

    // Pending - test endpoints with rpc-tester.html, then:
    // base:   { type: "evm", label: "Base", chainId: 8453, enabled: true, explorer: { tx: "https://basescan.org/tx/", address: "https://basescan.org/address/" },
    //           multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11", nativeSymbol: "ETH", confirmations: 0, logConfirmations: 2,
    //           endpoints: [ ...paste the tester output here... ] },
    //         + frequency.chains.base and the token deployments (tokens.<sym>.deployments.base).
    // canton: no public RPC.
  },

  /** Non-chain HTTP APIs, rate-limited through the same pool mechanism. */
  apis: {
    morpho: { id: "morpho-api", url: "https://api.morpho.org/graphql", maxRps: 1 },
    geckoterminal: { id: "geckoterminal", url: "https://api.geckoterminal.com/api/v2", maxRps: 0.5 },
    defillama: { id: "defillama", url: "https://stablecoins.llama.fi", maxRps: 0.5 }, // supply history only
  },

  /* ------------------------------------------------------------------------------------------
   * REFRESH FREQUENCIES (seconds)
   * - chains:  one tick per chain at this interval
   * - apis:    interval of HTTP APIs that are not chains
   * - modules: per module and per chain/api. null = same interval as the chain/api.
   *            Rounded UP to a multiple of the chain interval, so that every module due on the
   *            same tick shares one block and one Multicall batch.
   * Live request counts are in the Diagnostics panel (and window.cvStats).
   * ------------------------------------------------------------------------------------------ */
  frequency: {
    chains: {
      ethereum: 12, // ~1 block
      solana: 10,
      stellar: 20,
      xrpl: 20,
    },
    apis: {
      geckoterminal: 60, // free tier ~30 calls/min per IP, shared by everyone behind the same corporate IP
      defillama: 3600, // only checks the cache age; data re-fetched per cacheTtl["defillama.supply"]
    },
    modules: {
      "monitoring.supply": { ethereum: null, solana: null, stellar: null, xrpl: null },
      "monitoring.mintburn": { ethereum: null },
      "morpho.vaults": { ethereum: null }, // whitelisted vaults
      "morpho.vaults.others": { ethereum: null }, // "Show more" vaults, only while expanded
      "morpho.markets": { ethereum: null }, // whitelisted markets
      "morpho.markets.others": { ethereum: null }, // "Show more" markets, only while expanded
      "uniswap.pools": { ethereum: null }, // balances, price, ticks, oracles: one multicall per block
      "uniswap.positions": { ethereum: 60 }, // LP positions: new Mint/Burn logs + NFT positions
      "uniswap.volume": { geckoterminal: null },
      "monitoring.supplyHistory": { defillama: null },
    },
    /** Not data refresh: how long structural data is trusted before being re-read. */
    cacheTtl: {
      "morpho.discovery": 21600, // Morpho API lists (6 h)
      "morpho.structure": 900, // withdraw queues, adapters, adapter market ids
      "token.roles": 86400, // SmartCoin registrar / operations / technical
      "defillama.supply": 21600, // daily supply history from DefiLlama (data changes once a day)
      "morpho.history": 21600, // daily deposits history of the Main Vault (Morpho API)
    },
    behaviour: {
      pauseWhenHidden: true, // no calls while the tab is in the background
      skipIfSameBlock: true, // EVM: if head has not moved since a module's last run, skip that module
      shareAcrossTabs: true, // one leader tab per page polls, the others listen
      staleAfterIntervals: 3, // a value older than 3 x its interval is shown as stale
    },
    /** Optional savings, off by default. */
    options: {
      // Ethereum supply only changes on mint/burn: re-read totalSupply() only when the mint/burn
      // module sees one (and every 300 s as a safety). Only effective on the Monitoring page.
      supplyOnlyOnMintBurn: false,
    },
  },

  /* ------------------------------------------------------------------------------------------
   * TOKENS - CoinVertible deployments per chain. Decimals are checked against the chain.
   * ------------------------------------------------------------------------------------------ */
  tokens: {
    EURCV: {
      name: "EUR CoinVertible",
      currency: "EUR",
      defillamaId: 254, // stablecoins.llama.fi/stablecoin/254 - supply history chart
      deployments: {
        ethereum: { address: "0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2", decimals: 18 },
        solana: { mint: "DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52", decimals: 2, program: "token-2022" },
        stellar: { code: "EURCV", issuer: "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G", decimals: 7 },
        xrpl: { currency: "4555524356000000000000000000000000000000", issuer: "rUNaS5sqRuxZz6V7rBGhoSaZiVYA3ut4UL" },
      },
    },
    USDCV: {
      name: "USD CoinVertible",
      currency: "USD",
      defillamaId: 307, // stablecoins.llama.fi/stablecoin/307
      deployments: {
        ethereum: { address: "0x5422374B27757da72d5265cC745ea906E0446634", decimals: 18 },
        solana: { mint: "8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35", decimals: 2, program: "token-2022" },
      },
    },
  },

  /* ------------------------------------------------------------------------------------------
   * MORPHO
   * - Vaults and markets are discovered through the Morpho API (lists, names, logos only).
   *   Every number is read on-chain.
   * - whitelist: true  -> main list, always read (even if the API is down).
   *   Anything discovered but not whitelisted goes under "Show more".
   * - incentives: true -> Vault V2 only: reads the donation buffer and estimates its runway.
   * ------------------------------------------------------------------------------------------ */
  morpho: {
    chain: "ethereum",
    asset: "EURCV",
    morphoBlue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    appUrl: "https://app.morpho.org/ethereum", // vault / market names link to <appUrl>/vault|market/<id>/<slug>
    mainVault: null, // vault shown as "Main Vault"; null = the whitelisted vault with the largest deposits

    vaults: [
      { address: "0xbeef0C075Da5D01112AE5cF34d257074fB5DDB2f", label: "Steakhouse Prime EURCV", whitelist: true, incentives: true },
      { address: "0x34eCe536d2ae03192B06c0A67030D1Faf4c0Ba43", label: "EURCV Prime (MEV Capital)", whitelist: true },
      { address: "0xD6d4b804014EF27836dBe9f8f6Bf6c71251548Ec", label: "Belem RWA EURCV", whitelist: true },
      { address: "0xbeef0D24920098C404c7Fc7942ee6d0f66d65D57", label: "Safe x Steakhouse Prime Instant", whitelist: true },
    ],

    // Full 32-byte market ids. Pair names are not unique: there are two cbBTC/EURCV 86% markets
    // (different oracles), and two WBTC and two wstETH ones. Starting whitelist = every market above
    // ~$0.5M supplied on 2026-10-15 (amounts in comments are from that day, for orientation only).
    markets: [
      { id: "0x82053fe2fc3a3d6cb856458948e9c3589e76f20f3a2079606739b517587267ce", whitelist: true }, // cbBTC/EURCV 86% LLTV, oracle 0xbA75FD24.., ~$15.0M
      { id: "0x7a25fb17b8bd83a934ad87d9d1725188fc129992ca816f3145b4ab7f673c98c3", whitelist: true }, // wstETH/EURCV 86% LLTV, oracle 0xF13B2929.., ~$9.6M
      { id: "0xb7a75cabc2e8eadd0bc661340a9e359d9828bed6d5cbbcd64188bca8c01e399e", whitelist: true }, // WBTC/EURCV 86% LLTV, oracle 0x40721232.., ~$5.2M
      { id: "0x987b2c1979c6cfd6b7833d9b30c09b96ec6de1666579582d8f17730e20dd19b0", whitelist: true }, // mGLOeuro/EURCV 77% LLTV, oracle 0x2b43e079.., ~$5.2M
      { id: "0xb5f8d5554d85b782d7080314bba3544983755a75eb5c432f5eae1c47c6af4da4", whitelist: true }, // cbBTC/EURCV 86% LLTV, oracle 0xD08d519D.., ~$3.4M
      { id: "0xaa7231d6bee28b578efe38b52e801d5d3067023853342fc06ded437d2a80ef98", whitelist: true }, // EUTBL/EURCV 96.5% LLTV, oracle 0xf071b0a6.., ~$3.0M
      { id: "0x80c97dd236bafc6c5e41e84797efea2853511455f189525a8df70826a38cb282", whitelist: true }, // WBTC/EURCV 86% LLTV, oracle 0xd9547692.., ~$2.0M
      { id: "0x0b352b7550acdb1f39fea4b8f9ef8ac2d7953613b92599610b8fbec8a98a51d1", whitelist: true }, // wstETH/EURCV 86% LLTV, oracle 0x44D6d497.., ~$2.0M
      { id: "0xf135feb27b5f2bd2d54f344fd38dbb5161ff7f0ef4494901fb23f2fe8e58145a", whitelist: true }, // steakUSDC/EURCV 91.5% LLTV, oracle 0x74eC54c1.., ~$0.8M
      { id: "0x36da61bf253b8a7e07888cb96dbcde65001508159928801aeca932a5b5548119", whitelist: true }, // eurSAFO/EURCV 94.5% LLTV, oracle 0x8Bb55b19.., ~$0.7M
    ],
  },

  /* ------------------------------------------------------------------------------------------
   * UNISWAP - whitelisted pools only (v2, v3 or v4), never discovered at runtime.
   * Read on-chain at every block (one multicall): balances, slot0, liquidity, initialized ticks
   * (TickLens) and the Chainlink oracles. Depth, sale impact and the liquidity chart are computed
   * locally from the ticks (no quoter calls). Volume 24 h: GeckoTerminal (CoinGecko's DEX API).
   * LP positions: the pool's Mint/Burn history (one large eth_getLogs, then a few blocks per minute),
   * NFT positions resolved through the NonfungiblePositionManager.
   *   slug          page address: #/defi/uniswap/<slug>
   *   version       "v2" | "v3" | "v4" (default "v3")
   *   address       v2 pair / v3 pool address        id   v4 pool id (bytes32), instead of address
   *   createdBlock  first block of the pool (start of the LP history)
   *   fee           v2 only, in pips (default v2.defaultFee = 3000 = 0.30%)
   *   poolKey       v4 only, optional: { currency0, currency1, fee, tickSpacing, hooks } when the pool has
   *                 no NFT position yet (otherwise read from the PositionManager)
   * Examples:
   *   { slug: "eurcv-usdc-v2", version: "v2", address: "0x...", label: "EURCV/USDC", createdBlock: 0 },
   *   { slug: "eurcv-eurc-v4", version: "v4", id: "0x<64 hex>", label: "EURCV/EURC", createdBlock: 0 },
   * ------------------------------------------------------------------------------------------ */
  uniswap: {
    chain: "ethereum",
    network: "eth", // GeckoTerminal network id
    npm: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88", // NonfungiblePositionManager
    tickLens: "0xbfd8137f7d1516D3ea5cA83523914859ec47F573",
    v2: { defaultFee: 3000 },
    v4: {
      poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
      stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227",
      positionManager: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
    },
    appUrl: "https://app.uniswap.org", // pool and position links
    pools: [
      { slug: "eurcv-eurc", version: "v3", address: "0x6d074d42d50399581cc3d303b8024000a7897290", label: "EURCV/EURC", createdBlock: 24584043 },
      { slug: "eurcv-usdc", version: "v3", address: "0x1f195908f2ee7a6fc15d33b30c82298f568e805c", label: "EURCV/USDC", createdBlock: 23469089 },
      { slug: "usdcv-usdc", version: "v3", address: "0x27848b0c260961826c4135e69e6cdd45cfba8257", label: "USDCV/USDC", createdBlock: 23469056 },
    ],

    /** Chainlink feeds (latestRoundData). The first feed that answers, is fresh and agrees with the
     *  next one within maxDeviation is used; otherwise the next one. */
    oracles: {
      EURUSD: {
        maxAgeSec: 93600, // heartbeat 24 h + 2 h margin
        maxDeviation: 0.005, // SVR vs classic: above 0.5% apart, the SVR answer is not used
        feeds: [
          { label: "Chainlink EUR/USD (SVR)", address: "0xB34864138863eD5fB6fC8324e92d10fDa58b9902", decimals: 8 },
          { label: "Chainlink EUR/USD", address: "0xb49f677943BC038e9857d61E7d053CaA2C1734C1", decimals: 8 },
        ],
      },
      USDCUSD: {
        maxAgeSec: 93600,
        feeds: [{ label: "Chainlink USDC/USD", address: "0x37be050e75C7F0a80F0E8abBFC2c4Ff826728cAa", decimals: 8 }],
      },
    },
    /** USD value of one token: an oracle key above or a fixed number. 1 EURC = 1 EUR. */
    usdValue: { EURC: "EURUSD", USDC: "USDCUSD", EURCV: "EURUSD", USDCV: 1 },
    /** Peg target of each CoinVertible, in USD. Deviation = pool price x USD value of the other token / target - 1. */
    peg: { EURCV: "EURUSD", USDCV: 1 },
    pegThresholdsBps: [10, 50], // green below 10 bps, amber 10-50, red above 50
    depthBps: [10, 50, 100], // amount needed to move the price by these bands
    impactSizes: [100000, 500000, 1000000], // sale sizes, in units of the CoinVertible sold
  },

  /* ------------------------------------------------------------------------------------------
   * LOGOS - files you add in the logos/ folder (SVG recommended; any size or ratio, they are
   * fitted to their slot). A missing file shows a monogram instead. Morpho collateral logos are
   * not listed here: they come automatically from the Morpho API.
   * ------------------------------------------------------------------------------------------ */
  logos: {
    favicon: "logos/forge-favicon.png",
    brand: "logos/forge.svg", // top-left logo (36 px high, centred; the sidebar widens to fit it if needed)
    brandMark: "logos/forge-favicon.png", // shown when the sidebar is collapsed
    tokens: { EURCV: "logos/eurcv.png", USDCV: "logos/usdcv.png", EURC: "logos/eurc.svg", USDC: "logos/usdc.svg" },
    chains: { ethereum: "logos/ethereum.png", solana: "logos/solana.png", stellar: "logos/stellar.png", xrpl: "logos/xrpl.png" },
    nav: { morpho: "logos/morpho.svg", uniswap: "logos/uniswap.svg" }, // sidebar icons (others use built-in icons)
  },
};
