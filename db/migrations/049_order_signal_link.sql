-- One order per reviewed proposal (PAPER-04): the link is stored on the order, inside the reservation transaction, so a
-- second credential or a retry can never reserve a second order for the same proposal, and lapses and executions find
-- the proposal's own order rather than whichever command used a matching key. Earlier executions are linked from
-- their deterministic reservation keys (sigexec-reserve-<signal id>).
ALTER TABLE orders ADD COLUMN signal_id uuid UNIQUE REFERENCES trade_signals(id);
UPDATE orders o SET signal_id = s.id
  FROM commands c JOIN trade_signals s ON s.id::text = substring(c.key from 17)
  WHERE c.namespace = 'reserve-order' AND c.key ~ '^sigexec-reserve-[0-9a-f-]{36}$' AND o.id = (c.response->>'id')::uuid;
