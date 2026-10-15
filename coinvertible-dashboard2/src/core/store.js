// @ts-check
/**
 * Results of every module, keyed by store id. Results are cached in localStorage so a reload
 * shows the last known values (flagged `cached`) until the first tick refreshes them.
 */
import { Emitter } from "./util.js";
import { storage } from "./storage.js";

const CACHE_EVERY_MS = 10000;

export class Store extends Emitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.results = new Map();
    this._cachedAt = new Map();
  }

  get(id) {
    return this.results.get(id) || null;
  }

  /**
   * @param {string} id
   * @param {any} envelope
   * @param {{remote?: boolean}} [o] remote = received from the leader tab
   */
  set(id, envelope, o = {}) {
    this.results.set(id, envelope);
    if (!o.remote) {
      const last = this._cachedAt.get(id) || 0;
      if (Date.now() - last > CACHE_EVERY_MS) {
        storage.set(`result:${id}`, envelope);
        this._cachedAt.set(id, Date.now());
      }
      this.emit("local", { id, envelope });
    }
    this.emit("change", id);
  }

  /** Load cached results (shown as cached until refreshed). */
  loadCached() {
    for (const k of storage.keys("result:")) {
      const env = storage.get(k);
      if (env && env.module) this.results.set(k.slice("result:".length), { ...env, cached: true });
    }
    this.emit("change", "*");
  }
}
