# Zama Protocol due diligence — SG-FORGE angle

Oct 5, 2026 · @Ethan

## Summary

**Verdict: credible technology, already in production on Morpho; a real opportunity for SG-FORGE, held back by a regulatory risk that must be cleared before any broad rollout.**

- **What it is**: an FHE confidentiality layer on Ethereum, live since 30 December 2025. Balances and amounts are encrypted, addresses stay visible, and access rules are set by the issuer.
- **Traction**: 16 confidential vaults on Morpho since September 2026; the first cUSDC vault grew from 0 to $40M in 7 weeks. No euro stablecoin is among them.
- **Edge for SG-FORGE**: Flowdesk and Steakhouse, already EURCV partners, work with Zama. A cEURCV would be the first confidential euro in DeFi.
- **Main risk**: from July 2027, the AMLR (Art. 79) bars CASPs from assets with anonymisation features, even optional ones. A "confidential but identifiable" design needs legal validation.
- **Key technical risk**: confidentiality rests on a single key split across 13 third-party operators; a compromise would be retroactive.
- **Recommendation**: a capped pilot of an official cEURCV (ERC7984Rwa, KYC, observer access) on an existing Morpho vault, after a legal opinion and a discussion with the ACPR.

## 1. How it works (briefly)

Zama is neither an L1 nor an L2: it is a confidentiality layer on top of existing chains (live on Ethereum since 30 December 2025). Balances and amounts are encrypted with FHE (fully homomorphic encryption), while contracts stay on Ethereum and composable with the rest of DeFi.

**How it runs.** The contract on Ethereum only handles pointers ("handles") to ciphertexts. The actual FHE computation is offloaded off-chain, and the decryption key never exists in one piece.

| Component | Role | Trust assumption |
| --- | --- | --- |
| Host chain (Ethereum) | Hosts confidential contracts; emits an event for each FHE operation | Ethereum security |
| Coprocessors (5 operators) | Run the FHE computation, store ciphertexts, relay the ACL | Majority consensus; anyone can recompute |
| KMS (13 MPC nodes) | Holds the decryption key in shares; decrypts on authorised request | 2/3 threshold, robust up to 1/3 malicious nodes; AWS Nitro enclaves |
| Gateway | Dedicated Arbitrum rollup orchestrating input proofs, decryptions and bridging; fees in $ZAMA | Run by the protocol |
| ACL | On-chain registry of "who can decrypt what" | Issuer's contract logic |
| ZKPoK | Proves an encrypted input is well formed | Lightweight proof, generated client-side |

**Token side: the ERC-7984 standard**, co-authored by Zama and OpenZeppelin. Two issuance modes:

- **Wrapper**: an existing ERC-20 (e.g. EURCV) is deposited and converted into a confidential version; the underlying stays intact and redeemable.
- **Native**: a token issued directly as confidential, with no public twin.

The audited extensions cover a regulated issuer's needs: blocklist/allowlist, freezing amounts, force-transfer by an agent, pause, and **"observer" access** for a regulator or auditor. This is the key idea: compliance is coded into the issuer's contract, not into the protocol.

**Performance and cost.** Around 20 TPS on CPU today; Zama targets 500 to 1,000 TPS per chain with GPUs by end-2026. A confidential transfer costs $0.008 to $0.80 in protocol fees depending on the subscription (about $0.13 observed on the first cUSDT transfer).

### Infrastructure: who runs what

Four groups of named operators run the protocol (genesis list at mainnet launch). Zama itself runs a node in both the coprocessor and KMS sets, and hosts the default relayer.

&#91;embedded content: Zama Protocol infrastructure · operators and flows\]

- **Coprocessors (5 operators).** They listen to Ethereum, run the FHE computation, verify input proofs and store ciphertexts. The Gateway only accepts a result signed by a majority; operators are staked and slashable.
- **KMS (13 MPC nodes).** They hold the decryption key in shares inside AWS Nitro enclaves and decrypt only what the ACL allows. A quorum must cooperate (9 of 13 in Zama's example); key shares are also backed up with independent custodians.
- **Gateway (dedicated Arbitrum rollup).** The switchboard: it keeps a copy of the ACL, collects coprocessor signatures and forwards decryption requests to the KMS. It holds no keys or plaintext. The docs do not say who runs its sequencer: a question for the DD list.
- **Relayer and oracle.** Convenience services, run by Zama by default. They are untrusted (they can delay a request, not forge it) and anyone can run their own.
- **Governance.** Operators vote one-per-operator in an Aragon DAO on Ethereum; a simple majority currently decides upgrades, operator elections, slashing and key rotation. Any single operator can pause decryptions and input verification; unpausing takes a vote.

For SG-FORGE, the real trust boundary is the KMS quorum and the operator DAO, not Zama alone; but Zama sits in every group. Sources: [Coprocessor](https://docs.zama.org/protocol/protocol/overview/coprocessor), [Gateway](https://docs.zama.org/protocol/protocol/overview/gateway), [KMS](https://docs.zama.org/protocol/protocol/overview/kms), [Relayer & Oracle](https://docs.zama.org/protocol/solidity-guides/v0.10/docs/protocol/architecture/relayer_oracle), [Governance](https://docs.zama.org/protocol/protocol-apps/governance/governance), [Pausing](https://docs.zama.org/protocol/protocol-apps/governance/pausing).

## 2. Risks and limitations

The FHE cryptography itself is the strongest link (128-bit, post-quantum, audited TFHE-rs library). The risks lie elsewhere: key management, operations and, above all, regulation.

**Technical view (short)**

- **Single global key.** All ciphertexts in the protocol sit under the same public key, to stay composable. Collusion by a qualified majority of the 13 KMS nodes, combined with bypassing the AWS Nitro enclaves, would expose the entire history. Because ciphertexts stay public on Ethereum, a future compromise would be retroactive.
- **Computation integrity.** The 5 coprocessors vote by majority; verification is "optimistic" (anyone can recompute). Zero-knowledge proofs of FHE computation (ZK-FHE) are not yet in production.
- **Availability.** Any operator can pause the protocol in an emergency. Without the Gateway and KMS, nothing can be decrypted or unwrapped: funds are stuck for the duration of the incident.
- **Partial confidentiality.** Amounts and balances are encrypted, but addresses and timing are not. Wrapper entries and exits (EURCV → cEURCV) are public: with few users, positions remain linkable.
- **Limited composability.** Morpho "hybrid" vaults hide the depositor, not the underlying market mechanics (prices, liquidations). Fully confidential borrowing has not been demonstrated.
- **Maturity.** Mainnet is 9 months old, ERC-7984 is still a draft, and throughput is around 20 TPS. About 70 audit-weeks announced (Trail of Bits, Zenith) plus OpenZeppelin audits of the confidential contracts; no public incident found to date.
- **Post-quantum gaps.** The ZKPoK and Ethereum signatures are not post-quantum.

**High-level summary**

| Risk | Level | Mitigants |
| --- | --- | --- |
| Regulatory (AMLR Art. 79, MiCA Art. 76(3)) | High | "Confidential but identifiable" model: visible addresses, issuer/regulator observer access. Interpretation to secure before July 2027 |
| Key compromise (KMS collusion) | Medium, high impact | 13 known operators (Ledger, Fireblocks, OpenZeppelin, Figment…), MPC + enclaves; 100 nodes targeted |
| External governance | Medium | Pause and blacklist decided by third-party operators, not SG-FORGE; Swiss entity (Zug) |
| Availability / temporary lock-up | Medium | Emergency pause; depends on Gateway and KMS |
| Smart contracts and maturity | Medium | Multiple audits, OpenZeppelin standard, gradual ramp-up |
| Residual leakage (addresses, timing) | Low to medium | Shrinks as the user base grows |
| Cost and performance | Low | $0.01 to $0.80 per transfer; GPUs by end-2026 |

The hard point for a bank issuer is regulatory. From 10 July 2027, the AMLR (Art. 79) bars CASPs from holding accounts in "anonymity-enhancing coins", including where anonymisation is optional. A cEURCV designed with observer access and a KYC allowlist is not anonymous, but this reading must be confirmed by a legal opinion and discussions with the ACPR and AMF.

## 3. SG-FORGE view: EURCV/USDCV issuer deployed on Morpho

Zama is already plugged into Morpho, alongside two SG-FORGE partners, but with no euro stablecoin. A cEURCV would be the first confidential euro in DeFi.

**SG-FORGE starting point.** An e-money institution and registered digital asset service provider in France, SG-FORGE has issued EURCV since April 2023, alongside USDCV. EURCV runs on Ethereum, Solana, Stellar and XRPL; it was the second-largest euro stablecoin after EURC in February 2026. Since September 2025, EURCV and USDCV can be lent and borrowed on Morpho (vaults curated by MEV Capital, collateral in ETH, BTC and Spiko tokenised money market funds). Flowdesk makes markets; Safe and Deblock distribute yield through a Steakhouse vault.

**What Zama has already shipped on Morpho**

| Date | Milestone | Relevance to SG-FORGE |
| --- | --- | --- |
| Sept. 2026 | 16 confidential vaults, 5 curators (Steakhouse, Armitage/Wintermute, Flowdesk, RockawayX, Bitwise), assets USDC, USDT, WBTC, AUSD, tGBP; Zama Swap launched | Flowdesk and Steakhouse are already SG-FORGE partners; no euro on the list |
| July 2026 | Elliptic partnership: wallet screening before each transaction | Reusable AML building block |
| June 2026 | Confidential Steakhouse USDC Prime vault: 0 to $40M TVL in 7 weeks | Evidence of institutional demand |
| Dec. 2025 | Ethereum mainnet, first cUSDT transfer | Technical foundation |

The closest precedent is tGBP: a regulated sterling stablecoin (BCP Technologies, FCA-registered) joined the vault suite in September.

**Two ways in, not to be confused**

- **"Hybrid" wrapper on an existing vault.** The depositor brings EURCV and receives a confidential position; strategy, liquidity and risk stay those of the public vault. Fast, but SG-FORGE does not control the wrapper's rules.
- **Official cEURCV issued by SG-FORGE (ERC7984Rwa).** SG-FORGE keeps the agent role: KYC allowlist, freeze, force-transfer, pause, and observer access for its compliance team and the supervisor. This is the only option consistent with a "not anonymous" reading under the AMLR.

Top check: can a third party already deploy a cEURCV wrapper through Zama's public registry without SG-FORGE? If so, it is better to publish the official wrapper before someone else does.

**Canton is not a substitute.** SG-FORGE has been deploying EURCV and USDCV on Canton since May 2026 for collateral and repo, on a permissioned network where confidentiality is native. Zama brings confidentiality to public Ethereum, where Morpho and DeFi liquidity sit: the two are complementary.

## 4. Potential use cases

The first use case reuses building blocks already in production; the others depend on protocol maturity and regulatory clearance.

| # | Use case | For whom | What confidentiality adds | Maturity |
| --- | --- | --- | --- | --- |
| 1 | **Confidential EURCV / USDCV Morpho vault** (confidential version of an existing Steakhouse or MEV Capital vault) | Corporate treasuries, funds, family offices | EUR yield without revealing size or strategy | High: same model as cUSDC, tGBP |
| 2 | **Treasury and B2B payments in cEURCV** (suppliers, intragroup, payroll) | SG corporate clients | Amounts and balances hidden from competitors; SG-FORGE keeps full visibility | Medium: depends on wallets and custody |
| 3 | **Confidential cEURCV ↔ cUSDCV swap** via Zama Swap, Flowdesk liquidity | FX desks, market makers, corporates | No front-running; intent and size hidden | Medium: Zama Swap launched Sept. 2026 |
| 4 | **Confidential DvP settlement** of tokenised bonds against cEURCV (CMTAT Confidential already audited) | SG-FORGE issuers and investors | Private cap table and amounts on a public chain | Low to medium: young standards, trade-off with Canton |
| 5 | **Retail / neobank distribution** (Deblock-style) with private balances; Merkl incentives on encrypted balances | Retail clients | No more public-by-default balances | Low: highest AMLR exposure |
| 6 | **Borrower-side confidential lending** (borrowing EURCV against EUTBL/USTBL without exposing the position) | Institutions | Private leverage positions | Low: confidential liquidations not demonstrated |

Use case 1 is also the easiest to defend to the supervisor: a KYC allowlist, SG-FORGE observer access and a TVL cap are enough to show the asset stays traceable by the issuer.

## 5. Recommendation and next steps

Recommendation: a controlled pilot of an official cEURCV on a Morpho vault, conditional on an AMLR/MiCA legal opinion. No broad commitment before the 2027 regulatory picture is clear.

1. **Legal framing**: opinion on AMLR Art. 79 and MiCA Art. 76(3) as applied to a confidential but identifiable EMT; early presentation to the ACPR and AMF.
2. **Token design**: cEURCV issued by SG-FORGE as ERC7984Rwa, with KYC allowlist, SG-FORGE and supervisor observer access, freeze and force-transfer.
3. **Pilot**: one confidential EURCV vault with an already-integrated curator (Steakhouse or MEV Capital), capped TVL, invited clients only.
4. **Scale-up criteria**: no incidents, client feedback, clear regulatory position, expanded KMS.

**Due diligence questions for Zama**

- [ ] Who exactly are the 13 KMS operators, in which jurisdictions, and what collusion threshold allows decryption?
- [ ] Response plan for a key compromise: rotation, re-encryption, notification?
- [ ] Can an issuer get a dedicated key or KMS, or is it necessarily on the global key?
- [ ] Can a third party deploy a cEURCV wrapper without SG-FORGE's consent?
- [ ] Effect of an operator-decided pause or blacklist on an SG-FORGE token; availability SLA for decryption?
- [ ] Full audit reports (Trail of Bits, Zenith, OpenZeppelin) and open findings?
- [ ] How is the Travel Rule (TFR) handled when amounts are encrypted?
- [ ] Actual per-transfer cost at volume, and need for a Zama commercial licence outside the protocol?

## Sources

- [Zama Protocol Litepaper](https://docs.zama.org/protocol/zama-protocol-litepaper) (architecture, security, operators, fees)
- [Zama: testnet update and audits](https://www.zama.org/post/zama-protocol-testnet-update-mpc-partners-better-performance-audits-and-new-features)
- [Zama: ERC-7984 explained](https://www.zama.org/post/erc-7984-the-confidential-token-standard-explained)
- [OpenZeppelin: Confidential Contracts 0.3.0 audit](https://www.openzeppelin.com/news/zama-confidential-contracts-0.3.0-release-audit)
- [OpenZeppelin: CMTAT Confidential audit](https://www.openzeppelin.com/news/cmtat-confidential-audit)
- [Zama, Morpho and Steakhouse: cUSDC vault (June 2026)](https://chainwire.org/2026/06/18/zama-launches-usdc-confidential-lending-in-partnership-with-morpho-and-steakhouse-financial/)
- [Zama: expansion to 16 Morpho vaults (Sept. 2026)](https://dailyhodl.com/2026/09/17/zama-opens-confidential-access-to-defis-existing-yield-venues/)
- [Zama and Elliptic (July 2026)](https://www.zama.org/post/zama-partners-with-elliptic-to-make-confidential-finance-compliant-by-design)
- [SG-FORGE: DeFi deployment on Morpho and Uniswap](https://www.sgforge.com/sgf-deploys-eurcv-usdcv-in-dex/)
- [Morpho: SG-FORGE on Morpho](https://morpho.org/blog/societe-generale-forge-comes-onchain-with-morpho/)
- [Safe: Steakhouse EURCV vault](https://forum.safefoundation.org/t/safe-wallet-adds-euro-yield-via-sg-forges-eurcv-on-morpho/6939)
- [Ledger Insights: EURCV on XRPL](https://www.ledgerinsights.com/socgen-forge-goes-live-with-eurcv-stablecoin-on-xrp-ledger/)
- [SG-FORGE on Canton (May 2026)](https://www.gncrypto.news/news/societe-generale-launches-eurcv-usdcv-canton-network/)
- [AMLR Art. 79: overview](https://blockspot.io/are-privacy-coins-being-banned-in-europe/)
