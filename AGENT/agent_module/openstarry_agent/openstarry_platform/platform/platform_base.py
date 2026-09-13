from abc import ABC, abstractmethod
from typing import Any

from openstarry_agent.commons.type_def import OpenStarryEntryDataSchema, OpenStarryEventEnvelope


class PlatformBase(ABC):

    def __init__(self, platform: str):
        self.platform = platform

    @abstractmethod
    async def send(self, id: str, envelope: OpenStarryEventEnvelope):
        """
        Send envelope to client.
        """
        pass

    @abstractmethod
    def trans_payload(self, raw_data: Any) -> OpenStarryEntryDataSchema:
        """
        Translate data package to OpenStarryEntryDataSchema.
        """
        pass

    @abstractmethod
    def _open_envelope(self, envelope: OpenStarryEventEnvelope) -> dict:
        pass