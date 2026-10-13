-- Compute accounting (COST-01): per-bot model usage reported by workers (desk, allocator, claims runs), append-only and
-- deduplicated, plus an owner-set daily token budget per department.
CREATE TABLE compute_usage (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  run_label text NOT NULL CHECK (char_length(run_label) BETWEEN 1 AND 160),
  period_from date NOT NULL,
  period_to date NOT NULL CHECK (period_to >= period_from),
  calls integer NOT NULL CHECK (calls BETWEEN 1 AND 10000000),
  prompt_tokens bigint NOT NULL CHECK (prompt_tokens >= 0),
  completion_tokens bigint NOT NULL CHECK (completion_tokens >= 0),
  latency_ms bigint NOT NULL CHECK (latency_ms >= 0),
  reporter text NOT NULL,
  content_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compute_usage_by_period ON compute_usage(period_to, bot_id);
CREATE TRIGGER protect_compute_usage BEFORE UPDATE OR DELETE ON compute_usage FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
ALTER TABLE departments ADD COLUMN compute_tokens_per_day integer CHECK (compute_tokens_per_day IS NULL OR compute_tokens_per_day BETWEEN 1000 AND 100000000);
