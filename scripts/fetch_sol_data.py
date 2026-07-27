from stablecoin_history.solscan import SolanaToken, run_solscan

TOKEN = SolanaToken(
    name="EURCV Solana",
    mint="DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52",
    holders_file="data/sol_holders.json",
    supply_file="data/sol_marketcap.json",
    supply_precision=6,
    legacy_marketcap_shape=True,
)

if __name__ == "__main__":
    run_solscan(TOKEN)
