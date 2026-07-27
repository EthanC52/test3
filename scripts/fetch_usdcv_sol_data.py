from stablecoin_history.solscan import SolanaToken, run_solscan

TOKEN = SolanaToken(
    name="USDCV Solana",
    mint="8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35",
    holders_file="data/usdcv_sol_holders.json",
    supply_file="data/usdcv_sol_marketcap.json",
    supply_precision=2,
)

if __name__ == "__main__":
    run_solscan(TOKEN)
