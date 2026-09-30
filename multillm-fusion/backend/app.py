"""Run with: python -m uvicorn backend.app:app --host 127.0.0.1 --port 8765."""

import asyncio
from contextlib import asynccontextmanager
import hmac
import json
import math
import time
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse

from .diagnostics import configure_logging, error_payload, event, register_secrets, shutdown_logging
from .engine import Engine, FusionError, Turn, available_models
from .models import AppConfig, ChatRequest, StrictModel
from .storage import Store


@asynccontextmanager
async def lifespan(application):
    log_path = configure_logging()
    event("backend.starting", path=str(log_path))
    try:
        store = Store()
    except Exception as exc:
        event("backend.startup_failed", level="error", code="storage_initialization_failed", error_type=type(exc).__name__)
        shutdown_logging()
        raise
    register_secrets(store.token, store.config.fusion.api_key)
    engine = Engine(store)
    application.state.engine = engine
    engine.start()
    event("backend.ready", provider_count=sum(p.enabled for p in store.config.providers))
    try:
        yield
    finally:
        await engine.close()
        store.close()
        event("backend.stopped")
        shutdown_logging()


app = FastAPI(title="MultiLLM Fusion", version="1.17.10", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def engine_of(request: Request) -> Engine:
    return request.app.state.engine


def valid_token(header, token):
    return isinstance(header, str) and hmac.compare_digest(header.encode(), ("Bearer " + token).encode())


async def authenticate(request: Request):
    if not valid_token(request.headers.get("authorization"), engine_of(request).store.token):
        raise FusionError("invalid_api_key", "A valid local Bearer API token is required.", 401)


@app.middleware("http")
async def local_boundaries(request: Request, call_next):
    # Reject Host-based browser DNS rebinding. Only literal local destinations are supported.
    try:
        parsed_host = urlsplit("//" + request.headers.get("host", ""))
        host = parsed_host.hostname
        _ = parsed_host.port
        valid_host = host in ("127.0.0.1", "localhost", "::1") and not parsed_host.username and not parsed_host.password
    except ValueError:
        valid_host = False
    if not valid_host:
        return JSONResponse(FusionError("invalid_host", "This service only accepts localhost hosts.", 403).payload(), status_code=403)
    if request.url.path != "/health" and not valid_token(request.headers.get("authorization"), engine_of(request).store.token):
        return JSONResponse(FusionError("invalid_api_key", "A valid local Bearer API token is required.", 401).payload(),
                            status_code=401, headers={"WWW-Authenticate": "Bearer"})
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > 4_000_000):
        return JSONResponse(FusionError("request_too_large", "Request body exceeds 4000000 bytes.", 413).payload(), status_code=413)
    if request.method in ("POST", "PUT", "PATCH"):
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 4_000_000:
                return JSONResponse(FusionError("request_too_large", "Request body exceeds 4000000 bytes.", 413).payload(), status_code=413)
            chunks.append(chunk)
        # Starlette's cached request replays _body to the downstream parser.
        request._body = b"".join(chunks)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.middleware("http")
async def request_diagnostics(request: Request, call_next):
    started = time.monotonic()
    # Log the ASGI path without parsing an untrusted Host before host validation.
    path = request.scope.get("path", "")
    known = {"/health", "/v1/models", "/v1/chat/completions", "/internal/config", "/internal/status",
             "/internal/history", "/internal/cancel", "/internal/browser-maintenance"}
    route = path if path in known else "/internal/history/:id" if path.startswith("/internal/history/") else "/v1/progress/:id" if path.startswith("/v1/progress/") else "unmatched"
    quiet = route in {"/health", "/internal/status", "/internal/history", "/v1/progress/:id"} and request.method == "GET"
    request.state.http_id = str(uuid4())
    if not quiet:
        event("http.started", http_id=request.state.http_id, method=request.method, route=route)
    try:
        response = await call_next(request)
    except Exception as exc:
        event("http.failed", level="error", http_id=request.state.http_id, route=route,
              request_id=getattr(request.state, "turn_id", None), status=500,
              code="unhandled_http_error", error_type=type(exc).__name__, duration_ms=round((time.monotonic() - started) * 1000),
              payload=error_payload(exc))
        response = JSONResponse(FusionError("internal_error", "Unexpected local HTTP failure; inspect the backend log.", 500).payload(),
                                status_code=500)
    response.headers["X-HTTP-ID"] = request.state.http_id
    if getattr(request.state, "turn_id", None):
        response.headers["X-Request-ID"] = request.state.turn_id
    if not quiet or response.status_code >= 400:
        event("http.responded", level="warning" if response.status_code >= 400 else "info",
              http_id=request.state.http_id, request_id=getattr(request.state, "turn_id", None),
              method=request.method, route=route, status=response.status_code,
              duration_ms=round((time.monotonic() - started) * 1000))
    return response


@app.exception_handler(FusionError)
async def fusion_error(_request, exc):
    event("http.rejected", level="warning", http_id=getattr(_request.state, "http_id", None),
          request_id=getattr(_request.state, "turn_id", None), code=exc.code, status=exc.status, payload=error_payload(exc))
    headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else {}
    if exc.status == 429:
        headers["Retry-After"] = "30"
    return JSONResponse(exc.payload(), status_code=exc.status, headers=headers)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, exc):
    descriptions = [".".join(str(p) for p in e["loc"]) + ": " + e["msg"] for e in exc.errors()]
    error = FusionError("invalid_request", "; ".join(descriptions), 422)
    event("http.rejected", level="warning", http_id=getattr(_request.state, "http_id", None), code="invalid_request", status=422,
          payload=error.payload())
    return JSONResponse(error.payload(), status_code=422)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/internal/config", dependencies=[Depends(authenticate)])
async def get_config(request: Request):
    return engine_of(request).store.config.model_dump()


@app.put("/internal/config", dependencies=[Depends(authenticate)])
async def put_config(config: AppConfig, request: Request):
    engine = engine_of(request)
    if engine.busy:
        raise FusionError("configuration_busy", "Wait for running and queued requests before changing settings.", 409)
    engine.store.write_config(config)
    register_secrets(config.fusion.api_key)
    event("configuration.saved", provider_count=sum(p.enabled for p in config.providers), mode=config.fusion.mode)
    engine.bridge.providers = {}
    if engine.bridge.websocket:
        engine.bridge.ready = False
        try:
            await engine.bridge.send({"type": "config", "config": config.model_dump()})
        except FusionError:
            # Disk config remains authoritative; reconnect resends it.
            pass
    return config.model_dump()


@app.get("/internal/status", dependencies=[Depends(authenticate)])
async def status(request: Request):
    engine = engine_of(request)
    config = engine.store.config
    recovery = config.generation.recovery_timeout_seconds
    # Parallel candidates followed by one synthesis, including the bounded
    # queue and bridge overhead. Ordinary OpenAI clients need not use this.
    max_wait = (330 + config.generation.timeout_seconds + recovery + config.fusion.timeout_seconds
                + (recovery if config.fusion.mode == "web" else 0))
    return {"service": "multillm-fusion", "version": "1.17.10", "capabilities": {"web_progress": 1, "web_recovery": 1},
            "web_recovery": {"recovery_timeout_seconds": recovery,
                             "generation_timeout_seconds": config.generation.timeout_seconds,
                             "fusion_timeout_seconds": config.fusion.timeout_seconds,
                             "max_wait_seconds": math.ceil(max_wait)},
            "bridge_connected": engine.bridge.connected, "busy": engine.busy,
            "providers": engine.bridge.providers, "queue_size": len(engine.queue),
            "browser_maintenance": engine.maintenance_lease is not None,
            "active_request_id": engine.active.request_id if engine.active else None}


@app.get("/v1/progress/{progress_id}", dependencies=[Depends(authenticate)])
async def request_progress(progress_id: UUID, request: Request, after: int = 0):
    if not 0 <= after <= 1_000_000:
        raise FusionError("invalid_progress_cursor", "Progress cursor is outside the allowed range.", 400)
    report = engine_of(request).progress.get(str(progress_id), after)
    # A GET can race the single POST's admission. This does not reserve an ID,
    # nor disclose another active request. Completed records expire after 120 s.
    return report or {"request_id": None, "done": False, "sequence": 0, "events": [], "pending": True}


class BrowserMaintenanceRequest(StrictModel):
    active: bool
    lease_id: UUID | None = None


@app.post("/internal/browser-maintenance", dependencies=[Depends(authenticate)])
async def browser_maintenance(body: BrowserMaintenanceRequest, request: Request):
    engine = engine_of(request)
    if body.active:
        if body.lease_id is not None:
            raise FusionError("invalid_request", "Do not provide a lease ID when acquiring browser maintenance.", 400)
        return {"active": True, "lease_id": engine.acquire_browser_maintenance()}
    if body.lease_id is None:
        raise FusionError("invalid_request", "Releasing browser maintenance requires its lease ID.", 400)
    engine.release_browser_maintenance(str(body.lease_id))
    return {"active": False}


@app.get("/internal/history", dependencies=[Depends(authenticate)])
async def history(request: Request):
    return {"conversations": engine_of(request).store.history()}


@app.get("/internal/history/{conversation_id}", dependencies=[Depends(authenticate)])
async def conversation(conversation_id: UUID, request: Request):
    result = engine_of(request).store.conversation(str(conversation_id))
    if result is None:
        raise FusionError("conversation_not_found", "Conversation not found.", 404)
    return result


@app.get("/v1/models", dependencies=[Depends(authenticate)])
async def models(request: Request):
    ids = available_models(engine_of(request).store.config)
    return {"object": "list", "data": [{"id": name, "object": "model", "created": 0, "owned_by": "local-web-fusion"} for name in ids]}


class CancelRequest(StrictModel):
    request_id: UUID


@app.post("/internal/cancel", dependencies=[Depends(authenticate)])
async def cancel(body: CancelRequest, request: Request):
    return {"cancelled": engine_of(request).cancel(str(body.request_id))}


async def await_turn(engine: Engine, turn: Turn, request: Request, *, check_disconnect=True):
    try:
        while not turn.future.done():
            if not turn.started and time.monotonic() - turn.queued_at > engine.MAX_QUEUE_WAIT:
                engine.cancel(turn.request_id, disconnected=True)
                raise FusionError("queue_timeout", "Request waited over 300 seconds in the queue; no website submission occurred.", 504)
            if check_disconnect and await request.is_disconnected():
                engine.cancel(turn.request_id, disconnected=True)
                raise FusionError("client_disconnected", "Client disconnected; generation was cancelled.", 499)
            await asyncio.wait({turn.future}, timeout=0.5)
        return turn.future.result()
    except asyncio.CancelledError:
        engine.cancel(turn.request_id, disconnected=True)
        raise


def sse(data):
    return "data: " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n\n"


async def stream_turn(engine: Engine, turn: Turn, request: Request):
    # Websites expose no dependable token stream: keep the connection alive until synthesis completes.
    # StreamingResponse owns the receive channel and cancels this iterator on disconnect.
    waiter = asyncio.create_task(await_turn(engine, turn, request, check_disconnect=False))
    try:
        yield ": queued; stream is buffered until the requested answer finishes\n\n"
        while not waiter.done():
            done, _ = await asyncio.wait({waiter}, timeout=10)
            if not done:
                yield ": keepalive\n\n"
        response = waiter.result()
        base = {k: response[k] for k in ("id", "created", "model")}
        base["object"] = "chat.completion.chunk"
        yield sse(dict(base, choices=[{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]))
        content = response["choices"][0]["message"]["content"]
        for offset in range(0, len(content), 512):
            yield sse(dict(base, choices=[{"index": 0, "delta": {"content": content[offset:offset + 512]}, "finish_reason": None}]))
        yield sse(dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}], fusion=response["fusion"]))
        yield "data: [DONE]\n\n"
    except FusionError as exc:
        event("http.stream_failed", level="warning", http_id=getattr(request.state, "http_id", None), request_id=turn.request_id,
              code=exc.code, status=exc.status, payload=error_payload(exc))
        yield sse(exc.payload())
        yield "data: [DONE]\n\n"
    finally:
        if not waiter.done():
            waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        if not turn.future.done():
            engine.cancel(turn.request_id, disconnected=True)


@app.post("/v1/chat/completions", dependencies=[Depends(authenticate)])
async def completions(body: ChatRequest, request: Request):
    engine = engine_of(request)
    event("http.chat_request", http_id=getattr(request.state, "http_id", None), payload={"request": body.model_dump()})
    request_source = request.headers.get("x-fusion-request-source", "api")
    progress_id = request.headers.get("x-fusion-progress-id")
    if progress_id is not None:
        try:
            progress_id = str(UUID(progress_id))
        except (ValueError, AttributeError):
            raise FusionError("invalid_progress_id", "X-Fusion-Progress-ID must be a UUID.", 400) from None
    turn = engine.submit(body, http_id=getattr(request.state, "http_id", None), progress_id=progress_id,
                         request_source=request_source)
    request.state.turn_id = turn.request_id
    event("http.request_accepted", http_id=getattr(request.state, "http_id", None), request_id=turn.request_id,
          request_source=turn.request_source,
          mode="fusion" if body.model == "web-fusion" else "single")
    if body.stream:
        return StreamingResponse(stream_turn(engine, turn, request), media_type="text/event-stream",
                                 headers={"X-Accel-Buffering": "no", "X-Request-ID": turn.request_id})
    response = await await_turn(engine, turn, request)
    event("http.chat_response", http_id=getattr(request.state, "http_id", None), request_id=turn.request_id,
          status=200, payload={"response": response})
    return JSONResponse(response, headers={"X-Request-ID": turn.request_id})


@app.websocket("/internal/bridge")
async def bridge_socket(websocket: WebSocket):
    engine = websocket.app.state.engine
    if websocket.headers.get("origin") or not valid_token(websocket.headers.get("authorization"), engine.store.token):
        event("bridge.rejected", level="warning", code="invalid_bridge_authentication")
        await websocket.close(code=1008)
        return
    if engine.bridge.websocket is not None:
        event("bridge.rejected", level="warning", code="bridge_already_connected")
        await websocket.close(code=1008)
        return
    # Reserve before the first await so simultaneous connection attempts cannot both attach.
    engine.bridge.websocket = websocket
    try:
        await websocket.accept()
        event("bridge.connected")
        await engine.bridge.send({"type": "config", "config": engine.store.config.model_dump()})
        while True:
            packet = await websocket.receive_json()
            if not isinstance(packet, dict):
                await websocket.close(code=1008)
                break
            engine.bridge.receive(packet)
    except (WebSocketDisconnect, RuntimeError, FusionError, ValueError):
        pass
    finally:
        engine.on_bridge_disconnect(websocket)
