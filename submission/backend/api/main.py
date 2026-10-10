"""The two endpoints of submission/frontend/API_CONTRACT.md.

POST /api/documents/analyze            PDF -> text + detected occurrences
POST /api/documents/{id}/anonymize     selected ids -> masked text + PDF

The download is the uploaded PDF rebuilt with the selected words
redacted. If that cannot be done safely, it falls back to the masked
text as .txt, so the file never protects less than the preview shows.

Routes are plain functions on purpose: FastAPI runs them in a thread
pool, so the Gemini call never blocks the event loop.
"""

import base64
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from anonymizer import detector, entities, extract, pdf_reconstructor
from anonymizer.spans import Span
from api.frontend import mount_frontend, static_dir
from api.store import Analysis, AnalysisStore

MAX_BYTES = 10 * 1024 * 1024
FRONTEND_ORIGINS = ["http://localhost:4200", "http://127.0.0.1:4200"]

log = logging.getLogger("api")
app = FastAPI(title="DataVeil API", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=FRONTEND_ORIGINS,
    allow_methods=["POST", "OPTIONS"], allow_headers=["*"],
)
store = AnalysisStore()


class EntityOut(BaseModel):
    id: str
    start: int
    end: int
    type: str
    replacement: str
    reason: Optional[str] = None


class AnalysisOut(BaseModel):
    id: str
    originalText: str
    entities: List[EntityOut]


class AnonymizeIn(BaseModel):
    selectedEntityIds: List[str]


class DownloadOut(BaseModel):
    name: str
    mediaType: str
    contentBase64: str


class AnonymizeOut(BaseModel):
    anonymizedText: str
    download: DownloadOut


@app.exception_handler(HTTPException)
def http_error(_: Request, exc: HTTPException) -> JSONResponse:
    """The contract's error shape: {"message": "..."}."""
    return JSONResponse(
        status_code=exc.status_code, content={"message": exc.detail},
    )


@app.post("/api/documents/analyze", response_model=AnalysisOut)
def analyze(file: UploadFile = File(...)) -> AnalysisOut:
    data = file.file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "File larger than 10 MB")
    if not data.lstrip().startswith(b"%PDF"):
        raise HTTPException(415, "Only PDF documents are supported")
    try:
        text = extract.extract_text_from_bytes(data)
    except Exception:
        raise HTTPException(422, "The document cannot be read")
    if not text.strip():
        raise HTTPException(422, "The document has no text")
    try:
        spans = detector.detect(text)
    except Exception:
        log.exception("detection failed")
        raise HTTPException(500, "Processing failed")

    found = entities.entities(text, spans)
    analysis = store.put(file.filename or "document.pdf", text, found, data)
    return AnalysisOut(
        id=analysis.id, originalText=text,
        entities=[
            EntityOut(
                id=e.id, start=e.start, end=e.end, type=e.type,
                replacement=e.replacement, reason=e.reason or None,
            )
            for e in found
        ],
    )


@app.post("/api/documents/{analysis_id}/anonymize",
          response_model=AnonymizeOut)
def anonymize(analysis_id: str, body: AnonymizeIn) -> AnonymizeOut:
    analysis = store.get(analysis_id)
    if analysis is None:
        raise HTTPException(404, "Analysis not found or expired")
    ids = body.selectedEntityIds
    known = {e.id for e in analysis.entities}
    if len(set(ids)) != len(ids) or not set(ids) <= known:
        raise HTTPException(400, "Unknown or duplicate entity ids")

    spans = entities.selected_spans(analysis.entities, ids)
    masked = entities.mask_selected(analysis.text, analysis.entities, ids)
    return AnonymizeOut(
        anonymizedText=masked, download=_download(analysis, spans, masked),
    )


def _download(analysis: Analysis, spans: List[Span],
              masked: str) -> DownloadOut:
    """The rebuilt PDF, or the masked text when the PDF is not safe."""
    name = Path(analysis.filename).stem or "document"
    pdf = _rebuild_pdf(analysis, spans)
    if pdf is not None:
        return DownloadOut(
            name=f"{name}-anonymized.pdf", mediaType="application/pdf",
            contentBase64=base64.b64encode(pdf).decode("ascii"),
        )
    return DownloadOut(
        name=f"{name}-anonymized.txt", mediaType="text/plain;charset=utf-8",
        contentBase64=base64.b64encode(masked.encode("utf-8")).decode("ascii"),
    )


def _rebuild_pdf(analysis: Analysis, spans: List[Span]) -> Optional[bytes]:
    if not analysis.pdf:
        return None
    try:
        pdf, unmatched = pdf_reconstructor.reconstruct_pdf_with_report(
            analysis.pdf, spans,
        )
    except Exception:
        # e.g. "manual review required": redacting would touch public text
        log.warning("PDF rebuild failed, sending .txt", exc_info=True)
        return None
    if unmatched:
        # The PDF would protect less than the preview: never send that.
        log.warning("%d selected spans not in the PDF, sending .txt",
                    len(unmatched))
        return None
    return pdf


@app.get("/api/health")
def health() -> dict:
    """For the hosting platform's health check."""
    return {"status": "ok"}


# Last, so the API routes above take precedence over "/".
mount_frontend(app, static_dir())
