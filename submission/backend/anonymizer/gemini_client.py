"""Thin Gemini wrapper: .env config, retries and an on-disk cache.

The cache keys on model + schema + full prompt, so re-running the same
request costs no quota and returns byte-identical output.
"""

import hashlib
import os
import time
from pathlib import Path
from typing import Optional, Tuple, Type, TypeVar

from dotenv import load_dotenv
from google import genai
from google.genai import errors, types
from pydantic import BaseModel

BACKEND_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = BACKEND_DIR / ".cache" / "gemini"
DEFAULT_MODEL = "gemini-3.5-flash-lite"
RETRY_CODES = {429, 500, 503}
MAX_TRIES = 4
SEED = 42

load_dotenv(BACKEND_DIR / ".env")

T = TypeVar("T", bound=BaseModel)
_client: Optional[genai.Client] = None


def get_model() -> str:
    return os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL


def get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _client


def _call(model: str, prompt: str, schema: Type[BaseModel]) -> str:
    """One request, retried with backoff on quota and server errors."""
    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=schema,
        seed=SEED,
    )
    for attempt in range(MAX_TRIES):
        try:
            response = get_client().models.generate_content(
                model=model, contents=prompt, config=config,
            )
            return response.text
        except errors.APIError as exc:
            if exc.code not in RETRY_CODES or attempt == MAX_TRIES - 1:
                raise
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError("unreachable")


def generate_json(prompt: str, schema: Type[T]) -> T:
    """Return the model's answer parsed into `schema`, using the cache."""
    return generate_json_raw(prompt, schema)[0]


def generate_json_raw(prompt: str, schema: Type[T]) -> Tuple[T, str]:
    """Like generate_json(), plus the JSON text exactly as returned."""
    model = get_model()
    key = hashlib.sha256(
        "\n".join([model, schema.__name__, prompt]).encode("utf-8")
    ).hexdigest()
    cached = CACHE_DIR / f"{key}.json"
    if cached.exists():
        raw = cached.read_text("utf-8")
        return schema.model_validate_json(raw), raw

    raw = _call(model, prompt, schema)
    result = schema.model_validate_json(raw)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached.write_text(raw, encoding="utf-8")
    return result, raw
