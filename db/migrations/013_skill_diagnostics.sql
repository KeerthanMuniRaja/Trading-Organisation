CREATE TABLE skill_producers (
  hash text PRIMARY KEY, manifest jsonb NOT NULL, first_reporter text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_producers BEFORE UPDATE OR DELETE ON skill_producers FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_attempt_producers (
  attempt_id uuid PRIMARY KEY REFERENCES skill_attempts(id), producer_hash text NOT NULL REFERENCES skill_producers(hash)
);
CREATE TRIGGER protect_skill_attempt_producers BEFORE UPDATE OR DELETE ON skill_attempt_producers FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_diagnoses (
  attempt_id uuid PRIMARY KEY REFERENCES skill_attempts(id), failed_checks jsonb NOT NULL,
  description text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_diagnoses BEFORE UPDATE OR DELETE ON skill_diagnoses FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_remediation_proposals (
  id uuid PRIMARY KEY, attempt_id uuid NOT NULL UNIQUE REFERENCES skill_diagnoses(attempt_id),
  bot_id text NOT NULL REFERENCES bots(id), evidence_id uuid NOT NULL REFERENCES evidence(id),
  content text NOT NULL, author text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_remediation_proposals BEFORE UPDATE OR DELETE ON skill_remediation_proposals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_remediation_reviews (
  proposal_id uuid PRIMARY KEY REFERENCES skill_remediation_proposals(id),
  decision text NOT NULL CHECK(decision IN ('verified','rejected')), reviewer text NOT NULL,
  lesson_id uuid UNIQUE REFERENCES lessons(id), reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((decision='verified')=(lesson_id IS NOT NULL))
);
CREATE TRIGGER protect_skill_remediation_reviews BEFORE UPDATE OR DELETE ON skill_remediation_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
