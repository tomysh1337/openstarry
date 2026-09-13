"""
Provider registry.

This module ONLY defines provider imports and PROVIDER_REGISTRY.
No routing logic should be placed here.
"""

from typing import Dict, Type

from openstarry_agent.openstarry_agent_core.tools.web_search.providers.base import BaseSearchProvider

# ------------------------------------------------------------
# Link search providers (keyword -> urls)
# ------------------------------------------------------------
from openstarry_agent.openstarry_agent_core.tools.web_search.providers.duckduckgo import DuckDuckGoProvider
from openstarry_agent.openstarry_agent_core.tools.web_search.providers.bing import BingProvider
from openstarry_agent.openstarry_agent_core.tools.web_search.providers.google import GoogleProvider
from openstarry_agent.openstarry_agent_core.tools.web_search.providers.bocha import BochaProvider
from openstarry_agent.openstarry_agent_core.tools.web_search.providers.unifuncs import UniFuncsProvider
from openstarry_agent.openstarry_agent_core.tools.web_search.providers.searxng import SearxNGProvider

# ------------------------------------------------------------
# Content fetch providers (urls -> content / urls -> content+urls)
# ------------------------------------------------------------
from openstarry_agent.openstarry_agent_core.tools.web_search.providers.tavily import TavilyProvider
from openstarry_agent.openstarry_agent_core.tools.web_search.providers.jina import JinaProvider
from openstarry_agent.openstarry_agent_core.tools.web_search.providers.crawl4ai import Crawl4AIProvider

# ------------------------------------------------------------
# Provider registry
# ------------------------------------------------------------
PROVIDER_REGISTRY: Dict[str, Type[BaseSearchProvider]] = {
    # ---------- no api key ----------
    "duckduckgo": DuckDuckGoProvider,

    # ---------- link search (api key required) ----------
    # "searxng": SearxNGProvider,  # SearxNG provider requires self-hosted instance, disabled by default
    "bocha": BochaProvider,
    "unifuncs": UniFuncsProvider,
    "bing": BingProvider,
    # "google": GoogleProvider,  # Google provider requires both API key and CSE ID, set CSE ID via set_cx(), disabled by default

    # ---------- content fetch ----------
    "tavily": TavilyProvider,
    "jina": JinaProvider,
    "crawl4ai": Crawl4AIProvider,
}

__all__ = [
    "PROVIDER_REGISTRY",
]
