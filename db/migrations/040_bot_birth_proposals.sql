-- Opportunity-driven bot births (LIFE-01): bots propose a new specialist with evidence and a success criterion; the owner
-- decides; an approved birth creates the bot in school with zero budget. Proposals and decisions are append-only.
CREATE TABLE bot_birth_proposals (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL CHECK (bot_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  department text NOT NULL REFERENCES departments(id),
  specialty text NOT NULL CHECK (specialty ~ '^[a-zA-Z0-9_-]{1,80}$'),
  method text NOT NULL CHECK (method ~ '^[a-zA-Z0-9_-]{1,80}$'),
  novelty_key text NOT NULL,
  contribution text NOT NULL CHECK (char_length(contribution) BETWEEN 1 AND 600),
  opportunity text NOT NULL CHECK (char_length(opportunity) BETWEEN 1 AND 1000),
  success_criterion text NOT NULL CHECK (char_length(success_criterion) BETWEEN 1 AND 600),
  proposer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bot_birth_proposal_evidence (
  proposal_id uuid NOT NULL REFERENCES bot_birth_proposals(id),
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (proposal_id, evidence_id)
);
CREATE TABLE bot_birth_decisions (
  proposal_id uuid PRIMARY KEY REFERENCES bot_birth_proposals(id),
  outcome text NOT NULL CHECK (outcome IN ('approved','rejected')),
  mentor_id text REFERENCES bots(id),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 600),
  decided_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_bot_birth_proposals BEFORE UPDATE OR DELETE ON bot_birth_proposals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_birth_proposal_evidence BEFORE UPDATE OR DELETE ON bot_birth_proposal_evidence FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_birth_decisions BEFORE UPDATE OR DELETE ON bot_birth_decisions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
