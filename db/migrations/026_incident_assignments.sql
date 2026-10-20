CREATE TABLE incident_learning_assignments (
  id uuid PRIMARY KEY,
  lesson_id uuid NOT NULL REFERENCES incident_lessons(lesson_id),
  bot_id text NOT NULL REFERENCES bots(id),
  task text NOT NULL,
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lesson_id,bot_id)
);
CREATE TABLE incident_learning_attempts (
  assignment_id uuid NOT NULL REFERENCES incident_learning_assignments(id),
  request_id uuid UNIQUE NOT NULL REFERENCES bot_knowledge_requests(request_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(assignment_id,request_id)
);
CREATE TRIGGER protect_incident_assignments BEFORE UPDATE OR DELETE ON incident_learning_assignments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_incident_attempts BEFORE UPDATE OR DELETE ON incident_learning_attempts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
