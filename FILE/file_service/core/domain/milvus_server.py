import inspect
import json
import math
import os
import sqlite3
from pathlib import Path
from typing import Callable, Dict

from core.commons.decorator import task_handler
from core.commons.logger import logger
from core.embedding_models import get_embed_model


class MilvusService:
    """Local compact vector store retaining the former service interface."""

    def __init__(self, **_kwargs):
        data_root = Path(os.environ.get("OPENSTARRY_DATA_DIR", "./data"))
        data_root.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(data_root / "rag.sqlite3", check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, document_id TEXT NOT NULL,
            provider TEXT NOT NULL, model TEXT NOT NULL, split_mode TEXT, content TEXT NOT NULL,
            metadata TEXT NOT NULL, vector TEXT NOT NULL)"""
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chunks_lookup ON chunks(user_id,document_id,provider,model)"
        )
        self._conn.commit()

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

    @staticmethod
    def _embedding(payload):
        return get_embed_model(
            provider=payload["provider"],
            model=payload["model"],
            api_key=payload.get("api_key", ""),
            extra_config=payload.get("extra_config"),
        )

    @staticmethod
    def _cosine(left, right):
        dot = sum(a * b for a, b in zip(left, right))
        left_size = math.sqrt(sum(a * a for a in left))
        right_size = math.sqrt(sum(b * b for b in right))
        return dot / (left_size * right_size) if left_size and right_size else 0.0

    @task_handler("milvus.file.insert_chunks")
    async def insert_file_chunks(self, payload: dict) -> dict:
        try:
            chunks = payload.get("chunks", [])
            texts = [document.page_content for document in chunks]
            vectors = await self._embedding(payload).aembed_documents(texts)
            self._conn.execute(
                "DELETE FROM chunks WHERE user_id=? AND document_id=? AND provider=? AND model=?",
                (payload["client_id"], payload["document_id"], payload["provider"], payload["model"]),
            )
            for document, vector in zip(chunks, vectors):
                metadata = {
                    **(document.metadata or {}),
                    "user_id": payload["client_id"],
                    "document_id": payload["document_id"],
                    "split_mode": payload.get("split_mode", ""),
                    "provider": payload["provider"],
                    "model": payload["model"],
                }
                self._conn.execute(
                    """INSERT INTO chunks(user_id,document_id,provider,model,split_mode,content,metadata,vector)
                    VALUES (?,?,?,?,?,?,?,?)""",
                    (
                        payload["client_id"], payload["document_id"], payload["provider"], payload["model"],
                        payload.get("split_mode", ""), document.page_content,
                        json.dumps(metadata, ensure_ascii=False), json.dumps(vector),
                    ),
                )
            self._conn.commit()
            return {"success": True, "messages": f"inserted {len(chunks)} chunks (local)"}
        except Exception as error:
            logger.exception("[LocalVectorStore][insert] %s", error)
            return {"success": False, "messages": f"fail: {error}"}

    @task_handler("milvus.search")
    async def similarity_search(self, payload: dict) -> dict:
        try:
            document_ids = payload.get("document_id")
            if isinstance(document_ids, str):
                document_ids = [document_ids]
            document_ids = document_ids or []
            query_vector = await self._embedding(payload).aembed_query(payload["query"])
            placeholders = ",".join("?" for _ in document_ids)
            query = """SELECT content,metadata,vector FROM chunks
            WHERE user_id=? AND provider=? AND model=?"""
            params = [payload["client_id"], payload["provider"], payload["model"]]
            if document_ids:
                query += f" AND document_id IN ({placeholders})"
                params.extend(document_ids)
            ranked = []
            for row in self._conn.execute(query, params).fetchall():
                similarity = self._cosine(query_vector, json.loads(row["vector"]))
                ranked.append((similarity, row))
            ranked.sort(key=lambda item: item[0], reverse=True)
            return {
                "success": True,
                "messages": [
                    {
                        "text": row["content"],
                        "metadata": json.loads(row["metadata"]),
                        "score": similarity,
                    }
                    for similarity, row in ranked[: int(payload.get("top_k", 5))]
                ],
            }
        except Exception as error:
            logger.exception("[LocalVectorStore][search] %s", error)
            return {"success": False, "messages": f"fail: {error}"}

    @task_handler("milvus.file.delete")
    async def delete_file_vectors(self, payload: dict) -> dict:
        cursor = self._conn.execute(
            "DELETE FROM chunks WHERE user_id=? AND document_id=?",
            (payload["client_id"], payload["document_id"]),
        )
        self._conn.commit()
        return {"success": True, "messages": f"vectors deleted: {cursor.rowcount}"}


milvus_server = MilvusService()
