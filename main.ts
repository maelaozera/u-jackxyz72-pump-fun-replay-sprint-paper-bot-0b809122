// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
//
// A paper-trading bot for the agent-fun/replay/v2 protocol: it reads hello,
// batch, done as newline-delimited JSON on stdin and answers each batch with
// exactly one reply line on stdout (one reply per batch, echoing its seq).
// The strategy lives in strategy.ts; this file only owns the wire, the account
// state and the order validation, so a broken order fails here on your machine
// instead of in grading.
//
// Determinism: no clock, no environment, no randomness — the seed in hello is
// the only entropy the protocol allows, and this bot does not even use it, so
// the two graded executions produce byte-identical action logs.
//
// Run by the grader as `node /bot/main.ts` (Node 22 strips the types; no
// build step, no dependencies, stdlib only).

import { createStrategy, type BatchView, type StrategyState } from './strategy.ts';

const PROTOCOL = 'agent-fun/replay/v2';
const MAX_HARNESS_LINE_BYTES = 1_048_576;
const MAX_BOT_LINE_BYTES = 65_536;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;
const U64_MAX = 18_446_744_073_709_551_615n;

type U64 = string;

interface Hello {
  type: 'hello';
  protocol: typeof PROTOCOL;
  seed: U64;
  universe: unknown;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

interface Fill {
  client_id: string;
  mint: string;
  side: string;
  status: string;
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: Record<string, unknown>[];
  marks: Record<string, unknown>[];
  fills: Fill[];
  account: {
    cash_lamports: U64;
    positions: { mint: string; token_amount: U64; cost_lamports: U64 }[];
  };
}

interface Done {
  type: 'done';
  seq: number;
  reason: string;
  account: {
    cash_lamports: U64;
    positions: { mint: string; token_amount: U64; cost_lamports: U64 }[];
  };
}

interface Curve {
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

interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  mint: string;
  quote_lamports?: U64;
  token_amount?: U64;
  max_slippage_bps: number;
}

interface PendingOrder {
  order: Order;
  seq: number;
  decided_slot: number;
}

class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

function toU64(value: unknown, what = 'amount'): U64 {
  let n: bigint | null = null;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && U64_RE.test(value)) n = BigInt(value);
  if (n === null || n < 0n || n > U64_MAX) {
    throw new OrderError(`${what} must be a u64 (bigint, decimal string or safe integer), got ${String(value)}`);
  }
  return n.toString();
}

/** Everything the bot knows, kept current before each batch is answered. */
class BotState {
  readonly hello: Hello;
  seq = -1;
  slot = -1;
  account: Batch['account'];
  cash: bigint;
  readonly positions = new Map<string, Holding>();
  readonly curves = new Map<string, Curve>();
  readonly pending = new Map<string, PendingOrder>();
  #used = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.account = { cash_lamports: hello.capital.lamports, positions: [] };
    this.cash = BigInt(hello.capital.lamports);
  }

  clientId(): string {
    for (;;) {
      const id = `o${this.#next++}`;
      if (!this.#used.has(id)) {
        this.#used.add(id);
        return id;
      }
    }
  }

  txFeeLamports(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /** The size cap on this mint now: the most this batch's buys on it may spend together. */
  maxBuyLamports(mint: string): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (c.real_quote_reserves * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  /** Mints held plus mints with a buy pending: what counts against max_open_positions. */
  committedPositionCount(): number {
    const mints = new Set<string>(this.positions.keys());
    for (const p of this.pending.values()) {
      if (p.order.side === 'buy') mints.add(p.order.mint);
    }
    return mints.size;
  }

  /** Cash minus what pending orders will take if they fill (buy amounts and every tx fee). */
  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === 'buy') free -= BigInt(p.order.quote_lamports!);
    }
    return free;
  }

  /** Fold a batch in: its fills, account, marks and events (in that order). */
  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.#setAccount(batch.account);
    for (const m of batch.marks) {
      const mint = m.mint as string;
      const slot = m.slot as number;
      const c = this.curves.get(mint);
      if (c !== undefined && slot < c.reserves_slot) continue;
      const curve = c ?? this.#newCurve(mint, null, slot);
      curve.virtual_token_reserves = BigInt(m.virtual_token_reserves as string);
      curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves as string);
      curve.real_token_reserves = BigInt(m.real_token_reserves as string);
      curve.real_quote_reserves = BigInt(m.real_quote_reserves as string);
      curve.reserves_slot = slot;
    }
    for (const e of batch.events) {
      const mint = e.mint as string;
      if (e.event === 'CreateEvent') {
        const curve = this.#newCurve(mint, e.slot as number, e.slot as number);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves as string);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves as string);
        curve.real_token_reserves = BigInt(e.real_token_reserves as string);
        curve.real_quote_reserves = 0n;
      } else if (e.event === 'TradeEvent') {
        const curve = this.curves.get(mint) ?? this.#newCurve(mint, null, e.slot as number);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves as string);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves as string);
        curve.real_token_reserves = BigInt(e.real_token_reserves as string);
        curve.real_quote_reserves = BigInt(e.real_quote_reserves as string);
        curve.reserves_slot = e.slot as number;
        curve.trades += 1;
      } else {
        const curve = this.curves.get(mint) ?? this.#newCurve(mint, null, e.slot as number);
        curve.complete = true;
      }
    }
  }

  applyDone(done: Done): void {
    this.seq = done.seq;
    this.#setAccount(done.account);
  }

  /** Validate what the strategy returned and turn it into wire orders. */
  toOrders(result: unknown): Order[] {
    if (result === undefined || result === null) return [];
    if (!Array.isArray(result)) {
      throw new OrderError(`batch ${this.seq}: strategy must return an array of orders`);
    }
    const cap = this.hello.caps.max_orders_per_batch;
    if (result.length > cap) {
      throw new OrderError(
        `batch ${this.seq}: strategy returned ${result.length} orders, over caps.max_orders_per_batch (${cap})`,
      );
    }
    const checked: { side: 'buy' | 'sell'; client_id: string | undefined; mint: string; amount: U64; max_slippage_bps: number }[] = [];
    for (let i = 0; i < result.length; i++) {
      const o = result[i] as Record<string, unknown>;
      if (typeof o !== 'object' || o === null || Array.isArray(o)) {
        throw new OrderError(`batch ${this.seq} order ${i}: expected an order object`);
      }
      if (o.side !== 'buy' && o.side !== 'sell') {
        throw new OrderError(`batch ${this.seq} order ${i}: side must be "buy" or "sell"`);
      }
      const allowed = o.side === 'buy'
        ? new Set(['side', 'client_id', 'mint', 'quote_lamports', 'max_slippage_bps'])
        : new Set(['side', 'client_id', 'mint', 'token_amount', 'max_slippage_bps']);
      for (const k of Object.keys(o)) {
        if (!allowed.has(k)) throw new OrderError(`batch ${this.seq} order ${i}: unknown key "${k}"`);
      }
      if (typeof o.mint !== 'string' || !PUBKEY_RE.test(o.mint)) {
        throw new OrderError(`batch ${this.seq} order ${i}: mint must be a base58 address`);
      }
      const amountKey = o.side === 'buy' ? 'quote_lamports' : 'token_amount';
      const amount = toU64(o[amountKey], `batch ${this.seq} order ${i}: ${amountKey}`);
      const bps = o.max_slippage_bps;
      if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
        throw new OrderError(`batch ${this.seq} order ${i}: max_slippage_bps must be an integer 0..10000`);
      }
      let client_id: string | undefined;
      if (o.client_id !== undefined) {
        if (typeof o.client_id !== 'string' || !CLIENT_ID_RE.test(o.client_id)) {
          throw new OrderError(`batch ${this.seq} order ${i}: bad client_id`);
        }
        client_id = o.client_id;
      }
      checked.push({ side: o.side, client_id, mint: o.mint, amount, max_slippage_bps: bps });
    }
    const taken = new Set<string>();
    for (const o of checked) if (o.client_id !== undefined) taken.add(o.client_id);
    return checked.map((o) => {
      let client_id = o.client_id;
      if (client_id === undefined) {
        for (;;) {
          const id = `o${this.#next++}`;
          if (!this.#used.has(id) && !taken.has(id)) {
            client_id = id;
            break;
          }
        }
      }
      taken.add(client_id);
      return o.side === 'buy'
        ? { side: 'buy', client_id, mint: o.mint, quote_lamports: o.amount, max_slippage_bps: o.max_slippage_bps }
        : { side: 'sell', client_id, mint: o.mint, token_amount: o.amount, max_slippage_bps: o.max_slippage_bps };
    });
  }

  recordOrders(orders: readonly Order[]): void {
    for (const order of orders) {
      this.#used.add(order.client_id);
      this.pending.set(order.client_id, { order, seq: this.seq, decided_slot: this.slot });
    }
  }

  #newCurve(mint: string, created: number | null, slot: number): Curve {
    const curve: Curve = {
      mint,
      created_slot: created,
      virtual_token_reserves: 0n,
      virtual_quote_reserves: 0n,
      real_token_reserves: 0n,
      real_quote_reserves: 0n,
      reserves_slot: slot,
      trades: 0,
      complete: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }

  #setAccount(account: Batch['account']): void {
    this.account = account;
    this.cash = BigInt(account.cash_lamports);
    this.positions.clear();
    for (const p of account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) {
        this.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
      }
    }
  }
}

/** Split a byte stream into lines (`\n`-terminated, a trailing `\r` dropped). */
async function* readLines(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buf = '';
  let lineNo = 0;
  for await (const chunk of input) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buf += text;
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      let line = buf.slice(0, idx);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      buf = buf.slice(idx + 1);
      lineNo++;
      if (Buffer.byteLength(line, 'utf8') > MAX_HARNESS_LINE_BYTES) {
        throw new ProtocolError(`input line ${lineNo} is over ${MAX_HARNESS_LINE_BYTES} bytes`);
      }
      yield line;
      idx = buf.indexOf('\n');
    }
  }
  const tail = decoder.decode();
  if (tail.length > 0) buf += tail;
  if (buf.length > 0) {
    let line = buf;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    lineNo++;
    if (Buffer.byteLength(line, 'utf8') > MAX_HARNESS_LINE_BYTES) {
      throw new ProtocolError(`input line ${lineNo} is over ${MAX_HARNESS_LINE_BYTES} bytes`);
    }
    yield line;
  }
}

function checkBatch(batch: Batch, lineNo: number): void {
  const ok =
    Number.isSafeInteger(batch.seq) &&
    Number.isSafeInteger(batch.slot) &&
    Array.isArray(batch.events) &&
    Array.isArray(batch.marks) &&
    Array.isArray(batch.fills) &&
    typeof batch.account === 'object' &&
    batch.account !== null &&
    Array.isArray(batch.account.positions);
  if (!ok) throw new ProtocolError(`input line ${lineNo}: malformed batch`);
}

async function main(): Promise<void> {
  const strategy = createStrategy();
  let state: BotState | null = null;
  let batches = 0;
  let lineNo = 0;
  for await (const line of readLines(process.stdin)) {
    lineNo++;
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      throw new ProtocolError(`input line ${lineNo} is not JSON`);
    }
    const type =
      typeof msg === 'object' && msg !== null && !Array.isArray(msg)
        ? (msg as { type?: unknown }).type
        : undefined;
    if (type === 'hello') {
      const hello = msg as Hello;
      if (state !== null) throw new ProtocolError(`input line ${lineNo}: a second hello`);
      if (hello.protocol !== PROTOCOL) {
        throw new ProtocolError(`the harness speaks ${String(hello.protocol)}; this bot speaks ${PROTOCOL}`);
      }
      state = new BotState(hello);
    } else if (type === 'batch') {
      const batch = msg as Batch;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: a batch before hello`);
      checkBatch(batch, lineNo);
      state.applyBatch(batch);
      // The strategy sees the trimmed view: the full events carry every field
      // the schema defines, and the strategy reads only what it needs.
      const orders = state.toOrders(
        strategy.onBatch(state as unknown as StrategyState, batch as unknown as BatchView),
      );
      const reply = JSON.stringify({ type: 'reply', seq: batch.seq, orders });
      if (Buffer.byteLength(reply, 'utf8') > MAX_BOT_LINE_BYTES) {
        throw new OrderError(
          `batch ${batch.seq}: the reply is over ${MAX_BOT_LINE_BYTES} bytes; send fewer orders`,
        );
      }
      state.recordOrders(orders);
      process.stdout.write(`${reply}\n`);
      batches++;
    } else if (type === 'done') {
      const done = msg as Done;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: done before hello`);
      state.applyDone(done);
      const pnl = state.cash - LAMPORTS_PER_SOL * 10n;
      console.error(
        `done after ${batches} batches: cash ${state.cash} lamports, ` +
          `net PnL ${(Number(pnl) / 1e9).toFixed(6)} SOL`,
      );
      return;
    } else {
      throw new ProtocolError(`input line ${lineNo}: unknown message type ${String(type)}`);
    }
  }
  throw new ProtocolError(
    state === null ? 'input ended before hello' : `input ended before done (after ${batches} batches)`,
  );
}

await main();
