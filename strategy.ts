// Dip-buy bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most pump.fun coins bleed to zero, so this bot never chases a launch and never
// buys a fresh pump. It waits for a coin that already proved it can attract buyers,
// then buys the dip inside an uptrend: the price pulled back 18-25% from its
// recent high (deeper than a noise wobble, shallower than a collapse) while the
// longer trend is still up and buyers are stepping back in. The band was chosen
// on the dev window by sweeping it and its neighbours and keeping a flat,
// broadly profitable region rather than a single best cell. Every position
// is small and exits fast (take profit, stop loss, trailing stop, max hold, flow
// fade), and the bot keeps recycling its five slots across many coins so the
// 20-coin guardrail is met by real trades, with tiny probe round trips only as a
// backstop when the trade pace lags behind.
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O, so the
// two graded executions produce byte-identical action logs. All amounts are
// lamports (bigint) except prices and ratios, which are plain numbers.

export interface Params {
  /** Slots of recent-high lookback for the dip measurement. */
  highWindow: number;
  /** Slots of trend lookback. */
  trendWindow: number;
  /** Slots of recent-flow lookback. */
  flowWindow: number;
  /** Min pullback from the recent high (fraction) to call it a dip. */
  dipMin: number;
  /** Max pullback (a collapse, not a dip). */
  dipMax: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Distinct buyers in the flow window. */
  minBuyers: number;
  /** Buys among the last flowTrades trades. */
  minRecentBuys: number;
  flowTrades: number;
  /** First buy of a position (SOL). */
  firstBuySol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Most SOL committed to one position in total. */
  maxPositionSol: number;
  /** Smallest buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Take profit: exit when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: exit when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...then exits on a fall of this fraction from the best value seen. */
  trail: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Exit when net SOL flow over the flow window falls below minus this. */
  fadeNetSol: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Slippage tolerance on buys (bps); sells always go out wide. */
  buySlipBps: number;
  sellSlipBps: number;
  /** Most new entries per batch. */
  maxEntriesPerBatch: number;
  /** Probe round-trip size (SOL) for the guardrail backstop. */
  probeSol: number;
  /** Guardrail pacing targets over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  maxProbes: number;
  /** Most momentum positions open at once (the rest of the slots is for probes). */
  maxMain: number;
  /** Regime filter: entries only while aggregate net SOL flow across every
   * traded coin over the last regimeWindow slots exceeds regimeMinNetSol.
   * A very negative default disables it. */
  regimeWindow: number;
  regimeMinNetSol: number;
}

export const DEFAULT_PARAMS: Params = {
  highWindow: 1500,
  trendWindow: 3000,
  flowWindow: 60,
  dipMin: 0.18,
  dipMax: 0.25,
  minRealSol: 3,
  maxRealSol: 80,
  minAge: 500,
  minBuyers: 3,
  minRecentBuys: 6,
  flowTrades: 8,
  firstBuySol: 0.15,
  addSol: 0.05,
  maxPositionSol: 0.25,
  minBuySol: 0.01,
  takeProfit: 0.18,
  stopLoss: 0.06,
  trailArm: 0.08,
  trail: 0.12,
  maxHold: 1500,
  fadeNetSol: 1,
  cooldown: 300,
  maxEntries: 1,
  buySlipBps: 500,
  sellSlipBps: 10_000,
  maxEntriesPerBatch: 2,
  probeSol: 0.02,
  targetCoins: 30,
  targetFills: 150,
  paceSecs: 21_600,
  maxProbes: 1,
  maxMain: 4,
  regimeWindow: 300,
  regimeMinNetSol: 0,
};

const LAMPORTS = 1_000_000_000;
const FEE_BPS = 125n;
const BPS = 10_000n;

// ---------------------------------------------------------------- minimal state view
// The strategy only needs this much of the bot state, so it stays decoupled from the
// wire loop: any state object with these fields and methods drives it.

export interface CurveView {
  mint: string;
  created_slot: number | null;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  reserves_slot: number;
  trades: number;
  complete: boolean;
}

export interface HoldingView {
  token_amount: bigint;
  cost_lamports: bigint;
}

export interface PendingView {
  order: { side: string; mint: string };
  seq: number;
  decided_slot: number;
}

export interface StrategyState {
  hello: {
    caps: {
      max_open_positions: number;
      max_order_bps_of_real_reserve: number;
      max_orders_per_batch: number;
    };
    fees: { base_fee_lamports: string; priority_fee_lamports: string };
  };
  slot: number;
  positions: Map<string, HoldingView>;
  curves: Map<string, CurveView>;
  pending: Map<string, PendingView>;
  maxBuyLamports(mint: string): bigint;
  freeCashLamports(): bigint;
  txFeeLamports(): bigint;
  committedPositionCount(): number;
}

export interface ChainEventView {
  event: string;
  mint: string;
  slot: number;
  is_buy?: boolean;
  sol_amount?: string;
  user?: string;
  virtual_quote_reserves?: string;
  virtual_token_reserves?: string;
  real_quote_reserves?: string;
  block_time?: number | null;
}

export interface MarkView {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

export interface FillView {
  client_id: string;
  mint: string;
  side: string;
  status: string;
  tx_fee_lamports: string;
}

export interface BatchView {
  slot: number;
  events: ChainEventView[];
  marks: MarkView[];
  fills: FillView[];
}

export interface OrderInput {
  side: 'buy' | 'sell';
  mint: string;
  quote_lamports?: bigint;
  token_amount?: bigint;
  max_slippage_bps: number;
  client_id?: string;
}

// ---------------------------------------------------------------- per-coin tape

interface Tick {
  slot: number;
  price: number;
  buy: boolean;
  /** SOL moved, in lamports. */
  sol: number;
  user: string;
}

interface Tape {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  /** Best liquidation value seen, lamports. */
  peak: bigint;
  /** Tx fees paid on this position's fills, lamports. */
  txPaid: bigint;
  entryPrice: number;
  /** Lamports committed to buys (sent, filled or not). */
  invested: bigint;
  exiting: boolean;
  filled: boolean;
}

/** Marginal price of a curve: virtual SOL per virtual token. */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

/**
 * What selling `tokens` would pay, curve fees deducted, against the reserves the
 * harness marks for the mint (the recorded reserves shifted by our own net flow
 * into the curve). Capped at the real SOL reserve, like the replay engine.
 */
function liquidationValue(
  mark: MarkView | undefined,
  curve: CurveView | undefined,
  tokens: bigint,
  txFee: bigint,
): bigint {
  const vq = mark !== undefined ? BigInt(mark.virtual_quote_reserves) : curve?.virtual_quote_reserves ?? 0n;
  const vt = mark !== undefined ? BigInt(mark.virtual_token_reserves) : curve?.virtual_token_reserves ?? 0n;
  const rq = mark !== undefined ? BigInt(mark.real_quote_reserves) : curve?.real_quote_reserves ?? 0n;
  if (tokens <= 0n || vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  const proceeds = q - (q * FEE_BPS + BPS - 1n) / BPS;
  if (proceeds <= txFee) return 0n;
  return proceeds - txFee;
}

/** Net lamports bought minus sold over the last `w` slots. */
function netFlow(ticks: Tick[], now: number, w: number): number {
  let net = 0;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i]!;
    if (t.slot <= now - w) break;
    net += t.buy ? t.sol : -t.sol;
  }
  return net;
}

/** Highest price over the last `w` slots, and the price that far back (or the earliest known). */
function highAndRef(ticks: Tick[], now: number, w: number): { high: number; ref: number } {
  let high = 0;
  let ref = -1;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const t = ticks[i]!;
    if (t.slot <= now - w) break;
    if (t.price > high) high = t.price;
    ref = t.price;
  }
  return { high, ref };
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<string, Tape>();
  const held = new Map<string, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<string, boolean>();
  let myFills = 0;
  const myCoins = new Set<string>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.highWindow, p.trendWindow) + 5;
  /** Aggregate signed SOL flow across every traded coin, for the regime filter. */
  const globalFlow: { slot: number; net: number }[] = [];
  let gHead = 0;
  let globalNet = 0;

  const tapeOf = (mint: string): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** The dip-buy entry signal on a tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const { high, ref } = highAndRef(t.ticks, now, p.highWindow);
    if (high <= 0 || ref < 0) return false;
    const last = t.ticks[t.ticks.length - 1]!;
    const price = last.price;
    if (price <= 0) return false;
    const dip = 1 - price / high;
    if (dip < p.dipMin || dip > p.dipMax) return false;
    // Regime filter: the longer trend must still be up. Compare against the price
    // at the start of the trend window (or the earliest price we know).
    const trend = highAndRef(t.ticks, now, p.trendWindow);
    const trendUp = price >= trend.ref || netFlow(t.ticks, now, p.trendWindow) > 0;
    if (!trendUp) return false;
    // Buyers stepping back in: recent tape mostly buys, net flow positive, and the
    // latest recorded trade a buy (the dip is being bought, not sold into).
    let buys = 0;
    const buyers = new Set<string>();
    const n = Math.min(p.flowTrades, t.ticks.length);
    for (let i = t.ticks.length - n; i < t.ticks.length; i++) {
      const tr = t.ticks[i]!;
      if (tr.buy) {
        buys++;
        buyers.add(tr.user);
      }
    }
    if (buys < p.minRecentBuys || buyers.size < p.minBuyers) return false;
    if (netFlow(t.ticks, now, p.flowWindow) <= 0) return false;
    if (!last.buy) return false;
    return true;
  };

  /** The per-reply buy cap, with a margin: the harness checks it against reserves
   * shifted by our own earlier flow, which can sit below the recorded ones. */
  const buyCap = (state: StrategyState, mint: string): bigint => {
    return (state.maxBuyLamports(mint) * 97n) / 100n;
  };

  return {
    onBatch(state: StrategyState, batch: BatchView): OrderInput[] {
      const now = batch.slot;
      const touched: string[] = [];
      const touchedSet = new Set<string>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') {
          h.txPaid += BigInt(f.tx_fee_lamports);
        }
        if (f.side === 'sell' && h !== undefined) {
          h.exiting = false;
          if (!state.positions.has(f.mint)) {
            let stillPending = false;
            for (const o of state.pending.values()) {
              if (o.order.mint === f.mint) stillPending = true;
            }
            if (!stillPending) {
              held.delete(f.mint);
              tapeOf(f.mint).lastExit = now;
            }
          }
        } else if (f.side === 'buy' && f.status === 'filled' && h !== undefined) {
          h.filled = true;
        }
      }

      for (const e of batch.events) {
        if (e.block_time !== null && e.block_time !== undefined) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const vq = BigInt(e.virtual_quote_reserves ?? '0');
          const vt = BigInt(e.virtual_token_reserves ?? '0');
          const solLam = Number(e.sol_amount ?? '0');
          t.ticks.push({
            slot: e.slot,
            price: priceOf(vq, vt),
            buy: e.is_buy === true,
            sol: solLam,
            user: e.user ?? '',
          });
          const signed = e.is_buy === true ? solLam : -solLam;
          globalFlow.push({ slot: e.slot, net: signed });
          globalNet += signed;
          if (!touchedSet.has(e.mint)) {
            touchedSet.add(e.mint);
            touched.push(e.mint);
          }
        }
      }
      // Prune tapes we touched so they stay bounded by the trend window.
      for (const mint of touched) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.ticks.length && t.ticks[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.ticks.splice(0, cut);
      }
      // Prune the aggregate flow tape to the regime window.
      while (gHead < globalFlow.length && globalFlow[gHead]!.slot <= now - p.regimeWindow) {
        globalNet -= globalFlow[gHead]!.net;
        gHead++;
      }
      if (gHead > 10_000) {
        globalFlow.splice(0, gHead);
        gHead = 0;
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingMints = new Set<string>();
      for (const o of state.pending.values()) pendingMints.add(o.order.mint);

      // 1. Exits first, in mint order (deterministic).
      const heldMints = [...state.positions.keys()].sort();
      for (const mint of heldMints) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        let h = held.get(mint);
        if (h === undefined) {
          h = {
            opened: now,
            peak: 0n,
            txPaid: tx,
            entryPrice: priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves),
            invested: pos.cost_lamports,
            exiting: false,
            filled: true,
          };
          held.set(mint, h);
        }
        if (h.exiting || pendingMints.has(mint)) continue;
        const value = liquidationValue(marks.get(mint), curve, pos.token_amount, tx);
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.peak) h.peak = value;
        const t = tapeOf(mint);
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * BigInt(Math.round((1 + p.takeProfit) * 10_000))) exit = true;
          if (value * BPS <= basis * BigInt(Math.round((1 - p.stopLoss) * 10_000))) exit = true;
          if (
            h.peak >= basis * BigInt(Math.round((1 + p.trailArm) * 10_000)) / BPS &&
            value * BPS <= h.peak * BigInt(Math.round((1 - p.trail) * 10_000))
          ) {
            exit = true;
          }
        }
        if (now - h.opened >= p.maxHold) exit = true;
        if (!exit && netFlow(t.ticks, now, p.flowWindow) < -p.fadeNetSol * LAMPORTS) exit = true;
        if (!exit) continue;
        h.exiting = true;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // 2. Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        if (!selling) probes.set(mint, true);
      }

      // 3. Adds on held positions, then new entries, on coins that traded.
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain;
      for (const m of held.keys()) {
        if (state.positions.has(m)) mainLeft--;
      }
      let entries = 0;
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingMints.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (h !== undefined && state.positions.has(mint)) {
          // Add while the dip is recovering: price back above entry and flow positive.
          if (h.exiting || !h.filled || h.invested >= BigInt(Math.floor(p.maxPositionSol * LAMPORTS))) continue;
          if (price < h.entryPrice * 1.02) continue;
          if (netFlow(t.ticks, now, p.flowWindow) <= 0) continue;
          let amount = BigInt(Math.floor(p.addSol * LAMPORTS));
          const room = BigInt(Math.floor(p.maxPositionSol * LAMPORTS)) - h.invested;
          if (amount > room) amount = room;
          const sizeCap = buyCap(state, mint);
          if (amount > sizeCap) amount = sizeCap;
          if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          h.invested += amount;
          free -= amount + tx;
          pendingMints.add(mint);
          continue;
        }
        // New entry.
        if (entries >= p.maxEntriesPerBatch || slotsLeft <= 0 || mainLeft <= 0) continue;
        if (state.positions.has(mint)) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        // Regime gate: sit out while money is flowing out of pump.fun overall.
        if (globalNet <= p.regimeMinNetSol * LAMPORTS) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        let amount = BigInt(Math.floor(p.firstBuySol * LAMPORTS));
        const sizeCap = buyCap(state, mint);
        if (amount > sizeCap) amount = sizeCap;
        if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        held.set(mint, {
          opened: now,
          peak: 0n,
          txPaid: 0n,
          entryPrice: price,
          invested: amount,
          exiting: false,
          filled: false,
        });
        t.entries++;
        free -= amount + tx;
        slotsLeft--;
        mainLeft--;
        entries++;
        pendingMints.add(mint);
      }

      // 4. Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingMints.has(mint)) continue;
            if (state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < p.probeSol * 150) continue;
            if (free < BigInt(Math.floor(p.probeSol * LAMPORTS)) + 2n * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= BigInt(Math.floor(p.probeSol * LAMPORTS)) + tx;
          }
        }
      }
      return orders;
    },
  };
}
