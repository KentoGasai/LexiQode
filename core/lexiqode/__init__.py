"""LexiQode core - an OpenAI-compatible coding agent runtime.

The package is deliberately editor-agnostic: the same core serves the VSCodium
extension over HTTP/SSE, the terminal REPL and one-shot CLI runs.
"""

from __future__ import annotations

from .version import PROTOCOL_VERSION, PRODUCT_NAME, __version__

__all__ = ["PRODUCT_NAME", "PROTOCOL_VERSION", "__version__"]