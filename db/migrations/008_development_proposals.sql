CREATE TABLE development_policy (
  id integer PRIMARY KEY CHECK(id=1),revision integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,model jsonb,
  max_per_day integer NOT NULL CHECK(max_per_day BETWEEN 1 AND 10),
  max_lifetime integer NOT NULL CHECK(max_lifetime BETWEEN 1 AND 100)
);
INSERT INTO development_policy(id,max_per_day,max_lifetime) VALUES(1,1,10);
CREATE TABLE development_requests (
  id uuid PRIMARY KEY,author text NOT NULL,policy_revision integer NOT NULL,
  model jsonb NOT NULL,context jsonb NOT NULL,context_hash text NOT NULL,
  expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_development_requests BEFORE UPDATE OR DELETE ON development_requests FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE development_proposals (
  request_id uuid PRIMARY KEY REFERENCES development_requests(id),
  proposal jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_development_proposals BEFORE UPDATE OR DELETE ON development_proposals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE development_reviews (
  request_id uuid PRIMARY KEY REFERENCES development_proposals(request_id),
  decision text NOT NULL CHECK(decision IN ('recommended','rejected')),
  reason text NOT NULL,reviewer text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_development_reviews BEFORE UPDATE OR DELETE ON development_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
