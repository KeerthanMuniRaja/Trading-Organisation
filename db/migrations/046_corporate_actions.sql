-- Corporate actions (CORP-01): a split or bonus issue changes how many shares a holder has, not what the holding cost.
-- The owner records one from verified evidence; open paper positions are rescaled once, and calls reviewed before the
-- ex-date are scored against a reference price on the same basis. Both tables are append-only.
CREATE TABLE corporate_actions (
  id uuid PRIMARY KEY,
  symbol text NOT NULL CHECK (char_length(symbol) BETWEEN 1 AND 20),
  kind text NOT NULL CHECK (kind IN ('split','bonus')),
  shares_before integer NOT NULL CHECK (shares_before > 0),
  shares_after integer NOT NULL CHECK (shares_after > shares_before),
  ex_date date NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, ex_date)
);
CREATE TABLE corporate_action_adjustments (
  action_id uuid NOT NULL REFERENCES corporate_actions(id),
  bot_id text NOT NULL REFERENCES bots(id),
  quantity_before bigint NOT NULL CHECK (quantity_before > 0),
  quantity_after bigint NOT NULL CHECK (quantity_after > quantity_before),
  PRIMARY KEY (action_id, bot_id)
);
CREATE TRIGGER protect_corporate_actions BEFORE UPDATE OR DELETE ON corporate_actions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_corporate_action_adjustments BEFORE UPDATE OR DELETE ON corporate_action_adjustments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
