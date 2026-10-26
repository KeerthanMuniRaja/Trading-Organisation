import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'model-eval'))
import outcome_labels as ol


class OutcomeLabelTests(unittest.TestCase):
    def test_an_argument_is_right_when_what_it_argued_came_true(self):
        log = [{'signalId': 'a', 'side': 'bear', 'stance': 'oppose', 'userHash': 'h1'},
               {'signalId': 'a', 'side': 'bull', 'stance': 'support-with-caveat', 'userHash': 'h2'},
               {'signalId': 'b', 'side': 'bear', 'stance': 'oppose', 'userHash': 'h3'},
               {'signalId': 'c', 'side': 'bear', 'stance': 'oppose', 'userHash': 'h4'}]
        signals = [{'id': 'a', 'outcome': {'correct': False, 'moveBps': -150}}, {'id': 'b', 'outcome': {'correct': True, 'moveBps': 200}},
                   {'id': 'c', 'outcome': None}]
        labels = ol.labels(log, signals)
        self.assertEqual({k: v['right'] for k, v in labels.items()}, {'h1': True, 'h2': False, 'h3': False})  # c is not scored yet
        self.assertEqual(labels['h1']['moveBps'], -150)

    def test_the_training_data_marks_the_models_own_answers_by_the_real_outcome(self):
        import build_dataset as bd
        import hashlib
        from debate import SYSTEM, ROLES
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'journal').mkdir()
            user = json.dumps({'proposal': {'symbol': 'SBIN'}, 'verifiedEvidenceIds': []})
            system = SYSTEM.format(side='bear', task=ROLES['bear'][1])
            answer = {'argument': 'The bank is exposed to a rate surprise next week.', 'evidenceId': None, 'evidenceQuote': None}
            (root / 'journal' / 'calls.jsonl').write_text(json.dumps({'system': system, 'user': user, 'answer': answer}) + '\n', encoding='utf-8')
            labels = root / 'labels.json'
            labels.write_text(json.dumps({'labels': {hashlib.sha256(user.encode()).hexdigest()[:16]: {'right': True, 'signalId': 'a'}}}), encoding='utf-8')
            m = bd.build(journal=root / 'journal', evals=root / 'none', out=root / 'out', labels_path=labels)
            self.assertIn('debate/outcome-kto.jsonl', m['files'])
            row = json.loads((root / 'out' / 'debate' / 'outcome-kto.jsonl').read_text(encoding='utf-8'))
            self.assertEqual((row['label'], row['signalId']), (True, 'a'))


if __name__ == '__main__':
    unittest.main()
