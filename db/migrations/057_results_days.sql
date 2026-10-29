-- Results days (PROTECT-03, founderReview W13): the evaluator files each share's coming results day from the press
-- calendar, so the owner's `preResultsSizing` brake can size a buy down just before it. A wrong or stale date can only
-- make a buy smaller, never larger, and exits are never affected. Append-only: a moved date is filed as a new day.
CREATE TABLE results_days (
  symbol text NOT NULL CHECK (symbol ~ '^[A-Z0-9&_-]{1,30}$'),
  day date NOT NULL,
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 200),
  filed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, day)
);
CREATE TRIGGER protect_results_days BEFORE UPDATE OR DELETE ON results_days FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
