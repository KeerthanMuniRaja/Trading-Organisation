import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_allocator as ai
import curriculum
import daily
from test_ai_allocator import EVEN, SYMBOLS, Stub
from test_daily import synthetic_daily

TILT = {**{k: 15 for k in 'ABCD'}, **{k: 10 for k in 'EFGH'}, 'rationale': 'Tilt toward the trend.'}


def month(n, above=7, teacher_pct=2.0, model_pct=1.0, cash=10.0):
    facts = {k: {'return6mPct': 5.0, 'above200dAverage': i < above} for i, k in enumerate(ai.LETTERS)}
    return {'month': n, 'day': f'2022-{n:02d}-01', 'sharesAbove200d': above, 'basketPct': 1.0, 'modelPct': model_pct,
            'teacherPct': teacher_pct, 'cashPct': cash, 'teacherCashPct': 0.0, 'cashDragPct': -0.1, 'selectionPct': 0.05,
            'turnoverPct': 20.0, 'facts': facts, 'teacher': {**TILT}}


class LessonTests(unittest.TestCase):
    def test_lessons_and_examples_never_use_held_out_months(self):
        months = [month(1), month(2, above=4, teacher_pct=5.0), month(3, teacher_pct=0.5), month(4, teacher_pct=4.0)]
        later = [month(5, teacher_pct=50.0, cash=90.0), month(6, above=1, teacher_pct=60.0)]
        stats = curriculum.study_stats(months + later, 4)
        examples = curriculum.pick_examples(months + later, 4)
        changed = [{**m, 'teacherPct': -9.0, 'cashPct': 0.0, 'above': 0} for m in later]
        self.assertEqual(stats, curriculum.study_stats(months + changed, 4))
        self.assertEqual(curriculum.taught_system(stats, examples),
                         curriculum.taught_system(curriculum.study_stats(months + changed, 4), curriculum.pick_examples(months + changed, 4)))
        self.assertEqual([m['month'] for m in examples], [2, 4])  # best mixed month and best uptrend month; month 3 lost
        self.assertEqual(stats['months'], 4)
        self.assertEqual(stats['teacherWeightAbove200d'], 13.2)  # (3 months x (4x15 + 3x10) + 4x15) / 25 shares above
        text = curriculum.lessons(stats)
        self.assertIn('10.0% in cash', text)
        self.assertIn('untested', text)  # no downtrend month was studied, and the lesson says so

    def test_the_default_prompt_fingerprint_is_unchanged_and_taught_prompts_differ(self):
        original = hashlib.sha256((ai.SYSTEM + json.dumps(ai.SCHEMA, sort_keys=True)).encode()).hexdigest()[:16]
        self.assertEqual(ai.PROMPT_VERSION, original)
        self.assertNotEqual(ai.prompt_version(ai.SYSTEM, True), original)
        self.assertNotEqual(ai.prompt_version(ai.SYSTEM + 'x'), original)


class TaughtRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        self.cache, self.root, self.out = tmp / 'daily', tmp / 'runs', tmp / 'curricula'
        self.cache.mkdir()
        for k, symbol in enumerate(SYMBOLS):
            data = synthetic_daily(symbol, drift=0.0003 - 0.0001 * (k % 4), seed=5 + k)
            (self.cache / f'{symbol}-1d.json').write_text(json.dumps(data), encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def test_build_teach_and_compare_on_held_out_months_only(self):
        student = ai.replay('student', Stub(EVEN), 'stub', '2024-06-03', cache=self.cache, root=self.root)
        teacher_path = self.root / 'student' / 'teacher.json'
        # even answers mean the same thing under every run's letter mapping, so all three arms must match exactly
        teacher_path.write_text(json.dumps({f'{n:02d}': EVEN for n in range(1, student['months'] + 1)}), encoding='utf-8')
        record = curriculum.build('student', teacher_path, 6, 'lessons', cache=self.cache, root=self.root, out=self.out)
        self.assertGreater(record['heldOutFrom'], student['from'])
        with self.assertRaisesRegex(ValueError, 'frozen'):
            curriculum.build('student', teacher_path, 6, 'lessons', cache=self.cache, root=self.root, out=self.out)

        stub = Stub(EVEN)
        taught = ai.replay('taught', stub, 'stub', record['heldOutFrom'], cache=self.cache, root=self.root,
                           system=record['system'], held=True)
        self.assertEqual(taught['promptVersion'], record['promptVersion'])
        self.assertEqual(stub.calls[0]['currentWeights'], {k: 0 for k in ai.LETTERS})  # starts in cash
        self.assertEqual(stub.calls[1]['currentWeights'], {k: 12 for k in ai.LETTERS})  # then sees what it holds
        with self.assertRaisesRegex(ValueError, 'different model, prompt'):
            ai.replay('taught', stub, 'stub', record['heldOutFrom'], cache=self.cache, root=self.root)  # untaught prompt refused

        report = curriculum.compare('lessons', 'taught', cache=self.cache, root=self.root, out=self.out)
        self.assertEqual(report['heldOutFrom'], record['heldOutFrom'])
        self.assertEqual(report['heldOutMonths'], taught['months'])
        results = report['results']
        self.assertEqual(results['taught-student'], results['teacher'])  # same start, same cash, same costs
        self.assertEqual(results['taught-student'], results['untaught-student'])
        self.assertNotEqual(results['untaught-picks-fully-invested'], results['untaught-student'])
        self.assertEqual(report['habits']['taught-student'], {'averageCashPct': 4.0, 'averageTurnoverPct': 0.0, 'failedMonths': 0})
        self.assertEqual(report['trialsOnTheseMonths'], 1)
        monthly = report['versusBasketMonthly']['taught-student']
        self.assertEqual(monthly['months'], report['heldOutMonths'] - 1)  # the entry month from cash is left out
        self.assertLessEqual(monthly['monthsAheadOfBasket'] + monthly['monthsBehindBasket'], monthly['months'])
        self.assertEqual(monthly['verdict'], 'insufficient-evidence')  # a few synthetic months never prove anything
        payload = curriculum.fitness_payload(report, 'org-allocator')
        self.assertEqual((payload['role'], payload['baseline'], payload['judged'], payload['periodFrom']),
                         ('portfolio-allocator', 'equal-weight-basket', monthly['months'], record['heldOutFrom']))
        self.assertNotIn('verdict', payload)  # the backend computes the verdict from the counts
        self.assertEqual(curriculum.compare('lessons', 'taught', cache=self.cache, root=self.root, out=self.out)['trialsOnTheseMonths'], 1)
        # a second, different curriculum judged on the same months is a second trial, and the report says so
        other = self.root / 'student' / 'teacher2.json'
        other.write_text(json.dumps({f'{n:02d}': {**EVEN, **{k: 13 for k in ai.LETTERS}} for n in range(1, student['months'] + 1)}),
                         encoding='utf-8')
        second = curriculum.build('student', other, 6, 'lessons2', cache=self.cache, root=self.root, out=self.out)
        self.assertNotEqual(second['promptVersion'], record['promptVersion'])
        ai.replay('taught2', Stub(EVEN), 'stub', second['heldOutFrom'], cache=self.cache, root=self.root, system=second['system'], held=True)
        again = curriculum.compare('lessons2', 'taught2', cache=self.cache, root=self.root, out=self.out)
        self.assertEqual(again['trialsOnTheseMonths'], 2)
        self.assertIn('partly seen', again['note'])
        self.assertEqual(len((self.out / 'trials.jsonl').read_text(encoding='utf-8').splitlines()), 2)
        ai.replay('wrong', Stub(EVEN), 'stub', record['heldOutFrom'], cache=self.cache, root=self.root)
        with self.assertRaisesRegex(ValueError, 'not taught'):
            curriculum.compare('lessons', 'wrong', cache=self.cache, root=self.root, out=self.out)


if __name__ == '__main__':
    unittest.main()
