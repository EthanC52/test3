# Prompt à coller dans GPT (PC du bureau) — mise à jour du 19/11/2026

Copie tout ce qui suit la ligne, puis joins les fichiers CSV CoinWatch. Exporte de préférence les **30 derniers jours** pour les paires EURCV de la partie A et, si CoinWatch les a, les paires EURC des parties B et C.

---

Tu es analyste de données de marché. Je te fournis des fichiers CSV bruts exportés de CoinWatch : carnets d'ordres des stablecoins euro **EURCV** et **EURC** sur plusieurs exchanges, un point toutes les 4 heures environ. Pour chaque point : profondeur à 10, 25, 50, 100 et 200 bps, et spread. Ton travail : nettoyer ces données, calculer quelques agrégats précis et me les rendre dans un gabarit fixe que je recopierai à la main. N'invente jamais une valeur : si elle ne peut pas être calculée, écris `NA`.

## 1. Comprendre les fichiers (avant tout calcul)

Dis-moi en 6 lignes maximum :
- quelles colonnes correspondent à : horodatage, exchange, paire, spread, profondeur à 10, 25, 50, 100, 200 bps ;
- le fuseau horaire des horodatages (UTC ou heure de Paris = UTC+1 en novembre) ;
- si la profondeur est donnée **par côté** (bid et ask séparés) ou **en total**, et dans quelle devise (USD, EUR, devise de cotation de la paire, ou unités du jeton) ;
- l'unité du spread : ratio (0,0003), pourcentage (0,03 %) ou bps (3) ;
- quelles paires des tableaux du point 3 sont présentes, et lesquelles manquent.
Si un point reste ambigu malgré les noms de colonnes et les ordres de grandeur, pose-moi la question avant de continuer.

## 2. Nettoyer

- Convertis tous les horodatages en **UTC**. Supprime les doublons exacts.
- **Spread → points de base (bps)** : 1 bp = 0,01 %. Ratio 0,0003 = 3 bps ; 0,03 % = 3 bps.
- **Profondeur → EUR, total bid + ask** :
  - si elle est donnée par côté, additionne bid et ask pour chaque point ;
  - 1 EURCV = 1 EUR et 1 EURC = 1 EUR ;
  - USD (ou USDC, USDT) → EUR : divise par le taux BCE du jour (USD pour 1 EUR ; week-end et jours fériés : dernier taux publié ; après le 18/11 : 1.0968) :
    12/10 1.1181 ; 13/10 1.1188 ; 14/10 1.1195 ; 15/10 1.1208 ; 16/10 1.1253 ; 19/10 1.1225 ; 20/10 1.1215 ; 21/10 1.1234 ; 22/10 1.1205 ; 23/10 1.1193 ; 26/10 1.1188 ; 27/10 1.115 ; 28/10 1.1133 ; 29/10 1.113 ; 30/10 1.1172 ; 02/11 1.1216 ; 03/11 1.1179 ; 04/11 1.1267 ; 05/11 1.1224 ; 06/11 1.1165 ; 09/11 1.1193 ; 10/11 1.1214 ; 11/11 1.1127 ; 12/11 1.1081 ; 13/11 1.1052 ; 16/11 1.1014 ; 17/11 1.0989 ; 18/11 1.0968
  - autre devise (KRW, BTC…) : convertis d'abord en unités du jeton (montant en devise de cotation ÷ prix moyen de la paire au même point), ce qui donne des EUR ;
- Écarte les points invalides (spread négatif ou nul, carnet vide) et compte-les. Ne corrige pas les valeurs extrêmes, mais signale-les : spread > 100 bps, ou profondeur à ±10 bps plus de 10 fois au-dessus de sa médiane.

## 3. Les paires à traiter

**A. EURCV (obligatoire)**

| Code | Exchange | Paire |
|---|---|---|
| `KRAKEN_EUR` | Kraken | EURCV/EUR — listée le 03/11/2026 |
| `KRAKEN_USD` | Kraken | EURCV/USD — listée le 03/11/2026 |
| `KRAKEN_USDC` | Kraken | EURCV/USDC — listée le 03/11/2026 |
| `BITSTAMP_EUR` | Bitstamp | EURCV/EUR |
| `BITSTAMP_USDC` | Bitstamp | EURCV/USDC |
| `BITVAVO_EUR` | Bitvavo | EURCV/EUR |
| `BULLISH_USDC` | Bullish | EURCV/USDC |
| `BIT2ME_EUR` | Bit2Me | EURCV/EUR — absente la dernière fois |
| `BULLISH_BTC` | Bullish | BTC/EURCV — nouvelle : 1re paire EURCV en volume |

**B. EURC sur les mêmes exchanges** (si CoinWatch a l'EURC ; codes préfixés `EURC_` dans le gabarit)

| Code | Exchange | Paire |
|---|---|---|
| `KRAKEN_EUR` | Kraken | EURC/EUR |
| `KRAKEN_USD` | Kraken | EURC/USD |
| `KRAKEN_USDC` | Kraken | EURC/USDC |
| `BITSTAMP_EUR` | Bitstamp | EURC/EUR |
| `BITSTAMP_USDC` | Bitstamp | EURC/USDC |
| `BITVAVO_EUR` | Bitvavo | EURC/EUR |
| `BULLISH_USDC` | Bullish | EURC/USDC |
| `BIT2ME_EUR` | Bit2Me | EURC/EUR |
| `BULLISH_BTC` | Bullish | BTC/EURC |

**C. EURC sur des marchés où EURCV n'est pas listé** (si CoinWatch les a ; codes préfixés `EURC_`)

| Code | Exchange | Paire |
|---|---|---|
| `COINBASE_USDC` | Coinbase | EURC/USDC |
| `OKX_USDC` | OKX | EURC/USDC |
| `UPBIT_KRW` | Upbit | EURC/KRW |
| `BITHUMB_KRW` | Bithumb | EURC/KRW |

Ignore toutes les autres paires. Si une paire est absente des fichiers, mets `NA` sur toutes ses lignes et signale-le. Si aucune paire EURC n'est disponible, laisse les parties B et C du gabarit en `NA`.

## 4. Deux périodes

- **30J** : les 30 derniers jours disponibles dans les fichiers (indique la date du premier et du dernier point retenus).
- **COM** : du **02/11/2026 00:00 UTC au 16/11/2026 00:00 UTC** (exclu), soit les deux dernières semaines complètes. C'est la fenêtre commune EURC / EURCV, identique pour toutes les paires. Pour Kraken EURCV, elle commence de fait le 03/11.

## 5. Indicateurs

Calculés sur les points valides de la période :
- `N` : nombre de points valides ;
- `SPMOY` : spread moyen, en bps ;
- `SPMED` : spread médian, en bps ;
- `SPP90` : 90e centile du spread, en bps (interpolation linéaire, comme PERCENTILE.INC d'Excel) ;
- `D10` : profondeur totale moyenne à ±10 bps, en EUR ;
- `D50` : profondeur totale moyenne à ±50 bps, en EUR.

Arrondis : 2 décimales pour les spreads, 0 décimale pour les profondeurs et N.

## 6. Réponse attendue

**Partie A (court, en français)** : colonnes utilisées, fuseau, unité du spread, profondeur par côté ou totale et devise d'origine ; pour chaque paire, points attendus (1 toutes les 4 h), points valides et points écartés ; paires absentes ; valeurs extrêmes signalées.

**Partie B** : recopie **exactement** le gabarit ci-dessous, dans le même ordre, en complétant chaque ligne après le `=`. Ne change ni l'ordre ni les noms, ne supprime aucune ligne. Point décimal, pas de séparateur de milliers.

```
# Fenêtres (format 2026-11-02 00:00, UTC)
DEBUT_30J=
FIN_30J=
DEBUT_COM=2026-11-02 00:00
FIN_COM=2026-11-16 00:00
# ===== A. EURCV (obligatoire) =====
# Kraken EURCV/EUR (listée le 03/11/2026)
KRAKEN_EUR_30J_N=
KRAKEN_EUR_30J_SPMOY=
KRAKEN_EUR_30J_SPMED=
KRAKEN_EUR_30J_SPP90=
KRAKEN_EUR_30J_D10=
KRAKEN_EUR_30J_D50=
KRAKEN_EUR_COM_SPMED=
KRAKEN_EUR_COM_D10=
KRAKEN_EUR_COM_D50=
# Kraken EURCV/USD (listée le 03/11/2026)
KRAKEN_USD_30J_N=
KRAKEN_USD_30J_SPMOY=
KRAKEN_USD_30J_SPMED=
KRAKEN_USD_30J_SPP90=
KRAKEN_USD_30J_D10=
KRAKEN_USD_30J_D50=
KRAKEN_USD_COM_SPMED=
KRAKEN_USD_COM_D10=
KRAKEN_USD_COM_D50=
# Kraken EURCV/USDC (listée le 03/11/2026)
KRAKEN_USDC_30J_N=
KRAKEN_USDC_30J_SPMOY=
KRAKEN_USDC_30J_SPMED=
KRAKEN_USDC_30J_SPP90=
KRAKEN_USDC_30J_D10=
KRAKEN_USDC_30J_D50=
KRAKEN_USDC_COM_SPMED=
KRAKEN_USDC_COM_D10=
KRAKEN_USDC_COM_D50=
# Bitstamp EURCV/EUR
BITSTAMP_EUR_30J_N=
BITSTAMP_EUR_30J_SPMOY=
BITSTAMP_EUR_30J_SPMED=
BITSTAMP_EUR_30J_SPP90=
BITSTAMP_EUR_30J_D10=
BITSTAMP_EUR_30J_D50=
BITSTAMP_EUR_COM_SPMED=
BITSTAMP_EUR_COM_D10=
BITSTAMP_EUR_COM_D50=
# Bitstamp EURCV/USDC
BITSTAMP_USDC_30J_N=
BITSTAMP_USDC_30J_SPMOY=
BITSTAMP_USDC_30J_SPMED=
BITSTAMP_USDC_30J_SPP90=
BITSTAMP_USDC_30J_D10=
BITSTAMP_USDC_30J_D50=
BITSTAMP_USDC_COM_SPMED=
BITSTAMP_USDC_COM_D10=
BITSTAMP_USDC_COM_D50=
# Bitvavo EURCV/EUR
BITVAVO_EUR_30J_N=
BITVAVO_EUR_30J_SPMOY=
BITVAVO_EUR_30J_SPMED=
BITVAVO_EUR_30J_SPP90=
BITVAVO_EUR_30J_D10=
BITVAVO_EUR_30J_D50=
BITVAVO_EUR_COM_SPMED=
BITVAVO_EUR_COM_D10=
BITVAVO_EUR_COM_D50=
# Bullish EURCV/USDC
BULLISH_USDC_30J_N=
BULLISH_USDC_30J_SPMOY=
BULLISH_USDC_30J_SPMED=
BULLISH_USDC_30J_SPP90=
BULLISH_USDC_30J_D10=
BULLISH_USDC_30J_D50=
BULLISH_USDC_COM_SPMED=
BULLISH_USDC_COM_D10=
BULLISH_USDC_COM_D50=
# Bit2Me EURCV/EUR (absente la dernière fois)
BIT2ME_EUR_30J_N=
BIT2ME_EUR_30J_SPMOY=
BIT2ME_EUR_30J_SPMED=
BIT2ME_EUR_30J_SPP90=
BIT2ME_EUR_30J_D10=
BIT2ME_EUR_30J_D50=
BIT2ME_EUR_COM_SPMED=
BIT2ME_EUR_COM_D10=
BIT2ME_EUR_COM_D50=
# Bullish BTC/EURCV (nouvelle : 1re paire EURCV en volume)
BULLISH_BTC_30J_N=
BULLISH_BTC_30J_SPMOY=
BULLISH_BTC_30J_SPMED=
BULLISH_BTC_30J_SPP90=
BULLISH_BTC_30J_D10=
BULLISH_BTC_30J_D50=
BULLISH_BTC_COM_SPMED=
BULLISH_BTC_COM_D10=
BULLISH_BTC_COM_D50=
# ===== B. EURC, mêmes exchanges (si CoinWatch couvre l’EURC) =====
# Kraken EURC/EUR
EURC_KRAKEN_EUR_COM_SPMED=
EURC_KRAKEN_EUR_COM_D10=
EURC_KRAKEN_EUR_COM_D50=
# Kraken EURC/USD
EURC_KRAKEN_USD_COM_SPMED=
EURC_KRAKEN_USD_COM_D10=
EURC_KRAKEN_USD_COM_D50=
# Kraken EURC/USDC
EURC_KRAKEN_USDC_COM_SPMED=
EURC_KRAKEN_USDC_COM_D10=
EURC_KRAKEN_USDC_COM_D50=
# Bitstamp EURC/EUR
EURC_BITSTAMP_EUR_COM_SPMED=
EURC_BITSTAMP_EUR_COM_D10=
EURC_BITSTAMP_EUR_COM_D50=
# Bitstamp EURC/USDC
EURC_BITSTAMP_USDC_COM_SPMED=
EURC_BITSTAMP_USDC_COM_D10=
EURC_BITSTAMP_USDC_COM_D50=
# Bitvavo EURC/EUR
EURC_BITVAVO_EUR_COM_SPMED=
EURC_BITVAVO_EUR_COM_D10=
EURC_BITVAVO_EUR_COM_D50=
# Bullish EURC/USDC
EURC_BULLISH_USDC_COM_SPMED=
EURC_BULLISH_USDC_COM_D10=
EURC_BULLISH_USDC_COM_D50=
# Bit2Me EURC/EUR
EURC_BIT2ME_EUR_COM_SPMED=
EURC_BIT2ME_EUR_COM_D10=
EURC_BIT2ME_EUR_COM_D50=
# Bullish BTC/EURC
EURC_BULLISH_BTC_COM_SPMED=
EURC_BULLISH_BTC_COM_D10=
EURC_BULLISH_BTC_COM_D50=
# ===== C. EURC, marchés sans EURCV (si CoinWatch couvre l’EURC) =====
# Coinbase EURC/USDC
EURC_COINBASE_USDC_COM_SPMED=
EURC_COINBASE_USDC_COM_SPMOY=
EURC_COINBASE_USDC_COM_D10=
EURC_COINBASE_USDC_COM_D50=
# OKX EURC/USDC
EURC_OKX_USDC_COM_SPMED=
EURC_OKX_USDC_COM_SPMOY=
EURC_OKX_USDC_COM_D10=
EURC_OKX_USDC_COM_D50=
# Upbit EURC/KRW
EURC_UPBIT_KRW_COM_SPMED=
EURC_UPBIT_KRW_COM_SPMOY=
EURC_UPBIT_KRW_COM_D10=
EURC_UPBIT_KRW_COM_D50=
# Bithumb EURC/KRW
EURC_BITHUMB_KRW_COM_SPMED=
EURC_BITHUMB_KRW_COM_SPMOY=
EURC_BITHUMB_KRW_COM_D10=
EURC_BITHUMB_KRW_COM_D50=
```

Avant de répondre, vérifie : chaque spread est en bps (un marché liquide est entre 0,5 et 20 bps, jamais 0,0003 ni 300), chaque profondeur en EUR, et D10 ≤ D50 pour chaque paire et chaque période.
