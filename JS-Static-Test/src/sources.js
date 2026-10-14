import {
  RpcClient, SEL, callOf, encAddr, encUint, multicall,
  decUint, decAddr, decString, toNum,
  readSolanaSupply, readStellarSupply, readXrplSupply,
} from "./chain.js";

const WAD = 10n ** 18n;
const YEAR = 365 * 24 * 3600;

/* ════════════════════════════ Calcul vault (pur, testable) ════════════════════════════ */

/**
 * Morpho Vault V2 — reproduit VaultV2.accrueInterestView() :
 *   realAssets     = asset.balanceOf(vault) + Σ adapter.realAssets()
 *   maxTotalAssets = _totalAssets + _totalAssets × elapsed × maxRate / 1e18
 *   totalAssets()  = min(realAssets, maxTotalAssets)
 * Tout ce qui dépasse totalAssets() dans realAssets est de la valeur détenue par le vault mais
 * pas encore distribuée aux déposants : principalement les donations d'EURCV (incentives),
 * plus l'éventuel intérêt organique "en avance" sur le plafond maxRate.
 */
export function computeVaultV2(r) {
  const adaptersSum = r.adapters.reduce((s, a) => s + (a.realAssets ?? 0n), 0n);
  const realAssets = r.idle + adaptersSum;
  const buffer = realAssets - r.totalAssets; // > 0 : incentives en attente ; < 0 : perte non réalisée
  const capPerSecRaw = (r.totalAssets * r.maxRate) / WAD;
  const apr = Number(r.maxRate) / 1e18 * YEAR;
  return {
    version: 2,
    realAssets,
    totalAssets: r.totalAssets,
    storedTotalAssets: r.storedTotalAssets,
    pendingAccrual: r.totalAssets - r.storedTotalAssets,
    idle: r.idle,
    allocated: adaptersSum,
    adapters: r.adapters,
    buffer: buffer > 0n ? buffer : 0n,
    unrealizedLoss: buffer < 0n ? -buffer : 0n,
    maxRate: r.maxRate,
    capPerSecRaw,
    capApr: apr,
    capApy: Math.expm1(apr),
    lastUpdate: r.lastUpdate,
    sharePriceRaw: r.sharePriceRaw,
    totalSupply: r.totalSupply,
    performanceFee: r.performanceFee != null ? Number(r.performanceFee) / 1e18 : null,
    managementFee: r.managementFee != null ? Number(r.managementFee) / 1e18 * YEAR : null,
  };
}

/**
 * MetaMorpho V1/V1.1 — totalAssets() = Σ positions dans les marchés de la withdrawQueue.
 * L'EURCV envoyé directement au contrat n'est PAS comptabilisé (il reste "skimmable") :
 * c'est la donation non distribuée.
 */
export function computeVaultV1(r) {
  return {
    version: 1,
    realAssets: r.totalAssets + r.idle,
    totalAssets: r.totalAssets,
    storedTotalAssets: r.lastTotalAssets,
    pendingAccrual: r.lastTotalAssets != null ? r.totalAssets - r.lastTotalAssets : null,
    idle: r.idle,
    allocated: r.totalAssets,
    adapters: [],
    buffer: r.idle,
    unrealizedLoss: 0n,
    maxRate: null,
    capPerSecRaw: null,
    capApr: null,
    capApy: null,
    lastUpdate: null,
    sharePriceRaw: r.sharePriceRaw,
    totalSupply: r.totalSupply,
    performanceFee: r.fee != null ? Number(r.fee) / 1e18 : null,
    managementFee: null,
  };
}

/* ════════════════════════════ Suivi du buffer dans le temps ════════════════════════════ */

export class BufferTracker {
  constructor(windowSec = 900) {
    this.windowSec = windowSec;
    this.samples = []; // { ts, buffer(Number), block }
    this.events = []; // donations détectées
    this.prev = null;
  }
  push({ ts, block, buffer, totalAssets }) {
    if (this.prev && block <= this.prev.block) return this.stats(ts); // même bloc : rien de neuf
    if (this.prev) {
      const delta = buffer - this.prev.buffer;
      const threshold = Math.max(1, totalAssets * 1e-6);
      if (delta > threshold) {
        this.events.unshift({ ts, block, amount: delta, kind: "donation", seenAt: Date.now() });
        this.events = this.events.slice(0, 20);
        this.samples = []; // on repart d'une fenêtre propre après une donation
      } else if (delta < -Math.max(threshold * 50, 1000)) {
        this.events.unshift({ ts, block, amount: delta, kind: "retrait", seenAt: Date.now() });
        this.events = this.events.slice(0, 20);
        this.samples = [];
      }
    }
    this.prev = { ts, block, buffer };
    this.samples.push({ ts, block, buffer });
    const cutoff = ts - this.windowSec;
    while (this.samples.length > 2 && this.samples[1].ts <= cutoff) this.samples.shift();
    return this.stats(ts);
  }
  stats() {
    const n = this.samples.length;
    if (n < 2) return { burnPerSec: null, windowSec: 0, samples: n };
    const a = this.samples[0];
    const b = this.samples[n - 1];
    const dt = b.ts - a.ts;
    if (dt < 60) return { burnPerSec: null, windowSec: dt, samples: n };
    return { burnPerSec: (a.buffer - b.buffer) / dt, windowSec: dt, samples: n };
  }
}

/* ════════════════════════════ Pollers ════════════════════════════ */

class Loop {
  constructor(fn, cfg) {
    this.fn = fn;
    this.cfg = cfg;
    this.alive = false;
    this.timer = null;
  }
  start() {
    this.alive = true;
    const run = async () => {
      if (!this.alive) return;
      if (this.cfg.pauseWhenHidden && document.hidden) {
        this.timer = setTimeout(run, 400);
        return;
      }
      const t0 = Date.now();
      try {
        await this.fn();
      } catch (_) { /* géré dans fn */ }
      if (!this.alive) return;
      this.timer = setTimeout(run, Math.max(0, this.cfg.pollIntervalMs - (Date.now() - t0)));
    };
    run();
  }
  stop() {
    this.alive = false;
    clearTimeout(this.timer);
  }
}

/** Poller EVM : supply des tokens + vault Morpho, tout en un seul Multicall3. */
class EvmPoller {
  constructor(key, net, cfg, emit) {
    this.key = key;
    this.net = net;
    this.cfg = cfg;
    this.emit = emit;
    this.client = new RpcClient(net.rpcUrls, cfg.requestTimeoutMs);
    this.tokens = Object.entries(cfg.tokens)
      .filter(([, t]) => t.deployments?.[key]?.address)
      .map(([sym, t]) => ({ sym, address: t.deployments[key].address, decimals: null }));
    this.vaultCfg = cfg.vault?.network === key && cfg.vault.address ? cfg.vault : null;
    this.vaultMeta = null;
    this.tracker = new BufferTracker(cfg.vault?.burnWindowSec || 900);
    this.ready = false;
  }

  mc(calls) {
    return multicall(this.client, this.net.multicall3, calls);
  }

  async init() {
    const calls = this.tokens.map((t) => callOf(t.address, SEL.decimals));
    const v = this.vaultCfg?.address;
    if (v) {
      calls.push(
        callOf(v, SEL.asset), callOf(v, SEL.decimals), callOf(v, SEL.name), callOf(v, SEL.symbol),
        callOf(v, SEL.adaptersLength), callOf(v, SEL.withdrawQueueLength),
      );
    }
    const res = await this.mc(calls);
    this.tokens.forEach((t, i) => (t.decimals = Number(decUint(res[i]) ?? 18n)));
    if (v) {
      const o = this.tokens.length;
      const asset = decAddr(res[o]);
      if (!asset) throw new Error("Adresse du vault invalide (asset() a échoué)");
      const adaptersLength = decUint(res[o + 4]);
      const version = adaptersLength != null ? 2 : decUint(res[o + 5]) != null ? 1 : 2;
      const [assetDec, assetSym] = await this.mc([callOf(asset, SEL.decimals), callOf(asset, SEL.symbol)]);
      this.vaultMeta = {
        address: v,
        asset,
        assetDecimals: Number(decUint(assetDec) ?? 18n),
        assetSymbol: decString(assetSym) || "EURCV",
        decimals: Number(decUint(res[o + 1]) ?? 18n),
        name: decString(res[o + 2]) || this.vaultCfg.label,
        symbol: decString(res[o + 3]) || "",
        version,
        adapters: [],
      };
      if (version === 2) await this.loadAdapters(Number(adaptersLength));
    }
    this.ready = true;
  }

  async loadAdapters(n) {
    const v = this.vaultMeta.address;
    if (n === 0) { this.vaultMeta.adapters = []; return; }
    const res = await this.mc(Array.from({ length: n }, (_, i) => callOf(v, SEL.adapters, encUint(i))));
    this.vaultMeta.adapters = res.map(decAddr).filter(Boolean);
  }

  async poll() {
    if (!this.ready) await this.init();
    const calls = [
      callOf(this.net.multicall3, SEL.getBlockNumber),
      callOf(this.net.multicall3, SEL.getCurrentBlockTimestamp),
      ...this.tokens.map((t) => callOf(t.address, SEL.totalSupply)),
    ];
    const m = this.vaultMeta;
    let vIdx = calls.length;
    if (m) {
      const v = m.address;
      const one = encUint(10n ** BigInt(m.decimals));
      calls.push(
        callOf(m.asset, SEL.balanceOf, encAddr(v)), // 0 idle
        callOf(v, SEL.totalAssets),                  // 1
        callOf(v, SEL.totalSupply),                  // 2
        callOf(v, SEL.convertToAssets, one),         // 3
      );
      if (m.version === 2) {
        calls.push(
          callOf(v, SEL._totalAssets),               // 4
          callOf(v, SEL.maxRate),                    // 5
          callOf(v, SEL.lastUpdate),                 // 6
          callOf(v, SEL.adaptersLength),             // 7
          callOf(v, SEL.performanceFee),             // 8
          callOf(v, SEL.managementFee),              // 9
          ...m.adapters.map((a) => callOf(a, SEL.realAssets)),
        );
      } else {
        calls.push(callOf(v, SEL.lastTotalAssets), callOf(v, SEL.fee));
      }
    }

    const res = await this.mc(calls);
    const block = Number(decUint(res[0]));
    const timestamp = Number(decUint(res[1]));

    const tokens = {};
    this.tokens.forEach((t, i) => {
      const raw = decUint(res[2 + i]);
      tokens[t.sym] = { amount: toNum(raw, t.decimals), raw, decimals: t.decimals, address: t.address, ok: raw != null };
    });

    let vault = null;
    if (m) {
      const g = (k) => decUint(res[vIdx + k]);
      if (m.version === 2) {
        const len = Number(g(7) ?? 0n);
        if (len !== m.adapters.length) {
          // La liste d'adapters a changé : on recharge et on relit tout au même bloc.
          await this.loadAdapters(len);
          return this.poll();
        }
        const adapters = m.adapters.map((a, i) => ({ address: a, realAssets: g(10 + i) ?? 0n }));
        vault = computeVaultV2({
          idle: g(0) ?? 0n,
          totalAssets: g(1) ?? 0n,
          totalSupply: g(2),
          sharePriceRaw: g(3),
          storedTotalAssets: g(4) ?? 0n,
          maxRate: g(5) ?? 0n,
          lastUpdate: Number(g(6) ?? 0n),
          performanceFee: g(8),
          managementFee: g(9),
          adapters,
        });
      } else {
        vault = computeVaultV1({
          idle: g(0) ?? 0n,
          totalAssets: g(1) ?? 0n,
          totalSupply: g(2),
          sharePriceRaw: g(3),
          lastTotalAssets: g(4),
          fee: g(5),
        });
      }
      const d = m.assetDecimals;
      const bufferNum = toNum(vault.buffer, d);
      const taNum = toNum(vault.totalAssets, d);
      const burn = this.tracker.push({ ts: timestamp, block, buffer: bufferNum, totalAssets: taNum });
      vault = { ...vault, meta: m, burn, events: this.tracker.events.slice() };
    }

    return { block, timestamp, tokens, vault };
  }
}

/** Poller non-EVM générique */
class SimplePoller {
  constructor(key, net, cfg) {
    this.key = key;
    this.net = net;
    this.cfg = cfg;
    this.client = new RpcClient(net.rpcUrls, cfg.requestTimeoutMs);
    this.items = Object.entries(cfg.tokens)
      .filter(([, t]) => t.deployments?.[key])
      .map(([sym, t]) => ({ sym, dep: t.deployments[key] }));
  }
  async readOne(dep) {
    switch (this.net.type) {
      case "solana": return readSolanaSupply(this.client, dep.mint);
      case "stellar": return readStellarSupply(this.client, dep.code, dep.issuer);
      case "xrpl": return readXrplSupply(this.client, dep.currency, dep.issuer);
      default: throw new Error(`Type de réseau inconnu: ${this.net.type}`);
    }
  }
  async poll() {
    // Séquentiel volontairement : ménage les RPC publics limités en débit.
    const tokens = {};
    let ref = null;
    for (const it of this.items) {
      const r = await this.readOne(it.dep);
      tokens[it.sym] = { amount: r.amount, ok: true, id: it.dep.mint || it.dep.issuer };
      ref = r.slot ?? r.ledger ?? ref;
    }
    return { block: ref, timestamp: Math.floor(Date.now() / 1000), tokens };
  }
}

/* ════════════════════════════ Orchestrateur ════════════════════════════ */

export function startPolling(cfg, emit) {
  const loops = [];
  for (const [key, net] of Object.entries(cfg.networks)) {
    if (!net.enabled) continue;
    const hasToken = Object.values(cfg.tokens).some((t) => t.deployments?.[key]);
    const hasVault = cfg.vault?.network === key;
    if (!hasToken && !hasVault) continue;

    const poller = net.type === "evm" ? new EvmPoller(key, net, cfg) : new SimplePoller(key, net, cfg);
    const loop = new Loop(async () => {
      try {
        const data = await poller.poll();
        emit({ type: "data", key, data, latency: poller.client.lastLatency, rpc: poller.client.current, at: Date.now() });
      } catch (e) {
        emit({ type: "error", key, error: e?.message || String(e), rpc: poller.client.current, at: Date.now() });
      }
    }, cfg);
    loop.start();
    loops.push(loop);
  }
  return () => loops.forEach((l) => l.stop());
}
