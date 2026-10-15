// @ts-check
/**
 * Entry point: loads config, builds pools/adapters/modules, wires the router, tabs and scheduler.
 */
import { loadConfig } from "./core/config.js";
import { RpcPool } from "./core/rpc-pool.js";
import { Stats } from "./core/stats.js";
import { Store } from "./core/store.js";
import { Labels } from "./core/labels.js";
import { Tabs } from "./core/tabs.js";
import { Scheduler } from "./core/scheduler.js";
import { Emitter } from "./core/util.js";
import { serialize, deserialize } from "./core/storage.js";
import { EvmAdapter } from "./chains/evm/adapter.js";
import { SolanaAdapter } from "./chains/solana/adapter.js";
import { StellarAdapter } from "./chains/stellar/adapter.js";
import { XrplAdapter } from "./chains/xrpl/adapter.js";
import { SupplyModule } from "./modules/supply/index.js";
import { MintBurnModule } from "./modules/mintburn/index.js";
import { MorphoModule } from "./modules/morpho/index.js";
import { UniswapModule } from "./modules/uniswap/index.js";
import { UI } from "./ui/ui.js";

const ADAPTERS = { evm: EvmAdapter, solana: SolanaAdapter, stellar: StellarAdapter, xrpl: XrplAdapter };

export const ROUTES = {
  "#/coinvertible/monitoring": "monitoring",
  "#/coinvertible/coinwatch": "coinwatch",
  "#/defi/morpho": "morpho",
  "#/defi/uniswap": "uniswap",
};

/** Build the app (no DOM needed: also used by the Node smoke test). */
export async function createApp() {
  const config = await loadConfig();
  const stats = new Stats();
  const store = new Store();
  const bus = new Emitter();
  const labels = new Labels(config.known, config.chains);

  /** @type {Record<string, any>} */
  const adapters = {};
  for (const [key, c] of Object.entries(config.chains)) {
    if (!c.enabled) continue;
    const pool = new RpcPool(key, c.endpoints, { timeoutMs: config.timeoutMs, stats });
    adapters[key] = new ADAPTERS[c.type](key, c, pool);
  }
  const apiPools = Object.fromEntries(Object.entries(config.apis).map(([k, a]) => [k, new RpcPool(k, [a], { timeoutMs: config.timeoutMs, stats })]));
  const tabs = new Tabs(config.frequency.behaviour);

  const app = { config, stats, store, bus, labels, adapters, apiPools, tabs, modules: /** @type {any[]} */ ([]), scheduler: /** @type {any} */ (null) };
  app.modules = [new SupplyModule(app), new MintBurnModule(app), new MorphoModule(app), new UniswapModule(app)];
  app.scheduler = new Scheduler(app);
  return app;
}

async function boot() {
  const app = await createApp();
  // @ts-ignore
  window.cvApp = app;
  // @ts-ignore
  window.cvStats = app.stats;
  app.store.loadCached();

  const ui = new UI(app, document.getElementById("app"), document.getElementById("chrome"));
  const { tabs, scheduler, store } = app;

  tabs.on("role", (role) => {
    if (role === "leader") scheduler.start(); else scheduler.stop();
    ui.renderSoon();
  });
  tabs.on("message", (m) => {
    if (!m || typeof m !== "object") return;
    if (m.type === "result" && !tabs.isLeader()) store.set(m.id, deserialize(m.env), { remote: true });
    if (m.type === "hello" && tabs.isLeader() && m.page === tabs.page) {
      for (const mod of app.modules) if (mod.page === tabs.page) {
        const env = store.get(mod.storeId);
        if (env) tabs.post({ type: "result", id: mod.storeId, env: serialize(env) });
      }
    }
  });
  store.on("local", ({ id, envelope }) => { if (tabs.isLeader()) tabs.post({ type: "result", id, env: serialize(envelope) }); });
  tabs.on("gates", () => scheduler.kick());
  app.labels.on("change", () => ui.renderSoon());

  const route = () => {
    const page = ROUTES[location.hash] || "monitoring";
    if (!ROUTES[location.hash]) history.replaceState(null, "", "#/coinvertible/monitoring");
    scheduler.setPage(page);
    tabs.setPage(page);
    ui.setPage(page);
  };
  window.addEventListener("hashchange", route);
  route();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  boot().catch((e) => {
    console.error(e);
    const el = document.getElementById("app");
    if (el) el.textContent = `Startup error: ${e?.message || e}`;
  });
}
