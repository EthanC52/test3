// @ts-check
/**
 * Loads the config modules, the known addresses file and the per-user RPC overrides,
 * and validates everything once at startup.
 */
import { CHAINS, APIS, REQUEST_TIMEOUT_MS } from "../../config/chains.js";
import { FREQUENCY } from "../../config/frequency.js";
import { TOKENS } from "../../config/tokens.js";
import { MORPHO } from "../../config/morpho.js";
import { UNISWAP } from "../../config/uniswap.js";
import { storage } from "./storage.js";
import { isHexAddress, isHex32 } from "./util.js";

const SETTINGS_KEY = "settings";

/** Per-user overrides saved by the settings dialog: { rpc: { [chainKey]: string[] } } */
export function getSettings() {
  return storage.get(SETTINGS_KEY, { rpc: {} }) || { rpc: {} };
}
export function saveSettings(s) {
  return storage.set(SETTINGS_KEY, s);
}

/** Endpoints entered by a user: unknown limits, so conservative defaults (the pool learns tighter ones). */
function overrideEndpoint(url, i, type) {
  const ep = { id: `custom-${i + 1}`, url, maxRps: 3, weight: 1 };
  if (type === "evm") Object.assign(ep, { capabilities: ["calls", "logs"], maxMulticallSize: 150, maxLogRange: 5000 });
  return ep;
}

async function loadKnownAddresses() {
  try {
    const url = new URL("../../config/known_addresses.json", import.meta.url);
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { data: await r.json(), error: null };
  } catch (e) {
    return { data: {}, error: `known_addresses.json could not be loaded (${e?.message || e})` };
  }
}

export async function loadConfig() {
  const errors = [];
  const warnings = [];
  const settings = getSettings();

  /** @type {Record<string, any>} */
  const chains = {};
  for (const [key, c] of Object.entries(CHAINS)) {
    const urls = (settings.rpc?.[key] || []).map((u) => String(u).trim()).filter(Boolean);
    const endpoints = urls.length ? urls.map((u, i) => overrideEndpoint(u, i, c.type)) : c.endpoints;
    chains[key] = { ...c, key, endpoints, overridden: urls.length > 0 };
    if (!c.enabled) continue;
    if (!["evm", "solana", "stellar", "xrpl"].includes(c.type)) errors.push(`chains.${key}: unknown type "${c.type}"`);
    if (!endpoints.length) errors.push(`chains.${key}: no endpoint`);
    for (const ep of endpoints) if (!/^https?:\/\//.test(ep.url || "")) errors.push(`chains.${key}: invalid endpoint URL "${ep.url}"`);
    if (c.type === "evm" && !isHexAddress(c.multicall3)) errors.push(`chains.${key}: invalid multicall3 address`);
    if (!(FREQUENCY.chains[key] > 0)) errors.push(`frequency.chains.${key}: missing or not > 0`);
  }

  for (const [mod, per] of Object.entries(FREQUENCY.modules)) {
    for (const [k, v] of Object.entries(per)) {
      if (v != null && !(v > 0)) errors.push(`frequency.modules["${mod}"].${k}: must be null or > 0`);
      if (!(k in FREQUENCY.chains) && !(k in FREQUENCY.apis)) warnings.push(`frequency.modules["${mod}"].${k}: unknown chain/api`);
    }
  }

  for (const [sym, t] of Object.entries(TOKENS)) {
    for (const [chain, d] of Object.entries(t.deployments)) {
      if (!CHAINS[chain]) { errors.push(`tokens.${sym}: unknown chain "${chain}"`); continue; }
      const type = CHAINS[chain].type;
      if (type === "evm" && !isHexAddress(d.address)) errors.push(`tokens.${sym}.${chain}: invalid address`);
      if (type === "solana" && !d.mint) errors.push(`tokens.${sym}.${chain}: missing mint`);
      if (type === "stellar" && !(d.code && d.issuer)) errors.push(`tokens.${sym}.${chain}: missing code/issuer`);
      if (type === "xrpl" && !(d.currency && d.issuer)) errors.push(`tokens.${sym}.${chain}: missing currency/issuer`);
    }
  }

  for (const v of MORPHO.vaults) if (!isHexAddress(v.address)) errors.push(`morpho.vaults: invalid address ${v.address}`);
  for (const m of MORPHO.markets) if (!isHex32(m.id)) errors.push(`morpho.markets: invalid market id ${m.id}`);
  if (!TOKENS[MORPHO.asset]?.deployments?.[MORPHO.chain]) errors.push(`morpho.asset: ${MORPHO.asset} not deployed on ${MORPHO.chain}`);
  for (const p of UNISWAP.pools) if (!isHexAddress(p.address)) errors.push(`uniswap.pools: invalid address ${p.address}`);

  const known = await loadKnownAddresses();
  if (known.error) warnings.push(known.error);

  return {
    chains,
    apis: APIS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    frequency: FREQUENCY,
    tokens: TOKENS,
    morpho: MORPHO,
    uniswap: UNISWAP,
    known: known.data,
    settings,
    errors,
    warnings,
  };
}
