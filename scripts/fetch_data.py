from stablecoin_history.etherscan import EthereumToken, run_ethereum

TOKEN = EthereumToken(
    name="EURCV Ethereum",
    address="0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2",
    holders_file="data/holders.json",
    supply_file="data/marketcap.json",
    state_file="data/eurcv_eth_state.json",
    supply_precision=2,
    legacy_marketcap_shape=True,
)

if __name__ == "__main__":
    run_ethereum(TOKEN)
