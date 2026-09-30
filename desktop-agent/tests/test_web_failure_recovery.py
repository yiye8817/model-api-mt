"""Offline regression tests for retrieval failures and partial delivery."""

import json
from pathlib import Path
import tempfile
import unittest

from fusion_agent.client import ClientError
from fusion_agent.contracts import ToolSpec
from fusion_agent.registry import ToolRegistry
from fusion_agent.runtime import Runtime


def fetch(url, timeout=30):
    return {"type": "action", "tool": "web.fetch", "arguments": {"url": url, "timeout": timeout},
            "summary": "Read the requested source"}


def final(answer="Partial source summary"):
    return {"type": "final", "answer": answer}


def success(args):
    return {"ok": True, "url": args["url"], "content_fetched": True, "text": "source content",
            "verification": {"status": "verified", "scope": "web", "method": "test_read"}}


FAILURE = {"ok": False, "error": {"code": "page_fetch_failed", "message": "Network failure"}}


class ScriptedClient:
    model = "deepseek"

    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = 0

    def complete(self, messages):
        self.calls += 1
        reply = next(self.replies)
        if isinstance(reply, Exception):
            raise reply
        return json.dumps(reply)


class WebFailureRecoveryTests(unittest.TestCase):
    def run_case(self, replies, handler, *, max_steps=20, allowed=("web",)):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        calls, events = [], []

        def invoke(args):
            calls.append(dict(args))
            return handler(args)

        spec = ToolSpec("web.fetch", "Read a source", {
            "type": "object", "properties": {"url": {"type": "string"}, "timeout": {"type": "integer"}},
            "required": ["url"], "additionalProperties": False,
        }, "web", False, invoke)
        client = ScriptedClient(replies)
        runtime = Runtime(client, ToolRegistry([spec], allowed=allowed), Path(temporary.name) / "run",
                          max_steps=max_steps, event=lambda name, fields: events.append((name, fields)))
        result = runtime.run("Read the sources and summarize the available information")
        return result, runtime, client, calls, events

    def test_five_source_run_delivers_summary_with_both_failures(self):
        urls = ["https://openai.com/news/", "https://deepmind.google/discover/blog/",
                "https://www.anthropic.com/news", "https://ai.meta.com/blog/", "https://huggingface.co/blog"]

        def handler(args):
            if args["url"] == urls[0]:
                return {"ok": False, "error": {"code": "page_http_error", "message": "HTTP 403"}}
            return FAILURE if args["url"] == urls[3] else success(args)

        result, runtime, _, calls, _ = self.run_case(
            [*(fetch(url) for url in urls), final(), final(), final()], handler)
        self.assertEqual(result["steps"], 5)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(len(calls), 5)
        self.assertEqual(len(runtime.state["successful_actions"]), 3)
        self.assertEqual(len(runtime.state["unresolved_failures"]), 2)
        self.assertIn("Partial source summary", result["answer"])
        for url in (urls[0], urls[3]):
            self.assertIn(url, result["answer"])

    def test_unrelated_success_does_not_hide_failure_or_partial_answer(self):
        result, runtime, client, calls, events = self.run_case(
            [fetch("https://blocked.example/"), fetch("https://available.example/"), final(), final(), final()],
            lambda args: FAILURE if "blocked" in args["url"] else success(args))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error_code"], "tool_failed")
        self.assertEqual(len(calls), 2)  # No implicit network/tool replay.
        self.assertEqual(client.calls, 5)
        self.assertEqual(sum(name == "run.recovery_requested" for name, _ in events), 2)
        self.assertEqual(len(runtime.state["unresolved_failures"]), 1)
        self.assertIn("Partial source summary", result["answer"])
        self.assertIn("https://blocked.example/", result["answer"])
        self.assertTrue((runtime.run_dir / "partial.md").is_file())
        self.assertFalse((runtime.run_dir / "final.md").exists())

    def test_verified_retry_can_change_timeout(self):
        result, runtime, _, calls, _ = self.run_case(
            [fetch("https://source.example/"), final(), fetch("https://source.example/", 60), final("Complete")],
            lambda args: FAILURE if args["timeout"] == 30 else success(args))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["answer"], "Complete")
        self.assertEqual(runtime.state["unresolved_failures"], [])
        self.assertEqual([args["timeout"] for args in calls], [30, 60])

    def test_different_url_does_not_resolve_failure(self):
        result, runtime, _, _, _ = self.run_case(
            [fetch("https://source.example/a"), final(), fetch("https://source.example/b"), final(), final()],
            lambda args: FAILURE if args["url"].endswith("/a") else success(args))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(len(runtime.state["unresolved_failures"]), 1)

    def test_model_error_during_recovery_retains_partial_answer(self):
        result, _, _, _, _ = self.run_case(
            [fetch("https://source.example/"), final(), ClientError("api_timeout", "Timed out")],
            lambda _: FAILURE)
        self.assertEqual(result["error_code"], "api_timeout")
        self.assertIn("Partial source summary", result["answer"])

    def test_step_limit_does_not_request_more_recovery(self):
        result, _, client, calls, events = self.run_case(
            [fetch("https://source.example/"), final()], lambda _: FAILURE, max_steps=1)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(client.calls, 2)
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(name == "run.recovery_requested" for name, _ in events))

    def test_denied_capability_does_not_trigger_recovery(self):
        result, runtime, client, calls, events = self.run_case(
            [fetch("https://source.example/"), final()], success, allowed=())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(client.calls, 2)
        self.assertEqual(calls, [])
        self.assertEqual(runtime.state["unresolved_failures"][0]["error"]["code"], "capability_denied")
        self.assertFalse(any(name == "run.recovery_requested" for name, _ in events))

    def test_successful_run_is_unchanged(self):
        result, runtime, client, _, _ = self.run_case([fetch("https://source.example/"), final("Complete")], success)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["answer"], "Complete")
        self.assertEqual(client.calls, 2)
        self.assertFalse((runtime.run_dir / "partial.md").exists())


if __name__ == "__main__":
    unittest.main()
