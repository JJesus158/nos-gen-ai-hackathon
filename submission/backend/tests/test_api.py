import base64

import pymupdf
import pytest
from fastapi.testclient import TestClient

from anonymizer import detector, pdf_reconstructor
from anonymizer.extract import extract_text_from_bytes
from anonymizer.spans import Category, Span
from api import main

LINES = ["Nome: Ana Correia", "NIF: 123456789", "Contacto: Ana Correia"]


def pdf_bytes(lines=LINES) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    for i, line in enumerate(lines):
        page.insert_text((72, 72 + 20 * i), line)
    return doc.tobytes()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "store", main.AnalysisStore())
    monkeypatch.setattr(detector, "detect", lambda text, save_run=None: [
        Span(1, "Ana Correia", Category.NAME, "name"),
        Span(2, "123456789", Category.ID, "NIF"),
        Span(3, "Ana Correia", Category.NAME, "name"),
    ])
    return TestClient(main.app)


def analyze(client, data=None, name="ficha.pdf"):
    if data is None:
        data = pdf_bytes()
    return client.post(
        "/api/documents/analyze",
        files={"file": (name, data, "application/pdf")},
    )


def test_analyze_returns_text_and_occurrences(client):
    response = analyze(client)

    assert response.status_code == 200
    body = response.json()
    text = body["originalText"]
    assert text.split("\n") == LINES
    assert [(e["id"], e["type"], text[e["start"]:e["end"]], e["replacement"])
            for e in body["entities"]] == [
        ("entity-1", "NAME", "Ana Correia", "* *"),
        ("entity-2", "ID", "123456789", "*"),
        ("entity-3", "NAME", "Ana Correia", "* *"),
    ]
    assert body["entities"][0]["reason"] == "name"


def test_anonymize_masks_only_the_selection(client):
    analysis = analyze(client).json()

    response = client.post(
        f"/api/documents/{analysis['id']}/anonymize",
        json={"selectedEntityIds": ["entity-2"]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["anonymizedText"].split("\n") == [
        "Nome: Ana Correia", "NIF: *", "Contacto: Ana Correia",
    ]
    download = body["download"]
    assert download["name"] == "ficha-anonymized.pdf"
    assert download["mediaType"] == "application/pdf"
    assert pdf_words(download) == words(body["anonymizedText"])


def words(text):
    return sorted(text.split())


def pdf_words(download):
    """Words of the downloaded PDF. Order is not compared: the rebuilt
    PDF draws the asterisks after the page text."""
    data = base64.b64decode(download["contentBase64"])
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        assert not doc.metadata.get("author")
    return words(extract_text_from_bytes(data))


def test_anonymize_with_everything_and_with_nothing(client):
    analysis = analyze(client).json()
    url = f"/api/documents/{analysis['id']}/anonymize"
    ids = [e["id"] for e in analysis["entities"]]

    everything = client.post(url, json={"selectedEntityIds": ids}).json()
    nothing = client.post(url, json={"selectedEntityIds": []}).json()

    assert everything["anonymizedText"].split("\n") == [
        "Nome: * *", "NIF: *", "Contacto: * *",
    ]
    assert pdf_words(everything["download"]) == words(
        everything["anonymizedText"])
    assert nothing["anonymizedText"] == analysis["originalText"]
    assert pdf_words(nothing["download"]) == words(
        analysis["originalText"])


def _needs_review(pdf, spans):
    raise ValueError("manual review required")


def _misses_spans(pdf, spans):
    return pdf, list(spans)


@pytest.mark.parametrize("rebuild", [_needs_review, _misses_spans])
def test_unsafe_pdf_falls_back_to_masked_text(client, monkeypatch, rebuild):
    """The file never protects less than the preview shows."""
    monkeypatch.setattr(
        pdf_reconstructor, "reconstruct_pdf_with_report", rebuild,
    )
    analysis = analyze(client).json()

    body = client.post(
        f"/api/documents/{analysis['id']}/anonymize",
        json={"selectedEntityIds": ["entity-2"]},
    ).json()

    download = body["download"]
    assert download["name"] == "ficha-anonymized.txt"
    assert download["mediaType"] == "text/plain;charset=utf-8"
    decoded = base64.b64decode(download["contentBase64"]).decode("utf-8")
    assert decoded == body["anonymizedText"]


def test_error_statuses_follow_the_contract(client):
    assert analyze(client, b"plain text", "notes.txt").status_code == 415
    assert analyze(client, b"").status_code == 400
    assert analyze(client, b"%PDF-1.7 broken").status_code == 422
    big = b"%PDF" + b"0" * main.MAX_BYTES
    assert analyze(client, big).status_code == 413

    missing = client.post(
        "/api/documents/nope/anonymize", json={"selectedEntityIds": []},
    )
    assert missing.status_code == 404
    assert missing.json() == {"message": "Analysis not found or expired"}

    analysis = analyze(client).json()
    url = f"/api/documents/{analysis['id']}/anonymize"
    for ids in (["entity-9"], ["entity-1", "entity-1"]):
        bad = client.post(url, json={"selectedEntityIds": ids})
        assert bad.status_code == 400


def test_expired_analysis_is_gone(monkeypatch):
    now = [0.0]
    store = main.AnalysisStore(ttl_seconds=10, clock=lambda: now[0])
    analysis = store.put("a.pdf", "x", [])

    assert store.get(analysis.id) is analysis
    now[0] = 11
    assert store.get(analysis.id) is None


def anonymize(client, analysis_id, ids, manual_entities=None):
    body = {"selectedEntityIds": ids}
    if manual_entities is not None:
        body["manualEntities"] = manual_entities
    return client.post(f"/api/documents/{analysis_id}/anonymize", json=body)


def manual(start, end, kind="NAME"):
    return {"start": start, "end": end, "type": kind}


def test_manual_entities_are_masked_where_they_are(client):
    analysis = analyze(client).json()
    surname = analysis["originalText"].rindex("Correia")

    response = anonymize(client, analysis["id"], ["entity-2"], [
        manual(surname, surname + 7, "custom:Apelido"),
    ])

    assert response.status_code == 200
    body = response.json()
    assert body["anonymizedText"].split("\n") == [
        "Nome: Ana Correia", "NIF: *", "Contacto: Ana *",
    ]
    # The PDF download hides the hand-marked word too, like the preview.
    assert body["download"]["mediaType"] == "application/pdf"
    assert pdf_words(body["download"]) == words(body["anonymizedText"])


def test_manual_entities_without_selected_ids(client):
    analysis = analyze(client).json()
    name = analysis["originalText"].index("Ana")

    response = anonymize(client, analysis["id"], [], [manual(name, name + 3)])

    assert response.status_code == 200
    assert response.json()["anonymizedText"].split("\n") == [
        "Nome: * Correia", "NIF: 123456789", "Contacto: Ana Correia",
    ]


def test_absent_or_empty_manual_entities_change_nothing(client):
    analysis = analyze(client).json()

    absent = anonymize(client, analysis["id"], ["entity-1"])
    empty = anonymize(client, analysis["id"], ["entity-1"], [])

    assert absent.status_code == empty.status_code == 200
    # The rebuilt PDF bytes differ between saves; compare what they hold.
    absent_body, empty_body = absent.json(), empty.json()
    assert absent_body["anonymizedText"] == empty_body["anonymizedText"]
    assert absent_body["download"]["name"] == empty_body["download"]["name"]
    assert pdf_words(absent_body["download"]) == pdf_words(
        empty_body["download"])
    assert absent.json()["anonymizedText"].split("\n") == [
        "Nome: * *", "NIF: 123456789", "Contacto: Ana Correia",
    ]


def test_overlapping_manual_entities_are_accepted(client):
    analysis = analyze(client).json()
    name = analysis["originalText"].index("Ana Correia")

    response = anonymize(client, analysis["id"], ["entity-1"], [
        manual(name, name + 11),
        manual(name + 4, name + 11, "custom:Apelido"),
        manual(name + 4, name + 11, "custom:Apelido"),
    ])

    assert response.status_code == 200
    assert response.json()["anonymizedText"].split("\n") == [
        "Nome: * *", "NIF: 123456789", "Contacto: Ana Correia",
    ]


def test_invalid_manual_ranges_are_rejected(client):
    # Stored directly: the PDF font cannot draw the emoji.
    analysis = main.store.put("nota.pdf", "Nota: 😀 Ana", [])
    # 12 UTF-16 units; the emoji is the surrogate pair at 6 and 7.
    for start, end in [(-1, 3), (4, 4), (5, 2), (0, 13), (7, 12), (0, 7)]:
        response = anonymize(client, analysis.id, [], [
            manual(0, 4), manual(start, end),
        ])
        assert response.status_code == 400
        assert response.json() == {"message": "Invalid manual entity range"}

    unknown = anonymize(client, analysis.id, ["entity-1"], [manual(-1, 3)])
    assert unknown.json() == {"message": "Unknown or duplicate entity ids"}
    both = anonymize(client, analysis.id, [], [manual(6, 8), manual(8, 12)])
    assert both.json()["anonymizedText"] == "Nota: * *"


def test_malformed_manual_entities_are_schema_errors(client):
    analysis = analyze(client).json()
    for entity in [
        {"end": 3, "type": "NAME"},
        {"start": 0, "end": 1.5, "type": "NAME"},
        {"start": "0", "end": 3, "type": "NAME"},
        {"start": 0, "end": 3},
        {"start": 0, "end": 3, "type": "  "},
        {"start": 0, "end": 3, "type": "x" * 101},
    ]:
        response = anonymize(client, analysis["id"], [], [entity])
        assert response.status_code == 422

    longest = manual(0, 4, "custom:" + "x" * 93)
    assert anonymize(client, analysis["id"], [], [longest]).status_code == 200

    too_many = [manual(0, 4)] * (main.MAX_MANUAL_ENTITIES + 1)
    assert anonymize(client, analysis["id"], [], too_many).status_code == 422
    most = [manual(0, 4)] * main.MAX_MANUAL_ENTITIES
    assert anonymize(client, analysis["id"], [], most).status_code == 200
