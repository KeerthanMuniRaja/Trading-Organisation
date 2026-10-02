CREATE TABLE learning_workflows (
  id uuid PRIMARY KEY, owner_id text NOT NULL, researcher text NOT NULL, evaluator text NOT NULL,
  mentor_id text NOT NULL REFERENCES bots(id), recipient_id text NOT NULL REFERENCES bots(id),
  evidence_id uuid NOT NULL REFERENCES source_observations(evidence_id), task text NOT NULL,
  policy_revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(researcher<>evaluator AND mentor_id<>recipient_id)
);
CREATE TABLE learning_workflow_links (
  workflow_id uuid NOT NULL REFERENCES learning_workflows(id),
  step text NOT NULL CHECK(step IN ('source','transfer','assessment')),
  reference_id uuid NOT NULL UNIQUE, PRIMARY KEY(workflow_id,step), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE learning_workflow_cancellations (
  workflow_id uuid PRIMARY KEY REFERENCES learning_workflows(id), reason text NOT NULL,
  owner_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_learning_workflows BEFORE UPDATE OR DELETE ON learning_workflows FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_learning_workflow_links BEFORE UPDATE OR DELETE ON learning_workflow_links FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_learning_workflow_cancellations BEFORE UPDATE OR DELETE ON learning_workflow_cancellations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
