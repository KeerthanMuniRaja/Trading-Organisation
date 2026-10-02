CREATE TABLE development_experiments (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES development_proposals(request_id),
  bot_id text NOT NULL REFERENCES bots(id),
  method text NOT NULL CHECK(method IN ('equal_weight','inverse_volatility','minimum_variance')),
  operational_definition text NOT NULL,
  thresholds jsonb NOT NULL,
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE development_experiment_windows (
  experiment_id uuid NOT NULL REFERENCES development_experiments(id),
  dataset_id uuid NOT NULL UNIQUE REFERENCES portfolio_datasets(id),
  PRIMARY KEY(experiment_id,dataset_id)
);
CREATE TABLE development_experiment_results (
  experiment_id uuid PRIMARY KEY REFERENCES development_experiments(id),
  outcome text NOT NULL CHECK(outcome IN ('supported-for-further-research','not-supported')),
  report jsonb NOT NULL,
  reviewer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE development_experiment_cancellations (
  experiment_id uuid PRIMARY KEY REFERENCES development_experiments(id),
  reason text NOT NULL,actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_development_experiments BEFORE UPDATE OR DELETE ON development_experiments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_development_experiment_windows BEFORE UPDATE OR DELETE ON development_experiment_windows FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_development_experiment_results BEFORE UPDATE OR DELETE ON development_experiment_results FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_development_experiment_cancellations BEFORE UPDATE OR DELETE ON development_experiment_cancellations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
