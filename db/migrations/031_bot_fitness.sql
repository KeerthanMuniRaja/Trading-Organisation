-- Role-specific fitness: each report compares a bot with the do-nothing version of its own job on the same data.
-- The backend computes the p-value and verdict from the submitted counts; history is append-only.
CREATE TABLE bot_fitness_reports (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  role text NOT NULL CHECK (char_length(role) BETWEEN 1 AND 60),
  baseline text NOT NULL CHECK (baseline IN ('always-neutral','always-hold','buy-and-hold','cash','equal-weight-basket')),
  test_name text NOT NULL CHECK (char_length(test_name) BETWEEN 1 AND 120),
  period_from date NOT NULL,
  period_to date NOT NULL CHECK (period_to >= period_from),
  judged integer NOT NULL CHECK (judged BETWEEN 1 AND 1000000),
  wins integer NOT NULL CHECK (wins >= 0),
  losses integer NOT NULL CHECK (losses >= 0),
  failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  p_value numeric NOT NULL CHECK (p_value BETWEEN 0 AND 1),
  verdict text NOT NULL CHECK (verdict IN ('adds-value','worse-than-baseline','no-detectable-skill','insufficient-evidence')),
  model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 120),
  evidence_id uuid REFERENCES evidence(id),
  author text NOT NULL,
  content_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (wins + losses <= judged)
);
CREATE INDEX bot_fitness_by_bot ON bot_fitness_reports(bot_id, created_at);
CREATE TRIGGER protect_bot_fitness_reports BEFORE UPDATE OR DELETE ON bot_fitness_reports FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
