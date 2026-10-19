# CoinVertible Dashboard

> **Status:** v0.3.1 — first working version of the data layer, with a plain functional UI to check the numbers.
> The visual design comes later. Decisions are logged in §14, open questions in §13.
> v0.5: larger centred logo, top-right update status with refresh, Main Vault card, curator logos, incentives as `amount - runway`, frameless "Show more".

Static site (no build, no server) for GitHub Enterprise Pages. Everything is read **from the browser**:
RPC first, third-party APIs only for discovery, logos and volumes.

| Page (route) | Content |
|---|---|
| `CoinVertible/Monitoring` (`#/coinvertible/monitoring`) | EURCV & USDCV issued supply per chain; 15 most recent mint/burn on Ethereum |
| `CoinVertible/Coinwatch` (`#/coinvertible/coinwatch`) | To be defined |
| `DeFi/Morpho` (`#/defi/morpho`) | EURCV vaults (deposits, idle %, APY / native APY, incentives + runway) and EURCV-loan markets |
| `DeFi/Uniswap` (`#/defi/uniswap`) | Whitelisted pools: amount of each asset (RPC) and 24 h volume (GeckoTerminal) |

---

## 1. Files

Five files, all at the root of the repo:

| File | Role | Edit it? |
|---|---|---|
| `index.html` | Page shell + CSS (inline) | Rarely |
| `config.js` | **All configuration**: chains and endpoints, frequencies, tokens, Morpho whitelist, Uniswap pools | Yes |
| `known_addresses.json` | Address → label | Yes |
| `app.js` | All the code (one ES module, 25 numbered sections, no dependency) | When the code changes |
| `README.md` | This document | - |

Optional folders (binary files, uploaded as-is):
- `logos/` - files listed in `config.js` -> `logos` (forge-favicon.png, forge.svg, eurcv.png, usdcv.png, ethereum.png, solana.png, stellar.png, xrpl.png, morpho.svg, uniswap.svg). Any size or ratio; a missing file shows a monogram. Morpho collateral and curator logos come from the Morpho API automatically.
- `fonts/` - `Geist-Variable.woff2` and `GeistMono-Variable.woff2` (SIL OFL). If the folder is absent, the fonts load from jsDelivr; if that is blocked too, the system font is used.

Optional, not needed on the site: `tests.mjs` (developer tests, see below).

`index.html`, `config.js`, `app.js` and `tests.mjs` are pure ASCII, so copy-paste between machines cannot alter them (UI symbols are written as `\uXXXX` escapes). Save every file as UTF-8.

## 2. Run, test, deploy

```bash
python3 -m http.server 8080      # then http://localhost:8080 (ES modules do not work from file://)
node tests.mjs                   # unit tests (math, ABI codec, decimals, error classification)
node tests.mjs --live            # + one live read of every module (behind a proxy: NODE_USE_ENV_PROXY=1 node tests.mjs --live)
```

Deploy: commit the files at the root of the repo; GitHub Enterprise Pages -> *Deploy from a branch*, root folder. `config.js` is loaded first (it defines `globalThis.CV_CONFIG`), then `app.js`.

Sections of `app.js` (search for the number to jump to one):

```
 1-10  CORE     utilities, exact decimals, localStorage, request accounting, RPC pool, config loader,
                address labels, results store, cross-tab coordination, scheduler
11-15  CHAINS   EVM ABI codec, EVM adapter (multicall batching, merged logs), Solana, Stellar, XRPL
16-22  MODULES  base class, monitoring.supply, monitoring.mintburn, Morpho math / discovery / module, Uniswap
23-24  UI       formatting, pages (functional, to be redesigned)
25     MAIN     wiring and boot
```

No dependency at runtime. The ABI codec is hand-written (every call uses static types only); selectors and event topics are precomputed in section 11.

## 2b. Interface (DA)

- Dark theme from the SG-Forge Monitoring DA: background `#0A0A0A`, cards `#171717`, text `#FAFAFA`, SG red `#E9041E`; states success `#00884B`, error `#E40014`, warning `#F99C00`. Geist / Geist Mono, weights 400-600, tabular figures, 8 px radius, Lucide-style icons.
- Left sidebar: logo 36 px high, centred; width = the larger of the logo and the longest label. The toggle in the top bar collapses it to an icon rail (remembered per browser). The page uses all the remaining width with a 32 px margin.
- Top right: time since the page's data was last updated, a status dot (green: all sources fresh, amber: late, red: failing; details on hover) and a refresh button.
- No banners. Each page starts with a source line (chain, block/slot/ledger, age); hovering shows endpoints and errors. A chain whose value cannot be read gets a red dot next to its name, with the reason on hover. All warnings are listed in Diagnostics (gauge icon, bottom left; a red dot on it means something needs attention).
- Monitoring: supply per token and chain (share bars); mint/burn list showing 8 rows, scrollable to all 15.
- Morpho: the vault with the largest deposits (or `config.js` -> `morpho.mainVault`) is shown first in a "Main Vault" card at 1.5x; other vaults in the table with their curator logo. Vault and market names open the Morpho app (`morpho.appUrl`); vault APY shows native / incentives / cap on hover; incentives read `amount - runway` with burn/day and depletion date underneath. Totals supplied/borrowed cover the whitelisted markets, plus the others while "Show more" is open (details in the (i) tooltip).

## 3. How a refresh works

```
Router ─► visible page ─► its modules ─► Scheduler (one loop per chain / API)
                                            │ tick: EVM → 1 eth_blockNumber, pin block
                                            ▼
                         Chain adapter: Multicall3 batches (all modules of the tick merged,
                         de-duplicated, same block) + one merged eth_getLogs
                                            ▼
                         RpcPool: token bucket per endpoint, weighted round-robin,
                         failover, cooldown, learned limits, stats
                                            ▼
                         Store (+ localStorage cache) ─► UI, and other tabs via BroadcastChannel
```

- **Only the visible page polls.** Monitoring uses the 4 chains; Morpho and Uniswap only Ethereum (+ GeckoTerminal).
- **One tab polls per page.** The leader tab holds a Web Lock; other tabs on the same page receive the results and make no request.
- **Hidden tab = no request.** It releases the lock; a visible tab takes over.
- **Same block = skip.** If the Ethereum head has not moved since a module's last run, the module is skipped (1 call instead of 3).
- **"Show more" is polled only while expanded** (in any tab: expanded sections send a heartbeat to the leader).
- **Cached on reload:** last results (shown as cached), mint/burn events + cursor, Morpho discovery/structure/market params, block timestamps, token roles, incentive buffer samples.

## 4. Configuration

### 4.1 Endpoints — `config.js` → `chains`

Public endpoints only (the file is readable by anyone who can open the site). Measured from a browser context on 2026-10-15:

| Chain | Endpoints | Notes |
|---|---|---|
| Ethereum | NOWNodes, Pocket, SwiftNodes, BlockMachine (calls + logs with full history); Nodies, Nodies POKT (calls + logs up to 50 blocks); bloXroute x4, Stakely, BlockPI (calls only) | Only RPCs that pass the corporate proxy, without API keys (tested 2026-10-15). Log scans go to the endpoints with long ranges; the per-block refresh can use any endpoint with logs. Not used: Alchemy demo / RPCFast (API keys), Fullsend (no CORS), Tatum (`eth_call` paid only), Flashbots Protect (no `eth_call`, silently empty old logs), MeowRPC (no `eth_call` / `eth_getLogs`), PublicNode and dRPC (blocked by the proxy). |
| Solana | Solana Vibe Station, Solana Tracker | Uniblock has no CORS; the Solana Foundation endpoints are blocked by the proxy (and refuse web pages anyway). |
| Stellar | SDF Horizon | Not in the proxy test yet - to check. Stellar Expert refuses cross-origin requests. |
| XRPL | xrplcluster.com, xrpl.link | Not in the proxy test yet - to check. `s1/s2.ripple.com` send no CORS header. |

The pool learns tighter limits at runtime: an endpoint that answers "range too large" gets a smaller `maxLogRange`, one that answers "archive required" gets a smaller `logDepth`.

**Settings button** (discreet ⚙ bottom right): a user can paste their own endpoints per chain. They are stored in that browser only and replace the config for that chain. "Clear local cache" resets history and learned limits.

**About private keys and GitHub secrets.** Repository secrets are only available to GitHub Actions workflows, never to the page at runtime. A workflow could inject a key into `config.js` at deploy time, but the key would then sit in a public JS file and anyone who can open the site could read it: the secret only hides it in the repo, not on the site. Options if a private RPC is needed one day:
1. a key restricted **by origin** at the provider (allowlist the Pages domain) with a spend cap — the usual approach for front-end keys;
2. each user pastes their own key in the settings panel;
3. a small proxy that holds the key — not available with the current infrastructure.

### 4.2 Frequencies — `config.js` → `frequency`

```js
chains: { ethereum: 12, solana: 10, stellar: 20, xrpl: 20 },   // seconds
apis:   { geckoterminal: 60 },
modules: { "monitoring.supply": { ethereum: null, ... }, ... }   // null = same as the chain
cacheTtl: { "morpho.discovery": 21600, "morpho.structure": 900, "token.roles": 86400 },
behaviour: { pauseWhenHidden: true, skipIfSameBlock: true, shareAcrossTabs: true, staleAfterIntervals: 3 },
options: { supplyOnlyOnMintBurn: false },
```

Module intervals are rounded up to a multiple of the chain interval so that everything due on a tick shares one block and one batch. `supplyOnlyOnMintBurn: true` re-reads `totalSupply()` only after a mint/burn (+ every 5 min), saving one call per tick on Monitoring.

### 4.3 Morpho whitelist — `config.js` → `morpho`

```js
vaults:  [{ address, label, whitelist: true, incentives: true }, ...],
markets: [{ id: "0x…32 bytes", whitelist: true }, ...],
```

Starting whitelist: the 4 main vaults (incentives on Steakhouse Prime EURCV) and the 10 markets above ~$0.5M supplied. Both `cbBTC/EURCV 86%` markets (different oracles) are whitelisted for now — to decide. Everything else discovered goes under "Show more".

### 4.4 Uniswap — `config.js` → `uniswap`

Whitelisted v3 pools only (EURCV/EURC 0.01 %, EURCV/USDC 0.05 %, USDCV/USDC 0.01 %). `token0/token1`, symbols and decimals are read on-chain once.

### 4.5 Labels — `known_addresses.json`

```json
{ "ethereum": { "0xabc…": { "label": "Treasury", "type": "sgforge" } }, "solana": {}, "stellar": {}, "xrpl": {} }
```

EVM addresses are matched case-insensitively. Priority: this file > on-chain roles > Morpho vault names. On-chain roles are read automatically from the SmartCoin contracts: `Registrar (EURCV, USDCV)`, `Operations (…)`, `Technical (…)` and `Redemption (EURCV)` for redemption addresses.

## 5. Data sources

| Data | Source | Method |
|---|---|---|
| Supply, Ethereum | RPC | `totalSupply()` in Multicall3 (decimals checked once) |
| Supply, Solana | RPC | `getMultipleAccounts([both mints], jsonParsed)` → `supply` (1 call, Token-2022) |
| Supply, Stellar | Horizon | `GET /assets?asset_issuer=` → sum of `authorized`, `authorized_to_maintain_liabilities`, `unauthorized`, `claimable_balances_amount`, `liquidity_pools_amount`, `contracts_amount` |
| Supply, XRPL | RPC | `gateway_balances` on the issuer, validated ledger → `obligations` |
| Mint/burn | RPC | `eth_getLogs` (Transfer, RedemptionStarted) |
| Morpho lists, names, logos | Morpho API | GraphQL `vaults`, `vaultV2s`, `markets` (cached 6 h) |
| Morpho numbers | RPC | Morpho Blue, IRM, vaults, adapters in Multicall3 |
| Uniswap amounts | RPC | `token.balanceOf(pool)` |
| Uniswap volume 24 h | GeckoTerminal (CoinGecko) | `GET /networks/eth/pools/multi/{pools}` → `volume_usd.h24` (USD) |

Why Horizon for Stellar: a classic asset has no supply stored on-ledger; only an indexer can sum every trustline, claimable balance, pool and SAC balance. Stellar RPC cannot. Horizon is "nearing end-of-life" per SDF; the Stellar adapter isolates that choice.

## 6. Mint / burn (Ethereum)

**15 most recent across EURCV and USDCV.** Both tokens are proxies to the same `SmartCoin` implementation (`0xf4cc…f05b`).

- mint = `Transfer(0x0 → recipient)`; burn = `Transfer(registrar → 0x0)`: the burn's `from` is always the registrar.
- **Finding:** the holder's tokens reach the registrar before the burn:
  - EURCV: `RedemptionStarted(holder → redemption address)`, then `Transfer(holder → registrar)`
  - USDCV: only `Transfer(holder → registrar)` — no `RedemptionStarted` in the last 300,000 blocks
- **Attribution of a burn:** latest unmatched `RedemptionStarted` with the same token and amount before the burn (agreed rule); otherwise latest unmatched transfer to the registrar with the same amount; otherwise the registrar (`attribution: "registrar"`). On 2026-10-15 all 15 displayed events were attributed (14 EURCV through `RedemptionStarted`, 1 USDCV through the registrar transfer).
- **Reading:** first load scans back from the head in 10,000-block windows with targeted filters until 15 events are found and matched (1 window today). Then one `eth_getLogs` per new block over `(cursor, head − 2]` with `topic0 ∈ {Transfer, RedemptionStarted}`, filtered locally. State is cached, so a reload does not rescan.
- Timestamps come from `blockTimestamp` in the logs when the endpoint provides it, else `eth_getBlockByNumber` (cached).

## 7. Morpho (EURCV)

**Per tick:** phase A (one coalesced multicall: `market(id)`, vault state, positions, adapter `realAssets`, structure lengths) and phase B (`IRM.borrowRateView(params, market)` per market, which needs A's market tuples). Discovery and structure (V1 withdraw queues, V2 adapters and their market ids) are cached and reloaded when a length read on-chain changes.

**Markets** (loan asset = EURCV, idle markets excluded): `borrowAPY = exp(borrowRate × year) − 1`, utilization after interest accrual to the block timestamp (`MorphoBalancesLib` logic). Bands on the unrounded value: `[0,90[` yellow · `[90,91]` green · `]91,98[` orange · `[98,100]` red. The overview sums supplied/borrowed over whitelisted markets.

**Vaults:**
- V1 (MetaMorpho): positions from `MorphoBlue.position(id, vault)`; idle = vault's own EURCV balance + supply in the idle market. Native APY = Σ(assets × supplyRate) / assets × (1 − fee).
- V2: adapters detected on-chain (`MorphoMarketV1AdapterV2`, older `MorphoMarketV1Adapter`, `MorphoVaultV1Adapter`). Idle = vault's own EURCV balance + any idle-market allocation.
  - `nativeApy` = organic yield of the allocations, capped at `maxRate`, net of performance and management fees.
  - `apy` = `maxRate` while an incentive buffer exists (that is what share price does), net of fees; otherwise native.
  - **Incentives** (`incentives: true`): `buffer = realAssets − totalAssets()`; `burn/s = totalAssets × maxRate − realAssets × nativeRate`; `runway = buffer / burn`. An observed burn from buffer samples (≥ 10 min window, donations reset it) is shown alongside; a > 20 % gap raises a warning.

Live check on 2026-10-15 — Steakhouse Prime EURCV: 134.35 M deposits, 72.8 % idle, APY 3.00 % (native 0.48 % + incentives 2.52 %), buffer ≈ 65.9 k EURCV, burn ≈ 9.1 k/day, runway ≈ 7 days.

## 8. Uniswap

Amounts = `balanceOf(pool)` of both tokens (includes LP fees not yet collected, a small amount). Volume 24 h from GeckoTerminal, in USD, every 60 s (its free tier allows ~30 calls/min **per IP**, shared by everyone behind the corporate IP). v4 pools are not supported (pool balances are pooled in one contract).

## 9. Measured request rates (one visible tab, headless Chromium, 2026-10-15)

| Page | Calls / hour | Detail |
|---|---|---|
| Monitoring | ~1,350 | Ethereum ~630 (`eth_blockNumber` 270, `eth_call` 180, `eth_getLogs` 180), Solana 360, Stellar 180, XRPL 180 |
| Morpho | ~810 | `eth_blockNumber` 270, `eth_call` 540 (2 multicalls per new block, ~70 sub-calls each) |
| Uniswap | ~660 | `eth_blockNumber` 300, `eth_call` 300, GeckoTerminal 60 |

First load adds a few calls (mint/burn scan ~9, Morpho discovery + structure ~6). Hidden tabs cost nothing; extra tabs on the same page cost nothing. The Diagnostics panel (bottom of the page) and `window.cvStats` give live counts per endpoint, module and method.

## 10. Result envelope

Every module publishes:

```json
{ "module": "monitoring.supply", "schema": 1, "updatedAt": 1792061998844, "status": "ok|partial|error|pending",
  "sources": { "ethereum": { "block": 26197473, "blockTime": 1792061987, "endpoint": "publicnode, tenderly", "status": "ok", "okAt": 1792061998844 } },
  "warnings": [], "data": { } }
```

A source is `stale` in the UI when older than `staleAfterIntervals × interval`; the last good value is kept and flagged. A supply total missing a chain is flagged `partial`. Amounts are decimal strings computed from integers.

## 11. Extending

- **New EVM chain (Base…):** in `config.js`, add it to `chains` and `frequency.chains`, and add its deployments to `tokens`. Nothing else.
- **New chain type:** add an adapter class next to the others in `app.js` (sections 12-15), register it in `ADAPTERS` (section 25), handle it in `monitoring.supply` (section 17).
- **New module:** add a class extending `Module` (section 16) with `{ id, page, chains, schedules }` and `run(chain, ctx, dueIds)`, add its intervals to `config.js` -> `frequency.modules`, register it in `createApp()` (section 25). `ctx.call()` / `ctx.logs()` are batched automatically with the other modules of the tick.

## 12. Reference addresses (Ethereum)

| What | Address |
|---|---|
| EURCV (proxy) | `0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2` |
| USDCV (proxy) | `0x5422374B27757da72d5265cC745ea906E0446634` |
| SmartCoin implementation (both) | `0xf4ccc80c4b831a0d8d1414f2aca82a3d760ff05b` |
| Registrar (both tokens) | `0x7de0bbdfcd4a6a956f149befcca30d6b5bc5da69` |
| EURCV redemption address (seen) | `0x57b8b45fd166cecea7a4c37a0da218d9f01aeba2` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| AdaptiveCurveIrm | `0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC` |

## 13. Open questions

1. Which of the two `cbBTC/EURCV 86 %` markets (and the duplicate WBTC / wstETH ones) stay whitelisted.
2. Coinwatch page content.
3. Whether to turn on `supplyOnlyOnMintBurn` once the request counts are observed in real use.

## 14. Decisions log

| Topic | Decision |
|---|---|
| Runtime | Browser only, static site on GitHub Enterprise Pages |
| Packaging | 5 files (index.html, config.js, known_addresses.json, app.js, README.md), ASCII-only code for copy-paste |
| Endpoints | Public endpoints in `config.js`; discreet settings button to override per browser |
| Log history | RPC first (public endpoints with history); Etherscan API later if needed |
| Supply | Issued supply, everything counted |
| Chains pending | Base, Canton |
| Mint/burn | 15 most recent, any token, Ethereum only; burn attributed via `RedemptionStarted`, then transfer to registrar |
| Morpho | EURCV only; markets where EURCV is lent; idle = not deployed (vault balance + idle market); incentives = V2 donations only; "Show more" polled only while expanded |
| Uniswap | Whitelisted pools; amounts on-chain; 24 h volume from GeckoTerminal (CoinGecko); no pool price |
| Frequencies | Ethereum 12 s, Solana 10 s, Stellar / XRPL 20 s; modules default to their chain |
| known_addresses | JSON |
