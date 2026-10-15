// @ts-check
/**
 * Cross-tab coordination.
 *
 * Leadership: one tab per page holds the Web Lock "cv:page:<page>" and polls. Other tabs on the
 * same page are followers: they receive results over a BroadcastChannel and make no request.
 * A hidden tab releases its lock (pauseWhenHidden), so a visible tab takes over.
 *
 * Gates: "Show more" sections are only polled while expanded. A tab with an expanded section sends
 * a heartbeat so the leader polls it even if the leader's own section is collapsed.
 */
import { Emitter } from "./util.js";

const CHANNEL = "cv:v1";
const GATE_HEARTBEAT_MS = 10000;
const GATE_TTL_MS = 25000;

export class Tabs extends Emitter {
  /** @param {{shareAcrossTabs:boolean, pauseWhenHidden:boolean}} o */
  constructor(o) {
    super();
    this.share = !!o.shareAcrossTabs && typeof navigator !== "undefined" && !!navigator.locks && typeof BroadcastChannel !== "undefined";
    this.pauseWhenHidden = !!o.pauseWhenHidden;
    this.page = null;
    /** "leader" | "follower" | "hidden" | "idle" */
    this.role = "idle";
    this._abort = null;
    this._release = null;
    this._token = 0;
    this.channel = this.share ? new BroadcastChannel(CHANNEL) : null;
    this.channel?.addEventListener("message", (ev) => this.emit("message", ev.data));

    /** gates open locally / seen from other tabs */
    this.localGates = new Set();
    /** @type {Map<string, number>} */
    this.remoteGates = new Map();
    this.on("message", (m) => {
      if (m?.type === "gate" && m.open) { this.remoteGates.set(m.id, Date.now() + GATE_TTL_MS); this.emit("gates"); }
    });
    if (this.channel) setInterval(() => this.localGates.forEach((id) => this.post({ type: "gate", id, open: true })), GATE_HEARTBEAT_MS);

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (!this.pauseWhenHidden) return;
        if (document.hidden) this._setRole("hidden"), this._releaseLock();
        else this._acquire();
      });
    }
  }

  post(msg) {
    try { this.channel?.postMessage(msg); } catch { /* ignore */ }
  }

  setPage(page) {
    if (this.page === page) return;
    this.page = page;
    this._acquire();
  }

  _setRole(role) {
    if (this.role === role) return;
    this.role = role;
    this.emit("role", role);
  }

  _releaseLock() {
    this._token++;
    this._abort?.abort();
    this._abort = null;
    this._release?.();
    this._release = null;
  }

  _acquire() {
    this._releaseLock();
    if (!this.page) return;
    if (this.pauseWhenHidden && typeof document !== "undefined" && document.hidden) { this._setRole("hidden"); return; }
    if (!this.share) { this._setRole("leader"); return; }
    const token = this._token;
    const ctrl = new AbortController();
    this._abort = ctrl;
    this._setRole("follower");
    this.post({ type: "hello", page: this.page });
    navigator.locks
      .request(`cv:page:${this.page}`, { signal: ctrl.signal }, () => new Promise((resolve) => {
        if (token !== this._token) return resolve(undefined);
        this._release = () => resolve(undefined);
        this._setRole("leader");
      }))
      .catch(() => { /* aborted */ });
  }

  isLeader() {
    return this.role === "leader";
  }

  /** Open/close a gate locally. */
  setGate(id, open) {
    if (open) this.localGates.add(id); else this.localGates.delete(id);
    if (open) this.post({ type: "gate", id, open: true });
    this.emit("gates");
  }

  gateOpen(id) {
    if (this.localGates.has(id)) return true;
    const until = this.remoteGates.get(id);
    return !!until && until > Date.now();
  }
}
