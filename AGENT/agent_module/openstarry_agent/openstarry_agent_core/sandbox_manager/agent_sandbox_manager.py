import asyncio
import os
import subprocess

from openstarry_agent.commons.auto_init import auto_init


class AgentSandboxManager:
    """Workspace registry for direct local execution in the desktop edition."""

    async def configure_sandbox(self, *, client_id: str, work_dir: str) -> str:
        if not work_dir or not os.path.isdir(work_dir):
            return ""
        return os.path.abspath(work_dir)

    async def get_sandbox_container_id(self, *, client_id: str, work_dir: str):
        return await self.configure_sandbox(client_id=client_id, work_dir=work_dir)

    async def destroy_sandbox(self, *, client_id: str, work_dir: str):
        return None

    async def done(self, *, client_id: str, work_dir: str):
        return None

    async def cleanup_all(self):
        return None

    async def cleanup_expired(self) -> int:
        return 0

    async def docker_exec(self, container_id: str, cmd: str) -> str:
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        process = await asyncio.create_subprocess_shell(
            cmd,
            cwd=container_id,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=flags,
        )
        stdout, stderr = await process.communicate()
        return (stdout + stderr).decode("utf-8", errors="replace")

    async def start(self):
        return None

    async def stop(self):
        return None


agent_sandbox = AgentSandboxManager()
auto_init.register(agent_sandbox)
