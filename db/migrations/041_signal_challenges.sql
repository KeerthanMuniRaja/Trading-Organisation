-- Independent challengers (SPECIALIST-01): another bot argues against (or qualifies) a trade proposal before its review.
-- Disagreement stays visible, an evidenced objection reduces sizing, and challengers are scored like proposers.
CREATE TABLE trade_signal_challenges (
  id uuid PRIMARY KEY,
  signal_id uuid NOT NULL REFERENCES trade_signals(id),
  challenger_bot_id text NOT NULL REFERENCES bots(id),
  stance text NOT NULL CHECK (stance IN ('oppose','support-with-caveat')),
  argument text NOT NULL CHECK (char_length(argument) BETWEEN 1 AND 600),
  evidence_id uuid REFERENCES evidence(id),
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id, challenger_bot_id)
);
CREATE TRIGGER protect_trade_signal_challenges BEFORE UPDATE OR DELETE ON trade_signal_challenges FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
