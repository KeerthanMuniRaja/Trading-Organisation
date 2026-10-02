CREATE TABLE source_observations (
  evidence_id uuid PRIMARY KEY REFERENCES evidence(id),
  source_id text NOT NULL REFERENCES sources(id),
  url text NOT NULL, title text NOT NULL, snapshot_hash text NOT NULL UNIQUE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  provenance text NOT NULL CHECK(provenance='collector-submitted')
);
CREATE INDEX source_observations_recent ON source_observations(source_id,observed_at DESC);
CREATE TRIGGER protect_source_observations BEFORE UPDATE OR DELETE ON source_observations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
