CREATE TABLE knowledge_assessments (
  id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE REFERENCES bot_knowledge_reviews(request_id),
  evaluator text NOT NULL, inference_request_id uuid NOT NULL UNIQUE REFERENCES development_requests(id),
  cases jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '1 hour')
);
CREATE TABLE knowledge_assessment_answers (
  assessment_id uuid PRIMARY KEY REFERENCES knowledge_assessments(id), author text NOT NULL,
  answers jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_assessment_results (
  assessment_id uuid PRIMARY KEY REFERENCES knowledge_assessments(id), evaluator text NOT NULL,
  report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_knowledge_assessments BEFORE UPDATE OR DELETE ON knowledge_assessments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_knowledge_assessment_answers BEFORE UPDATE OR DELETE ON knowledge_assessment_answers FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_knowledge_assessment_results BEFORE UPDATE OR DELETE ON knowledge_assessment_results FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
