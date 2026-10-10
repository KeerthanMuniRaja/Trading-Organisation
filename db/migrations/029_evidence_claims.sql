CREATE TABLE evidence_claims (
  id uuid PRIMARY KEY,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 240),
  quote text NOT NULL CHECK (char_length(quote) BETWEEN 20 AND 300),
  symbols text[] NOT NULL CHECK (cardinality(symbols) BETWEEN 1 AND 3),
  event_type text NOT NULL CHECK (event_type IN ('earnings','guidance','order-or-contract','regulatory-or-legal','management',
    'corporate-action','deal-or-investment','rating-or-target','macro-or-sector','other')),
  direction text NOT NULL CHECK (direction IN ('positive','negative','neutral','unclear')),
  event_date date,
  certainty text NOT NULL CHECK (certainty IN ('reported-fact','company-statement','forecast','opinion','rumour')),
  author text NOT NULL,
  content_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_claims_by_evidence ON evidence_claims(evidence_id);
CREATE TRIGGER protect_evidence_claims BEFORE UPDATE OR DELETE ON evidence_claims FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE evidence_claim_reviews (
  claim_id uuid PRIMARY KEY REFERENCES evidence_claims(id),
  decision text NOT NULL CHECK (decision IN ('accepted','rejected')),
  reviewer text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_evidence_claim_reviews BEFORE UPDATE OR DELETE ON evidence_claim_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
