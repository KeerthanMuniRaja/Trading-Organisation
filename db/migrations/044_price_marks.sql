-- Verified end-of-day marks (PAPER-02): without a live feed, open paper positions are valued at a daily close stated in
-- verified evidence from an approved source, recorded by the evaluator. One mark per share per observation time;
-- append-only, so every past valuation can be traced to its evidence.
CREATE TABLE price_marks (
  id uuid PRIMARY KEY,
  symbol text NOT NULL,
  price_paise bigint NOT NULL CHECK (price_paise > 0),
  observed_at timestamptz NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, observed_at)
);
CREATE INDEX price_marks_latest ON price_marks (symbol, observed_at DESC);
CREATE TRIGGER protect_price_marks BEFORE UPDATE OR DELETE ON price_marks FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
