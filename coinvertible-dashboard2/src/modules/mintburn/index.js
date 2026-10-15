// @ts-check
/**
 * monitoring.mintburn — the 15 most recent mint/burn events across EURCV and USDCV on Ethereum.
 *
 * SmartCoin specifics (verified on mainnet, Oct 2026):
 * - mint = Transfer(0x0 → to), burn = Transfer(registrar → 0x0): `from` of a burn is always the registrar
 * - before a burn the holder's tokens reach the registrar:
 *     EURCV: RedemptionStarted(holder → redemption address, value), then Transfer(holder → registrar, value)
 *     USDCV: only Transfer(holder → registrar, value) — no RedemptionStarted seen in 300k blocks
 * - a burn is attributed to the holder of the latest unmatched RedemptionStarted with the same token
 *   and value before it; if none, to the sender of the latest unmatched Transfer to the registrar
 *   with the same value; otherwise to the registrar itself.
 *
 * Reading:
 * - steady state: one merged eth_getLogs per tick over (cursor, logHead], topic0 ∈ {Transfer, RedemptionStarted}
 * - empty cache or large gap: scan back from logHead in windows with targeted filters until enough
 *   events are found and their burns are matched (bounded by REDEMPTION_LOOKBACK).
 */
import { Module } from "../base.js";
import { TOPIC, ZERO_WORD, call, dec, logWord, topicAddr } from "../../chains/evm/abi.js";
import { formatUnits } from "../../core/decimal.js";
import { storage } from "../../core/storage.js";
import { shortHex } from "../../core/util.js";

const SHOW = 15;
const KEEP_EVENTS = 60;
const KEEP_REDEMPTIONS = 400;
const WINDOW = 10000; // blocks per backward window (split further by the adapter if needed)
const REDEMPTION_LOOKBACK = 50000; // ~7 days
const MAX_WINDOWS = 12;

export class MintBurnModule extends Module {
  constructor(app) {
    super(app, { id: "monitoring.mintburn", page: "monitoring", chains: ["ethereum"], schedules: [{ id: "monitoring.mintburn" }] });
    this.chain = "ethereum";
    this.tokens = Object.entries(app.config.tokens)
      .filter(([, t]) => t.deployments[this.chain]?.address)
      .map(([sym, t]) => ({ sym, address: t.deployments[this.chain].address.toLowerCase(), decimals: t.deployments[this.chain].decimals }));
    this.addresses = this.tokens.map((t) => t.address);
    this.state = storage.get(`mintburn:${this.chain}`, null) || { cursor: null, events: [], redemptions: [], deposits: [], scannedFrom: null };
    this.state.deposits ||= [];
    this.roles = storage.get(`roles:${this.chain}`, null);
    if (this.roles) this.applyRoles();
    this.state.redemptions.forEach((r) => app.labels.setRole(this.chain, r.redemptionAddress, "Redemption", r.token));
  }

  tokenOf(addr) {
    return this.tokens.find((t) => t.address === addr.toLowerCase());
  }

  save() {
    storage.set(`mintburn:${this.chain}`, this.state);
  }

  applyRoles() {
    for (const [sym, r] of Object.entries(this.roles.byToken || {})) {
      this.app.labels.setRole(this.chain, r.registrar, "Registrar", sym);
      this.app.labels.setRole(this.chain, r.operations, "Operations", sym);
      this.app.labels.setRole(this.chain, r.technical, "Technical", sym);
    }
  }

  async loadRoles(ctx) {
    const ttl = (this.app.config.frequency.cacheTtl["token.roles"] || 86400) * 1000;
    if (this.roles && Date.now() - this.roles.at < ttl) return;
    const calls = this.tokens.flatMap((t) => [call(t.address, "registrar"), call(t.address, "operations"), call(t.address, "technical")]);
    const res = await ctx.call(calls, this.id);
    const byToken = {};
    this.tokens.forEach((t, i) => {
      byToken[t.sym] = { registrar: dec.addr(res[i * 3]), operations: dec.addr(res[i * 3 + 1]), technical: dec.addr(res[i * 3 + 2]) };
    });
    this.roles = { at: Date.now(), byToken };
    storage.set(`roles:${this.chain}`, this.roles);
    this.applyRoles();
  }

  /** Registrar address per token (lowercase), once roles are known. */
  registrars() {
    const out = {};
    for (const [sym, r] of Object.entries(this.roles?.byToken || {})) if (r.registrar) out[sym] = r.registrar.toLowerCase();
    return out;
  }

  /** Parse logs into events / redemptions / deposits to the registrar (deduplicated by key). */
  ingest(logs) {
    const evKeys = new Set(this.state.events.map((e) => e.key));
    const rdKeys = new Set(this.state.redemptions.map((r) => r.key));
    const dpKeys = new Set(this.state.deposits.map((r) => r.key));
    const regs = this.registrars();
    let newMintBurn = 0;
    for (const l of logs) {
      const tok = this.tokenOf(l.address);
      if (!tok) continue;
      const key = `${tok.sym}:${Number(BigInt(l.blockNumber))}:${Number(BigInt(l.logIndex))}`;
      const base = {
        key,
        token: tok.sym,
        block: Number(BigInt(l.blockNumber)),
        logIndex: Number(BigInt(l.logIndex)),
        txHash: l.transactionHash,
        ts: l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : null,
        value: logWord(l.data, 0),
      };
      const t0 = l.topics[0]?.toLowerCase();
      if (t0 === TOPIC.Transfer) {
        const from = l.topics[1]?.toLowerCase();
        const to = l.topics[2]?.toLowerCase();
        const isMint = from === ZERO_WORD;
        const isBurn = to === ZERO_WORD;
        if (!isMint && !isBurn) {
          const reg = regs[tok.sym];
          if (reg && topicAddr(to) === reg && !dpKeys.has(key)) {
            dpKeys.add(key);
            this.state.deposits.push({ ...base, holder: topicAddr(from) });
          }
          continue;
        }
        if (evKeys.has(key)) continue;
        evKeys.add(key);
        this.state.events.push({ ...base, type: isMint ? "mint" : "burn", from: topicAddr(from), to: topicAddr(to) });
        newMintBurn++;
      } else if (t0 === TOPIC.RedemptionStarted) {
        if (rdKeys.has(key)) continue;
        rdKeys.add(key);
        const r = { ...base, holder: topicAddr(l.topics[1]), redemptionAddress: topicAddr(l.topics[2]) };
        this.state.redemptions.push(r);
        this.app.labels.setRole(this.chain, r.redemptionAddress, "Redemption", r.token);
      }
    }
    const ord = (a, b) => b.block - a.block || b.logIndex - a.logIndex;
    this.state.events.sort(ord);
    this.state.redemptions.sort(ord);
    this.state.deposits.sort(ord);
    this.state.events = this.state.events.slice(0, KEEP_EVENTS);
    this.state.redemptions = this.state.redemptions.slice(0, KEEP_REDEMPTIONS);
    this.state.deposits = this.state.deposits.slice(0, KEEP_REDEMPTIONS);
    return newMintBurn;
  }

  /**
   * Match burns to their holder (deterministic, recomputed each time).
   * @returns {Map<string, {holder:string, via:string|null, attribution:string}>}
   */
  match() {
    const before = (x, b) => x.block < b.block || (x.block === b.block && x.logIndex < b.logIndex);
    const usedR = new Set();
    const usedD = new Set();
    const burns = this.state.events.filter((e) => e.type === "burn").sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    const out = new Map();
    for (const b of burns) {
      // lists are sorted newest first, so find() returns the latest candidate
      const r = this.state.redemptions.find((x) => !usedR.has(x.key) && x.token === b.token && x.value === b.value && before(x, b));
      const d = this.state.deposits.find((x) => !usedD.has(x.key) && x.token === b.token && x.value === b.value && before(x, b) && (!r || x.holder === r.holder));
      if (d) usedD.add(d.key);
      if (r) { usedR.add(r.key); out.set(b.key, { holder: r.holder, via: r.redemptionAddress, attribution: "redemption" }); }
      else if (d) out.set(b.key, { holder: d.holder, via: null, attribution: "transfer-to-registrar" });
    }
    return out;
  }

  topUnmatched() {
    const m = this.match();
    return this.state.events.slice(0, SHOW).filter((e) => e.type === "burn" && !m.has(e.key)).length;
  }

  /**
   * Scan back from `to` down to `stopAt` (exclusive), with targeted filters.
   * Stops when SHOW events newer than stopAt are known and burns are matched, or limits are hit.
   */
  async scanBack(ctx, to, stopAt) {
    const addr = this.addresses;
    let end = to;
    let windows = 0;
    let found = 0;
    for (;;) {
      const lowest = stopAt != null ? stopAt + 1 : 0;
      const start = Math.max(lowest, end - WINDOW + 1);
      const needEvents = found < SHOW;
      const regTopics = [...new Set(Object.values(this.registrars()))].map((a) => "0x" + a.slice(2).padStart(64, "0"));
      const reqs = [ctx.logs({ address: addr, topics: [TOPIC.RedemptionStarted] }, start, end, this.id)];
      if (regTopics.length) reqs.push(ctx.logs({ address: addr, topics: [TOPIC.Transfer, null, regTopics] }, start, end, this.id));
      if (needEvents) {
        reqs.push(ctx.logs({ address: addr, topics: [TOPIC.Transfer, ZERO_WORD] }, start, end, this.id));
        reqs.push(ctx.logs({ address: addr, topics: [TOPIC.Transfer, null, ZERO_WORD] }, start, end, this.id));
      }
      const parts = await Promise.all(reqs);
      found += this.ingest(parts.flat());
      this.state.scannedFrom = Math.min(this.state.scannedFrom ?? start, start);
      windows++;
      if (start <= lowest) break;
      if (found >= SHOW && this.topUnmatched() === 0) break;
      if (found >= SHOW && to - start >= REDEMPTION_LOOKBACK) break;
      if (windows >= MAX_WINDOWS) {
        this.warn("scan", `Stopped scanning after ${windows} windows of ${WINDOW} blocks.`);
        break;
      }
      end = start - 1;
    }
  }

  async run(chain, ctx) {
    await this.loadRoles(ctx).catch((e) => this.warn("roles", `Could not read token roles: ${e.message}`));
    const head = ctx.logHead;
    const s = this.state;
    let added = 0;
    const before = s.events.length;
    if (s.cursor == null || head - s.cursor > WINDOW) {
      const stopAt = s.cursor;
      try {
        await this.scanBack(ctx, head, stopAt);
        this.clearWarn("depth");
      } catch (e) {
        if (e?.kind !== "depth" || !s.events.length) throw e;
        this.warn("depth", `History limited by the endpoints' log depth: ${e.message}`);
      }
      s.cursor = head;
      added = s.events.length - before;
    } else if (head > s.cursor) {
      const logs = await ctx.logs({ address: this.addresses, topics: [[TOPIC.Transfer, TOPIC.RedemptionStarted]] }, s.cursor + 1, head, this.id);
      added = this.ingest(logs);
      s.cursor = head;
    }
    if (added > 0) this.app.bus.emit("mintburn:new", { count: added });

    // Timestamps for displayed events when the endpoint did not include blockTimestamp.
    const show = s.events.slice(0, SHOW);
    for (const e of show) if (e.ts == null) e.ts = await this.app.adapters[this.chain].blockTime(e.block, this.id);
    this.save();
    this.sourceOk(chain, { ...ctx.info(), block: head, cursor: s.cursor, scannedFrom: s.scannedFrom });
    this.publish(this.build());
  }

  build() {
    const m = this.match();
    const explorer = this.app.config.chains[this.chain].explorer;
    const events = this.state.events.slice(0, SHOW).map((e) => {
      const tok = this.tokens.find((t) => t.sym === e.token);
      const hit = m.get(e.key);
      const counterparty = e.type === "mint" ? e.to : hit ? hit.holder : e.from;
      return {
        timestamp: e.ts,
        chain: this.chain,
        token: e.token,
        type: e.type,
        counterparty: { address: counterparty, label: this.app.labels.resolve(this.chain, counterparty).label },
        via: hit?.via || null,
        attribution: e.type === "mint" ? "recipient" : hit ? hit.attribution : "registrar",
        amount: formatUnits(e.value, tok?.decimals ?? 18),
        block: e.block,
        txHash: e.txHash,
        txHashShort: shortHex(e.txHash),
        explorerUrl: explorer.tx + e.txHash,
      };
    });
    return { events, cursor: this.state.cursor, scannedFrom: this.state.scannedFrom };
  }
}
