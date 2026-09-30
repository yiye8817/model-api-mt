"""Shared tool contract. Tool outputs are JSON-compatible, untrusted observations."""

from dataclasses import dataclass
from typing import Callable


class ToolError(Exception):
    def __init__(self, code: str, message: str, *, not_executed=False, details=None):
        """A tool failure, optionally proven to precede its requested action.

        ``not_executed`` must only be set by the code that knows no requested
        action was dispatched. It never means that an interrupted action was
        rolled back. Library exceptions remain uncertain by default.
        """
        super().__init__(message)
        self.code = code
        self.not_executed = not_executed is True
        self.details = details


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict
    capability: str
    mutating: bool
    handler: Callable[[dict], dict]

    def public(self):
        return {"name": self.name, "description": self.description, "parameters": self.parameters,
                "capability": self.capability, "mutating": self.mutating}
