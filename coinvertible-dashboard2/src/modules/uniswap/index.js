// @ts-check
/**
 * DeFi/Uniswap — whitelisted pools only.
 *   uniswap.liquidity (Ethereum tick): token0/token1.balanceOf(pool), in one coalesced multicall
 *   uniswap.volume    (GeckoTerminal): 24 h volume in USD, all pools in one call
 */
import { Module } from "../base.js";
import { call, dec, enc } from "../../chains/evm/abi.js";
import { formatUnits } from "../../core/decimal.js";
import { storage } from "../../core/storage.js";

export class UniswapModule extends Module {
  constructor(app) {
    const cfg = app.config.uniswap;
    super(app, {
      id: "uniswap", page: "uniswap", chains: [cfg.chain, "api:geckoterminal"],
      schedules: [
        { id: "uniswap.liquidity", chains: [cfg.chain] },
        { id: "uniswap.volume", chains: ["api:geckoterminal"] },
      ],
    });
    this.cfg = cfg;
    this.chain = cfg.chain;
    /** pool address → { token0, token1, t0:{symbol,decimals}, t1:{…} } */
    this.meta = storage.get(`uniswap:meta:${this.chain}`, null) || {};
    this.liq = {};
    this.vol = {};
  }

  async ensureMeta(ctx) {
    const pools = this.cfg.pools.map((p) => p.address.toLowerCase()).filter((a) => !this.meta[a]?.t1?.decimals);
    if (!pools.length) return;
    const res = await ctx.call(pools.flatMap((a) => [call(a, "token0"), call(a, "token1")]), this.id);
    const tokens = new Set();
    const pairs = {};
    pools.forEach((a, i) => {
      const t0 = dec.addr(res[i * 2]), t1 = dec.addr(res[i * 2 + 1]);
      if (!t0 || !t1) { this.warn(`pool:${a}`, `${a}: token0()/token1() failed — is it a Uniswap v3 pool?`); return; }
      pairs[a] = { token0: t0, token1: t1 };
      tokens.add(t0); tokens.add(t1);
    });
    const tl = [...tokens];
    const r2 = await ctx.call(tl.flatMap((t) => [call(t, "symbol"), call(t, "decimals")]), this.id);
    const tm = {};
    tl.forEach((t, i) => { tm[t] = { symbol: dec.string(r2[i * 2]) || "?", decimals: Number(dec.uint(r2[i * 2 + 1]) ?? 18n) }; });
    // Assign complete entries only, so a concurrent build() never sees half-filled metadata.
    for (const [a, p] of Object.entries(pairs)) this.meta[a] = { ...p, t0: tm[p.token0], t1: tm[p.token1] };
    storage.set(`uniswap:meta:${this.chain}`, this.meta);
  }

  async run(chain, ctx) {
    if (chain === "api:geckoterminal") await this.runVolume();
    else await this.runLiquidity(chain, ctx);
    this.publish(this.build());
  }

  async runLiquidity(chain, ctx) {
    await this.ensureMeta(ctx);
    const pools = this.cfg.pools.map((p) => p.address.toLowerCase()).filter((a) => this.meta[a]);
    const res = await ctx.call(pools.flatMap((a) => [call(this.meta[a].token0, "balanceOf", enc.addr(a)), call(this.meta[a].token1, "balanceOf", enc.addr(a))]), this.id);
    pools.forEach((a, i) => {
      const b0 = dec.uint(res[i * 2]), b1 = dec.uint(res[i * 2 + 1]);
      this.liq[a] = { b0, b1, block: ctx.block };
    });
    this.sourceOk(chain, ctx.info());
  }

  async runVolume() {
    const pool = this.app.apiPools.geckoterminal;
    const addrs = this.cfg.pools.map((p) => p.address.toLowerCase());
    const info = {};
    const j = await pool.getJson(`/networks/${this.cfg.network}/pools/multi/${addrs.join(",")}`, { module: this.id, info, label: "GET pools/multi" });
    const seen = new Set();
    for (const p of j?.data || []) {
      const a = String(p.attributes?.address || "").toLowerCase();
      const v = p.attributes?.volume_usd?.h24;
      seen.add(a);
      this.vol[a] = { volumeUsd24h: v == null ? null : Number(v), reserveUsd: p.attributes?.reserve_in_usd == null ? null : Number(p.attributes.reserve_in_usd), at: Date.now() };
    }
    const missing = addrs.filter((a) => !seen.has(a));
    if (missing.length) this.warn("gt-missing", `GeckoTerminal has no data for ${missing.join(", ")}`); else this.clearWarn("gt-missing");
    this.sourceOk("geckoterminal", { endpoint: info.endpoint });
  }

  /** The scheduler reports failures with the chain key; map the API key to the source name. */
  fail(chain, err, ids) {
    super.fail(chain === "api:geckoterminal" ? "geckoterminal" : chain, err, ids);
  }

  build() {
    const pools = this.cfg.pools.map((p) => {
      const a = p.address.toLowerCase();
      const m = this.meta[a];
      const l = this.liq[a];
      const v = this.vol[a];
      return {
        address: p.address,
        label: p.label,
        version: p.version,
        tokens: m?.t0 && m?.t1 ? [
          { symbol: m.t0?.symbol, address: m.token0, amount: l?.b0 != null ? formatUnits(l.b0, m.t0.decimals) : null },
          { symbol: m.t1?.symbol, address: m.token1, amount: l?.b1 != null ? formatUnits(l.b1, m.t1.decimals) : null },
        ] : [],
        volumeUsd24h: v?.volumeUsd24h ?? null,
        block: l?.block ?? null,
      };
    });
    return { pools };
  }
}
