"""Schema validation and session capability grants before any tool is called."""

import json
import math
import time

from .contracts import ToolError, ToolSpec
from .tool_resolution import alternatives, canonical_tool


def validate(value, schema, location="arguments"):
    for keyword, exact in (("oneOf", True), ("anyOf", False)):
        if keyword in schema:
            matches = 0
            for candidate in schema[keyword]:
                try:
                    validate(value, candidate, location)
                    matches += 1
                except ToolError:
                    pass
            if matches == 0 or (exact and matches != 1):
                raise ToolError("invalid_arguments", f"{location} does not match {keyword}")
    types = schema.get("type")
    if types:
        types = types if isinstance(types, list) else [types]
        checks = {"object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str),
                  "integer": isinstance(value, int) and not isinstance(value, bool),
                  "number": isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value),
                  "boolean": isinstance(value, bool), "null": value is None}
        if not any(checks.get(kind, False) for kind in types):
            raise ToolError("invalid_arguments", f"{location} has an invalid type")
    if "enum" in schema and value not in schema["enum"]:
        raise ToolError("invalid_arguments", f"{location} is not an allowed value")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        if any(key not in value for key in schema.get("required", [])):
            raise ToolError("invalid_arguments", f"{location} is missing required fields")
        if schema.get("additionalProperties") is False and set(value) - set(properties):
            raise ToolError("invalid_arguments", f"{location} contains unknown fields")
        for key, item in value.items():
            if key in properties:
                validate(item, properties[key], location + "." + key)
    elif isinstance(value, list):
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 10000):
            raise ToolError("invalid_arguments", f"{location} array length is outside its limits")
        for item in value:
            if "items" in schema:
                validate(item, schema["items"], location + "[]")
    elif isinstance(value, str):
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 100000):
            raise ToolError("invalid_arguments", f"{location} string length is outside its limits")
    elif isinstance(value, (float, int)) and not isinstance(value, bool):
        if not math.isfinite(value) or not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf):
            raise ToolError("invalid_arguments", f"{location} number is outside its limits")


def redact_known(value, secrets):
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[REDACTED]")
        return value
    if isinstance(value, dict):
        return {key: redact_known(item, secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_known(item, secrets) for item in value]
    return value


class ToolRegistry:
    def __init__(self, specs, allowed=("files", "skills"), authorize=None, event=None, secrets=(),
                 fallbacks=None):
        self.tools = {}
        for spec in specs:
            if not isinstance(spec, ToolSpec) or spec.name in self.tools:
                raise ValueError("Invalid or duplicated tool definition")
            self.tools[spec.name] = spec
        self.allowed = set(allowed)
        self.denied = set()
        self.authorize = authorize
        self.event = event or (lambda *_: None)
        self.secrets = tuple(secrets)
        self.fallbacks = fallbacks

    def catalog(self):
        return [spec.public() for spec in self.tools.values()]

    def resolve_tool(self, name):
        """Resolve a real tool or materialize one explicitly allowlisted fallback.

        Resolution itself never invokes a handler.  A dynamically supplied
        fallback becomes an ordinary registry entry so schema validation,
        capability authorization and result auditing remain on the exact same
        path as every built-in tool.
        """
        resolved = canonical_tool(name, self.tools)
        if resolved is not None:
            return resolved, None
        if self.fallbacks is None:
            return None, None
        resolution = self.fallbacks.resolve(name, self.tools)
        if resolution is None:
            return None, None
        canonical = resolution.canonical_name
        if canonical not in self.tools:
            spec = resolution.spec
            if not isinstance(spec, ToolSpec) or spec.name != canonical:
                raise ValueError("Invalid fallback tool definition")
            self.tools[canonical] = spec
        return canonical, resolution.public()

    def invoke(self, name, arguments):
        started = time.monotonic()
        invoked = False
        mutating = False
        try:
            requested_name = name
            resolved, fallback = self.resolve_tool(name)
            if resolved is None:
                raise ToolError("unknown_tool", "Tool unavailable; choose a verified equivalent from the current catalog",
                                not_executed=True,
                                details={"alternatives": alternatives(name, self.catalog(), arguments)})
            if fallback is not None:
                event_name = ("tool.alias_resolved" if fallback.get("implementation") == "registered_tool"
                              else "tool.python_fallback_resolved")
                self.event(event_name, {"tool": resolved, "original_tool": requested_name,
                           "resolved_tool": resolved,
                           "payload": {"arguments": redact_known(arguments, self.secrets),
                                       "resolution": fallback, "arguments_changed": False}})
                name = resolved
            elif resolved != name:
                self.event("tool.alias_resolved", {"tool": resolved, "original_tool": name,
                           "payload": {"arguments": redact_known(arguments, self.secrets),
                                       "reason": "explicit_compatible_alias", "arguments_changed": False}})
                name = resolved
            spec = self.tools[name]
            if not isinstance(arguments, dict):
                raise ToolError("invalid_arguments", "Tool arguments must be an object")
            validate(arguments, spec.parameters)
            if spec.capability not in self.allowed:
                granted = spec.capability not in self.denied and self.authorize and self.authorize(spec, arguments)
                if not granted:
                    self.denied.add(spec.capability)
                    raise ToolError("capability_denied", f"Capability {spec.capability} is not authorized for this task")
                self.allowed.add(spec.capability)
                self.event("capability.granted", {"capability": spec.capability})
            self.event("tool.started", {"tool": name, "capability": spec.capability, "mutating": spec.mutating, "payload": {"arguments": redact_known(arguments, self.secrets)}})
            invoked = True
            mutating = spec.mutating
            result = spec.handler(arguments)
            if not isinstance(result, dict):
                raise ToolError("invalid_tool_result", "Tool returned an invalid observation")
            # Validate serializability before returning data to the model, and never
            # include this agent's own Fusion credential in a tool observation.
            result = redact_known(result, self.secrets)
            json.dumps(result, allow_nan=False)
            output = {"ok": True, **result}
            if not isinstance(output["ok"], bool):
                raise ToolError("invalid_tool_result", "Tool ok field must be boolean")
            # A handler returning normally is not proof that an external command
            # or a postcondition succeeded. Honor its explicit outcome.
            if name == "shell.run" and (output.get("timed_out") or output.get("returncode") != 0):
                output["ok"] = False
                output.setdefault("error", {"code": "command_timeout" if output.get("timed_out") else "command_failed", "message": "Command did not exit successfully; inspect stdout/stderr and actual state"})
            verification = output.get("verification", {})
            if verification.get("status") == "failed":
                output["ok"] = False
            self.event("tool.completed" if output["ok"] else "tool.failed", {"tool": name, "ok": output["ok"],
                       "code": output.get("error", {}).get("code"), "verification_status": verification.get("status"),
                       "returncode": output.get("returncode"), "timed_out": output.get("timed_out"),
                       "elapsed_ms": round((time.monotonic() - started) * 1000), "payload": {"result": output}})
            return output
        except ToolError as exc:
            error = {"code": exc.code, "message": redact_known(str(exc), self.secrets)}
            if exc.details is not None:
                try:
                    details = redact_known(exc.details, self.secrets)
                    json.dumps(details, allow_nan=False)
                    error["details"] = details
                except (TypeError, ValueError, RecursionError):
                    # Details are optional diagnostics, never a reason to lose
                    # the primary failure or leak a raw library exception.
                    pass
            output = {"ok": False, "error": error}
            if not invoked or exc.not_executed:
                output["execution"] = {"status": "not_started"}
            elif mutating:
                output.update(outcome_unknown=True, execution={"status": "unknown"})
            self.event("tool.failed", {"tool": name, "ok": False, "code": exc.code,
                       "execution": output.get("execution"), "outcome_unknown": output.get("outcome_unknown", False),
                       "elapsed_ms": round((time.monotonic() - started) * 1000), "payload": {"result": output}})
            if exc.code == "desktop_failsafe":
                raise KeyboardInterrupt from exc
            return output
        except Exception as exc:
            # Raw library exceptions can contain file contents, headers or credentials.
            output = {"ok": False, "error": {"code": "tool_exception", "message": f"Tool failed ({type(exc).__name__}); inspect its environment and arguments before another action"}}
            if not invoked:
                output["execution"] = {"status": "not_started"}
            elif mutating:
                output.update(outcome_unknown=True, execution={"status": "unknown"})
            self.event("tool.failed", {"tool": name, "ok": False, "code": "tool_exception", "error_type": type(exc).__name__,
                       "execution": output.get("execution"), "outcome_unknown": output.get("outcome_unknown", False),
                       "elapsed_ms": round((time.monotonic() - started) * 1000), "payload": {"result": output}})
            return output
