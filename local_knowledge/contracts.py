"""Shared, serializable contracts for local knowledge and its HTTP boundary."""
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, TypedDict

SourceKind = Literal['document', 'api_chat', 'web_chat', 'web_synthesis']
REASONS = frozenset(('disabled', 'empty_index', 'local_unavailable', 'uncalibrated',
    'low_relevance', 'constraint_mismatch', 'context_uncertain', 'insufficient_evidence',
    'evidence_conflict', 'stale_source', 'source_changed', 'invalid_answer', 'local_timeout', 'cancelled'))


@dataclass
class Position:
    kind: str = 'lines'
    start_line: int = 1
    end_line: int = 1
    start_char: int = 0
    end_char: int = 0
    page: int | None = None
    paragraph: int | None = None
    table: int | None = None
    row: int | None = None
    column: int | None = None
    message_id: str | None = None


@dataclass
class Source:
    id: str
    kind: SourceKind = 'document'
    title: str = ''
    locator: dict = field(default_factory=dict)
    enabled: bool = True
    revision: int = 0
    content_hash: str = ''
    context_complete: bool = True
    completed_at: float | None = None
    valid_until: float | None = None
    status: str = 'pending'
    nature: str = 'document'
    metadata: dict = field(default_factory=dict)


@dataclass
class Chunk:
    id: str
    source_id: str = ''
    revision: int = 0
    text: str = ''
    keyword_text: str = ''
    position: Position = field(default_factory=Position)
    ordinal: int = 0
    continuation_group: str | None = None
    status: str = 'pending'


@dataclass
class Candidate:
    chunk: Chunk
    raw_score: float = 0.0
    score: float = 0.0
    score_transform: str = 'identity'
    rank: int = 0


class QueryRequest(TypedDict, total=False):
    request_id: str
    question: str
    context: list[dict]
    system_constraints: str
    source_ids: list[str]
    mode: str
    online_target: dict | None
    parameters: dict
    conversation_id: str
    user_message_id: str


@dataclass
class Citation:
    source_id: str
    source_kind: str
    title: str
    chunk_id: str
    revision: int
    locator: dict
    position: Position
    quote: str


@dataclass
class QueryResult:
    request_id: str
    decision: str
    reason: str = ''
    answer: str | None = None
    citations: list[Citation] = field(default_factory=list)
    trace: list[dict] = field(default_factory=list)
    local_model: str = ''
    duration_ms: float = 0
    answer_origin: str | None = None

    def to_dict(self) -> dict:
        result = asdict(self)
        if self.decision != 'hit':
            result.update(answer=None, citations=[], answer_origin=None)
        return result


@dataclass
class ParseLimits:
    max_file_bytes: int = 20 * 1024 * 1024
    max_text_chars: int = 10 * 1024 * 1024
    max_pdf_page_bytes: int = 20 * 1024 * 1024
    timeout_seconds: float = 30
    max_memory_bytes: int = 512 * 1024 * 1024


@dataclass
class TextUnit:
    text: str
    position: Position
    kind: str = 'paragraph'
    continuation_group: str | None = None


@dataclass
class ParsedDocument:
    units: list[TextUnit]
    nature: str = 'document'
    warnings: list[str] = field(default_factory=list)


@dataclass
class ScanResult:
    files: list[Any] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    failed: list[dict] = field(default_factory=list)


@dataclass
class UploadItem:
    relative_path: str
    stream: Any
    size: int = 0
    encoding: str | None = None


@dataclass
class PreparedQuestion:
    original: str
    retrieval_question: str
    kind: str = 'qa'
    constraints: list[dict] = field(default_factory=list)
    context_basis: list[dict] = field(default_factory=list)


@dataclass
class MatchResult:
    answerable: bool
    reason: str = ''
    matched_constraints: list[str] = field(default_factory=list)
    unresolved_constraints: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)


@dataclass
class ValidatedAnswer:
    answer: str
    claims: list[dict]
    citations: list[Citation]


@dataclass
class EvaluationDataset:
    calibration: list[dict]
    validation: list[dict]


@dataclass
class EvaluationReport:
    answerable: int = 0
    correct_hits: int = 0
    wrong_hits: int = 0
    items: list[dict] = field(default_factory=list)
    model_fingerprint: str = ''
    dataset_hash: str = ''
    real_models: bool = False
    reviewed: bool = False
    threshold: float = 0.0
    dimension: int | None = None
    calibration: list[dict] = field(default_factory=list)
    validation_hash: str = ''

    def meets_release_gate(self) -> bool:
        return self.answerable > 0 and self.wrong_hits == 0 and self.correct_hits / self.answerable >= .6


def chunk_from_dict(data: dict) -> Chunk:
    value = dict(data)
    value['position'] = Position(**value.get('position', {}))
    return Chunk(**value)
