// @ts-check
/**
 * CoinVertible deployments per chain. Decimals are checked against the chain at first read.
 */
export const TOKENS = {
  EURCV: {
    name: "EUR CoinVertible",
    currency: "EUR",
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
    deployments: {
      ethereum: { address: "0x5422374B27757da72d5265cC745ea906E0446634", decimals: 18 },
      solana: { mint: "8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35", decimals: 2, program: "token-2022" },
    },
  },
};
