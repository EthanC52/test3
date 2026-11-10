# Prompt à coller dans GPT (PC du bureau)

Copie tout ce qui suit la ligne, puis joins les fichiers CSV CoinWatch.

---

Tu es analyste de données de marché. Je te fournis des fichiers CSV bruts exportés de CoinWatch : carnets d'ordres du stablecoin **EURCV** sur plusieurs exchanges, un point toutes les 4 heures environ, sur 30 jours. Pour chaque point : profondeur à 10, 25, 50, 100 et 200 bps, et spread. Ton travail : nettoyer ces données, calculer quelques agrégats précis et me les rendre dans un gabarit fixe que je recopierai à la main. N'invente jamais une valeur : si elle ne peut pas être calculée, écris `NA`.

## 1. Comprendre les fichiers (avant tout calcul)

Dis-moi en 5 lignes maximum :
- quelles colonnes correspondent à : horodatage, exchange, paire, spread, profondeur à 10, 25, 50, 100, 200 bps ;
- le fuseau horaire des horodatages (UTC ou heure de Paris ? Paris est passée de UTC+2 à UTC+1 le 25/10/2026) ;
- si la profondeur est donnée **par côté** (bid et ask séparés) ou **en total**, et dans quelle devise (USD, EUR ou unités d'EURCV) ;
- l'unité du spread : ratio (0,0003), pourcentage (0,03 %) ou bps (3).
Si un point reste ambigu malgré les noms de colonnes et les ordres de grandeur, pose-moi la question avant de continuer.

## 2. Nettoyer

- Convertis tous les horodatages en **UTC**. Supprime les doublons exacts.
- **Spread → points de base (bps)** : 1 bp = 0,01 %. Ratio 0,0003 = 3 bps ; 0,03 % = 3 bps.
- **Profondeur → EUR, total bid + ask** :
  - si elle est donnée par côté, additionne bid et ask pour chaque point ;
  - 1 EURCV = 1 EUR ;
  - USD → EUR : divise par le taux BCE du jour (USD pour 1 EUR ; week-end et jours fériés : dernier taux publié) :
    08/10 1.1186 ; 09/10 1.1206 ; 12/10 1.1181 ; 13/10 1.1188 ; 14/10 1.1195 ; 15/10 1.1208 ; 16/10 1.1253 ; 19/10 1.1225 ; 20/10 1.1215 ; 21/10 1.1234 ; 22/10 1.1205 ; 23/10 1.1193 ; 26/10 1.1188 ; 27/10 1.115 ; 28/10 1.1133 ; 29/10 1.113 ; 30/10 1.1172 ; 02/11 1.1216 ; 03/11 1.1179 ; 04/11 1.1267 ; 05/11 1.1224 ; 06/11 1.1165 ; 09/11 1.1193 ; 10/11 1.1214
- Écarte les points invalides (spread négatif ou nul, carnet vide) et compte-les. Ne corrige pas les valeurs extrêmes, mais signale-les : spread > 100 bps, ou profondeur à ±10 bps plus de 10 fois au-dessus de sa médiane.

## 3. Les 8 paires à traiter (EURCV uniquement)

| Code | Exchange | Paire |
|---|---|---|
| `KRAKEN_EUR` | Kraken | EURCV/EUR (listée le 03/11/2026 seulement) |
| `KRAKEN_USD` | Kraken | EURCV/USD (listée le 03/11/2026 seulement) |
| `KRAKEN_USDC` | Kraken | EURCV/USDC (listée le 03/11/2026 seulement) |
| `BITSTAMP_EUR` | Bitstamp | EURCV/EUR |
| `BITSTAMP_USDC` | Bitstamp | EURCV/USDC |
| `BITVAVO_EUR` | Bitvavo | EURCV/EUR |
| `BULLISH_USDC` | Bullish | EURCV/USDC |
| `BIT2ME_EUR` | Bit2Me | EURCV/EUR |

Ignore toutes les autres paires (crypto, USDT, USDCV…). Si une des 8 paires est absente des fichiers, mets `NA` partout pour elle et signale-le.

## 4. Deux périodes

- **30J** : toute la période disponible (environ 30 jours).
- **COM** : du **26/10/2026 00:00 UTC au 09/11/2026 12:00 UTC** inclus. C'est la période où j'ai déjà les mêmes mesures pour l'EURC : elle sert à comparer à conditions égales. Pour Kraken, elle commence de fait le 03/11.

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

**Partie B** : recopie **exactement** le gabarit ci-dessous, dans le même ordre, en complétant chaque ligne après le `=`. Ne change ni l'ordre ni les noms. Pas de séparateur de milliers. Mets les dates au format `2026-10-11 08:00`.

```
# Période 30 jours
DEBUT_30J=
FIN_30J=
# Kraken EURCV/EUR (depuis le 03/11)
KRAKEN_EUR_30J_N=
KRAKEN_EUR_30J_SPMOY=
KRAKEN_EUR_30J_SPMED=
KRAKEN_EUR_30J_SPP90=
KRAKEN_EUR_30J_D10=
KRAKEN_EUR_30J_D50=
KRAKEN_EUR_COM_SPMED=
KRAKEN_EUR_COM_D10=
KRAKEN_EUR_COM_D50=
# Kraken EURCV/USD (depuis le 03/11)
KRAKEN_USD_30J_N=
KRAKEN_USD_30J_SPMOY=
KRAKEN_USD_30J_SPMED=
KRAKEN_USD_30J_SPP90=
KRAKEN_USD_30J_D10=
KRAKEN_USD_30J_D50=
KRAKEN_USD_COM_SPMED=
KRAKEN_USD_COM_D10=
KRAKEN_USD_COM_D50=
# Kraken EURCV/USDC (depuis le 03/11)
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
# Bit2Me EURCV/EUR
BIT2ME_EUR_30J_N=
BIT2ME_EUR_30J_SPMOY=
BIT2ME_EUR_30J_SPMED=
BIT2ME_EUR_30J_SPP90=
BIT2ME_EUR_30J_D10=
BIT2ME_EUR_30J_D50=
BIT2ME_EUR_COM_SPMED=
BIT2ME_EUR_COM_D10=
BIT2ME_EUR_COM_D50=
```

Avant de répondre, vérifie : chaque spread est en bps (un marché liquide est entre 0,5 et 20 bps, jamais 0,0003 ni 300), chaque profondeur en EUR, et D10 ≤ D50 pour chaque paire et chaque période.
