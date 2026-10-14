# CoinVertible Monitor

Page statique (React, sans build) qui lit **on-chain, toutes les 3 s** :

- la **total supply EURCV et USDCV** sur chaque réseau (Ethereum, Solana, Stellar, XRP Ledger) et leur somme ;
- les **incentives en EURCV du vault Morpho** (par défaut *Steakhouse Prime EURCV*, Vault V2) : assets réels, assets comptabilisés, donations en attente, rythme de distribution et durée restante.

Aucune API intermédiaire : uniquement tes RPC.

## Configurer tes RPC

Tout se passe dans **`config.js`** :

```js
networks: {
  ethereum: { rpcUrls: ["https://eth-mainnet.g.alchemy.com/v2/<TA_CLE>", "https://ethereum-rpc.publicnode.com"] },
  solana:   { rpcUrls: ["https://mainnet.helius-rpc.com/?api-key=<TA_CLE>"] },
  ...
}
```

- Plusieurs URL par réseau = bascule automatique sur la suivante en cas d'erreur ou de timeout.
- `enabled: false` pour couper un réseau (il sort aussi du total).
- `pollIntervalMs` règle la fréquence (3000 par défaut).
- `pauseWhenHidden: true` stoppe les appels quand l'onglet est en arrière-plan.

Le bouton **Réglages RPC** de la page permet aussi de saisir des RPC stockés **uniquement dans ton navigateur** (localStorage) : pratique pour ne pas publier une clé privée sur GitHub.

> `config.js` est public une fois sur GitHub Pages. Si tu y mets une clé, restreins-la à ton domaine `https://<user>.github.io` chez ton provider.

### Consommation RPC

| Réseau | Requêtes par cycle |
|---|---|
| Ethereum | **1** `eth_call` (Multicall3 : supply EURCV, USDCV et tout le vault, au même bloc) |
| Solana | 2 `getTokenSupply` |
| Stellar | 1 `GET /assets` |
| XRPL | 1 `gateway_balances` |

À 3 s, Ethereum consomme ~28 800 appels par jour d'onglet ouvert.

## Déployer sur GitHub Pages

1. Crée un repo et pousse le contenu de ce dossier à la racine.
2. *Settings → Pages → Build and deployment → Deploy from a branch*, branche `main`, dossier `/ (root)`.
3. La page est servie sur `https://<user>.github.io/<repo>/`.

Tester en local : `python3 -m http.server 8080` puis http://localhost:8080 (ouvrir `index.html` en `file://` ne marche pas à cause des modules ES).

## Calcul des incentives (Morpho Vault V2)

Toutes les valeurs sont lues dans le même `eth_call` Multicall3, donc au même bloc.

```
assetsRéels   = EURCV.balanceOf(vault) + Σ adapter.realAssets()
totalAssets() = min(assetsRéels, _totalAssets × (1 + maxRate × Δt))   // VaultV2.accrueInterestView()
incentives    = assetsRéels − totalAssets()
```

`incentives` est l'EURCV détenu par le vault mais pas encore attribué aux parts : les donations, plus l'éventuel intérêt organique au-delà du plafond `maxRate`.

- **Distribution plafonnée / jour** = `totalAssets × maxRate × 86 400`.
- **Consommation observée** = baisse du buffer mesurée sur une fenêtre glissante (`vault.burnWindowSec`, 15 min). Les dépôts/retraits n'affectent pas le buffer ; une hausse brutale est enregistrée comme donation et relance la mesure.
- **Rendement organique** = distribution plafonnée − consommation observée.
- **Durée restante** = buffer / consommation observée (et, en attendant 60 s de blocs, un minimum garanti = buffer / distribution plafonnée).

Si tu pointes `vault.address` vers un vault MetaMorpho V1 (ex. *MEV Capital EURCV Prime*, en commentaire dans `config.js`), la page le détecte et affiche l'EURCV présent sur le contrat hors `totalAssets()` (non distribué, skimmable).

## Fichiers

```
index.html      page + chargement React/htm depuis jsDelivr
config.js       ← ta configuration
styles.css
src/chain.js    JSON-RPC, encodage ABI, Multicall3, lecteurs Solana/Stellar/XRPL
src/sources.js  boucles de polling, calcul du vault, suivi des donations
src/app.js      interface
```

## Adresses

| | Réseau | Adresse |
|---|---|---|
| EURCV | Ethereum | `0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2` |
| EURCV | Solana | `DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52` |
| EURCV | Stellar | `EURCV` / `GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G` |
| EURCV | XRPL | `4555524356…` / `rUNaS5sqRuxZz6V7rBGhoSaZiVYA3ut4UL` |
| USDCV | Ethereum | `0x5422374B27757da72d5265cC745ea906E0446634` |
| USDCV | Solana | `8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35` |
| Vault | Ethereum | `0xbeef0C075Da5D01112AE5cF34d257074fB5DDB2f` (Steakhouse Prime EURCV, V2) |
