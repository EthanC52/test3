// @ts-check
/**
 * Minimal functional UI: plain tables to check the data layer. The real design comes later.
 */
import { esc, amount, compact, usd, pct, age, dateTime, duration, addrLink, txLink, num } from "./format.js";
import { getSettings, saveSettings } from "../core/config.js";
import { storage } from "../core/storage.js";

const NAV = [
  ["#/coinvertible/monitoring", "monitoring", "CoinVertible / Monitoring"],
  ["#/coinvertible/coinwatch", "coinwatch", "CoinVertible / Coinwatch"],
  ["#/defi/morpho", "morpho", "DeFi / Morpho"],
  ["#/defi/uniswap", "uniswap", "DeFi / Uniswap"],
];

export class UI {
  /** @param {any} app @param {HTMLElement|null} root @param {HTMLElement|null} chrome */
  constructor(app, root, chrome) {
    this.app = app;
    this.root = root;
    this.chrome = chrome;
    this.page = "monitoring";
    this.apyOpen = new Set();
    this._raf = 0;
    this.renderChrome();
    app.store.on("change", () => this.renderSoon());
    setInterval(() => this.renderSoon(), 5000);
    root?.addEventListener("click", (e) => this.onClick(e));
  }

  setPage(page) {
    this.page = page;
    this.renderChrome();
    this.render();
  }

  renderSoon() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  /* ───────── chrome: nav, settings, diagnostics ───────── */

  renderChrome() {
    if (!this.chrome) return;
    const { config } = this.app;
    const banner = config.errors.length
      ? `<div class="banner error"><b>Config errors</b><ul>${config.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
    const warn = config.warnings.length
      ? `<div class="banner warn">${config.warnings.map((e) => esc(e)).join("<br>")}</div>` : "";
    const overridden = Object.values(config.chains).filter((c) => c.overridden).map((c) => c.label);
    this.chrome.innerHTML = `
      <header>
        <nav>${NAV.map(([href, id, label]) => `<a href="${href}" class="${id === this.page ? "active" : ""}">${esc(label)}</a>`).join("")}</nav>
        <span class="role" id="role"></span>
      </header>
      ${banner}${warn}
      ${overridden.length ? `<div class="banner info">Custom RPC in use for: ${esc(overridden.join(", "))}</div>` : ""}`;
    this.renderFooter();
  }

  renderFooter() {
    let f = document.getElementById("footer");
    if (!f) {
      f = document.createElement("footer");
      f.id = "footer";
      document.body.appendChild(f);
      f.innerHTML = `
        <details id="diag"><summary>Diagnostics</summary><div id="diag-body"></div></details>
        <button id="settings-btn" class="gear" title="RPC settings" aria-label="RPC settings">⚙</button>
        <dialog id="settings"></dialog>`;
      f.querySelector("#settings-btn")?.addEventListener("click", () => this.openSettings());
      f.querySelector("#diag")?.addEventListener("toggle", () => this.renderDiag());
      setInterval(() => this.renderDiag(), 3000);
    }
  }

  renderDiag() {
    const d = /** @type {HTMLDetailsElement|null} */ (document.getElementById("diag"));
    const body = document.getElementById("diag-body");
    if (!d || !body || !d.open) return;
    const s = this.app.stats;
    const table = (rows, title) => `
      <h4>${esc(title)}</h4>
      <table class="small"><thead><tr><th>Key</th><th>Last hour</th><th>Total</th><th>Sub-calls</th><th>Errors</th><th>429</th><th>p50 ms</th><th>p95 ms</th><th>Last error</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.key)}</td><td>${num(r.lastHour)}</td><td>${num(r.total)}</td><td>${num(r.subcalls)}</td><td>${num(r.errors)}</td><td>${num(r.rateLimited)}</td><td>${r.p50 ?? "—"}</td><td>${r.p95 ?? "—"}</td><td class="err">${esc(r.lastError || "")}</td></tr>`).join("") || `<tr><td colspan="9">No request yet</td></tr>`}</tbody></table>`;
    const health = Object.entries(this.app.adapters).flatMap(([k, a]) => a.pool.health().map((h) => ({ chain: k, ...h })))
      .concat(Object.entries(this.app.apiPools).flatMap(([k, p]) => p.health().map((h) => ({ chain: k, ...h }))));
    body.innerHTML = `
      <p>Tab role: <b>${esc(this.app.tabs.role)}</b> · requests since ${esc(new Date(s.startedAt).toLocaleTimeString("en-GB"))} · skipped ticks (previous still running): ${num(s.skippedTicks)}</p>
      <h4>Endpoints health</h4>
      <table class="small"><thead><tr><th>Scope</th><th>Endpoint</th><th>Status</th><th>Last error</th></tr></thead><tbody>
      ${health.map((h) => `<tr><td>${esc(h.chain)}</td><td title="${esc(h.url)}">${esc(h.id)}</td><td>${h.healthy ? "ok" : `cooldown ${Math.ceil(h.cooldownMs / 1000)}s`}</td><td class="err">${esc(h.lastError || "")}</td></tr>`).join("")}
      </tbody></table>
      ${table(s.rows("endpoint"), "Requests by endpoint")}
      ${table(s.rows("module"), "Requests by module")}
      ${table(s.rows("method"), "Requests by method")}`;
  }

  openSettings() {
    const dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById("settings"));
    if (!dlg) return;
    const settings = getSettings();
    const chains = Object.entries(this.app.config.chains).filter(([, c]) => c.enabled);
    dlg.innerHTML = `
      <form method="dialog">
        <h3>RPC settings</h3>
        <p class="muted">Endpoints entered here replace those of <code>config/chains.js</code> for that chain, in this browser only. One URL per line. Leave empty to use the config.</p>
        ${chains.map(([k, c]) => `
          <label>${esc(c.label)}
            <textarea name="${esc(k)}" rows="2" placeholder="${esc(c.endpoints.map((e) => e.url).join("\n"))}">${esc((settings.rpc?.[k] || []).join("\n"))}</textarea>
          </label>`).join("")}
        <div class="row">
          <button value="save" id="s-save">Save &amp; reload</button>
          <button value="reset" id="s-reset" type="button">Reset to config</button>
          <button value="clear" id="s-clear" type="button" title="Clears cached results, history and learned limits">Clear local cache</button>
          <button value="cancel">Close</button>
        </div>
      </form>`;
    dlg.querySelector("#s-save")?.addEventListener("click", () => {
      const rpc = {};
      for (const [k] of chains) {
        const ta = /** @type {HTMLTextAreaElement|null} */ (dlg.querySelector(`textarea[name="${k}"]`));
        const urls = (ta?.value || "").split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
        if (urls.length) rpc[k] = urls;
      }
      saveSettings({ ...settings, rpc });
      location.reload();
    });
    dlg.querySelector("#s-reset")?.addEventListener("click", () => { saveSettings({ ...settings, rpc: {} }); location.reload(); });
    dlg.querySelector("#s-clear")?.addEventListener("click", () => {
      const keep = getSettings();
      storage.clearAll();
      saveSettings(keep);
      location.reload();
    });
    dlg.showModal();
  }

  onClick(e) {
    const el = /** @type {HTMLElement} */ (e.target)?.closest?.("[data-act]");
    if (!el) return;
    const act = el.getAttribute("data-act");
    if (act === "gate") {
      const id = el.getAttribute("data-gate");
      const open = !this.app.tabs.localGates.has(id);
      this.app.tabs.setGate(id, open);
      this.app.scheduler.kick(this.app.config.morpho.chain);
      this.render();
    } else if (act === "apy") {
      const k = el.getAttribute("data-key");
      if (this.apyOpen.has(k)) this.apyOpen.delete(k); else this.apyOpen.add(k);
      this.render();
    }
  }

  /* ───────── pages ───────── */

  render() {
    if (!this.root) return;
    const role = document.getElementById("role");
    if (role) role.textContent = { leader: "live", follower: "live (shared with another tab)", hidden: "paused (tab hidden)", idle: "" }[this.app.tabs.role] || "";
    const p = this.page;
    this.root.innerHTML = p === "monitoring" ? this.monitoring() : p === "morpho" ? this.morpho() : p === "uniswap" ? this.uniswap() : this.coinwatch();
  }

  /** Status line of an envelope's sources. */
  sources(env, chainsOrder) {
    if (!env) return `<p class="muted">Waiting for the first read…</p>`;
    const f = this.app.config.frequency;
    const keys = chainsOrder || Object.keys(env.sources || {});
    const items = keys.filter((k) => env.sources?.[k]).map((k) => {
      const s = env.sources[k];
      const interval = this.app.scheduler.baseInterval(k in f.chains ? k : `api:${k}`);
      const stale = s.okAt && Date.now() - s.okAt > interval * 1000 * (f.behaviour.staleAfterIntervals || 3);
      const status = s.status === "ok" && stale ? "stale" : s.status;
      const ref = s.block ? `block ${num(s.block)}` : s.slot ? `slot ${num(s.slot)}` : s.ledger ? `ledger ${num(s.ledger)}` : "";
      const label = this.app.config.chains[k]?.label || k;
      const parts = [esc(label), ref && esc(ref), age(s.okAt), s.endpoint && esc(s.endpoint), status !== "ok" && `<b>${esc(status)}</b>`].filter(Boolean);
      return `<span class="src ${esc(status)}" title="${esc(s.error || "")}">${parts.join(" · ")}</span>`;
    });
    const warn = (env.warnings || []).map((w) => `<div class="banner warn">${esc(w)}</div>`).join("");
    return `<div class="sources">${items.join("")}${env.cached ? `<span class="src stale">cached values from your last visit</span>` : ""}</div>${warn}`;
  }

  monitoring() {
    const sup = this.app.store.get("monitoring.supply");
    const mb = this.app.store.get("monitoring.mintburn");
    const chains = this.app.config.chains;
    const supplyHtml = sup?.data ? Object.entries(sup.data).map(([sym, t]) => `
      <div class="card">
        <h3>${esc(sym)} <span class="muted">${esc(t.name)}</span></h3>
        <div class="big">${amount(t.total, 2)} ${esc(sym)}${t.partial ? ` <span class="tag warn" title="At least one chain could not be read">partial</span>` : ""}</div>
        <table><thead><tr><th>Chain</th><th class="r">Supply</th><th class="r">Share</th><th>Status</th></tr></thead><tbody>
        ${Object.entries(t.chains).map(([c, v]) => `<tr><td>${esc(chains[c]?.label || c)}</td><td class="r">${amount(v.amount, 2)}</td><td class="r">${pct(v.share)}</td><td>${esc(v.status)}</td></tr>`).join("")}
        </tbody></table>
      </div>`).join("") : "";
    const ex = chains.ethereum?.explorer;
    const rows = (mb?.data?.events || []).map((e) => {
      const label = this.app.labels.resolve(e.chain, e.counterparty.address).label;
      const via = e.attribution === "redemption" ? ` <span class="muted" title="RedemptionStarted to ${esc(e.via)}">via redemption</span>`
        : e.attribution === "transfer-to-registrar" ? ` <span class="muted" title="Matched on a transfer to the registrar with the same amount">via registrar</span>`
        : e.attribution === "registrar" ? ` <span class="muted" title="No matching redemption or transfer to the registrar found">(registrar)</span>` : "";
      return `<tr>
        <td>${dateTime(e.timestamp)}</td><td>${esc(chains[e.chain]?.label || e.chain)}</td><td>${esc(e.token)}</td>
        <td><span class="tag ${e.type}">${e.type}</span></td>
        <td>${addrLink(chains[e.chain].explorer, e.counterparty.address, label)}${via}</td>
        <td class="r">${amount(e.amount, 2)}</td><td>${txLink(chains[e.chain].explorer, e.txHash)}</td></tr>`;
    }).join("");
    return `
      <section><h2>Total supply</h2>${this.sources(sup, ["ethereum", "solana", "stellar", "xrpl"])}<div class="cards">${supplyHtml}</div></section>
      <section><h2>Recent mints &amp; burns <span class="muted">Ethereum, last 15</span></h2>${this.sources(mb)}
        <table><thead><tr><th>Date</th><th>Chain</th><th>Token</th><th>Type</th><th>Recipient / sender</th><th class="r">Amount</th><th>Tx</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7" class="muted">${mb ? "No event found yet" : "Loading…"}</td></tr>`}</tbody></table>
        ${ex ? "" : ""}
      </section>`;
  }

  morpho() {
    const env = this.app.store.get("morpho");
    const d = env?.data;
    const ex = this.app.config.chains[this.app.config.morpho.chain].explorer;
    const tabs = this.app.tabs;
    const vOpen = tabs.localGates.has("morpho.vaults.others");
    const mOpen = tabs.localGates.has("morpho.markets.others");
    const vaultRow = (v) => {
      const open = this.apyOpen.has(v.key);
      const inc = v.incentives;
      return `<tr class="${v.whitelist ? "" : "other"}">
        <td>${addrLink(ex, v.address, v.label)} <span class="muted">V${v.version}</span></td>
        <td class="r big2">${amount(v.totalDeposits, 0)}</td>
        <td class="r">${pct(v.idlePct)}</td>
        <td class="r"><button class="link" data-act="apy" data-key="${esc(v.key)}" title="Show native APY">${pct(v.apy)}</button>
          ${open ? `<div class="sub">native ${pct(v.nativeApy)}${v.incentiveApy != null ? ` · incentives ${pct(v.incentiveApy)}` : ""}${v.capApy != null ? ` · cap ${pct(v.capApy)}` : ""}</div>` : ""}</td>
        <td>${inc ? `${amount(String(inc.buffer), 0)} ${esc(d.asset)}
              <div class="sub">burn ${amount(String(inc.burnPerDay), 0)}/day · runway ${inc.runwayInfinite ? "∞ (buffer growing)" : duration(inc.runwaySec)}${inc.depletionAt ? ` · until ${esc(new Date(inc.depletionAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }))}` : ""}</div>
              <div class="sub">observed ${inc.observedBurnPerDay == null ? `— (measuring, ${Math.round((inc.observedWindowSec || 0) / 60)} min)` : amount(String(inc.observedBurnPerDay), 0) + "/day"}</div>`
          : v.incentivesEnabled ? "—" : ""}</td>
      </tr>`;
    };
    const marketRow = (m) => `<tr class="${m.whitelist ? "" : "other"}">
      <td>${m.collateral.logoURI ? `<img class="logo" src="${esc(m.collateral.logoURI)}" alt="" onerror="this.style.display='none'">` : ""}${esc(m.pair)} <span class="muted">${pct(m.lltv, 1)} LLTV</span>
        <div class="sub"><code title="${esc(m.id)}">${esc(m.id.slice(0, 10))}…</code> · oracle ${addrLink(ex, m.oracle, null)}</div></td>
      <td class="r big2">${pct(m.borrowApy)}</td>
      <td><div class="bar"><span class="band-${m.utilizationBand}" style="width:${Math.min(100, m.utilization * 100).toFixed(2)}%"></span></div><span class="sub">${pct(m.utilization)}</span></td>
      <td class="r">${compact(m.totalSupplied)}</td><td class="r">${compact(m.totalBorrowed)}</td></tr>`;
    const vW = (d?.vaults || []).filter((v) => v.whitelist);
    const vO = (d?.vaults || []).filter((v) => !v.whitelist);
    const mW = (d?.markets || []).filter((m) => m.whitelist);
    const mO = (d?.markets || []).filter((m) => !m.whitelist);
    const vHead = `<thead><tr><th>Vault</th><th class="r">Total deposits (${esc(d?.asset || "")})</th><th class="r">Idle</th><th class="r">APY</th><th>Incentives</th></tr></thead>`;
    const mHead = `<thead><tr><th>Market</th><th class="r">Borrow APY</th><th>Utilization</th><th class="r">Supplied</th><th class="r">Borrowed</th></tr></thead>`;
    return `
      ${this.sources(env)}
      <section><h2>Vaults <span class="muted">${esc(d?.asset || "")}</span></h2>
        <table>${vHead}<tbody>${vW.map(vaultRow).join("") || `<tr><td colspan="5" class="muted">Loading…</td></tr>`}
        ${vOpen ? vO.map(vaultRow).join("") || `<tr><td colspan="5" class="muted">Loading…</td></tr>` : ""}</tbody></table>
        <button class="more" data-act="gate" data-gate="morpho.vaults.others">${vOpen ? "Show less" : `Show more (${d?.counts?.othersVaults ?? "…"})`}</button>
      </section>
      <section><h2>Markets <span class="muted">${esc(d?.asset || "")} lent</span></h2>
        <div class="cards"><div class="card"><div class="muted">Total supplied (whitelisted)</div><div class="big">${amount(d?.overview?.totalSupplied, 0)}</div></div>
        <div class="card"><div class="muted">Total borrowed (whitelisted)</div><div class="big">${amount(d?.overview?.totalBorrowed, 0)}</div></div>
        <div class="card"><div class="muted">Utilization</div><div class="big">${pct(d?.overview?.utilization)}</div></div></div>
        <table>${mHead}<tbody>${mW.map(marketRow).join("") || `<tr><td colspan="5" class="muted">Loading…</td></tr>`}
        ${mOpen ? mO.map(marketRow).join("") || `<tr><td colspan="5" class="muted">Loading…</td></tr>` : ""}</tbody></table>
        <button class="more" data-act="gate" data-gate="morpho.markets.others">${mOpen ? "Show less" : `Show more (${d?.counts?.othersMarkets ?? "…"})`}</button>
      </section>`;
  }

  uniswap() {
    const env = this.app.store.get("uniswap");
    const ex = this.app.config.chains[this.app.config.uniswap.chain].explorer;
    const rows = (env?.data?.pools || []).map((p) => `<tr>
      <td>${addrLink(ex, p.address, p.label)} <span class="muted">${esc(p.version)}</span></td>
      ${[0, 1].map((i) => `<td class="r">${p.tokens[i] ? `${amount(p.tokens[i].amount, 0)} ${esc(p.tokens[i].symbol)}` : "—"}</td>`).join("")}
      <td class="r big2">${usd(p.volumeUsd24h)}</td></tr>`).join("");
    return `<section><h2>Uniswap pools</h2>${this.sources(env)}
      <table><thead><tr><th>Pool</th><th class="r">Token 0 in pool</th><th class="r">Token 1 in pool</th><th class="r">Volume 24h (GeckoTerminal)</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">Loading…</td></tr>`}</tbody></table></section>`;
  }

  coinwatch() {
    return `<section><h2>Coinwatch</h2><p class="muted">To be defined.</p></section>`;
  }
}
