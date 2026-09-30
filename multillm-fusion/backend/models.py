"""Validated configuration and the intentionally narrow text-only API contract."""

import os
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Selectors(StrictModel):
    input: list[str] = Field(default_factory=list, max_length=30)
    send: list[str] = Field(default_factory=list, max_length=30)
    # Some web apps (notably Yuanbao) expose conversation turns through
    # provider-specific classes instead of role/data-testid attributes.
    user: list[str] = Field(default_factory=list, max_length=30)
    assistant: list[str] = Field(default_factory=list, max_length=30)
    stop: list[str] = Field(default_factory=list, max_length=30)
    new_chat: list[str] = Field(default_factory=list, max_length=30)

    @field_validator("input", "send", "user", "assistant", "stop", "new_chat")
    @classmethod
    def bounded_selectors(cls, items):
        if any(not item.strip() or len(item) > 1000 for item in items):
            raise ValueError("selectors must be nonempty CSS selectors of at most 1000 characters")
        return items


def validate_url(value: str, *, website=False) -> str:
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("invalid URL") from exc
    if parsed.username or parsed.password or not parsed.hostname:
        raise ValueError("URL must have a host and must not contain credentials")
    if website:
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
        ):
            raise ValueError("website URL must use HTTPS (HTTP allowed only on localhost)")
    elif parsed.scheme not in ("http", "https") or parsed.query or parsed.fragment:
        raise ValueError("API base URL must be HTTP(S), without query or fragment")
    return value


class Provider(StrictModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,39}$")
    name: str = Field(min_length=1, max_length=80)
    url: str = Field(max_length=2048)
    enabled: bool = False
    proxy: str = Field(default="", max_length=1000)
    access_interval_seconds: float = Field(default=0, ge=0, le=3600)
    selectors: Selectors = Field(default_factory=Selectors)

    @field_validator("url")
    @classmethod
    def url_valid(cls, value):
        return validate_url(value, website=True)

    @field_validator("proxy")
    @classmethod
    def proxy_valid(cls, value):
        if value and ("\n" in value or "\r" in value or "@" in value):
            raise ValueError("proxy must not contain credentials or line breaks")
        return value


class FusionSettings(StrictModel):
    mode: Literal["web", "api"] = "web"
    provider: str = "chatgpt"
    base_url: str = Field(default="http://127.0.0.1:11434/v1", max_length=2048)
    api_key: str = Field(default="", max_length=8192)
    model: str = Field(default="", max_length=200)
    timeout_seconds: float = Field(default=600, ge=15, le=1200)

    @field_validator("base_url")
    @classmethod
    def url_valid(cls, value):
        return validate_url(value)


class ChatSettings(StrictModel):
    # A single wall-clock budget for ALL candidates in a web-fusion turn.
    # Synthesis has its own existing timeout; single-model Agent calls keep
    # GenerationSettings and their explicit recovery budget.
    # MiMo can stream long answers for several minutes.  Keep the default
    # generous enough for that first response while still allowing users to
    # lower it in Advanced settings.
    timeout_seconds: float = Field(default=180, ge=15, le=1200)


class GenerationSettings(StrictModel):
    qwen_retry_stages: bool = Field(default=True, strict=True)
    qwen_retry_screenshot: bool = Field(default=True, strict=True)
    qwen_retry_learning: bool = Field(default=True, strict=True)
    qwen_retry_trigger_wait_seconds: float = Field(default=3, ge=0.5, le=15)
    qwen_manual_retry_wait_seconds: float = Field(default=20, ge=1, le=120)
    input_chunk_chars: int = Field(default=4096, ge=256, le=16384, strict=True)
    input_chunk_delay_ms: int = Field(default=35, ge=0, le=1000, strict=True)
    submit_settle_seconds: float = Field(default=2, ge=0, le=10)
    submission_timeout_seconds: float = Field(default=120, ge=15, le=600)
    timeout_seconds: float = Field(default=600, ge=15, le=1200)
    recovery_timeout_seconds: float = Field(default=180, ge=0, le=600)
    stable_seconds: float = Field(default=6, ge=2, le=60)
    min_wait_seconds: float = Field(default=10, ge=2, le=120)

    @model_validator(mode="after")
    def validate_timing(self):
        if self.timeout_seconds <= self.min_wait_seconds + self.stable_seconds:
            raise ValueError("generation timeout must exceed min_wait_seconds + stable_seconds")
        return self


class AppConfig(StrictModel):
    schema_version: Literal[3] = 3
    # Schema 2 allowed 20 user entries. Schema 3 must be able to append the two
    # new disabled built-ins without deleting a user's valid configuration.
    providers: list[Provider] = Field(min_length=1, max_length=32)
    fusion: FusionSettings = Field(default_factory=FusionSettings)
    generation: GenerationSettings = Field(default_factory=GenerationSettings)
    chat: ChatSettings = Field(default_factory=ChatSettings)
    allow_partial: bool = False

    @model_validator(mode="after")
    def validate_providers(self):
        ids = [p.id for p in self.providers]
        enabled = [p.id for p in self.providers if p.enabled]
        if len(ids) != len(set(ids)):
            raise ValueError("provider IDs must be unique")
        if not 1 <= len(enabled) <= 16:
            raise ValueError("enable between one and sixteen providers")
        for provider in self.providers:
            if provider.enabled and (not provider.selectors.input or not provider.selectors.assistant):
                raise ValueError(f"enabled provider {provider.id} requires input and assistant selectors")
        if self.fusion.mode == "web" and self.fusion.provider not in enabled:
            raise ValueError("web synthesis provider must be enabled")
        if self.fusion.mode == "api" and not self.fusion.model.strip():
            raise ValueError("API synthesis requires a model")
        if self.fusion.mode == "api":
            url = urlsplit(self.fusion.base_url)
            own_port = int(os.environ.get("FUSION_PORT", "8765"))
            port = url.port or (443 if url.scheme == "https" else 80)
            if url.hostname in ("localhost", "127.0.0.1", "::1") and port == own_port:
                raise ValueError("synthesis API cannot point to this Fusion server: that would deadlock its queue")
        if self.fusion.mode == "web" and self.fusion.timeout_seconds <= (
            self.generation.stable_seconds + self.generation.min_wait_seconds
        ):
            raise ValueError("web synthesis timeout must exceed min_wait_seconds + stable_seconds")
        return self


class Message(StrictModel):
    role: Literal["system", "developer", "user", "assistant"]
    content: str = Field(max_length=200_000)


class ChatRequest(StrictModel):
    model: str = Field(default="web-fusion", min_length=1, max_length=200)
    messages: list[Message] = Field(min_length=1, max_length=100)
    stream: bool = False
    conversation_id: str | None = None
    # The current turn may be saved locally while the renderer drops older
    # messages after a DeepSeek/Fusion response.  The full request is still
    # used for this generation; this only controls the durable snapshot.
    save_current_only: bool = False

    @field_validator("conversation_id")
    @classmethod
    def valid_id(cls, value):
        return str(UUID(value)) if value is not None else None

    @model_validator(mode="after")
    def valid_messages(self):
        if not any(m.role == "user" and m.content.strip() for m in self.messages):
            raise ValueError("at least one nonempty user message is required")
        if sum(len(m.content) for m in self.messages) > 500_000:
            raise ValueError("conversation exceeds 500000 characters; start a new conversation")
        return self
