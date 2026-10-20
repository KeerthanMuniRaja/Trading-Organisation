-- Bot control (LIFE-02): the owner can suspend a bot (no new risk: no new buys or entry proposals; exits stay allowed so
-- risk can only fall) and resume it, and can change a bot's budget. Both histories are append-only: the latest
-- suspension row decides, and each budget change records the old and new budget.
CREATE TABLE bot_suspensions (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  suspended boolean NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 600),
  decided_by text NOT NULL,
  sequence bigserial,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_suspensions_latest ON bot_suspensions (bot_id, sequence DESC);
CREATE TABLE bot_budget_changes (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  budget_before bigint NOT NULL CHECK (budget_before >= 0),
  budget_after bigint NOT NULL CHECK (budget_after >= 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 600),
  decided_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_bot_suspensions BEFORE UPDATE OR DELETE ON bot_suspensions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_budget_changes BEFORE UPDATE OR DELETE ON bot_budget_changes FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
