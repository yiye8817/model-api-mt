"""Private stdlib search worker, invoked only with fixed argv by files.search.

An isolated child bounds regex execution time as well as file I/O. Does not
follow links, import model code, expand shell syntax, or search outside root.
"""
import json
import os
import re
import stat
import sys


def search(root, options):
    budget = options["budget"]
    query = options["query"]
    fixed, case = options["fixed_strings"], options["case_sensitive"]
    needle = query if case else query.casefold()
    pattern = None if fixed else re.compile(query, 0 if case else re.IGNORECASE)
    result = {"matches": [], "truncated": False, "files_scanned": 0, "files_skipped": 0,
              "bytes_scanned": 0, "backend": "python", "symlinks_followed": False}
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    target = options["path"]
    pending = []

    def read_file(parent, name, path):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                result["files_skipped"] += 1
                return
            data = source.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            data = data[:1024 * 1024]
            result["truncated"] = True
            result["files_skipped"] += 1
        result["bytes_scanned"] += len(data)
        result["files_scanned"] += 1
        if b"\x00" in data:
            return
        for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            if fixed:
                index = (line if case else line.casefold()).find(needle)
                if index < 0:
                    continue
                column = index + 1 if case else None
            else:
                match = pattern.search(line)
                if not match:
                    continue
                column = match.start() + 1
            entry = {"path": path, "line": n, "column": column, "text": line[:600]}
            candidate = {**result, "matches": [*result["matches"], entry]}
            if len(json.dumps(candidate, ensure_ascii=False)) > budget - 200:
                result["truncated"] = True
                return
            result["matches"].append(entry)
            if len(result["matches"]) >= options["max_results"]:
                result["truncated"] = True
                return

    try:
        parts = [p for p in target.split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts) or target.startswith("/"):
            raise ValueError("invalid target")
        for p in parts[:-1]:
            next_fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            os.close(root_fd)
            root_fd = next_fd
        leaf = parts[-1] if parts else "."
        info = os.stat(leaf, dir_fd=root_fd, follow_symlinks=False)
        if stat.S_ISREG(info.st_mode):
            read_file(root_fd, leaf, target)
        elif stat.S_ISDIR(info.st_mode):
            directory = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            pending.append((directory, "" if target == "." else target))
            while pending:
                fd, relative = pending.pop()
                try:
                    for name in sorted(os.listdir(fd)):
                        if (result["files_scanned"] >= 10000 or result["bytes_scanned"] >= 64 * 1024 * 1024
                                or len(result["matches"]) >= options["max_results"]
                                or len(json.dumps(result, ensure_ascii=False)) > budget - 900):
                            result["truncated"] = True
                            return result
                        path = relative + "/" + name if relative else name
                        try:
                            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                            if stat.S_ISDIR(info.st_mode):
                                if len(pending) >= 128:
                                    result["truncated"] = True
                                    result["files_skipped"] += 1
                                else:
                                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                                    pending.append((child, path))
                            elif stat.S_ISREG(info.st_mode):
                                read_file(fd, name, path)
                        except OSError:
                            result["files_skipped"] += 1
                            result["truncated"] = True
                finally:
                    os.close(fd)
        else:
            raise ValueError("not a regular file or directory")
        return result
    finally:
        os.close(root_fd)
        for fd, _ in pending:
            os.close(fd)


if __name__ == "__main__":
    try:
        result = search(sys.argv[1], json.loads(sys.argv[2]))
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
    except (OSError, ValueError, re.error) as exc:
        print(json.dumps({"ok": False, "error": {"code": "python_search_failed", "message": type(exc).__name__}}))
        sys.exit(2)
