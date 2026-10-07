from langchain_core.messages import SystemMessage


def normalize_system_messages(messages):
    """Keep runtime/skill instructions in the leading system message.

    Several OpenAI-compatible model templates reject system messages between
    assistant/tool turns. Preserve the conversation and its tool-call ordering.
    """
    if not isinstance(messages, (list, tuple)):
        return messages
    instructions, conversation = [], []
    for message in messages:
        if isinstance(message, SystemMessage):
            content = message.content
            instructions.extend([content] if isinstance(content, str) else content)
        else:
            conversation.append(message)
    if not instructions:
        return conversation
    content = "\n\n".join(instructions) if all(isinstance(item, str) for item in instructions) else instructions
    return [SystemMessage(content=content), *conversation]
