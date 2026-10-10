"""Analyses kept in memory between the two requests of the contract."""

import threading
import time
import uuid
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

from anonymizer.entities import Entity


@dataclass(frozen=True)
class Analysis:
    id: str
    filename: str
    text: str
    entities: List[Entity]
    created_at: float
    pdf: bytes = b""  # the uploaded file, to rebuild it masked


class AnalysisStore:
    """Thread-safe dict with expiry; the API runs its routes in threads."""

    def __init__(self, ttl_seconds: float = 3600,
                 clock: Callable[[], float] = time.monotonic):
        self._ttl = ttl_seconds
        self._clock = clock
        self._items: Dict[str, Analysis] = {}
        self._lock = threading.Lock()

    def put(self, filename: str, text: str, entities: List[Entity],
            pdf: bytes = b"") -> Analysis:
        analysis = Analysis(
            uuid.uuid4().hex, filename, text, entities, self._clock(), pdf,
        )
        with self._lock:
            self._evict()
            self._items[analysis.id] = analysis
        return analysis

    def get(self, analysis_id: str) -> Optional[Analysis]:
        with self._lock:
            self._evict()
            return self._items.get(analysis_id)

    def _evict(self) -> None:
        limit = self._clock() - self._ttl
        for key in [k for k, a in self._items.items() if a.created_at < limit]:
            del self._items[key]
