CREATE TABLE portfolio_datasets (
  id uuid PRIMARY KEY,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  purpose text NOT NULL CHECK (purpose='example-testing'),
  assets jsonb NOT NULL,
  training jsonb NOT NULL,
  holdout jsonb NOT NULL,
  digest text UNIQUE NOT NULL,
  holdout_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_portfolio_datasets BEFORE UPDATE OR DELETE ON portfolio_datasets
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE portfolio_trials (
  id uuid PRIMARY KEY,
  dataset_id uuid NOT NULL REFERENCES portfolio_datasets(id),
  bot_id text NOT NULL REFERENCES bots(id),
  holdout_digest text NOT NULL,
  method text NOT NULL CHECK (method IN ('equal_weight','inverse_volatility','minimum_variance')),
  weights jsonb NOT NULL,
  author text NOT NULL,
  state text NOT NULL CHECK (state IN ('submitted','evaluated','revoked','cancelled')),
  reviewer text,
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE(bot_id,holdout_digest,method)
);
CREATE INDEX portfolio_trials_dataset ON portfolio_trials(dataset_id);
