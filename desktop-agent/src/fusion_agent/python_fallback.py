"""Controlled Python fallbacks for a small set of workspace file tools.

This module deliberately does *not* evaluate Python supplied by a model and it
does not translate unknown requests into shell commands.  It only maps an
explicit allowlist of file-tool spellings to the already hardened
``LocalTools`` implementations.  The resulting :class:`ToolSpec` therefore
keeps normal schema validation, capability authorization, workspace
containment, overwrite protection, and readback verification when invoked by
``ToolRegistry``.

``PythonFileFallbacks.resolve`` is intended to be called only after normal
tool lookup fails.  An exact, registered tool always wins.  If the canonical
file tool is registered, a compatible alias resolves to that registered spec;
otherwise the bundled Python implementation is returned as a fallback.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Iterable, Mapping

from .contracts import ToolSpec
from .local_tools import LocalTools


# Keep this mapping intentionally small and exact.  In particular, generic
# names such as ``run``, ``python``, and ``execute`` are never inferred.
_ALIASES = MappingProxyType({
    "files.read": "files.read",
    "file.read": "files.read",
    "filesystem.read": "files.read",
    "filesystem.read_file": "files.read",
    "read_file": "files.read",
    "read_text_file": "files.read",
    "files.list": "files.list",
    "file.list": "files.list",
    "filesystem.list": "files.list",
    "filesystem.list_files": "files.list",
    "list_files": "files.list",
    "list_directory": "files.list",
    "files.write": "files.write",
    "file.write": "files.write",
    "filesystem.write": "files.write",
    "filesystem.write_file": "files.write",
    "filesystem.write_text": "files.write",
    "write_file": "files.write",
    "write_text_file": "files.write",
    "files.stat": "files.stat", "file.stat": "files.stat", "stat_file": "files.stat",
    "files.search": "files.search", "file.search": "files.search", "search_files": "files.search",
    "grep_files": "files.search",
    "files.mkdir": "files.mkdir", "file.mkdir": "files.mkdir", "make_directory": "files.mkdir",
    "files.copy": "files.copy", "file.copy": "files.copy", "copy_file": "files.copy",
    "files.move": "files.move", "file.move": "files.move", "move_file": "files.move",
    "rename_file": "files.move",
    "files.delete": "files.delete", "file.delete": "files.delete", "delete_file": "files.delete",
    "remove_file": "files.delete",
})

_CANONICAL_NAMES = ("files.list", "files.read", "files.stat", "files.search", "files.write",
                    "files.mkdir", "files.copy", "files.move", "files.delete")
_MUTATING_NAMES = frozenset({"files.write", "files.mkdir", "files.copy", "files.move", "files.delete"})


@dataclass(frozen=True)
class PythonFallbackResolution:
    """A proven mapping to a safe file implementation.

    ``uses_existing`` is true when the canonical tool was already registered;
    callers should record this as alias resolution, not as a Python fallback.
    ``as_tool_spec`` is a convenience for registries that need a spec named
    after the request while retaining the canonical handler and contract.
    """

    requested_name: str
    canonical_name: str
    spec: ToolSpec
    uses_existing: bool

    @property
    def implementation(self) -> str:
        return "registered_tool" if self.uses_existing else "python_local_tools"

    def as_tool_spec(self) -> ToolSpec:
        return ToolSpec(
            name=self.requested_name,
            description=self.spec.description,
            parameters=self.spec.parameters,
            capability=self.spec.capability,
            mutating=self.spec.mutating,
            handler=self.spec.handler,
        )

    def public(self) -> dict:
        """Return serializable resolution metadata without exposing a handler."""

        return {
            "requested_tool": self.requested_name,
            "canonical_tool": self.canonical_name,
            "implementation": self.implementation,
            "capability": self.spec.capability,
            "mutating": self.spec.mutating,
            "arguments_changed": False,
        }


class PythonFileFallbacks:
    """Resolve explicitly supported missing file tools to safe Python code."""

    def __init__(self, local_tools: LocalTools):
        if not isinstance(local_tools, LocalTools):
            raise TypeError("local_tools must be a LocalTools instance")
        specs = {spec.name: spec for spec in local_tools.specs()}
        if any(name not in specs for name in _CANONICAL_NAMES):
            raise ValueError("LocalTools does not provide the required file tools")
        for name in _CANONICAL_NAMES:
            spec = specs[name]
            if spec.capability != "files":
                raise ValueError(f"Unsafe capability for {name}")
            if spec.mutating is not (name in _MUTATING_NAMES):
                raise ValueError(f"Unsafe mutation declaration for {name}")
        self._specs = {name: specs[name] for name in _CANONICAL_NAMES}

    @staticmethod
    def canonical_name(requested_name: str) -> str | None:
        """Return a canonical name only for an exact allowlisted spelling."""

        if not isinstance(requested_name, str):
            return None
        return _ALIASES.get(requested_name)

    @staticmethod
    def _known_specs(known_tools: Mapping[str, ToolSpec] | Iterable[ToolSpec | str]) -> dict[str, ToolSpec | None]:
        if isinstance(known_tools, Mapping):
            return {name: spec if isinstance(spec, ToolSpec) else None
                    for name, spec in known_tools.items() if isinstance(name, str)}
        result: dict[str, ToolSpec | None] = {}
        for item in known_tools:
            if isinstance(item, ToolSpec):
                result[item.name] = item
            elif isinstance(item, str):
                result[item] = None
        return result

    def resolve(
        self,
        requested_name: str,
        known_tools: Mapping[str, ToolSpec] | Iterable[ToolSpec | str] = (),
    ) -> PythonFallbackResolution | None:
        """Resolve a missing exact name without guessing or executing anything.

        The caller should perform its regular exact lookup first.  This method
        still checks ``known_tools`` defensively: if the requested name already
        exists it returns ``None`` so that tool cannot be shadowed.
        """

        canonical = self.canonical_name(requested_name)
        if canonical is None:
            return None
        known = self._known_specs(known_tools)
        if requested_name in known:
            return None
        existing = known.get(canonical)
        if isinstance(existing, ToolSpec):
            return PythonFallbackResolution(requested_name, canonical, existing, True)
        # If only a set of names was supplied, there is no safe handler to bind.
        # Do not shadow a known canonical implementation with our own.
        if canonical in known:
            return None
        return PythonFallbackResolution(requested_name, canonical, self._specs[canonical], False)

    def missing_specs(
        self,
        known_tools: Mapping[str, ToolSpec] | Iterable[ToolSpec | str] = (),
    ) -> list[ToolSpec]:
        """Return only canonical fallback specs absent from ``known_tools``."""

        known = self._known_specs(known_tools)
        return [self._specs[name] for name in _CANONICAL_NAMES if name not in known]
