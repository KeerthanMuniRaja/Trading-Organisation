-- Signal execution (PAPER-01): an accepted proposal becomes exactly one paper order and fill, permanently linked, so
-- every decision can be traced to its trade and its profit or loss. Append-only.
CREATE TABLE trade_signal_executions (
  signal_id uuid PRIMARY KEY REFERENCES trade_signals(id),
  order_id uuid UNIQUE NOT NULL REFERENCES orders(id),
  fill_id uuid UNIQUE NOT NULL REFERENCES fills(id),
  side text NOT NULL CHECK (side IN ('buy','sell')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  price_paise bigint NOT NULL CHECK (price_paise > 0),
  fee_paise bigint NOT NULL CHECK (fee_paise >= 0),
  realised_paise bigint,
  executed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_trade_signal_executions BEFORE UPDATE OR DELETE ON trade_signal_executions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
