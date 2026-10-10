CREATE TABLE incident_learning_cancellations (
  assignment_id uuid PRIMARY KEY REFERENCES incident_learning_assignments(id),
  author text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_incident_learning_cancellations BEFORE UPDATE OR DELETE ON incident_learning_cancellations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
