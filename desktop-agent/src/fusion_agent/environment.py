"""Inspect and repair the current interpreter's optional browser dependency.

Repair commands are fixed, require the shell capability, and run only inside a
virtual environment. Availability checks do not launch a browser and never prove
that the user's browser task has completed.
"""

from __future__ import annotations

import importlib
import importlib.util
from pathlib import Path
import sys
import time

from .contracts import ToolError, ToolSpec


class EnvironmentTools:
    def __init__(self, runtime_dir, runner, event=None, *, active_driver=None):
        self.runtime_dir = Path(runtime_dir).expanduser()
        self.runner = runner
        self.event = event or (lambda *_: None)
        self.active_driver = active_driver or (lambda: None)

    def specs(self):
        parameters = {"type": "object", "properties": {}, "additionalProperties": False}
        return [
            ToolSpec("environment.browser_check",
                     "Check Playwright import and its Chromium executable in the running Python interpreter. "
                     "Read-only; this does not launch a browser or verify completion of a browser task. "
                     "When dependencies are missing, use the exact repair_tool reported in the result.",
                     parameters, "browser", False, self.browser_check),
            ToolSpec("environment.browser_setup",
                     "Install only Playwright and its Chromium binary into the agent's current virtual "
                     "environment using fixed commands and the current Python interpreter. Requires shell "
                     "capability; never uses sudo, a system Python, or user-provided package/command arguments. "
                     "Each installation command runs at most once, with a 600-second total command budget. "
                     "Successful dependency inspection is not successful browser launch or task completion.",
                     parameters, "shell", True, self.browser_setup),
        ]

    @staticmethod
    def _validate(arguments):
        if not isinstance(arguments, dict) or arguments:
            raise ToolError("invalid_arguments", "This environment tool accepts only an empty object", not_executed=True)

    def _inspect(self):
        # Do not resolve sys.executable: a venv's Python commonly is a symlink to
        # the system interpreter; invoking its resolved target loses the venv.
        result = {
            "python_executable": sys.executable,
            "python_prefix": sys.prefix,
            "python_base_prefix": sys.base_prefix,
            "in_virtualenv": sys.prefix != sys.base_prefix,
            "runtime_dir": str(self.runtime_dir),
            "package_ready": False,
            "browser_binary_ready": None,
            "browser_executable": None,
            "dependency_ready": False,
            "browser_launch_verified": False,
            "repair_tool": "environment.browser_setup",
        }
        importlib.invalidate_caches()
        try:
            api = importlib.import_module("playwright.sync_api")
        except ModuleNotFoundError as exc:
            result["check_error"] = {"code": "dependency_missing", "phase": "package_import",
                                     "message": f"Playwright could not import in {sys.executable}: {exc}"}
            return result
        except Exception as exc:
            result["check_error"] = {"code": "dependency_check_failed", "phase": "package_import",
                                     "message": f"Playwright import failed in {sys.executable} ({type(exc).__name__}): {exc}"}
            return result
        result["package_ready"] = True
        driver = None
        owns_driver = False
        try:
            # BrowserTools may already own a sync driver on this thread. Starting
            # a nested sync driver then would fail because its asyncio loop is
            # active. Borrow the existing driver strictly for path inspection.
            driver = self.active_driver()
            if driver is None:
                driver = api.sync_playwright().start()
                owns_driver = True
            executable = driver.chromium.executable_path
            result["browser_executable"] = str(executable)
            result["browser_binary_ready"] = Path(executable).is_file()
            if not result["browser_binary_ready"]:
                result["check_error"] = {"code": "dependency_missing", "phase": "browser_binary",
                                         "message": f"Chromium executable is missing for {sys.executable}: {executable}"}
        except Exception as exc:
            result["check_error"] = {"code": "dependency_check_failed", "phase": "browser_binary_inspection",
                                     "message": f"Cannot inspect Chromium for {sys.executable} ({type(exc).__name__}): {exc}"}
        finally:
            if driver is not None and owns_driver:
                try:
                    driver.stop()
                except Exception as exc:
                    result["check_error"] = {"code": "dependency_check_failed", "phase": "driver_stop",
                                             "message": f"Playwright inspection cleanup failed ({type(exc).__name__}): {exc}"}
        result["dependency_ready"] = bool(result["package_ready"] and result["browser_binary_ready"]
                                          and "check_error" not in result)
        return result

    @staticmethod
    def _result(check, steps, *, error=None, outcome_unknown=False):
        ready = check["dependency_ready"] and error is None
        result = {"ok": ready, **check, "steps": steps,
                  "verification": {"status": "verified" if ready else "failed",
                                   "method": "dependency_check", "scope": "shell",
                                   "description": "Python package and Chromium file availability only; browser launch and task completion are unverified."}}
        if not ready:
            result["error"] = error or check.get("check_error") or {
                "code": "dependency_missing", "message": f"Browser dependencies are not ready in {check['python_executable']}"}
        if outcome_unknown:
            result["outcome_unknown"] = True
        return result

    def browser_check(self, arguments):
        self._validate(arguments)
        check = self._inspect()
        # Finding an absent optional dependency is a successful diagnostic, not
        # a failed user action. It must not create an unresolved shell failure or
        # satisfy a browser/task postcondition in the runtime's verification gate.
        error = check.get("check_error")
        inspected = error is None or error["code"] == "dependency_missing"
        result = {"ok": inspected, **check, "steps": []}
        if not inspected:
            result["error"] = error
        return result

    def browser_setup(self, arguments):
        self._validate(arguments)
        if sys.prefix == sys.base_prefix:
            raise ToolError("dependency_environment",
                            f"Browser setup was not executed: current Python {sys.executable} is outside a virtual environment. "
                            "Start desktop-agent with ./run.sh and explicitly grant/configure browser and shell capabilities "
                            "so the launcher creates and uses the project's managed virtual environment; then run environment.browser_check.",
                            not_executed=True,
                            details={"python_executable": sys.executable, "python_prefix": sys.prefix,
                                     "python_base_prefix": sys.base_prefix, "repair_tool": "environment.browser_setup"})
        deadline = time.monotonic() + 600
        steps = []
        check = self._inspect()

        def command(step, argv):
            remaining = int(deadline - time.monotonic())
            if remaining < 1:
                return {"code": "dependency_timeout", "step": step,
                        "message": f"Dependency setup budget exhausted before {step} in {sys.executable}; inspect dependency state before another setup."}, False
            arguments = {"argv": argv, "timeout": min(300, remaining)}
            self.event("environment.command.started", {"step": step, "python_executable": sys.executable,
                                                       "payload": {"arguments": arguments}})
            try:
                output = self.runner(arguments)
            except Exception as exc:
                # A runner exception after dispatch cannot prove no changes occurred.
                output = {"ok": False, "error": {"code": getattr(exc, "code", "dependency_command_exception"),
                                                   "message": str(exc)},
                          "outcome_unknown": not getattr(exc, "not_executed", False)}
            unknown = bool(output.get("timed_out") or output.get("outcome_unknown"))
            succeeded = (output.get("ok", True) is True and output.get("returncode") == 0
                         and not unknown and output.get("verification", {}).get("status") != "failed")
            steps.append({"step": step, "arguments": arguments, "result": output})
            self.event("environment.command.completed" if succeeded else "environment.command.failed",
                       {"step": step, "python_executable": sys.executable, "ok": succeeded,
                        "payload": {"arguments": arguments, "result": output}})
            if not succeeded:
                return {"code": "dependency_timeout" if unknown else "dependency_install_failed", "step": step,
                        "message": f"Dependency setup stopped at {step} in {sys.executable}; inspect this step's stdout/stderr. "
                                   + ("Command outcome is unknown; do not automatically repeat the installation." if unknown else "The installation command did not complete successfully.")}, unknown
            return None, False

        def run(step, argv):
            error, unknown = command(step, argv)
            if error is not None:
                return self._result(check, steps, error=error, outcome_unknown=unknown)
            return None

        if check["dependency_ready"]:
            return self._result(check, steps)
        if not check["package_ready"]:
            if check.get("check_error", {}).get("code") != "dependency_missing":
                return self._result(check, steps)
            importlib.invalidate_caches()
            if importlib.util.find_spec("pip") is None:
                failure = run("ensurepip", [sys.executable, "-m", "ensurepip", "--upgrade"])
                if failure:
                    return failure
            failure = run("install_playwright", [sys.executable, "-m", "pip", "install", "playwright>=1.50,<2"])
            if failure:
                return failure
            check = self._inspect()
            if not check["package_ready"]:
                return self._result(check, steps)
        if check["browser_binary_ready"] is False:
            failure = run("install_chromium", [sys.executable, "-m", "playwright", "install", "chromium"])
            if failure:
                return failure
            check = self._inspect()
        return self._result(check, steps)

    def close(self):
        """No persistent driver or subprocess is retained by environment checks."""
