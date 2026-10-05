import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adapter
import runner
import worker


def settings():
    return adapter.Settings(Path("/reviewed/hermes"), Path(sys.executable), "test-model", "https://model.example/v1", "model-key")


def bars():
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    return [{"timestamp": (start + timedelta(days=index)).isoformat(), "closePaise": str(10000 + index * 23)} for index in range(40)]


def trials():
    return [{"lookback": value, "netReturnBps": 10.0, "maxDrawdownBps": 2.0, "turnover": 3} for value in range(2, 21)]


class AdapterTests(unittest.TestCase):
    def test_disabled_and_missing_configuration_fail_before_provider(self):
        for env in ({}, {"HERMES_ENABLED": "true"}):
            with self.assertRaises(adapter.HermesError):
                adapter.Settings.from_env(env)

    def test_untrusted_endpoint_or_embedded_secret_is_refused(self):
        env = dict(HERMES_ENABLED="true", HERMES_SOURCE_PATH="source", HERMES_PYTHON=sys.executable,
                   HERMES_MODEL="model", HERMES_MODEL_API_KEY="model-key")
        for url in ("http://public.example/v1", "https://secret@model.example/v1", "https://model.example/v1?key=secret", "file:///tmp/model"):
            with self.assertRaises(adapter.HermesError):
                adapter.Settings.from_env({**env, "HERMES_MODEL_BASE_URL": url})

    def test_child_does_not_inherit_organisation_or_ambient_credentials(self):
        inherited = {"API_TOKEN": "research-token", "OWNER_PRIVATE_KEY": "owner-secret", "PRINCIPALS_JSON": "all-roles",
                     "DATABASE_URL": "db-secret", "OPENAI_API_KEY": "other-key", "HERMES_HOME": "/personal",
                     "HTTP_PROXY": "http://proxy", "PYTHONPATH": "/untrusted", "SystemRoot": "C:/Windows"}
        env = adapter.child_environment(settings(), Path("/isolated"), inherited)
        for key in inherited.keys() - {"HERMES_HOME", "SystemRoot"}:
            self.assertNotIn(key, env)
        self.assertEqual(env["HERMES_HOME"], str(Path("/isolated")))
        self.assertEqual(env["HERMES_MODEL_API_KEY"], "model-key")

    def test_code_commands_extra_fields_boolean_and_non_json_are_rejected(self):
        for response in ('{"kind":"momentum","lookback":true}', '{"kind":"momentum","lookback":21}',
                         '{"kind":"momentum","lookback":5,"shell":"buy"}', '{"kind":"arbitrary","lookback":5}',
                         '```json\n{"kind":"momentum","lookback":5}\n```',
                         '{"kind":"momentum","lookback":5,"lookback":10}', '{"kind":"momentum","lookback":NaN}'):
            with self.assertRaises(adapter.HermesError):
                adapter.validate_candidate(adapter.strict_json(response))

    def test_subprocess_has_deadline_no_shell_and_only_bounded_candidate(self):
        seen = {}

        def run(command, **kwargs):
            seen.update(kwargs)
            self.assertEqual(command[1], "-I")
            self.assertNotIn("API_TOKEN", kwargs["env"])
            self.assertEqual(set(json.loads(kwargs["input"])), {"source", "model", "baseUrl", "trials"})
            kwargs["stdout"].write(b'{"kind":"momentum","lookback":7}')
            return subprocess.CompletedProcess(command, 0)

        with patch.object(adapter, "verify_checkout"), patch.object(adapter.subprocess, "run", side_effect=run):
            self.assertEqual(adapter.propose(settings(), trials()), {"kind": "momentum", "lookback": 7})
        self.assertFalse(seen["shell"])
        self.assertEqual(seen["timeout"], 70)

    def test_provider_timeout_and_oversized_output_fail_closed(self):
        def too_large(command, **kwargs):
            kwargs["stdout"].write(b"x" * 4097)
            return subprocess.CompletedProcess(command, 0)

        for effect in (subprocess.TimeoutExpired("python", 70), too_large):
            with patch.object(adapter, "verify_checkout"), patch.object(adapter.subprocess, "run", side_effect=effect):
                with self.assertRaises(adapter.HermesError):
                    adapter.propose(settings(), trials())

    def test_wrong_revision_and_dirty_source_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / "run_agent.py").write_text("# fixture", encoding="utf-8")
            config = adapter.Settings(source, Path(sys.executable), "model", "https://model.example/v1", "key")
            for revision, dirty in (("0" * 40, ""), (adapter.PINNED_REVISION, " M run_agent.py")):
                with patch.object(adapter.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0, revision), subprocess.CompletedProcess([], 0, dirty)]):
                    with self.assertRaises(adapter.HermesError):
                        adapter.verify_checkout(config)
            (source / ".env").write_text("SECRET=fixture", encoding="utf-8")
            with patch.object(adapter.subprocess, "run") as run:
                with self.assertRaises(adapter.HermesError):
                    adapter.verify_checkout(config)
                run.assert_not_called()

    def test_git_verification_uses_local_commands_without_ambient_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / "run_agent.py").write_text("# fixture", encoding="utf-8")
            config = adapter.Settings(source, Path(sys.executable), "model", "https://model.example/v1", "secret-model-key")
            commands = []

            def run(command, **kwargs):
                commands.append(command)
                self.assertNotIn("GITHUB_TOKEN", kwargs["env"])
                self.assertNotIn("API_TOKEN", kwargs["env"])
                self.assertNotIn("HERMES_MODEL_API_KEY", kwargs["env"])
                self.assertEqual(kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")
                self.assertEqual(kwargs["env"]["GIT_CONFIG_GLOBAL"], os.devnull)
                self.assertIn("core.fsmonitor=false", command)
                return subprocess.CompletedProcess(command, 0, adapter.PINNED_REVISION if "rev-parse" in command else "")

            with patch.dict(os.environ, {"GITHUB_TOKEN": "git-secret", "API_TOKEN": "owner-secret"}), patch.object(adapter.subprocess, "run", side_effect=run):
                adapter.verify_checkout(config)
            self.assertEqual(len(commands), 2)
            self.assertNotIn("secret-model-key", repr(config))


class RunnerTests(unittest.TestCase):
    def test_unexpected_injected_tool_prevents_conversation(self):
        class Agent:
            def __init__(self, **kwargs):
                self.tools = [{"function": {"name": "terminal"}}]
                self.valid_tool_names = {"terminal"}

            def run_conversation(self, prompt):
                raise AssertionError("Must not call provider when a tool is enabled")

        with patch.dict(os.environ, {"HERMES_MODEL_API_KEY": "test"}):
            with self.assertRaises(RuntimeError):
                runner.query_agent(Agent, {"model": "test", "baseUrl": "https://model.example/v1", "trials": trials()})

    def test_tool_execution_is_denied_even_if_provider_attempts_it(self):
        class Agent:
            def __init__(self, **kwargs):
                self.tools, self.valid_tool_names = [], set()

            def run_conversation(self, prompt):
                self._execute_tool_calls_concurrent([{"name": "terminal"}])

        with patch.dict(os.environ, {"HERMES_MODEL_API_KEY": "test"}):
            with self.assertRaisesRegex(RuntimeError, "forbidden"):
                runner.query_agent(Agent, {"model": "test", "baseUrl": "https://model.example/v1", "trials": trials()})


class WorkerTests(unittest.TestCase):
    def test_candidate_score_comes_from_backtest_and_holdout_is_never_forwarded(self):
        payload = {"training": bars(), "costBps": 15}
        selected_trials = []

        def select(config, values):
            selected_trials.extend(values)
            return {"kind": "momentum", "lookback": 7}

        result = worker.research(payload, settings(), select)
        expected = worker.base_worker.backtest(payload["training"], 7, 15)
        self.assertEqual(result["trainingReport"]["selectedScoreBps"], expected["netReturnBps"])
        self.assertEqual(len(selected_trials), 19)
        self.assertNotIn("training", selected_trials[0])
        with self.assertRaises(adapter.HermesError):
            worker.research({**payload, "holdout": bars()}, settings(), select)

    def test_uncertain_completion_reuses_result_and_key_without_new_model_call(self):
        calls, researches = [], []

        class Client(worker.base_worker.Client):
            def _send(self, path, body, key, timeout):
                calls.append((path, body, key))
                if path.endswith("claims"):
                    return {"job": {"id": "job", "kind": "research", "leaseToken": "lease", "payload": {}}}
                if len(calls) == 2:
                    raise TimeoutError("uncertain response")
                return {}

        def research(payload, config):
            researches.append(payload)
            return {"candidate": {"kind": "momentum", "lookback": 5}, "trainingReport": {}}

        with patch.object(worker.base_worker.time, "sleep"), contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(worker.run_once(Client("http://127.0.0.1:3000", "r" * 43), settings(), research))
        self.assertEqual(len(researches), 1)
        self.assertEqual(calls[1], calls[2])

    def test_stale_lease_403_is_not_retried_or_recomputed(self):
        calls, researches = [], []

        class Client(worker.base_worker.Client):
            def _send(self, path, body, key, timeout):
                calls.append(path)
                if path.endswith("claims"):
                    return {"job": {"id": "job", "kind": "research", "leaseToken": "lease", "payload": {}}}
                raise HTTPError("http://127.0.0.1:3000/v1/jobs/completions", 403, "stale lease", {}, None)

        def research(payload, config):
            researches.append(payload)
            return {"candidate": {"kind": "momentum", "lookback": 5}, "trainingReport": {}}

        with patch.object(worker.base_worker.time, "sleep") as sleep:
            with self.assertRaises(HTTPError) as caught:
                worker.run_once(Client("http://127.0.0.1:3000", "r" * 43), settings(), research)
            self.assertEqual(caught.exception.code, 403)
            sleep.assert_not_called()
        self.assertEqual(calls, ["/v1/jobs/claims", "/v1/jobs/completions"])
        self.assertEqual(len(researches), 1)

    def test_evaluation_job_rejected_without_reading_payload(self):
        class Client:
            def post(self, *args):
                return {"job": {"kind": "evaluation"}}

        with self.assertRaises(adapter.HermesError):
            worker.run_once(Client(), settings())


if __name__ == "__main__":
    unittest.main()
