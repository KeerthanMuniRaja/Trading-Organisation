-- Dividends (CORP-02): holders on the ex-date receive cash per share, as realised paper profit, so live paper returns are
-- comparable with backtests on dividend-adjusted prices; calls held through an ex-date are scored on total return.
-- Append-only; each payment is one balanced ledger journal.
CREATE TABLE dividends (
  id uuid PRIMARY KEY,
  symbol text NOT NULL CHECK (char_length(symbol) BETWEEN 1 AND 20),
  amount_per_share_paise bigint NOT NULL CHECK (amount_per_share_paise > 0),
  ex_date date NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, ex_date)
);
CREATE TABLE dividend_payments (
  dividend_id uuid NOT NULL REFERENCES dividends(id),
  bot_id text NOT NULL REFERENCES bots(id),
  quantity bigint NOT NULL CHECK (quantity > 0),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  journal_id uuid UNIQUE NOT NULL REFERENCES journals(id),
  PRIMARY KEY (dividend_id, bot_id)
);
CREATE TRIGGER protect_dividends BEFORE UPDATE OR DELETE ON dividends FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_dividend_payments BEFORE UPDATE OR DELETE ON dividend_payments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
