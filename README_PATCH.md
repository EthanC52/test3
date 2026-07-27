# Patch incrémental ETH/SOL — historiques originaux conservés

Ce ZIP est un **overlay** à extraire à la racine du dépôt original
`Bifflou/stablecoin_dashboard`. Il ne contient volontairement **aucun**
`data/*.json` : les historiques présents dans ton dépôt restent la source de
vérité et ne peuvent pas être écrasés par l'installation du patch.

## JSON conservés, mêmes chemins et mêmes schémas

- EURCV / Ethereum
  - `data/holders.json` → `[{"date":"YYYY-MM-DD","holders":123}]`
  - `data/marketcap.json` → objets historiques `{date, marketcap, supply}`
- EURCV / Solana
  - `data/sol_holders.json`
  - `data/sol_marketcap.json` → objets historiques `{date, marketcap, supply}`
- USDCV / Ethereum
  - `data/usdcv_eth_holders.json`
  - `data/usdcv_eth_marketcap.json` → `{date, supply}`
- USDCV / Solana
  - `data/usdcv_sol_holders.json`
  - `data/usdcv_sol_marketcap.json` → `{date, supply}`

Chaque écriture est un **upsert quotidien UTC** : un point déjà présent pour la
date est remplacé, un point absent est inséré, et tous les objets plus anciens
restent présents. Le workflow tourne toutes les 30 minutes, mais comme le format
originel contient une date sans heure, il n'ajoute pas 48 doublons par jour.

Pour les deux fichiers EURCV qui possèdent déjà la clé `marketcap`, cette clé est
conservée. Les nouveaux points utilisent `marketcap == supply`, dans la monnaie
du token, sans taux EUR/USD et sans appel à une source de change.

## Ethereum — Etherscan Free

- Les snapshots de supply et de holders couvrent les **trois dates UTC les plus
  récentes**.
- `totalSupply()` est lu au bloc correspondant à chaque snapshot.
- Le compteur direct Etherscan étant PRO, les holders sont calculés à partir des
  logs ERC-20 `Transfer` sur cette fenêtre et du checkpoint de balances déjà
  présent dans `data/eurcv_eth_state.json` et
  `data/usdcv_eth_state.json`.
- Le premier run convertit le checkpoint originel en checkpoint roulant ; les
  runs suivants ne relisent qu'une petite fenêtre récente.
- Aucun replay depuis le déploiement du contrat n'est lancé automatiquement.
- Avant d'écrire les holders, la somme des balances est comparée à
  `totalSupply()` au bloc courant. En cas d'incohérence, le JSON holders et le
  checkpoint restent inchangés.

## Solana — Solscan Playground / Free tier

Un seul appel `token/meta` est effectué par mint. Il fournit le nombre courant de
holders, les decimals et la supply. Le script ajoute ou remplace uniquement le
point UTC du jour ; il ne demande aucun historique à Solscan et ne parcourt
aucune transaction.

## Résilience

- retries exponentiels, timeouts et limitation du débit ;
- écritures JSON atomiques ;
- supply et holders isolés l'un de l'autre ;
- une chaîne en panne n'empêche pas les autres scripts de tourner ;
- un JSON invalide est laissé intact plutôt que réécrit ;
- chaque étape du workflow de collecte est `continue-on-error` ;
- le commit contient toutes les mises à jour valides du run, même si une source
  a échoué.

## Installation

Extraire l'archive **par-dessus le dépôt original**, puis supprimer `.claude`
localement une fois :

```bash
rm -rf .claude
python -m pip install requests pytest
python scripts/validate_history_files.py
python -m pytest -q
```

Ajouter dans **Settings → Secrets and variables → Actions** :

- `ETHERSCAN_API_KEY`
- `SOLSCAN_API_KEY`

`HELIUS_API_KEY` n'est plus utilisé. Configure GitHub Pages sur **Deploy from a
branch**, branche `main`, dossier `/ (root)`. Le workflow commit les JSON mis à
jour à `:07` et `:37` UTC ; Pages republie alors le site depuis la branche.
