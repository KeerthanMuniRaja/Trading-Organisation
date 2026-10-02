CREATE TABLE skill_policy (
  id integer PRIMARY KEY CHECK(id=1), revision integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,
  max_per_day integer NOT NULL CHECK(max_per_day BETWEEN 1 AND 100),
  max_lifetime integer NOT NULL CHECK(max_lifetime BETWEEN 1 AND 1000)
);
INSERT INTO skill_policy(id,max_per_day,max_lifetime) VALUES(1,12,100);
CREATE TABLE skill_attempts (
  id uuid PRIMARY KEY, bot_id text NOT NULL REFERENCES bots(id),
  policy_revision integer NOT NULL, rubric text NOT NULL CHECK(rubric='research-basics-v1'),
  curriculum jsonb NOT NULL, challenge jsonb NOT NULL, author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '120 seconds'
);
CREATE INDEX skill_attempts_bot ON skill_attempts(bot_id);
CREATE TRIGGER protect_skill_attempts BEFORE UPDATE OR DELETE ON skill_attempts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_submissions (
  attempt_id uuid PRIMARY KEY REFERENCES skill_attempts(id), answers jsonb NOT NULL,
  author text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_submissions BEFORE UPDATE OR DELETE ON skill_submissions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_reviews (
  attempt_id uuid PRIMARY KEY REFERENCES skill_attempts(id),
  outcome text NOT NULL CHECK(outcome IN ('passed','failed','invalidated')),
  checks jsonb NOT NULL, reviewer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER protect_skill_reviews BEFORE UPDATE OR DELETE ON skill_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
