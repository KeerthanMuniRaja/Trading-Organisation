-- Department registry (ORG-01): charters with mandate, lead and an owner-set budget ceiling; evidence-based proposals to
-- open or close a department; owner decisions. Membership is the bots' existing department label.
-- Proposals and decisions are append-only; the departments table changes only through audited owner actions.
CREATE TABLE departments (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  mandate text NOT NULL CHECK (char_length(mandate) BETWEEN 1 AND 600),
  lead_bot_id text REFERENCES bots(id),
  budget_paise bigint NOT NULL CHECK (budget_paise >= 0),
  status text NOT NULL CHECK (status IN ('active','closed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE TABLE department_proposals (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('open','close')),
  department_id text NOT NULL CHECK (department_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 120),
  mandate text CHECK (mandate IS NULL OR char_length(mandate) BETWEEN 1 AND 600),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 1000),
  proposer text NOT NULL,
  content_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'close' OR (name IS NOT NULL AND mandate IS NOT NULL))
);
CREATE TABLE department_proposal_evidence (
  proposal_id uuid NOT NULL REFERENCES department_proposals(id),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (proposal_id, evidence_id)
);
CREATE TABLE department_decisions (
  id uuid PRIMARY KEY,
  proposal_id uuid UNIQUE NOT NULL REFERENCES department_proposals(id),
  outcome text NOT NULL CHECK (outcome IN ('approved','rejected')),
  budget_paise bigint CHECK (budget_paise IS NULL OR budget_paise >= 0),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 600),
  decided_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_department_proposals BEFORE UPDATE OR DELETE ON department_proposals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_department_proposal_evidence BEFORE UPDATE OR DELETE ON department_proposal_evidence FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_department_decisions BEFORE UPDATE OR DELETE ON department_decisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
