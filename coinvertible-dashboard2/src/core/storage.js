// @ts-check
/**
 * Safe, namespaced localStorage. Every access is wrapped: the app must work without storage
 * (private mode, blocked site data). BigInt values survive a round trip.
 */
const NS = "cv:v1:";

function replacer(_k, v) {
  return typeof v === "bigint" ? { __big: v.toString() } : v;
}
function reviver(_k, v) {
  return v && typeof v === "object" && typeof v.__big === "string" && Object.keys(v).length === 1 ? BigInt(v.__big) : v;
}

function ls() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = ls()?.getItem(NS + key);
      return raw == null ? fallback : JSON.parse(raw, reviver);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      ls()?.setItem(NS + key, JSON.stringify(value, replacer));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try { ls()?.removeItem(NS + key); } catch { /* ignore */ }
  },
  /** Keys (without namespace) starting with prefix. */
  keys(prefix = "") {
    try {
      const s = ls();
      if (!s) return [];
      const out = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(NS + prefix)) out.push(k.slice(NS.length));
      }
      return out;
    } catch {
      return [];
    }
  },
  /** Remove every key of this app (all versions of the namespace prefix "cv:"). */
  clearAll() {
    try {
      const s = ls();
      if (!s) return;
      const del = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith("cv:")) del.push(k);
      }
      del.forEach((k) => s.removeItem(k));
    } catch { /* ignore */ }
  },
};

/** For BroadcastChannel payloads (structured clone handles BigInt, but keep one format). */
export const serialize = (v) => JSON.stringify(v, replacer);
export const deserialize = (s) => JSON.parse(s, reviver);
