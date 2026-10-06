import contextlib
import io
import json
import unittest
from unittest.mock import patch

import knowledge_worker


class DiscoveryTests(unittest.TestCase):
    def test_discovery_reads_backend_without_model_settings_or_inference(self):
        expected = {'suggestedLessonIds': ['lesson-fixture'], 'modelInvoked': False}
        with patch.dict('os.environ', {'API_URL': 'http://127.0.0.1:3000', 'API_TOKEN': 'fixture-only'}), \
                patch('sys.argv', ['knowledge_worker.py', 'discover', '--bot-id', 'student', '--query', 'fees slippage']), \
                patch.object(knowledge_worker, 'Client') as client, \
                patch.object(knowledge_worker.Settings, 'from_env', side_effect=AssertionError('No model setup')), \
                patch.object(knowledge_worker, 'propose_knowledge', side_effect=AssertionError('No inference')):
            client.return_value.post.return_value = expected
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                knowledge_worker.main()
            self.assertEqual(json.loads(output.getvalue()), expected)
            client.return_value.post.assert_called_once_with('/v1/learning/knowledge/discover',
                {'botId': 'student', 'query': 'fees slippage', 'limit': 5})


if __name__ == '__main__':
    unittest.main()
