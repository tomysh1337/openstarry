from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from core.domain.mysql_server import mysql_server
from core.domain.redis_server import redis_server


router = APIRouter(tags=["sync"])


@router.post("/sync/export")
async def export_sync_records(req: Request):
    payload = await req.json()
    user_uid = payload.get("client_id") or "local-user"
    return JSONResponse(
        {
            "success": True,
            "records": mysql_server.export_sync_records(user_uid),
        }
    )


@router.post("/sync/apply")
async def apply_sync_records(req: Request):
    payload = await req.json()
    user_uid = payload.get("client_id") or "local-user"
    applied = mysql_server.apply_sync_records(
        user_uid,
        payload.get("records") or [],
    )
    # SQLite imports must invalidate both the message and selected-branch caches.
    # Otherwise an already-open conversation continues to return its old rows.
    histories = {
        (record.get("payload") or {}).get("conversation_uid")
        for record in payload.get("records") or []
        if record.get("kind") in {"conversation", "message"}
    }
    for history_id in histories:
        if history_id:
            await redis_server.expire_immediately({"client_id": user_uid, "history_id": history_id})
    ids = {record.get("id") for record in payload.get("records") or []}
    normalized = [record for record in mysql_server.export_sync_records(user_uid) if record["id"] in ids]
    return JSONResponse({"success": True, "applied": applied, "records": normalized})


@router.post("/sync/preferences")
async def sync_preferences(req: Request):
    from core.domain.sync_preferences import sanitize_preference
    data = await req.json()
    user = data.get("client_id") or "local-user"
    records = []
    for key, value in (data.get("values") or {}).items():
        clean = sanitize_preference({"key": key, "value": value})
        if clean:
            records.append({"id": "preference:" + key, "kind": "preference", "payload": clean})
    if records:
        mysql_server.apply_sync_records(user, records)
    rows = mysql_server._sqlite_rows("SELECT pref_key,value FROM sync_preferences WHERE user_uid=?", (user,))
    import json
    return {"values": {row["pref_key"]: json.loads(row["value"]) for row in rows}}
