"""Bounded, body-free progress indexed by an unguessable client correlation ID."""

from collections import deque
import time


WEB_STAGES = frozenset({"preparing", "send_dispatched", "accepted", "server_responded",
                        "waiting_response", "generating", "collecting",
                        "retrying", "manual_retry_required", "recovering", "rate_limited",
                        "verification_required", "verification_cleared", "retry_unavailable"})


class ProgressStore:
    MAX_RECORDS = 128
    MAX_EVENTS = 256
    RETENTION_SECONDS = 120

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.records = {}
        self.requests = {}

    def prune(self):
        now = self.clock()
        for key, record in list(self.records.items()):
            if record["finished_at"] is not None and now - record["finished_at"] > self.RETENTION_SECONDS:
                self.requests.pop(record["request_id"], None)
                self.records.pop(key, None)

    def register(self, key, request_id):
        self.prune()
        if key in self.records:
            return False
        if len(self.records) >= self.MAX_RECORDS:
            finished = next((k for k, v in self.records.items() if v["finished_at"] is not None), None)
            if finished is None:
                return False
            self.requests.pop(self.records[finished]["request_id"], None)
            del self.records[finished]
        self.records[key] = {"request_id": request_id, "events": deque(maxlen=self.MAX_EVENTS),
                             "sequence": 0, "finished_at": None}
        self.requests[request_id] = key
        self.add(request_id, "queued")
        return True

    def add(self, request_id, stage, *, provider=None, purpose=None, http_status=None,
            retry_stage=None, remaining_seconds=None, retry_reason=None):
        record = self.records.get(self.requests.get(request_id))
        if record is None or record["finished_at"] is not None:
            return
        row = {"stage": stage}
        if provider is not None:
            row["provider"] = provider
        if purpose in ("candidate", "fusion"):
            row["purpose"] = purpose
        if type(http_status) is int and 100 <= http_status <= 599:
            row["http_status"] = http_status
        if stage in ("retrying", "manual_retry_required"):
            if retry_stage in ("dom_handler", "screenshot_click", "manual"):
                row["retry_stage"] = retry_stage
            if type(remaining_seconds) in (int, float) and 0 <= remaining_seconds <= 1200:
                row["remaining_seconds"] = int(remaining_seconds)
        if stage == "retry_unavailable" and retry_reason in (
                "cancelled", "total_deadline_expired", "recovery_disabled", "not_submitted",
                "already_attempted", "non_recoverable_error"):
            row["retry_reason"] = retry_reason
        # Repeated snapshots must not fill the ring or repeat terminal output.
        if record["events"] and all(record["events"][-1].get(k) == v for k, v in row.items()) and len(record["events"][-1]) == len(row) + 1:
            return
        record["sequence"] += 1
        record["events"].append({"sequence": record["sequence"], **row})

    def finish(self, request_id, stage):
        self.add(request_id, stage)
        record = self.records.get(self.requests.get(request_id))
        if record is not None and record["finished_at"] is None:
            record["finished_at"] = self.clock()

    def get(self, key, after=0):
        self.prune()
        record = self.records.get(key)
        if record is None:
            return None
        rows = record["events"]
        return {"request_id": record["request_id"], "done": record["finished_at"] is not None,
                "sequence": record["sequence"], "events": [dict(row) for row in rows if row["sequence"] > after],
                "truncated": bool(rows and after < rows[0]["sequence"] - 1)}
