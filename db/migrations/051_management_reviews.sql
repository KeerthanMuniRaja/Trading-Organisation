-- Management reviews (ORG-02). Every day an evaluator applies fixed, published rules (management-v1) to each working
-- bot's record (live fitness, return on budget, worst fall, lapsed proposals) and files a recommendation the way a
-- manager would: watch it, suspend it, give it more budget, or retire it. Only the owner decides; accepting applies the
-- change in the same transaction. Both histories are append-only; the newest pending recommendation per bot is the live one.
CREATE TABLE bot_recommendations (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  kind text NOT NULL CHECK (kind IN ('watch', 'suspend', 'raise-budget', 'retire')),
  rule text NOT NULL CHECK (char_length(rule) BETWEEN 1 AND 60),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 600),
  proposed_budget_paise bigint CHECK (proposed_budget_paise IS NULL OR proposed_budget_paise >= 0),
  facts jsonb NOT NULL,
  proposer text NOT NULL,
  content_hash text NOT NULL UNIQUE,
  sequence bigserial,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'raise-budget') = (proposed_budget_paise IS NOT NULL))
);
CREATE INDEX bot_recommendations_latest ON bot_recommendations (bot_id, sequence DESC);
CREATE TABLE bot_recommendation_decisions (
  recommendation_id uuid PRIMARY KEY REFERENCES bot_recommendations(id),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'declined')),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 600),
  decided_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_bot_recommendations BEFORE UPDATE OR DELETE ON bot_recommendations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_recommendation_decisions BEFORE UPDATE OR DELETE ON bot_recommendation_decisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
