import json
import sqlite3
import threading
import time
from pathlib import Path


class SyncStore:
    def __init__(self, data_dir: str):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.attachments_dir = self.data_dir / "attachments"
        self.attachments_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(
            self.data_dir / "sync.sqlite3",
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=NORMAL")
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS sync_meta (
              user_id TEXT PRIMARY KEY,
              latest_revision INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sync_records (
              user_id TEXT NOT NULL,
              record_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              payload TEXT NOT NULL,
              deleted INTEGER NOT NULL DEFAULT 0,
              modified_at INTEGER NOT NULL,
              device_id TEXT NOT NULL,
              revision INTEGER NOT NULL,
              PRIMARY KEY(user_id,record_id)
            );
            CREATE INDEX IF NOT EXISTS idx_sync_revision
            ON sync_records(user_id,revision);
            """
        )
        self._connection.commit()

    def _next_revision(self, user_id: str) -> int:
        self._connection.execute(
            """INSERT OR IGNORE INTO sync_meta(user_id,latest_revision)
            VALUES (?,0)""",
            (user_id,),
        )
        self._connection.execute(
            """UPDATE sync_meta SET latest_revision=latest_revision+1
            WHERE user_id=?""",
            (user_id,),
        )
        return int(
            self._connection.execute(
                "SELECT latest_revision FROM sync_meta WHERE user_id=?",
                (user_id,),
            ).fetchone()[0]
        )

    def latest_revision(self, user_id: str) -> int:
        row = self._connection.execute(
            "SELECT latest_revision FROM sync_meta WHERE user_id=?",
            (user_id,),
        ).fetchone()
        return int(row[0]) if row else 0

    def synchronize(
        self,
        user_id: str,
        cursor: int,
        operations: list[dict],
        limit: int = 500,
    ) -> dict:
        acknowledged = []
        server_time = int(time.time() * 1000)
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                for operation in operations[:1000]:
                    op_id = str(operation.get("opId") or "")
                    record = operation.get("record") or {}
                    record_id = str(record.get("id") or "")
                    kind = str(record.get("kind") or "")
                    device_id = str(operation.get("deviceId") or "")
                    if not op_id or not record_id or kind not in {
                        "conversation",
                        "message",
                        "file",
                        "provider",
                        "preference",
                    }:
                        continue
                    modified_at = int(operation.get("modifiedAt") or server_time)
                    modified_at = min(modified_at, server_time + 300000)
                    current = self._connection.execute(
                        """SELECT modified_at,device_id FROM sync_records
                        WHERE user_id=? AND record_id=?""",
                        (user_id, record_id),
                    ).fetchone()
                    incoming_version = (modified_at, device_id)
                    current_version = (
                        (int(current["modified_at"]), current["device_id"])
                        if current
                        else None
                    )
                    if current_version is None or incoming_version > current_version:
                        revision = self._next_revision(user_id)
                        self._connection.execute(
                            """INSERT INTO sync_records(
                            user_id,record_id,kind,payload,deleted,
                            modified_at,device_id,revision
                            ) VALUES (?,?,?,?,?,?,?,?)
                            ON CONFLICT(user_id,record_id) DO UPDATE SET
                            kind=excluded.kind,payload=excluded.payload,
                            deleted=excluded.deleted,
                            modified_at=excluded.modified_at,
                            device_id=excluded.device_id,
                            revision=excluded.revision""",
                            (
                                user_id,
                                record_id,
                                kind,
                                json.dumps(
                                    record.get("payload") or {},
                                    ensure_ascii=False,
                                    separators=(",", ":"),
                                ),
                                int(bool(record.get("deleted"))),
                                modified_at,
                                device_id,
                                revision,
                            ),
                        )
                    acknowledged.append(op_id)
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

            page_size = max(1, min(int(limit or 500), 1000))
            rows = self._connection.execute(
                """SELECT record_id,kind,payload,deleted,modified_at,
                device_id,revision FROM sync_records
                WHERE user_id=? AND revision>? ORDER BY revision ASC LIMIT ?""",
                (user_id, max(0, int(cursor or 0)), page_size),
            ).fetchall()
            records = [
                {
                    "id": row["record_id"],
                    "kind": row["kind"],
                    "payload": json.loads(row["payload"]),
                    "deleted": bool(row["deleted"]),
                    "modifiedAt": int(row["modified_at"]),
                    "deviceId": row["device_id"],
                    "revision": int(row["revision"]),
                }
                for row in rows
            ]
            latest = self.latest_revision(user_id)
            next_cursor = int(rows[-1]["revision"]) if rows else latest
            return {
                "protocolVersion": 1,
                "cursor": next_cursor,
                "serverCursor": latest,
                "serverTime": server_time,
                "hasMore": next_cursor < latest,
                "acknowledgedIds": acknowledged,
                "records": records,
            }

    def attachment_path(self, user_id: str, sha256: str) -> Path:
        return self.attachments_dir / user_id / sha256[:2] / sha256
