import os
from typing import Annotated, Any

import httpx
from langchain.tools import tool, InjectedToolCallId
from langgraph.prebuilt import InjectedState
from langgraph.types import Command
from langchain_core.messages import ToolMessage


@tool(description="""Control Windows desktop applications and browsers through OpenStarry NextGen.
Use this when the user asks to operate the computer or when completing the task requires visible UI interaction.
Supported actions: list_apps, list_windows, get_window, launch_app, get_window_state,
activate_window, click, press_key, type_text, scroll, set_value, drag, perform_secondary_action.
Set irreversible=true for payments, permanent deletion, external sending, account changes, or system settings.""")
async def control_computer(
    action: str,
    args: dict[str, Any] | None = None,
    irreversible: bool = False,
    description: str = "",
    state: Annotated[dict, InjectedState] = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = None,
) -> Command:
    bridge = os.environ.get("OPENSTARRY_COMPUTER_BRIDGE", "http://127.0.0.1:5095")
    token = os.environ.get("OPENSTARRY_BRIDGE_TOKEN", "")
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{bridge}/action",
                headers={"x-openstarry-token": token},
                json={
                    "action": action,
                    "args": args or {},
                    "options": {
                        "irreversible": irreversible,
                        "description": description,
                    },
                },
            )
            response.raise_for_status()
            payload = response.json()
            if not payload.get("success"):
                raise RuntimeError(payload.get("error", "Computer operation failed"))
            result = payload.get("result")
            return Command(update={"messages": [ToolMessage(str(result), tool_call_id=tool_call_id)]})
    except Exception as error:
        return Command(update={"messages": [
            ToolMessage(f"Computer operation failed: {error}", tool_call_id=tool_call_id, status="error")
        ]})
