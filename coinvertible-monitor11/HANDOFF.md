# CoinVertible Dashboard - handoff (version v11)

Everything a new conversation needs to continue this project without the history. **Read it fully before changing anything.** `README.md` is the technical reference of the code (what it does, how, configuration); this file holds the **working rules, the design rules, the user's decisions and the state of the project**.

---

## 0. Start here (new conversation)

1. The user gives the current files: `index.html`, `app.js`, `config.js`, `known_addresses.json`, `rpc-tester.html`, `tests.mjs`, `tests-aggregators.mjs`, `README.md`, `HANDOFF.md`. Read this file, then `README.md`, then the parts of `app.js` you will touch (search the section numbers, §5).
2. Check the files are sound before changing them: `node --check app.js && node --check config.js`, `node tests.mjs`, `node tests-aggregators.mjs`, and `grep -cP '[^\x00-\x7F]'` = 0 on the code files.
3. Version: the current version is **v11**; the next delivery is **v12** (`VERSION` in `app.js`, first lines of README and of this file). The user decides the numbering: if he says a delivery is version X, use X.
4. Answer in French; the UI stays in English.
5. Deliver complete files (never diffs), screenshots, and a short French message: what changed, what he must do (logos to add, config to fill), what is pending.

## 1. The project in one paragraph

An English-language dashboard on SG-Forge's CoinVertible stablecoins **EURCV** and **USDCV**, a static site on **GitHub Enterprise Pages**. Pages: `CoinVertible/Monitoring` (supply per chain + daily history, Canton temporary row, mint / burn), `CoinVertible/Coinwatch` (Coinwatch market data per token; Trading pairs from the config), `DeFi/Morpho` (EURCV vaults and markets, multi-chain), `DeFi/Uniswap` (whitelisted pools, one sub-page per pool, and the "Aggregators" section). Everything is read from the browser: on-chain through public RPCs first, a few public APIs only where agreed (Morpho API for lists / logos / histories, DefiLlama for the supply history, GeckoTerminal for volumes, CoinGecko for the Canton total, Coinwatch with a personal key).

## 2. Hard constraints (never break these)

| Constraint | Consequence |
|---|---|
| Browser only, static hosting: **no server, no build step, no collector, no dependency** | One ES module `app.js`, one classic script `config.js`, inline CSS in `index.html`. No npm package at runtime, no bundler. |
| The user **copy-pastes file contents** from another computer (cannot download) | Minimal file count. **Code files are pure ASCII**: non-ASCII characters in JS / CSS / HTML go as `\uXXXX` escapes (Python string literals turn `…` into a real character: run an escape pass; `grep -cP '[^\x00-\x7F]'` must give 0 on `app.js`, `config.js`, `index.html`, `rpc-tester.html`, `tests.mjs`, `tests-aggregators.mjs`). Always deliver complete files. |
| The user uploads binary files himself | `logos/` and `fonts/`; names in `config.js` -> `logos`. A missing logo shows a monogram; tell him which files to add. |
| Corporate PC behind a proxy | **Only the RPCs listed in `config.js`** (they pass the proxy). **Never an endpoint with an API key.** New endpoints are tested with `rpc-tester.html` on his PC; he gives the result. |
| Public endpoints live in `config.js` | Settings (sliders icon, bottom of the sidebar) let a user override endpoints per chain in his browser only. GitHub secrets cannot protect a client-side key. |
| Minimise requests and rate-limit risk | Any new data source states its request cost (§6). Read only what the visible page shows. |
| Coinwatch data is **confidential** | Personal key, typed per user (or in config, readable by anyone); keep the confidentiality note on the page. The key allows **120 requests/min**. |

## 3. Way of working with the user

- He writes in **French**; answer in French. The **UI is in English**.
- Non-trivial or uncertain: **test first, then ask with the test results, then code** ("Test et poses les questions avec les resultats de tes tests, on avise et ensuite tu code"). When he writes "propose and ask before coding", do exactly that. Clear requests: just do them.
- He reviews **visually**: deliver screenshots (headless Chromium, 1440 px, dark and light, mobile 390 px when the layout changes). Very demanding on design: "very pro", "not AI slop", respect the DA, same look in both themes, keep the data placement unless asked.
- When he attaches a guide (`.md` with rules / patches), follow it exactly; do not redesign what it fixes.
- Keep **README.md purely technical**: it describes the code only, with **no reference to the conversation** (no "confirmed by the user", "asked by", dates of messages). Decisions and their origin go in this file.
- Keep this file and README up to date with every change.

## 4. Design rules (DA = SG-Forge Monitoring)

**Themes.** Dark "Graphite" (default, the reference) and light "Paper": **identical structure, only colours differ**. CSS order in `index.html`: base rules -> colour variables per theme (`html:not([data-theme="light"])`, `html[data-theme="light"]`) -> **one common structure block** prefixed `html:is([data-theme], :not([data-theme]))` (same specificity as the theme blocks) with every size, padding, radius, border, hover rule. A new style: structure in the common block with variables; colours as variables in both theme blocks; never a hard-coded grey. Light-only rules: tooltip, dialog, backdrop, peg badge. Check: same page height in both themes.

Variables: `--background`, `--card`, `--card-top` (card gradient top), `--card-hover(-top)`, `--foreground`, `--muted`, `--muted-foreground`, `--subtle-foreground`, `--border(-strong)`, `--shadow(-lift)`, `--topbar-bg`, `--th-bg`, `--row-hover`, `--more-hover`, `--tag-bg`, `--seg-on(-shadow)`, `--bar-ct(-hover)`, `--bar-hit`, `--peg` (`#3EE6A8` dark / `#047857` light), `--sidebar` (`#111113` dark / `#FFFFFF` light), `--nav-foreground`, palette `--s1..8`. Shared: radius 12 px, SG red `#E9041E`, success `#00884B`, error `#E40014`, warning `#FF700C`.

**Sidebar.** Follows the theme (dark in Graphite, **white in Paper**). Brand logo per theme: `logos.brand = { dark: "logos/forge_white.svg", light: "logos/forge_black.svg" }`, `logos.brandMark = { dark: forge_mark_white.svg, light: forge_mark_black.svg }` (classes `th-dark` / `th-light`). Logo 36 px high, centred; width = the larger of the logo and the longest label; active item with a red inset bar; collapsible rail.

**Components.**
- No banners: red dot + reason on hover, warnings in Diagnostics (gauge icon, red badge).
- Top bar: breadcrumbs, "Updated Xs ago" + status dot + refresh. No red stripe.
- **Source pills** at the top of each page: label + age only; **the block / slot / ledger number is in the tooltip** (with endpoints and errors). No RPC names in the page.
- Section titles with a 3 x 14 px red tick; controls on the right of a title go in `.sec-tools`.
- **Segmented buttons** (`.seg`, radius 10 / 7): token switch, chain filters, periods.
- **Filter menus** in the DA (`ddMenu()`): never a native `<select>` (the user found them ugly). Button "Label  Value", card-like list with logos, counts, disabled empty choices, check on the current one; Esc / outside click closes. Used by Coinwatch Trading pairs and Aggregators trades.
- "Show more": frameless full-width footer in the card; **while fetching, "Fetching N more vaults..." with a small spinner and a moving line** (discreet), click still closes.
- Tables: rows 50 px (tall 62), headers 42 px uppercase 11 px, first / last cell 22 px, tags 20 px; Diagnostics tables 34 px / 12 px.
- Tooltips: short, one or two lines.
- Utilisation bands (Morpho): `[0,90[` yellow, `[90,91]` green, `]91,98[` orange, `[98,100]` red. Peg badge: green < 10 bps, amber 10-50, red > 50.
- History charts: one SG-red 2 px line + fading fill, no axis; supply charts compact (56 %, smoothed) unfolding on hover. `areaChart(id, points, {compact, height, unit, title, label})`, 1000-wide viewBox, no width measurement.
- Multi-line charts: palette `--s1..8` (SG red, aqua, blue, orange, violet, yellow, magenta, green; colour-blind safe in both themes), colour follows the entity.
- Liquidity chart: current / peg lines 2 px, dash `4 3`, over a 6 px halo in the card colour, labels with `paint-order: stroke`.
- Chain logos (`logos.chains`) before every Morpho vault / market (16 px, tooltip = chain name).

## 5. Architecture (details in README)

`app.js` sections: 1-10 CORE (utilities, BigInt decimals, localStorage `cv:v1:` with BigInt-safe JSON, stats, RpcPool, config loader, labels, store, cross-tab, scheduler), 11-15 CHAINS (ABI codec with precomputed `SIG` / `TOPIC`, EVM adapter + TickContext, Solana, Stellar, XRPL), 16-22 MODULES (Module base, 17 supply, 17b supplyHistory, 18 mintburn, 19-21 Morpho maths / discovery / `MorphoChain` + `MorphoModule`, 22 Uniswap, 22c Aggregators, 22b `CoinwatchService`), 23-24 UI, 25 MAIN.

- **RpcPool** per chain / API: token bucket, weighted round-robin, failover with cooldown, RateLimit headers, learned `maxLogRange` / `logDepth` / `maxBatch`, `jsonRpcBatch()`. `finalKinds` option (Coinwatch) to not cool down on auth / not-found.
- **Scheduler**: one loop per chain and per `api:<name>`; only modules of the visible page; per tick one `eth_blockNumber`, then a **TickContext** pinned to the block merges every module's calls into Multicall3 and logs into merged `eth_getLogs`. Leader tab per page (Web Locks), results to other tabs over BroadcastChannel.
- **Module**: `{id, page, chains, schedules}` + `run(chain, ctx, dueIds)`, publishes an envelope to the store (cached, shown at once on reload). Long work must not run inside `run()` (it blocks the chain loop): the aggregators use a background worker.
- **Config loader** (`loadConfig`): validates; **drops placeholder deployments** (empty address); normalises Morpho (`morpho.chains`, `chain` on every vault / market, `morpho.active` = enabled chains with the asset deployed).
- **Routing**: `#/coinvertible/monitoring`, `#/coinvertible/coinwatch/<eurcv|usdcv|pairs>`, `#/defi/morpho`, `#/defi/uniswap`, `#/defi/uniswap/<slug>`. Sub-page changes only re-render.
- **UI**: `render()` rebuilds from the store on every change and every 5 s, skips the DOM update when the HTML is unchanged (open menus, typed key stay); scroll positions kept with `data-keep`.

## 6. Request budget

| Page | Per new block (12 s) | Other |
|---|---|---|
| Monitoring | 1 `eth_blockNumber`, 1 multicall (supply), 1 `eth_getLogs` (mint / burn) | Solana / Stellar / XRPL 1 call per tick; DefiLlama 2 GET / 6 h; Canton total 1 GET / h |
| Morpho | per chain: 1 `eth_blockNumber`, 2 multicalls | Morpho API: discovery / 6 h / chain; deposits history per vault card shown / 6 h |
| Uniswap | 1 `eth_blockNumber`, 1 multicall (pools + ticks + oracles) | LP logs + GeckoTerminal each minute; aggregators ~160 / h (first visit ~60 s for 7 days) |
| Coinwatch | no RPC | Coinwatch only for what is shown, cached 6 h: ~29 requests for a token page, +5 per unfolded row, +2 for the Exchanges tab; Trading pairs: none |

## 7. Decisions by page (with their origin)

**Monitoring**
- Supply = **issued** supply, everything counted; no decimals shown. History from DefiLlama (254 / 307), issued = `circulating + unreleased`.
- Mint / burn: 15 most recent, Ethereum only, 8 rows visible. Burn attributed via `RedemptionStarted` (same token and amount), else transfer to the token's registrar, else the registrar (rule agreed with the user).
- **Canton (USDCV, temporary)**: Canton = published total - every chain read on-chain, never negative. Source URL: **CoinGecko `coins/usd-coinvertible`, `market_data.circulating_supply`** (the user's choice: CoinGecko's figure comes from the Forge API, which has no CORS); **the pill stays labelled "Forge API"**. Orange dot: "source updated once a day". Switch off with `cantonFromForgeApi.url: ""`. Remove when Canton gets a real reader.

**Base (chain)**
- Configured in `config.js` with the two RPCs the user tested (`base-rpc.publicnode.com`, `base.api.pocket.network`), **`enabled: false`**, token deployments `base: { address: "" }` (placeholders). To switch on: the address, then `enabled: true` - nothing else (user's requirement). Logo `logos/base.svg`.

**Morpho**
- EURCV only. Lists / names / logos from the Morpho API, **every number on-chain**. Whitelist in config; the rest under "Show more" (read only while open).
- **Multi-chain (prepared for Base)**: `morpho.chains` (Morpho Blue + app URL per chain); one `MorphoChain` reader per active chain; keys `chain:address` / `chain:id`; Ethereum keeps its old cache keys. **Chain logo left of each vault and market** (user). **Buttons All / per chain on the right of the "Vaults" and "Markets" titles** (user), shown when 2+ chains are active; the **Main Vault = largest whitelisted deposits of the selected chain** (or `mainVault` if on that chain); **Total supplied / borrowed for the selected chain** (user).
- Net APY column (after fees), fees in grey under it. Hover rules (user, v7): everything before fees so native + incentives = gross; gross only when the vault has fees; native always ("Native = gross APY" when equal); incentives = gross - native whenever native < gross, every vault; cap only with `incentives: true` and cap <= 15 %, "reached" when at the cap. Native also kept in the card sub-line.
- Incentives (V2, `incentives: true`): buffer = realAssets - totalAssets, runway shown `amount - runway`. Safe x Steakhouse Prime Instant has `incentives: true` (user).
- Vault rows unfold into the vault card (one at a time, Close / Esc), its deposits chart from the Morpho API.
- **"Show more" loading state** (user): spinner + "Fetching N more ..." in the footer while nothing extra is read yet.

**Uniswap**
- Whitelisted pools only. v2 / v3 / v4 share one code path. TVL = on-chain balances x Chainlink (**not CoinGecko**); volume GeckoTerminal; peg via Chainlink EUR/USD SVR (classic fallback) and USDC/USD; 1 EURC = 1 EUR. Depth +/-10/50/100 bps, impact 100k / 500k / 1M (no 2M). Depth / impact computed locally (identical to the quoters): never replace by quoter calls. LP history needs NOWNodes (~3M-block ranges), else "History unavailable".

**Aggregators** (section 22c; built from the user's guide `AGGREGATORS.md`, decisions of 2026-11-04 / 05 - do not change without asking him)
- Bebop, 0x, UniswapX (asked), CoW Protocol, Velora, 1inch, KyberSwap (added at his request). On-chain only: EURCV transfers + receipts in JSON-RPC batches. `classifyTrade()` is a pure function: test it offline (`tests-aggregators.mjs`) before any change.
- **Two venues: our pools and RFQ. Never add them** (pools already in the pools' volume: grey, apart). **Each EURCV leg counted once, under its executor**; overlapping info (brought by, passed on) small, grey, labelled. Default view "Executed by". Invariant checked on every build.
- "Pivot" = EURCV used as a pivot between two other tokens (his word). History **7 days max** (`historyDays`, editable 1-30). Tooltips: one or two short lines. The trades filters use the DA menus (`ddMenu`).

**Coinwatch** (section 22b)
- Not a scheduled module: the page asks `cw.get()` for exactly what it shows; cache 6 h; refresh button re-fetches. No request for anything not displayed.
- Key: config or typed once per user (`cv-coinwatch-key`); the key page links to **coinwatch.co/settings/api_keys** (user). 120 req/min allowed; pool 1.8/s.
- Company slugs **`eurcv` / `usdcv`**, no dashboard, `fallbacks: []` (checked by the user in Diagnostics).
- **Coinwatch is the first source of the token pages; `coinwatch.markets` fills what it does not give** (user). Per-venue market maker charts only for venues Coinwatch reports, and not for venues the list gives with no market maker (`[]`). **No other 404 handling** (user's decision: the list will avoid them).
- Parsing: `volume24h: "last"`, `spreadUnit: "percent"` (user). "Remaining Depth / Volume" are not market makers.
- KPI order: Volume 24h (15 daily bars), Depth (share by our market makers), Average spread (note on its computation), Active market makers. Market makers tab grouped by market maker (user). Bigger header on unfolded rows.
- **Trading pairs tab: built from the config list ONLY** (user, v11: no Coinwatch pairs or volumes). Grouped by exchange; filters Exchange / Market maker / Token (EURCV, USDCV, "EURCV / USDCV pairs" only if such a pair exists - automatic from the pair names). `pairsTab`: public (even without a key), private (once a key is entered), hidden (user).
- Logos matched by whole words (earliest, longest): "Uniswap v3 - Ethereum" -> Uniswap; any extension.

## 8. Endpoints (as configured)

Ethereum (tested through the proxy 2026-10-15; limits re-measured 2026-11-04 from outside): NOWNodes (calls + logs, 3M-block ranges; its `eth_getLogs` timed out on 2026-11-04), Pocket (10k ranges, some nodes 1k), BlockMachine (logs of the last ~10k blocks: `logDepth: 9500`), SwiftNodes, Nodies, Nodies POKT (50-block logs), bloXroute x4, Stakely, BlockPI (calls only); `maxBatch` per endpoint. Base (tested by the user): PublicNode (multicall 300, logs 50k), Pocket (multicall 50, logs 10k). Solana: Solana Vibe Station, Solana Tracker. Stellar: SDF Horizon. XRPL: xrplcluster, xrpl.link. APIs: Morpho GraphQL, GeckoTerminal, DefiLlama, CoinGecko (Canton), Coinwatch. Not used on purpose: anything with an API key, endpoints without CORS, PublicNode Ethereum / dRPC (blocked by the proxy), Flashbots, Tatum, MeowRPC, Solana Foundation RPC, the Forge API itself (no CORS).

## 9. Tests and checks before every delivery

- `node --check app.js && node --check config.js`; ASCII check (§2).
- `node tests.mjs` (unit, incl. config loading, Morpho normalisation, Coinwatch helpers, Canton field); `node tests-aggregators.mjs` (6 real transactions). Live: `NODE_USE_ENV_PROXY=1 node tests.mjs --live` and `node tests-aggregators.mjs --live` (in a sandbox also `NODE_EXTRA_CA_CERTS=<ca bundle>`). Live failures from public endpoints (429 GeckoTerminal, a timeout) are environmental: retry.
- Visual: headless Chromium (Playwright) serving the folder on a fake origin (route `https://app.test/**` to the files); screenshots of each page at 1440 px dark + light (same heights), 390 px mobile; no `pageerror`. Mocks used so far: Coinwatch API (shapes of its OpenAPI doc) and the Canton source. To see Morpho with two chains without EURCV on Base, a test config can enable Base with EURC on Base (`0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42`, 6 decimals) standing in for EURCV.
- New maths: compare with the protocol's own view / quoter at the same block.

## 10. State and ideas not done yet

- Base: switch on when EURCV / USDCV are deployed (address + `enabled: true`); add Base vaults / markets with `chain: "base"` if they must be whitelisted.
- Coinwatch: the user fills `coinwatch.markets` (with `[]` for venues without market maker).
- Logos to add by the user: brand (4 files), `base.svg`, aggregators (6 files), Coinwatch venues / market makers.
- Aggregators: label the main RFQ maker `0x5002...6dee` and the routers seen in "Other contracts" in `known_addresses.json`, or add routers to `aggregators.list`.
- Re-test the Ethereum endpoints with `rpc-tester.html` (NOWNodes logs, BlockMachine depth, Pocket ranges); add a batch test to the tester.
- Which of the duplicate `cbBTC/EURCV 86 %` (and WBTC / wstETH) markets stay whitelisted.
- Optional `supplyOnlyOnMintBurn` (off). Etherscan as an alternative log source if NOWNodes disappears.
- Modularity ideas proposed earlier: navigation and pages declared in config, generic history-chart sources, per-module enable flags, labels from config.
