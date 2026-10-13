-- R&D hackathons (RD-01): owner-set challenges with a concealed evaluation window, versioned bot entries, independent
-- judging with evidence, and recorded findings (including negative results). Entries, results and findings are
-- append-only; a challenge's status only moves forward (open -> judging -> closed) through audited owner actions.
CREATE TABLE hackathons (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 1000),
  metric text NOT NULL CHECK (char_length(metric) BETWEEN 1 AND 120),
  higher_is_better boolean NOT NULL,
  baseline text NOT NULL CHECK (char_length(baseline) BETWEEN 1 AND 120),
  entry_deadline timestamptz NOT NULL,
  max_entries_per_bot integer NOT NULL CHECK (max_entries_per_bot BETWEEN 1 AND 10),
  window_from date NOT NULL,
  window_to date NOT NULL CHECK (window_to >= window_from),
  window_commit text NOT NULL,
  status text NOT NULL CHECK (status IN ('open','judging','closed')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hackathon_entries (
  id uuid PRIMARY KEY,
  hackathon_id text NOT NULL REFERENCES hackathons(id),
  bot_id text NOT NULL REFERENCES bots(id),
  version integer NOT NULL CHECK (version >= 1),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  spec jsonb NOT NULL,
  spec_hash text NOT NULL,
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hackathon_id, bot_id, version),
  UNIQUE (hackathon_id, spec_hash)
);
CREATE TABLE hackathon_results (
  id uuid PRIMARY KEY,
  entry_id uuid UNIQUE NOT NULL REFERENCES hackathon_entries(id),
  score numeric NOT NULL,
  baseline_score numeric NOT NULL,
  beat_baseline boolean NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 600),
  judge text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hackathon_findings (
  id uuid PRIMARY KEY,
  hackathon_id text NOT NULL REFERENCES hackathons(id),
  kind text NOT NULL CHECK (kind IN ('positive','negative','next-step')),
  finding text NOT NULL CHECK (char_length(finding) BETWEEN 1 AND 1000),
  evidence_id uuid REFERENCES evidence(id),
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_hackathon_entries BEFORE UPDATE OR DELETE ON hackathon_entries FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_hackathon_results BEFORE UPDATE OR DELETE ON hackathon_results FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_hackathon_findings BEFORE UPDATE OR DELETE ON hackathon_findings FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
