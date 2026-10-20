CREATE TABLE incident_lessons (
  finding_id uuid PRIMARY KEY REFERENCES incident_findings(id),
  lesson_id uuid UNIQUE NOT NULL REFERENCES lessons(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
