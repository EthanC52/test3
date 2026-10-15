// @ts-check
/**
 * Address labels. Priority: known_addresses.json > on-chain roles > Morpho names > none.
 */
import { normAddr, Emitter } from "./util.js";

const PRIORITY = { file: 3, role: 2, morpho: 1 };

export class Labels extends Emitter {
  /** @param {Record<string, Record<string, {label:string, type?:string}>>} known @param {Record<string, any>} chains */
  constructor(known, chains) {
    super();
    this.chains = chains;
    /** @type {Map<string, {label:string, source:string, type?:string, roles?:Map<string,Set<string>>}>} */
    this.map = new Map();
    for (const [chain, entries] of Object.entries(known || {})) {
      for (const [addr, v] of Object.entries(entries || {})) {
        if (!v || !v.label) continue;
        this.map.set(this._k(chain, addr), { label: v.label, type: v.type, source: "file" });
      }
    }
  }
  _k(chain, addr) {
    return `${chain}|${normAddr(this.chains[chain]?.type, addr)}`;
  }
  /** Generic automatic label (Morpho names…). */
  setAuto(chain, addr, label, source = "morpho") {
    if (!addr || !label) return;
    const k = this._k(chain, addr);
    const cur = this.map.get(k);
    if (cur && PRIORITY[cur.source] >= PRIORITY[source]) return;
    this.map.set(k, { label, source });
    this.emit("change");
  }
  /** Role label merged across tokens: "Registrar (EURCV, USDCV)". */
  setRole(chain, addr, role, token) {
    if (!addr || /^0x0{40}$/i.test(addr)) return;
    const k = this._k(chain, addr);
    const cur = this.map.get(k);
    if (cur && cur.source === "file") return;
    const roles = cur?.source === "role" && cur.roles ? cur.roles : new Map();
    if (!roles.has(role)) roles.set(role, new Set());
    const before = roles.get(role).size;
    roles.get(role).add(token);
    const label = [...roles].map(([r, toks]) => `${r} (${[...toks].join(", ")})`).join(" · ");
    this.map.set(k, { label, source: "role", roles });
    if (!cur || roles.get(role).size !== before) this.emit("change");
  }
  /** @returns {{address:string, label:string|null, source:string|null}} */
  resolve(chain, addr) {
    const v = this.map.get(this._k(chain, addr));
    return { address: addr, label: v?.label || null, source: v?.source || null };
  }
}
