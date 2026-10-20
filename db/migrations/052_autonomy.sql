-- Standing approvals (AUTO-03). The owner approves classes of decisions once, with limits, instead of one by one; the
-- organisation's agents then carry out matching decisions themselves. The newest policy row is the policy (an empty
-- history means nothing is automatic). Every automatic action is recorded with the policy that allowed it. Both are
-- append-only; agents can never write a policy.
CREATE TABLE autonomy_policies (
  id uuid PRIMARY KEY,
  rules jsonb NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 600),
  set_by text NOT NULL,
  sequence bigserial,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE autonomy_actions (
  id uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES autonomy_policies(id),
  kind text NOT NULL CHECK (kind IN ('suspend', 'watch', 'raise-budget', 'birth', 'release', 'qualification', 'starting-budget', 'promotion', 'rollback')),
  target text NOT NULL,
  amount_paise bigint CHECK (amount_paise IS NULL OR amount_paise >= 0),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX autonomy_actions_month ON autonomy_actions (created_at);
CREATE TRIGGER protect_autonomy_policies BEFORE UPDATE OR DELETE ON autonomy_policies FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER protect_autonomy_actions BEFORE UPDATE OR DELETE ON autonomy_actions FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
