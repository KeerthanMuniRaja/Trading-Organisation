-- Relevance triage (KNOW-02): news and articles waiting for review are classified by fixed backend rules as in scope
-- (they name one of the tracked shares or a market-wide driver) or out of scope. Out-of-scope items are not rejected
-- (nobody judged them false); they are only set aside, so the review queue, backlog alert and digest count what matters.
-- One row per evidence item; append-only.
CREATE TABLE evidence_triage (
  evidence_id uuid PRIMARY KEY REFERENCES evidence(id),
  decision text NOT NULL CHECK (decision IN ('in-scope','out-of-scope')),
  matched text[] NOT NULL,
  rules_version text NOT NULL,
  triaged_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_evidence_triage BEFORE UPDATE OR DELETE ON evidence_triage FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
