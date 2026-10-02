CREATE TABLE source_learning_requests (
  request_id uuid PRIMARY KEY REFERENCES development_requests(id),
  bot_id text NOT NULL REFERENCES bots(id), evidence_id uuid NOT NULL REFERENCES source_observations(evidence_id)
);
CREATE TABLE source_learning_proposals (
  request_id uuid PRIMARY KEY REFERENCES source_learning_requests(request_id),
  lesson_id uuid NOT NULL UNIQUE REFERENCES lessons(id), proposal jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE source_learning_reviews (
  request_id uuid PRIMARY KEY REFERENCES source_learning_proposals(request_id),
  reviewer text NOT NULL, decision text NOT NULL CHECK(decision IN ('accepted','rejected')),
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_source_learning_requests BEFORE UPDATE OR DELETE ON source_learning_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_source_learning_proposals BEFORE UPDATE OR DELETE ON source_learning_proposals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_source_learning_reviews BEFORE UPDATE OR DELETE ON source_learning_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
