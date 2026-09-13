import asyncio
import copy
import time

from enum import Enum

from openstarry_agent.commons.type_def import OpenStarryEventEnvelope, MinimalEnvelopeData, OpenStarryIdentity
from openstarry_agent.commons.logger import logger


class AgentCommonEvent(str, Enum):
    INFO = 'info'
    WARNING = 'warning'
    ERROR = 'error'


EVENT_PIPE = asyncio.Queue(maxsize=1000)
    

class EventPipeWriter:

    async def post_event(
        self,
        *,
        event: AgentCommonEvent,
        target: OpenStarryIdentity = None,
        data: MinimalEnvelopeData = None,
        timestamp: float = None,
        generation_id: str = None
    ):
        '''
        Args:
            event: Event enum.
            target: Event receiver, the OpenStarryEventEnvelope will try to send to this target at the final.
            data: Event data, should contains event_name and content.
        '''
        
        envelope: OpenStarryEventEnvelope = {
            "event": event.value,
            "target": copy.deepcopy(target),
            "data": copy.deepcopy(data),
            "timestamp": timestamp or time.time(),
            "generation_id": generation_id,
            "blocking": False,
        }

        await EVENT_PIPE.put(envelope)

    async def get_event(self) -> OpenStarryEventEnvelope:
        return await EVENT_PIPE.get()
    
    async def clear(self):
        count = 0
        while not EVENT_PIPE.empty():
            await EVENT_PIPE.get()
            count = count + 1

        logger.info(f"Cleaned {count} in pipe.")
        return count



event_pipe = EventPipeWriter()