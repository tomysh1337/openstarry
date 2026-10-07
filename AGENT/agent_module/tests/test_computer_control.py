"""Exercise the real tool node without starting services or controlling a desktop.

Run with: python -m unittest discover -s tests -p test_computer_control.py -v
"""

import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx
from langchain_core.messages import AIMessage
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.graph import END, START, MessagesState, StateGraph


TOOLS = (
    Path(os.environ.get("OPENSTARRY_AGENT_SOURCE", Path(__file__).resolve().parents[1]))
    / "openstarry_agent/openstarry_agent_core/tools"
)


def load_module(name, path):
    # Import leaf modules directly to avoid the application's service bootstrap.
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


computer_control = load_module(
    "computer_control_under_test",
    os.environ.get(
        "OPENSTARRY_COMPUTER_TOOL_FILE", TOOLS / "basic_tools/computer_control.py"
    ),
)
OpenStarryToolNode = load_module(
    "tool_node_under_test", TOOLS / "tool_node.py"
).OpenStarryToolNode


class ComputerControlTests(unittest.IsolatedAsyncioTestCase):
    async def invoke_tool(self, arguments, *, status_code=200, body=None):
        requests = []

        def handle(request):
            requests.append(request)
            return httpx.Response(
                status_code,
                json=body if body is not None else {
                    "success": True, "result": {"fixture": True}
                },
            )

        client_class = httpx.AsyncClient

        def client(**kwargs):
            return client_class(transport=httpx.MockTransport(handle), **kwargs)

        builder = StateGraph(MessagesState)
        builder.add_node("tools", OpenStarryToolNode([computer_control.control_computer]))
        builder.add_edge(START, "tools")
        builder.add_edge("tools", END)
        graph = builder.compile()
        call = {
            "name": "control_computer", "args": arguments,
            "id": "computer-test", "type": "tool_call",
        }
        with patch.dict(os.environ, {
            "OPENSTARRY_COMPUTER_BRIDGE": "http://computer-bridge.invalid",
            "OPENSTARRY_BRIDGE_TOKEN": "fixture-token",
        }), patch.object(computer_control.httpx, "AsyncClient", side_effect=client):
            result = await graph.ainvoke({
                "messages": [AIMessage(content="", tool_calls=[call])]
            })
        message = result["messages"][-1]
        self.assertEqual(message.tool_call_id, call["id"])
        return message, requests

    def test_model_schema_preserves_action_args_and_hides_injected_fields(self):
        schema = convert_to_openai_tool(computer_control.control_computer)
        parameters = schema["function"]["parameters"]
        self.assertEqual(
            set(parameters["properties"]),
            {"action", "args", "irreversible", "description"},
        )
        self.assertEqual(parameters["required"], ["action"])

    async def test_list_apps_without_args_reaches_bridge(self):
        message, requests = await self.invoke_tool({"action": "list_apps"})
        self.assertEqual(message.status, "success", message.content)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url, "http://computer-bridge.invalid/action")
        self.assertEqual(requests[0].headers["x-openstarry-token"], "fixture-token")
        self.assertEqual(json.loads(requests[0].content), {
            "action": "list_apps", "args": {},
            "options": {"irreversible": False, "description": ""},
        })

    async def test_action_arguments_and_approval_options_survive_tool_node(self):
        arguments = {
            "action": "click", "args": {"window_id": "fixture", "x": 12, "y": 34},
            "irreversible": True, "description": "Fixture approval request",
        }
        message, requests = await self.invoke_tool(arguments)
        self.assertEqual(message.status, "success", message.content)
        self.assertEqual(len(requests), 1)
        self.assertEqual(json.loads(requests[0].content), {
            "action": arguments["action"], "args": arguments["args"],
            "options": {"irreversible": True, "description": arguments["description"]},
        })

    async def test_explicit_null_args_use_empty_object(self):
        message, requests = await self.invoke_tool({"action": "list_windows", "args": None})
        self.assertEqual(message.status, "success", message.content)
        self.assertEqual(json.loads(requests[0].content)["args"], {})

    async def test_invalid_args_do_not_reach_bridge(self):
        message, requests = await self.invoke_tool({"action": "click", "args": "invalid"})
        self.assertEqual(message.status, "error")
        self.assertIn("valid dictionary", message.content)
        self.assertEqual(requests, [])

    async def test_bridge_rejection_remains_tool_error(self):
        message, requests = await self.invoke_tool(
            {"action": "list_apps"},
            body={"success": False, "error": "Fixture approval declined"},
        )
        self.assertEqual(len(requests), 1)
        self.assertEqual(message.status, "error")
        self.assertIn("Fixture approval declined", message.content)

    async def test_http_failure_remains_tool_error(self):
        message, requests = await self.invoke_tool({"action": "list_apps"}, status_code=401)
        self.assertEqual(len(requests), 1)
        self.assertEqual(message.status, "error")
        self.assertIn("401", message.content)


if __name__ == "__main__":
    unittest.main()
