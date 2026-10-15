// @ts-check
/**
 * monitoring.supply — issued supply of every token on every chain (everything counted).
 *   Ethereum: totalSupply()                 Solana: mint supply (getMultipleAccounts)
 *   Stellar:  Horizon /assets sum           XRPL:   gateway_balances obligations
 */
import { Module } from "../base.js";
import { call, dec } from "../../chains/evm/abi.js";
import { formatUnits, parseUnits, rescale } from "../../core/decimal.js";
import { stellarSupplyRaw, STELLAR_DECIMALS } from "../../chains/stellar/adapter.js";
import { hexCurrencyToAscii } from "../../chains/xrpl/adapter.js";
import { storage } from "../../core/storage.js";

const XRPL_DECIMALS = 15; // IOU amounts have up to 15 significant digits; 15 decimals is enough to hold them exactly here
const TOTAL_DECIMALS = 18;

export class SupplyModule extends Module {
  constructor(app) {
    const { chains, tokens } = app.config;
    const used = Object.keys(chains).filter((k) => chains[k].enabled && Object.values(tokens).some((t) => t.deployments[k]));
    super(app, { id: "monitoring.supply", page: "monitoring", chains: used, schedules: [{ id: "monitoring.supply" }] });
    /** values[token][chain] = { raw, decimals } */
    this.values = {};
    this.checkedDecimals = storage.get("imm:decimals", {}) || {};
    this.mintBurnDirty = true;
    this.lastFullEvm = 0;
    app.bus.on("mintburn:new", () => { this.mintBurnDirty = true; });
  }

  deps(chain) {
    return Object.entries(this.app.config.tokens)
      .filter(([, t]) => t.deployments[chain])
      .map(([sym, t]) => ({ sym, dep: t.deployments[chain] }));
  }

  set(sym, chain, raw, decimals) {
    (this.values[sym] ||= {})[chain] = { raw, decimals };
  }

  async run(chain, ctx) {
    const type = this.app.config.chains[chain].type;
    if (type === "evm") await this.runEvm(chain, ctx);
    else if (type === "solana") await this.runSolana(chain);
    else if (type === "stellar") await this.runStellar(chain);
    else if (type === "xrpl") await this.runXrpl(chain);
    this.publish(this.build());
  }

  async runEvm(chain, ctx) {
    const list = this.deps(chain);
    const opt = this.app.config.frequency.options?.supplyOnlyOnMintBurn;
    const haveAll = list.every(({ sym }) => this.values[sym]?.[chain]);
    if (opt && haveAll && !this.mintBurnDirty && Date.now() - this.lastFullEvm < 300000) {
      // Supply cannot have changed without a mint/burn: keep the value, confirm it at this block.
      this.sourceOk(chain, { ...ctx.info(), skipped: true });
      return;
    }
    const needDec = list.filter(({ sym }) => !this.checkedDecimals[`${chain}:${sym}`]);
    const calls = [
      ...list.map(({ dep }) => call(dep.address, "totalSupply")),
      ...needDec.map(({ dep }) => call(dep.address, "decimals")),
    ];
    const res = await ctx.call(calls, this.id);
    needDec.forEach(({ sym, dep }, i) => {
      const d = dec.uint(res[list.length + i]);
      if (d == null) return;
      if (Number(d) !== dep.decimals) this.warn(`dec:${chain}:${sym}`, `${sym} on ${chain}: config says ${dep.decimals} decimals, chain says ${d}. Using the chain value.`);
      this.checkedDecimals[`${chain}:${sym}`] = Number(d);
    });
    storage.set("imm:decimals", this.checkedDecimals);
    list.forEach(({ sym, dep }, i) => {
      const raw = dec.uint(res[i]);
      if (raw == null) throw new Error(`${sym}.totalSupply() failed on ${chain}`);
      this.set(sym, chain, raw, this.checkedDecimals[`${chain}:${sym}`] ?? dep.decimals);
    });
    this.mintBurnDirty = false;
    this.lastFullEvm = Date.now();
    this.sourceOk(chain, ctx.info());
  }

  async runSolana(chain) {
    const list = this.deps(chain);
    const r = await this.app.adapters[chain].mintSupplies(list.map(({ dep }) => dep.mint), this.id);
    for (const { sym, dep } of list) {
      const s = r.supplies[dep.mint];
      if (s.decimals !== dep.decimals) this.warn(`dec:${chain}:${sym}`, `${sym} on ${chain}: config says ${dep.decimals} decimals, chain says ${s.decimals}. Using the chain value.`);
      this.set(sym, chain, s.raw, s.decimals);
    }
    this.sourceOk(chain, { slot: r.slot, endpoint: r.endpoint });
  }

  async runStellar(chain) {
    const list = this.deps(chain);
    const byIssuer = new Map();
    for (const it of list) byIssuer.set(it.dep.issuer, [...(byIssuer.get(it.dep.issuer) || []), it]);
    let endpoint = null;
    for (const [issuer, items] of byIssuer) {
      const r = await this.app.adapters[chain].issuerAssets(issuer, this.id);
      endpoint = r.endpoint;
      for (const { sym, dep } of items) {
        const rec = r.records.find((x) => x.asset_code === dep.code && x.asset_issuer === dep.issuer);
        if (!rec) throw new Error(`Stellar: asset ${dep.code}-${dep.issuer} not found on Horizon`);
        this.set(sym, chain, stellarSupplyRaw(rec), STELLAR_DECIMALS);
      }
    }
    this.sourceOk(chain, { endpoint });
  }

  async runXrpl(chain) {
    const list = this.deps(chain);
    const byIssuer = new Map();
    for (const it of list) byIssuer.set(it.dep.issuer, [...(byIssuer.get(it.dep.issuer) || []), it]);
    let ledger = null, endpoint = null;
    for (const [issuer, items] of byIssuer) {
      const r = await this.app.adapters[chain].gatewayBalances(issuer, this.id);
      ledger = r.ledger;
      endpoint = r.endpoint;
      for (const { sym, dep } of items) {
        const ob = r.obligations;
        const ascii = hexCurrencyToAscii(dep.currency);
        const v = ob[dep.currency] ?? ob[dep.currency.toUpperCase()] ?? (ascii ? ob[ascii] : undefined);
        this.set(sym, chain, v == null ? 0n : parseUnits(v, XRPL_DECIMALS), XRPL_DECIMALS);
      }
    }
    this.sourceOk(chain, { ledger, endpoint });
  }

  build() {
    const out = {};
    for (const [sym, t] of Object.entries(this.app.config.tokens)) {
      const chains = {};
      let total = 0n;
      let partial = false;
      for (const chain of Object.keys(t.deployments)) {
        if (!this.app.config.chains[chain]?.enabled) continue;
        const v = this.values[sym]?.[chain];
        const src = this.sources[chain];
        if (!v) { partial = true; chains[chain] = { amount: null, status: src?.status || "pending" }; continue; }
        if (src?.status === "error") partial = true;
        total += rescale(v.raw, v.decimals, TOTAL_DECIMALS);
        chains[chain] = { amount: formatUnits(v.raw, v.decimals), raw: v.raw.toString(), decimals: v.decimals, status: src?.status || "ok" };
      }
      for (const c of Object.values(chains)) {
        c.share = c.amount != null && total > 0n ? Number(parseUnits(c.amount, TOTAL_DECIMALS)) / Number(total) : null;
      }
      out[sym] = { name: t.name, currency: t.currency, total: formatUnits(total, TOTAL_DECIMALS), partial, chains };
    }
    return out;
  }
}
