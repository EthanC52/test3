from stablecoin_history.storage import HistorySpec, load_history

FILES = {
    "data/holders.json": HistorySpec("holders", 0),
    "data/marketcap.json": HistorySpec("supply", 2),
    "data/sol_holders.json": HistorySpec("holders", 0),
    "data/sol_marketcap.json": HistorySpec("supply", 6),
    "data/usdcv_eth_holders.json": HistorySpec("holders", 0),
    "data/usdcv_eth_marketcap.json": HistorySpec("supply", 2),
    "data/usdcv_sol_holders.json": HistorySpec("holders", 0),
    "data/usdcv_sol_marketcap.json": HistorySpec("supply", 2),
}

for path, spec in FILES.items():
    points = load_history(path, spec)
    print(f"OK {path}: {len(points)} points, dernier={points[-1] if points else None}")
