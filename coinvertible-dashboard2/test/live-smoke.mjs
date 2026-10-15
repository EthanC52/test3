// Live smoke test (dev only): runs every module once or twice against the configured endpoints.
// Usage: NODE_USE_ENV_PROXY=1 node test/live-smoke.mjs   (the proxy variable is only needed behind a proxy)
import { createApp } from "../src/main.js";

const app = await createApp();
if (app.config.errors.length) { console.error("Config errors:", app.config.errors); process.exit(1); }
console.log("warnings:", app.config.warnings);

async function tick(chain, mods, ids) {
  const adapter = app.adapters[chain];
  const ctx = adapter?.beginTick ? await adapter.beginTick() : { chain };
  await Promise.all(mods.map((m) => m.run(chain, ctx, ids?.[m.id] || m.schedules.map((s) => s.id))));
  return ctx;
}

const [supply, mintburn, morpho, uniswap] = app.modules;
const t0 = Date.now();

// Monitoring page: all chains, supply + mint/burn coalesced on Ethereum
await tick("ethereum", [supply, mintburn]);
for (const c of ["solana", "stellar", "xrpl"]) await tick(c, [supply]);
const sup = app.store.get("monitoring.supply");
console.log("\n== supply", sup.status, JSON.stringify(sup.sources));
for (const [sym, t] of Object.entries(sup.data)) console.log(sym, t.total, t.partial ? "(partial)" : "", Object.fromEntries(Object.entries(t.chains).map(([c, v]) => [c, v.amount])));

const mb = app.store.get("monitoring.mintburn");
console.log("\n== mintburn", mb.status, mb.warnings, "cursor", mb.data.cursor, "scannedFrom", mb.data.scannedFrom);
for (const e of mb.data.events) console.log(new Date(e.timestamp * 1000).toISOString(), e.token, e.type.padEnd(4), e.counterparty.address, e.counterparty.label || "", e.attribution, e.amount, e.txHashShort);

// second tick: steady state (incremental logs)
await new Promise((r) => setTimeout(r, 13000));
const ctx2 = await tick("ethereum", [supply, mintburn]);
console.log("second tick head", ctx2.head, "events", app.store.get("monitoring.mintburn").data.events.length);

// Morpho: whitelisted + others
await tick("ethereum", [morpho]);
const mo = app.store.get("morpho");
console.log("\n== morpho", mo.status, mo.warnings);
console.log("overview", mo.data.overview, "counts", mo.data.counts);
for (const v of mo.data.vaults) {
  console.log(`${v.whitelist ? "W" : " "} V${v.version} ${v.label.padEnd(36)} deposits ${Number(v.totalDeposits).toFixed(0).padStart(12)} idle ${(v.idlePct * 100).toFixed(2)}% apy ${(v.apy * 100).toFixed(3)}% native ${(v.nativeApy * 100).toFixed(3)}%`, v.incentives ? `buffer ${v.incentives.buffer.toFixed(2)} burn/day ${v.incentives.burnPerDay.toFixed(0)} runway ${(v.incentives.runwaySec / 86400).toFixed(2)}d` : "");
}
for (const m of mo.data.markets.slice(0, 40)) console.log(`${m.whitelist ? "W" : " "} ${m.pair.padEnd(18)} lltv ${(m.lltv * 100).toFixed(1)} util ${(m.utilization * 100).toFixed(2)}% ${m.utilizationBand.padEnd(6)} borrowAPY ${(m.borrowApy * 100).toFixed(3)}% supplied ${Number(m.totalSupplied).toFixed(0)}`);

// Uniswap
await tick("ethereum", [uniswap]);
await tick("api:geckoterminal", [uniswap]);
const un = app.store.get("uniswap");
console.log("\n== uniswap", un.status, un.warnings, JSON.stringify(un.sources));
for (const p of un.data.pools) console.log(p.label, p.tokens.map((t) => `${t.amount} ${t.symbol}`).join(" | "), "vol24h $", p.volumeUsd24h);

console.log("\n== requests", Math.round((Date.now() - t0) / 1000), "s");
for (const r of app.stats.rows("endpoint")) console.log(r.key.padEnd(28), "total", r.total, "errors", r.errors, "429", r.rateLimited, "p50", r.p50, r.lastError || "");
for (const r of app.stats.rows("module")) console.log("module", r.key.padEnd(40), "total", r.total, "subcalls", r.subcalls);
process.exit(0);
