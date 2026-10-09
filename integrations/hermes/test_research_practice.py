import hashlib
import unittest
from contracts import (PROMPTS, RESEARCH_PRACTICE, RESEARCH_PRACTICE_VERSION,
                       prompt_version, output_schema, MAX_TOKENS, TASK_TIMEOUT_CAP)


class ResearchPracticeTests(unittest.TestCase):
    def test_guidance_is_in_actual_versioned_research_prompts(self):
        for task in ('knowledge', 'capability'):
            self.assertTrue(PROMPTS[task].endswith(RESEARCH_PRACTICE))
            self.assertIn(RESEARCH_PRACTICE_VERSION, PROMPTS[task])
            old = PROMPTS[task][:-len(RESEARCH_PRACTICE)]
            self.assertNotEqual(prompt_version(task), hashlib.sha256(old.encode()).hexdigest()[:16])
            self.assertEqual(prompt_version(task), hashlib.sha256(PROMPTS[task].encode()).hexdigest()[:16])

    def test_examinations_and_execution_selector_do_not_receive_guidance(self):
        for task in ('candidate', 'source-lesson', 'knowledge-assessment', 'knowledge-assessment-methods'):
            self.assertNotIn(RESEARCH_PRACTICE_VERSION, PROMPTS[task])

    def test_schema_and_compute_limits_are_unchanged(self):
        schema = output_schema('knowledge', {'lessons': [{'id': 'lesson'}]})
        self.assertEqual(set(schema['properties']), {'summary', 'application', 'lessonIds', 'checks', 'risks'})
        self.assertFalse(schema['additionalProperties'])
        self.assertEqual(schema['properties']['lessonIds']['items']['enum'], ['lesson'])
        self.assertEqual(MAX_TOKENS['knowledge'], 1024)
        self.assertEqual(TASK_TIMEOUT_CAP['knowledge'], 540)
        self.assertIn('not separate agents', RESEARCH_PRACTICE)


if __name__ == '__main__':
    unittest.main()
