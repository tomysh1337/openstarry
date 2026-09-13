import time
from abc import ABC

from openstarry_agent.commons.logger import logger
from openstarry_agent.openstarry_platform.register import PLATFORM_REGISTRY
from openstarry_agent.commons.type_def import OpenStarryIdentity, MinimalEnvelopeData, OpenStarryEventEnvelope, PlatformNotRegister


class EventHandler(ABC):

    def _build_envelope(
        self,
        event: str,
        target: OpenStarryIdentity,
        data: MinimalEnvelopeData,
        generation_id: str,
    ) -> OpenStarryEventEnvelope:
        return {
            "event": event,
            "target": target,
            "data": data,
            "generation_id": generation_id,
            "timestamp": time.time(),
        }
    
    async def _send_envelope(
        self,
        target: OpenStarryIdentity,
        envelope: OpenStarryEventEnvelope = None
    ):
        """
        Dispatch envelope to different platform senders.

        - default → websocket
        - extensible via @send_interface
        """

        if not envelope:
            return
        
        try: 
            client_id = target.get("id")
            platform = target.get("platform")
            sender = PLATFORM_REGISTRY.get(platform)

            if not sender:
                raise PlatformNotRegister(platform=platform)
            
            envelope = await self._before_send(envelope)

            await sender.send(client_id, envelope)

            await self._after_send(envelope)

        except PlatformNotRegister as e:
            raise e

        except Exception as e:
            logger.error(f"Error: {e}")


    # Extension hooks
    async def _before_send(
        self,
        envelope: OpenStarryEventEnvelope,
    ) -> OpenStarryEventEnvelope:
        return envelope

    async def _after_send(
        self,
        envelope: OpenStarryEventEnvelope,
    ) -> None:
        pass