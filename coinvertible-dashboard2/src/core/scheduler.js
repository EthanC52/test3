// @ts-check
/**
 * One loop per chain (or API). On each tick it finds the module schedules of the visible page that
 * are due on this chain, opens one tick context (EVM: one eth_blockNumber + block pin), and runs
 * them together so their reads are coalesced.
 */
import { jitter } from "./util.js";

export class Scheduler {
  /** @param {any} app */
  constructor(app) {
    this.app = app;
    this.page = null;
    this.running = false;
    /** @type {Map<string, {timer:any, busy:boolean}>} */
    this.loops = new Map();
    /** key `${scheduleId}@${chain}` → { at, block } */
    this.last = new Map();
  }

  /** Interval of a chain or "api:<name>" in seconds. */
  baseInterval(chain) {
    const f = this.app.config.frequency;
    if (chain.startsWith("api:")) return f.apis[chain.slice(4)] || 60;
    return f.chains[chain] || 60;
  }

  /** Interval of one schedule on one chain, rounded up to a multiple of the chain interval. */
  interval(scheduleId, chain) {
    const base = this.baseInterval(chain);
    const short = chain.startsWith("api:") ? chain.slice(4) : chain;
    const v = this.app.config.frequency.modules?.[scheduleId]?.[short];
    return v == null ? base : Math.ceil(v / base) * base;
  }

  setPage(page) {
    this.page = page;
    if (this.running) this._sync(true);
  }

  start() {
    this.running = true;
    this._sync(true);
  }

  stop() {
    this.running = false;
    for (const l of this.loops.values()) clearTimeout(l.timer);
    this.loops.clear();
  }

  /** Run a chain now (e.g. a "Show more" section was opened). */
  kick(chain) {
    if (!this.running) return;
    if (chain) this._run(chain, true);
    else this._sync(true);
  }

  _modulesOn(chain) {
    return this.app.modules.filter((m) => m.page === this.page && m.chains.includes(chain));
  }

  _activeChains() {
    const set = new Set();
    for (const m of this.app.modules) if (m.page === this.page) m.chains.forEach((c) => set.add(c));
    return [...set];
  }

  _sync(runNow) {
    const active = new Set(this._activeChains());
    for (const [chain, l] of this.loops) if (!active.has(chain)) { clearTimeout(l.timer); this.loops.delete(chain); }
    for (const chain of active) {
      if (!this.loops.has(chain)) this.loops.set(chain, { timer: null, busy: false });
      if (runNow) this._run(chain, true);
    }
  }

  _schedule(chain) {
    const l = this.loops.get(chain);
    if (!l || !this.running) return;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => this._run(chain, false), jitter(this.baseInterval(chain) * 1000, 0.1));
  }

  async _run(chain, force) {
    const l = this.loops.get(chain);
    if (!l || !this.running) return;
    if (l.busy) { this.app.stats.skippedTicks++; return; }
    l.busy = true;
    clearTimeout(l.timer);
    try {
      await this._tick(chain, force);
    } catch (e) {
      console.error(`[scheduler] ${chain}`, e);
    } finally {
      l.busy = false;
      this._schedule(chain);
    }
  }

  async _tick(chain) {
    const now = Date.now();
    const halfBase = this.baseInterval(chain) * 500;
    /** @type {{module:any, ids:string[]}[]} */
    let due = [];
    for (const m of this._modulesOn(chain)) {
      const ids = m.schedules
        .filter((s) => !s.chains || s.chains.includes(chain))
        .filter((s) => !s.gate || this.app.tabs.gateOpen(s.gate))
        .filter((s) => {
          const last = this.last.get(`${s.id}@${chain}`);
          return !last || now - last.at >= this.interval(s.id, chain) * 1000 - halfBase;
        })
        .map((s) => s.id);
      if (ids.length) due.push({ module: m, ids });
    }
    if (!due.length) return;

    const adapter = this.app.adapters[chain];
    let ctx = { chain };
    if (adapter?.beginTick) {
      try {
        ctx = await adapter.beginTick();
      } catch (e) {
        due.forEach((d) => d.module.fail(chain, e, d.ids));
        return;
      }
      if (this.app.config.frequency.behaviour.skipIfSameBlock) {
        due = due
          .map((d) => ({ ...d, ids: d.ids.filter((id) => this.last.get(`${id}@${chain}`)?.block !== ctx.head) }))
          .filter((d) => d.ids.length);
        if (!due.length) return;
      }
    }

    await Promise.all(due.map(async (d) => {
      try {
        await d.module.run(chain, ctx, d.ids);
      } catch (e) {
        console.warn(`[${d.module.id}] ${chain}:`, e);
        d.module.fail(chain, e, d.ids);
      } finally {
        for (const id of d.ids) this.last.set(`${id}@${chain}`, { at: Date.now(), block: ctx.head });
      }
    }));
  }
}
