// Unit tests (dev only): node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { formatUnits, parseUnits, rescale } from "../src/core/decimal.js";
import { encodeAggregate3, decodeAggregate3, dec, enc, call } from "../src/chains/evm/abi.js";
import { wTaylorCompounded, toAssetsDown, accrue, marketRates, utilizationBand, vaultV2Rates, observedBurn, WAD } from "../src/modules/morpho/math.js";
import { stellarSupplyRaw } from "../src/chains/stellar/adapter.js";
import { hexCurrencyToAscii } from "../src/chains/xrpl/adapter.js";
import { classifyRpcError } from "../src/core/rpc-pool.js";

test("decimal: format/parse round trip", () => {
  assert.equal(formatUnits(141725037260000000000000000n, 18), "141725037.260000000000000000");
  assert.equal(formatUnits(5n, 2), "0.05");
  assert.equal(formatUnits(-1500n, 3), "-1.500");
  assert.equal(parseUnits("15030600.0000000", 7), 150306000000000n);
  assert.equal(parseUnits("1e7", 2), 1000000000n);
  assert.equal(parseUnits("1.23E-2", 4), 123n);
  assert.equal(parseUnits("0.123456789", 6), 123456n); // truncation
  assert.equal(parseUnits("-2.5", 1), -25n);
  assert.equal(rescale(208559870n, 2, 18), 2085598700000000000000000n);
  assert.throws(() => parseUnits("abc", 2));
});

test("abi: aggregate3 encode/decode", () => {
  const data = encodeAggregate3([call("0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2", "totalSupply")]);
  assert.ok(data.startsWith("0x82ad56cb"));
  // Build a fake response: one result (true, 32 bytes = 42)
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  const resp = "0x" + w(0x20) + w(1) + w(0x20) + w(1) + w(0x40) + w(32) + w(42);
  const out = decodeAggregate3(resp);
  assert.equal(out.length, 1);
  assert.equal(out[0].success, true);
  assert.equal(dec.uint(out[0]), 42n);
  assert.equal(dec.uint({ success: false, data: "0x" }), null);
  assert.equal(enc.addr("0xABCDEF0000000000000000000000000000000001"), "000000000000000000000000abcdef0000000000000000000000000000000001");
});

test("abi: string decoding", () => {
  const w = (v) => BigInt(v).toString(16).padStart(64, "0");
  const txt = Buffer.from("EURCV").toString("hex").padEnd(64, "0");
  assert.equal(dec.string({ success: true, data: "0x" + w(0x20) + w(5) + txt }), "EURCV");
  assert.equal(dec.string({ success: true, data: "0x" + txt }), "EURCV"); // bytes32 style
});

test("morpho: wTaylorCompounded ≈ e^x − 1", () => {
  const rate = 634195839n; // ~2% APR per second in WAD
  const year = 31536000n;
  const v = Number(wTaylorCompounded(rate, year)) / 1e18;
  assert.ok(Math.abs(v - Math.expm1(Number(rate) / 1e18 * 31536000)) < 1e-6);
});

test("morpho: toAssetsDown with virtual shares", () => {
  assert.equal(toAssetsDown(10n ** 6n, 0n, 0n), 1n);
  assert.equal(toAssetsDown(2n * 10n ** 24n, 2n * 10n ** 18n, 2n * 10n ** 24n), 2000000000000000000n);
  assert.equal(toAssetsDown(10n ** 24n, 3n * 10n ** 18n, 2n * 10n ** 24n), 1499999999999999999n);
});

test("morpho: accrue + rates", () => {
  const m = { totalSupplyAssets: 1000n * WAD, totalBorrowAssets: 900n * WAD, lastUpdate: 1000n };
  const r = 634195839n;
  const a = accrue(m, r, 1000n + 86400n, true);
  assert.ok(a.borrow > m.totalBorrowAssets);
  assert.equal(a.supply - m.totalSupplyAssets, a.borrow - m.totalBorrowAssets);
  const noIrm = accrue(m, r, 2000n, false);
  assert.equal(noIrm.borrow, m.totalBorrowAssets);
  const mr = marketRates(1000n * WAD, 900n * WAD, r, 0n);
  assert.ok(Math.abs(mr.utilization - 0.9) < 1e-12);
  assert.ok(Math.abs(mr.supplyApy - Math.expm1(Number(r) / 1e18 * 0.9 * 31536000)) < 1e-9);
});

test("morpho: utilization bands", () => {
  assert.equal(utilizationBand(0), "yellow");
  assert.equal(utilizationBand(0.8999), "yellow");
  assert.equal(utilizationBand(0.90), "green");
  assert.equal(utilizationBand(0.91), "green");
  assert.equal(utilizationBand(0.9101), "orange");
  assert.equal(utilizationBand(0.9799), "orange");
  assert.equal(utilizationBand(0.98), "red");
  assert.equal(utilizationBand(1), "red");
});

test("morpho: Vault V2 incentives and runway", () => {
  const maxRate = 0.029558805320448 / 31536000; // per second
  const r = vaultV2Rates({ realAssets: 134102043, totalAssets: 134035766, organicPerSec: 36688838 * 0.018 / 31536000, maxRate, performanceFee: 0, managementFee: 0 });
  assert.ok(Math.abs(r.buffer - 66277) < 1);
  assert.ok(Math.abs(r.apy - Math.expm1(maxRate * 31536000)) < 1e-12);
  assert.ok(r.nativeApy < r.apy);
  assert.ok(r.burnPerSec > 0 && Number.isFinite(r.runwaySec));
  // no buffer → native
  const r2 = vaultV2Rates({ realAssets: 100, totalAssets: 100, organicPerSec: 100 * 0.01 / 31536000, maxRate, performanceFee: 0.1, managementFee: 0 });
  assert.equal(r2.buffer, 0);
  assert.ok(Math.abs(r2.apy - r2.nativeApy) < 1e-12);
  // organic above cap → buffer grows, runway infinite
  const r3 = vaultV2Rates({ realAssets: 101, totalAssets: 100, organicPerSec: 100 * 0.05 / 31536000, maxRate, performanceFee: 0, managementFee: 0 });
  assert.equal(r3.runwaySec, Infinity);
});

test("morpho: observed burn with donation reset", () => {
  const s = [{ t: 0, buffer: 1000 }, { t: 600, buffer: 990 }, { t: 1200, buffer: 5000 }, { t: 1800, buffer: 4990 }, { t: 2400, buffer: 4980 }];
  const o = observedBurn(s, 600);
  assert.equal(o.donations.length, 1);
  assert.ok(Math.abs(o.burnPerSec - 20 / 1200) < 1e-12);
});

test("stellar supply sums every bucket", () => {
  const rec = { balances: { authorized: "15030600.0000000", authorized_to_maintain_liabilities: "1.0000000", unauthorized: "0.0000000" }, claimable_balances_amount: "2.5000000", liquidity_pools_amount: "0.0000000", contracts_amount: "0.0000001" };
  assert.equal(stellarSupplyRaw(rec), parseUnits("15030603.5000001", 7));
});

test("xrpl currency code", () => {
  assert.equal(hexCurrencyToAscii("4555524356000000000000000000000000000000"), "EURCV");
});

test("rpc error classification", () => {
  assert.equal(classifyRpcError({ message: "execution reverted" }), "revert");
  assert.equal(classifyRpcError({ message: "Archive requests require a personal token." }), "depth");
  assert.equal(classifyRpcError({ message: "ranges over 10000 blocks are not supported on free plan" }), "range");
  assert.equal(classifyRpcError({ message: "Invalid eth_getLogs request. 'fromBlock'-'toBlock' range too large. Max range: 800" }), "range");
  assert.equal(classifyRpcError({ message: "Rate limit exceeded", code: -32005 }), "rate");
  assert.equal(classifyRpcError({ message: "header not found" }), "rpc");
});
