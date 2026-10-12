#!/usr/bin/env python3
"""
Historique des taux annuels instantanés (borrow / supply) de markets Morpho Blue
sur Ethereum et Base.

Deux méthodes :
  - rpc (défaut) : lecture on-chain (Morpho Blue + IRM) au bloc correspondant à
    chaque timestamp, puis recalcul du taux instantané de l'AdaptiveCurveIrm.
    Nécessite un RPC "archive" (accès à l'état des blocs anciens).
  - api : API GraphQL officielle de Morpho (https://api.morpho.org/graphql).

Exemples :
  python morpho_rates.py --start 2025-09-01
  python morpho_rates.py --start 2025-09-01 --end 2025-10-01 --interval 4h
  python morpho_rates.py --start 2025-09-01 --method api --markets "cbBTC/USDC 86%"
  python morpho_rates.py --start "2025-10-01 12:00" --interval 15m --sep ";"

Dépendance : requests  (pip install requests)
"""

from __future__ import annotations

import argparse
import bisect
import csv
import json
import math
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

# --------------------------------------------------------------------------- #
# Constantes
# --------------------------------------------------------------------------- #

MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"  # même adresse sur ETH et Base
MORPHO_API_URL = "https://api.morpho.org/graphql"

CHAINS = {
    "ethereum": {"chain_id": 1, "aliases": {"eth", "mainnet", "ethereum", "1"},
                 # bloc antérieur au déploiement de Morpho Blue (borne basse de recherche)
                 "anchor_block": 18_800_000,
                 "adaptive_irms": {"0x870ac11d48b15db9a138cf899d20f13f79ba00bc"}},
    "base": {"chain_id": 8453, "aliases": {"base", "8453"},
             "anchor_block": 13_000_000,
             "adaptive_irms": {"0x46415998764c29ab2a25cbea6254146d50d22687"}},
}

# Sélecteurs de fonctions (keccak256 de la signature, 4 premiers octets)
SEL_MARKET = "0x5c60e39a"              # market(bytes32)
SEL_ID_TO_PARAMS = "0x2c3c9157"        # idToMarketParams(bytes32)
SEL_RATE_AT_TARGET = "0x01977b57"      # rateAtTarget(bytes32)  (AdaptiveCurveIrm)
SEL_BORROW_RATE_VIEW = "0x8c00bf6b"    # borrowRateView(MarketParams,Market)
SEL_DECIMALS = "0x313ce567"            # decimals()
SEL_SYMBOL = "0x95d89b41"              # symbol()

WAD = 10**18
SECONDS_PER_YEAR = 365 * 24 * 3600

# Paramètres de l'AdaptiveCurveIrm (cf. ConstantsLib.sol de morpho-blue-irm)
CURVE_STEEPNESS = 4.0
TARGET_UTILIZATION = 0.9
ADJUSTMENT_SPEED = 50.0 / SECONDS_PER_YEAR
INITIAL_RATE_AT_TARGET = 0.04 / SECONDS_PER_YEAR
MIN_RATE_AT_TARGET = 0.001 / SECONDS_PER_YEAR
MAX_RATE_AT_TARGET = 2.0 / SECONDS_PER_YEAR

API_INTERVALS = {"HOUR": 3600, "DAY": 86400, "WEEK": 7 * 86400}

CSV_COLUMNS = [
    "chain", "market_name", "market_id", "timestamp", "datetime_utc", "block",
    "borrow_apy_pct", "supply_apy_pct", "borrow_apr_pct", "supply_apr_pct",
    "utilization_pct", "fee_pct", "total_supply", "total_borrow", "loan_token", "method",
]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# Parsing des arguments
# --------------------------------------------------------------------------- #

def parse_date(s: str) -> int:
    """'2025-01-01', '2025-01-01 12:00', '2025-01-01T12:00:00', ou timestamp unix. UTC."""
    s = s.strip()
    if s.isdigit():
        return int(s)
    if s.lower() in ("now", "today", "ajd"):
        return int(time.time())
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%dT%H:%M:%S", "%d/%m/%Y", "%d/%m/%Y %H:%M"):
        try:
            return int(datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            pass
    raise argparse.ArgumentTypeError(f"Date invalide : {s!r} (ex : 2025-01-01 ou '2025-01-01 12:00')")


def parse_interval(s: str) -> int:
    """'1h', '30m', '1d', '1w', '90s' ou un nombre de secondes."""
    m = re.fullmatch(r"\s*(\d+)\s*([smhdw]?)\s*", s.lower())
    if not m:
        raise argparse.ArgumentTypeError(f"Intervalle invalide : {s!r} (ex : 1h, 30m, 1d)")
    n, unit = int(m.group(1)), m.group(2) or "s"
    sec = n * {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[unit]
    if sec <= 0:
        raise argparse.ArgumentTypeError("L'intervalle doit être > 0")
    return sec


def normalize_chain(c: str) -> str:
    c = str(c).strip().lower()
    for name, info in CHAINS.items():
        if c in info["aliases"]:
            return name
    raise ValueError(f"Chaîne non supportée : {c!r} (ethereum ou base)")


def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    markets = []
    for i, m in enumerate(cfg.get("markets", [])):
        mid = (m.get("id") or m.get("market_id") or m.get("address") or "").strip().lower()
        if not re.fullmatch(r"0x[0-9a-f]{64}", mid):
            raise ValueError(f"Market #{i}: id invalide {mid!r} (attendu : bytes32, 0x + 64 hex)")
        markets.append({"name": m.get("name") or "", "chain": normalize_chain(m.get("chain", "ethereum")),
                        "id": mid})
    rpc = {}
    for chain, urls in (cfg.get("rpc") or {}).items():
        rpc[normalize_chain(chain)] = [urls] if isinstance(urls, str) else list(urls)
    # Surcharge possible par variables d'environnement : RPC_ETHEREUM, RPC_BASE
    for chain in CHAINS:
        env = os.environ.get(f"RPC_{chain.upper()}")
        if env:
            rpc[chain] = [u.strip() for u in env.split(",") if u.strip()]
    return {"markets": markets, "rpc": rpc}


# --------------------------------------------------------------------------- #
# Client JSON-RPC (retries + bascule entre plusieurs URLs)
# --------------------------------------------------------------------------- #

class RpcError(Exception):
    pass


class Rpc:
    def __init__(self, urls: list[str], retries: int = 6, timeout: int = 30):
        if not urls:
            raise ValueError("Aucune URL RPC configurée")
        self.urls = urls
        self.retries = retries
        self.timeout = timeout
        self._local = threading.local()
        self._id = 0
        self._lock = threading.Lock()

    def _session(self) -> requests.Session:
        if not hasattr(self._local, "s"):
            self._local.s = requests.Session()
        return self._local.s

    def call(self, method: str, params: list):
        with self._lock:
            self._id += 1
            rid = self._id
        payload = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        last_err = None
        for attempt in range(self.retries):
            url = self.urls[attempt % len(self.urls)]
            try:
                r = self._session().post(url, json=payload, timeout=self.timeout)
                if r.status_code == 429 or r.status_code >= 500:
                    raise RpcError(f"HTTP {r.status_code}")
                data = r.json()
                if "error" in data and data["error"]:
                    err = data["error"]
                    msg = str(err.get("message", err))
                    # Revert d'un eth_call : inutile de réessayer
                    if "revert" in msg.lower() or err.get("code") == 3:
                        raise RpcError(f"revert: {msg}")
                    raise RpcError(msg)
                return data["result"]
            except RpcError as e:
                if str(e).startswith("revert"):
                    raise
                last_err = e
            except (requests.RequestException, ValueError) as e:
                last_err = e
            time.sleep(min(0.5 * 2 ** attempt, 8))
        raise RpcError(f"{method} échoué après {self.retries} essais ({self.urls}) : {last_err}")

    def eth_call(self, to: str, data: str, block: int | str = "latest") -> bytes:
        tag = hex(block) if isinstance(block, int) else block
        res = self.call("eth_call", [{"to": to, "data": data}, tag])
        return bytes.fromhex(res[2:])

    def block(self, tag: int | str = "latest") -> tuple[int, int]:
        t = hex(tag) if isinstance(tag, int) else tag
        b = self.call("eth_getBlockByNumber", [t, False])
        if b is None:
            raise RpcError(f"Bloc {tag} introuvable")
        return int(b["number"], 16), int(b["timestamp"], 16)


def words(data: bytes) -> list[int]:
    return [int.from_bytes(data[i:i + 32], "big") for i in range(0, len(data) - len(data) % 32, 32)]


def to_int256(x: int) -> int:
    return x - (1 << 256) if x >= (1 << 255) else x


def enc_word(x: int) -> str:
    return format(x % (1 << 256), "064x")


def enc_addr(a: str) -> str:
    return a.lower().replace("0x", "").rjust(64, "0")


# --------------------------------------------------------------------------- #
# Recherche du bloc correspondant à un timestamp
# --------------------------------------------------------------------------- #

class BlockFinder:
    """Trouve le dernier bloc dont le timestamp est <= t (recherche par interpolation + cache)."""

    def __init__(self, rpc: Rpc, anchor_block: int):
        self.rpc = rpc
        self.lock = threading.Lock()
        self.blocks: list[int] = []
        self.stamps: list[int] = []
        latest, latest_ts = rpc.block("latest")
        anchor_ts = rpc.block(anchor_block)[1]
        self._add(anchor_block, anchor_ts)
        self._add(latest, latest_ts)
        self.latest, self.latest_ts = latest, latest_ts

    def _add(self, n: int, ts: int) -> None:
        with self.lock:
            i = bisect.bisect_left(self.blocks, n)
            if i < len(self.blocks) and self.blocks[i] == n:
                return
            self.blocks.insert(i, n)
            self.stamps.insert(i, ts)

    def _ts(self, n: int) -> int:
        with self.lock:
            i = bisect.bisect_left(self.blocks, n)
            if i < len(self.blocks) and self.blocks[i] == n:
                return self.stamps[i]
        ts = self.rpc.block(n)[1]
        self._add(n, ts)
        return ts

    def find(self, t: int) -> tuple[int, int] | None:
        with self.lock:
            i = bisect.bisect_right(self.stamps, t)
            if i == 0:
                return None  # avant la borne basse : Morpho n'existait pas
            if i == len(self.blocks):
                return self.blocks[-1], self.stamps[-1]
            lo, lo_ts = self.blocks[i - 1], self.stamps[i - 1]
            hi, hi_ts = self.blocks[i], self.stamps[i]
        it = 0
        while hi - lo > 1:
            it += 1
            if it > 6:   # sécurité : bascule en dichotomie si l'interpolation stagne
                g = (lo + hi) // 2
            else:
                g = lo + int((t - lo_ts) * (hi - lo) / max(hi_ts - lo_ts, 1))
                g = min(max(g, lo + 1), hi - 1)
            g_ts = self._ts(g)
            if g_ts <= t:
                lo, lo_ts = g, g_ts
            else:
                hi, hi_ts = g, g_ts
        return lo, lo_ts


# --------------------------------------------------------------------------- #
# Calcul des taux (AdaptiveCurveIrm)
# --------------------------------------------------------------------------- #

def _err(utilization: float) -> float:
    norm = (1 - TARGET_UTILIZATION) if utilization > TARGET_UTILIZATION else TARGET_UTILIZATION
    return (utilization - TARGET_UTILIZATION) / norm


def _curve(rate_at_target: float, err: float) -> float:
    coeff = (1 - 1 / CURVE_STEEPNESS) if err < 0 else (CURVE_STEEPNESS - 1)
    return (coeff * err + 1) * rate_at_target


def _clamp_rat(x: float) -> float:
    return min(max(x, MIN_RATE_AT_TARGET), MAX_RATE_AT_TARGET)


def adaptive_curve_instant_rate(rate_at_target: float, total_supply: float, total_borrow: float,
                                elapsed: int) -> tuple[float, float, float, float]:
    """Taux de borrow instantané (par seconde) de l'AdaptiveCurveIrm à l'instant t.

    Reproduit ce que ferait le contrat si le market était "accrue" à t :
      1. le rateAtTarget dérive depuis market.lastUpdate selon l'utilisation stockée ;
      2. les intérêts courus (taux moyen sur la période) s'ajoutent au supply et au borrow ;
      3. le taux instantané = courbe(rateAtTarget à t, utilisation après accrual).
    Retourne (taux/s, utilisation, total_supply, total_borrow) après accrual.
    """
    elapsed = max(elapsed, 0)
    u0 = total_borrow / total_supply if total_supply else 0.0
    err0 = _err(u0)
    if rate_at_target == 0:
        avg_rat = end_rat = INITIAL_RATE_AT_TARGET
    else:
        lin = ADJUSTMENT_SPEED * err0 * elapsed
        end_rat = _clamp_rat(rate_at_target * math.exp(lin))
        mid_rat = _clamp_rat(rate_at_target * math.exp(lin / 2))
        avg_rat = (rate_at_target + end_rat + 2 * mid_rat) / 4  # trapèzes, comme le contrat
    avg_rate = _curve(avg_rat, err0)
    interest = total_borrow * math.expm1(avg_rate * elapsed)
    tb, ts = total_borrow + interest, total_supply + interest
    u = tb / ts if ts else 0.0
    return _curve(end_rat, _err(u)), u, ts, tb


def rates_from_borrow_rate(borrow_rate_s: float, utilization: float, fee: float) -> dict:
    """APR = taux/s * secondes/an ; APY = exp(APR) - 1 (intérêts composés en continu,
    même convention que l'app et l'API Morpho)."""
    borrow_apr = borrow_rate_s * SECONDS_PER_YEAR
    supply_apr = borrow_apr * utilization * (1 - fee)
    return {
        "borrow_apr": borrow_apr, "borrow_apy": math.expm1(borrow_apr),
        "supply_apr": supply_apr, "supply_apy": math.expm1(supply_apr),
    }


# --------------------------------------------------------------------------- #
# Méthode RPC
# --------------------------------------------------------------------------- #

def read_token(rpc: Rpc, token: str) -> tuple[str, int]:
    sym, dec = token[:8], 18
    try:
        dec = words(rpc.eth_call(token, SEL_DECIMALS))[0]
    except Exception:
        pass
    try:
        raw = rpc.eth_call(token, SEL_SYMBOL)
        if len(raw) >= 96 and int.from_bytes(raw[:32], "big") == 32:   # string ABI
            ln = int.from_bytes(raw[32:64], "big")
            sym = raw[64:64 + ln].decode("utf-8", "replace")
        elif len(raw) >= 32:                                             # bytes32 (ex : MKR)
            sym = raw[:32].rstrip(b"\x00").decode("utf-8", "replace")
    except Exception:
        pass
    return sym, dec


def fetch_rpc(market: dict, timestamps: list[int], rpc: Rpc, finder: BlockFinder,
              workers: int) -> list[dict]:
    chain, mid = market["chain"], market["id"]
    id_hex = mid[2:]

    # Paramètres du market (immuables)
    p = rpc.eth_call(MORPHO_BLUE, SEL_ID_TO_PARAMS + id_hex)
    pw = words(p)
    loan, coll, oracle, irm, lltv = ("0x" + format(pw[0], "040x"), "0x" + format(pw[1], "040x"),
                                     "0x" + format(pw[2], "040x"), "0x" + format(pw[3], "040x"), pw[4])
    if pw[0] == 0:
        raise ValueError(f"Market {mid} inexistant sur {chain}")
    loan_sym, loan_dec = read_token(rpc, loan)
    if not market["name"]:
        coll_sym = read_token(rpc, coll)[0] if pw[1] else "idle"
        market["name"] = f"{coll_sym}/{loan_sym} {lltv / 1e16:g}%"
    is_adaptive = irm.lower() in CHAINS[chain]["adaptive_irms"]
    params_enc = "".join(enc_addr(a) for a in (loan, coll, oracle, irm)) + enc_word(lltv)
    log(f"  [{market['name']}] loan={loan_sym} irm={irm} "
        f"({'AdaptiveCurveIrm' if is_adaptive else 'IRM générique' if pw[3] else 'pas d IRM'})")

    def one(t: int) -> dict | None:
        found = finder.find(t)
        if found is None:
            return None
        block, block_ts = found
        try:
            mw = words(rpc.eth_call(MORPHO_BLUE, SEL_MARKET + id_hex, block))
        except RpcError as e:
            raise RpcError(f"{e}\n -> Ce RPC ne semble pas être un nœud archive "
                           f"(état du bloc {block} indisponible).") from e
        tsa, tss, tba, tbs, last_update, fee_wad = mw[:6]
        if last_update == 0:
            return None  # market pas encore créé à ce bloc
        utilization = tba / tsa if tsa else 0.0
        fee = fee_wad / WAD
        sup, bor = float(tsa), float(tba)
        if is_adaptive:
            rat = to_int256(words(rpc.eth_call(irm, SEL_RATE_AT_TARGET + id_hex, block))[0]) / WAD
            rate, utilization, sup, bor = adaptive_curve_instant_rate(rat, sup, bor, block_ts - last_update)
        elif pw[3] == 0:
            rate = 0.0
        else:  # IRM inconnue : borrowRateView (taux moyen depuis le dernier update)
            data = SEL_BORROW_RATE_VIEW + params_enc + "".join(enc_word(x) for x in mw[:6])
            rate = words(rpc.eth_call(irm, data, block))[0] / WAD
        r = rates_from_borrow_rate(rate, utilization, fee)
        return {
            "timestamp": t, "block": block, "utilization": utilization, "fee": fee,
            "total_supply": sup / 10**loan_dec, "total_borrow": bor / 10**loan_dec, **r,
        }

    rows, done = [], 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for res in ex.map(one, timestamps):
            done += 1
            if res:
                rows.append(res)
            if done % 100 == 0 or done == len(timestamps):
                log(f"    {done}/{len(timestamps)} points")
    for r in rows:
        r["loan_token"] = loan_sym
    return rows


# --------------------------------------------------------------------------- #
# Méthode API Morpho
# --------------------------------------------------------------------------- #

API_QUERY = """
query($id: String!, $chainId: Int!, $opts: TimeseriesOptions) {
  marketById(marketId: $id, chainId: $chainId) {
    lltv
    loanAsset { symbol decimals }
    collateralAsset { symbol }
    state { fee }
    historicalState {
      borrowApy(options: $opts) { x y }
      supplyApy(options: $opts) { x y }
      utilization(options: $opts) { x y }
      supplyAssets(options: $opts) { x y }
      borrowAssets(options: $opts) { x y }
    }
  }
}
"""


def api_post(query: str, variables: dict, retries: int = 5) -> dict:
    last = None
    for attempt in range(retries):
        try:
            r = requests.post(MORPHO_API_URL, json={"query": query, "variables": variables}, timeout=60)
            if r.status_code == 429 or r.status_code >= 500:
                raise RuntimeError(f"HTTP {r.status_code}")
            data = r.json()
            if data.get("errors"):
                raise ValueError("; ".join(e.get("message", str(e)) for e in data["errors"]))
            return data["data"]
        except ValueError:
            raise
        except Exception as e:
            last = e
            time.sleep(min(2 ** attempt, 15))
    raise RuntimeError(f"API Morpho injoignable : {last}")


def fetch_api(market: dict, timestamps: list[int], interval: int) -> list[dict]:
    chain_id = CHAINS[market["chain"]]["chain_id"]
    api_iv = "WEEK" if interval % API_INTERVALS["WEEK"] == 0 else \
             "DAY" if interval % API_INTERVALS["DAY"] == 0 else "HOUR"
    if interval < 3600:
        log(f"  /!\\ L'API ne descend pas sous 1h : les points intermédiaires reprennent la valeur horaire précédente.")

    series: dict[str, dict[int, float]] = {k: {} for k in
                                           ("borrowApy", "supplyApy", "utilization", "supplyAssets", "borrowAssets")}
    meta = None
    start, end = timestamps[0] - API_INTERVALS[api_iv], timestamps[-1]
    chunk = 90 * 86400  # ~2 200 points horaires x 5 séries par requête (limite API : 50 000)
    t0 = start
    while t0 <= end:
        t1 = min(t0 + chunk, end)
        d = api_post(API_QUERY, {"id": market["id"], "chainId": chain_id,
                                 "opts": {"startTimestamp": t0, "endTimestamp": t1, "interval": api_iv}})
        m = d.get("marketById")
        if m is None:
            raise ValueError(f"Market {market['id']} introuvable dans l'API (chainId {chain_id})")
        meta = meta or m
        for k in series:
            for pt in (m["historicalState"] or {}).get(k) or []:
                if pt["y"] is not None:
                    series[k][int(pt["x"])] = float(pt["y"])
        t0 = t1 + 1

    loan_sym = meta["loanAsset"]["symbol"]
    dec = int(meta["loanAsset"]["decimals"])
    if not market["name"]:
        coll = (meta.get("collateralAsset") or {}).get("symbol") or "idle"
        market["name"] = f"{coll}/{loan_sym} {int(meta['lltv']) / 1e16:g}%"
    fee_now = float((meta.get("state") or {}).get("fee") or 0)  # l'API n'historise pas le fee

    xs = sorted(series["borrowApy"])
    rows = []
    for t in timestamps:
        i = bisect.bisect_right(xs, t) - 1           # dernier point API <= t
        if i < 0 or t - xs[i] > max(interval, API_INTERVALS[api_iv]):
            continue
        x = xs[i]
        b_apy = series["borrowApy"].get(x)
        s_apy = series["supplyApy"].get(x)
        if b_apy is None:
            continue
        sa, ba = series["supplyAssets"].get(x), series["borrowAssets"].get(x)
        rows.append({
            "timestamp": t, "block": "", "utilization": series["utilization"].get(x, float("nan")),
            "fee": fee_now,
            "borrow_apy": b_apy, "supply_apy": s_apy if s_apy is not None else float("nan"),
            "borrow_apr": math.log1p(b_apy),
            "supply_apr": math.log1p(s_apy) if s_apy is not None else float("nan"),
            "total_supply": sa / 10**dec if sa is not None else "",
            "total_borrow": ba / 10**dec if ba is not None else "",
            "loan_token": loan_sym,
        })
    return rows


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def fmt_pct(x) -> str:
    return "" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:.6f}"


def main() -> None:
    ap = argparse.ArgumentParser(description="Historique des taux borrow/supply de markets Morpho Blue (ETH / Base).")
    ap.add_argument("--start", required=True, type=parse_date, help="Date de début (UTC), ex : 2025-01-01 ou '2025-01-01 12:00'")
    ap.add_argument("--end", type=parse_date, default=None, help="Date de fin (UTC). Défaut : maintenant")
    ap.add_argument("--interval", type=parse_interval, default=3600, help="Récurrence : 15m, 1h (défaut), 4h, 1d...")
    ap.add_argument("--method", choices=["rpc", "api"], default="rpc", help="Source des données (défaut : rpc)")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "markets.json"),
                    help="Fichier JSON des markets (défaut : markets.json à côté du script)")
    ap.add_argument("--markets", default=None,
                    help="Filtre : noms ou ids séparés par des virgules (défaut : tous les markets du JSON)")
    ap.add_argument("--output", "-o", default=None, help="Fichier CSV de sortie")
    ap.add_argument("--workers", type=int, default=8, help="Requêtes RPC parallèles (défaut : 8)")
    ap.add_argument("--sep", default=",", help="Séparateur CSV (';' pour Excel FR)")
    args = ap.parse_args()

    end = args.end if args.end is not None else int(time.time())
    end = min(end, int(time.time()))
    if args.start > end:
        sys.exit("Erreur : --start est après --end")
    timestamps = list(range(args.start, end + 1, args.interval))
    if not timestamps:
        sys.exit("Erreur : aucun point dans la période")

    cfg = load_config(args.config)
    markets = cfg["markets"]
    if args.markets:
        wanted = {w.strip().lower() for w in args.markets.split(",")}
        markets = [m for m in markets if m["id"] in wanted or m["name"].lower() in wanted]
    if not markets:
        sys.exit("Erreur : aucun market sélectionné (vérifie le JSON / --markets)")

    def iso(t): return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M")
    out = args.output or f"morpho_rates_{args.method}_{iso(args.start)[:10]}_{iso(end)[:10]}.csv"
    log(f"Méthode {args.method.upper()} | {iso(args.start)} -> {iso(end)} UTC | pas {args.interval}s "
        f"| {len(timestamps)} points x {len(markets)} market(s)")

    rpcs, finders = {}, {}
    all_rows = []
    for m in markets:
        log(f"\n> {m['name'] or m['id']} ({m['chain']})")
        try:
            if args.method == "rpc":
                ch = m["chain"]
                if ch not in rpcs:
                    rpcs[ch] = Rpc(cfg["rpc"].get(ch, []))
                    finders[ch] = BlockFinder(rpcs[ch], CHAINS[ch]["anchor_block"])
                rows = fetch_rpc(m, timestamps, rpcs[ch], finders[ch], args.workers)
            else:
                rows = fetch_api(m, timestamps, args.interval)
        except Exception as e:
            log(f"  ERREUR : {e}")
            continue
        log(f"  {len(rows)} lignes")
        for r in rows:
            all_rows.append({
                "chain": m["chain"], "market_name": m["name"], "market_id": m["id"],
                "timestamp": r["timestamp"], "datetime_utc": iso(r["timestamp"]), "block": r["block"],
                "borrow_apy_pct": fmt_pct(r["borrow_apy"]), "supply_apy_pct": fmt_pct(r["supply_apy"]),
                "borrow_apr_pct": fmt_pct(r["borrow_apr"]), "supply_apr_pct": fmt_pct(r["supply_apr"]),
                "utilization_pct": fmt_pct(r["utilization"]), "fee_pct": fmt_pct(r["fee"]),
                "total_supply": r["total_supply"], "total_borrow": r["total_borrow"],
                "loan_token": r["loan_token"], "method": args.method,
            })

    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, delimiter=args.sep)
        w.writeheader()
        w.writerows(all_rows)
    log(f"\nCSV écrit : {out} ({len(all_rows)} lignes)")


if __name__ == "__main__":
    main()
