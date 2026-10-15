// @ts-check
/**
 * Morpho math (pure functions, unit-tested).
 * Reproduces Morpho Blue's MathLib / SharesMathLib / MorphoBalancesLib and Vault V2 accrual.
 */

export const WAD = 10n ** 18n;
export const YEAR = 31_536_000;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;

/** MathLib.wTaylorCompounded: e^(x·n) − 1 ≈ x·n + (x·n)²/2 + (x·n)³/6, in WAD. */
export function wTaylorCompounded(x, n) {
  const first = x * n;
  const second = (first * first) / (2n * WAD);
  const third = (second * first) / (3n * WAD);
  return first + second + third;
}

/** SharesMathLib.toAssetsDown */
export function toAssetsDown(shares, totalAssets, totalShares) {
  return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
}

/**
 * MorphoBalancesLib.expectedMarketBalances (without fee shares, which do not change asset totals).
 * @param {{totalSupplyAssets:bigint,totalBorrowAssets:bigint,lastUpdate:bigint}} m
 * @param {bigint} borrowRate per second, WAD
 * @param {bigint} now block timestamp
 * @param {boolean} hasIrm
 */
export function accrue(m, borrowRate, now, hasIrm) {
  const elapsed = now > m.lastUpdate ? now - m.lastUpdate : 0n;
  if (!hasIrm || elapsed === 0n || m.totalBorrowAssets === 0n) {
    return { supply: m.totalSupplyAssets, borrow: m.totalBorrowAssets };
  }
  const interest = (m.totalBorrowAssets * wTaylorCompounded(borrowRate, elapsed)) / WAD;
  return { supply: m.totalSupplyAssets + interest, borrow: m.totalBorrowAssets + interest };
}

/** Per-second rate (float) → APY. */
export const rateToApy = (perSec) => (perSec == null || !Number.isFinite(perSec) ? null : Math.expm1(perSec * YEAR));

/** WAD bigint → float. */
export const wadToFloat = (w) => (w == null ? null : Number(w) / 1e18);

/**
 * Market rates from its state.
 * @returns {{utilization:number, borrowRate:number, supplyRate:number, borrowApy:number, supplyApy:number}}
 */
export function marketRates(supply, borrow, borrowRateWad, feeWad) {
  const utilization = supply === 0n ? 0 : Number((borrow * 10n ** 12n) / supply) / 1e12;
  const borrowRate = wadToFloat(borrowRateWad) || 0;
  const fee = wadToFloat(feeWad) || 0;
  const supplyRate = borrowRate * utilization * (1 - fee);
  return { utilization, borrowRate, supplyRate, borrowApy: rateToApy(borrowRate), supplyApy: rateToApy(supplyRate) };
}

/**
 * Utilization band, compared on the unrounded percentage.
 *   [0, 90[ yellow · [90, 91] green · ]91, 98[ orange · [98, 100] red
 */
export function utilizationBand(utilization) {
  const p = utilization * 100;
  if (p < 90) return "yellow";
  if (p <= 91) return "green";
  if (p < 98) return "orange";
  return "red";
}

/**
 * Vault V2: displayed and native rates, incentive buffer and runway.
 * All amounts as floats in asset units (display), rates per second.
 * @param {{realAssets:number, totalAssets:number, organicPerSec:number, maxRate:number, performanceFee:number, managementFee:number}} v
 */
export function vaultV2Rates(v) {
  const { realAssets: RA, totalAssets: TA, organicPerSec, maxRate, performanceFee, managementFee } = v;
  const buffer = Math.max(0, RA - TA);
  const nativeGross = TA > 0 ? Math.min(organicPerSec / TA, maxRate) : 0;
  const gross = buffer > 0 ? maxRate : nativeGross;
  const net = (r) => r * (1 - performanceFee) - managementFee;
  const apy = rateToApy(net(gross));
  const nativeApy = rateToApy(net(nativeGross));
  const capGrowth = TA * maxRate;
  const burnPerSec = capGrowth - organicPerSec;
  const runwaySec = buffer <= 0 ? 0 : burnPerSec > 0 ? buffer / burnPerSec : Infinity;
  return {
    buffer,
    nativeRateOnRealAssets: RA > 0 ? organicPerSec / RA : 0,
    apy,
    nativeApy,
    incentiveApy: apy != null && nativeApy != null ? apy - nativeApy : null,
    capApy: rateToApy(maxRate),
    burnPerSec,
    runwaySec,
  };
}

/**
 * Observed burn of the buffer from samples [{t, buffer}] (seconds, asset units).
 * A jump up (donation) restarts the window. Returns burn per second over the window, or null.
 */
export function observedBurn(samples, minWindowSec = 600) {
  if (!samples || samples.length < 2) return { burnPerSec: null, windowSec: 0, donations: [] };
  const donations = [];
  let start = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].buffer - samples[i - 1].buffer;
    const threshold = Math.max(1, Math.abs(samples[i - 1].buffer) * 1e-4);
    if (d > threshold) { donations.push({ t: samples[i].t, amount: d }); start = i; }
  }
  const a = samples[start];
  const b = samples[samples.length - 1];
  const dt = b.t - a.t;
  if (dt < minWindowSec) return { burnPerSec: null, windowSec: dt, donations };
  return { burnPerSec: (a.buffer - b.buffer) / dt, windowSec: dt, donations };
}
