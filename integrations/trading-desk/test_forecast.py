from datetime import datetime
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch
import desk
import forecast
import forecast_eval
from test_desk import StubModel, synthetic

HAS_NUMPY = importlib.util.find_spec('numpy') is not None


class FakeForecaster:
    """Forecasts the last hour's move again; records the newest bar it was shown."""
    name = 'fake-momentum@0000-s1'
    samples = 1

    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def __call__(self, bars, i):
        window = forecast.history(bars, i)
        self.calls.append((i, len(bars)))
        if window is None:
            return None
        if self.fail:
            raise RuntimeError('model crashed')
        return {'model': self.name, 'expectedReturn1HourBps': desk.bps(window[-1]['closePaise'], window[-12]['closePaise']),
                'lookbackBars': len(window), 'samplesAveraged': 1, 'seed': 0}


class ForecastRuleTests(unittest.TestCase):
    def test_future_times_follow_the_session_calendar(self):
        times = forecast.future_times('2026-01-09T15:15:00+05:30', 4)  # a Friday afternoon
        self.assertEqual([t.isoformat() for t in times], ['2026-01-09T15:20:00+05:30', '2026-01-09T15:25:00+05:30',
                                                          '2026-01-12T09:15:00+05:30', '2026-01-12T09:20:00+05:30'])

    def test_history_uses_only_completed_bars_and_abstains_when_short(self):
        bars = synthetic()['bars']
        self.assertIsNone(forecast.history(bars, forecast.MIN_HISTORY - 2))
        window = forecast.history(bars, 200)
        self.assertEqual(window[-1], bars[200])
        self.assertEqual(len(window), 201)
        self.assertEqual(len(forecast.history(bars * 3, 600)), forecast.LOOKBACK)

    def test_stance_follows_fixed_cost_aware_rules(self):
        self.assertEqual(forecast.opinion(25)['stance'], 'neutral')
        self.assertEqual((forecast.opinion(45)['stance'], forecast.opinion(45)['conviction']), ('bullish', 'low'))
        self.assertEqual((forecast.opinion(-70)['stance'], forecast.opinion(-70)['conviction']), ('bearish', 'medium'))
        self.assertEqual(forecast.opinion(95)['conviction'], 'high')
        self.assertTrue(desk.valid_opinion(forecast.opinion(-130)))
        with self.assertRaises(ValueError):
            forecast.build('Kronos-large')


class DeskForecastTests(unittest.TestCase):
    def test_forecast_analyst_joins_the_meeting_without_a_model_call(self):
        model, forecaster = StubModel(), FakeForecaster()
        result = desk.run_desk(synthetic(), model, every=12, max_decisions=12, forecaster=forecaster)
        meetings = [d for d in result['decisions'] if d['type'] == 'desk-meeting']
        for i, seen in forecaster.calls:
            self.assertEqual(seen, len(synthetic()['bars']))  # the full list is passed, but history() cuts at i
        first = meetings[0]['bots']['forecast-analyst']
        self.assertEqual(first, {'outcome': 'not-consulted', 'reason': 'insufficient-history'})  # 10:10 on day one
        consulted = [d for d in meetings if d['bots']['forecast-analyst']['outcome'] == 'valid']
        self.assertTrue(consulted)
        self.assertEqual(result['modelCalls'], len(model.calls))  # forecasts are not language-model calls
        managers = [p for r, p, _ in model.calls if r == 'portfolio-manager']
        self.assertTrue(any('forecast-analyst' in p['opinions'] for p in managers))
        for role, payload, schema in model.calls:
            if role == 'portfolio-manager':
                self.assertEqual(set(schema['properties']['reliedOn']['items']['enum']), set(payload['opinions']))
            else:
                self.assertNotIn('forecast', json.dumps(payload))  # analysts never see the forecast
        card = result['scorecards']['analysts']['forecast-analyst']
        self.assertEqual(card['opinions'] + card['notConsulted'] + card['abstained'], len(meetings))
        self.assertEqual(card['opinions'], len(consulted))

    def test_a_crashing_forecaster_becomes_an_abstention(self):
        result = desk.run_desk(synthetic(), StubModel(), every=12, max_decisions=18, forecaster=FakeForecaster(fail=True))
        logs = [d['bots']['forecast-analyst'] for d in result['decisions'] if d['type'] == 'desk-meeting']
        failed = [log for log in logs if log['outcome'] == 'failed']
        self.assertTrue(failed)
        self.assertTrue(all(log['failure'] == 'RuntimeError' and log['opinion'] == desk.ABSTAIN for log in failed))
        self.assertTrue(all(log['outcome'] in ('failed', 'not-consulted') for log in logs))
        self.assertEqual(result['scorecards']['analysts']['forecast-analyst']['abstained'], len(failed))
        self.assertTrue(all('portfolio-manager' in d['bots'] for d in result['decisions'] if d['type'] == 'desk-meeting'))

    def test_batch_with_a_forecaster_labels_and_keeps_its_results_apart(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            path = tmp / 'w.json'
            path.write_text(json.dumps(synthetic()), encoding='utf-8')
            plain = batch.run_batch([path], StubModel(), tmp / 'b', every=12, max_decisions=8, max_calls=100, model='stub')
            treated = batch.run_batch([path], StubModel(), tmp / 'b', every=12, max_decisions=8, max_calls=100,
                                      model='stub+fake', forecaster=FakeForecaster())
            self.assertGreater(treated['modelCallsThisRun'], 0)  # not reused from the plain run
            self.assertEqual(plain['analysts']['forecast-analyst']['opinions'], 0)
            self.assertGreater(treated['analysts']['forecast-analyst']['opinions'], 0)


class EvaluationTests(unittest.TestCase):
    def test_evaluation_scores_forecasters_against_baselines_and_caches(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            paths = []
            for k, drift in enumerate(((3, -2, 4), (-2, 3, -1))):
                path = tmp / f'w{k}.json'
                path.write_text(json.dumps(synthetic(drift=drift, start_day=5 + 7 * k)), encoding='utf-8')
                paths.append(path)
            forecaster = FakeForecaster()
            report = forecast_eval.evaluate(paths, [forecaster], cache=tmp / 'cache')
            arms = report['arms']
            self.assertEqual(set(arms), {'always-neutral', 'momentum-rule', forecaster.name})
            self.assertEqual(arms['always-neutral']['judged'], arms['momentum-rule']['judged'])
            self.assertEqual(arms['always-neutral']['paperRuleTrades'], 0)
            self.assertEqual(arms[forecaster.name]['judged'] + arms[forecaster.name]['abstained'], arms['momentum-rule']['judged'])
            self.assertTrue(-1 <= arms[forecaster.name]['pearson'] <= 1)
            self.assertIsInstance(arms[forecaster.name]['paperRuleNetPaise'], int)
            self.assertEqual(report['buyAndHoldPaise'], sum(w['buyAndHold'] for w in report['windows']))
            calls = len(forecaster.calls)
            forecast_eval.evaluate(paths, [forecaster], cache=tmp / 'cache')
            self.assertEqual(len(forecaster.calls), calls)  # served from the cache
            self.assertEqual(len(report['windows']), 2)

    def test_spearman_ranks_handle_ties(self):
        self.assertEqual(forecast_eval.ranks([5, 1, 5, 3]), [2.5, 0.0, 2.5, 1.0])
        self.assertEqual(forecast_eval.pearson([1, 2, 3], [2, 4, 6]), 1.0)
        self.assertIsNone(forecast_eval.pearson([1, 1, 1], [1, 2, 3]))


@unittest.skipUnless(HAS_NUMPY, 'needs numpy')
class FinetuneDataTests(unittest.TestCase):
    def test_training_windows_never_span_gaps_and_validation_targets_follow_the_cutoff(self):
        import kronos_finetune as kf
        week = lambda day, drift: synthetic(days=5, drift=drift, start_day=day)['bars']  # noqa: E731
        bars = week(5, (3, -2, 4)) + week(12, (1, -1, 2)) + week(26, (2, 2, -3))  # 19 Jan week missing
        runs = []
        current = []
        for bar in bars:
            if current and datetime.fromisoformat(bar['time']) - datetime.fromisoformat(current[-1]['time']) > kf.MAX_GAP:
                runs.append(current)
                current = []
            current.append(bar)
        runs.append(current)
        self.assertEqual([len(r) for r in runs], [750, 375])
        data = kf.samples([r for r in runs if len(r) >= kf.WINDOW], 25)
        self.assertTrue(data)
        x, stamp = data[0]
        self.assertEqual(x.shape, (kf.WINDOW, 6))
        self.assertEqual(stamp.shape, (kf.WINDOW, 5))
        self.assertLessEqual(float(abs(x).max()), kf.CLIP)
        self.assertAlmostEqual(float(x[:kf.LOOKBACK, 3].mean()), 0.0, places=3)  # normalised on lookback only
        validation = kf.validation_samples([runs[0]], '2026-01-12')
        self.assertTrue(validation)
        self.assertEqual(len(validation), len([s for s in range(0, len(runs[0]) - kf.WINDOW + 1, kf.HORIZON)
                                               if runs[0][s + kf.LOOKBACK]['time'] >= '2026-01-12']))


if __name__ == '__main__':
    unittest.main()
