# 5 EMA strategy: backtester

A standalone backtester for the **5 EMA strategy** on Sensex / Nifty. It is separate from Risk Guard: no shared code, no shared rules.
It answers one question: **would this strategy have made money on real past data?**

## The rules tested (on the INDEX chart)

| | Sell side → buy a **PE** | Buy side → buy a **CE** |
|---|---|---|
| Chart | 5-minute | 15-minute |
| Alert candle | Completed candle **fully above** the 5 EMA (low > EMA) | Completed candle **fully below** the 5 EMA (high < EMA) |
| Entry | A later candle trades **below** the alert candle's low | A later candle trades **above** the alert candle's high |
| Stop | Alert candle's high | Alert candle's low |
| Target | 3 × risk (1:3) | 3 × risk (1:3) |

A newer qualifying candle replaces the alert candle. Alerts don't carry over to the next day. One trade at a time.

## How it simulates (conservative on purpose)
- Uses **1-minute candles** for fills; the 5- and 15-minute charts are built from them (aligned to 09:15).
- Entry fills at the alert level, or at the open if price gapped through it.
- In the entry minute only the stop is checked. If one minute touches both stop and target, **the stop is assumed first**.
- A stop gapped through fills at the worse open price. Open trades close at `exitTime` (15:15).
- **Option P&L is an estimate:** index points × `optionDelta` (0.5, roughly ATM) × quantity − ₹50 charges. It ignores time decay and slippage, so real option-buying results will be **worse** than shown.

## Run it

Node 22+.

```bash
npm install && npm run build && npm test
```

You need an Upstox access token. Either set it for the run:

```bash
UPSTOX_ACCESS_TOKEN=your_token npm run backtest -- --index SENSEX --from 2026-05-01 --to 2026-10-31
```

or point at a token file (a JSON with `accessToken`, e.g. the one Risk Guard's `npm run login` saves):

```bash
npm run backtest -- --index SENSEX --from 2026-05-01 --to 2026-10-31 --token-file ../risk-guard/data/token.json
```

Options:
- `--index SENSEX|NIFTY` (default SENSEX)
- `--from / --to YYYY-MM-DD` (default: the last 6 months)
- `--sides PE`, `--sides CE` or `--sides PE,CE` (default both)
- `--lot N` overrides the lot size from `config.json` (**check the current Nifty lot size**; NSE has changed it more than once)

Upstox 1-minute history starts in January 2022. Candles are cached in `data/candles/`, so re-runs are instant.

## What you get
- A summary table (all trades, PE side, CE side): trades, win %, net P&L, average win and loss, profit factor, max drawdown, worst losing streak, and average and max ₹ risk per trade.
- A month-by-month table and the average number of trades per day.
- `reports/ema5-<index>-<from>-<to>.csv` with every trade (times in IST), so you can check any trade on a chart.

## Reading the result honestly
- **Profit factor above ~1.3 over 12+ months,** after charges, is the minimum to take seriously. Below 1.0 means it loses money.
- **Check the worst losing streak and max drawdown**, not just the net P&L. Could you sit through them?
- **Max risk:** with the strategy's own stop, a big alert candle means a big loss. Compare it with what you're willing to lose on one trade.
- Test different periods (e.g. 2023, 2024, 2025 separately). A strategy that only works in one period is luck.

## Config (`config.json`)
| Key | Default | Meaning |
|---|---|---|
| `emaPeriod` | 5 | EMA length |
| `sellTimeframeMin` / `buyTimeframeMin` | 5 / 15 | Chart for the PE side / CE side |
| `rewardRisk` | 3 | Target = 3 × risk |
| `entryWindow` | 09:15–15:00 | When new entries are allowed |
| `exitTime` | 15:15 | Close any open trade |
| `optionDelta` | 0.5 | Index-to-option move (ATM ≈ 0.5) |
| `chargesPerTrade` | 50 | ₹ per round trip |
| `lots`, `lotSize` | 1; SENSEX 20, NIFTY 65 | Quantity = lots × lot size |

## Next (after a good backtest)
Live Telegram alerts when a signal triggers. You still place the trade yourself.
