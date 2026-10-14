#!/usr/bin/env python3
"""
Teste des RPC Ethereum (mainnet) : la requête passe-t-elle, en combien de temps,
et à quel bloc le nœud est-il ?

Usage :
    python3 check_eth_rpc.py                      # teste toute la liste ci-dessous
    python3 check_eth_rpc.py https://mon-rpc ...  # teste seulement les URL données
    python3 check_eth_rpc.py --timeout 5 --origin https://monpseudo.github.io

Aucune dépendance : bibliothèque standard Python 3.8+.
"""
import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# (fournisseur, URL) — endpoints publics sans inscription, relevés sur Chainlist et OpenChainBench
ENDPOINTS = [
    ("PublicNode", "https://ethereum-rpc.publicnode.com"),
    ("dRPC", "https://eth.drpc.org"),
    ("1RPC", "https://public.1rpc.io/eth"),
    ("MEV Blocker", "https://rpc.mevblocker.io"),
    ("Flashbots Protect", "https://rpc.flashbots.net/"),
    ("Cloudflare", "https://cloudflare-eth.com/"),
    ("Blast API", "https://eth-mainnet.public.blastapi.io"),
    ("Nodies", "https://ethereum-public.nodies.app"),
    ("Nodies (POKT)", "https://eth-pokt.nodies.app"),
    ("BlockPI", "https://ethereum.public.blockpi.network/v1/rpc/public"),
    ("Tenderly", "https://gateway.tenderly.co/public/mainnet"),
    ("Tenderly (gateway)", "https://mainnet.gateway.tenderly.co"),
    ("Gateway.fm", "https://rpc.eth.gateway.fm"),
    ("MeowRPC", "https://eth.meowrpc.com"),
    ("Merkle", "https://eth.merkle.io"),
    ("ZAN", "https://api.zan.top/eth-mainnet"),
    ("Tatum", "https://ethereum-mainnet.gateway.tatum.io"),
    ("NOWNodes", "https://public-eth.nownodes.io"),
    ("BlockRazor", "https://eth.blockrazor.xyz"),
    ("0xRPC", "https://0xrpc.io/eth"),
    ("OnFinality", "https://eth.api.onfinality.io/public"),
    ("Stakely", "https://ethereum-json-rpc.stakely.io"),
    ("Pocket Network", "https://eth.api.pocket.network"),
    ("Polysplit", "https://rpc.polysplit.cloud/v1/chain/1"),
    ("bloXroute", "https://eth.rpc.blxrbdn.com/"),
    ("bloXroute Virginia", "https://virginia.rpc.blxrbdn.com/"),
    ("bloXroute UK", "https://uk.rpc.blxrbdn.com/"),
    ("bloXroute Singapore", "https://singapore.rpc.blxrbdn.com/"),
    ("Sentio", "https://mainnet.rpc.sentio.xyz"),
    ("SwiftNodes", "https://rpc.swiftnodes.io/rpc/eth"),
    ("Fullsend", "https://rpc.fullsend.to/"),
    ("BlockMachine", "https://rpc-eth.blockmachine.io"),
    ("XRPC", "https://xrpc.cl/eth"),
    ("HostDeFi", "https://rpc.hostdefi.com/api/rpc/ethereum"),
    ("RouteMe", "https://lb.routeme.sh/rpc/evm/1"),
    ("NodeFlare", "https://rpc.nodeflare.app/eth/public"),
    ("Valve City (démo)", "https://one.valve.city/rpc/vk_demo/evm/1"),
    ("Ava.do", "https://mainnet.eth.cloud.ava.do/"),
    ("Flux", "https://ethereumnodelight.app.runonflux.io"),
    # Clés publiques publiées par le fournisseur sur Chainlist
    ("NodeReal", "https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7"),
    ("RPCFast", "https://eth-mainnet.rpcfast.com?api_key=xbhWBI1Wkguk8SNMu1bvvLurPGLXmgwYeC4S6g2H7WdwFigZSmPWVZRxrskEQwIf"),
    ("Chain49", "https://rpc.chain49.com/ethereum?api_key=14d1a8b86d8a4b4797938332394203dc"),
    ("Tokenview", "https://services.tokenview.io/vipapi/nodeservice/eth?apikey=qVHq2o6jpaakcw3lRstl"),
    ("Owlracle", "https://rpc.owlracle.info/eth/70d38ce1826c4a60bb2a8e05a6c8b20f"),
    ("Dwellir", "https://api-ethereum-mainnet-reth.n.dwellir.com/2ccf18bf-2916-4198-8856-42172854353c"),
    ("Alchemy (clé démo)", "https://eth-mainnet.g.alchemy.com/v2/demo"),
    # Anciennement publics, peut-être désormais avec clé
    ("Ankr", "https://rpc.ankr.com/eth"),
    ("LlamaNodes", "https://eth.llamarpc.com"),
]

METHOD = "eth_blockNumber"


def call(url, timeout, origin):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": METHOD, "params": []}).encode()
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
        if "result" in data and data["result"]:
            return {"ok": True, "ms": ms, "block": int(data["result"], 16), "cors": cors}
        err = data.get("error", {})
        msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
        return {"ok": False, "ms": ms, "error": f"erreur RPC : {msg}"[:70]}
    except urllib.error.HTTPError as e:
        return {"ok": False, "ms": (time.perf_counter() - t0) * 1000, "error": f"HTTP {e.code} {e.reason}"[:70]}
    except Exception as e:  # timeout, DNS, TLS, JSON invalide...
        return {"ok": False, "ms": (time.perf_counter() - t0) * 1000, "error": f"{type(e).__name__}: {e}"[:70]}


def main():
    ap = argparse.ArgumentParser(description="Teste des RPC Ethereum avec " + METHOD)
    ap.add_argument("urls", nargs="*", help="URL à tester (par défaut : toute la liste du script)")
    ap.add_argument("--timeout", type=float, default=10, help="timeout par requête en secondes (défaut 10)")
    ap.add_argument("--origin", default="https://example.github.io",
                    help="Origin envoyé pour vérifier le CORS (mets l'URL de ta page GitHub Pages)")
    args = ap.parse_args()

    targets = [(urllib.parse.urlparse(u).netloc or u, u) for u in args.urls] if args.urls else ENDPOINTS
    print(f"Test de {len(targets)} RPC Ethereum ({METHOD}, timeout {args.timeout:g} s)...\n")

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda t: (t[0], t[1], call(t[1], args.timeout, args.origin)), targets))

    ok = sorted([r for r in results if r[2]["ok"]], key=lambda r: r[2]["ms"])
    ko = [r for r in results if not r[2]["ok"]]
    top = max((r[2]["block"] for r in ok), default=0)

    print(f"{'':2} {'Fournisseur':22} {'Temps':>8}  {'Bloc':>11} {'Retard':>7}  {'CORS':5} URL")
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
