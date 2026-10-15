// @ts-check
/**
 * Exact decimal helpers on BigInt. Amounts are computed as integers ("raw" units) and
 * converted to decimal strings only at the edge. Floats are for rates and display only.
 */

/** raw integer → decimal string, e.g. (1500000n, 6) → "1.500000" */
export function formatUnits(raw, decimals) {
  const neg = raw < 0n;
  const v = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const int = v.slice(0, v.length - decimals);
  const frac = decimals > 0 ? v.slice(v.length - decimals) : "";
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

/**
 * Decimal string (also "1e7", "1.2E-3") → raw integer with `decimals` decimals.
 * Digits beyond `decimals` are truncated toward zero.
 */
export function parseUnits(str, decimals) {
  let s = String(str).trim();
  let neg = false;
  if (s[0] === "-") { neg = true; s = s.slice(1); } else if (s[0] === "+") s = s.slice(1);
  const m = s.match(/^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`Invalid decimal: ${str}`);
  const ip = m[1] || "0";
  const fp = m[2] || "";
  const exp = m[3] ? parseInt(m[3], 10) : 0;
  const digits = (ip + fp).replace(/^0+(?=\d)/, "");
  // value = digits × 10^(exp − fp.length); we want value × 10^decimals
  const shift = decimals + exp - fp.length;
  let v = BigInt(digits || "0");
  v = shift >= 0 ? v * 10n ** BigInt(shift) : v / 10n ** BigInt(-shift);
  return neg ? -v : v;
}

/** Rescale a raw integer from one number of decimals to another (truncating). */
export function rescale(raw, fromDec, toDec) {
  if (toDec === fromDec) return raw;
  return toDec > fromDec ? raw * 10n ** BigInt(toDec - fromDec) : raw / 10n ** BigInt(fromDec - toDec);
}

/** raw → float (display / ratios only). */
export function toNumber(raw, decimals) {
  if (raw == null) return null;
  return Number(formatUnits(raw, decimals));
}
