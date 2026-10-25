-- A way back from suspension (management-v4). The management review may now recommend REINSTATING a bot that the loss
-- limit suspended, once it has served its time, holds nothing or has recovered, and its live calls do not lose to cash.
-- Reinstatement always comes with a proposed (smaller) budget, and a standing approval may carry it out. Only the allowed
-- kinds change; no existing row changes.
ALTER TABLE bot_recommendations DROP CONSTRAINT bot_recommendations_kind_check;
ALTER TABLE bot_recommendations ADD CONSTRAINT bot_recommendations_kind_check CHECK (kind IN ('watch', 'suspend', 'raise-budget', 'reduce-budget', 'reinstate', 'retire'));
ALTER TABLE bot_recommendations DROP CONSTRAINT bot_recommendations_budget_check;
ALTER TABLE bot_recommendations ADD CONSTRAINT bot_recommendations_budget_check CHECK ((kind IN ('raise-budget', 'reduce-budget', 'reinstate')) = (proposed_budget_paise IS NOT NULL));
ALTER TABLE autonomy_actions DROP CONSTRAINT autonomy_actions_kind_check;
ALTER TABLE autonomy_actions ADD CONSTRAINT autonomy_actions_kind_check CHECK (kind IN ('suspend', 'watch', 'raise-budget', 'reduce-budget', 'reinstate', 'birth',
  'release', 'qualification', 'starting-budget', 'trial', 'promotion', 'rollback'));
