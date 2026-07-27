# Sources API utilisées

## Ethereum

- Etherscan V2 `logs/getLogs`, filtré par adresse du token et topic ERC-20
  `Transfer`, avec pagination `page` / `offset=1000`.
- Etherscan V2 `block/getblocknobytime` pour associer les fins de journées UTC à
  des blocs Ethereum.
- Etherscan V2 `proxy/eth_call` pour `decimals()` et `totalSupply()` à un bloc
  hexadécimal précis.
- Le endpoint direct `token/tokenholdercount` n'est volontairement pas utilisé :
  il nécessite un plan Standard ou supérieur.

Documentation officielle :

- https://docs.etherscan.io/api-reference/endpoint/getlogs-address-topics
- https://docs.etherscan.io/api-reference/endpoint/getblocknobytime
- https://docs.etherscan.io/api-reference/endpoint/ethcall
- https://docs.etherscan.io/api-reference/endpoint/tokenholdercount
- https://docs.etherscan.io/resources/rate-limits

## Solana

- Solscan Pro API / Playground V2 `GET /token/meta`, authentification par le
  header `token`.
- Champs utilisés : `holder`, `decimals`, `supply`.
- Aucun endpoint historique, holders-list, transactions ou transfers n'est
  appelé.

Documentation officielle :

- https://pro-api.solscan.io/pro-api-docs/v2.0/reference/v2-token-meta
- https://pro-api.solscan.io/pro-api-docs/v2.0/playground/v2-token-meta
