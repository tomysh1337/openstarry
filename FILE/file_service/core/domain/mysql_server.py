import inspect
import json
import os
import sqlite3
from pathlib import Path
from typing import Callable, Dict

from core.commons.decorator import task_handler
from core.commons.logger import logger


class MysqlService:
    """Compatibility facade backed by the integrated local SQLite database."""

    def __init__(self, **_kwargs):
        self._conn = None

    async def init(self):
        data_root = Path(os.environ.get("OPENSTARRY_DATA_DIR", "./data"))
        data_root.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(data_root / "files.sqlite3", check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_uid TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS file_store (
                file_id TEXT PRIMARY KEY,
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                mime_type TEXT,
                user_uid TEXT NOT NULL,
                sha256 TEXT,
                deleted INTEGER NOT NULL DEFAULT 0,
                upload_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                deleted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_file_user ON file_store(user_uid, deleted, upload_at);
            CREATE INDEX IF NOT EXISTS idx_file_sha ON file_store(user_uid, sha256);
            CREATE TABLE IF NOT EXISTS agent_skills (
                skill_id TEXT PRIMARY KEY,
                skill_name TEXT NOT NULL,
                skill_description TEXT NOT NULL,
                skill_version TEXT NOT NULL DEFAULT 'v1.0',
                package_path TEXT NOT NULL,
                package_size INTEGER NOT NULL,
                package_sha256 TEXT,
                user_uid TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER NOT NULL DEFAULT 0,
                upload_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                deleted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_skill_user ON agent_skills(user_uid, deleted, upload_at);
            CREATE TABLE IF NOT EXISTS rag_documents (
                document_id TEXT PRIMARY KEY,
                document_name TEXT NOT NULL,
                document_description TEXT NOT NULL DEFAULT '',
                embed_engine TEXT,
                mime_type TEXT,
                document_path TEXT NOT NULL,
                document_size INTEGER NOT NULL,
                document_sha256 TEXT,
                user_uid TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                deleted INTEGER NOT NULL DEFAULT 0,
                upload_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                deleted_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_document_user ON rag_documents(user_uid, deleted, upload_at);
            """
        )
        self._conn.execute(
            "INSERT OR IGNORE INTO users(user_uid, username) VALUES (?, ?)",
            ("local-user", "本地用户"),
        )
        self._conn.commit()
        logger.success("[MysqlService] Local SQLite storage ready")

    async def _close(self):
        if self._conn:
            self._conn.close()
            self._conn = None

    def export_handlers(self) -> Dict[str, Callable]:
        handlers = {}
        for name in dir(self):
            value = getattr(self, name)
            task_name = getattr(value, "_handler_name", None)
            if task_name:
                if not inspect.iscoroutinefunction(value):
                    raise TypeError(f"Task handler '{task_name}' must be async")
                handlers[task_name] = value
        return handlers

    def _rows(self, query, params=()):
        return [dict(row) for row in self._conn.execute(query, params).fetchall()]

    def _commit(self, query, params=()):
        self._conn.execute(query, params)
        self._conn.commit()

    def export_sync_records(self, user_uid: str) -> list[dict]:
        rows = self._rows(
            """SELECT file_id,file_name,file_path,file_size,mime_type,sha256,
            deleted,upload_at,deleted_at FROM file_store WHERE user_uid=?""",
            (user_uid,),
        )
        records = []
        for row in rows:
            local_path = row.pop("file_path", "")
            records.append(
                {
                    "id": "file:" + row["file_id"],
                    "kind": "file",
                    "deleted": bool(row.get("deleted")),
                    "payload": row,
                    "localPath": local_path,
                }
            )
        return records

    def apply_sync_records(self, user_uid: str, records: list[dict]) -> int:
        applied = 0
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            self._conn.execute(
                "INSERT OR IGNORE INTO users(user_uid,username) VALUES (?,?)",
                (user_uid, "本地用户"),
            )
            for record in records:
                if record.get("kind") != "file":
                    continue
                payload = record.get("payload") or {}
                file_id = payload.get("file_id")
                if not file_id:
                    continue
                current = self._conn.execute(
                    "SELECT file_path FROM file_store WHERE file_id=? AND user_uid=?",
                    (file_id, user_uid),
                ).fetchone()
                if record.get("deleted") and not current:
                    continue
                file_path = record.get("localPath") or (
                    current["file_path"] if current else ""
                )
                self._conn.execute(
                    """INSERT INTO file_store(
                    file_id,file_name,file_path,file_size,mime_type,user_uid,
                    sha256,deleted,upload_at,deleted_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(file_id) DO UPDATE SET
                    file_name=excluded.file_name,file_path=excluded.file_path,
                    file_size=excluded.file_size,mime_type=excluded.mime_type,
                    sha256=excluded.sha256,deleted=excluded.deleted,
                    deleted_at=excluded.deleted_at""",
                    (
                        file_id,
                        payload.get("file_name") or file_id,
                        file_path,
                        int(payload.get("file_size") or 0),
                        payload.get("mime_type"),
                        user_uid,
                        payload.get("sha256"),
                        int(bool(record.get("deleted"))),
                        payload.get("upload_at") or "1970-01-01 00:00:00",
                        payload.get("deleted_at"),
                    ),
                )
                applied += 1
            self._conn.commit()
            return applied
        except Exception:
            self._conn.rollback()
            raise

    @task_handler("mysql.user.ensure_user_exists")
    async def ensure_user_exists(self, payload: dict) -> dict:
        user_uid = payload.get("client_id") or "local-user"
        self._commit(
            "INSERT OR IGNORE INTO users(user_uid, username) VALUES (?, ?)",
            (user_uid, payload.get("username") or "本地用户"),
        )
        return {"success": True, "messages": "success"}

    @task_handler("mysql.file.insert_file_info")
    async def insert_file_info(self, payload: dict) -> dict:
        try:
            for item in payload.get("file_info", []):
                self._commit(
                    """INSERT OR REPLACE INTO file_store
                    (file_id,file_name,file_path,file_size,mime_type,user_uid,sha256,deleted,deleted_at)
                    VALUES (?,?,?,?,?,?,?,0,NULL)""",
                    (
                        item["file_id"], item["file_name"], item["file_path"], item["file_size"],
                        item.get("file_type", "unknown"), payload.get("client_id", "local-user"), item.get("sha256"),
                    ),
                )
            return {"success": True, "messages": "success"}
        except Exception as error:
            logger.exception("[MysqlService][insert_file_info] %s", error)
            return {"success": False, "messages": f"fail: {error}"}

    @task_handler("mysql.file.update_file_status")
    async def update_file_status(self, payload: dict) -> dict:
        deleted = int(bool(payload.get("is_deleted")))
        self._commit(
            """UPDATE file_store SET deleted=?,
            deleted_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END
            WHERE file_id=? AND user_uid=?""",
            (deleted, deleted, payload.get("file_id"), payload.get("client_id", "local-user")),
        )
        return {"success": True, "messages": "success"}

    @task_handler("mysql.file.fetch_recent_files")
    async def fetch_recent_files(self, payload: dict) -> dict:
        rows = self._rows(
            """SELECT file_id,file_name,file_path,upload_at,file_size,sha256
            FROM file_store WHERE user_uid=? AND deleted=0 ORDER BY upload_at DESC LIMIT ?""",
            (payload.get("client_id", "local-user"), int(payload.get("limit", 5))),
        )
        return {"success": True, "messages": rows}

    @task_handler("mysql.file.fetch_target_file")
    async def fetch_target_file(self, payload: dict) -> dict:
        rows = self._rows(
            """SELECT file_id,file_name,file_path,upload_at,file_size,mime_type,sha256
            FROM file_store WHERE user_uid=? AND file_id=? AND deleted=0 LIMIT 1""",
            (payload.get("client_id", "local-user"), payload.get("file_id")),
        )
        return {"success": True, "messages": rows}

    @task_handler("mysql.skills.insert_skill_info")
    async def insert_skill_info(self, payload: dict) -> dict:
        try:
            for item in payload.get("messages", []):
                self._commit(
                    """INSERT OR REPLACE INTO agent_skills
                    (skill_id,skill_name,skill_description,skill_version,package_path,package_size,package_sha256,user_uid)
                    VALUES (?,?,?,?,?,?,?,?)""",
                    (
                        item["skill_id"], item["skill_name"], item["skill_description"],
                        item.get("skill_version", "v1.0"), item["package_path"], item["package_size"],
                        item.get("package_sha256"), payload.get("client_id", "local-user"),
                    ),
                )
            return {"success": True, "messages": "success"}
        except Exception as error:
            return {"success": False, "messages": f"fail: {error}"}

    @task_handler("mysql.skills.update_skill_status")
    async def update_skill_status(self, payload: dict) -> dict:
        current = self._rows(
            "SELECT is_active,deleted FROM agent_skills WHERE skill_id=? AND user_uid=?",
            (payload.get("skill_id"), payload.get("client_id", "local-user")),
        )
        if current:
            active = current[0]["is_active"] if payload.get("is_active") is None else int(bool(payload["is_active"]))
            deleted = current[0]["deleted"] if payload.get("deleted") is None else int(bool(payload["deleted"]))
            self._commit(
                """UPDATE agent_skills SET is_active=?,deleted=?,
                deleted_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END
                WHERE skill_id=? AND user_uid=?""",
                (active, deleted, deleted, payload.get("skill_id"), payload.get("client_id", "local-user")),
            )
        return {"success": True, "messages": "success"}

    @task_handler("mysql.skills.fetch_available_skills")
    async def fetch_available_skills(self, payload: dict) -> dict:
        rows = self._rows(
            """SELECT skill_id,skill_name,skill_description,skill_version,package_path,package_size,is_active,upload_at
            FROM agent_skills WHERE user_uid=? AND deleted=0 ORDER BY upload_at DESC LIMIT ?""",
            (payload.get("client_id", "local-user"), int(payload.get("limit", 5))),
        )
        for row in rows:
            row["is_active"] = bool(row["is_active"])
        return {"success": True, "messages": rows}

    @task_handler("mysql.skills.fetch_target_skill")
    async def fetch_target_skill(self, payload: dict) -> dict:
        rows = self._rows(
            """SELECT skill_id,skill_name,skill_description,skill_version,package_path,package_size,
            is_active,upload_at,deleted,deleted_at FROM agent_skills
            WHERE user_uid=? AND skill_id=? AND deleted=0 LIMIT 1""",
            (payload.get("client_id", "local-user"), payload.get("skill_id")),
        )
        for row in rows:
            row["is_active"] = bool(row["is_active"])
            row["deleted"] = bool(row["deleted"])
        return {"success": True, "messages": rows}

    @task_handler("mysql.rag.insert_rag_document")
    async def insert_rag_document(self, payload: dict) -> dict:
        try:
            for item in payload.get("file_info", []):
                self._commit(
                    """INSERT OR REPLACE INTO rag_documents
                    (document_id,document_name,document_description,mime_type,document_path,document_size,document_sha256,user_uid)
                    VALUES (?,?,?,?,?,?,?,?)""",
                    (
                        item["file_id"], item["file_name"], "", item.get("file_type", "unknown"),
                        item["file_path"], item["file_size"], item.get("sha256"),
                        payload.get("client_id", "local-user"),
                    ),
                )
            return {"success": True, "messages": "success"}
        except Exception as error:
            return {"success": False, "messages": f"fail: {error}"}

    @task_handler("mysql.rag.update_document_status")
    async def update_document_status(self, payload: dict) -> dict:
        rows = self._rows(
            "SELECT * FROM rag_documents WHERE document_id=? AND user_uid=?",
            (payload.get("document_id"), payload.get("client_id", "local-user")),
        )
        if rows:
            current = rows[0]
            active = current["is_active"] if payload.get("is_active") is None else int(bool(payload["is_active"]))
            deleted = current["deleted"] if payload.get("deleted") is None else int(bool(payload["deleted"]))
            description = current["document_description"] if payload.get("description") is None else payload["description"]
            embed_engine = current["embed_engine"] if payload.get("embed_engine") is None else payload["embed_engine"]
            if not isinstance(embed_engine, (str, type(None))):
                embed_engine = json.dumps(embed_engine, ensure_ascii=False)
            self._commit(
                """UPDATE rag_documents SET is_active=?,deleted=?,document_description=?,embed_engine=?,
                deleted_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END
                WHERE document_id=? AND user_uid=?""",
                (
                    active, deleted, description, embed_engine, deleted,
                    payload.get("document_id"), payload.get("client_id", "local-user"),
                ),
            )
        return {"success": True, "messages": "success"}

    def _decode_documents(self, rows):
        for row in rows:
            row["is_active"] = bool(row["is_active"])
            row["deleted"] = bool(row.get("deleted", 0))
            if row.get("embed_engine"):
                try:
                    row["embed_engine"] = json.loads(row["embed_engine"])
                except (TypeError, json.JSONDecodeError):
                    pass
            else:
                row["embed_engine"] = []
        return rows

    @task_handler("mysql.rag.fetch_available_documents")
    async def fetch_available_documents(self, payload: dict) -> dict:
        rows = self._rows(
            """SELECT document_id,document_name,document_description,embed_engine,mime_type,
            document_path,document_size,document_sha256,is_active,upload_at
            FROM rag_documents WHERE user_uid=? AND deleted=0 ORDER BY upload_at DESC LIMIT ?""",
            (payload.get("client_id", "local-user"), int(payload.get("limit", 5))),
        )
        return {"success": True, "messages": self._decode_documents(rows)}

    @task_handler("mysql.rag.fetch_target_document")
    async def fetch_target_document(self, payload: dict) -> dict:
        rows = self._rows(
            """SELECT document_id,document_name,document_description,embed_engine,mime_type,
            document_path,document_size,document_sha256,is_active,deleted,upload_at,deleted_at
            FROM rag_documents WHERE user_uid=? AND document_id=? LIMIT 1""",
            (payload.get("client_id", "local-user"), payload.get("document_id")),
        )
        return {"success": True, "messages": self._decode_documents(rows)}


mysql_server = MysqlService()
