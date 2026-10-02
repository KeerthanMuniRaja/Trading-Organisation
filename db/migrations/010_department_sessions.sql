CREATE TABLE department_session_history (
  session_id uuid PRIMARY KEY,
  role text NOT NULL CHECK(role IN ('researcher','evaluator')),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_department_session_history BEFORE UPDATE OR DELETE ON department_session_history FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE department_sessions (
  role text PRIMARY KEY CHECK(role IN ('researcher','evaluator')),
  actor text NOT NULL,
  session_id uuid NOT NULL UNIQUE REFERENCES department_session_history(session_id),
  sequence integer NOT NULL DEFAULT 0 CHECK(sequence>=0),
  fingerprint text,
  state text NOT NULL CHECK(state IN ('running','waiting','degraded','stopped')),
  completed_cycles integer NOT NULL DEFAULT 0 CHECK(completed_cycles>=0),
  failed_cycles integer NOT NULL DEFAULT 0 CHECK(failed_cycles>=0),
  failure_active boolean NOT NULL DEFAULT false,
  last_cycle_at timestamptz,
  last_seen timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NOT NULL
);
