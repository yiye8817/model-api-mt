"""Private local configuration, SQLite metadata, and durable reply outputs."""

import json
import os
from pathlib import Path
import secrets
import sqlite3
import tempfile
from datetime import datetime, timezone

from .models import AppConfig
from .diagnostics import event


def atomic_write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Store:
    def __init__(self, data_dir: Path | None = None):
        self.root = (data_dir or Path(os.environ.get(
            "FUSION_DATA_DIR", "~/.local/share/multillm-fusion"
        )).expanduser()).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        token_path = self.root / "api-key.txt"
        token_override = os.environ.get("FUSION_TOKEN")
        if token_override:
            self.token = token_override.strip()
        else:
            try:
                fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(secrets.token_urlsafe(32) + "\n")
            token_path.chmod(0o600)
            self.token = token_path.read_text(encoding="utf-8").strip()
        if len(self.token) < 16:
            raise ValueError("FUSION_TOKEN/api-key.txt must contain at least 16 characters")
        self.config_path = self.root / "config.json"
        example = Path(__file__).resolve().parent.parent / "config.example.json"
        if not self.config_path.exists():
            config = AppConfig.model_validate_json(example.read_text(encoding="utf-8"))
            self.write_config(config)
        self.config_path.chmod(0o600)
        raw_config = json.loads(self.config_path.read_text(encoding="utf-8"))
        from_schema = raw_config.get("schema_version", 1)
        migrate_v1 = from_schema == 1
        migrate_defaults = from_schema in (1, 2)
        if migrate_v1:
            # Migrate exactly once. Preserve site/auth/selectors and custom
            # deadlines; retire only the old release defaults and partial mode.
            raw_config["allow_partial"] = False
            for section in ("generation", "fusion"):
                settings = raw_config.setdefault(section, {})
                if settings.get("timeout_seconds", 180) == 180:
                    settings["timeout_seconds"] = 600
            raw_config["generation"].setdefault("submission_timeout_seconds", 120)
        appended = []
        glm_url_migrated = False
        # Keep the built-in web catalog available for both fresh installs and
        # existing schema-3 configurations.  New entries are disabled so a
        # user's active model set, ordering, selectors, proxy and credentials
        # remain untouched; each missing entry is appended only once unless a
        # user deliberately removes it from the local config.
        defaults = json.loads(example.read_text(encoding="utf-8"))["providers"]
        builtin_ids = {"glm", "kimi", "doubao", "yuanbao", "mimo", "baidu", "spark", "stepfun"}
        configured = raw_config.setdefault("providers", [])
        existing = {item.get("id") for item in configured if isinstance(item, dict)}
        for provider in defaults:
            if provider.get("id") in builtin_ids and provider["id"] not in existing:
                provider = dict(provider)
                provider["enabled"] = False
                configured.append(provider)
                appended.append(provider["id"])
        if migrate_defaults or appended:
            raw_config["schema_version"] = 3
        # Retire only the exact historical built-in GLM URL. Custom URLs,
        # paths, proxies and selectors remain untouched.
        for provider in raw_config.get("providers", []):
            if (isinstance(provider, dict) and provider.get("id") == "glm"
                    and provider.get("url") == "https://chatglm.cn/"):
                provider["url"] = "https://chat.z.ai/"
                glm_url_migrated = True
        self.config = AppConfig.model_validate(raw_config)
        if migrate_defaults or appended or glm_url_migrated:
            self.write_config(self.config)
            event("config.migrated", state="all_candidates_required" if migrate_v1 else "provider_catalog_updated", payload={
                "from_schema": from_schema, "to_schema": 3,
                "allow_partial": self.config.allow_partial,
                "providers_appended": appended,
                "glm_url_migrated": glm_url_migrated,
                "generation": self.config.generation.model_dump(),
                "fusion_timeout_seconds": self.config.fusion.timeout_seconds,
            })
        self.db = sqlite3.connect(self.root / "history.sqlite3", check_same_thread=False)
        (self.root / "history.sqlite3").chmod(0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY, title TEXT NOT NULL,
                messages_json TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
                request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
                fusion_json TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id);
        """)
        self.db.commit()

    def write_config(self, config: AppConfig):
        atomic_write(self.config_path, config.model_dump_json(indent=2) + "\n")
        self.config = config

    def write_markdown(self, request_id: str, filename: str, text: str) -> str:
        path = self.root / "runs" / request_id / filename
        atomic_write(path, text)
        return str(path)

    def exists(self, conversation_id: str) -> bool:
        return self.db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone() is not None

    def save_turn(self, conversation_id: str, messages: list, content: str, fusion: dict):
        now = datetime.now(timezone.utc).isoformat()
        title = next(m["content"] for m in messages if m["role"] == "user").strip()[:80]
        complete_messages = messages + [{"role": "assistant", "content": content}]
        with self.db:
            self.db.execute(
                "INSERT INTO conversations(id,title,messages_json,updated_at) VALUES(?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET messages_json=excluded.messages_json,updated_at=excluded.updated_at",
                (conversation_id, title, json.dumps(complete_messages, ensure_ascii=False), now),
            )
            self.db.execute(
                "INSERT INTO runs(request_id,conversation_id,fusion_json,created_at) VALUES(?,?,?,?)",
                (fusion["request_id"], conversation_id, json.dumps(fusion, ensure_ascii=False), now),
            )

    def history(self):
        rows = self.db.execute("SELECT id,title,updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100").fetchall()
        return [{"id": r[0], "title": r[1], "updated_at": r[2]} for r in rows]

    def conversation(self, conversation_id: str):
        row = self.db.execute("SELECT id,title,messages_json FROM conversations WHERE id=?", (conversation_id,)).fetchone()
        if not row:
            return None
        runs = self.db.execute(
            "SELECT fusion_json,created_at FROM runs WHERE conversation_id=? ORDER BY created_at", (conversation_id,)
        ).fetchall()
        return {"id": row[0], "title": row[1], "messages": json.loads(row[2]),
                "runs": [dict(json.loads(r[0]), created_at=r[1]) for r in runs]}

    def close(self):
        self.db.close()
