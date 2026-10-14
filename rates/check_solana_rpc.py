#!/usr/bin/env python3
"""
Teste des RPC Solana (mainnet) : la requête passe-t-elle, en combien de temps,
et à quelle hauteur de bloc le nœud est-il ?

Usage :
    python3 check_solana_rpc.py                      # teste toute la liste ci-dessous
    python3 check_solana_rpc.py https://mon-rpc ...  # teste seulement les URL données
    python3 check_solana_rpc.py --timeout 5 --origin https://monpseudo.github.io

Aucune dépendance : bibliothèque standard Python 3.8+.
"""
import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# (fournisseur, URL) — endpoints publics sans inscription (Helius exclu)
ENDPOINTS = [
    ("Solana Foundation", "https://api.mainnet.solana.com"),
    ("Solana Foundation (ancien nom)", "https://api.mainnet-beta.solana.com"),
    ("PublicNode", "https://solana-rpc.publicnode.com"),
    ("Solana Vibe Station", "https://public.rpc.solanavibestation.com"),
    ("OnFinality", "https://solana.api.onfinality.io/public"),
    ("Tatum", "https://solana-mainnet.gateway.tatum.io"),
    ("Pocket Network", "https://solana.api.pocket.network"),
    ("Web3CDN", "https://solana.web3cdn.rest"),
    ("LeoRPC", "https://solana.leorpc.com/?api_key=FREE"),
    ("Uniblock", "https://api.uniblock.dev/uni/v1/json-rpc?chainId=solana"),
    ("Solana Tracker", "https://rpc.solanatracker.io/public"),
    # Anciennement publics, peut-être désormais avec clé
    ("dRPC", "https://solana.drpc.org"),
    ("Ankr", "https://rpc.ankr.com/solana"),
]

METHOD = "getBlockHeight"


def call(url, timeout, origin):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": METHOD, "params": [{"commitment": "confirmed"}]}).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "rpc-check/1.0", "Origin": origin},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            cors = resp.headers.get("Access-Control-Allow-Origin")
        ms = (time.perf_counter() - t0) * 1000
        data = json.loads(body)
        if isinstance(data.get("result"), int):
            return {"ok": True, "ms": ms, "block": data["result"], "cors": cors}
        err = data.get("error", {})
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        return {"ok": False, "ms": ms, "error": f"erreur RPC : {msg}"[:70]}
    except urllib.error.HTTPError as e:
        return {"ok": False, "ms": (time.perf_counter() - t0) * 1000, "error": f"HTTP {e.code} {e.reason}"[:70]}
    except Exception as e:  # timeout, DNS, TLS, JSON invalide...
        return {"ok": False, "ms": (time.perf_counter() - t0) * 1000, "error": f"{type(e).__name__}: {e}"[:70]}


def main():
    ap = argparse.ArgumentParser(description="Teste des RPC Solana avec " + METHOD)
    ap.add_argument("urls", nargs="*", help="URL à tester (par défaut : toute la liste du script)")
    ap.add_argument("--timeout", type=float, default=10, help="timeout par requête en secondes (défaut 10)")
    ap.add_argument("--origin", default="https://example.github.io",
                    help="Origin envoyé pour vérifier le CORS (mets l'URL de ta page GitHub Pages)")
    args = ap.parse_args()

    targets = [(urllib.parse.urlparse(u).netloc or u, u) for u in args.urls] if args.urls else ENDPOINTS
    print(f"Test de {len(targets)} RPC Solana ({METHOD}, timeout {args.timeout:g} s)...\n")

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda t: (t[0], t[1], call(t[1], args.timeout, args.origin)), targets))

    ok = sorted([r for r in results if r[2]["ok"]], key=lambda r: r[2]["ms"])
    ko = [r for r in results if not r[2]["ok"]]
    top = max((r[2]["block"] for r in ok), default=0)

    print(f"{'':2} {'Fournisseur':22} {'Temps':>8}  {'Hauteur':>11} {'Retard':>7}  {'CORS':5} URL")
    for name, url, r in ok:
        lag = top - r["block"]
        cors = "oui" if r["cors"] in ("*", args.origin) else "non"
        print(f"OK {name[:22]:22} {r['ms']:6.0f} ms  {r['block']:>11} {lag:>7}  {cors:5} {url}")
    for name, url, r in ko:
        print(f"KO {name[:22]:22} {r['ms']:6.0f} ms  {r['error']}")
        print(f"   {'':22} {'':8}  {url}")

    print(f"\n{len(ok)}/{len(results)} RPC répondent.")
    print("Retard = blocs de retard sur le nœud le plus à jour. CORS = utilisable depuis un navigateur (dashboard).")


if __name__ == "__main__":
    main()
