import { startPolling } from "./sources.js";
import { toNum } from "./chain.js";

const { useState, useEffect, useReducer, useRef, useMemo } = React;
const html = htm.bind(React.createElement);

/* ═══════════════════════════ Config (fichier + surcharge locale) ═══════════════════════════ */

const LS_KEY = "coinvertible-monitor.override.v1";

function loadOverride() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "null");
  } catch {
    return null;
  }
}
function saveOverride(o) {
  try {
    if (o) localStorage.setItem(LS_KEY, JSON.stringify(o));
    else localStorage.removeItem(LS_KEY);
  } catch { /* stockage indisponible */ }
}
function buildConfig(base, override) {
  const cfg = structuredClone(base);
  if (!base.allowUiOverride || !override) return cfg;
  if (override.pollIntervalMs) cfg.pollIntervalMs = Math.max(1000, Number(override.pollIntervalMs));
  for (const [k, o] of Object.entries(override.networks || {})) {
    if (!cfg.networks[k]) continue;
    if (Array.isArray(o.rpcUrls) && o.rpcUrls.length) cfg.networks[k].rpcUrls = o.rpcUrls;
    if (typeof o.enabled === "boolean") cfg.networks[k].enabled = o.enabled;
  }
  return cfg;
}

/* ═══════════════════════════ Formatage ═══════════════════════════ */

const nf = (min, max) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: min, maximumFractionDigits: max });
const F2 = nf(2, 2);
const F0 = nf(0, 0);
const fmt = (v, digits = 2) => (v == null || Number.isNaN(v) ? "—" : digits === 0 ? F0.format(v) : nf(digits, digits).format(v));
const pct = (v, d = 2) => (v == null || !isFinite(v) ? "—" : `${nf(d, d).format(v * 100)} %`);
const signed = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmt(Math.abs(v), d)}`);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

function ago(sec) {
  if (sec == null || !isFinite(sec)) return "—";
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `il y a ${sec} s`;
  if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`;
  return `il y a ${Math.floor(sec / 86400)} j`;
}
function duration(days) {
  if (days == null || !isFinite(days)) return "—";
  if (days < 1) return `${fmt(days * 24, 1)} h`;
  if (days < 90) return `${fmt(days, 1)} jours`;
  return `${fmt(days / 30.44, 1)} mois`;
}
function maskUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    const path = x.pathname.length > 12 ? x.pathname.slice(0, 8) + "…" : x.pathname;
    return x.host + (path === "/" ? "" : path);
  } catch {
    return u.slice(0, 24);
  }
}

/* ═══════════════════════════ State ═══════════════════════════ */

const init = { nets: {}, moves: [], openedAt: Date.now(), baseline: {} };

function reducer(s, ev) {
  if (ev.type === "reset") return { ...init, openedAt: Date.now() };
  const prev = s.nets[ev.key] || {};
  if (ev.type === "error") {
    return { ...s, nets: { ...s.nets, [ev.key]: { ...prev, error: ev.error, errorAt: ev.at, rpc: ev.rpc } } };
  }
  // data
  const moves = [...s.moves];
  const baseline = { ...s.baseline };
  for (const [sym, t] of Object.entries(ev.data.tokens)) {
    const old = prev.data?.tokens?.[sym]?.amount;
    const bk = `${ev.key}:${sym}`;
    if (baseline[bk] == null && t.amount != null) baseline[bk] = t.amount;
    if (old != null && t.amount != null && Math.abs(t.amount - old) >= 1e-6) {
      moves.unshift({ sym, key: ev.key, delta: t.amount - old, at: ev.at, block: ev.data.block });
    }
  }
  return {
    ...s,
    moves: moves.slice(0, 30),
    baseline,
    nets: {
      ...s.nets,
      [ev.key]: { data: ev.data, at: ev.at, latency: ev.latency, rpc: ev.rpc, error: null, errorAt: null },
    },
  };
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ═══════════════════════════ Petits composants ═══════════════════════════ */

/** Nombre qui signale ses variations (montée / baisse) par un bref changement de couleur. */
function Num({ value, digits = 2, className = "" }) {
  const prev = useRef(value);
  const [dir, setDir] = useState(null);
  useEffect(() => {
    if (prev.current != null && value != null && value !== prev.current) {
      setDir(value > prev.current ? "up" : "down");
      const t = setTimeout(() => setDir(null), 900);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  if (value == null) return html`<span className=${"num " + className}>—</span>`;
  const [int, dec] = nf(digits, digits).format(value).split(",");
  return html`<span className=${`num ${className} ${dir ? "flash-" + dir : ""}`}>
    <span className="num-int">${int}</span>${dec != null && html`<span className="num-dec">,${dec}</span>`}
  </span>`;
}

function StatusDot({ state }) {
  return html`<span className=${"dot dot-" + state} aria-hidden="true"></span>`;
}

function netState(n, cfg, now) {
  if (!n) return "wait";
  if (n.error && (!n.at || n.errorAt > n.at)) return n.data ? "stale" : "error";
  if (n.at && now - n.at > Math.max(15000, cfg.pollIntervalMs * 5)) return "stale";
  return "live";
}

/* ═══════════════════════════ Header ═══════════════════════════ */

function Header({ cfg, state, now, onSettings }) {
  const active = Object.entries(cfg.networks).filter(([, n]) => n.enabled);
  const eth = state.nets[cfg.vault?.network || "ethereum"]?.data;
  const states = active.map(([k]) => netState(state.nets[k], cfg, now));
  const live = states.filter((s) => s === "live").length;
  return html`
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <div>
            <div className="brand-name">CoinVertible Monitor</div>
            <div className="brand-sub">Supply et incentives lus on-chain</div>
          </div>
        </div>
        <div className="topbar-status" role="status" aria-live="off">
          <span className="live-pill">
            <${StatusDot} state=${live === active.length && live > 0 ? "live" : live > 0 ? "stale" : "error"} />
            ${live}/${active.length} réseaux en direct
          </span>
          ${eth?.block && html`<span className="topbar-meta">Bloc Ethereum ${F0.format(eth.block)}</span>`}
          <span className="topbar-meta">Rafraîchi toutes les ${fmt(cfg.pollIntervalMs / 1000, cfg.pollIntervalMs % 1000 ? 1 : 0)} s</span>
          <button className="btn-ghost" onClick=${onSettings}>Réglages RPC</button>
        </div>
      </div>
    </header>`;
}

/* ═══════════════════════════ Supply ═══════════════════════════ */

function TokenPanel({ sym, cfg, state, now }) {
  const token = cfg.tokens[sym];
  const rows = Object.keys(token.deployments)
    .filter((k) => cfg.networks[k])
    .map((k) => {
      const net = cfg.networks[k];
      const n = state.nets[k];
      const t = n?.data?.tokens?.[sym];
      return { key: k, net, amount: net.enabled ? t?.amount ?? null : null, st: net.enabled ? netState(n, cfg, now) : "off", n };
    });
  const counted = rows.filter((r) => r.amount != null);
  const total = counted.reduce((s, r) => s + r.amount, 0);
  const allReady = rows.filter((r) => r.st !== "off").every((r) => r.amount != null);
  const base = counted.reduce((s, r) => s + (state.baseline[`${r.key}:${sym}`] ?? r.amount), 0);
  const sessionDelta = counted.length ? total - base : null;
  const lastMove = state.moves.find((m) => m.sym === sym);

  return html`
    <section className="token" aria-labelledby=${"t-" + sym}>
      <div className="split">
        <div className="split-top">
          <h2 id=${"t-" + sym} className="token-sym">${sym}</h2>
          <p className="token-name">Total supply de l’${token.name}</p>
        </div>
        <div className="split-figure">
          <${Num} value=${counted.length ? total : null} className="hero-num" />
        </div>
        <div className="split-bottom">
          <span>${allReady ? `Somme de ${counted.length} réseau${counted.length > 1 ? "x" : ""}` : counted.length ? "Lecture partielle, en attente des autres réseaux" : "Connexion aux RPC…"}</span>
          <span>Depuis l'ouverture : ${sessionDelta == null ? "—" : signed(sessionDelta)}</span>
        </div>
      </div>

      <table className="chains">
        <caption className="sr-only">Répartition de la supply ${sym} par réseau</caption>
        <thead><tr><th scope="col">Réseau</th><th scope="col" className="r">Supply</th><th scope="col" className="r">Part</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const share = r.amount != null && total > 0 ? r.amount / total : null;
            return html`<tr key=${r.key} className=${"st-" + r.st}>
              <th scope="row">
                <${StatusDot} state=${r.st} />
                ${r.net.label}
                ${r.st === "off" && html`<span className="muted"> désactivé</span>`}
                ${r.st === "error" && html`<span className="err" title=${r.n?.error}> erreur RPC</span>`}
                ${r.st === "stale" && html`<span className="muted" title=${r.n?.error || ""}> donnée figée</span>`}
              </th>
              <td className="r"><${Num} value=${r.amount} /></td>
              <td className="r share">
                <span className="bar" aria-hidden="true"><span style=${{ width: `${(share ?? 0) * 100}%` }}></span></span>
                ${share == null ? "—" : pct(share, 1)}
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
      <p className="token-foot">
        ${lastMove
          ? html`Dernier mouvement : <strong className=${lastMove.delta > 0 ? "pos" : "neg"}>${signed(lastMove.delta)} ${sym}</strong>${" "}(${lastMove.delta > 0 ? "émission" : "destruction"}) sur ${cfg.networks[lastMove.key]?.label}, ${ago((now - lastMove.at) / 1000)}`
          : "Aucune émission ni destruction depuis l'ouverture de la page."}
      </p>
    </section>`;
}

/* ═══════════════════════════ Vault ═══════════════════════════ */

function Fact({ label, children, hint }) {
  return html`<div className="fact">
    <dt>${label}</dt>
    <dd>${children}</dd>
    ${hint && html`<p className="fact-hint">${hint}</p>`}
  </div>`;
}

function VaultSection({ cfg, state, now }) {
  const vk = cfg.vault.network;
  const n = state.nets[vk];
  const v = n?.data?.vault;
  const explorer = cfg.networks[vk]?.explorer || "";
  const st = netState(n, cfg, now);

  if (!v) {
    return html`<section className="vault" aria-labelledby="vault-h">
      <div className="vault-head"><h2 id="vault-h">Incentives du vault ${cfg.vault.label}</h2></div>
      <p className="empty">${n?.error ? html`Lecture du vault impossible : <span className="err">${n.error}</span>. Vérifie l'URL RPC ${cfg.networks[vk]?.label} dans Réglages RPC.` : "Lecture du vault en cours…"}</p>
    </section>`;
  }

  const m = v.meta;
  const d = m.assetDecimals;
  const sym = m.assetSymbol;
  const N = (x) => toNum(x, d);
  const ts = n.data.timestamp;
  const real = N(v.realAssets);
  const ta = N(v.totalAssets);
  const buffer = N(v.buffer);
  const idle = N(v.idle);
  const capDay = v.capPerSecRaw != null ? N(v.capPerSecRaw) * 86400 : null;
  const burnDay = v.burn?.burnPerSec != null ? v.burn.burnPerSec * 86400 : null;
  const organicDay = capDay != null && burnDay != null ? capDay - burnDay : null;
  const organicApr = organicDay != null && ta ? (organicDay * 365) / ta : null;
  const runway = burnDay != null && burnDay > 0 ? buffer / burnDay : null;
  const runwayFloor = capDay ? buffer / capDay : null;
  const sharePrice = v.sharePriceRaw != null ? N(v.sharePriceRaw) : null;
  const bufShare = real > 0 ? buffer / real : 0;
  const isV2 = v.version === 2;

  return html`
    <section className="vault" aria-labelledby="vault-h">
      <div className="vault-head">
        <div>
          <h2 id="vault-h">Incentives du vault ${cfg.vault.label}</h2>
          <p className="vault-sub">
            Morpho Vault ${isV2 ? "V2" : "V1"} sur ${cfg.networks[vk].label}, lu au bloc ${F0.format(n.data.block)}
            ${st !== "live" && html` <span className="err">(donnée figée)</span>`}
          </p>
        </div>
        <div className="vault-links">
          <a href=${explorer + m.address} target="_blank" rel="noopener">${short(m.address)} sur l'explorer</a>
          ${cfg.vault.url && html`<a href=${cfg.vault.url} target="_blank" rel="noopener">Ouvrir sur Morpho</a>`}
        </div>
      </div>

      <div className="incentive">
        <div className="incentive-main">
          <p className="incentive-label">${isV2 ? "Incentives en attente de distribution" : `${sym} détenus par le vault et non comptabilisés`}</p>
          <div className="incentive-fig"><${Num} value=${buffer} className="big-num" /><span className="unit">${sym}</span></div>
          <p className="incentive-formula">
            ${isV2
              ? html`Assets réels <strong>${fmt(real)}</strong> − total assets comptabilisés <strong>${fmt(ta)}</strong>`
              : html`Solde ${sym} du contrat, hors totalAssets()`}
          </p>
          ${v.unrealizedLoss > 0n && html`<p className="err">Perte non réalisée : ${fmt(N(v.unrealizedLoss))} ${sym} (assets réels inférieurs aux assets comptabilisés).</p>`}
        </div>
        ${isV2 && html`<div className="incentive-side">
          <div className="kpi">
            <span className="kpi-label">Durée restante estimée</span>
            <span className="kpi-val">${runway != null ? duration(runway) : burnDay != null && burnDay <= 0 ? "Buffer stable ou en hausse" : "Mesure en cours…"}</span>
            <span className="kpi-hint">${runway != null
              ? `Au rythme observé sur ${fmt(v.burn.windowSec / 60, 0)} min`
              : `Il faut au moins 60 s de blocs ; minimum garanti ${duration(runwayFloor)}`}</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">APY plafonné (maxRate)</span>
            <span className="kpi-val">${pct(v.capApy)}</span>
            <span className="kpi-hint">${pct(v.capApr)} APR, soit ${fmt(capDay)} ${sym} distribués par jour au maximum</span>
          </div>
        </div>`}
      </div>

      <div className="stack" role="img" aria-label=${`Assets réels : ${fmt(ta)} comptabilisés et ${fmt(buffer)} d'incentives en attente`}>
        <span className="stack-a" style=${{ flexGrow: Math.max(1 - bufShare, 0.001) }}>
          <span>Part des déposants ${pct(1 - bufShare, 2)}</span>
        </span>
        <span className="stack-b" style=${{ flexGrow: Math.max(bufShare, 0.001) }}>
          <span>Incentives ${pct(bufShare, 2)}</span>
        </span>
      </div>

      <div className="vault-grid">
        <dl className="facts">
          <${Fact} label="Assets réels" hint=${isV2 ? "Solde du vault + Σ realAssets() des adapters" : "totalAssets() + solde non comptabilisé"}>
            <${Num} value=${real} /> ${sym}
          </${Fact}>
          <${Fact} label="Total assets comptabilisés" hint=${isV2 ? "totalAssets(), intérêts courus inclus" : "totalAssets()"}>
            <${Num} value=${ta} /> ${sym}
          </${Fact}>
          <${Fact} label=${`${sym} dans le contrat du vault`} hint="Liquidité idle et donations non allouées">
            <${Num} value=${idle} /> ${sym}
          </${Fact}>
          ${isV2 && html`<${Fact} label="Alloué via adapters" hint=${`${m.adapters.length} adapter${m.adapters.length > 1 ? "s" : ""}`}>
            <${Num} value=${N(v.allocated)} /> ${sym}
          </${Fact}>`}
          <${Fact} label="Prix de la part" hint=${m.symbol ? `${m.symbol} → ${sym}` : null}>
            <${Num} value=${sharePrice} digits=${6} />
          </${Fact}>
          ${isV2 && html`<${Fact} label="Dernière mise à jour des intérêts" hint=${`Intérêts courus depuis : ${fmt(N(v.pendingAccrual))} ${sym}`}>
            ${ago(ts - v.lastUpdate)}
          </${Fact}>`}
          <${Fact} label="Frais">
            ${v.performanceFee != null ? `Perf. ${pct(v.performanceFee, 1)}` : "—"}${isV2 ? `, gestion ${pct(v.managementFee ?? 0, 2)}/an` : ""}
          </${Fact}>
        </dl>

        ${isV2 && html`<div className="dyn">
          <h3>Rythme de distribution</h3>
          <table className="dyn-table">
            <tbody>
              <tr><th scope="row">Distribution plafonnée (maxRate)</th><td className="r">${capDay == null ? "—" : `${fmt(capDay)} ${sym}/j`}</td></tr>
              <tr><th scope="row">Consommation observée du buffer</th><td className="r">${burnDay == null ? "Mesure en cours…" : `${fmt(burnDay)} ${sym}/j`}</td></tr>
              <tr><th scope="row">Rendement organique des marchés</th><td className="r">${organicDay == null ? "—" : `${fmt(organicDay)} ${sym}/j (${pct(organicApr)} APR)`}</td></tr>
            </tbody>
          </table>
          <p className="dyn-note">
            Les dépôts et retraits ne modifient pas le buffer. Il baisse au rythme du plafond moins les intérêts réellement gagnés,
            et monte d'un coup à chaque donation.
          </p>
          <h3>Donations détectées</h3>
          ${v.events?.length
            ? html`<ul className="events">${v.events.map((e) => html`<li key=${e.block + e.kind}>
                <strong className=${e.amount > 0 ? "pos" : "neg"}>${signed(e.amount)} ${sym}</strong>
                <span>${e.kind === "donation" ? "Donation" : "Baisse brutale"} au bloc ${F0.format(e.block)}, ${ago((Date.now() - e.seenAt) / 1000)}</span>
              </li>`)}</ul>`
            : html`<p className="muted">Aucune depuis l'ouverture de la page.</p>`}
        </div>`}
      </div>

      ${isV2 && html`<table className="adapters">
        <caption>Composition des assets réels</caption>
        <thead><tr><th scope="col">Source</th><th scope="col" className="r">${sym}</th><th scope="col" className="r">Part</th></tr></thead>
        <tbody>
          <tr><th scope="row">Solde du vault (idle + donations)</th><td className="r"><${Num} value=${idle} /></td><td className="r">${pct(real ? idle / real : null, 1)}</td></tr>
          ${v.adapters.map((a) => html`<tr key=${a.address}>
            <th scope="row">Adapter <a href=${explorer + a.address} target="_blank" rel="noopener">${short(a.address)}</a></th>
            <td className="r"><${Num} value=${N(a.realAssets)} /></td>
            <td className="r">${pct(real ? N(a.realAssets) / real : null, 1)}</td>
          </tr>`)}
        </tbody>
      </table>`}

      <details className="method">
        <summary>Méthode de calcul</summary>
        ${isV2
          ? html`<ol>
              <li>Toutes les lectures partent dans un seul <code>eth_call</code> Multicall3 : elles sont lues au même bloc.</li>
              <li><code>assetsRéels = ${sym}.balanceOf(vault) + Σ adapter.realAssets()</code>, comme dans <code>VaultV2.accrueInterestView()</code>.</li>
              <li><code>totalAssets()</code> renvoie <code>min(assetsRéels, _totalAssets × (1 + maxRate × Δt))</code> : la part des déposants ne peut pas croître plus vite que <code>maxRate</code>.</li>
              <li><code>incentives en attente = assetsRéels − totalAssets()</code>. C'est l'${sym} détenu par le vault mais pas encore attribué aux parts : les donations, plus l'éventuel intérêt organique au-delà du plafond.</li>
              <li>La consommation du buffer est mesurée entre le premier et le dernier bloc de la fenêtre (${fmt((cfg.vault.burnWindowSec || 900) / 60, 0)} min). Une hausse soudaine est enregistrée comme donation et relance la mesure.</li>
            </ol>`
          : html`<p>Vault MetaMorpho V1 : <code>totalAssets()</code> ne compte que les positions dans les marchés. L'${sym} envoyé directement au contrat n'est pas distribué aux déposants et peut être récupéré via <code>skim()</code>.</p>`}
      </details>
    </section>`;
}

/* ═══════════════════════════ Réglages ═══════════════════════════ */

function Settings({ base, override, onSave, onClose, state, cfg }) {
  const ref = useRef(null);
  const [draft, setDraft] = useState(() => {
    const d = { pollIntervalMs: cfg.pollIntervalMs, networks: {} };
    for (const [k, n] of Object.entries(cfg.networks)) d.networks[k] = { enabled: n.enabled, text: n.rpcUrls.join("\n") };
    return d;
  });
  useEffect(() => {
    ref.current?.querySelector("textarea, input")?.focus();
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const set = (k, patch) => setDraft((d) => ({ ...d, networks: { ...d.networks, [k]: { ...d.networks[k], ...patch } } }));
  const save = () => {
    const o = { pollIntervalMs: Number(draft.pollIntervalMs) || base.pollIntervalMs, networks: {} };
    for (const [k, n] of Object.entries(draft.networks)) {
      o.networks[k] = { enabled: n.enabled, rpcUrls: n.text.split(/\s+/).map((s) => s.trim()).filter(Boolean) };
    }
    onSave(o);
  };

  return html`<div className="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="set-h" ref=${ref}>
      <h2 id="set-h">Réglages RPC</h2>
      ${!base.allowUiOverride
        ? html`<p>La surcharge depuis l'interface est désactivée. Modifie <code>config.js</code>.</p>`
        : html`<p className="dialog-intro">
            Ces réglages sont enregistrés uniquement dans ce navigateur et remplacent ceux de <code>config.js</code>.
            Une URL par ligne : les suivantes servent de secours.
          </p>
          ${Object.entries(cfg.networks).map(([k, n]) => {
            const s = state.nets[k];
            return html`<fieldset key=${k} className="net-field">
              <legend>
                <label className="switch">
                  <input type="checkbox" checked=${draft.networks[k].enabled} onChange=${(e) => set(k, { enabled: e.target.checked })} />
                  ${n.label}
                </label>
                <span className="muted">
                  ${s?.latency != null ? ` ${s.latency} ms via ${maskUrl(s.rpc)}` : ""}
                  ${s?.error ? html` <span className="err">${s.error}</span>` : ""}
                </span>
              </legend>
              <textarea rows="2" spellcheck="false" aria-label=${"URL RPC " + n.label}
                value=${draft.networks[k].text} onInput=${(e) => set(k, { text: e.target.value })}></textarea>
            </fieldset>`;
          })}
          <label className="interval">
            Rafraîchissement (ms)
            <input type="number" min="1000" step="500" value=${draft.pollIntervalMs}
              onInput=${(e) => setDraft((d) => ({ ...d, pollIntervalMs: e.target.value }))} />
          </label>`}
      <div className="dialog-actions">
        ${override && html`<button className="btn-link" onClick=${() => onSave(null)}>Revenir à config.js</button>`}
        <span className="spacer"></span>
        <button className="btn-ghost dark" onClick=${onClose}>Annuler</button>
        ${base.allowUiOverride && html`<button className="btn-primary" onClick=${save}>Enregistrer et relancer</button>`}
      </div>
    </div>
  </div>`;
}

/* ═══════════════════════════ App ═══════════════════════════ */

function Footer({ cfg }) {
  const items = [];
  for (const [sym, t] of Object.entries(cfg.tokens)) {
    for (const [k, dep] of Object.entries(t.deployments)) {
      const net = cfg.networks[k];
      if (!net) continue;
      const id = dep.address || dep.mint || (dep.code ? `${dep.code}-${dep.issuer}` : dep.issuer);
      const href = net.explorer ? net.explorer + id : null;
      items.push(html`<li key=${sym + k}><span>${sym} sur ${net.label}</span>${href ? html`<a href=${href} target="_blank" rel="noopener">${short(dep.address || dep.mint || dep.issuer)}</a>` : short(id)}</li>`);
    }
  }
  return html`<footer className="foot">
    <div className="foot-inner">
      <div>
        <h2>Contrats lus</h2>
        <ul className="addr">${items}</ul>
      </div>
      <p className="foot-note">
        Données lues directement sur les blockchains via les RPC configurés, sans API intermédiaire.
        Page indépendante, non affiliée à Société Générale ou SG-FORGE. Ne constitue pas un conseil en investissement.
      </p>
    </div>
  </footer>`;
}

function App() {
  const base = window.APP_CONFIG;
  const [override, setOverride] = useState(loadOverride);
  const cfg = useMemo(() => buildConfig(base, override), [override]);
  const [state, dispatch] = useReducer(reducer, init);
  const [showSettings, setShowSettings] = useState(false);
  const now = useNow(1000);

  useEffect(() => {
    dispatch({ type: "reset" });
    return startPolling(cfg, dispatch);
  }, [cfg]);

  return html`
    <${Header} cfg=${cfg} state=${state} now=${now} onSettings=${() => setShowSettings(true)} />
    <main className="wrap">
      <div className="tokens">
        ${Object.keys(cfg.tokens).map((sym) => html`<${TokenPanel} key=${sym} sym=${sym} cfg=${cfg} state=${state} now=${now} />`)}
      </div>
      ${cfg.vault?.address && html`<${VaultSection} cfg=${cfg} state=${state} now=${now} />`}
    </main>
    <${Footer} cfg=${cfg} />
    ${showSettings && html`<${Settings} base=${base} override=${override} cfg=${cfg} state=${state}
      onClose=${() => setShowSettings(false)}
      onSave=${(o) => { saveOverride(o); setOverride(o); setShowSettings(false); }} />`}
  `;
}

if (!window.APP_CONFIG) {
  document.getElementById("root").innerHTML = '<p style="padding:24px">config.js introuvable ou invalide.</p>';
} else {
  ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
}
