"""Run delegation through real LangGraph nodes, queues and task state transitions.

Only model responses and external service dependencies are fixtures.
"""

import asyncio
import copy
import importlib
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessageChunk, HumanMessage, SystemMessage
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, MessagesState, StateGraph


ROOT = Path(os.environ.get("OPENSTARRY_AGENT_SOURCE", Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(ROOT))
PREFIX = "openstarry_agent."


def module(name, **attributes):
    result = ModuleType(PREFIX + name)
    result.__dict__.update(attributes)
    return result


context = MagicMock()
for name in ("create_workspace_prompt", "create_memorandum_prompt", "create_todo_prompt"):
    getattr(context, name).return_value = ""
context.create_system_prompt_list.return_value = []
context.create_role_prompt_list.return_value = []
creator = SimpleNamespace(create_sub_agent=AsyncMock(), done=AsyncMock())
adapter = SimpleNamespace()
stubs = {
    PREFIX + name: module(name, **values)
    for name, values in {
        "commons.logger": {"logger": MagicMock()},
        "commons.auto_init": {"auto_init": MagicMock()},
        "commons.common_func": {
            "get_date_natural_language": lambda: "Fixture date",
            "convert_generation_id_to_message_node_id": lambda *args: "fixture-node",
        },
        "global_config": {"MAX_RETRY": 8},
        "openstarry_agent_core.tools.registry": {"conflict_tool_set": set()},
        "openstarry_agent_core.LLM.llm_adapter": {"LlmNodeAdapter": adapter},
        "openstarry_agent_core.sandbox_manager.agent_sandbox_manager": {"agent_sandbox": MagicMock()},
        "openstarry_agent_core.context_manager.context_process": {"ai_context_manager": context},
        "openstarry_agent_core.agent_factory.agent_creator": {"agent_creator": creator},
    }.items()
}
for name in ("openstarry_agent_core.tools", "openstarry_agent_core.agent_factory.agent_node"):
    package = module(name)
    package.__path__ = [str(ROOT / "openstarry_agent" / name.replace(".", "/"))]
    stubs[PREFIX + name] = package

with patch.dict(sys.modules, stubs):
    tools = importlib.import_module(PREFIX + "openstarry_agent_core.tools.assistant.call_assistant")
    task_module = importlib.import_module(PREFIX + "openstarry_agent_core.agent_task.team_task_manager")
    runtime_module = importlib.import_module(PREFIX + "openstarry_agent_core.agent")
    main_module = importlib.import_module(PREFIX + "openstarry_agent_core.agent_factory.agent_node.main_agent_node")
    tool_node = importlib.import_module(PREFIX + "openstarry_agent_core.tools.tool_node")
    MainAgentState = importlib.import_module(PREFIX + "commons.type_def").MainAgentState

PROMISE = "好的！我先把任务委派给子代理去定位和修复 bug："


def assignment(name="Fixture worker", call_id="assign-fixture"):
    return {
        "name": "assign_sub_assistant", "id": call_id, "type": "tool_call",
        "args": {
            "agent_identity": name, "system_prompt": "Fixture worker instructions",
            "task_description": "Calculate 2 + 2", "instruction": "Return 4; do not use tools.",
        },
    }


class SubagentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.manager = task_module.team_task_manager
        self.manager.__init__()
        self.events = []

        async def event(**kwargs):
            self.events.append(kwargs)

        self.event_patch = patch.object(task_module, "event_pipe", SimpleNamespace(post_event=event))
        self.event_patch.start()
        self.addCleanup(self.event_patch.stop)
        creator.create_sub_agent.reset_mock()
        creator.done.reset_mock()
        self.inputs = []
        self.stream_events = []
        self.stream_patch = patch.object(tools, "AgentStreamWriter", lambda _: SimpleNamespace(
            send_event=lambda **entry: self.stream_events.append(entry)
        ))
        self.stream_patch.start()
        self.addCleanup(self.stream_patch.stop)

    def state(self):
        return {
            "agent_role": "main_agent", "agent_name": "Parent", "generation_id": "fixture-generation",
            "history_id": "fixture-history", "client_id": "fixture-client",
            "target": {"id": "fixture-client", "platform": "fixture", "conversation_id": "fixture-history"},
            "messages": [HumanMessage(content="请派一个子代理计算 2 + 2")],
            "config": {"role_prompt": {"name": "Parent", "definition": "Parent instructions"},
                       "enable_agent_assign": True, "llm_calls_warning_threshold": 999},
            "loaded_skills_cache": [], "llm_calls": 0, "llm_retry_count": 0,
        }

    async def run_leader(self, responses, state=None, tool_names=None):
        async def stream(**kwargs):
            self.inputs.append(kwargs["input"])
            yield copy.deepcopy(responses[min(len(self.inputs) - 1, len(responses) - 1)])

        adapter.astream = stream
        node = main_module.MainAgentNode(None, tool_names if tool_names is not None else ["assign_sub_assistant"])
        builder = StateGraph(MainAgentState)
        builder.add_node("llm", node.llm_call)
        builder.add_node("tools", tool_node.OpenStarryToolNode([tools.assign_sub_assistant]))
        builder.add_edge(START, "llm")

        async def route(state):
            result = await node.route_after_llm(state)
            return "llm" if result == "retry" else node.should_continue(state)

        builder.add_conditional_edges("llm", route, {"llm": "llm", "tools": "tools", END: END})
        builder.add_edge("tools", END)
        return await builder.compile().ainvoke(state or self.state(), {"recursion_limit": 12})

    async def test_unexecuted_promise_retries_then_submits_real_task(self):
        result = await self.run_leader([
            AIMessageChunk(content=PROMISE),
            AIMessageChunk(content="", tool_calls=[assignment()]),
        ])
        self.assertEqual(len(self.inputs), 2)
        self.assertTrue(any(isinstance(msg, SystemMessage) and "assign_sub_assistant" in msg.content
                            for msg in self.inputs[1]))
        self.assertEqual(self.manager.task_queue.qsize(), 1)
        message = result["messages"][-1]
        self.assertEqual(message.status, "success", message.content)
        self.assertIn("Task id:", message.content)
        self.assertTrue(any(item["data"]["event_name"] == "on_team_task_task_submitted" for item in self.events))
        task_id = next(iter(self.manager.task_generation))
        self.assertTrue(any(task_id in item["data"].get("content", "") for item in self.stream_events))

    async def test_repeated_promise_stops_after_one_retry_and_reports_no_task(self):
        result = await self.run_leader([AIMessageChunk(content=PROMISE)])
        self.assertEqual(len(self.inputs), 2)
        self.assertIn("子代理尚未启动", result["messages"][-1].content)
        self.assertEqual(self.manager.task_queue.qsize(), 0)

    async def test_retry_without_tool_call_cannot_claim_success_with_different_wording(self):
        result = await self.run_leader([
            AIMessageChunk(content=PROMISE), AIMessageChunk(content="任务已经安排好了。")
        ])
        self.assertEqual(len(self.inputs), 2)
        self.assertIn("子代理尚未启动", result["messages"][-1].content)
        self.assertEqual(self.manager.task_queue.qsize(), 0)

    async def test_explanations_disabled_tools_and_existing_calls_do_not_retry(self):
        cases = [
            ("子代理可以执行独立任务。", self.state(), ["assign_sub_assistant"]),
            ("我不能启动子代理，当前权限不允许。", self.state(), ["assign_sub_assistant"]),
            ("示例：\n```text\n" + PROMISE + "\n```", self.state(), ["assign_sub_assistant"]),
            (PROMISE, self.state(), []),
        ]
        prior = self.state()
        prior["messages"].append(AIMessageChunk(content="", tool_calls=[assignment()]))
        cases.append((PROMISE, prior, ["assign_sub_assistant"]))
        for text, state, names in cases:
            with self.subTest(text=text, names=names):
                self.inputs.clear()
                await self.run_leader([AIMessageChunk(content=text)], state, names)
                self.assertEqual(len(self.inputs), 1)

    async def test_assignment_keeps_parent_and_sibling_configs_independent(self):
        state = self.state()
        original_config = copy.deepcopy(state["config"])
        await self.run_leader([AIMessageChunk(content="", tool_calls=[assignment()])], state)
        _, first, first_config = await self.manager.task_queue.get()
        self.assertEqual(state["config"], original_config)
        self.assertEqual(first_config["role_prompt"]["name"], "Fixture worker")
        await self.run_leader([AIMessageChunk(content="", tool_calls=[assignment("Second worker", "second")])], state)
        _, second, second_config = await self.manager.task_queue.get()
        self.assertEqual(first_config["role_prompt"]["name"], "Fixture worker")
        self.assertEqual(second_config["role_prompt"]["name"], "Second worker")
        self.assertIs(first["config"], first_config)
        self.assertIs(second["config"], second_config)

    async def test_creation_failure_marks_task_failed_instead_of_leaving_pending(self):
        await self.run_leader([AIMessageChunk(content="", tool_calls=[assignment()])])
        name, state, config = await self.manager.task_queue.get()
        creator.create_sub_agent.return_value = "Fixture provider unavailable"
        runtime = runtime_module.AgentRuningtime()
        await runtime._run_sub_agent(name, state, config)
        result = (await self.manager.query_tasks(state["history_id"], [state["task_id"]]))[0]
        self.assertEqual(result["status"], "failed")
        self.assertIn("Fixture provider unavailable", result["errors"])
        creator.done.assert_not_awaited()
        self.assertTrue(any(item["data"]["event_name"] == "on_team_task_failed" for item in self.events))

    async def test_submitted_task_runs_through_worker_and_reports_completion(self):
        async def work(state):
            get_stream_writer()({"event": "ai_message_return", "data": {
                "event_name": "output_chunk_rtn", "content": "4"
            }})
            return {}

        child = StateGraph(MessagesState)
        child.add_node("work", work)
        child.add_edge(START, "work")
        child.add_edge("work", END)
        creator.create_sub_agent.return_value = child.compile()
        finished = asyncio.Event()

        async def event(**kwargs):
            self.events.append(kwargs)
            if kwargs["data"]["event_name"] == "on_team_task_completed":
                finished.set()

        task_module.event_pipe.post_event = event
        runtime = runtime_module.AgentRuningtime()
        await runtime.start()
        try:
            await self.run_leader([AIMessageChunk(content="", tool_calls=[assignment()])])
            await asyncio.wait_for(finished.wait(), 3)
            result = (await self.manager.query_all_tasks())[0]
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["outputs"], "4")
            names = [item["data"]["event_name"] for item in self.events]
            self.assertLess(names.index("on_team_task_task_submitted"), names.index("on_team_task_in_progress"))
            self.assertLess(names.index("on_team_task_in_progress"), names.index("on_team_task_completed"))
        finally:
            await runtime.stop()


if __name__ == "__main__":
    unittest.main()
