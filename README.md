# Pump.fun Replay Sprint — Dip-Buy Paper Bot

A paper-trading bot for the make.fun **Pump.fun Replay Sprint** competition
(`u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`). It trades 10 SOL of
paper money on a 24h replay of recorded pump.fun bonding-curve activity, under
the `agent-fun/replay/v2` protocol. No real money, no network, no API keys.

## Strategy: buy the dip inside an uptrend

Most pump.fun coins bleed to zero, so the bot never chases a launch and never
buys a fresh pump. It waits for a coin that already proved it can attract
buyers, then buys the dip:

- **Dip:** price pulled back **18–25%** from its 1500-slot recent high —
  deeper than a noise wobble, shallower than a collapse.
- **Regime filter:** the longer trend (3000 slots) is still up — price above
  its trend-window start, or net SOL flow over the window is positive — and
  money is flowing into pump.fun overall (aggregate net SOL flow over the
  last 300 slots is positive).
- **Buyers stepping back in:** at least 6 of the last 8 trades are buys from
  at least 3 distinct wallets, net flow over the last 60 slots is positive,
  and the latest trade is a buy.
- **Quality gates:** coin at least 500 slots old, real SOL reserve 3–80 SOL,
  one entry per coin ever (re-entries chased dead coins in testing), 300-slot
  cooldown after an exit.

**Sizing:** first buy 0.15 SOL, adds of 0.05 SOL while the price recovers above
entry and flow stays positive, at most 0.25 SOL per position and 4 main
positions at once (the 5th slot is kept for guardrail probes).

**Exits (first trigger wins):** take profit +18% of cost, stop loss −6%,
trailing stop −12% from the peak once +8% up, max hold 1500 slots (~5 min),
or net flow fading below −1 SOL over 60 slots. Curves that complete are
closed by the replay itself.

**Guardrail backstop:** the run must end with round trips of ≥ 0.01 SOL on at
least 20 coins. If filled coins or fills lag the pace (30 coins / 150 fills
over 6h of block time), the bot opens tiny 0.02 SOL probe round trips on
liquid coins and sells them as soon as the buy lands.

## Local results (dev window, `grade-local --driver process`)

| | |
|---|---|
| Net PnL | **+0.195 SOL** (return +1.95%, 90% interval −0.23…+0.75 SOL) |
| Fills / coins / round trips | 238 / 63 / 99 |
| Win rate | 13.1% (avg win ≫ avg loss: a few runners pay for many small stops) |
| Max drawdown | 0.015 |
| Fees | 0.193 SOL curve + 0.026 SOL tx (at 2x fees: −0.024 SOL) |
| Guardrails | met (63 coins with a round trip ≥ 0.01 SOL, drawdown ok) |
| Determinism | L1 regrade reproduced byte for byte |

Stress (10 rebuilt copies of the dev window): median −0.42 SOL, 9 of 10
copies lost money — the score leans on this window's own coins, as the
kit warns. The profit is concentrated (top 3 coins made 72% of the gains;
without them −0.21 SOL), which is the normal shape of this market. The
entry band was chosen by sweeping it and its neighbours on the full dev
window and keeping a flat, broadly profitable region rather than a single
best cell. For reference, the kit's own pilots score far worse on the same
window: momentum −9.39 SOL, reversion −4.02 SOL.

## Layout

- `main.ts` — the wire: reads `hello` / `batch` / `done` NDJSON on stdin,
  answers each batch with exactly one `reply` line on stdout, owns the
  account state and validates every order before sending it.
- `strategy.ts` — the strategy (see above); a pure function of the batches,
  no clock, no randomness, no I/O, so the two graded executions produce
  byte-identical action logs.
- `LICENSE` — MIT.

## Run it

```sh
node main.ts            # Node 22: types are stripped, no build, no deps
```

The grader runs `node /bot/main.ts` with the repository mounted at `/bot`.
To grade locally against the kit's dev window:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Fees the bot prices in

Curve fees 95 bps protocol + 30 bps creator per side, plus 105,000 lamports
of tx fees per order. A round trip therefore costs ~2.5% of the traded value
plus 210,000 lamports, which is why positions are small, stops are tight, and
the bot never overtrades.

## Determinism and limits

- The bot reads nothing from the clock, the environment, or `Math.random`;
  every decision is a function of the batches the harness sends, so two runs
  on the same window produce byte-identical action logs.
- At most 5 open positions, at most 16 orders per batch, buys capped at 1%
  of a coin's real SOL reserve per batch, no shorts, no leverage.
- Diagnostics go to stderr only; stdout carries replies and nothing else.
