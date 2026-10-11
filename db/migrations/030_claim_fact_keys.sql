-- Fact keys make claims comparable: which figure (metric), for which period, and the reported change.
-- Corroboration and contradiction use only claims that carry a fact key; price-direction opinions never decide them.
ALTER TABLE evidence_claims
  ADD COLUMN metric text CHECK (metric IS NULL OR char_length(metric) BETWEEN 1 AND 60),
  ADD COLUMN period text CHECK (period IS NULL OR char_length(period) BETWEEN 1 AND 40),
  ADD COLUMN reported_change_pct numeric CHECK (reported_change_pct IS NULL OR reported_change_pct BETWEEN -1000 AND 1000),
  ADD CONSTRAINT evidence_claims_fact_key_complete CHECK ((metric IS NULL) = (period IS NULL)),
  ADD CONSTRAINT evidence_claims_change_needs_key CHECK (reported_change_pct IS NULL OR metric IS NOT NULL);
