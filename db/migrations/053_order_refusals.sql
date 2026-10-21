-- Refused orders (TRUST-03): a refused reserve or fill rolls its transaction back, so it used to leave no trace. Each
-- business refusal (HTTP 403, 404 or 409) is now kept in a small separate write after the rollback: who asked, the
-- stage, the bot, share, side and quantity (or the order), the proposal it carried out, and the refusal's status and
-- message. No foreign keys, so recording a refusal can never fail on the thing that was refused. Append-only; one row
-- per (actor, stage, idempotency key), so a retried request is recorded once.
CREATE TABLE order_refusals (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('reserve', 'fill')),
  idempotency_key text NOT NULL,
  bot_id text,
  symbol text,
  side text CHECK (side IN ('buy', 'sell')),
  quantity bigint,
  order_id uuid,
  signal_id uuid,
  status int NOT NULL CHECK (status BETWEEN 400 AND 499),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, stage, idempotency_key)
);
CREATE INDEX order_refusals_recent ON order_refusals (created_at DESC);
CREATE TRIGGER protect_order_refusals BEFORE UPDATE OR DELETE ON order_refusals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
