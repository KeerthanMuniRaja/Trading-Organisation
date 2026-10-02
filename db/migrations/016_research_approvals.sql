CREATE TABLE skill_research_approvals (
  id uuid PRIMARY KEY, experiment_id uuid NOT NULL UNIQUE REFERENCES skill_experiment_reviews(experiment_id),
  owner_id text NOT NULL, candidate_hash text NOT NULL REFERENCES skill_producers(hash),
  plan_hash text NOT NULL, policy_revision integer NOT NULL, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL
);
CREATE TRIGGER protect_skill_research_approvals BEFORE UPDATE OR DELETE ON skill_research_approvals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_research_revocations (
  approval_id uuid PRIMARY KEY REFERENCES skill_research_approvals(id), owner_id text NOT NULL,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_research_revocations BEFORE UPDATE OR DELETE ON skill_research_revocations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
