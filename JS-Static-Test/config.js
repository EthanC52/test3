/**
 * ============================================================================
 *  CONFIGURATION — CoinVertible Monitor
 * ============================================================================
 *  C'est le SEUL fichier à modifier pour brancher tes propres RPC.
 *
 *  - rpcUrls : liste d'URL par réseau. La première est utilisée, les suivantes
 *    servent de secours (bascule automatique en cas d'erreur / timeout).
 *  - enabled : false pour ne plus interroger un réseau (et l'exclure du total).
 *
 *  ⚠️  Ce fichier est servi publiquement par GitHub Pages : toute clé d'API
 *  mise ici est visible par n'importe qui. Utilise des clés restreintes par
 *  domaine (allowlist "https://<user>.github.io") côté provider (Alchemy,
 *  Infura, QuickNode, Helius…), ou passe par le panneau "Réglages" de la page
 *  qui enregistre tes RPC uniquement dans ton navigateur (localStorage).
 * ============================================================================
 */
window.APP_CONFIG = {
  /** Fréquence de rafraîchissement (ms). */
  pollIntervalMs: 3000,

  /** Timeout d'une requête RPC (ms) avant de basculer sur l'URL de secours. */
  requestTimeoutMs: 8000,

  /** Met les requêtes en pause quand l'onglet n'est pas visible (économise tes crédits RPC). */
  pauseWhenHidden: true,

  /** Autorise la surcharge des RPC depuis le panneau "Réglages" (stockée en localStorage). */
  allowUiOverride: true,

  /* -------------------------------------------------------------------------- */
  /*  Réseaux                                                                    */
  /* -------------------------------------------------------------------------- */
  networks: {
    ethereum: {
      type: "evm",
      label: "Ethereum",
      enabled: true,
      rpcUrls: [
        "https://ethereum-rpc.publicnode.com",
        // "https://eth-mainnet.g.alchemy.com/v2/<TA_CLE>",
      ],
      // Multicall3 : toutes les lectures EVM d'un cycle partent en 1 seul eth_call,
      // lues au même bloc (indispensable pour un calcul de donations cohérent).
      multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
      explorer: "https://etherscan.io/address/",
    },
    solana: {
      type: "solana",
      label: "Solana",
      enabled: true,
      rpcUrls: ["https://api.mainnet-beta.solana.com"],
      explorer: "https://solscan.io/token/",
    },
    stellar: {
      type: "stellar",
      label: "Stellar",
      enabled: true,
      // Endpoint Horizon (REST)
      rpcUrls: ["https://horizon.stellar.org"],
      explorer: "https://stellar.expert/explorer/public/asset/",
    },
    xrpl: {
      type: "xrpl",
      label: "XRP Ledger",
      enabled: true,
      rpcUrls: ["https://xrplcluster.com", "https://s2.ripple.com:51234"],
      explorer: "https://livenet.xrpl.org/accounts/",
    },
  },

  /* -------------------------------------------------------------------------- */
  /*  Tokens (adresses officielles SG-FORGE)                                     */
  /* -------------------------------------------------------------------------- */
  tokens: {
    EURCV: {
      name: "EUR CoinVertible",
      currency: "EUR",
      deployments: {
        ethereum: { address: "0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2" },
        solana: { mint: "DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52" },
        stellar: { code: "EURCV", issuer: "GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G" },
        xrpl: { currency: "4555524356000000000000000000000000000000", issuer: "rUNaS5sqRuxZz6V7rBGhoSaZiVYA3ut4UL" },
      },
    },
    USDCV: {
      name: "USD CoinVertible",
      currency: "USD",
      deployments: {
        ethereum: { address: "0x5422374B27757da72d5265cC745ea906E0446634" },
        solana: { mint: "8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35" },
      },
    },
  },

  /* -------------------------------------------------------------------------- */
  /*  Vault Morpho suivi pour les incentives                                     */
  /* -------------------------------------------------------------------------- */
  vault: {
    network: "ethereum",
    // Steakhouse Prime EURCV — Morpho Vault V2, APY plafonné par maxRate,
    // alimenté par des donations d'EURCV.
    address: "0xbeef0C075Da5D01112AE5cF34d257074fB5DDB2f",
    label: "Steakhouse Prime EURCV",
    url: "https://app.morpho.org/ethereum/vault/0xbeef0C075Da5D01112AE5cF34d257074fB5DDB2f/steakhouse-prime-eurcv",

    // Alternative : le vault "EURCV Prime" de MEV Capital (Morpho Vault V1.1).
    // Le type (V1 / V2) est détecté automatiquement on-chain.
    // address: "0x34eCe536d2ae03192B06c0A67030D1Faf4c0Ba43",
    // label: "MEV Capital EURCV Prime",
    // url: "https://app.morpho.org/ethereum/vault/0x34eCe536d2ae03192B06c0A67030D1Faf4c0Ba43/eurcv-prime",

    /** Fenêtre (s) utilisée pour mesurer la consommation réelle du buffer d'incentives. */
    burnWindowSec: 900,
  },
};
