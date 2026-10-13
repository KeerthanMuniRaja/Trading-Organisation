-- A proposal may state the share of the bot's budget it wants in the instrument; the risk review never sizes beyond it.
ALTER TABLE trade_signals ADD COLUMN target_weight_pct integer CHECK (target_weight_pct IS NULL OR target_weight_pct BETWEEN 1 AND 100);
