CREATE TABLE skill_execution_streams (
  experiment_id uuid PRIMARY KEY REFERENCES skill_experiments(id), reporter text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('trusted-local-process-only','docker-linux-container')),
  image_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((mode='docker-linux-container')=(image_id IS NOT NULL))
);
CREATE TRIGGER protect_skill_execution_streams BEFORE UPDATE OR DELETE ON skill_execution_streams FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE skill_execution_events (
  experiment_id uuid NOT NULL REFERENCES skill_execution_streams(experiment_id),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 16),
  event jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(experiment_id,sequence)
);
CREATE TRIGGER protect_skill_execution_events BEFORE UPDATE OR DELETE ON skill_execution_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
