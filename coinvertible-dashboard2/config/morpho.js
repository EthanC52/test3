// @ts-check
/**
 * Morpho configuration.
 *
 * - Vaults and markets are discovered through the Morpho API (lists, names, logos only).
 *   Every number is read on-chain.
 * - whitelist: true  → shown in the main list and always read, even if the API is down.
 *   Anything discovered but not whitelisted goes under "Show more".
 * - incentives: true → Vault V2 only: reads the donation buffer and estimates its runway.
 */
export const MORPHO = {
  chain: "ethereum",
  asset: "EURCV",
  morphoBlue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",

  vaults: [
    { address: "0xbeef0C075Da5D01112AE5cF34d257074fB5DDB2f", label: "Steakhouse Prime EURCV", whitelist: true, incentives: true },
    { address: "0x34eCe536d2ae03192B06c0A67030D1Faf4c0Ba43", label: "EURCV Prime (MEV Capital)", whitelist: true },
    { address: "0xD6d4b804014EF27836dBe9f8f6Bf6c71251548Ec", label: "Belem RWA EURCV", whitelist: true },
    { address: "0xbeef0D24920098C404c7Fc7942ee6d0f66d65D57", label: "Safe x Steakhouse Prime Instant", whitelist: true },
  ],

  // Full 32-byte market ids. Pair names are not unique: there are two cbBTC/EURCV 86% markets
  // (different oracles) and two WBTC and two wstETH ones. Starting whitelist = every market above
  // ~$0.5M supplied on 2026-10-15 (amounts in comments are from that day, for orientation only).
  markets: [
    { id: "0x82053fe2fc3a3d6cb856458948e9c3589e76f20f3a2079606739b517587267ce", whitelist: true }, // cbBTC/EURCV 86% LLTV, oracle 0xbA75FD24…, ~$15.0M
    { id: "0x7a25fb17b8bd83a934ad87d9d1725188fc129992ca816f3145b4ab7f673c98c3", whitelist: true }, // wstETH/EURCV 86% LLTV, oracle 0xF13B2929…, ~$9.6M
    { id: "0xb7a75cabc2e8eadd0bc661340a9e359d9828bed6d5cbbcd64188bca8c01e399e", whitelist: true }, // WBTC/EURCV 86% LLTV, oracle 0x40721232…, ~$5.2M
    { id: "0x987b2c1979c6cfd6b7833d9b30c09b96ec6de1666579582d8f17730e20dd19b0", whitelist: true }, // mGLOeuro/EURCV 77% LLTV, oracle 0x2b43e079…, ~$5.2M
    { id: "0xb5f8d5554d85b782d7080314bba3544983755a75eb5c432f5eae1c47c6af4da4", whitelist: true }, // cbBTC/EURCV 86% LLTV, oracle 0xD08d519D…, ~$3.4M
    { id: "0xaa7231d6bee28b578efe38b52e801d5d3067023853342fc06ded437d2a80ef98", whitelist: true }, // EUTBL/EURCV 96.5% LLTV, oracle 0xf071b0a6…, ~$3.0M
    { id: "0x80c97dd236bafc6c5e41e84797efea2853511455f189525a8df70826a38cb282", whitelist: true }, // WBTC/EURCV 86% LLTV, oracle 0xd9547692…, ~$2.0M
    { id: "0x0b352b7550acdb1f39fea4b8f9ef8ac2d7953613b92599610b8fbec8a98a51d1", whitelist: true }, // wstETH/EURCV 86% LLTV, oracle 0x44D6d497…, ~$2.0M
    { id: "0xf135feb27b5f2bd2d54f344fd38dbb5161ff7f0ef4494901fb23f2fe8e58145a", whitelist: true }, // steakUSDC/EURCV 91.5% LLTV, oracle 0x74eC54c1…, ~$0.8M
    { id: "0x36da61bf253b8a7e07888cb96dbcde65001508159928801aeca932a5b5548119", whitelist: true }, // eurSAFO/EURCV 94.5% LLTV, oracle 0x8Bb55b19…, ~$0.7M
  ],
};
