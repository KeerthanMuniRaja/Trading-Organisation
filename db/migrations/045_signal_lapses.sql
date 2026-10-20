-- Lapsed intents (PAPER-03): an accepted proposal that expired without being executed is closed for good, and the buy
-- reservation a failed fill left behind is cancelled, so it stops holding the bot's budget and the shared capital.
-- One row per signal; append-only.
CREATE TABLE trade_signal_lapses (
  signal_id uuid PRIMARY KEY REFERENCES trade_signals(id),
  order_id uuid REFERENCES orders(id),
  released_paise bigint NOT NULL DEFAULT 0 CHECK (released_paise >= 0),
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_trade_signal_lapses BEFORE UPDATE OR DELETE ON trade_signal_lapses FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
