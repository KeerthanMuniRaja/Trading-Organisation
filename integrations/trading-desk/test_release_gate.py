import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_gate as rg

ENV = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([{'role': 'researcher', 'token': 'r' * 43},
                                                                         {'role': 'evaluator', 'token': 'e' * 43}])}


class Response:
    def __init__(self, body): self.body = body
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self, n): return json.dumps(self.body).encode()


class GateTests(unittest.TestCase):
    def test_fingerprint_ignores_line_endings_and_changes_with_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'a.py').write_bytes(b'x = 1\r\ny = 2\r\n')
            unix = rg.code_fingerprint(('a.py',), root)
            (root / 'a.py').write_bytes(b'x = 1\ny = 2\n')
            self.assertEqual(rg.code_fingerprint(('a.py',), root), unix)
            (root / 'a.py').write_bytes(b'x = 1\ny = 3\n')
            self.assertNotEqual(rg.code_fingerprint(('a.py',), root), unix)
            self.assertRegex(unix, r'^[a-f0-9]{32}$')

    def test_only_an_authorised_version_may_run(self):
        sent = []

        def opener(answer):
            def call(req, timeout):
                sent.append((req.full_url, json.loads(req.data), req.headers['Authorization']))
                return Response(answer)
            return call
        ok = rg.check('allocator', 'Qwen3.5-4B-Q4_K_M', 'p1', ENV, opener({'allowed': True, 'stage': 'active', 'version': 1}))
        self.assertEqual(ok['stage'], 'active')
        url, body, auth = sent[0]
        self.assertTrue(url.endswith('/v1/releases/check'))
        self.assertEqual(body['codeFingerprint'], rg.code_fingerprint())
        self.assertEqual(auth, 'Bearer ' + 'r' * 43)
        with self.assertRaisesRegex(PermissionError, 'version-not-authorised'):
            rg.check('allocator', 'other-model', 'p1', ENV, opener({'allowed': False, 'reason': 'version-not-authorised'}))

        def down(req, timeout):
            raise OSError('connection refused')
        with self.assertRaisesRegex(PermissionError, 'not running an unverified version'):
            rg.check('allocator', 'm', 'p1', ENV, down)  # an unreachable registry never means "allowed"


if __name__ == '__main__':
    unittest.main()
