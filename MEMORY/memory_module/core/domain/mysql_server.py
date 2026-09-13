import asyncio
import os
import re
import sqlite3
from pathlib import Path
from ulid import ulid
import inspect
import json
import time
from typing import Callable, Dict
import aiomysql
from aiomysql.cursors import DictCursor
from fastapi.encoders import jsonable_encoder

from global_config import MYSQL_DOCKER_BASE_URL, MYSQL_DOCKER_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE, MYSQL_CHARSET, AUTO_COMMIT
from core.commons.logger import logger
from core.commons.decorator import task_handler
from core.commons.id_generator import idgen


class MysqlService:
    """
    MySQL service for persistent storage, include task info with status [done | failed] and dialog conversation history.
    """

    def __init__(self, *, host, port, user, password, database, charset="utf8mb4"):
        self._pool = None
        self._sqlite_conn = None
        self._pool_args = dict(
            host=host,
            port=port,
            user=user,
            password=password,
            db=database,
            charset=charset,
            autocommit=AUTO_COMMIT,
            cursorclass=DictCursor,
        )
        self._pool_lock = asyncio.Lock()

    async def init(self):
        """Initialize MySQL connection pool."""
        async with self._pool_lock:
            if os.environ.get("OPENSTARRY_INTEGRATED") == "1":
                self._init_sqlite()
                return
            if not self._pool:
                try:
                    self._pool = await aiomysql.create_pool(**self._pool_args)
                except Exception as exc:
                    self._init_sqlite()
                    logger.warning(f"[MysqlService] MySQL unavailable ({type(exc).__name__}); using local SQLite")

    def _init_sqlite(self):
        if self._sqlite_conn:
            return
        data_root = Path(os.environ.get("OPENSTARRY_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
        data_root.mkdir(parents=True, exist_ok=True)
        self._sqlite_conn = sqlite3.connect(data_root / "memory.sqlite3", check_same_thread=False)
        self._sqlite_conn.row_factory = sqlite3.Row
        self._sqlite_conn.execute("PRAGMA journal_mode=WAL")
        self._sqlite_conn.execute("PRAGMA synchronous=NORMAL")
        self._sqlite_conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              user_uid TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS conversations (
              id INTEGER PRIMARY KEY AUTOINCREMENT, user_uid TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'default',
              conversation_uid TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '新的聊天...',
              work_space TEXT DEFAULT '', last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              latest_cursor INTEGER NOT NULL DEFAULT 0, latest_timestamp INTEGER NOT NULL DEFAULT 0,
              has_new_message INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0,
              is_cron INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_conversation_user ON conversations(user_uid,is_deleted,is_pinned,last_active_at);
            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT, user_uid TEXT NOT NULL, conversation_id INTEGER NOT NULL,
              conversation_uid TEXT NOT NULL, generation_id TEXT NOT NULL DEFAULT '', node_id TEXT NOT NULL DEFAULT '',
              parent_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, content TEXT, think TEXT,
              extra TEXT, info TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              msg_cursor INTEGER NOT NULL, msg_timestamp INTEGER NOT NULL DEFAULT 0,
              is_deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(conversation_id,msg_cursor)
            );
            CREATE INDEX IF NOT EXISTS idx_message_conversation ON messages(user_uid,conversation_uid,msg_cursor);
            CREATE INDEX IF NOT EXISTS idx_message_node ON messages(conversation_id,node_id);
            CREATE TABLE IF NOT EXISTS shortterm_memory (
              memory_id TEXT PRIMARY KEY, user_uid TEXT NOT NULL, conversation_uid TEXT NOT NULL,
              content TEXT NOT NULL, created_timestamp INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS memo_files (
              file_id TEXT PRIMARY KEY, file_name TEXT NOT NULL, file_path TEXT NOT NULL, mime_type TEXT,
              user_uid TEXT NOT NULL, conversation_uid TEXT, deleted INTEGER NOT NULL DEFAULT 0,
              upload_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
            );
            CREATE TABLE IF NOT EXISTS llm_provider (
              provider_id TEXT PRIMARY KEY, user_uid TEXT NOT NULL, provider_name TEXT NOT NULL,
              type TEXT NOT NULL DEFAULT 'openai', endpoint TEXT NOT NULL, model_list TEXT NOT NULL DEFAULT '[]',
              description TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, is_deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS mcp_server (
              mcp_id TEXT PRIMARY KEY, user_uid TEXT NOT NULL, mcp_name TEXT NOT NULL, transport TEXT NOT NULL,
              endpoint TEXT, config TEXT NOT NULL DEFAULT '{}', description TEXT, tool_count INTEGER NOT NULL DEFAULT 0,
              enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              is_deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS cron_task (
              task_id TEXT PRIMARY KEY, user_uid TEXT NOT NULL, conversation_uid TEXT, platform TEXT DEFAULT 'default',
              name TEXT, prompt TEXT, execute TEXT, exec_time TEXT, repeat TEXT DEFAULT 'once',
              extra_config TEXT, description TEXT, enabled INTEGER NOT NULL DEFAULT 1,
              is_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        self._sqlite_conn.execute(
            "INSERT OR IGNORE INTO users(user_uid,username,password) VALUES (?,?,?)",
            ("local-user", "本地用户", ""),
        )
        self._sqlite_conn.commit()

    async def _close(self):
        """Close MySQL connection pool."""
        async with self._pool_lock:
            if self._pool:
                self._pool.close()
                await self._pool.wait_closed()
                self._pool = None
            if self._sqlite_conn:
                self._sqlite_conn.close()
                self._sqlite_conn = None

    def _conversation_id_generator(self) -> str:
        """
        Generate a unique conversation ID using Yuki IdGenerator.
        """
        uid = idgen.next_id()
        return str(uid)
    
    async def _call_procedure(self, proc_name: str, params: tuple | None = None):
        """
        Call stored procedure using CALL statement.

        Always return the last result set (may be empty).
        All result sets are fully consumed to keep connection clean.
        """
        logger.info(f"[MysqlService][_call_procedure] enter.")
        if self._sqlite_conn:
            return self._call_sqlite_procedure(proc_name, params or ())
        if not self._pool:
            raise RuntimeError("[MysqlService][_call_procedure] MySQL pool is not initialized, call init() first")
        async with self._pool.acquire() as conn:
            async with conn.cursor() as cursor:
                if params:
                    placeholders = ", ".join(["%s"] * len(params))
                    sql = f"CALL {proc_name}({placeholders})"
                    await cursor.execute(sql, params)
                else:
                    sql = f"CALL {proc_name}()"
                    await cursor.execute(sql)

                # Only persist the latest message in payload.messages
                # Upstream is responsible for calling append_message per message
                results = []
                while True:
                    rows = await cursor.fetchall()
                    results.append(rows)
                    # logger.info(f"[MysqlService][_call_procedure] append rows: {rows}")
                    if not await cursor.nextset():
                        break
                index = min(len(results), 2) # Ignore Message OK at the fetchall's tail.
                return jsonable_encoder(results[-index]) if results else []

    def _sqlite_rows(self, query, params=()):
        rows = [dict(row) for row in self._sqlite_conn.execute(query, params).fetchall()]
        for row in rows:
            for key in ("extra", "info", "model_list", "config", "extra_config"):
                if row.get(key):
                    try:
                        row[key] = json.loads(row[key])
                    except (TypeError, json.JSONDecodeError):
                        pass
            for key in ("is_pinned", "has_new_message", "is_cron", "is_deleted", "enabled"):
                if key in row:
                    row[key] = bool(row[key])
        return rows

    def _sqlite_execute(self, query, params=()):
        cursor = self._sqlite_conn.execute(query, params)
        self._sqlite_conn.commit()
        return cursor

    def _sqlite_update_optional(self, table, key_name, key_value, owner_name, owner_value, values):
        updates = [(name, value) for name, value in values.items() if value is not None]
        if not updates:
            return
        assignments = ", ".join(f"{name}=?" for name, _ in updates)
        params = [value for _, value in updates]
        params.extend([key_value, owner_value])
        self._sqlite_execute(
            f"UPDATE {table} SET {assignments} WHERE {key_name}=? AND {owner_name}=?",
            params,
        )

    def _call_sqlite_procedure(self, proc_name, params):
        if proc_name == "create_user":
            self._sqlite_execute("INSERT INTO users(user_uid,username,password) VALUES (?,?,?)", params)
            return []
        if proc_name == "verify_user":
            return self._sqlite_rows("SELECT user_uid,username FROM users WHERE username=? AND password=?", params)
        if proc_name == "ensure_user_exists":
            user_uid, username = params
            if user_uid:
                self._sqlite_execute(
                    "INSERT OR IGNORE INTO users(user_uid,username,password) VALUES (?,?,?)",
                    (user_uid, username or ("本地用户" if user_uid == "local-user" else user_uid), ""),
                )
            return self._sqlite_rows(
                "SELECT user_uid,username FROM users WHERE user_uid=? OR (? IS NOT NULL AND username=?)",
                (user_uid, username, username),
            )
        if proc_name == "create_conversation":
            user_uid, platform, conversation_uid, title, workspace, is_cron = params
            self._sqlite_execute(
                """INSERT INTO conversations(user_uid,platform,conversation_uid,title,work_space,is_cron)
                VALUES (?,?,?,?,?,?)""",
                (user_uid, platform or "default", conversation_uid, title or "新的聊天...", workspace or "", int(bool(is_cron))),
            )
            return []
        if proc_name == "update_conversation":
            user_uid, conversation_uid, title, workspace, pinned, deleted, has_new = params
            self._sqlite_update_optional(
                "conversations", "conversation_uid", conversation_uid, "user_uid", user_uid,
                {
                    "title": title, "work_space": workspace,
                    "is_pinned": None if pinned is None else int(bool(pinned)),
                    "is_deleted": None if deleted is None else int(bool(deleted)),
                    "has_new_message": None if has_new is None else int(bool(has_new)),
                },
            )
            return []
        if proc_name == "fetch_conversation_list":
            return self._sqlite_rows(
                """SELECT conversation_uid,title,work_space,last_active_at,created_at,latest_cursor,
                is_pinned,has_new_message,is_cron FROM conversations
                WHERE user_uid=? AND is_deleted=0 ORDER BY is_pinned DESC,last_active_at DESC""",
                params,
            )
        if proc_name == "get_conversation_meta_by_id":
            return self._sqlite_rows(
                """SELECT conversation_uid,title,work_space,last_active_at,created_at,latest_cursor,
                is_pinned,has_new_message FROM conversations WHERE conversation_uid=? AND is_deleted=0 LIMIT 1""",
                params,
            )
        if proc_name == "append_message":
            (
                user_uid, conversation_uid, role, content, think, extra, info,
                generation_id, node_id, parent_id, timestamp,
            ) = params
            conversation = self._sqlite_conn.execute(
                "SELECT id,latest_cursor,latest_timestamp FROM conversations WHERE user_uid=? AND conversation_uid=? AND is_deleted=0",
                (user_uid, conversation_uid),
            ).fetchone()
            if not conversation:
                raise RuntimeError("Conversation not found or deleted")
            cursor = int(conversation["latest_cursor"]) + 1
            inserted = self._sqlite_conn.execute(
                """INSERT INTO messages(user_uid,conversation_id,conversation_uid,role,content,think,extra,info,
                msg_cursor,generation_id,node_id,parent_id,msg_timestamp)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    user_uid, conversation["id"], conversation_uid, role, content, think, extra, info,
                    cursor, generation_id, node_id, parent_id, timestamp,
                ),
            )
            self._sqlite_conn.execute(
                """UPDATE conversations SET latest_cursor=?,latest_timestamp=?,last_active_at=CURRENT_TIMESTAMP,
                has_new_message=? WHERE id=?""",
                (cursor, max(int(conversation["latest_timestamp"] or 0), int(timestamp)), int(role != "human"), conversation["id"]),
            )
            self._sqlite_conn.commit()
            created = self._sqlite_conn.execute("SELECT created_at FROM messages WHERE id=?", (inserted.lastrowid,)).fetchone()[0]
            return [{"msg_id": inserted.lastrowid, "msg_cursor": cursor, "msg_timestamp": timestamp, "created_at": created}]
        if proc_name == "delete_messages_node":
            rows = self._sqlite_rows(
                "SELECT info FROM messages WHERE user_uid=? AND conversation_uid=? AND node_id=?",
                params,
            )
            self._sqlite_execute(
                "UPDATE messages SET is_deleted=1 WHERE user_uid=? AND conversation_uid=? AND node_id=?",
                params,
            )
            return rows
        if proc_name == "fetch_messages_after_cursor":
            return self._sqlite_rows(
                """SELECT role,content,think,extra,info,msg_cursor,created_at,generation_id,node_id,parent_id,is_deleted
                FROM messages WHERE user_uid=? AND conversation_uid=? AND msg_cursor>=?
                ORDER BY msg_cursor ASC LIMIT ?""",
                params,
            )
        if proc_name == "fetch_messages_for_user":
            return self._sqlite_rows(
                """SELECT role,content,think,extra,info,msg_cursor,generation_id,created_at
                FROM messages WHERE user_uid=? AND conversation_uid=? AND role IN ('ai','human','info')
                AND is_deleted=0 ORDER BY msg_cursor ASC""",
                params,
            )
        if proc_name == "search_messages_by_keyword":
            user_uid, keyword = params
            return self._sqlite_rows(
                """SELECT m.conversation_uid,m.generation_id,m.role,m.content,c.title,c.last_active_at
                FROM messages m JOIN conversations c ON c.id=m.conversation_id
                WHERE c.user_uid=? AND c.is_deleted=0 AND m.is_deleted=0 AND m.role IN ('human','ai')
                AND m.content LIKE ? ORDER BY c.last_active_at DESC,m.id DESC LIMIT 300""",
                (user_uid, f"%{keyword}%"),
            )
        if proc_name == "insert_file_info":
            self._sqlite_execute(
                """INSERT OR REPLACE INTO memo_files(file_id,file_name,file_path,mime_type,user_uid,conversation_uid)
                VALUES (?,?,?,?,?,?)""",
                params,
            )
            return []
        if proc_name == "update_file_info":
            file_id, user_uid, deleted = params
            self._sqlite_execute(
                """UPDATE memo_files SET deleted=?,deleted_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE NULL END
                WHERE file_id=? AND user_uid=?""",
                (int(bool(deleted)), int(bool(deleted)), file_id, user_uid),
            )
            return []
        if proc_name == "fetch_recent_files":
            return self._sqlite_rows(
                """SELECT file_id,file_name,file_path,mime_type,conversation_uid,upload_at
                FROM memo_files WHERE user_uid=? AND deleted=0 ORDER BY upload_at DESC LIMIT ?""",
                params,
            )
        if proc_name == "insert_shortterm_memory":
            self._sqlite_execute(
                """INSERT OR REPLACE INTO shortterm_memory(memory_id,user_uid,conversation_uid,content,created_timestamp,is_deleted)
                VALUES (?,?,?,?,?,0)""",
                params,
            )
            return []
        if proc_name == "fetch_shortterm_memory":
            return self._sqlite_rows(
                """SELECT memory_id,content,created_timestamp FROM shortterm_memory
                WHERE user_uid=? AND conversation_uid=? AND is_deleted=0 ORDER BY created_timestamp DESC LIMIT 1""",
                params,
            )
        if proc_name == "delete_shortterm_memory":
            memory_ids, user_uid, conversation_uid = params
            ids = json.loads(memory_ids) if isinstance(memory_ids, str) else memory_ids
            if not isinstance(ids, list):
                ids = [ids]
            for memory_id in ids:
                self._sqlite_conn.execute(
                    "UPDATE shortterm_memory SET is_deleted=1 WHERE memory_id=? AND user_uid=? AND conversation_uid=?",
                    (memory_id, user_uid, conversation_uid),
                )
            self._sqlite_conn.commit()
            return []
        if proc_name == "create_llm_provider":
            self._sqlite_execute(
                """INSERT OR REPLACE INTO llm_provider
                (provider_id,user_uid,provider_name,type,endpoint,model_list,description) VALUES (?,?,?,?,?,?,?)""",
                params,
            )
            return []
        if proc_name == "get_llm_providers":
            return self._sqlite_rows(
                """SELECT provider_id,provider_name,type,endpoint,model_list,description,created_at
                FROM llm_provider WHERE user_uid=? AND is_deleted=0 ORDER BY created_at DESC""",
                params,
            )
        if proc_name == "get_llm_provider_by_id":
            return self._sqlite_rows(
                """SELECT provider_id,provider_name,type,endpoint,model_list,description,created_at
                FROM llm_provider WHERE provider_id=? AND is_deleted=0 LIMIT 1""",
                params,
            )
        if proc_name == "update_llm_provider":
            provider_id, user_uid, name, provider_type, endpoint, models, description, deleted = params
            self._sqlite_update_optional(
                "llm_provider", "provider_id", provider_id, "user_uid", user_uid,
                {
                    "provider_name": name, "type": provider_type, "endpoint": endpoint,
                    "model_list": models, "description": description,
                    "is_deleted": None if deleted is None else int(bool(deleted)),
                },
            )
            return []
        if proc_name == "create_mcp_server":
            self._sqlite_execute(
                """INSERT OR REPLACE INTO mcp_server
                (mcp_id,user_uid,mcp_name,transport,endpoint,config,description) VALUES (?,?,?,?,?,?,?)""",
                params,
            )
            return []
        if proc_name in ("get_mcp_servers", "get_enabled_mcp_servers"):
            where = "user_uid=? AND is_deleted=0" + (" AND enabled=1" if proc_name == "get_enabled_mcp_servers" else "")
            fields = "mcp_id,mcp_name,transport,endpoint,config"
            if proc_name == "get_mcp_servers":
                fields += ",description,enabled,tool_count,created_at"
            return self._sqlite_rows(f"SELECT {fields} FROM mcp_server WHERE {where} ORDER BY created_at ASC", params)
        if proc_name == "update_mcp_server":
            mcp_id, user_uid, name, transport, endpoint, config, description, enabled, tool_count, deleted = params
            self._sqlite_update_optional(
                "mcp_server", "mcp_id", mcp_id, "user_uid", user_uid,
                {
                    "mcp_name": name, "transport": transport, "endpoint": endpoint, "config": config,
                    "description": description, "enabled": None if enabled is None else int(bool(enabled)),
                    "tool_count": tool_count, "is_deleted": None if deleted is None else int(bool(deleted)),
                },
            )
            return []
        if proc_name == "create_cron_task":
            self._sqlite_execute(
                """INSERT OR REPLACE INTO cron_task
                (task_id,user_uid,conversation_uid,platform,name,prompt,execute,exec_time,repeat,extra_config,description)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                params,
            )
            return []
        if proc_name in ("get_cron_tasks", "get_cron_task_by_id", "get_all_enabled_cron_tasks"):
            fields = """task_id,user_uid,conversation_uid,platform,name,prompt,execute,exec_time,repeat,
            extra_config,description,enabled,created_at,updated_at"""
            if proc_name == "get_cron_tasks":
                query, values = f"SELECT {fields} FROM cron_task WHERE user_uid=? AND is_deleted=0 ORDER BY exec_time", params
            elif proc_name == "get_cron_task_by_id":
                query, values = f"SELECT {fields} FROM cron_task WHERE task_id=? AND is_deleted=0 LIMIT 1", params
            else:
                query, values = f"SELECT {fields} FROM cron_task WHERE enabled=1 AND is_deleted=0 ORDER BY exec_time", ()
            return self._sqlite_rows(query, values)
        if proc_name == "update_cron_task":
            task_id, conversation_id, platform, name, prompt, execute, exec_time, repeat, extra, description, enabled, deleted = params
            updates = {
                "conversation_uid": conversation_id, "platform": platform, "name": name, "prompt": prompt,
                "execute": execute, "exec_time": exec_time, "repeat": repeat, "extra_config": extra,
                "description": description, "enabled": None if enabled is None else int(bool(enabled)),
                "is_deleted": None if deleted is None else int(bool(deleted)),
            }
            actual = [(key, value) for key, value in updates.items() if value is not None]
            if actual:
                assignments = ",".join(f"{key}=?" for key, _ in actual)
                self._sqlite_execute(
                    f"UPDATE cron_task SET {assignments},updated_at=CURRENT_TIMESTAMP WHERE task_id=?",
                    [value for _, value in actual] + [task_id],
                )
            return []
        raise NotImplementedError(f"SQLite procedure is not implemented: {proc_name}")
                


    # ------------------------------------------------------------------
    # Handler Export
    # ------------------------------------------------------------------

    def export_handlers(self) -> Dict[str, Callable]:
        handlers: Dict[str, Callable] = {}

        for attr_name in dir(self):
            if attr_name.startswith("_"):
                continue

            attr = getattr(self, attr_name)
            if not callable(attr):
                continue

            task_name = getattr(attr, "_handler_name", None)
            if not task_name:
                continue

            if not inspect.iscoroutinefunction(attr):
                raise TypeError(
                    f"[MysqlService][export_handlers] Task handler '{task_name}' must be async function"
                )

            handlers[task_name] = attr

        return handlers
            
    # --------------------------------------------------
    # Action of Memo Mysql (Dialog Memory)
    # --------------------------------------------------

    @task_handler("mysql.user.create_a_user")
    async def create_a_user(self, payload: dict) -> dict:
        """
        Ensure user account exists. Call procedure create_a_user.
        If user not exist, raise RuntimeError.

        Args:
            payload: Dict, the format is {
                "client_id": str, # user_uid
                "username": str,
                "password": str, # encrypted
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or "success",
            }
        """
        logger.info(f"[MysqlService][create_a_user] enter.")
        try:
            user_uid = payload["client_id"]
            username = payload["username"]
            password = payload["password"]
            if self._sqlite_conn:
                self._sqlite_conn.execute(
                    "INSERT INTO users (user_uid, username, password) VALUES (?, ?, ?)",
                    (user_uid, username, password),
                )
                self._sqlite_conn.commit()
                return {
                    "success": True,
                    "messages": {"msg": "success", "uid": user_uid},
                }
            await self._call_procedure("create_user", (user_uid, username, password))
            return {
                "success": True,
                "messages": {
                    "msg": "success",
                    "uid": user_uid
                },
            }
        except Exception as e:
            logger.exception(f"[MysqlService][create_a_user] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": {
                    "msg": f"{type(e).__name__}: {e}",
                    "uid": None
                },
            }

    @task_handler("mysql.user.verify_user")
    async def verify_user(self, payload: dict) -> dict:
        """
        Ensure user account exists. Call procedure verify_user.
        If user not exist, raise RuntimeError.

        Args:
            payload: Dict, the format is {
                "username": str,
                "password": str, # encrypted
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or "success",
            }
        """
        logger.info(f"[MysqlService][verify_user] enter.")
        try:
            username = payload["username"]
            password = payload["password"]
            if self._sqlite_conn:
                row = self._sqlite_conn.execute(
                    "SELECT user_uid FROM users WHERE username = ? AND password = ?",
                    (username, password),
                ).fetchone()
                if not row:
                    raise Exception("User do not exist or wrong password.")
                return {
                    "success": True,
                    "messages": {"msg": "success", "uid": row[0]},
                }
            res = await self._call_procedure("verify_user", (username, password))
            if(len(res) != 1): raise Exception("User do not exist or wrong password.")
            return {
                "success": True,
                "messages": {
                    "msg": "success",
                    "uid": res[0].get("user_uid")
                },
            }
        except Exception as e:
            logger.exception(f"[MysqlService][verify_user] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": {
                    "msg": f"{type(e).__name__}: {e}",
                    "uid": None
                },
            }

    @task_handler("mysql.user.ensure_user_exists")
    async def ensure_user_exists(self, payload: dict, exist: bool = True) -> dict:
        """
        Ensure user account exists. Call procedure ensure_user_exists.
        If user not exist, raise RuntimeError.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
            }
            exist: ensure exist if ture, else ensure not exist.

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or "success",
            }
        """
        logger.info(f"[MysqlService][ensure_user_exists] enter.")
        try:
            user_uid = payload["client_id"]
            user_name = payload.get("username")
            if self._sqlite_conn:
                row = self._sqlite_conn.execute(
                    "SELECT user_uid FROM users WHERE user_uid = ?",
                    (user_uid,),
                ).fetchone()
                if exist and not row:
                    raise Exception("User do not exist.")
                if not exist and row:
                    raise Exception("User has already exist.")
                return {"success": True, "messages": "success"}
            res = await self._call_procedure("ensure_user_exists", (user_uid, user_name))
            # logger.debug(res)
            if exist and len(res) == 0: raise Exception("User do not exist.")
            elif not exist and len(res) > 0: raise Exception("User has already exist.")
            return {
                "success": True,
                "messages": "success",
            }
        except Exception as e:
            logger.exception(f"[MysqlService][ensure_user_exists] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    # --------------------------------------------------
    # Action of Memo Mysql (Dialog Memory)
    # --------------------------------------------------

    @task_handler("mysql.memo.fetch_conversation_list")
    async def fetch_conversation_list(self, payload: dict) -> dict:
        """
        Get conversation history list for a user. Call procedure fetch_conversation_list.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or [...] (list of conversation histories dicts),
            }
        """
        logger.info(f"[MysqlService][fetch_conversation_list] enter.")
        try:
            user_uid = payload["client_id"]
            rows = await self._call_procedure("fetch_conversation_list", (str(user_uid),))
            return {
                "success": True,
                "messages": rows,
            }
        except Exception as e:
            logger.exception(f"[MysqlService][fetch_conversation_list] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.memo.get_conversation_meta_by_id")
    async def get_conversation_meta_by_id(self, payload: dict) -> dict:
        """
        Get a conversation metadata. Call procedure get_conversation_meta_by_id.

        Args:
            payload: Dict, the format is {
                "history_id": "{{ hid }} : to indicate which dialog history the data belong to.",
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or [...] (list of conversation meta dicts),
            }
        """
        logger.info(f"[MysqlService][get_conversation_meta_by_id] enter.")
        try:
            conversation_uid = payload["history_id"]
            rows = await self._call_procedure("get_conversation_meta_by_id", (conversation_uid,))
            return {
                "success": True,
                "messages": rows,
            }
        except Exception as e:
            logger.exception(f"[MysqlService][get_conversation_meta_by_id] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.memo.create_conversation")
    async def create_conversation(self, payload: dict) -> dict:
        """
        Create a new conversation record. Call procedure create_conversation.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "platform": str,
                "title": "conversation title",
                "workspace": "Agent work dir",
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or "conversation_uid",
            }
        """
        logger.info(f"[MysqlService][create_conversation] enter.")
        try:
            user_uid = payload["client_id"]
            platform = payload.get("platform", "default")
            conversation_uid = self._conversation_id_generator()
            title = payload.get("title", "新的聊天...")
            workspace = payload.get("workspace", None)
            is_cron = payload.get("is_cron", False)

            await self._call_procedure("create_conversation", (user_uid, platform, conversation_uid, title, workspace, is_cron))
            return {
                "success": True,
                "messages": f"{conversation_uid}",
            }
        except Exception as e:
            logger.exception(f"[MysqlService][create_conversation] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.memo.update_conversation")
    async def update_conversation(self, payload: dict) -> dict:
        """
        Update a conversation record. Call procedure update_conversation.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "history_id": "{{ hid }} : to indicate which dialog history the data belong to.",
                "title": "Conversation title",
                "workspace": "Agent work dir",
                "is_pinned": bool,
                "is_deleted": bool,
                "has_new_message": bool
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or "conversation_uid",
            }
        """
        logger.info(f"[MysqlService][update_conversation] enter.")
        try:
            user_uid = payload["client_id"]
            conversation_uid = payload["history_id"]
            workspace = payload.get("workspace", None)
            title = payload.get("title", None)
            pinned = payload.get("is_pinned", None)
            is_deleted = payload.get("is_deleted", None)
            has_new_message = payload.get("has_new_message", None)
            await self._call_procedure(
                "update_conversation", 
                (user_uid, conversation_uid, title, workspace, pinned, is_deleted, has_new_message)
            )
            return {
                "success": True,
                "messages": f"{conversation_uid}",
            }
        except Exception as e:
            logger.exception(f"[MysqlService][update_conversation] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    # --------------------------------------------------
    # Messages
    # --------------------------------------------------

    @task_handler("mysql.memo.append_message")
    async def append_message(self, payload: dict) -> dict:
        """
        Persist a peice of message. Call procedure append_message.
        If len of messages list in payload is over one piece, only append the last one.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "history_id": "{{ hid }} : to indicate which dialog history the data belong to.",
                "messages": {
                    "role": 'human', 'ai', 'system', 'tool', 'info'
                    "content": "message content",
                    "think": "",
                    "extra": {...},
                    "info": {
                        "model": "...",
                        "total_duration": "...",
                        "model_provider": "...",
                        "total_tokens": int,
                        "id": "",
                    }, 
                    "node_id": str,
                    "parent_id": str,
                    "timestamp": int,
                }
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or dict,
            }
        """
        logger.info(f"[MysqlService][append_message] enter.")
        try:
            user_uid = payload["client_id"]
            conversation_id = payload["history_id"]
            messages = payload["messages"]
            
            if not messages:
                raise ValueError("[MysqlService][append_message] message is empty")
            
            role = messages["role"]
            content = messages["content"]
            think = messages.get("think", "")
            extra = messages.get("extra", {})
            info = messages.get("info", {})
            generation_id = messages.get("generation_id", "")
            node_id = messages.get("node_id", "")
            parent_id = messages.get("parent_id", "")
            timestamp = messages["timestamp"]

            if extra is None:
                extra = {}
            if not isinstance(extra, str):
                extra = json.dumps(extra, ensure_ascii=False)

            if info is None:
                info = {}
            if not isinstance(info, str):
                info = json.dumps(info, ensure_ascii=False)

            if not timestamp:
                raise ValueError("[MysqlService][append_message] message timestamp is empty")
                
            result = await self._call_procedure(
                "append_message", 
                (user_uid, conversation_id, role, content, think, extra, info, generation_id, node_id, parent_id, timestamp)
            )
            cursor =  result[0].get("msg_cursor", -1)
            created_at = result[0].get("created_at")
            if cursor == -1: raise ValueError("Invalid cursor the database returned.")
            return {
                "success": True,
                "messages": {
                    "msg_cursor": cursor,
                    "created_at": created_at
                }
            }
        except Exception as e:
            logger.exception(f"[MysqlService][append_message] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.memo.delete_messages")
    async def delete_messages(self, payload: dict) -> dict:
        """
        Persist a peice of message. Call procedure delete_messages.
        If len of messages list in payload is over one piece, only append the last one.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "history_id": "{{ hid }} : to indicate which dialog history the data belong to.",
                "messages": [  # list of message node_id
                    str, 
                    ...
                ]
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or list[dict],
            }
        """
        logger.info(f"[MysqlService][delete_messages] enter.")
        try:
            user_uid = payload["client_id"]
            conversation_id = payload["history_id"]
            messages = payload["messages"]
            
            if not messages:
                raise ValueError("[MysqlService][delete_messages] list is empty")
                
            msg_info = []
            for node_id in messages:
                res = await self._call_procedure("delete_messages_node", (user_uid, conversation_id, node_id))
                for row in res:
                    if not isinstance(row, dict):
                        continue
                    raw = row.get("info")
                    if isinstance(raw, str):
                        try:
                            parsed = json.loads(raw)
                        except Exception:
                            continue
                    elif isinstance(raw, dict):
                        parsed = raw
                    else:
                        continue

                    msg_info.append(parsed)
            
            return {
                "success": True,
                "messages": msg_info
            }
        except Exception as e:
            logger.exception(f"[MysqlService][delete_messages] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.memo.fetch_messages_after_cursor")
    async def fetch_messages_after_cursor(self, payload: dict) -> dict:
        """
        Get a batch of messages after cursor (include this cursor). Call procedure fetch_messages_after_cursor.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "history_id": "{{ hid }} : to indicate which dialog history the data belong to.",
                "cursor": int, // fetch messages with msg_cursor >= after_cursor
                "limit": int, // max number of messages to fetch
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or [...] (list of message dicts),
                "next_cursor": new cursor = latest_msg_cursor + 1.
            }
        """
        logger.info(f"[MysqlService][fetch_messages_after_cursor] enter.")
        try:
            user_uid = payload["client_id"]
            conversation_id = payload["history_id"]
            after_cursor = payload.get("cursor", 0)
            after_cursor = max(int(after_cursor), 0)
            limit = payload.get("limit", 65535)
            rows = await self._call_procedure("fetch_messages_after_cursor", (user_uid, conversation_id, after_cursor, limit))
            next_cursor = rows[-1].get('msg_cursor') + 1 if rows else after_cursor
            return {
                "success": True,
                "messages": rows,
                "next_cursor": next_cursor
            }
        except Exception as e:
            logger.exception(f"[MysqlService][fetch_messages_after_cursor] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.memo.fetch_messages_for_user")
    async def fetch_messages_for_user(self, payload: dict) -> dict:
        """
        Get all messages in one conversation. Call procedure fetch_messages_for_user.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "history_id": "{{ hid }} : to indicate which dialog history the data belong to.",
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or [...] (list of message dicts),
            }
        """
        logger.info(f"[MysqlService][fetch_messages_for_user] enter.")
        try:
            user_uid = payload["client_id"]
            conversation_id = payload["history_id"]
            rows = await self._call_procedure("fetch_messages_for_user", (user_uid, conversation_id))
            return {
                "success": True,
                "messages": rows,
            }
        except Exception as e:
            logger.exception(f"[MysqlService][fetch_messages_for_user] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        
    @task_handler("mysql.memo.search_messages_by_keyword")
    async def search_messages_by_keyword(self, payload: dict) -> dict:
        """
        Search messages in all conversations. Call procedure search_messages_by_keyword.

        Args:
            payload: Dict, the format is {
                "client_id": str,
                "keyword": str
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or [...] (list of result dicts),
            }

            Result dict format: {
                "conversation_uid": str,
                "generation_id": str,
                "role": str,
                "content": str,
                "title": str,
                "last_active_at": str
            }
        """
        logger.info("[MysqlService][search_messages_by_keyword] enter.")
        try:
            user_uid = payload["client_id"]
            keyword: str = payload["keyword"]

            # Ignore keywords that contain only %, _, \ and whitespace
            if not re.sub(r"[%_\\\s]+", "", keyword):
                return {
                    "success": True,
                    "messages": [],
                }

            # Normalize separators for SQL LIKE search
            keyword = re.sub(r"[_\\\s]+", "%", keyword)
            keyword = re.sub(r"%+", "%", keyword).strip("%")

            rows = await self._call_procedure("search_messages_by_keyword", (user_uid, keyword))

            return {
                "success": True,
                "messages": rows,
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][search_messages_by_keyword] [ERROR] Error: {type(e).__name__}: {e}"
            )
            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        
    # --------------------------------------------------
    # Files
    # --------------------------------------------------
    @task_handler("mysql.file.insert_file_info")
    async def insert_file_info(self, payload: dict) -> dict:
        """
        Insert one file's info uploaded by user. Call procedure insert_file_info.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "history_id": "{{ hid }} : Optional",
                "file_id": "Unique id for each file, Generated by file service.",
                "file_name": "File name user upload.",
                "file_path": "File store path in file service.",
                "mime_type": "File mime type such as pic, doc, txt...",
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or [...] (lists of files dict),
            }
        """
        logger.info(f"[MysqlService][insert_file_info] enter.")
        try:
            file_id = payload["file_id"]
            file_name = payload["file_name"]
            file_path = payload["file_path"]
            mime_type = payload.get("mime_type", '')
            user_uid = payload["client_id"]
            conversation_uid = payload.get("history_id", '')
            rows = await self._call_procedure(
                "insert_file_info", 
                (file_id, file_name, file_path, mime_type, user_uid, conversation_uid)
            )
            return {
                "success": True,
                "messages": rows,
            }
        except Exception as e:
            logger.exception(f"[MysqlService][insert_file_info] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        
    @task_handler("mysql.file.update_file_info")
    async def update_file_info(self, payload: dict) -> dict:
        """
        Update one file's info uploaded by user. Call procedure update_file_info.
        This method is only used to update delete mark at now. 

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "file_id": "Unique id for each file, Generated by file service.", 
                "is_deleted": bool,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or [...] (lists of files dict),
            }
        """
        logger.info(f"[MysqlService][update_file_info] enter.")
        try:
            user_uid = payload["client_id"]
            file_id = payload.get("file_id")
            is_deleted = payload.get("is_deleted")
            rows = await self._call_procedure("update_file_info", (file_id, user_uid, is_deleted))
            return {
                "success": True,
                "messages": rows,
            }
        except Exception as e:
            logger.exception(f"[MysqlService][update_file_info] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        
    @task_handler("mysql.file.fetch_recent_files")
    async def fetch_recent_files(self, payload: dict) -> dict:
        """
        Get a batch of recent files user upload. Call procedure fetch_recent_files.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "limit": int, // max number of messages to fetch
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or [...] (lists of files dict),
            }
        """
        logger.info(f"[MysqlService][fetch_recent_files] enter.")
        try:
            user_uid = payload["client_id"]
            limit = payload.get("limit", 10)
            rows = await self._call_procedure("fetch_recent_files", (user_uid, limit))
            return {
                "success": True,
                "messages": rows,
            }
        except Exception as e:
            logger.exception(f"[MysqlService][fetch_recent_files] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        
    # --------------------------------------------------
    # Short-term Memory 
    # --------------------------------------------------

    @task_handler("mysql.memo.fetch_shortterm_memory")
    async def fetch_shortterm_memory(self, payload: dict) -> dict:
        """
        Get a batch of memories. Call procedure fetch_shortterm_memory.

        Args:
            payload: Dict, the format is {
                "client_id": "{{ cid }} : to indicate which user the data is from.",
                "history_id": "{{ hid }} : to indicate which dialog history the data belong to.",
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or [...] (list of message dicts),
            }

        NOTE:
        message dicts format:
            "messages": [
                {
                    "memory_id": str,
                    "content": str,
                    "created_timestamp": int,
                }
            ]
        """
        logger.info(f"[MysqlService][fetch_shortterm_memory] enter.")
        try:
            user_uid = payload["client_id"]
            conversation_uid = payload["history_id"]
            rows = await self._call_procedure("fetch_shortterm_memory", (user_uid, conversation_uid))
            return {
                "success": True,
                "messages": rows,
            }
        except Exception as e:
            logger.exception(f"[MysqlService][fetch_shortterm_memory] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.memo.insert_shortterm_memory")
    async def insert_shortterm_memory(self, payload: dict) -> dict:
        """
        Get a batch of memories. Call procedure insert_shortterm_memory.

        Args:
            payload: Dict, the format is {
                "memory_id": str, // Message's id generated by langChain (task_id in tool massage or id in ai message)
                "client_id": "{{ cid }} : to indicate which user the data is from.",,
                "history_id": "{{ hid }} : to indicate which dialog history the data belong to.",
                "content": str,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or "success",
            }
        """
        logger.info(f"[MysqlService][insert_shortterm_memory] enter.")
        try:
            memory_id = payload["memory_id"]
            user_uid = payload["client_id"]
            conversation_uid = payload["history_id"]
            content = payload["content"]
            created_timestamp = int(time.time() * 1_000_000)
            await self._call_procedure("insert_shortterm_memory", (memory_id, user_uid, conversation_uid, content, created_timestamp))
            return {
                "success": True,
                "messages": "success",
            }
        except Exception as e:
            logger.exception(f"[MysqlService][insert_shortterm_memory] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.memo.delete_shortterm_memory")
    async def delete_shortterm_memory(self, payload: dict) -> dict:
        """
        Get a batch of memories. Call procedure delete_shortterm_memory.

        Args:
            payload: Dict, the format is {
                "memory_ids": list[str], // Message's id generated by langChain (task_id in tool massage or id in ai message)
                "client_id": "{{ cid }} : to indicate which user the data is from.",,
                "history_id": "{{ hid }} : to indicate which dialog history the data belong to.",
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or "success",
            }
        """
        logger.info(f"[MysqlService][delete_shortterm_memory] enter.")
        try:
            memory_id = payload["memory_id"]
            user_uid = payload["client_id"]
            conversation_uid = payload["history_id"]
            await self._call_procedure("delete_shortterm_memory", (json.dumps(memory_id), user_uid, conversation_uid))
            return {
                "success": True,
                "messages": "success",
            }
        except Exception as e:
            logger.exception(f"[MysqlService][delete_shortterm_memory] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        
    # --------------------------------------------------
    # Custom Provider 
    # --------------------------------------------------

    @task_handler("mysql.provider.create_llm_provider")
    async def create_llm_provider(self, payload: dict) -> dict:
        """
        Insert a llm provider meta in database. Call procedure create_llm_provider.

        Args:
            payload: Dict, the format is {
                "provider_id": str, # provider's unique id (uuid4)
                "client_id": str, # to indicate which user the data is from
                "provider_name": str, # provider's name, not null
                "type": str, # provider's protocol, default openai
                "endpoint": str, # provider's endpoint, not null
                "model_list": str, # provider's model list, not null
                "description": str, # description for provider, default null
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or dict {"provider_id": str},
            }
        """
        logger.info(f"[MysqlService][create_llm_provider] enter.")
        try:
            provider_id = payload["provider_id"]
            user_uid = payload["client_id"]
            provider_name = payload["provider_name"]
            provider_type = (payload.get("type", "openai") or "openai").lower()
            endpoint = payload["endpoint"]
            model_list = payload["model_list"]
            description = payload.get("description")
            await self._call_procedure(
                "create_llm_provider", 
                (provider_id, user_uid, provider_name, provider_type, endpoint, json.dumps(model_list), description)
            )
            return {
                "success": True,
                "messages": {
                    "provider_id": provider_id
                },
            }
        except Exception as e:
            logger.exception(f"[MysqlService][create_llm_provider] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.provider.get_llm_providers")
    async def get_llm_providers(self, payload: dict) -> dict:
        """
        Get all llm provider meta in database. Call procedure get_llm_providers.

        Args:
            payload: Dict, the format is {
                "client_id": str, # to indicate which user the request from
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or list [
                    {
                        "provider_id": str,
                        "provider_name": str,
                        "type": str,
                        "endpoint": str,
                        "model_list": list,
                        "description": str,
                        "created_at": str
                    },
                    ...
                ],
            }
        """
        logger.info(f"[MysqlService][get_llm_providers] enter.")
        try:
            user_uid = payload["client_id"]
            rows = await self._call_procedure("get_llm_providers", (user_uid, ))
            return {
                "success": True,
                "messages": rows,
            }
        except Exception as e:
            logger.exception(f"[MysqlService][get_llm_providers] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.provider.get_llm_provider_by_id")
    async def get_llm_provider_by_id(self, payload: dict) -> dict:
        """
        Get a llm provider meta in database. Call procedure get_llm_provider_by_id.

        Args:
            payload: Dict, the format is {
                "provider_id": str, # provider's unique id (uuid4)
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or list [
                    {
                        "provider_id": str,
                        "provider_name": str,
                        "type": str,
                        "endpoint": str,
                        "model_list": list,
                        "description": str,
                        "created_at": str
                    }
                ],
            }
        """
        logger.info(f"[MysqlService][get_llm_provider_by_id] enter.")
        try:
            provider_id = payload["provider_id"]
            rows = await self._call_procedure("get_llm_provider_by_id", (provider_id, ))
            return {
                "success": True,
                "messages": rows,
            }
        except Exception as e:
            logger.exception(f"[MysqlService][get_llm_provider_by_id] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }

    @task_handler("mysql.provider.update_llm_provider")
    async def update_llm_provider(self, payload: dict) -> dict:
        """
        Update a llm provider meta in database, include is_deleted status. Call procedure update_llm_provider.

        Args:
            payload: Dict, the format is {
                "provider_id": str, # provider's unique id (uuid4)
                "client_id": str, # to indicate which user the data is from
                "provider_name": str, # Optional, provider's name
                "type": str, # Optional, provider's protocol
                "endpoint": str, # Optional, provider's endpoint
                "model_list": str, # Optional, provider's model list
                "description": str, # Optional, description for provider
                "is_deleted": bool, # Optional, delete if true
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or "success",
            }
        """
        logger.info(f"[MysqlService][update_llm_provider] enter.")
        try:
            provider_id = payload["provider_id"]
            user_uid = payload["client_id"]
            provider_name = payload.get("provider_name")
            provider_type = payload.get("type")
            if isinstance(provider_type, str):
                provider_type = provider_type.lower()
            endpoint = payload.get("endpoint")
            model_list = payload.get("model_list")
            if isinstance(model_list, list):
                model_list = json.dumps(model_list)
            description = payload.get("description")
            is_deleted = payload.get("is_deleted")
            await self._call_procedure(
                "update_llm_provider", 
                (provider_id, user_uid, provider_name, provider_type, endpoint, model_list, description, is_deleted)
            )
            return {
                "success": True,
                "messages": 'success',
            }
        except Exception as e:
            logger.exception(f"[MysqlService][update_llm_provider] [ERROR] Error: {type(e).__name__}: {e}")
            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        
    # --------------------------------------------------
    # MCP Server
    # --------------------------------------------------

    @task_handler("mysql.mcp.create_mcp_server")
    async def create_mcp_server(self, payload: dict) -> dict:
        """
        Insert a mcp server meta in database. Call procedure create_mcp_server.

        Args:
            payload: Dict, the format is {
                "mcp_id": str,
                "client_id": str,
                "mcp_name": str,
                "transport": str,
                "endpoint": str,
                "config": dict,
                "description": str,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or {
                    "mcp_id": str
                },
            }
        """
        logger.info("[MysqlService][create_mcp_server] enter.")

        try:
            mcp_id = payload["mcp_id"]
            user_uid = payload["client_id"]
            mcp_name = payload["mcp_name"]
            transport = payload["transport"]
            endpoint = payload["endpoint"]
            config = payload.get("config", {})
            description = payload.get("description")

            await self._call_procedure(
                "create_mcp_server",
                (mcp_id, user_uid, mcp_name, transport, endpoint, json.dumps(config), description,),
            )

            return {
                "success": True,
                "messages": {
                    "mcp_id": mcp_id,
                },
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][create_mcp_server] [ERROR] Error: {type(e).__name__}: {e}"
            )

            return {
                "success": False,
                "messages": f"fail: {e}",
            }


    @task_handler("mysql.mcp.get_mcp_servers")
    async def get_mcp_servers(self, payload: dict) -> dict:
        """
        Get all mcp servers in database. Call procedure get_mcp_servers.

        Args:
            payload: Dict, the format is {
                "client_id": str,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or list
            }
        """
        logger.info("[MysqlService][get_mcp_servers] enter.")

        try:
            user_uid = payload["client_id"]

            rows = await self._call_procedure("get_mcp_servers", (user_uid,),)

            return {
                "success": True,
                "messages": rows,
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][get_mcp_servers] [ERROR] Error: {type(e).__name__}: {e}"
            )

            return {
                "success": False,
                "messages": f"fail: {e}",
            }


    @task_handler("mysql.mcp.get_enabled_mcp_servers")
    async def get_enabled_mcp_servers(self, payload: dict) -> dict:
        """
        Get enabled mcp servers in database. Call procedure get_enabled_mcp_servers.

        Args:
            payload: Dict, the format is {
                "client_id": str,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or list
            }
        """
        logger.info("[MysqlService][get_enabled_mcp_servers] enter.")

        try:
            user_uid = payload["client_id"]

            rows = await self._call_procedure("get_enabled_mcp_servers", (user_uid,),)

            return {
                "success": True,
                "messages": rows,
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][get_enabled_mcp_servers] [ERROR] Error: {type(e).__name__}: {e}"
            )

            return {
                "success": False,
                "messages": f"fail: {e}",
            }


    @task_handler("mysql.mcp.update_mcp_server")
    async def update_mcp_server(self, payload: dict) -> dict:
        """
        Update a mcp server meta in database. Call procedure update_mcp_server.

        Args:
            payload: Dict, the format is {
                "mcp_id": str,
                "client_id": str,

                "mcp_name": str,
                "transport": str,
                "endpoint": str,
                "config": dict,
                "description": str,

                "enabled": bool,
                "tool_count": int,

                "is_deleted": bool,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "success" or "fail: {e}"
            }
        """
        logger.info("[MysqlService][update_mcp_server] enter.")

        try:
            mcp_id = payload["mcp_id"]
            user_uid = payload["client_id"]

            mcp_name = payload.get("mcp_name")
            transport = payload.get("transport")
            endpoint = payload.get("endpoint")

            config = payload.get("config")
            if isinstance(config, (dict, list)):
                config = json.dumps(config)

            description = payload.get("description")

            enabled = payload.get("enabled")
            tool_count = payload.get("tool_count")

            is_deleted = payload.get("is_deleted")

            await self._call_procedure(
                "update_mcp_server",
                ( mcp_id, user_uid, mcp_name, transport, endpoint, config, description, enabled, tool_count, is_deleted,),
            )

            return {
                "success": True,
                "messages": "success",
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][update_mcp_server] [ERROR] Error: {type(e).__name__}: {e}"
            )

            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        

    @task_handler("mysql.cron.create_cron_task")
    async def create_cron_task(self, payload: dict) -> dict:
        """
        Create a cron task in database. Call procedure create_cron_task.

        Args:
            payload: Dict, the format is {
                "task_id": str,
                "client_id": str,
                "conversation_id": str,
                "platform": str,
                "task_name": str,
                "prompt": str,
                "execute": str,
                "exec_time": str, # ISO-8601
                "repeat": Literal["once", "day", "week", "month", "year"],
                "extra_config": dict,
                "description": str,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or {
                    "task_id": str
                }
            }
        """
        logger.info("[MysqlService][create_cron_task] enter.")

        try:
            task_id = payload["task_id"]
            user_uid = payload["client_id"]
            conversation_id = payload.get("history_id")
            platform = payload.get("platform")
            task_name = payload.get("task_name")
            task_prompt = payload.get("prompt")
            execute_code = payload.get("execute")
            execute_time = payload.get("exec_time")
            repeat = payload.get("repeat")
            extra_config = payload.get("extra_config", {})
            description = payload.get("description", "")
            
            if extra_config is None:
                extra_config = {}
            if not isinstance(extra_config, str):
                extra_config = json.dumps(extra_config, ensure_ascii=False)

            await self._call_procedure(
                "create_cron_task",
                (task_id, user_uid, conversation_id, platform, task_name, task_prompt, execute_code, execute_time, repeat, extra_config, description,),
            )

            return {
                "success": True,
                "messages": {
                    "task_id": task_id
                },
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][create_cron_task] [ERROR] Error: {type(e).__name__}: {e}"
            )

            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        

    async def get_all_enabled_cron_tasks(self, payload: dict) -> dict:
        """
        Get all cron tasks in database. Call procedure get_all_enabled_cron_tasks.

        Args:
            payload: Dict, the format is { }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or list
            }
        """
        logger.info("[MysqlService][get_all_enabled_cron_tasks] enter.")

        try:
            rows = await self._call_procedure("get_all_enabled_cron_tasks", (),)

            return {
                "success": True,
                "messages": rows,
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][get_all_enabled_cron_tasks] [ERROR] Error: {type(e).__name__}: {e}"
            )

            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        

    async def get_cron_tasks(self, payload: dict) -> dict:
        """
        Get all cron tasks in database. Call procedure get_cron_tasks.

        Args:
            payload: Dict, the format is {
                "client_id": str,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or list
            }
        """
        logger.info("[MysqlService][get_cron_tasks] enter.")

        try:
            user_uid = payload["client_id"]

            rows = await self._call_procedure("get_cron_tasks", (user_uid,),)

            return {
                "success": True,
                "messages": rows,
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][get_cron_tasks] [ERROR] Error: {type(e).__name__}: {e}"
            )

            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        

    async def get_cron_task_by_id(self, payload: dict) -> dict:
        """
        Get a cron task in database. Call procedure get_cron_task_by_id.

        Args:
            payload: Dict, the format is {
                "task_id": str,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or list
            }
        """
        logger.info("[MysqlService][get_cron_task_by_id] enter.")

        try:
            task_id = payload["task_id"]

            rows = await self._call_procedure("get_cron_task_by_id", (task_id,),)

            return {
                "success": True,
                "messages": rows,
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][get_cron_task_by_id] [ERROR] Error: {type(e).__name__}: {e}"
            )

            return {
                "success": False,
                "messages": f"fail: {e}",
            }
        
    async def update_cron_task(self, payload: dict) -> dict:
        """
        Update a cron task in database. Call procedure update_cron_task.

        Args:
            payload: Dict, the format is {
                "task_id": str,
                "conversation_id": str,
                "platform": str,
                "task_name": str,
                "prompt": str,
                "execute": str,
                "exec_time": str, # ISO-8601
                "repeat": Literal["once", "day", "week", "month", "year"],
                "extra_config": dict,
                "description": str,
                "is_deleted": bool,
            }

        Return:
            dict, the format is {
                "success": True / False,
                "messages": "fail: {e}" or "success"
            }
        """
        logger.info("[MysqlService][update_cron_task] enter.")

        try:
            task_id = payload["task_id"]
            conversation_id = payload.get("history_id")
            platform = payload.get("platform")
            task_name = payload.get("task_name")
            task_prompt = payload.get("prompt")
            execute_code = payload.get("execute")
            execute_time = payload.get("exec_time")
            repeat = payload.get("repeat")
            extra_config = payload.get("extra_config")
            description = payload.get("description")
            enabled = payload.get("enabled")
            is_deleted = payload.get("is_deleted")

            if isinstance(extra_config, (dict, list)):
                extra_config = json.dumps(extra_config)

            await self._call_procedure(
                "update_cron_task",
                (task_id, conversation_id, platform, task_name, task_prompt, execute_code, execute_time, repeat, extra_config, description, enabled, is_deleted,),
            )

            return {
                "success": True,
                "messages": "success",
            }

        except Exception as e:
            logger.exception(
                f"[MysqlService][update_cron_task] [ERROR] Error: {type(e).__name__}: {e}"
            )

            return {
                "success": False,
                "messages": f"fail: {e}",
            }



mysql_server = MysqlService(
    host=MYSQL_DOCKER_BASE_URL,
    port=MYSQL_DOCKER_PORT,
    user=MYSQL_USER,
    password=MYSQL_PASSWORD,
    database=MYSQL_DATABASE,
    charset=MYSQL_CHARSET,
)
