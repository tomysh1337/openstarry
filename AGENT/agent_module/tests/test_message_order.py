import importlib.util
import os
from pathlib import Path
import unittest
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage

source = Path(os.environ.get('OPENSTARRY_AGENT_SOURCE', Path(__file__).resolve().parents[1]))
spec = importlib.util.spec_from_file_location('message_normalization', source / 'openstarry_agent/openstarry_agent_core/LLM/messages.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MessageOrderTests(unittest.TestCase):
    def test_runtime_alerts_and_skills_do_not_break_tool_transcript(self):
        user = HumanMessage('test')
        assistant = AIMessage('', tool_calls=[{'id': 'one', 'name': 'read_file', 'args': {}}])
        result = ToolMessage('ok', tool_call_id='one')
        original = [SystemMessage('base'), user, assistant, result, SystemMessage('skill'), SystemMessage('retry')]
        normalized = module.normalize_system_messages(original)
        self.assertEqual(normalized[0].content, 'base\n\nskill\n\nretry')
        self.assertEqual(normalized[1:], [user, assistant, result])
        self.assertEqual(len(original), 6)

    def test_no_system_message_does_not_invent_instructions(self):
        messages = [HumanMessage('hello')]
        self.assertEqual(module.normalize_system_messages(messages), messages)

    def test_plain_prompt_is_not_split_into_characters(self):
        self.assertEqual(module.normalize_system_messages('hello'), 'hello')

    def test_structured_system_content_is_preserved(self):
        normalized = module.normalize_system_messages([SystemMessage([{'type': 'text', 'text': 'base'}]), HumanMessage('test'), SystemMessage('retry')])
        self.assertEqual(normalized[0].content, [{'type': 'text', 'text': 'base'}, 'retry'])
