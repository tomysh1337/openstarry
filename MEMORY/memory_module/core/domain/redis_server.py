import inspect
from typing import Callable, Dict

from core.commons.decorator import task_handler


class RedisService:
    """Small in-process cache used by the integrated desktop application."""

    def __init__(self, *_args, **_kwargs):
        self._messages = {}
        self._chains = {}

    async def _close(self):
        self._messages.clear()
        self._chains.clear()

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
    def _key(payload):
        client_id = payload.get("client_id")
        history_id = payload.get("history_id")
        if not client_id or not history_id:
            raise KeyError("client_id and history_id are required")
        return client_id, history_id

    @task_handler("redis.memo.append_messages")
    async def append_messages(self, payload: dict) -> dict:
        key = self._key(payload)
        if key in self._messages:
            self._messages[key].append(payload.get("messages", {}))
        return {"success": True, "messages": "success"}

    @task_handler("redis.memo.backfill_messages")
    async def backfill_messages(self, payload: dict) -> dict:
        messages = payload.get("messages", [])
        if not isinstance(messages, list):
            return {"success": False, "messages": "fail: messages must be a list"}
        self._messages[self._key(payload)] = list(messages)
        return {"success": True, "messages": "success"}

    @task_handler("redis.memo.get_recent_messages")
    async def get_recent_messages(self, payload: dict) -> dict:
        key = self._key(payload)
        if key not in self._messages:
            return {"success": True, "messages": [], "cache_hit": False}
        return {"success": True, "messages": list(self._messages[key]), "cache_hit": True}

    @task_handler("redis.memo.cache_current_messages_branch_chain")
    async def cache_current_messages_branch_chain(self, payload: dict) -> dict:
        chain = payload.get("node_id_chain", [])
        if not isinstance(chain, list):
            return {"success": False, "messages": "fail: node_id_chain must be a list"}
        self._chains[self._key(payload)] = list(chain)
        return {"success": True, "messages": "success"}

    @task_handler("redis.memo.update_current_messages_branch_chain_cache")
    async def update_current_messages_branch_chain_cache(self, payload: dict) -> dict:
        key = self._key(payload)
        chain = self._chains.get(key)
        if not chain:
            return {"success": True, "messages": "cache not found"}
        parent_id = payload.get("parent_id")
        node_id = payload.get("node_id")
        if parent_id not in chain:
            return {"success": True, "messages": "parent_id not found in cache"}
        index = chain.index(parent_id)
        self._chains[key] = chain[:index + 1] + [node_id]
        return {"success": True, "messages": "success"}

    @task_handler("redis.memo.get_current_messages_branch_chain")
    async def get_current_messages_branch_chain(self, payload: dict) -> dict:
        key = self._key(payload)
        if key not in self._chains:
            return {"success": True, "messages": [], "cache_hit": False}
        return {"success": True, "messages": list(self._chains[key]), "cache_hit": True}

    @task_handler("redis.common.set_expire")
    async def set_expire(self, _payload: dict, ttl_seconds: int = 0) -> dict:
        return {"success": True, "messages": "success"}

    @task_handler("redis.common.expire_immediately")
    async def expire_immediately(self, payload: dict) -> dict:
        key = self._key(payload)
        self._messages.pop(key, None)
        self._chains.pop(key, None)
        return {"success": True, "messages": "success"}


redis_server = RedisService()
