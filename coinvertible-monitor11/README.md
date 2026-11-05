# CoinVertible Dashboard

> **Version: v11** (2026-11-05) - shown in Diagnostics. `HANDOFF.md` holds the working rules and the state of the project for whoever continues it.
>
> v11: DeFi/Uniswap "Aggregators" section (§8c); Morpho read on every configured chain (Base ready), chain logo on each vault / market, chain filters next to the section titles, Main Vault and totals per chain, loading state of "Show more"; Base chain configured (disabled until the token is deployed there); light theme with a white sidebar and one brand logo per theme; block numbers moved to the source pills' tooltip; Coinwatch "Trading pairs" built from the markets list only, filter menus in the DA, link to create a Coinwatch API key; Canton supply source = CoinGecko (Forge figure).
> v10: light and dark themes with one structure (colour variables per theme); Current / Peg lines with a halo; Coinwatch: market makers grouped, Trading pairs tab, venue logos; USDCV Canton supply (temporary).
> v9: Coinwatch KPIs (volume bars, depth share, average spread, active market makers), venue / market maker logos matched by name, markets list in config.js.
> v8: Coinwatch page (API key per user, 6 h browser cache, requests only for what is shown); categorical palette for multi-line charts.
> v7: Graphite / Paper themes, compact supply curves, unfoldable Morpho vault rows, APY hover rules.
> Before v7: supply history (DefiLlama), Morpho Net APY and fees, Main Vault card, Uniswap v2 / v3 / v4 with pool pages, RPC tester.

Static site (no build, no server, no dependency) for GitHub Enterprise Pages. Everything is read **from the browser**: public RPCs first, third-party APIs only for discovery, logos, histories and volumes.

| Page (route) | Content |
|---|---|
| `CoinVertible/Monitoring` (`#/coinvertible/monitoring`) | EURCV and USDCV issued supply per chain (with the daily history), 15 most recent mints / burns on Ethereum |
| `CoinVertible/Coinwatch` (`#/coinvertible/coinwatch/eurcv`, `/usdcv`, `/pairs`) | Coinwatch market data per token: KPIs, market makers per exchange (unfolding details), exchanges; Trading pairs from the markets list of `config.js` |
| `DeFi/Morpho` (`#/defi/morpho`) | EURCV vaults (Main Vault card, deposits, idle, Net APY, incentives and runway) and EURCV-loan markets, on every configured chain, filterable by chain |
| `DeFi/Uniswap` (`#/defi/uniswap`) | TVL and 24 h volume; one card per pool (price, peg, TVL, volume, composition); **Aggregators**: EURCV traded through 7 DEX aggregators |
| `DeFi/Uniswap/<pool>` (`#/defi/uniswap/eurcv-eurc`, ...) | Liquidity distribution (zoomable), depth +/-10/50/100 bps, sale impact 100k / 500k / 1M, LP positions |

---

## 1. Files

| File | Role | Edit it? |
|---|---|---|
| `index.html` | Page shell + all the CSS (inline) | Rarely |
| `config.js` | **All configuration**: chains and endpoints, frequencies, tokens, Morpho, Uniswap, aggregators, Coinwatch, logos | Yes |
| `known_addresses.json` | Address -> label | Yes |
| `app.js` | All the code (one ES module, numbered sections, no dependency) | When the code changes |
| `rpc-tester.html` | Tests RPC endpoints from the browser and prints them in the `config.js` format (§4.2) | Lists inside, if needed |
| `README.md` | This document | - |
| `HANDOFF.md` | Working rules, design rules, architecture, state of the project | - |
| `tests.mjs`, `tests-aggregators.mjs` | Developer tests (§2); not needed on the site | - |

Optional folders (binary files, uploaded as they are):
- `logos/` - the files named in `config.js` -> `logos`: brand (`forge_white.svg` / `forge_black.svg`, marks `forge_mark_white.svg` / `forge_mark_black.svg`, favicon `forge-favicon.png`), tokens (`eurcv.png`, `usdcv.png`, `eurc.svg`, `usdc.svg`), chains (`ethereum.png`, `base.svg`, `solana.png`, `stellar.png`, `xrpl.png`, `canton.svg`), sidebar (`morpho.svg`, `uniswap.svg`), Coinwatch (`flowdesk.svg`, `flowtraders.svg`, `bitvavo.svg`, `bullish.svg`, `bitstamp.png`, `kraken.svg`), aggregators (`bebop.svg`, `0x.svg`, `cow.svg`, `velora.svg`, `1inch.svg`, `kyberswap.svg`). Any size or ratio. A missing file shows a monogram; a local logo missing under its extension is also tried as `.svg`, `.png`, `.webp`, `.jpg`, `.jpeg`. Morpho collateral and curator logos come from the Morpho API.
- `fonts/` - `Geist-Variable.woff2` and `GeistMono-Variable.woff2` (SIL OFL). Without the folder the fonts load from jsDelivr, then the system font.

`index.html`, `config.js`, `app.js`, `rpc-tester.html` and the test files are pure ASCII (non-ASCII characters are written as `\uXXXX` escapes), so copying them between machines cannot alter them. Save every file as UTF-8.

## 2. Run, test, deploy

```bash
python3 -m http.server 8080                  # then http://localhost:8080 (ES modules do not work from file://)
node tests.mjs                               # unit tests: decimals, ABI codec, Morpho / Uniswap maths, routes, config, Coinwatch helpers
node tests.mjs --live                        # + one live read of every module
node tests-aggregators.mjs                   # Aggregators: 6 real transactions as fixtures
node tests-aggregators.mjs --live            # + the last 24 h read from the RPCs, invariants checked
# behind a proxy: NODE_USE_ENV_PROXY=1 node ... (and NODE_EXTRA_CA_CERTS=<ca bundle> if the proxy intercepts TLS)
```

Deploy: commit the files at the root of the repository; GitHub Enterprise Pages -> *Deploy from a branch*, root folder. `config.js` is loaded first (it defines `globalThis.CV_CONFIG`), then `app.js`.

Sections of `app.js` (search the number to jump to one):

```
 1-10  CORE     utilities, exact decimals, localStorage, request accounting, RPC pool, config loader,
                address labels, results store, cross-tab coordination, scheduler
11-15  CHAINS   EVM ABI codec, EVM adapter (multicall batching, merged logs), Solana, Stellar, XRPL
16-22  MODULES  base class, 17 monitoring.supply, 17b monitoring.supplyHistory, 18 monitoring.mintburn,
                19-21 Morpho maths / discovery / module (one reader per chain), 22 Uniswap (v2 / v3 / v4),
                22c Aggregators, 22b Coinwatch (data service, not a scheduled module)
23-24  UI       formatting, icons, logos, tooltip; shell, pages, charts, dialogs
25     MAIN     createApp(), parseRoute(), boot()
```

The ABI codec is hand-written (static types only); selectors and event topics are precomputed in section 11.

## 3. Interface

- **Layout.** Left sidebar (logo 36 px high, centred; width = the larger of the logo and the longest label; collapsible to an icon rail, remembered per browser; a drawer on mobile). Top bar: breadcrumbs, "Updated Xs ago" with a status dot (green: all sources fresh, amber: late, red: failing; details on hover) and a refresh button. Content up to 1,640 px wide, centred beyond.
- **Themes.** Dark "Graphite" (default) and light "Paper", switched with the sun / moon button at the bottom of the sidebar and kept in the browser (`localStorage["cv-theme"]`, applied before the first paint, kept by "Clear local cache"). Both themes have exactly the same structure. In `index.html`: base rules, then one block of **colour variables per theme** (`html:not([data-theme="light"])` / `html[data-theme="light"]`: `--background`, `--card`, `--card-top`, `--foreground`, `--muted`, `--muted-foreground`, `--subtle-foreground`, `--border`, `--th-bg`, `--tag-bg`, `--seg-on`, `--peg`, `--sidebar`, `--nav-foreground`, palette `--s1..8`...), then **one common structure block** prefixed `html:is([data-theme], :not([data-theme]))` for both. The sidebar follows the theme (dark in Graphite, white in Paper). The brand logo has one file per theme (`logos.brand` / `logos.brandMark` = `{ dark, light }`; a single file also works).
- **Type and colours.** Geist / Geist Mono, tabular figures; SG red `#E9041E`; success `#00884B`, error `#E40014`, warning `#FF700C`; radius 12 px; Lucide icons.
- **No banners.** Each page starts with a line of source pills (chain or API, age); the block / slot / ledger number and the endpoints are in the pill's tooltip. A value that cannot be read gets a red dot with the reason on hover. Every warning is listed in **Diagnostics** (gauge icon at the bottom of the sidebar; a red badge means something needs attention), with the request counters per endpoint / module / method, the version, the Coinwatch cache and the configuration errors.
- **Settings** (sliders icon at the bottom of the sidebar): a user can paste their own endpoints per chain (kept in that browser only, replacing the config for that chain); "Clear local cache" resets cached results, histories and learned endpoint limits.
- **Charts.** History charts (supply, vault deposits): one SG-red line with a fading fill, no axis; hover = crosshair, dot and tooltip. Supply charts are compact at rest (smoothed, 56 % of the card) and unfold to the full daily curve when the pointer enters them. Multi-line charts use the categorical palette `--s1..8` (SG red, aqua, blue, orange, violet, yellow, magenta, green), colour following the entity.
- **Segmented buttons** (token switch, chain filters, periods) and **filter menus** (Coinwatch Trading pairs, Aggregators trades) share one look: menus open as a card with logos, the number of rows each choice gives (choices giving none are disabled) and a check on the current one; Esc or a click outside closes them.

## 4. Configuration (`config.js`)

### 4.1 Chains and endpoints - `chains`

| Chain | Endpoints | Notes |
|---|---|---|
| Ethereum | NOWNodes (calls + logs, ranges up to 3M blocks: the only one used for the Uniswap LP history), Pocket, BlockMachine (logs of the last ~10,000 blocks: `logDepth: 9500`), SwiftNodes; Nodies, Nodies POKT (logs up to 50 blocks); bloXroute x4, Stakely, BlockPI (calls only) | No endpoint with an API key. Not used: Alchemy demo / RPCFast (keys), Fullsend (no CORS), Tatum, Flashbots Protect, MeowRPC, PublicNode and dRPC (blocked by the corporate proxy) |
| Base | Base PublicNode, Pocket | `enabled: false` until a token is deployed there (§4.4) |
| Solana | Solana Vibe Station, Solana Tracker | Uniblock has no CORS; the Solana Foundation endpoints are blocked by the proxy |
| Stellar | SDF Horizon | Stellar Expert refuses cross-origin requests |
| XRPL | xrplcluster.com, xrpl.link | `s1/s2.ripple.com` send no CORS header |

Endpoint fields: `id`, `url`, `maxRps` (token bucket), `weight` (share of the load), and for EVM `capabilities` (`calls`, `logs`), `maxMulticallSize`, `maxLogRange`, `logDepth` (how far back logs are served; omit = unlimited), `maxBatch` (requests per JSON-RPC batch, used by the Aggregators section; 0 = none, default 20). The pool learns tighter limits at runtime ("range too large" -> smaller `maxLogRange`, "archive required" -> smaller `logDepth`, refused batch -> smaller `maxBatch`). EVM chains also take `chainId`, `explorer`, `multicall3`, `confirmations` (calls at head - n) and `logConfirmations` (logs stop at head - n).

**Private keys and GitHub secrets.** Repository secrets reach GitHub Actions, never the page at runtime; a key injected into `config.js` at deploy time would be readable by anyone who opens the site. If a private RPC is ever needed: a key restricted by origin at the provider with a spend cap, or each user pasting their own endpoint in Settings.

### 4.2 RPC tester - `rpc-tester.html`

Open it on the PC that uses the dashboard (same corporate proxy, same browser CORS rules). Per chain (Ethereum, Base, Solana, Stellar, XRPL) the list starts with the endpoints of `config.js`, then known public candidates; edit it freely. "Test" checks each URL:

| Chain | Checks | Output fields |
|---|---|---|
| EVM | chain id, latency (p50 of 3), `eth_call` through Multicall3 with 1 / 50 / 150 / 300 / 500 sub-calls, `eth_getLogs` returning logs, largest accepted range (50 ... 3M blocks), old logs (2M / 500k / 100k / 10k blocks back), rate | `id, url, maxRps, weight, capabilities, maxMulticallSize, maxLogRange, logDepth` |
| Solana | `getSlot` x3, `getMultipleAccounts` on the CoinVertible mints, rate | `id, url, maxRps, weight` |
| Stellar | Horizon root x3, `/assets`, quota header | `id, url, maxRps, weight` |
| XRPL | `server_info` x3, `gateway_balances` on the issuer, rate | `id, url, maxRps, weight` |

`maxRps` is capped at 2 (the corporate IP is shared). The output gives each chain's `endpoints` block, best first, rejected URLs as comments with the reason.

### 4.3 Frequencies - `frequency`

```js
chains:   { ethereum: 12, base: 12, solana: 10, stellar: 20, xrpl: 20 },   // seconds, one tick per chain
apis:     { geckoterminal: 60, defillama: 3600, forge: 3600 },
modules:  { "morpho.vaults": { ethereum: null }, "uniswap.aggregators": { ethereum: 60 }, ... }  // null or absent = the chain's interval
cacheTtl: { "morpho.discovery": 21600, "morpho.structure": 900, "token.roles": 86400, "defillama.supply": 21600,
            "morpho.history": 21600, "aggregators.registry": 21600 },
behaviour: { pauseWhenHidden: true, skipIfSameBlock: true, shareAcrossTabs: true, staleAfterIntervals: 3 },
options:  { supplyOnlyOnMintBurn: false },
```

Module intervals are rounded up to a multiple of the chain interval, so that everything due on a tick shares one block and one multicall. `supplyOnlyOnMintBurn: true` re-reads Ethereum `totalSupply()` only after a mint / burn (and every 5 min).

### 4.4 Tokens - `tokens`

One entry per token with `name`, `currency`, `defillamaId` (supply history) and `deployments` per chain: EVM `{ address, decimals }`, Solana `{ mint, decimals, program }`, Stellar `{ code, issuer, decimals }`, XRPL `{ currency, issuer }`. **A deployment with an empty address (`base: { address: "" }`) is a placeholder**: ignored until it is filled.

**Turning Base on**: put the token address in `tokens.<sym>.deployments.base`, then `chains.base.enabled: true`. Monitoring adds the Base supply, and Morpho starts reading Base (§7). Nothing else to change.

`tokens.USDCV.cantonFromForgeApi` (temporary Canton method, §6b): `{ url, field, decimals }`; `url: ""` removes the Canton row.

### 4.5 Morpho - `morpho`

```js
asset: "EURCV",
chains: { ethereum: { morphoBlue, appUrl }, base: { morphoBlue, appUrl } },   // where Morpho is read
mainVault: null,                                                            // or a vault address
vaults:  [{ chain: "ethereum", address, label, whitelist: true, incentives: true }, ...],
markets: [{ chain: "ethereum", id: "0x...32 bytes", whitelist: true }, ...],
```

A chain of `morpho.chains` is read when it is enabled and the asset is deployed on it (`config.morpho.active` after loading). `chain` of a vault / market defaults to the first chain. Whitelisted vaults and markets are always read; everything else discovered by the Morpho API goes under "Show more". `incentives: true` (Vault V2) reads the donation buffer and its runway. Two `cbBTC/EURCV 86 %` markets exist (different oracles), as well as two WBTC and two wstETH ones: market ids, not names, identify them.

### 4.6 Uniswap - `uniswap`

Whitelisted pools on Ethereum (today three v3: EURCV/EURC 0.01 %, EURCV/USDC 0.05 %, USDCV/USDC 0.01 %), each with `slug` (page address), `version` (`v2`, `v3` default, `v4`), `address` (v2 pair / v3 pool) or `id` (v4 pool id), `createdBlock` (start of the LP history), v2 `fee`, v4 optional `poolKey`. Token addresses, fee, tick spacing, symbols and decimals are read on-chain once.

| Key | Meaning |
|---|---|
| `oracles` | Chainlink feeds. EUR/USD: SVR feed first, classic feed when the SVR answer is missing, older than `maxAgeSec` or more than `maxDeviation` away. USDC/USD: one feed |
| `usdValue` | USD value per token: EURC and EURCV at EUR/USD (1 EURC = 1 EUR), USDC at USDC/USD, USDCV at 1 |
| `peg` | Peg target in USD: EURCV = EUR/USD, USDCV = 1 |
| `pegThresholdsBps` | Badge colour: green below 10 bps, amber 10-50, red above 50 |
| `depthBps`, `impactSizes` | Bands of the depth table; sale sizes of the impact table |
| `npm`, `tickLens`, `v4` | NonfungiblePositionManager, TickLens, v4 PoolManager / StateView / PositionManager |

### 4.7 Aggregators - `aggregators`

| Key | Meaning |
|---|---|
| `chain`, `token` | `ethereum`, `EURCV` |
| `historyDays` | history read on-chain and kept, in days (default 7, 1 to 30). Periods: 24h, 7d, and the whole history when it is another length |
| `receiptBatch` | receipts per JSON-RPC batch (40), capped by each endpoint's `maxBatch` |
| `backfillPauseMs` | beyond 7 days: pause between two days of history |
| `tradesShown` | rows of "Latest trades" (50) |
| `list[]` | `{ id, label, layer, contracts[], registry? }`; `layer` 1 = intents / solvers (UniswapX, CoW), 2 = routers (0x, Velora, 1inch, KyberSwap), 3 = RFQ liquidity (Bebop); `registry` (0x): the Deployer whose `ownerOf(feature)` / `prev(feature)` give the Settlers, read every `cacheTtl["aggregators.registry"]` |
| `walletContracts` | ERC-4337 EntryPoints: a tx sent there is the trader's own smart account |

Logos `logos.aggregators.<id>` (UniswapX uses `uniswap.svg`); colours = palette `--s1..8` in list order.

### 4.8 Coinwatch - `coinwatch`

| Key | Meaning |
|---|---|
| `url`, `apiKey` | API base; key `cw_...` (`""` = each user types theirs once, kept in their browser) |
| `maxRps`, `cacheTtlSec` | 1.8 requests/s; answers cached 6 h in the browser |
| `depthBps` | depth band (+/-100 bps) |
| `tokens` | company slug (and dashboard slug) per token: `eurcv`, `usdcv` |
| `fallbacks` | other slugs to try when the first is refused (`[]` = none, no check request) |
| `ourMarketMakers` | names counted as "ours" (`[]` = the market makers of the markets list, or all of them when the list is empty) |
| `ignoreLabels` | dataset labels that are not a venue / market maker ("Remaining", "Other", "Total"...), matched on their first words |
| `spreadUnit`, `volume24h` | `"percent"` / `"ratio"` / `"bps"`; `"last"` (last point of the 24 h chart) or `"auto"` |
| `volumeBarsDays` | daily bars in the Volume card (15) |
| `pairsTab` | Trading pairs tab: `"public"` (everyone), `"private"` (once a key is entered), `"hidden"` |
| `markets` | the markets list per token: exchange -> pair -> market makers (`[]` = none) |

### 4.9 Logos - `logos`

`favicon`, `brand` and `brandMark` (`{ dark, light }` or one file), `tokens`, `chains`, `nav` (sidebar icons), `marketMakers`, `exchanges`, `aggregators`. Coinwatch names are matched to the keys as whole words, the earliest match first ("Uniswap v3 - Ethereum" gets the Uniswap logo).

### 4.10 Labels - `known_addresses.json`

```json
{ "ethereum": { "0xabc...": { "label": "Treasury", "type": "sgforge" } }, "solana": {}, "stellar": {}, "xrpl": {} }
```

EVM addresses are matched case-insensitively. Priority: this file > on-chain roles > Morpho vault names. Roles are read from the SmartCoin contracts: Registrar, Operations, Technical, and the redemption addresses seen in `RedemptionStarted`.

## 5. How a refresh works

```
Router -> visible page -> its modules -> Scheduler (one loop per chain / API)
                                            | tick: EVM -> 1 eth_blockNumber, block pinned
                                            v
                         Chain adapter: Multicall3 batches (all modules of the tick merged,
                         de-duplicated, same block) + merged eth_getLogs
                                            v
                         RpcPool: token bucket per endpoint, weighted round-robin, failover,
                         cooldown 5 s -> 5 min, Retry-After / RateLimit headers, learned limits, stats
                                            v
                         Store (+ localStorage cache) -> UI, and other tabs via BroadcastChannel
```

- **Only the visible page polls**, on the chains its modules use.
- **One tab polls per page**: the leader holds a Web Lock; other tabs on the same page receive the results.
- **Hidden tab = no request** (`pauseWhenHidden`).
- **Same block = skip**: a module whose chain head has not moved since its last run is skipped.
- **"Show more" is read only while open** (in any tab: open sections send a heartbeat to the leader).
- **Cached on reload**: last results (shown as "cached" until refreshed), mint / burn events and cursor, Morpho discovery / structure / market params per chain, block timestamps, token roles, incentive buffer samples, Uniswap LP history, aggregator trades, Coinwatch answers, Morpho deposits histories.
- `render()` rebuilds the page from the store on every change and every 5 s; it leaves the DOM untouched when the HTML is the same (open menus and typed text stay).

## 6. Monitoring

**Supply** = issued supply, everything counted:

| Chain | Method |
|---|---|
| Ethereum, Base | `totalSupply()` in Multicall3 (decimals checked once) |
| Solana | `getMultipleAccounts([mints], jsonParsed)` -> `supply` (one call, Token-2022) |
| Stellar | Horizon `GET /assets?asset_issuer=` -> sum of `authorized`, `authorized_to_maintain_liabilities`, `unauthorized`, `claimable_balances_amount`, `liquidity_pools_amount`, `contracts_amount` (a classic asset has no supply on-ledger: only an indexer can sum it) |
| XRPL | `gateway_balances` on the issuer, validated ledger -> `obligations` |

A total missing a chain is flagged partial (red dot next to it). Per token: the total, its daily history (DefiLlama `GET /stablecoin/{254, 307}`, issued = `circulating + unreleased`, refreshed every 6 h), then one row per chain with its share.

### 6b. Canton (USDCV, temporary)

Canton has no public RPC. Its supply = **the total supply published by SG-Forge - every chain read on-chain** (Ethereum, Solana, Base when enabled), never below 0 (a negative difference is shown as 0 and explained). The total is read from `cantonFromForgeApi.url`: CoinGecko `GET /api/v3/coins/usd-coinvertible`, `market_data.circulating_supply` (CoinGecko's figure comes from the Forge API, which itself sends no CORS header). Polled every hour (`frequency.apis.forge`), stale after 3 days. The row has the Canton logo and an orange dot: its tooltip says the source is updated once a day, the fetch age and the published total. The pill is labelled "Forge API". `url: ""` removes the row.

### 6c. Mints and burns (Ethereum)

The 15 most recent across EURCV and USDCV (8 rows visible, scrollable).
- Mint = `Transfer(0x0 -> recipient)`; burn = `Transfer(registrar -> 0x0)`.
- The holder's tokens reach the registrar before the burn: EURCV emits `RedemptionStarted(holder -> redemption address)` then `Transfer(holder -> registrar)`; USDCV only the transfer.
- **Attribution of a burn**: the latest unmatched `RedemptionStarted` with the same token and amount before it; otherwise the latest unmatched transfer to that token's registrar with the same amount; otherwise the registrar. The note next to the address says which.
- First load scans back in 10,000-block windows until 15 events are found and matched; then one `eth_getLogs` per new block over `(cursor, head - 2]`, `topic0` in {Transfer, RedemptionStarted}. Timestamps from `blockTimestamp` in the logs, else `eth_getBlockByNumber` (cached).

## 7. Morpho (EURCV)

**Chains.** One reader per chain of `morpho.chains` that is enabled and has the asset (Ethereum today; Base starts by itself once EURCV is deployed there and the chain enabled). Each reader has its own discovery, caches and outputs; the page merges them. Keys are `chain:address` (vaults) and `chain:id` (markets). Every vault and market row starts with its chain logo; the Main Vault card shows the chain under the vault name.

**Chain filter.** With two chains or more, buttons next to the "Vaults" and "Markets" titles (All + one per chain) filter each section, kept per browser. The **Main Vault** is the whitelisted vault with the largest deposits of the chain selected (All = every chain), or `morpho.mainVault` when it is on that chain. **Total supplied / borrowed** sum the markets of the chain selected.

**Discovery** (Morpho API, cached 6 h per chain): vaults V1 and V2 whose asset is EURCV, markets whose loan asset is EURCV, names, curator and collateral logos. Never used for numbers. If the API is down, the cached list or the whitelist is used.

**Per tick** (per chain): phase A, one coalesced multicall (`market(id)`, vault state, positions, adapter `realAssets`, structure lengths); phase B, `IRM.borrowRateView(params, market)` per market. Structure (V1 withdraw queues, V2 adapters and their market ids, recursively through V1 vault adapters) is cached 15 min and reloaded as soon as a length read on-chain changes.

**Markets** (idle markets excluded): borrow APY = `exp(borrowRate x year) - 1`; utilization after interest accrual to the block time; bands `[0,90[` yellow, `[90,91]` green, `]91,98[` orange, `[98,100]` red. Totals: whitelisted markets, plus the others while "Show more" is open (the (i) tooltip says which).

**Vaults.**
- V1 (MetaMorpho): positions `MorphoBlue.position(id, vault)`; idle = the vault's own EURCV + its supply in the idle market; APY = sum(assets x supplyRate) / assets x (1 - fee).
- V2: adapters detected on-chain (`MorphoMarketV1AdapterV2`, `MorphoMarketV1Adapter`, `MorphoVaultV1Adapter`); idle = the vault's own EURCV + idle-market allocation. Net APY after performance and management fees; while a donation buffer exists the vault grows at `maxRate`.
- **Incentives** (`incentives: true`): buffer = `realAssets - totalAssets`; burn/s = `totalAssets x maxRate - organic yield`; runway = buffer / burn, shown as `amount - runway` with burn/day and depletion date. An observed burn from buffer samples is compared with it (warning beyond 20 %).
- **Net APY column**, fees in grey underneath when the vault has any (read on-chain). Hover, all before fees so that native + incentives = gross: gross APY when the vault has fees; native always (one line "Native = gross APY" when equal); incentives = gross - native whenever native < gross; cap (maxRate) only for `incentives: true` vaults with a cap <= 15 %, marked "reached" when the vault grows at the cap.
- **Main Vault card** (1.5x): deposits, Net APY, idle, incentives, and the daily deposits history (Morpho API `historicalState.totalAssets`, interval DAY, cached 6 h, per `chain:address`). **Every other vault row unfolds** into the same card (one at a time, Close or Esc; the page scrolls so the card is visible).
- **"Show more"**: opening it reads the other vaults / markets at the next block; until they arrive, the footer says "Fetching N more vaults..." with a small spinner and a moving line (a click still closes it).

## 8. Uniswap

**Every block, one multicall** for the pools (`balanceOf` x2, `slot0`, `liquidity`, TickLens words of initialized ticks) and the Chainlink feeds.

- **Price** from `sqrtPriceX96`. **Peg deviation** = price x USD value of the other token / peg target - 1 (EURCV/EURC: price - 1; EURCV/USDC: price x USDC/USD / EUR/USD - 1; USDCV/USDC: price x USDC/USD - 1).
- **TVL** = pool balances x `usdValue` (Chainlink, not CoinGecko). **Volume 24 h**: GeckoTerminal (`/networks/eth/pools/multi/{pools}`, USD, every 60 s; its free tier is ~30 calls/min per IP).
- **Depth** (amount to move the price by 10 / 50 / 100 bps) and **sale impact** (exact-input sale of 100k / 500k / 1M, fee included; "Exceeds the pool (max ~X)" beyond) are computed locally by walking the initialized ticks, identical to Uniswap's QuoterV2 / v2 Router / V4Quoter at the same block (0.000 ppm). Quoters are not called (one call per size, and they fail when a sale drains the pool).
- **Tick map check**: ticks must sum to zero and give `liquidity()` at the current tick; otherwise more words are read and values are flagged approximate.
- **Liquidity chart** (pool page): bars per price bucket (CoinVertible in SG red, other token grey), current price and peg lines (2 px dashed over a halo in the card colour); wheel to zoom around the pointer, drag to pan, double-click or reset button; hover gives the range and quantities.
- **LP positions** (every 60 s): the pools' whole `Mint` / `Burn` history in one `eth_getLogs` at the first visit (needs an endpoint serving ~3M-block ranges: NOWNodes), kept in the browser, then new blocks only. Direct positions are netted per (owner, range); position-manager liquidity is resolved to NFT ids from the minting receipts, then `positions(id)` / `ownerOf(id)`. Without such an endpoint: "History unavailable", retried every 5 min.
- **Versions**: v2 (one full-range position of liquidity sqrt(r0 x r1); LP history from the pair's LP token transfers), v3, v4 (StateView `getSlot0`, `getLiquidity`, `getTickBitmap`, `getTickLiquidity`; balances computed from the liquidity; LP fee + protocol fee per direction; dynamic-fee and hooked pools flagged approximate; LP history from `ModifyLiquidity`). One code path for all.
- **Navigation**: `#/defi/uniswap/<slug>` is a sub-page; switching pool only re-renders from data already loaded.

## 8b. Coinwatch (CoinVertible/Coinwatch)

Coinwatch public API (`https://coinwatch.co/api/v1`, Bearer key `cw_...`, CORS open, `RateLimit-*` headers exposed). The data is confidential: a note at the bottom of the page says so.

**Key.** `coinwatch.apiKey`, or each user types theirs once (kept in `localStorage["cv-coinwatch-key"]`, not removed by "Clear local cache"; "Forget the API key" at the bottom of the page). The key page links to `https://coinwatch.co/settings/api_keys`. A refused key (401) brings the form back with Coinwatch's message.

**Token pages** (`/eurcv`, `/usdcv`). Four KPIs: **Volume 24h** (with daily bars, `volumeBarsDays`), **Depth +/-100 bps** (bar = share provided by our market makers), **Average spread 24h** (volume-weighted, with how it is computed), **Active market makers** (names and logos). Then two tabs:
- **Market makers**: one group per market maker (logo, number of exchanges, total volume, volume-weighted spread, total depth), then one row per exchange (volume 24 h, average spread 24 h, share of venue depth). A row unfolds into depth over 30 days, spread by pair over 30 days and the pairs (volume, share of the pair's volume on the venue, spread).
- **Exchanges**: per venue volume, spread, depth, "our market makers" (share of the venue's volume); chart "Depth +/-100 bps by venue (30d)" (8 lines max, the smallest summed as "Other").

| Element | Coinwatch chart (`/companies/{company}/charts/{category}`) |
|---|---|
| Volume 24h / bars | `total-volume` 24h and 30d, `denomination=baseAsset` |
| Average spread | `volume-weighted-bid-ask-spread-ratio` 24h |
| Depth, venue depth | `depth-by-exchange` 24h (30d for the chart), `basis_points_from_mid=100` |
| Venues, venue volume | `volume-by-exchange` 24h (names -> slugs with `GET /exchanges`) |
| Venue spread | `bid-ask-spread-ratio-by-exchange` 24h (Exchanges tab) |
| Market makers per venue | `market-maker-volume-for-exchange`, `market-maker-depth-for-exchange`, `market-maker-bid-ask-spread-ratio-for-exchange` (names -> slugs with `GET /market_makers`) |
| Unfolded row | `market-maker-depth-for-market-maker-and-exchange` 30d, `market-maker-bid-ask-spread-ratio-for-market-maker-and-exchange-by-asset-pair` 30d and 24h, `market-maker-volume-for-market-maker-and-exchange-by-asset-pair` 24h, `volume-for-exchange-by-asset-pair` 24h |

**Sources and merge.** Coinwatch is the first source of the token pages; the markets list (`coinwatch.markets`) completes what Coinwatch does not give, marked "not in list" (reported by Coinwatch, absent from the list) or "no Coinwatch data" (in the list only). Per-venue market maker charts are asked only for venues Coinwatch reports, and not for a venue the list gives with no market maker on any pair (`[]`, e.g. a DEX: Coinwatch answers 404 there; the Exchanges tab shows "none listed"). Names are matched as whole words, case and punctuation ignored ("Bitstamp" = "Bitstamp by Robinhood", "EURCV/EUR" = "EURCV-EUR").

**"Remaining ..." datasets** (per-venue market maker charts) are what the listed market makers do not provide: never a market maker, they complete the venue totals (shares = market maker / (market makers + remaining)).

**Parsing.** Answers are time series (`datasets[{label, data[{timestamp, value}]}]`). Volume 24h = last point (`volume24h: "last"`) or the sum of intraday buckets (`"auto"`); spreads and depths = average of the last 24 h; spreads in `spreadUnit` (a Diagnostics warning appears when they look too large). Diagnostics lists every cached answer with its datasets, points, step and value range.

**Trading pairs** (`/pairs`, third item of the token switch). **Built from the markets list only** (no Coinwatch request): every pair of every token, grouped by exchange (logo, number of pairs), each pair with our token logos and its market makers (chips with logos, "None" for `[]`). A pair's tokens come from its name ("EURCV/USDCV" counts for both); a pair listed under two tokens is shown once. Filters: Exchange, Market maker, Token (EURCV, USDCV, and "EURCV / USDCV pairs" only when such a pair exists), kept per browser, with "Clear filters". Visibility `pairsTab`: public (even without a key), private (once a key is entered), hidden; a tab not available opens the first token.

**Requests.** Only what is on screen: the KPIs and the open tab; the 5 charts of a row only when it is unfolded. Answers are cached 6 h (`cacheTtlSec`) and shown at once on the next visit; the refresh button re-fetches. Measured on a mock with 4 venues: first token view ~29 requests, unfolded row +5, Exchanges tab +2, reload 0. Pace 1.8/s (the key allows 120/min); the pool pauses when `RateLimit-Remaining` runs low.

**Company slug.** `coinwatch.tokens` (`eurcv`, `usdcv`, no dashboard slug). With a single candidate no check request is made; with `fallbacks`, the first candidate that answers a cheap chart is remembered, and dropped as soon as it is no longer configured.

## 8c. Aggregators (DeFi/Uniswap)

**Question answered:** how much EURCV goes through DEX aggregators (Bebop, 0x, UniswapX, CoW Protocol, Velora, 1inch, KyberSwap), which ones, how they route to each other, and how much ends in our Uniswap pools. On-chain only, no API.

**Reading.** Every EURCV `Transfer` on Ethereum (~900 a day, ~330 transactions), then the receipt of each transaction (`eth_getTransactionReceipt` in JSON-RPC batches of up to 40, `RpcPool.jsonRpcBatch()`). Only trades are kept in the browser (`aggregators:v1:ethereum`, format `v: 2`). History `historyDays` (7), newest day first (~60 s, ~2,300 receipts), then new blocks every minute (one `eth_getLogs` + about one batch). A background worker does it, with its own log contexts: the per-block pool refresh never waits. A refused log range is split down to ~900 blocks; a failed day is retried after 5 s, then every minute. Only the leader tab reads. 0x Settlers come from the 0x Deployer (`ownerOf` / `prev`, features 2-5) every 6 h, accumulated; counter-token symbols via `symbol()`.

**Two venues, never added.** EURCV is bought and sold in two places: our Uniswap pools and RFQ market makers. Each trade's EURCV is split into legs, one per venue:
- **Our pools** (whitelisted pools, v4 by pool id): already in the pools' volume (GeckoTerminal KPI): shown apart, in grey, never added. A trade through two pools counts in both, like the pools' own volume.
- **RFQ**: a counterparty that exchanged EURCV against another token outside any pool (market makers behind Bebop / 0x, solvers' inventory, 1inch limit orders). Not a venue: the trader, aggregator contracts, wallet infrastructure, plain destinations that give nothing back (Morpho Blue receiving a vault deposit).
- Other pools (non-whitelisted Uniswap, Curve, Balancer): shown only if any.

**Which aggregator.** An aggregator takes part only if it **handled the EURCV** of the transaction: tx sent to one of its contracts; one of its contracts sends / receives EURCV; one of its events names EURCV (CoW `Trade`, Kyber `Swapped`) or is the swapper's (UniswapX `Fill`); or one of its events comes right after an EURCV transfer with no other aggregator log in between (RFQ fills). A CoW batch where Bebop filled another pair is therefore not Bebop's. **Entry** = the aggregator the tx was sent to, else the involved one of the lowest layer; **sources** = the others; "Other contracts" = sent by an untracked contract (never for intents).

**Trader and side.** Taker = UniswapX swapper, ERC-4337 account, tx sender or the wallet it called; CoW: the EURCV legs of its `Trade` events. Side: **Buy**, **Sell**, **Buy + sell** (CoW batch with both), **Pivot** (the trader swapped two other tokens and EURCV was only an intermediate hop, e.g. USDC -> EURCV -> EURC; the pair actually swapped is shown, "EURCV as pivot"), or none (trader not identified, e.g. gasless RFQ order).

**One owner per EURCV.** Each leg has one **executor**: RFQ leg -> the aggregator whose event follows the maker's transfer, else the RFQ aggregator of the tx, else the contract trading with the maker (0x Settler); pool leg -> the aggregator whose contract trades with the pool, else the deepest router of the tx; none -> "Other contracts". The leg counts there only. On every update the cards are checked to sum to the total per venue family (to 1 EURCV); otherwise an orange dot next to the title and a Diagnostics warning.

**Display.**
- Period switch 24h / 7d (and the whole history when `historyDays` is another length); "history x / 7 days" while loading.
- Cards: **All aggregators** (RFQ | Our pools, split "Executed by"), then one card per aggregator with what it **executed**: RFQ | Our pools, split bar, **Origin** (Direct / Via X / Other contracts), grey lines "-> X: 488K RFQ" for what it passed on (counted in X), foot "EURCV as pivot" % and the top 2 counter tokens.
- **Daily volume**: RFQ or Our pools (never stacked together), coloured by **Executed by** (default) or **Brought by**; days not loaded in grey.
- **Latest trades** (50): date, route (entry -> sources), side, amount, pair, **Executed on** (each leg: venue, amount, executor), tx; filter menus Aggregator and Executed on (RFQ / Our pools / Pivot trades).
- Tooltips of one or two short lines.

**Limits.** Contracts are configured (a new router or deployment must be added to `aggregators.list`); a 0x Settler retired before the first visit is unknown; gasless Bebop orders have no visible taker.

## 9. Request rates (one visible tab)

| Page | Calls / hour | Detail |
|---|---|---|
| Monitoring | ~1,350 | Ethereum ~630 (`eth_blockNumber`, `eth_call`, `eth_getLogs` per block), Solana 360, Stellar 180, XRPL 180; DefiLlama 2 GET / 6 h; Forge total 1 GET / h |
| Morpho | ~810 per chain | `eth_blockNumber` + 2 multicalls per new block; Morpho API: discovery every 6 h per chain, deposits history per vault shown every 6 h |
| Uniswap | ~880 + aggregators | one multicall per block (pools, ticks, oracles; NFT positions once a minute), `eth_getLogs` every minute, GeckoTerminal every minute; first visit: 1 large `eth_getLogs` + a few receipts. Aggregators: ~160 / h (first visit with 7 days: ~60 s, ~2,300 receipts in ~70 batches) |
| Coinwatch | no RPC | Coinwatch API only for what is shown, cached 6 h (§8b) |

Hidden tabs and extra tabs on the same page cost nothing. Diagnostics and `window.cvStats` give live counts per endpoint, module and method.

## 10. Result envelope

```json
{ "module": "monitoring.supply", "schema": 1, "updatedAt": 1792061998844, "status": "ok|partial|error|pending",
  "sources": { "ethereum": { "block": 26197473, "blockTime": 1792061987, "endpoint": "nownodes, pocket", "status": "ok", "okAt": 1792061998844 } },
  "warnings": [], "data": { } }
```

A source is `stale` when older than `staleAfterIntervals x interval` (or its own `staleAfterSec`); the last good value is kept and flagged. Amounts are decimal strings computed from integers (BigInt). Morpho `data`: `{ asset, chains, main{all, <chain>}, overviewBy, overviewAllBy, countsBy, vaults[], markets[] }` (each vault / market with `chain` and `key`).

## 11. Extending

- **New EVM chain**: add it to `chains` and `frequency.chains`, its deployments to `tokens`; for Morpho, an entry in `morpho.chains` and the vaults / markets with `chain`. Supply and Morpho follow without code change; mint / burn, Uniswap and aggregators stay on Ethereum.
- **New chain type**: an adapter class next to the others (sections 12-15), registered in `ADAPTERS` (section 25), handled in `monitoring.supply` (section 17).
- **New module**: a class extending `Module` (section 16) with `{ id, page, chains, schedules }` and `run(chain, ctx, dueIds)`, its intervals in `frequency.modules`, registered in `createApp()`. `ctx.call()` / `ctx.logs()` are batched with the other modules of the tick.

## 12. Reference addresses (Ethereum)

| What | Address |
|---|---|
| EURCV (proxy) | `0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2` |
| USDCV (proxy) | `0x5422374B27757da72d5265cC745ea906E0446634` |
| SmartCoin implementation (both) | `0xf4ccc80c4b831a0d8d1414f2aca82a3d760ff05b` |
| Registrar (both tokens) | `0x7de0bbdfcd4a6a956f149befcca30d6b5bc5da69` |
| Multicall3 (also Base) | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| Morpho Blue (also Base) | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| AdaptiveCurveIrm | `0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC` |
| Uniswap NonfungiblePositionManager / TickLens | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` / `0xbfd8137f7d1516D3ea5cA83523914859ec47F573` |
| Uniswap v4 PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` |
| Chainlink EUR/USD SVR / classic | `0xB34864138863eD5fB6fC8324e92d10fDa58b9902` / `0xb49f677943BC038e9857d61E7d053CaA2C1734C1` |
| Chainlink USDC/USD | `0x37be050e75C7F0a80F0E8abBFC2c4Ff826728cAa` |
| Bebop PMM settlement / JAM / JAM v2 | `0xbbbbbBB520d69a9775E85b458C58c648259FAD5F` / `0xbEbEbEb035351f58602E0C1C8B59ECBfF5d5f47b` / `0xbeb0b0623f66bE8cE162EbDfA2ec543A522F4ea6` |
| 0x AllowanceHolder / Deployer (Settler registry) | `0x0000000000001fF3684f28c67538d4D072C22734` / `0x00000000000004533Fe15556B1E086BB1A72cEae` |
| UniswapX reactors | `0x00000011F84B9aa48e5f8aA8B9897600006289Be` / `0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4` |
| CoW GPv2Settlement / FlashLoanRouter | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` / `0x9da8B48441583a2b93e2eF8213aaD0EC0b392C69` |
| Velora Augustus v6.2 / Delta v2 | `0x6A000F20005980200259B80c5102003040001068` / `0x0000000000bbF5c5Fd284e657F01Bd000933C96D` |
| 1inch router v6 / KyberSwap MetaAggregationRouterV2 | `0x111111125421cA6dc452d289314280a0f8842a65` / `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` |

## 13. Known limits

- The Uniswap LP history needs an endpoint serving ~3M-block log ranges (NOWNodes); without it the LP table shows "History unavailable".
- Canton is derived from a daily figure (orange dot); the difference can lag the chains by up to a day.
- Coinwatch per-venue market maker charts answer 404 for venues without market makers (DEX) until the markets list says so with `[]`.
- Aggregators: contracts are configured, not discovered.
