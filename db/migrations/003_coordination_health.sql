CREATE TABLE coordination_health (
  actor text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('healthy', 'degraded')),
  code text NOT NULL CHECK (code IN ('SYNCED', 'OS_PROFILE_UNAVAILABLE', 'DEPENDENCIES_UNAVAILABLE', 'BACKEND_UNAVAILABLE', 'MCP_UNAVAILABLE', 'RECONCILIATION_REQUIRED', 'CAPACITY_REACHED')),
  task_count integer NOT NULL CHECK (task_count BETWEEN 0 AND 100),
  last_seen timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'healthy') = (code = 'SYNCED'))
);
