CREATE TABLE skill_recoveries (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL UNIQUE REFERENCES bots(id),
  failed_attempt_id uuid NOT NULL UNIQUE REFERENCES skill_attempts(id),
  lesson_id uuid NOT NULL UNIQUE REFERENCES lessons(id),
  lesson_fingerprint text NOT NULL,
  policy_revision integer NOT NULL,
  reason text NOT NULL, owner_actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days'
);
CREATE TRIGGER protect_skill_recoveries BEFORE UPDATE OR DELETE ON skill_recoveries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_recovery_revocations (
  recovery_id uuid PRIMARY KEY REFERENCES skill_recoveries(id),
  reason text NOT NULL, actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_recovery_revocations BEFORE UPDATE OR DELETE ON skill_recovery_revocations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_recovery_attempts (
  recovery_id uuid PRIMARY KEY REFERENCES skill_recoveries(id),
  attempt_id uuid NOT NULL UNIQUE REFERENCES skill_attempts(id)
);
CREATE TRIGGER protect_skill_recovery_attempts BEFORE UPDATE OR DELETE ON skill_recovery_attempts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
