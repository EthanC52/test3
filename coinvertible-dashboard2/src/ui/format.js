// @ts-check
/** Display helpers (UI only). */
import { shortHex } from "../core/util.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const nf = (max, min = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: max, minimumFractionDigits: min });

/** Decimal string → "1,234,567.89" */
export function amount(str, max = 2) {
  if (str == null || str === "") return "—";
  const n = Number(str);
  return Number.isFinite(n) ? nf(max).format(n) : esc(str);
}

/** Compact: 1.23M */
export function compact(str) {
  if (str == null) return "—";
  const n = Number(str);
  return Number.isFinite(n) ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n) : "—";
}

export const usd = (n) => (n == null || !Number.isFinite(n) ? "—" : "$" + nf(0).format(n));

export const pct = (x, dp = 2) => (x == null || !Number.isFinite(x) ? "—" : nf(dp, dp).format(x * 100) + "%");

export function age(ms) {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dateTime(tsSec) {
  if (!tsSec) return "—";
  return new Date(tsSec * 1000).toLocaleString("en-GB", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function duration(sec) {
  if (sec == null) return "—";
  if (!Number.isFinite(sec)) return "∞";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

export function addrLink(explorer, address, label) {
  if (!address) return "—";
  const text = label ? esc(label) : `<code>${esc(shortHex(address))}</code>`;
  return `<a href="${esc(explorer.address + address)}" target="_blank" rel="noopener" title="${esc(address)}">${text}</a>`;
}

export function txLink(explorer, hash) {
  if (!hash) return "—";
  return `<a href="${esc(explorer.tx + hash)}" target="_blank" rel="noopener" title="${esc(hash)}"><code>${esc(shortHex(hash))}</code></a>`;
}

export const num = (n) => (n == null ? "—" : nf(0).format(n));
