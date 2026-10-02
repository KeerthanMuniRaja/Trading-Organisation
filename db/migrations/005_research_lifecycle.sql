ALTER TABLE bots ADD COLUMN lifecycle_managed boolean NOT NULL DEFAULT false;
ALTER TABLE bots ADD CONSTRAINT managed_bots_are_research_only
  CHECK (NOT lifecycle_managed OR (budget_paise=0 AND state IN ('school','college','retired')));
CREATE TABLE lifecycle_policy (
  id integer PRIMARY KEY CHECK(id=1), revision integer NOT NULL,
  rules jsonb NOT NULL, last_cycle_at timestamptz
);
INSERT INTO lifecycle_policy VALUES(1,0,'{"enabled":false,"maxActiveBots":4,"maxBirthsPerDay":2,"maxLifetimeBots":20,"minWindows":3,"reviewsBeforeRetirement":3,"mentorReviews":3,"positiveRewardBps":50,"negativeRewardBps":-50,"cycleSeconds":60}',NULL);
CREATE TABLE lifecycle_blueprints (
  id text PRIMARY KEY, name text NOT NULL, specialty text NOT NULL,
  method text NOT NULL CHECK(method IN ('equal_weight','inverse_volatility','minimum_variance')),
  novelty_key text UNIQUE NOT NULL, contribution text NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence(id),
  lesson_ids jsonb NOT NULL, mentor_id text REFERENCES bots(id),
  state text NOT NULL CHECK(state IN ('approved','used','blocked','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bot_lifecycle (
  bot_id text PRIMARY KEY REFERENCES bots(id),
  blueprint_id text UNIQUE NOT NULL REFERENCES lifecycle_blueprints(id),
  designation text NOT NULL CHECK(designation IN ('student','practising','mentor','retired')),
  reputation integer NOT NULL DEFAULT 0 CHECK(reputation BETWEEN -100 AND 100),
  negative_streak integer NOT NULL DEFAULT 0,
  positive_streak integer NOT NULL DEFAULT 0,
  retirement_pending boolean NOT NULL DEFAULT false,
  born_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz
);
CREATE TABLE lifecycle_reviews (
  id uuid PRIMARY KEY, bot_id text NOT NULL REFERENCES bots(id),
  policy_revision integer NOT NULL, policy jsonb NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('positive','negative','neutral')),
  mean_reward_bps double precision NOT NULL, details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lifecycle_review_trials (
  trial_id uuid PRIMARY KEY REFERENCES portfolio_trials(id),
  review_id uuid NOT NULL REFERENCES lifecycle_reviews(id)
);
CREATE TABLE bot_archives (
  bot_id text PRIMARY KEY REFERENCES bots(id), reason text NOT NULL,
  knowledge jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_lifecycle_reviews BEFORE UPDATE OR DELETE ON lifecycle_reviews FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_lifecycle_review_trials BEFORE UPDATE OR DELETE ON lifecycle_review_trials FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_bot_archives BEFORE UPDATE OR DELETE ON bot_archives FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
