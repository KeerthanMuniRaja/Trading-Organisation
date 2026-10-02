CREATE TABLE learning_models (
  id text PRIMARY KEY,
  name text NOT NULL,
  engine text NOT NULL CHECK(engine='factual-reflection-v1'),
  manifest_hash text NOT NULL UNIQUE,
  manifest jsonb NOT NULL,
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_learning_models BEFORE UPDATE OR DELETE ON learning_models FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE learning_model_revocations (
  model_id text PRIMARY KEY REFERENCES learning_models(id),
  reason text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_learning_revocations BEFORE UPDATE OR DELETE ON learning_model_revocations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE learning_policy (
  id integer PRIMARY KEY CHECK(id=1), revision integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,
  model_id text REFERENCES learning_models(id),
  max_per_day integer NOT NULL CHECK(max_per_day BETWEEN 1 AND 100),
  max_lifetime integer NOT NULL CHECK(max_lifetime BETWEEN 1 AND 1000)
);
INSERT INTO learning_policy(id,max_per_day,max_lifetime) VALUES(1,12,100);
CREATE TABLE learning_proposals (
  id uuid PRIMARY KEY,
  trial_id uuid NOT NULL UNIQUE REFERENCES portfolio_trials(id),
  bot_id text NOT NULL REFERENCES bots(id),
  model_id text NOT NULL REFERENCES learning_models(id),
  policy_revision integer NOT NULL,
  report_hash text NOT NULL,
  content text NOT NULL,
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_learning_proposals BEFORE UPDATE OR DELETE ON learning_proposals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE learning_reviews (
  proposal_id uuid PRIMARY KEY REFERENCES learning_proposals(id),
  decision text NOT NULL CHECK(decision IN ('verified','rejected')),
  reason text NOT NULL,
  reviewer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_learning_reviews BEFORE UPDATE OR DELETE ON learning_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
