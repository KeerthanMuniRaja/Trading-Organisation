-- Owner token ceiling and immutable per-request inference reports (AI-01).
ALTER TABLE development_policy ADD COLUMN max_tokens_per_day integer
  CHECK (max_tokens_per_day IS NULL OR max_tokens_per_day BETWEEN 1000 AND 10000000);

-- All model tickets share development_requests; their kind is derived from the frozen context.
CREATE FUNCTION inference_request_kind(ctx jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN ctx ? 'datasetId' THEN 'portfolio-rd' ELSE coalesce(ctx->>'kind', 'unknown') END
$$;
-- Conservative charge before usage is known: maximum completion, prompt overhead and ~3 bytes per context token.
CREATE FUNCTION inference_reservation(ctx jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE WHEN ctx->>'kind' = 'knowledge-assessment-v1' THEN 2048 ELSE 1024 END) + 512
    + ceil(octet_length(ctx::text) / 3.0)::integer
$$;

CREATE TABLE inference_reports (
  request_id uuid PRIMARY KEY REFERENCES development_requests(id),
  author text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('completed', 'failed', 'uncertain')),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{2,47}$'),
  engine text NOT NULL CHECK (engine ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  prompt_version text NOT NULL CHECK (prompt_version ~ '^[a-f0-9]{16}$'),
  latency_ms integer CHECK (latency_ms BETWEEN 0 AND 3600000),
  prompt_tokens integer CHECK (prompt_tokens BETWEEN 0 AND 10000000),
  completion_tokens integer CHECK (completion_tokens BETWEEN 0 AND 10000000),
  reported_model text CHECK (reported_model IS NULL OR length(reported_model) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'completed') = (failure_code IS NULL))
);
CREATE INDEX inference_reports_created ON inference_reports(created_at);
CREATE TRIGGER protect_inference_reports BEFORE UPDATE OR DELETE ON inference_reports
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
