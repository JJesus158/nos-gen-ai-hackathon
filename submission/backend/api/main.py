"""The endpoints of submission/frontend/API_CONTRACT.md.

POST /api/documents/analyze            PDF -> text + detected occurrences
POST /api/documents/{id}/anonymize     selected ids -> masked text + PDF
POST /api/documents/{id}/summarize     selected ids -> readable summary

The download is the uploaded PDF rebuilt with the selected words
redacted. If that cannot be done safely, it falls back to the masked
text as .txt, so the file never protects less than the preview shows.

Routes are plain functions on purpose: FastAPI runs them in a thread
pool, so the Gemini call never blocks the event loop.
"""

import base64
import logging
from pathlib import Path
from typing import Annotated, List, Literal, Optional, Tuple

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StrictInt, StringConstraints

from anonymizer import (
    detector, entities, extract, masker, pdf_reconstructor, summarizer,
)
from anonymizer.masker import LineRange
from anonymizer.spans import Span
from api.frontend import mount_frontend, static_dir
from api.store import Analysis, AnalysisStore

MAX_BYTES = 10 * 1024 * 1024
MAX_MANUAL_ENTITIES = 5000
FRONTEND_ORIGINS = ["http://localhost:4200", "http://127.0.0.1:4200"]

log = logging.getLogger("api")
app = FastAPI(title="DataVeil API", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=FRONTEND_ORIGINS,
    allow_methods=["POST", "OPTIONS"], allow_headers=["*"],
)
store = AnalysisStore()


class PdfBoxOut(BaseModel):
    start: int
    end: int
    page: int
    x: float
    y: float
    width: float
    height: float


class EntityOut(BaseModel):
    id: str
    start: int
    end: int
    type: str
    replacement: str
    reason: Optional[str] = None
    boxes: List[PdfBoxOut] = Field(default_factory=list)


class AnalysisOut(BaseModel):
    id: str
    originalText: str
    entities: List[EntityOut]


class ManualEntityIn(BaseModel):
    """An occurrence the user marked by hand, as UTF-16 offsets."""

    start: StrictInt
    end: StrictInt
    type: Annotated[str, StringConstraints(
        strip_whitespace=True, min_length=1, max_length=100,
    )]


class AnonymizeIn(BaseModel):
    selectedEntityIds: List[str]
    manualEntities: Annotated[
        List[ManualEntityIn], Field(max_length=MAX_MANUAL_ENTITIES),
    ] = []


class SummarizeIn(AnonymizeIn):
    """The same selection as anonymize, plus the language of the summary
    (the document's own when absent)."""

    language: Optional[Literal["pt-PT", "en"]] = None


class SummaryOut(BaseModel):
    summary: str


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
        layout = extract.extract_layout_from_bytes(data)
        text = layout.text
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
                boxes=layout.boxes_for(e.start, e.end),
            )
            for e in found
        ],
    )


@app.post("/api/documents/{analysis_id}/anonymize",
          response_model=AnonymizeOut)
def anonymize(analysis_id: str, body: AnonymizeIn) -> AnonymizeOut:
    analysis, spans, ranges = _selection(analysis_id, body)
    masked = masker.mask(analysis.text, spans, ranges=ranges)
    return AnonymizeOut(
        anonymizedText=masked,
        download=_download(analysis, spans, ranges, masked),
    )


@app.post("/api/documents/{analysis_id}/summarize",
          response_model=SummaryOut)
def summarize(analysis_id: str, body: SummarizeIn) -> SummaryOut:
    """The masked text, and only it, rewritten by the model as a summary."""
    analysis, spans, ranges = _selection(analysis_id, body)
    masked = masker.mask_with_positions(analysis.text, spans, ranges=ranges)
    try:
        summary = summarizer.summarize(masked, body.language)
    except Exception:
        log.exception("summary failed")
        raise HTTPException(500, "Summary failed")
    return SummaryOut(summary=summary)


def _selection(
        analysis_id: str, body: AnonymizeIn,
) -> Tuple[Analysis, List[Span], List[LineRange]]:
    """The analysis and what the selection masks, or the contract's error."""
    analysis = store.get(analysis_id)
    if analysis is None:
        raise HTTPException(404, "Analysis not found or expired")
    ids = body.selectedEntityIds
    known = {e.id for e in analysis.entities}
    if len(set(ids)) != len(ids) or not set(ids) <= known:
        raise HTTPException(400, "Unknown or duplicate entity ids")
    manual = [(m.start, m.end, m.type) for m in body.manualEntities]
    try:
        ranges = entities.manual_ranges(analysis.text, manual)
    except ValueError:
        raise HTTPException(400, "Invalid manual entity range")
    return analysis, entities.selected_spans(analysis.entities, ids), ranges


def _download(analysis: Analysis, spans: List[Span],
              ranges: List[LineRange], masked: str) -> DownloadOut:
    """The rebuilt PDF, or the masked text when the PDF is not safe."""
    name = Path(analysis.filename).stem or "document"
    pdf = _rebuild_pdf(analysis, spans, ranges)
    if pdf is not None:
        return DownloadOut(
            name=f"{name}-anonymized.pdf", mediaType="application/pdf",
            contentBase64=base64.b64encode(pdf).decode("ascii"),
        )
    return DownloadOut(
        name=f"{name}-anonymized.txt", mediaType="text/plain;charset=utf-8",
        contentBase64=base64.b64encode(masked.encode("utf-8")).decode("ascii"),
    )


def _rebuild_pdf(analysis: Analysis, spans: List[Span],
                 ranges: List[LineRange]) -> Optional[bytes]:
    if not analysis.pdf:
        return None
    try:
        pdf, unmatched = pdf_reconstructor.reconstruct_pdf_with_report(
            analysis.pdf, spans, ranges=ranges,
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
