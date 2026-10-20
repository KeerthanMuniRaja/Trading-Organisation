CREATE TABLE incident_findings (
  id uuid PRIMARY KEY,
  sequence bigserial UNIQUE NOT NULL,
  incident_id uuid NOT NULL REFERENCES incidents(id),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  root_cause text NOT NULL,
  corrective_action text NOT NULL,
  prevention text NOT NULL,
  verification_plan text NOT NULL,
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_findings_incident ON incident_findings(incident_id, sequence);
CREATE TABLE incident_finding_reviews (
  finding_id uuid PRIMARY KEY REFERENCES incident_findings(id),
  decision text NOT NULL CHECK (decision IN ('accepted','rejected')),
  reason text NOT NULL,
  reviewer text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
