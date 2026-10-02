CREATE TABLE research_dispatch_policy (
  id integer PRIMARY KEY CHECK(id=1),
  revision integer NOT NULL DEFAULT 0,
  rules jsonb NOT NULL
);
INSERT INTO research_dispatch_policy VALUES (1,0,'{"enabled":false,"maxAssignmentsPerDay":12,"maxLifetimeAssignments":100,"datasetIds":[]}');

CREATE TABLE research_assignments (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  dataset_id uuid NOT NULL REFERENCES portfolio_datasets(id),
  method text NOT NULL CHECK(method IN ('equal_weight','inverse_volatility','minimum_variance')),
  policy_revision integer NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','running','submitted','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  trial_id uuid UNIQUE REFERENCES portfolio_trials(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bot_id,dataset_id,method),
  CHECK((state='running') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((state='submitted') = (trial_id IS NOT NULL))
);
CREATE INDEX research_assignments_queue ON research_assignments(state,created_at);
