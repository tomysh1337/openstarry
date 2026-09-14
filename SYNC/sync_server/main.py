import hashlib
import hmac
import json
import os
import re
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from store import SyncStore


app = FastAPI(title="OpenStarry Sync Server", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://localhost",
        "capacitor://localhost",
        "https://openstarry.154-219-110-177.sslip.io",
    ],
    allow_methods=["GET", "HEAD", "POST", "PUT", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-OpenStarry-User",
        "X-OpenStarry-Device",
    ],
)
store = SyncStore(os.environ.get("OPENSTARRY_SYNC_DATA", "/data"))


def configured_tokens() -> dict[str, str]:
    raw = os.environ.get("OPENSTARRY_SYNC_TOKENS", "{}")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("OPENSTARRY_SYNC_TOKENS must be valid JSON") from error
    return {str(key): str(token) for key, token in value.items() if token}


def authorize(user_id: str, authorization: str | None):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", user_id):
        raise HTTPException(status_code=400, detail="Invalid sync user")
    token = configured_tokens().get(user_id)
    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:]
    if not token or not hmac.compare_digest(token, supplied):
        raise HTTPException(status_code=401, detail="Invalid sync credentials")


def valid_sha256(value: str) -> str:
    normalized = value.lower()
    if len(normalized) != 64 or any(char not in "0123456789abcdef" for char in normalized):
        raise HTTPException(status_code=400, detail="Invalid attachment hash")
    return normalized


@app.get("/health")
def health():
    return {"status": "ok", "service": "openstarry-sync"}


@app.post("/v1/sync")
async def synchronize(
    request: Request,
    authorization: str | None = Header(default=None),
    x_openstarry_user: str | None = Header(default=None),
):
    payload = await request.json()
    user_id = str(payload.get("userId") or x_openstarry_user or "")
    authorize(user_id, authorization)
    if int(payload.get("protocolVersion") or 0) != 1:
        raise HTTPException(status_code=400, detail="Unsupported protocol version")
    result = store.synchronize(
        user_id=user_id,
        cursor=int(payload.get("cursor") or 0),
        operations=payload.get("operations") or [],
        limit=int(payload.get("limit") or 500),
    )
    return JSONResponse(result)


@app.head("/v1/sync/attachments/{sha256}")
def attachment_exists(
    sha256: str,
    authorization: str | None = Header(default=None),
    x_openstarry_user: str = Header(),
):
    authorize(x_openstarry_user, authorization)
    path = store.attachment_path(x_openstarry_user, valid_sha256(sha256))
    if not path.is_file():
        raise HTTPException(status_code=404)
    return JSONResponse({}, headers={"ETag": sha256})


@app.put("/v1/sync/attachments/{sha256}")
async def upload_attachment(
    sha256: str,
    request: Request,
    authorization: str | None = Header(default=None),
    x_openstarry_user: str = Header(),
):
    authorize(x_openstarry_user, authorization)
    expected = valid_sha256(sha256)
    destination = store.attachment_path(x_openstarry_user, expected)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(str(destination) + ".upload")
    hasher = hashlib.sha256()
    size = 0
    with temporary.open("wb") as output:
        async for chunk in request.stream():
            size += len(chunk)
            if size > 512 * 1024 * 1024:
                temporary.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Attachment is too large")
            hasher.update(chunk)
            output.write(chunk)
    if hasher.hexdigest() != expected:
        temporary.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Attachment hash mismatch")
    temporary.replace(destination)
    return {"success": True, "sha256": expected, "size": size}


@app.get("/v1/sync/attachments/{sha256}")
def download_attachment(
    sha256: str,
    authorization: str | None = Header(default=None),
    x_openstarry_user: str = Header(),
):
    authorize(x_openstarry_user, authorization)
    normalized = valid_sha256(sha256)
    path = store.attachment_path(x_openstarry_user, normalized)
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={"X-File-SHA256": normalized, "ETag": normalized},
    )
