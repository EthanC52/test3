// @ts-check
/**
 * DeFi/Morpho — vaults and markets for one asset (EURCV), all numbers read on-chain.
 *
 * Schedules (see frequency.js):
 *   morpho.vaults / morpho.markets                 whitelisted items
 *   morpho.vaults.others / morpho.markets.others   "Show more" items, only while expanded
 *
 * Per tick:
 *   0. discovery (Morpho API, cached 6 h) and structure (queues, adapters, cached 15 min) when needed
 *   A. one coalesced multicall: market(id), vault state, positions, adapter realAssets, lengths
 *   B. one multicall: IRM.borrowRateView(params, market) per market (needs A's market tuples)
 */
import { Module } from "../base.js";
import { call, dec, enc, ZERO_ADDRESS } from "../../chains/evm/abi.js";
import { formatUnits, toNumber } from "../../core/decimal.js";
import { storage } from "../../core/storage.js";
import { discover } from "./discovery.js";
import { accrue, marketRates, utilizationBand, toAssetsDown, vaultV2Rates, observedBurn, rateToApy, wadToFloat, YEAR } from "./math.js";

class Batch {
  constructor() { this.calls = []; this.cbs = []; }
  add(c, cb) { this.calls.push(c); this.cbs.push(cb); }
  async run(ctx, module) {
    if (!this.calls.length) return;
    const res = await ctx.call(this.calls, module);
    res.forEach((r, i) => this.cbs[i](r));
  }
}

const lc = (a) => (a ? a.toLowerCase() : a);
const isZero = (a) => !a || /^0x0{40}$/i.test(a);
const SAMPLE_KEEP_SEC = 7200;

export class MorphoModule extends Module {
  constructor(app) {
    const cfg = app.config.morpho;
    super(app, {
      id: "morpho", page: "morpho", chains: [cfg.chain],
      schedules: [
        { id: "morpho.vaults" },
        { id: "morpho.vaults.others", gate: "morpho.vaults.others" },
        { id: "morpho.markets" },
        { id: "morpho.markets.others", gate: "morpho.markets.others" },
      ],
    });
    this.cfg = cfg;
    this.chain = cfg.chain;
    const dep = app.config.tokens[cfg.asset].deployments[cfg.chain];
    this.asset = lc(dep.address);
    this.assetSymbol = cfg.asset;
    this.assetDecimals = dep.decimals;
    this.morpho = cfg.morphoBlue;
    this.chainId = app.config.chains[cfg.chain].chainId;
    this.disc = storage.get("morpho:discovery", null);
    /** immutable: market params and token metadata */
    this.imm = storage.get("morpho:imm", null) || { params: {}, tokens: {} };
    /** structure per vault address */
    this.structs = storage.get("morpho:struct", null) || {};
    this.samples = storage.get("morpho:buffers", null) || {};
    /** last outputs (kept across ticks so groups refreshed at different times can be published together) */
    this.outVaults = new Map();
    this.outMarkets = new Map();
    /** raw per market for totals */
    this.rawMarkets = new Map();
    this._discP = null;
    if (this.disc) this.labelVaults();
  }

  /* ───────────── lists ───────────── */

  labelVaults() {
    for (const v of [...(this.disc?.v1 || []), ...(this.disc?.v2 || [])]) this.app.labels.setAuto(this.chain, v.address, v.name, "morpho");
    for (const v of this.cfg.vaults) if (v.label) this.app.labels.setAuto(this.chain, v.address, v.label, "morpho");
  }

  allVaults() {
    const m = new Map();
    for (const v of [...(this.disc?.v1 || []), ...(this.disc?.v2 || [])]) {
      m.set(lc(v.address), { address: v.address, key: lc(v.address), apiName: v.name, listed: v.listed, versionHint: v.version, whitelist: false, incentives: false, label: null });
    }
    for (const v of this.cfg.vaults) {
      const k = lc(v.address);
      m.set(k, { ...(m.get(k) || { address: v.address, key: k, apiName: null, listed: null, versionHint: null }), whitelist: !!v.whitelist, incentives: !!v.incentives, label: v.label || null });
    }
    return m;
  }

  allMarkets() {
    const m = new Map();
    for (const x of this.disc?.markets || []) m.set(x.id, { id: x.id, meta: x, whitelist: false, idle: !x.collateral });
    for (const x of this.cfg.markets) {
      const id = lc(x.id);
      const cur = m.get(id) || { id, meta: null, idle: false };
      m.set(id, { ...cur, whitelist: !!x.whitelist });
    }
    // Idle-ness from on-chain params when known.
    for (const v of m.values()) {
      const p = this.imm.params[v.id];
      if (p) v.idle = isZero(p.collateralToken);
    }
    return m;
  }

  /* ───────────── discovery / immutable / structure ───────────── */

  async ensureDiscovery() {
    const ttl = (this.app.config.frequency.cacheTtl["morpho.discovery"] || 21600) * 1000;
    if (this.disc && Date.now() - this.disc.at < ttl) return;
    if (this._discP) return this._discP;
    this._discP = (async () => {
      try {
        this.disc = await discover(this.app.apiPools.morpho, this.asset, this.chainId);
        storage.set("morpho:discovery", this.disc);
        this.labelVaults();
        this.clearWarn("discovery");
      } catch (e) {
        this.warn("discovery", `Morpho API discovery failed (${e.message}); using ${this.disc ? "the cached list" : "the whitelist only"}.`);
        // retry in 5 minutes
        this.disc = { ...(this.disc || { v1: [], v2: [], markets: [] }), at: Date.now() - ttl + 300000 };
      } finally {
        this._discP = null;
      }
    })();
    return this._discP;
  }

  async ensureParams(ctx, ids) {
    const missing = [...new Set(ids)].filter((id) => !this.imm.params[id]);
    if (missing.length) {
      const b = new Batch();
      for (const id of missing) {
        b.add(call(this.morpho, "idToMarketParams", enc.b32(id)), (r) => {
          const loanToken = dec.addr(r, 0);
          if (!loanToken || isZero(loanToken)) return; // unknown market id
          this.imm.params[id] = { loanToken, collateralToken: dec.addr(r, 1), oracle: dec.addr(r, 2), irm: dec.addr(r, 3), lltv: dec.uint(r, 4) };
        });
      }
      await b.run(ctx, this.id);
    }
    // collateral token metadata (from discovery when available, on-chain otherwise)
    const discMeta = new Map((this.disc?.markets || []).filter((m) => m.collateral).map((m) => [lc(m.collateral.address), m.collateral]));
    const needTok = [...new Set(ids.map((id) => this.imm.params[id]?.collateralToken).filter((a) => a && !isZero(a)).map(lc))]
      .filter((a) => !this.imm.tokens[a]);
    const b2 = new Batch();
    for (const a of needTok) {
      const dm = discMeta.get(a);
      if (dm) { this.imm.tokens[a] = { symbol: dm.symbol, decimals: dm.decimals, logoURI: dm.logoURI }; continue; }
      const t = { symbol: null, decimals: null, logoURI: null };
      this.imm.tokens[a] = t;
      b2.add(call(a, "symbol"), (r) => { t.symbol = dec.string(r) || "?"; });
      b2.add(call(a, "decimals"), (r) => { const d = dec.uint(r); t.decimals = d == null ? null : Number(d); });
    }
    await b2.run(ctx, this.id);
    // refresh logos from discovery
    for (const [a, dm] of discMeta) if (this.imm.tokens[a] && !this.imm.tokens[a].logoURI) this.imm.tokens[a].logoURI = dm.logoURI;
    storage.set("morpho:imm", this.imm);
  }

  structFresh(key) {
    const s = this.structs[key];
    const ttl = (this.app.config.frequency.cacheTtl["morpho.structure"] || 900) * 1000;
    return s && !s.dirty && Date.now() - s.at < ttl;
  }

  /** Load version, queue / adapters and adapter markets for vaults whose structure is missing or stale. */
  async ensureStructure(ctx, keys, depth = 0) {
    const need = [...new Set(keys)].filter((k) => !this.structFresh(k));
    if (!need.length) return;
    // 1. version, asset, name, lengths
    const b1 = new Batch();
    const tmp = {};
    for (const k of need) {
      const t = (tmp[k] = {});
      b1.add(call(k, "asset"), (r) => { t.asset = dec.addr(r); });
      b1.add(call(k, "name"), (r) => { t.name = dec.string(r); });
      b1.add(call(k, "adaptersLength"), (r) => { t.adaptersLength = dec.uint(r); });
      b1.add(call(k, "withdrawQueueLength"), (r) => { t.queueLength = dec.uint(r); });
    }
    await b1.run(ctx, this.id);
    // 2. queue items / adapters
    const b2 = new Batch();
    for (const k of need) {
      const t = tmp[k];
      t.version = t.adaptersLength != null ? 2 : t.queueLength != null ? 1 : null;
      if (t.version === 1) { t.queue = []; for (let i = 0; i < Number(t.queueLength); i++) b2.add(call(k, "withdrawQueue", enc.uint(i)), (r) => { t.queue[i] = lc(dec.b32(r)); }); }
      if (t.version === 2) { t.adapters = []; for (let i = 0; i < Number(t.adaptersLength); i++) b2.add(call(k, "adapters", enc.uint(i)), (r) => { t.adapters[i] = { address: lc(dec.addr(r)) }; }); }
    }
    await b2.run(ctx, this.id);
    // 3. adapter type
    const b3 = new Batch();
    for (const k of need) for (const ad of tmp[k].adapters || []) {
      b3.add(call(ad.address, "marketIdsLength"), (r) => { ad.marketIdsLength = dec.uint(r); });
      b3.add(call(ad.address, "marketParamsListLength"), (r) => { ad.marketParamsListLength = dec.uint(r); });
      b3.add(call(ad.address, "morphoVaultV1"), (r) => { ad.vault = dec.addr(r); });
    }
    await b3.run(ctx, this.id);
    // 4. adapter markets
    const b4 = new Batch();
    let needParamsMatch = false;
    for (const k of need) for (const ad of tmp[k].adapters || []) {
      if (ad.marketIdsLength != null) {
        ad.type = "MorphoMarketV1AdapterV2"; ad.marketIds = [];
        for (let i = 0; i < Number(ad.marketIdsLength); i++) b4.add(call(ad.address, "marketIds", enc.uint(i)), (r) => { ad.marketIds[i] = lc(dec.b32(r)); });
      } else if (ad.marketParamsListLength != null) {
        ad.type = "MorphoMarketV1Adapter"; ad.paramsList = []; needParamsMatch = true;
        for (let i = 0; i < Number(ad.marketParamsListLength); i++) b4.add(call(ad.address, "marketParamsList", enc.uint(i)), (r) => {
          ad.paramsList[i] = { loanToken: dec.addr(r, 0), collateralToken: dec.addr(r, 1), oracle: dec.addr(r, 2), irm: dec.addr(r, 3), lltv: dec.uint(r, 4) };
        });
      } else if (ad.vault && !isZero(ad.vault)) {
        ad.type = "MorphoVaultV1Adapter"; ad.vault = lc(ad.vault);
      } else {
        ad.type = "unknown";
      }
    }
    await b4.run(ctx, this.id);
    // Older adapters list market params: map them to ids through the params of known markets.
    if (needParamsMatch) {
      await this.ensureParams(ctx, [...this.allMarkets().keys()]);
      const key = (p) => [p.loanToken, p.collateralToken, p.oracle, p.irm].map(lc).join("|") + "|" + String(p.lltv);
      const byParams = new Map(Object.entries(this.imm.params).map(([id, p]) => [key(p), id]));
      for (const k of need) for (const ad of tmp[k].adapters || []) {
        if (ad.type !== "MorphoMarketV1Adapter") continue;
        ad.marketIds = ad.paramsList.map((p) => byParams.get(key(p))).filter(Boolean);
        if (ad.marketIds.length !== ad.paramsList.length) this.warn(`adapter:${ad.address}`, `Adapter ${ad.address}: ${ad.paramsList.length - ad.marketIds.length} market(s) not matched to a known market id.`);
        delete ad.paramsList;
      }
    }
    const underlying = [];
    for (const k of need) {
      const t = tmp[k];
      if (!t.version) { this.warn(`version:${k}`, `${k}: not recognised as a Morpho vault (V1 or V2).`); continue; }
      if (t.asset && lc(t.asset) !== this.asset) this.warn(`asset:${k}`, `${k}: asset is ${t.asset}, not ${this.assetSymbol}.`);
      this.structs[k] = { at: Date.now(), version: t.version, name: t.name, queue: t.queue, adapters: t.adapters };
      for (const ad of t.adapters || []) if (ad.type === "MorphoVaultV1Adapter") underlying.push(ad.vault);
      for (const ad of t.adapters || []) if (ad.type === "unknown") this.warn(`adapter:${ad.address}`, `Vault ${t.name || k}: adapter ${ad.address} has an unknown type; its yield is not counted.`);
    }
    storage.set("morpho:struct", this.structs);
    if (underlying.length && depth < 2) await this.ensureStructure(ctx, underlying, depth + 1);
  }

  /** Market ids used by a vault (V1 queue, V2 adapters, recursively through V1 vault adapters). */
  vaultMarketIds(key, seen = new Set()) {
    if (seen.has(key)) return [];
    seen.add(key);
    const s = this.structs[key];
    if (!s) return [];
    if (s.version === 1) return s.queue || [];
    return (s.adapters || []).flatMap((ad) => ad.type === "MorphoVaultV1Adapter" ? this.vaultMarketIds(ad.vault, seen) : ad.marketIds || []);
  }

  /** V1 vaults needed to value V2 vault adapters. */
  auxVaults(keys) {
    const out = new Set();
    for (const k of keys) for (const ad of this.structs[k]?.adapters || []) if (ad.type === "MorphoVaultV1Adapter") out.add(ad.vault);
    return [...out];
  }

  /* ───────────── tick ───────────── */

  async run(chain, ctx, dueIds) {
    const due = new Set(dueIds);
    await this.ensureDiscovery();
    const vaults = this.allVaults();
    const markets = this.allMarkets();

    const targetVaults = [...vaults.values()].filter((v) => (v.whitelist ? due.has("morpho.vaults") : due.has("morpho.vaults.others")));
    const targetMarkets = [...markets.values()].filter((m) => !m.idle && (m.whitelist ? due.has("morpho.markets") : due.has("morpho.markets.others")));

    await this.ensureStructure(ctx, targetVaults.map((v) => v.key));
    const vaultKeys = targetVaults.map((v) => v.key).filter((k) => this.structs[k]);
    const aux = this.auxVaults(vaultKeys).filter((k) => this.structs[k]);
    const allVaultKeys = [...new Set([...vaultKeys, ...aux])];
    const neededMarkets = [...new Set([...targetMarkets.map((m) => m.id), ...allVaultKeys.flatMap((k) => this.vaultMarketIds(k))])];
    await this.ensureParams(ctx, neededMarkets);
    const marketIds = neededMarkets.filter((id) => this.imm.params[id]);

    /* Phase A */
    const A = new Batch();
    const mstate = {};
    for (const id of marketIds) {
      A.add(call(this.morpho, "market", enc.b32(id)), (r) => {
        if (!r.success) return;
        mstate[id] = { totalSupplyAssets: dec.uint(r, 0), totalSupplyShares: dec.uint(r, 1), totalBorrowAssets: dec.uint(r, 2), totalBorrowShares: dec.uint(r, 3), lastUpdate: dec.uint(r, 4), fee: dec.uint(r, 5) };
      });
    }
    const vstate = {};
    for (const k of allVaultKeys) {
      const s = this.structs[k];
      const v = (vstate[k] = { positions: {}, adapters: {} });
      A.add(call(k, "totalAssets"), (r) => { v.totalAssets = dec.uint(r); });
      A.add(call(k, "totalSupply"), (r) => { v.totalSupply = dec.uint(r); });
      A.add(call(this.asset, "balanceOf", enc.addr(k)), (r) => { v.balance = dec.uint(r) ?? 0n; });
      if (s.version === 1) {
        A.add(call(k, "fee"), (r) => { v.fee = dec.uint(r) ?? 0n; });
        A.add(call(k, "withdrawQueueLength"), (r) => { v.queueLength = dec.uint(r); });
        for (const id of s.queue || []) A.add(call(this.morpho, "position", enc.b32(id), enc.addr(k)), (r) => { v.positions[id] = dec.uint(r, 0) ?? 0n; });
      } else {
        A.add(call(k, "maxRate"), (r) => { v.maxRate = dec.uint(r) ?? 0n; });
        A.add(call(k, "performanceFee"), (r) => { v.performanceFee = dec.uint(r) ?? 0n; });
        A.add(call(k, "managementFee"), (r) => { v.managementFee = dec.uint(r) ?? 0n; });
        A.add(call(k, "adaptersLength"), (r) => { v.adaptersLength = dec.uint(r); });
        for (const ad of s.adapters || []) {
          const a = (v.adapters[ad.address] = { positions: {} });
          A.add(call(ad.address, "realAssets"), (r) => { a.realAssets = dec.uint(r) ?? 0n; });
          if (ad.type === "MorphoMarketV1AdapterV2") A.add(call(ad.address, "marketIdsLength"), (r) => { a.length = dec.uint(r); });
          if (ad.type === "MorphoMarketV1Adapter") A.add(call(ad.address, "marketParamsListLength"), (r) => { a.length = dec.uint(r); });
          for (const id of ad.marketIds || []) A.add(call(this.morpho, "position", enc.b32(id), enc.addr(ad.address)), (r) => { a.positions[id] = dec.uint(r, 0) ?? 0n; });
        }
      }
    }
    await A.run(ctx, this.id);

    /* Phase B: borrow rates */
    const B = new Batch();
    const rates = {};
    for (const id of marketIds) {
      const p = this.imm.params[id];
      const m = mstate[id];
      if (!m || isZero(p.irm)) { rates[id] = 0n; continue; }
      const words = [enc.addr(p.loanToken), enc.addr(p.collateralToken), enc.addr(p.oracle), enc.addr(p.irm), enc.uint(p.lltv),
        enc.uint(m.totalSupplyAssets), enc.uint(m.totalSupplyShares), enc.uint(m.totalBorrowAssets), enc.uint(m.totalBorrowShares), enc.uint(m.lastUpdate), enc.uint(m.fee)];
      B.add(call(p.irm, "borrowRateView", ...words), (r) => { rates[id] = dec.uint(r) ?? 0n; });
    }
    await B.run(ctx, this.id);

    const now = BigInt(ctx.blockTime ?? Math.floor(Date.now() / 1000));

    /* Markets */
    const mk = {}; // id → { supply, borrow, rates, shares }
    for (const id of marketIds) {
      const p = this.imm.params[id];
      const s = mstate[id];
      if (!s) continue;
      const acc = accrue(s, rates[id], now, !isZero(p.irm));
      const r = marketRates(acc.supply, acc.borrow, rates[id], s.fee);
      mk[id] = { ...acc, ...r, totalSupplyShares: s.totalSupplyShares, idle: isZero(p.collateralToken) };
    }
    for (const id of marketIds) {
      const m = markets.get(id);
      if (!m || m.idle || !mk[id]) continue;
      if (!(m.whitelist ? due.has("morpho.markets") : due.has("morpho.markets.others"))) continue;
      this.outMarkets.set(id, this.marketOut(id, m, mk[id], ctx.block));
      this.rawMarkets.set(id, { supply: mk[id].supply, borrow: mk[id].borrow });
    }

    /* Vaults */
    const v1Rates = {};
    for (const k of allVaultKeys) if (this.structs[k].version === 1) v1Rates[k] = this.computeV1(k, vstate[k], mk);
    for (const v of targetVaults) {
      const s = this.structs[v.key];
      if (!s) continue;
      const out = s.version === 1 ? this.v1Out(v, s, v1Rates[v.key]) : this.computeV2(v, s, vstate[v.key], mk, v1Rates, ctx);
      out.block = ctx.block;
      this.outVaults.set(v.key, out);
    }

    // Structure change detection → reload next tick
    for (const k of allVaultKeys) {
      const s = this.structs[k];
      const st = vstate[k];
      let dirty = false;
      if (s.version === 1 && st.queueLength != null && Number(st.queueLength) !== (s.queue || []).length) dirty = true;
      if (s.version === 2 && st.adaptersLength != null && Number(st.adaptersLength) !== (s.adapters || []).length) dirty = true;
      for (const ad of s.adapters || []) {
        const a = st.adapters[ad.address];
        if (a?.length != null && Number(a.length) !== (ad.marketIds || []).length) dirty = true;
      }
      if (dirty) s.dirty = true;
    }

    this.sourceOk(chain, ctx.info());
    this.publish(this.build(vaults, markets));
  }

  /* ───────────── computations ───────────── */

  marketOut(id, m, x, block) {
    const p = this.imm.params[id];
    const tok = this.imm.tokens[lc(p.collateralToken)] || {};
    const d = this.assetDecimals;
    return {
      id,
      pair: `${tok.symbol || "?"}/${this.assetSymbol}`,
      collateral: { address: p.collateralToken, symbol: tok.symbol || null, logoURI: tok.logoURI || m.meta?.collateral?.logoURI || null },
      lltv: wadToFloat(p.lltv),
      oracle: p.oracle,
      irm: p.irm,
      totalSupplied: formatUnits(x.supply, d),
      totalBorrowed: formatUnits(x.borrow, d),
      availableLiquidity: formatUnits(x.supply - x.borrow, d),
      utilization: x.utilization,
      utilizationBand: utilizationBand(x.utilization),
      borrowApy: x.borrowApy,
      supplyApy: x.supplyApy,
      whitelist: m.whitelist,
      listed: m.meta?.listed ?? null,
      block,
    };
  }

  /** Allocation of a holder (vault or adapter) across markets. */
  allocation(positions, mk) {
    const d = this.assetDecimals;
    let assets = 0n, idle = 0n, organic = 0;
    const rows = [];
    for (const [id, shares] of Object.entries(positions)) {
      const m = mk[id];
      if (!m) continue;
      const a = toAssetsDown(shares, m.supply, m.totalSupplyShares);
      assets += a;
      if (m.idle) idle += a;
      const af = toNumber(a, d);
      organic += af * (m.idle ? 0 : m.supplyRate);
      if (a > 0n) {
        const p = this.imm.params[id];
        const tok = this.imm.tokens[lc(p.collateralToken)] || {};
        rows.push({ marketId: id, pair: m.idle ? `Idle market` : `${tok.symbol || "?"}/${this.assetSymbol}`, lltv: wadToFloat(p.lltv), assets: formatUnits(a, d), supplyApy: m.idle ? 0 : m.supplyApy, idle: m.idle });
      }
    }
    rows.sort((x, y) => Number(y.assets) - Number(x.assets));
    return { assets, idle, organic, rows };
  }

  computeV1(k, st, mk) {
    const d = this.assetDecimals;
    const al = this.allocation(st.positions, mk);
    const ta = toNumber(al.assets, d);
    const fee = wadToFloat(st.fee) || 0;
    const gross = ta > 0 ? al.organic / ta : 0;
    const net = gross * (1 - fee);
    return { st, al, gross, net, fee };
  }

  v1Out(v, s, r) {
    const d = this.assetDecimals;
    const real = r.al.assets + (r.st.balance || 0n);
    const idle = r.al.idle + (r.st.balance || 0n);
    const apy = rateToApy(r.net);
    return {
      address: v.address, key: v.key, label: v.label || v.apiName || s.name || v.address, version: 1,
      whitelist: v.whitelist, listed: v.listed, incentivesEnabled: false,
      totalDeposits: r.st.totalAssets != null ? formatUnits(r.st.totalAssets, d) : null,
      realAssets: formatUnits(real, d),
      idle: formatUnits(idle, d),
      idlePct: real > 0n ? toNumber(idle, d) / toNumber(real, d) : 0,
      apy, nativeApy: apy, incentiveApy: null,
      fees: { performance: r.fee, management: 0 },
      allocation: r.al.rows,
    };
  }

  computeV2(v, s, st, mk, v1Rates, ctx) {
    const d = this.assetDecimals;
    let organic = 0;
    let idle = st.balance || 0n;
    let real = st.balance || 0n;
    const rows = [];
    for (const ad of s.adapters || []) {
      const a = st.adapters[ad.address];
      if (!a) continue;
      real += a.realAssets || 0n;
      if (ad.type === "MorphoVaultV1Adapter") {
        const u = v1Rates[ad.vault];
        const af = toNumber(a.realAssets || 0n, d);
        organic += af * (u ? u.net : 0);
        const name = this.structs[ad.vault]?.name || ad.vault;
        rows.push({ marketId: null, vault: ad.vault, pair: `Vault: ${name}`, assets: formatUnits(a.realAssets || 0n, d), supplyApy: u ? rateToApy(u.net) : null, idle: false });
      } else if (ad.marketIds) {
        const al = this.allocation(a.positions, mk);
        organic += al.organic;
        idle += al.idle;
        rows.push(...al.rows);
      }
    }
    rows.sort((x, y) => Number(y.assets) - Number(x.assets));
    const RA = toNumber(real, d);
    const TA = toNumber(st.totalAssets ?? 0n, d);
    const r = vaultV2Rates({
      realAssets: RA, totalAssets: TA, organicPerSec: organic,
      maxRate: wadToFloat(st.maxRate) || 0, performanceFee: wadToFloat(st.performanceFee) || 0, managementFee: wadToFloat(st.managementFee) || 0,
    });
    const out = {
      address: v.address, key: v.key, label: v.label || v.apiName || s.name || v.address, version: 2,
      whitelist: v.whitelist, listed: v.listed, incentivesEnabled: v.incentives,
      totalDeposits: st.totalAssets != null ? formatUnits(st.totalAssets, d) : null,
      realAssets: formatUnits(real, d),
      idle: formatUnits(idle, d),
      idlePct: real > 0n ? toNumber(idle, d) / RA : 0,
      apy: r.apy, nativeApy: r.nativeApy, incentiveApy: r.incentiveApy, capApy: r.capApy,
      fees: { performance: wadToFloat(st.performanceFee) || 0, management: (wadToFloat(st.managementFee) || 0) * YEAR },
      allocation: rows,
    };
    if (v.incentives) {
      const t = Number(ctx.blockTime ?? Math.floor(Date.now() / 1000));
      const arr = (this.samples[v.key] ||= []);
      if (!arr.length || arr[arr.length - 1].t !== t) arr.push({ t, buffer: r.buffer });
      while (arr.length > 2 && arr[0].t < t - SAMPLE_KEEP_SEC) arr.shift();
      if (arr.length > 800) arr.splice(0, arr.length - 800);
      storage.set("morpho:buffers", this.samples);
      const obs = observedBurn(arr);
      const projDay = r.burnPerSec * 86400;
      const obsDay = obs.burnPerSec == null ? null : obs.burnPerSec * 86400;
      if (obsDay != null && projDay > 0 && Math.abs(obsDay - projDay) / projDay > 0.2) {
        this.warn(`burn:${v.key}`, `${out.label}: observed incentive burn (${obsDay.toFixed(0)}/day over ${Math.round(obs.windowSec / 60)} min) differs from the projection (${projDay.toFixed(0)}/day) by more than 20%.`);
      } else this.clearWarn(`burn:${v.key}`);
      out.incentives = {
        buffer: r.buffer,
        burnPerDay: projDay,
        runwaySec: Number.isFinite(r.runwaySec) ? r.runwaySec : null,
        runwayInfinite: !Number.isFinite(r.runwaySec),
        depletionAt: Number.isFinite(r.runwaySec) && r.runwaySec > 0 ? (t + r.runwaySec) * 1000 : null,
        observedBurnPerDay: obsDay,
        observedWindowSec: obs.windowSec,
        donations: obs.donations.slice(-5),
      };
    }
    return out;
  }

  build(vaults, markets) {
    const vs = [...this.outVaults.values()].filter((v) => vaults.has(v.key));
    vs.forEach((v) => { v.whitelist = vaults.get(v.key).whitelist; });
    vs.sort((a, b) => Number(b.whitelist) - Number(a.whitelist) || Number(b.totalDeposits || 0) - Number(a.totalDeposits || 0));
    const ms = [...this.outMarkets.values()].filter((m) => markets.has(m.id));
    ms.forEach((m) => { m.whitelist = markets.get(m.id).whitelist; });
    ms.sort((a, b) => Number(b.whitelist) - Number(a.whitelist) || Number(b.totalSupplied) - Number(a.totalSupplied));
    let sup = 0n, bor = 0n, n = 0;
    for (const m of ms) if (m.whitelist) { const r = this.rawMarkets.get(m.id); if (r) { sup += r.supply; bor += r.borrow; n++; } }
    const d = this.assetDecimals;
    const othersVaults = [...vaults.values()].filter((v) => !v.whitelist).length;
    const othersMarkets = [...markets.values()].filter((m) => !m.whitelist && !m.idle).length;
    return {
      asset: this.assetSymbol,
      overview: { totalSupplied: formatUnits(sup, d), totalBorrowed: formatUnits(bor, d), utilization: sup > 0n ? Number((bor * 10n ** 12n) / sup) / 1e12 : 0, markets: n },
      vaults: vs,
      markets: ms,
      counts: { othersVaults, othersMarkets },
      discoveryAt: this.disc?.at || null,
    };
  }
}
