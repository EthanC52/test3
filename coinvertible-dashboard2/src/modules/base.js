// @ts-check
/**
 * Base class for data modules.
 *
 * A module declares:
 *   id        unique id
 *   storeId   key of its result in the store
 *   page      route it belongs to (only modules of the visible page run)
 *   chains    chain keys (or "api:<name>") it reads
 *   schedules [{ id, chains?, gate? }] — one entry per independently scheduled part (see frequency.js)
 * and implements run(chain, ctx, dueScheduleIds).
 *
 * It publishes one envelope: { module, schema, updatedAt, status, sources, warnings, data }.
 */
export class Module {
  /**
   * @param {any} app
   * @param {{id:string, storeId?:string, page:string, chains:string[], schedules:{id:string, chains?:string[], gate?:string}[]}} def
   */
  constructor(app, def) {
    this.app = app;
    this.id = def.id;
    this.storeId = def.storeId || def.id;
    this.page = def.page;
    this.chains = def.chains;
    this.schedules = def.schedules;
    /** @type {Record<string, any>} */
    this.sources = {};
    /** @type {Map<string, string>} */
    this.warnings = new Map();
    this.data = null;
  }

  /** Record a successful read on a chain. info: { block?, slot?, ledger?, blockTime?, endpoint? } */
  sourceOk(chain, info = {}) {
    this.sources[chain] = { ...info, status: "ok", at: Date.now(), okAt: Date.now(), error: null };
  }

  sourceFail(chain, err) {
    const prev = this.sources[chain] || {};
    this.sources[chain] = { ...prev, status: prev.okAt ? "stale" : "error", at: Date.now(), error: String(err?.message || err).slice(0, 300) };
  }

  warn(key, msg) {
    this.warnings.set(key, msg);
  }

  clearWarn(key) {
    this.warnings.delete(key);
  }

  /** Called by the scheduler when run() throws or the tick could not start. */
  fail(chain, err, _ids) {
    this.sourceFail(chain, err);
    this.publish(this.data);
  }

  publish(data) {
    this.data = data;
    const st = Object.values(this.sources).map((s) => s.status);
    const status = !st.length ? "pending" : st.every((s) => s === "ok") ? "ok" : st.every((s) => s === "error") ? "error" : "partial";
    this.app.store.set(this.storeId, {
      module: this.storeId,
      schema: 1,
      updatedAt: Date.now(),
      status,
      sources: structuredClone(this.sources),
      warnings: [...this.warnings.values()],
      data,
    });
  }
}
