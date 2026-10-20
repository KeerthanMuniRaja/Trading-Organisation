-- Daily mark-to-market history per bot: the first snapshot of each trading day stands and history is append-only,
-- so equity curves and worst falls cannot be rewritten after the fact.
CREATE TABLE paper_performance_snapshots (
  id uuid PRIMARY KEY,
  day date NOT NULL,
  bot_id text NOT NULL REFERENCES bots(id),
  budget_paise bigint NOT NULL CHECK (budget_paise >= 0),
  realised_paise bigint NOT NULL,
  unrealised_paise bigint NOT NULL,
  open_positions integer NOT NULL CHECK (open_positions >= 0),
  unpriced_or_stale integer NOT NULL CHECK (unpriced_or_stale >= 0),
  recorder text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, bot_id)
);
CREATE INDEX paper_performance_snapshots_by_bot ON paper_performance_snapshots(bot_id, day);
CREATE TRIGGER protect_paper_performance_snapshots BEFORE UPDATE OR DELETE ON paper_performance_snapshots FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
