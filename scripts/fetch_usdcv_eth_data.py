from stablecoin_history.etherscan import EthereumToken, run_ethereum

TOKEN = EthereumToken(
    name="USDCV Ethereum",
    address="0x5422374B27757da72d5265cC745ea906E0446634",
    holders_file="data/usdcv_eth_holders.json",
    supply_file="data/usdcv_eth_marketcap.json",
    state_file="data/usdcv_eth_state.json",
    supply_precision=2,
)

if __name__ == "__main__":
    run_ethereum(TOKEN)
