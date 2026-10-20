-- Bot releases (RELEASE-01, AI-02): each bot version binds model, prompt and code fingerprints; it is evaluated against
-- the bot's own fitness record for that model, activated by the owner (canary, then active), and can be rolled back or
-- revoked. Workers ask whether their exact version is authorised before running. All history is append-only.
CREATE TABLE bot_releases (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  version integer NOT NULL CHECK (version >= 1),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  prompt_version text NOT NULL CHECK (prompt_version ~ '^[a-zA-Z0-9._-]{1,64}$'),
  code_fingerprint text NOT NULL CHECK (code_fingerprint ~ '^[a-f0-9]{16,64}$'),
  settings jsonb NOT NULL,
  notes text NOT NULL CHECK (char_length(notes) BETWEEN 1 AND 600),
  author text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, version),
  UNIQUE (bot_id, model, prompt_version, code_fingerprint)
);
CREATE TABLE bot_release_evaluations (
  id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES bot_releases(id),
  fitness_report_id uuid NOT NULL REFERENCES bot_fitness_reports(id),
  fitness_verdict text NOT NULL,
  canary_eligible boolean NOT NULL,
  active_eligible boolean NOT NULL,
  evaluator text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, fitness_report_id)
);
CREATE TABLE bot_release_stages (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(id),
  release_id uuid NOT NULL REFERENCES bot_releases(id),
  stage text NOT NULL CHECK (stage IN ('canary','active','revoked')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 600),
  decided_by text NOT NULL,
  sequence bigserial NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_release_stages_by_bot ON bot_release_stages(bot_id, sequence);
CREATE TRIGGER protect_bot_releases BEFORE UPDATE OR DELETE ON bot_releases FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_release_evaluations BEFORE UPDATE OR DELETE ON bot_release_evaluations FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_release_stages BEFORE UPDATE OR DELETE ON bot_release_stages FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
