"""Detect an unexecuted delegation promise without inventing a tool call."""

import re


DELEGATION_RETRY_PROMPT = (
    "Your previous reply promised to start a sub-agent, but contained no tool call. "
    "No sub-agent has been created. If you are delegating this task, actually call "
    "assign_sub_assistant with the task and instructions now. Do not just announce "
    "a plan or claim success. If you cannot delegate, explain that no task was started."
)
DELEGATION_NOT_STARTED = (
    "\n\n子代理尚未启动：模型没有发出任务分配工具调用，因此没有创建任务或任务 ID。"
)

_CLAIM = re.compile(
    r"(?:^|\s)(?:我(?:们)?|现在|接下来|马上|已经|正在|已).{0,48}?"
    r"(?:委派|分配|派出|启动|创建|调用|召唤|交给).{0,32}?"
    r"(?:子代理|子助手|子智能体|sub[ -]?(?:agent|assistant))"
    r"|\b(?:I(?:'ll|'m| will| am)|we(?:'ll| will| are)|now)\b.{0,60}?"
    r"\b(?:delegate|assign|spawn|launch|start|create)\b.{0,50}?"
    r"\b(?:sub[ -]?(?:agent|assistant)|worker)\b",
    re.IGNORECASE,
)
_NON_ACTION = re.compile(
    r"不能|无法|不会|不要|未能|没有|失败|是否|如果|假如|例如|示例|比如|吗[？?]?|[？?]"
    r"|\b(?:not|cannot|can't|won't|could|would|if|example)\b",
    re.IGNORECASE,
)


def needs_delegation_call(response, state, tool_names):
    if state.get("agent_role") not in {"main_agent", "team_leader"}:
        return False
    if "assign_sub_assistant" not in tool_names or response.tool_calls:
        return False
    # Never replay a delegation already attempted during this user turn.
    for message in reversed(state.get("messages", [])):
        if message.type == "human":
            break
        if any(call.get("name") == "assign_sub_assistant"
               for call in getattr(message, "tool_calls", [])):
            return False
    text = re.sub(r"```.*?```", "", response.text, flags=re.DOTALL)
    text = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(">"))
    for sentence in re.findall(r"[^\n。！？.!?]+[。！？.!?]?", text):
        if not _NON_ACTION.search(sentence) and _CLAIM.search(sentence):
            return True
    return False
