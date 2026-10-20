"""Single source of truth for product, protocol and handshake identity.

Everything that has to agree between the core and the editor extension is
declared here once: the product name, the release version and the contract
version described in ``docs/protocol.md``.
"""

from __future__ import annotations

#: Release version of the product.
__version__ = "1.0.0"

#: Contract version spoken between the extension and the core. Bump it when an
#: endpoint or an event changes shape in a way that older peers cannot read.
PROTOCOL_VERSION = 1

#: Product name used in settings files, logs and the HTTP handshake.
PRODUCT_NAME = "LexiQode"

#: First token of the one-line stdout handshake the core prints on startup.
HANDSHAKE_PREFIX = "lexiqode-core-ready"

#: Name of the machine-readable descriptor that lets a second editor attach to
#: an already running core instead of spawning another one.
RUNTIME_DESCRIPTOR_NAME = "core-runtime.json"