from langgraph.prebuilt import ToolNode, ToolRuntime

from typing import Literal

from langchain_core.messages import (
    ToolCall,
    ToolMessage,
)
from langgraph.types import Command

class OpenStarryToolNode(ToolNode):
    """
    Base class for OpenStarry tools.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    
    async def _arun_one(
        self,
        call: ToolCall,
        input_type: Literal["list", "dict", "tool_calls"],
        tool_runtime: ToolRuntime,
    ) -> ToolMessage | Command:
        """Execute single tool call asynchronously with awrap_tool_call wrapper if configured.

        Args:
            call: Tool call dict.
            input_type: Input format.
            tool_runtime: Tool runtime.

        Returns:
            ToolMessage or Command.
        """
        try:
            return await super()._arun_one(call, input_type, tool_runtime)
        except Exception as e:
            return ToolMessage(
                content=repr(e),
                name=call["name"],
                tool_call_id=call["id"],
                status="error",
            )