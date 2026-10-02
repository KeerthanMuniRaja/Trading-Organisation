ALTER TABLE evidence DROP CONSTRAINT evidence_status_check;
ALTER TABLE evidence ADD CONSTRAINT evidence_status_check CHECK(status IN ('unverified','verified','rejected','revoked'));
