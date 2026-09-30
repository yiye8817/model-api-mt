"""Explicit in-process conversation checkpoints, never restored from history files.

The checkpoint includes conversation data and unresolved execution gates. It does
not include ToolRegistry, grants, browser handles, callbacks, or executable code.
Every read returns a deep copy so a later run cannot mutate an earlier record.
"""

from collections.abc import Mapping
from copy import deepcopy


_ISSUER = object()


class RuntimeCheckpoint(Mapping):
    """A checkpoint issued by this process, not an arbitrary JSON transcript."""

    def __init__(self, data, *, _issuer=None):
        if _issuer is not _ISSUER:
            raise ValueError("会话检查点只能由当前进程中的 Runtime 导出。")
        self.__data = deepcopy(data)

    def __getitem__(self, key):
        return deepcopy(self.__data[key])

    def __iter__(self):
        return iter(self.__data)

    def __len__(self):
        return len(self.__data)

    def __deepcopy__(self, memo):
        return self

    def copy_data(self):
        return deepcopy(self.__data)


def _make_checkpoint(data):
    return RuntimeCheckpoint(data, _issuer=_ISSUER)


def checkpoint_data(checkpoint):
    if not isinstance(checkpoint, RuntimeCheckpoint):
        raise ValueError("仅支持当前交互进程的会话检查点；历史文件不是可执行恢复记录。")
    return checkpoint.copy_data()


class SessionContext:
    """Hold the most recent runtime checkpoint for one interactive session."""

    def __init__(self):
        self._checkpoint = None

    def checkpoint(self):
        return self._checkpoint

    def capture(self, runtime):
        # Import lazily to keep Runtime's checkpoint dependency acyclic.
        from .runtime import Runtime
        if not isinstance(runtime, Runtime):
            return False
        checkpoint = runtime.export_context()
        if checkpoint is None:
            return False
        self._checkpoint = checkpoint
        return True

    def clear(self):
        self._checkpoint = None

    def summary(self):
        if self._checkpoint is None:
            return {"has_context": False}
        data = self._checkpoint.copy_data()
        state = data["state"]
        return {"has_context": True, "original_task": data["original_task"],
                "last_task": data["last_task"], "status": state.get("status"),
                "steps": state.get("steps", 0), "inherited_steps": state.get("inherited_steps", 0),
                "run_id": data["run_id"]}
