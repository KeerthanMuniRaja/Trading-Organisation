CREATE TABLE bot_knowledge_requests (
  request_id uuid PRIMARY KEY REFERENCES development_requests(id), bot_id text NOT NULL REFERENCES bots(id)
);
CREATE TABLE bot_knowledge_lessons (
  request_id uuid NOT NULL REFERENCES bot_knowledge_requests(request_id), lesson_id uuid NOT NULL REFERENCES lessons(id),
  PRIMARY KEY(request_id,lesson_id)
);
CREATE TABLE bot_knowledge_proposals (
  request_id uuid PRIMARY KEY REFERENCES bot_knowledge_requests(request_id), proposal jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bot_knowledge_reviews (
  request_id uuid PRIMARY KEY REFERENCES bot_knowledge_proposals(request_id), reviewer text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('accepted','rejected')), reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_bot_knowledge_requests BEFORE UPDATE OR DELETE ON bot_knowledge_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_knowledge_lessons BEFORE UPDATE OR DELETE ON bot_knowledge_lessons FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_knowledge_proposals BEFORE UPDATE OR DELETE ON bot_knowledge_proposals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_knowledge_reviews BEFORE UPDATE OR DELETE ON bot_knowledge_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
