// Isolated diagnostic ledger: no organisation wallet, promotion or broker-order API.
export class PaperTrial {
  constructor() {
    this.initialPaise = 1_000_000;
    this.cashPaise = this.initialPaise;
    this.position = null;
    this.history = [];
    this.trades = [];
    this.lastQuote = null;
    this.halted = false;
    this.realisedNetPaise = 0;
  }
  step(q, closing = false) {
    if (!Number.isSafeInteger(q.time) || q.time <= (this.lastQuote?.time ?? 0) ||
        ![q.bidPaise, q.askPaise, q.bidQuantity, q.askQuantity].every(n => Number.isSafeInteger(n) && n > 0) ||
        q.askPaise < q.bidPaise) throw new Error('INVALID_SIMULATION_QUOTE');
    this.lastQuote = q;
    const mid = (q.bidPaise + q.askPaise) / 2;
    this.history.push(mid);
    if (this.history.length > 12) this.history.shift();
    // One share, 5bps adverse slippage and illustrative 10bps costs per side.
    // Costs are test assumptions, not a broker or statutory fee schedule.
    const sell = Math.floor(q.bidPaise * 0.9995);
    const proceeds = sell - Math.ceil(sell * 0.001);
    if (this.position) {
      const net = proceeds - this.position.costPaise;
      if (closing || net <= -Math.ceil(this.position.costPaise * 0.005) ||
          net >= Math.ceil(this.position.costPaise * 0.008) || q.time - this.position.time >= 300_000) {
        this.cashPaise += proceeds;
        this.realisedNetPaise += net;
        this.trades.push({ side: 'sell', quantity: 1, fillPaise: sell, feePaise: sell - proceeds,
          realisedNetPaise: net, observedAt: q.observedAt, reason: closing ? 'session_end' : 'exit_rule' });
        this.position = null;
        if (this.realisedNetPaise <= -10_000) this.halted = true;
        return 'sell';
      }
      return 'hold';
    }
    const buy = Math.ceil(q.askPaise * 1.0005);
    const cost = buy + Math.ceil(buy * 0.001);
    if (!closing && !this.halted && this.trades.length < 20 && this.history.length === 12 &&
        (q.askPaise - q.bidPaise) / mid <= 0.002 && mid > this.history[0] * 1.001 &&
        cost <= Math.min(this.cashPaise, this.initialPaise * 0.2)) {
      this.cashPaise -= cost;
      this.position = { costPaise: cost, time: q.time, quantity: 1 };
      this.trades.push({ side: 'buy', quantity: 1, fillPaise: buy, feePaise: cost - buy,
        observedAt: q.observedAt, reason: 'baseline_momentum' });
      return 'buy';
    }
    return 'hold';
  }
  report() {
    const liquidation = this.position && this.lastQuote ? Math.floor(this.lastQuote.bidPaise * 0.9995) : 0;
    const mark = liquidation - Math.ceil(liquidation * 0.001);
    return { initialPaise: this.initialPaise, cashPaise: this.cashPaise,
      realisedNetPaise: this.realisedNetPaise, position: this.position,
      unrealisedNetPaise: this.position ? mark - this.position.costPaise : 0,
      valuationAsOf: this.lastQuote?.observedAt ?? null, halted: this.halted, trades: this.trades };
  }
}
