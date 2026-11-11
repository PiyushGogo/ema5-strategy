# Results log

## 5 EMA on Sensex and Nifty: no edge found (Nov 2026)

**Classic rules, Jan 2025 → Oct 2026** (1 lot; delta 0.5; ₹50 charges; no slippage):

| | Sensex | Nifty |
|---|---|---|
| Profit factor, all trades | 0.97 | 0.97 |
| Net P&L | −₹37,745 | −₹35,281 |
| Max drawdown | ₹1,75,049 | ₹1,48,178 |
| Worst losing streak | 19 | 21 |
| PE side (5-min) PF | 1.04 (~₹22/trade) | 1.03 (~₹15/trade) |
| CE side (15-min) PF | 0.85 | 0.87 |
| Trades/day | ~4 | ~4 |

**Optimiser** (288 combinations, train 2025, test Jan–Oct 2026, ₹1/unit slippage):
- The best 2025 combinations reached PF 1.15–1.36 on both indices.
- On 2026 they fell to PF 0.77–1.08. **0 of the top 10 stayed above 1.1 on both indices.**
- The "improved" versions were no better than the classic rules in 2026 (classic: 0.97 / 1.02).
- PE-only + 15-min 50 EMA trend filter + max 2/day roughly halved the drawdown, but did not make it profitable.

**Verdict:** don't trade it. The improvements found on 2025 were overfitting. Keep this repo for honestly testing other ideas: tune on one period, then check on unseen data and on both indices.
