-- Each trade proposal records the bot release it came from (RELEASE-01), so live outcomes can be compared by release.
ALTER TABLE trade_signals ADD COLUMN release_id uuid REFERENCES bot_releases(id);
