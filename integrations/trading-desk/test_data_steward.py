from datetime import date, timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data_steward as ds


def series(closes, start=date(2026, 6, 1)):
    bars, day = [], start
    for c in closes:
        while day.weekday() >= 5:
            day += timedelta(days=1)
        bars.append({'date': day.isoformat(), 'openPaise': c, 'highPaise': c, 'lowPaise': c, 'closePaise': c, 'volume': 1000})
        day += timedelta(days=1)
    return {'symbol': 'TEST.NS', 'bars': bars}


TODAY = date(2026, 6, 1) + timedelta(days=60)
BASE = [100000 + 100 * (i % 7) for i in range(40)]


class StewardTests(unittest.TestCase):
    def test_a_clean_refresh_with_a_dividend_adjustment_is_accepted(self):
        old = series(BASE)
        # new download: one more day, and every day before day 30 rescaled by 0.99 (a 1% dividend went ex on day 30)
        new = series([round(c * 0.99) if i < 30 else c for i, c in enumerate(BASE)] + [100300])
        result = ds.review(new, old, today=date.fromisoformat(new['bars'][-1]['date']))
        self.assertEqual(result['verdict'], 'ok')
        r = ds.rewrite(old['bars'], new['bars'])
        self.assertEqual((r['adjustmentSteps'], r['rewritten']), (1, False))

    def test_an_adjusted_bonus_is_accepted_but_flagged_for_the_owner_to_record(self):
        old = series(BASE)
        # the day after the old file ends, a 1:1 bonus goes ex: the provider halves the whole past, today trades near half
        new = series([round(c / 2) for c in BASE] + [50100])
        result = ds.review(new, old, today=date.fromisoformat(new['bars'][-1]['date']))
        self.assertEqual(result['verdict'], 'warning')
        flag = next(i for i in result['issues'] if i['check'] == 'corporate-action-suspected')
        self.assertEqual((flag['factor'], flag['likelyExDate']), (2.0, new['bars'][-1]['date']))
        self.assertIn('/v1/corporate-actions', flag['action'])
        dividend = series([round(c * 0.97) for c in BASE] + [100300])  # a 3% dividend is not a corporate action
        self.assertNotIn('corporate-action-suspected', [i['check'] for i in ds.review(dividend, old, today=TODAY)['issues']])

    def test_a_genuine_big_move_is_kept_back_until_the_owner_confirms_it_then_accepted(self):
        old = series(BASE)
        crash = series(BASE + [75000])  # a genuine -25% session on a results day
        day = crash['bars'][-1]['date']
        self.assertEqual(ds.review(crash, old, today=date.fromisoformat(day))['verdict'], 'reject')
        self.assertEqual(ds.review(crash, old, today=date.fromisoformat(day), accepted=[day])['verdict'], 'ok')  # owner confirmed
        later = series(BASE + [75000, 75500])
        self.assertNotIn('extreme-move', [i['check'] for i in ds.review(later, crash, today=TODAY)['issues']])  # known from then on

    def test_an_unadjusted_split_or_bad_print_is_rejected(self):
        halved = series(BASE[:20] + [c // 2 for c in BASE[20:]])  # a 1:1 bonus left unadjusted looks like a 50% crash
        result = ds.review(halved, today=TODAY)
        self.assertEqual(result['verdict'], 'reject')
        self.assertEqual(result['issues'][0]['check'], 'extreme-move')
        self.assertEqual(result['issues'][0]['changePct'], -50.0)

    def test_a_rewritten_past_is_rejected_even_without_big_moves(self):
        old = series(BASE)
        blip = [c * 1.01 if 10 <= i < 12 else c for i, c in enumerate(BASE)]  # two old days quietly changed by 1%
        new = series([round(c) for c in blip])
        result = ds.review(new, old, today=TODAY)
        self.assertEqual(result['verdict'], 'reject')
        self.assertIn('history-rewrite', [i['check'] for i in result['issues']])

    def test_gaps_and_staleness_are_warnings_not_rejections(self):
        mine = series(BASE)
        peer = series(BASE)
        mine['bars'].pop(15)  # a session the peers traded
        result = ds.review(mine, peers=[peer, peer], today=date(2026, 12, 1))
        self.assertEqual(result['verdict'], 'warning')
        self.assertEqual(sorted(i['check'] for i in result['issues']), ['gaps', 'stale'])

    def test_replaced_versions_are_archived_by_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'TEST.NS-1d.json'
            old = series(BASE)
            archived = ds.archive(path, old, Path(tmp) / 'history')
            self.assertEqual(archived.name, f'TEST.NS-1d-{ds.fingerprint(old)}.json')
            self.assertEqual(json.loads(archived.read_text(encoding='utf-8')), old)
            self.assertEqual(ds.archive(path, old, Path(tmp) / 'history'), archived)  # idempotent


class StoreTests(unittest.TestCase):
    def test_daily_store_keeps_the_previous_file_on_reject_and_archives_on_accept(self):
        import daily
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            path = cache / 'TEST.NS-1d.json'
            good = series(BASE)
            path.write_text(json.dumps(good), encoding='utf-8')
            bad = series(BASE[:20] + [c // 2 for c in BASE[20:]])
            result = daily.store(path, bad, cache)
            self.assertEqual((result['state'], result['quality']), ('kept-previous', 'reject'))
            self.assertEqual(json.loads(path.read_text(encoding='utf-8')), good)  # good data untouched
            newer = series(BASE + [100200])
            result = daily.store(path, newer, cache)
            self.assertEqual(result['state'], 'downloaded')
            self.assertTrue((cache / 'history' / result['archived']).exists())
            self.assertEqual(json.loads(path.read_text(encoding='utf-8')), newer)


if __name__ == '__main__':
    unittest.main()
