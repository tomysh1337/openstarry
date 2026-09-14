from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from core.domain.mysql_server import mysql_server


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
    return JSONResponse({"success": True, "applied": applied})
