"""Serve the built Angular app from the API, so one service = one URL.

In the Docker image the build lands in backend/static (STATIC_DIR
overrides it). Locally there is no build and nothing is mounted: use
`ng serve`, which forwards /api to this API.
"""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException

DEFAULT_DIR = Path(__file__).resolve().parents[1] / "static"


class SinglePageApp(StaticFiles):
    """Static files; any other non-API path gets index.html so a reload
    on an Angular route still works."""

    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code != 404 or path.split("/")[0] == "api":
                raise
            return await super().get_response("index.html", scope)


def static_dir() -> Path:
    return Path(os.environ.get("STATIC_DIR") or DEFAULT_DIR)


def mount_frontend(app: FastAPI, directory: Path) -> bool:
    """Mount the build at "/" if it exists. Call after the API routes."""
    if not (directory / "index.html").is_file():
        return False
    app.mount("/", SinglePageApp(directory=directory, html=True),
              name="frontend")
    return True
