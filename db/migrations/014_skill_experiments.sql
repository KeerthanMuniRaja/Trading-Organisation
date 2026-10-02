CREATE TABLE skill_experiments (
  id uuid PRIMARY KEY, author text NOT NULL, researcher text NOT NULL,
  baseline_hash text NOT NULL REFERENCES skill_producers(hash), candidate_hash text NOT NULL REFERENCES skill_producers(hash),
  policy_revision integer NOT NULL, rubric text NOT NULL, criteria jsonb NOT NULL, cases jsonb NOT NULL,
  plan_hash text NOT NULL UNIQUE, purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '24 hours'),
  CHECK(baseline_hash<>candidate_hash), CHECK(author<>researcher)
);
CREATE TRIGGER protect_skill_experiments BEFORE UPDATE OR DELETE ON skill_experiments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_experiment_submissions (
  experiment_id uuid PRIMARY KEY REFERENCES skill_experiments(id), author text NOT NULL,
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_experiment_submissions BEFORE UPDATE OR DELETE ON skill_experiment_submissions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_experiment_reviews (
  experiment_id uuid PRIMARY KEY REFERENCES skill_experiments(id), reviewer text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('meets-criteria','below-criteria','invalidated')),
  report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_experiment_reviews BEFORE UPDATE OR DELETE ON skill_experiment_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_experiment_cancellations (
  experiment_id uuid PRIMARY KEY REFERENCES skill_experiments(id), author text NOT NULL, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_experiment_cancellations BEFORE UPDATE OR DELETE ON skill_experiment_cancellations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
