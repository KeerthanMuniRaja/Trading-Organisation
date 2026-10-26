-- Founder charter (CHARTER-01): the owner sets the boundaries once, and the organisation runs itself inside them.
-- Budget follows evidence both ways: the management review (management-v2) may now recommend a budget REDUCTION for a
-- bot that keeps trailing the basket, and a standing approval may carry it out. The organisation's last-resort stop is
-- recorded as an automatic action. Only the allowed kinds change; no existing row changes.
ALTER TABLE bot_recommendations DROP CONSTRAINT bot_recommendations_kind_check;
ALTER TABLE bot_recommendations ADD CONSTRAINT bot_recommendations_kind_check CHECK (kind IN ('watch', 'suspend', 'raise-budget', 'reduce-budget', 'retire'));
ALTER TABLE bot_recommendations DROP CONSTRAINT bot_recommendations_check;
ALTER TABLE bot_recommendations ADD CONSTRAINT bot_recommendations_budget_check CHECK ((kind IN ('raise-budget', 'reduce-budget')) = (proposed_budget_paise IS NOT NULL));
ALTER TABLE autonomy_actions DROP CONSTRAINT autonomy_actions_kind_check;
ALTER TABLE autonomy_actions ADD CONSTRAINT autonomy_actions_kind_check CHECK (kind IN ('suspend', 'watch', 'raise-budget', 'reduce-budget', 'birth', 'release',
  'qualification', 'starting-budget', 'trial', 'promotion', 'rollback'));
