-- Owner alerts (OBS-01): condition-based, deduplicated (one open alert per condition), auto-resolving, deliverable.
CREATE TABLE owner_alerts (
  id uuid PRIMARY KEY,
  rule text NOT NULL CHECK (char_length(rule) BETWEEN 1 AND 60),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 120),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
  detail jsonb NOT NULL,
  fingerprint text NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  delivered_at timestamptz
);
CREATE UNIQUE INDEX owner_alerts_one_open_per_condition ON owner_alerts(fingerprint) WHERE resolved_at IS NULL;
CREATE INDEX owner_alerts_recent ON owner_alerts(raised_at DESC);
