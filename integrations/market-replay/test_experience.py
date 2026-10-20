import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from experience import digest, packet, review_run
from replay import run_replay
from test_replay import dataset
from export_evidence import prepare


def artifacts():
    data = dataset()
    report = {**run_replay(data), 'datasetSha256': digest(data),
              'simulatorSha256': hashlib.sha256(Path(__file__).with_name('replay.py').read_bytes()).hexdigest()}
    return data, report


class ExperienceTests(unittest.TestCase):
    def test_export_is_stable_recomputed_and_separates_provider_from_analysis(self):
        d, r = artifacts()
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder/'dataset.json').write_text(json.dumps(d))
            (folder/'report.json').write_text(json.dumps(r))
            review_run(folder)
            first = prepare(folder, 'internal-research')
            self.assertEqual(prepare(folder, 'internal-research'), first)
            self.assertLessEqual(len(first['evidence']['content']), 4000)
            content = json.loads(first['evidence']['content'])
            self.assertEqual(content['provenance'], 'local-computation-not-provider-published-analysis')
            self.assertEqual(content['reviewStatus'], 'unverified')
            with self.assertRaises(ValueError):
                prepare(folder, '../escape')
            r['realisedNetPaise'] += 1
            (folder/'report.json').write_text(json.dumps(r))
            with self.assertRaises(ValueError):
                prepare(folder, 'internal-research')

    def test_facts_graph_and_authority(self):
        data, report = artifacts()
        p = packet(data, report)
        self.assertEqual(p['status'], 'pending-independent-review')
        self.assertFalse(any(p['authority'].values()))
        self.assertEqual(p['source'], 'synthetic-test')
        ids = {n['id'] for n in p['graph']['nodes']}
        for e in p['graph']['edges']:
            self.assertIn(e['from'], ids)
            self.assertIn(e['to'], ids)
        self.assertEqual(next(f['value'] for f in p['facts'] if f['key'] == 'realised-net-paise'), report['realisedNetPaise'])

    def test_tampered_report_dataset_and_engine_are_rejected(self):
        for key, value in [('realisedNetPaise', 12345), ('datasetSha256', '0'*64),
                           ('simulatorSha256', '0'*64), ('extra', 'invented approval')]:
            d, r = artifacts()
            r[key] = value
            with self.assertRaises(ValueError):
                packet(d, r)
        d, r = artifacts()
        d['bars'][0]['volume'] += 1
        with self.assertRaises(ValueError):
            packet(d, r)

    def test_idempotent_review_preserves_conflicting_packet(self):
        d, r = artifacts()
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder/'dataset.json').write_text(json.dumps(d))
            (folder/'report.json').write_text(json.dumps(r))
            target = review_run(folder)
            initial = target.read_bytes()
            self.assertEqual(review_run(folder).read_bytes(), initial)
            target.write_text('{"status":"approved"}')
            with self.assertRaisesRegex(ValueError, 'CONFLICT'):
                review_run(folder)
            self.assertEqual(target.read_text(), '{"status":"approved"}')
