-- Structured trade proposals (DECISION-01), their deterministic risk reviews and their scored outcomes.
-- A bot proposes; code alone decides acceptance and size from the configured limits; an independent evaluator later
-- records the realised price so every bot's calls can be scored and calibrated. All history is append-only.
CREATE TABLE trade_signals (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  symbol text NOT NULL CHECK (char_length(symbol) BETWEEN 1 AND 20),
  action text NOT NULL CHECK (action IN ('enter-long','exit','no-action')),
  horizon_days integer NOT NULL CHECK (horizon_days BETWEEN 1 AND 365),
  conviction text NOT NULL CHECK (conviction IN ('low','medium','high')),
  probability_pct integer CHECK (probability_pct IS NULL OR probability_pct BETWEEN 1 AND 99),
  thesis text NOT NULL CHECK (char_length(thesis) BETWEEN 1 AND 600),
  invalidation text CHECK (invalidation IS NULL OR char_length(invalidation) BETWEEN 1 AND 300),
  expires_at timestamptz NOT NULL,
  model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 120),
  prompt_version text CHECK (prompt_version IS NULL OR char_length(prompt_version) BETWEEN 1 AND 64),
  author text NOT NULL,
  content_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (action = 'no-action' OR invalidation IS NOT NULL),
  CHECK (expires_at > created_at)
);
CREATE INDEX trade_signals_by_bot ON trade_signals(bot_id, created_at);
CREATE TABLE trade_signal_evidence (
  signal_id uuid NOT NULL REFERENCES trade_signals(id),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (signal_id, evidence_id)
);
CREATE TABLE trade_signal_reviews (
  id uuid PRIMARY KEY,
  signal_id uuid UNIQUE NOT NULL REFERENCES trade_signals(id),
  outcome text NOT NULL CHECK (outcome IN ('accepted','rejected','expired','acknowledged')),
  reasons text[] NOT NULL,
  side text CHECK (side IS NULL OR side IN ('buy','sell')),
  quantity bigint CHECK (quantity IS NULL OR quantity > 0),
  reference_price_paise bigint CHECK (reference_price_paise IS NULL OR reference_price_paise > 0),
  quote_observed_at timestamptz,
  rules_version text NOT NULL,
  reviewer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'accepted') = (side IS NOT NULL AND quantity IS NOT NULL)),
  CHECK (outcome <> 'accepted' OR reference_price_paise IS NOT NULL)
);
CREATE TABLE trade_signal_outcomes (
  id uuid PRIMARY KEY,
  signal_id uuid UNIQUE NOT NULL REFERENCES trade_signals(id),
  exit_price_paise bigint NOT NULL CHECK (exit_price_paise > 0),
  observed_at timestamptz NOT NULL,
  move_bps integer NOT NULL,
  correct boolean NOT NULL,
  brier numeric CHECK (brier IS NULL OR brier BETWEEN 0 AND 1),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  evaluator text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_trade_signals BEFORE UPDATE OR DELETE ON trade_signals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_trade_signal_evidence BEFORE UPDATE OR DELETE ON trade_signal_evidence FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_trade_signal_reviews BEFORE UPDATE OR DELETE ON trade_signal_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_trade_signal_outcomes BEFORE UPDATE OR DELETE ON trade_signal_outcomes FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
