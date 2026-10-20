"""Private one-shot child. No organisation API credential enters this process."""
from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import json
import os
from pathlib import Path
import sys


def load_contracts():
    # Load by exact path without touching sys.path, so upstream imports cannot resolve to our modules.
    spec = importlib.util.spec_from_file_location('organisation_model_contracts', Path(__file__).resolve().with_name('contracts.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def query_agent(agent_class, request: dict) -> dict:
    contracts = load_contracts()
    task = contracts.task_name(request)
    requested = request.get('timeoutSeconds')
    timeout = contracts.timeout_for(task, requested if type(requested) is int and 70 <= requested <= 540 else contracts.DEFAULT_TIMEOUT_SECONDS)
    capability, knowledge = task == 'capability', task == 'knowledge'
    assessment, source_lesson = task in ('knowledge-assessment', 'knowledge-assessment-methods'), task == 'source-lesson'
    agent = agent_class(
        model=request["model"], base_url=request["baseUrl"],
        api_key=os.environ["HERMES_MODEL_API_KEY"], provider="custom", api_mode="chat_completions",
        enabled_toolsets=[], max_iterations=2, max_tokens=contracts.MAX_TOKENS[task], run_budget_seconds=contracts.agent_budgets(timeout)['run'],
        skip_context_files=True, skip_memory=True, skip_background_review=True,
        load_soul_identity=False, save_trajectories=False, quiet_mode=True,
        checkpoints_enabled=False, cwd=str(Path.cwd()),
        ephemeral_system_prompt=contracts.PROMPTS[task],
    )
    try:
        # Defense in depth: do not silently accept tools injected by a changed
        # upstream configuration, plugin, memory backend, or context engine.
        if agent.tools or agent.valid_tool_names:
            raise RuntimeError("Unexpected Hermes tool surface")
        # Private hook verified at the pinned revision. Disable between-turn MCP
        # refresh; this adapter is intentionally tied to a reviewed source pin.
        agent._skip_mcp_refresh = True

        def deny_execution(*args, **kwargs):
            raise RuntimeError("Tool execution is forbidden in this research adapter")

        agent._execute_tool_calls_concurrent = deny_execution
        agent._execute_tool_calls_sequential = deny_execution
        payload = contracts.user_payload(task, request)
        result = agent.run_conversation(json.dumps(payload, allow_nan=False))
        if result.get("completed") is not True or result.get("partial") or result.get("interrupted") or result.get("error"):
            raise RuntimeError("Hermes did not complete a valid research turn")
        # Import our own validator by exact adapter directory, not ambient cwd.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from adapter import strict_json, validate_candidate, validate_capability
        response = result.get("final_response")
        if not isinstance(response, str) or len(response.encode("utf-8")) > 4096:
            raise RuntimeError("Invalid Hermes final response")
        decoded = strict_json(response)
        if source_lesson:
            from source_learning import validate_lesson
            return validate_lesson(decoded, request['context'])
        if assessment:
            from knowledge_assessment import validate_answers
            return validate_answers(decoded,request['context'])
        if knowledge:
            from knowledge import validate_plan
            return validate_plan(decoded, request['context'])
        return validate_capability(decoded, request['context']) if capability else validate_candidate(decoded)
    finally:
        close = getattr(agent, "close", None)
        if callable(close):
            close()


def main() -> int:
    try:
        request_bytes = sys.stdin.buffer.read(65537)
        if len(request_bytes) > 65536:
            return 2
        request = json.loads(request_bytes)
        source = Path(request["source"]).resolve()
        sys.path.insert(0, str(source))
        # No upstream logs or exception text are forwarded: either may contain
        # endpoint diagnostics. The outer process logs a bounded generic error.
        with open(os.devnull, "w", encoding="utf-8") as sink, redirect_stdout(sink), redirect_stderr(sink):
            from run_agent import AIAgent
            candidate = query_agent(AIAgent, request)
        print(json.dumps(candidate, allow_nan=False))
        return 0
    except Exception:
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
