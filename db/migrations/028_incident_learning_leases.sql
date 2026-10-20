CREATE TABLE incident_learning_leases (
  assignment_id uuid PRIMARY KEY REFERENCES incident_learning_assignments(id),
  worker text NOT NULL,
  token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 3)
);
