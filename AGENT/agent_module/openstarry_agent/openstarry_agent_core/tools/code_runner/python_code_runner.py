import asyncio
import os
import subprocess
import sys
from pathlib import Path
from typing import Annotated, List, Optional
from uuid import uuid4

from langchain.messages import ToolMessage
from langchain.tools import tool, InjectedToolCallId
from langgraph.prebuilt import InjectedState
from langgraph.types import Command

from openstarry_agent.openstarry_event_pipe.stream_event.agent_stream_writer import AgentStreamWriter, AgentStreamEvent
from openstarry_agent.commons.logger import logger
from openstarry_agent.global_config import TOOLS_MAX_OUTPUT_LENGTH
from openstarry_agent.openstarry_agent_core.tools.prompt import RUN_PYTHON_CODE_PROMPT


@tool(description=RUN_PYTHON_CODE_PROMPT)
async def run_python_code(
    code: str,
    run_args: Optional[list[str]] = None,
    state: Annotated[dict, InjectedState] = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = None,
) -> Command:

    target = state.get("target")
    generation_id = state.get("generation_id")

    event_writer = AgentStreamWriter(generation_id)
    event_writer.send_event(
        event=AgentStreamEvent.TOOL_EXEC_START, 
        target=target,
        data={
            "event_name": "tool_exec_chunk_rtn",
            "tool_name": "run_python_code",
            "tool_call_id": tool_call_id,
            "content": (
                "Running Python code\n\n"
                "'''python\n"
                f"{code}\n"
                "'''\n"
                f"With args: {run_args}"
            ),
            "chunk_position": "start",
            "status": "success",
        }
    )

    run_args = run_args or []
    config = state.get("config", {}) or {}
    workspace = config.get("work_dir")

    if not workspace or not os.path.isdir(workspace):
        event_writer.send_event(
            event=AgentStreamEvent.TOOL_EXEC_END, 
            target=target,
            data={
                "event_name": "tool_exec_chunk_rtn",
                "tool_name": "run_python_code",
                "tool_call_id": tool_call_id,
                "content": "Error: Sandbox configure failed.",
                "chunk_position": "end",
                "status": "fail",
            }
        )
        return Command(update={
            "messages": [
                ToolMessage("Error: Work directory is not configured.", tool_call_id=tool_call_id)
            ]
        })

    if not code or not code.strip():
        event_writer.send_event(
            event=AgentStreamEvent.TOOL_EXEC_END, 
            target=target,
            data={
                "event_name": "tool_exec_chunk_rtn",
                "tool_name": "run_python_code",
                "tool_call_id": tool_call_id,
                "content": "Error: Python code cannot be empty.",
                "chunk_position": "end",
                "status": "fail",
            }
        )
        return Command(update={
            "messages": [
                ToolMessage("Error: Python code cannot be empty.", tool_call_id=tool_call_id)
            ]
        })

    try:
        host_script_path = Path(workspace) / ".openstarry" / "tmp" / f"{uuid4().hex}.py"
        host_script_path.parent.mkdir(parents=True, exist_ok=True)
        with open(host_script_path, "w", encoding="utf-8", newline="") as f:
            f.write(code)

        run_cmd = [sys.executable, str(host_script_path), *run_args]

        process = await asyncio.create_subprocess_exec(
            *run_cmd,
            cwd=workspace,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )

        stdout, stderr = await process.communicate()
        stdout_text = stdout.decode("utf-8", errors="replace")
        stderr_text = stderr.decode("utf-8", errors="replace")

        output_parts = []
        if stdout_text.strip():
            output_parts.append(stdout_text.rstrip())
        if stderr_text.strip():
            output_parts.append(stderr_text.rstrip())

        output = "\n".join(output_parts).strip()
        if not output:
            output = "Python code executed successfully (no output)."

        if len(output) > TOOLS_MAX_OUTPUT_LENGTH:
            output = output[:TOOLS_MAX_OUTPUT_LENGTH] + "\n...[output truncated]"

        event_writer.send_event(
            event=AgentStreamEvent.TOOL_EXEC_END, 
            target=target,
            data={
                "event_name": "tool_exec_chunk_rtn",
                "tool_name": "run_python_code",
                "tool_call_id": tool_call_id,
                "content": (
                    "Result:\n"
                    "'''text\n"
                    "[STDOUT]\n"
                    f"{stdout_text}\n\n"
                    "[STDERR]\n"
                    f"{stderr_text}\n"
                    "'''"
                ),
                "chunk_position": "end",
                "status": "success" if process.returncode == 0 else "fail",
            }
        )

        if process.returncode != 0:
            return Command(update={
                "messages": [
                    ToolMessage(
                        f"Python exited with code {process.returncode}.\n{output}",
                        tool_call_id=tool_call_id,
                    )
                ]
            })

        return Command(update={
            "messages": [
                ToolMessage(output, tool_call_id=tool_call_id)
            ]
        })

    except Exception as e:

        event_writer.send_event(
            event=AgentStreamEvent.TOOL_EXEC_END, 
            target=target,
            data={
                "event_name": "tool_exec_chunk_rtn",
                "tool_name": "run_python_code",
                "tool_call_id": tool_call_id,
                "content": f"Error executing Python code: {str(e)}",
                "chunk_position": "end",
                "status": "fail",
            }
        )
        return Command(update={
            "messages": [
                ToolMessage(f"Error executing Python code: {str(e)}", tool_call_id=tool_call_id)
            ]
        })

    finally:
        try:
            host_script_path = locals().get("host_script_path")
            if isinstance(host_script_path, Path) and host_script_path.exists():
                host_script_path.unlink()
        except Exception:
            pass
