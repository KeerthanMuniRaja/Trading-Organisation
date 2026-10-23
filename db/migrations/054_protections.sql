-- Self-expiring protections (PROTECT-01): the owner sets loss brakes once, and a bot's new buys pause by themselves
-- after a realised loss over a recent window, after a streak of losing exits, or for a share it just sold. Each pause
-- lifts by itself as its window rolls on; exits are never blocked. The policy history is append-only and the latest row
-- decides; with no row, nothing is paused. The index serves the per-bot realised-loss and exit lookups.
CREATE TABLE protection_policies (
  id uuid PRIMARY KEY,
  rules jsonb NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 600),
  set_by text NOT NULL,
  sequence bigserial,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protect_protection_policies BEFORE UPDATE OR DELETE ON protection_policies FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE INDEX journals_bot_kind ON journals ((metadata->>'botId'), kind, created_at DESC);
