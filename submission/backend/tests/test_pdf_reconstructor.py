from pathlib import Path

import pymupdf
import pytest

from anonymizer import pdf_reconstructor
from anonymizer.extract import extract_text_from_bytes, ocr_language

from anonymizer.pdf_reconstructor import (
    reconstruct_pdf,
    reconstruct_pdf_with_report,
)
from anonymizer.spans import Category, Span

CHALLENGE_PDF = (
    Path(__file__).resolve().parents[3]
    / "raw_data" / "document_to_anonymize.pdf"
)


def test_reconstruct_pdf_removes_sensitive_text():
    """Sensitive text disappears; unrelated text remains."""

    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Nome: Ana Correia")
        page.insert_text((72, 100), "Departamento: Informatica")
        original_pdf = document.tobytes()

    spans = [
        Span(
            line=1,
            text="Ana Correia",
            category=Category.NAME,
        )
    ]

    result_pdf = reconstruct_pdf(original_pdf, spans)

    with pymupdf.open(
        stream=result_pdf,
        filetype="pdf",
    ) as document:
        result_text = document[0].get_text()

        assert "Ana" not in result_text
        assert "Correia" not in result_text
        assert result_text.count("*") == 2
        assert "Departamento: Informatica" in result_text


def test_reconstruct_pdf_preserves_unmarked_words():
    """Keep identical words that were not marked as sensitive."""

    with pymupdf.open() as document:
        page1 = document.new_page()
        page1.insert_text((72, 72), "Nome: Ana Correia")

        page2 = document.new_page()
        page2.insert_text((72, 72), "Nota: Ana confirmou a visita")

        original_pdf = document.tobytes()

    spans = [
        Span(
            line=1,
            text="Ana Correia",
            category=Category.NAME,
        )
    ]

    result_pdf = reconstruct_pdf(original_pdf, spans)

    with pymupdf.open(
        stream=result_pdf,
        filetype="pdf",
    ) as document:
        first_page = document[0].get_text()
        second_page = document[1].get_text()

        assert "Ana Correia" not in first_page
        assert first_page.count("*") == 2
        assert "Nota: Ana confirmou a visita" in second_page


def test_unmatched_span_does_not_block_export():
    """Export matched words and report unmatched spans."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Nome: Ana Correia")
        pdf_data = document.tobytes()

    valid = Span(
        line=1, text="Ana Correia", category=Category.NAME
    )
    missing = Span(
        line=1, text="Pessoa Inexistente", category=Category.NAME
    )

    pdf_result, unmatched = reconstruct_pdf_with_report(
        pdf_data, [valid, missing]
    )

    assert unmatched == [missing]

    with pymupdf.open(stream=pdf_result, filetype="pdf") as doc:
        text = doc[0].get_text()
        assert "Ana" not in text
        assert "Correia" not in text
        assert text.count("*") == 2


def test_pdf_without_sensitive_data():
    """A PDF without detected sensitive data is valid."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Documento publico")
        pdf_data = document.tobytes()

    pdf_result, unmatched = reconstruct_pdf_with_report(
        pdf_data, []
    )

    assert unmatched == []

    with pymupdf.open(stream=pdf_result, filetype="pdf") as doc:
        assert "Documento publico" in doc[0].get_text()


def test_pdf_metadata_is_removed():
    """Clear personal metadata during PDF export."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Nome: Ana Correia")

        document.set_metadata({
            "author": "Sensitive Author",
            "creator": "Microsoft Word",
            "creationDate": "D:20261010120000",
        })

        document.set_xml_metadata(
            '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
            'Private metadata'
            '</x:xmpmeta>'
        )

        pdf_data = document.tobytes()

    span = Span(
        line=1, text="Ana Correia", category=Category.NAME
    )

    result = reconstruct_pdf(pdf_data, [span])

    with pymupdf.open(stream=result, filetype="pdf") as doc:
        assert not doc.metadata.get("author")
        assert not doc.metadata.get("creator")
        assert not doc.metadata.get("creationDate")
        assert not doc.get_xml_metadata()
        assert "Ana Correia" not in doc[0].get_text()


@pytest.mark.parametrize("fontsize", [3, 4])
def test_small_text_keeps_every_mask_visible(fontsize):
    """Small table text must still receive one asterisk per word."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Ana Correia", fontsize=fontsize)
        pdf_data = document.tobytes()

    result, unmatched = reconstruct_pdf_with_report(
        pdf_data, [Span(1, "Ana Correia", Category.NAME)]
    )

    assert unmatched == []
    with pymupdf.open(stream=result, filetype="pdf") as document:
        text = document[0].get_text()
        assert "Ana" not in text
        assert "Correia" not in text
        assert text.count("*") == 2


def test_close_lines_require_review_instead_of_removing_public_text():
    """Overlapping word boxes must not silently erase a nearby line."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Ana Correia")
        page.insert_text((72, 84), "PUBLIC DEPARTMENT")
        pdf_data = document.tobytes()

    with pytest.raises(ValueError, match="(?i)review"):
        reconstruct_pdf_with_report(
            pdf_data, [Span(1, "Ana Correia", Category.NAME)]
        )

    with pymupdf.open(stream=pdf_data, filetype="pdf") as document:
        assert document[0].get_text() == "Ana Correia\nPUBLIC DEPARTMENT\n"


def _line_of(pdf_data, text):
    """1-based line of the extracted text that contains `text`."""
    lines = extract_text_from_bytes(pdf_data).split("\n")
    return next(number for number, line in enumerate(lines, 1)
                if text in line)


def _start_of(page, text):
    """Direction of the line holding `text` and the origin of its first
    character."""
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            chars = [c for span in line["spans"] for c in span["chars"]]
            at = "".join(c["c"] for c in chars).find(text)
            if at >= 0:
                return line["dir"], chars[at]["origin"]
    raise AssertionError(f"{text!r} not on the page")


def _stars(page):
    """Every "*" drawn on the page, with its span and line."""
    return [
        (char, span, line)
        for block in page.get_text("rawdict")["blocks"]
        for line in block.get("lines", [])
        for span in line["spans"]
        for char in span["chars"]
        if char["c"] == "*"
    ]


def _words(page):
    return {word[4]: pymupdf.Rect(word[:4])
            for word in page.get_text("words")}


def test_mask_starts_where_the_value_started():
    """Asterisks on the value's baseline, from its first letter, at its
    size and in its colour: not small dots centred in a blank gap."""
    colour = (0.8, 0.1, 0.1)
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text(
            (72, 100), "Nome: Ana Correia", fontsize=12, color=colour,
        )
        value = page.search_for("Ana Correia")[0]
        pdf_data = document.tobytes()

    result = reconstruct_pdf(
        pdf_data, [Span(1, "Ana Correia", Category.NAME)]
    )

    with pymupdf.open(stream=result, filetype="pdf") as document:
        stars = _stars(document[0])
    assert len(stars) == 2
    first, span, _ = stars[0]
    assert abs(first["origin"][0] - value.x0) <= 2
    assert first["origin"][1] == pytest.approx(100, abs=0.5)
    assert span["size"] >= 0.8 * 12
    assert pymupdf.sRGB_to_pdf(span["color"]) == pytest.approx(
        colour, abs=0.01,
    )


def test_mask_shrinks_only_when_it_would_not_fit():
    """Short words leave less room than "* * *" needs at full size."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 100), "Codigo: A B C fim", fontsize=10)
        value = page.search_for("A B C")[0]
        pdf_data = document.tobytes()

    result = reconstruct_pdf(pdf_data, [Span(1, "A B C", Category.ID)])

    with pymupdf.open(stream=result, filetype="pdf") as document:
        page = document[0]
        stars = _stars(page)
        assert "fim" in _words(page)
    assert len(stars) == 3
    assert stars[0][1]["size"] < 10
    assert max(char["bbox"][2] for char, _, _ in stars) <= value.x1 + 0.5


def test_rotated_line_masks_the_value_and_keeps_its_label():
    """A 90-degree line: the number goes, its label stays, and the
    asterisks run up the page like the text did."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((100, 500), "Telefone: 912 345 678", rotate=90)
        direction, origin = _start_of(page, "912")
        label = _words(page)["Telefone:"]
        pdf_data = document.tobytes()

    result, unmatched = reconstruct_pdf_with_report(
        pdf_data, [Span(1, "912 345 678", Category.CONTACT)]
    )

    assert unmatched == []
    with pymupdf.open(stream=result, filetype="pdf") as document:
        page = document[0]
        words = _words(page)
        stars = _stars(page)
    assert words["Telefone:"] == label
    assert not {"912", "345", "678"} & set(words)
    assert len(stars) == 3
    first, _, line = stars[0]
    assert line["dir"] == pytest.approx(direction)
    assert first["origin"] == pytest.approx(origin, abs=1)


def test_tilted_line_masks_the_value_and_keeps_its_label():
    """A line at 17 degrees: only the email's letters are removed."""
    with pymupdf.open() as document:
        page = document.new_page()
        start = pymupdf.Point(150, 500)
        page.insert_text(
            start, "Email: ana.correia@example.com", fontsize=11,
            morph=(start, pymupdf.Matrix(17)),
        )
        direction, origin = _start_of(page, "ana.correia")
        label = _words(page)["Email:"]
        pdf_data = document.tobytes()

    result, unmatched = reconstruct_pdf_with_report(
        pdf_data, [Span(1, "ana.correia@example.com", Category.CONTACT)]
    )

    assert unmatched == []
    with pymupdf.open(stream=result, filetype="pdf") as document:
        page = document[0]
        words = _words(page)
        stars = _stars(page)
        assert "example" not in page.get_text()
    assert words["Email:"] == label
    assert len(stars) == 1
    first, _, line = stars[0]
    assert line["dir"] == pytest.approx(direction, abs=0.001)
    assert first["origin"] == pytest.approx(origin, abs=1)


def test_public_text_around_a_tilted_value_is_untouched():
    """The upright box of a tilted value covers far more than its
    letters: words inside that box but away from the letters stay."""
    with pymupdf.open() as document:
        page = document.new_page()
        start = pymupdf.Point(100, 500)
        page.insert_text(
            start, "Email: ana.correia@example.com", fontsize=11,
            morph=(start, pymupdf.Matrix(20)),
        )
        page.insert_text((200, 495), "Texto publico", fontsize=11)
        page.insert_text((150, 440), "Outro texto", fontsize=11)
        before = page.get_text("words")
        value = next(pymupdf.Rect(w[:4]) for w in before if "@" in w[4])
        public = {(w[4], tuple(w[:4])) for w in before if "@" not in w[4]}
        pdf_data = document.tobytes()

    # One redaction box over the value would have erased these words.
    assert all(value.intersects(box) for word, box in public
               if word in {"publico", "Outro"})
    number = _line_of(pdf_data, "ana.correia@example.com")

    result = reconstruct_pdf(
        pdf_data,
        [Span(number, "ana.correia@example.com", Category.CONTACT)],
    )

    with pymupdf.open(stream=result, filetype="pdf") as document:
        page = document[0]
        after = {(w[4], tuple(w[:4])) for w in page.get_text("words")}
        assert "example" not in page.get_text()
    assert public <= after


def test_rotated_value_crossed_by_public_text_requires_review():
    """A public word drawn across a vertical name: removing the name
    would cut into it, so the rebuild stops for review instead."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((100, 400), "Ana Correia", rotate=90)
        page.insert_text((90, 380), "PUBLICO")
        pdf_data = document.tobytes()
    number = _line_of(pdf_data, "Ana Correia")

    with pytest.raises(ValueError, match="(?i)review"):
        reconstruct_pdf_with_report(
            pdf_data, [Span(number, "Ana Correia", Category.NAME)]
        )


def test_tilted_value_over_a_picture_requires_review():
    """Removing a tilted value letter by letter would leave it visible in
    a picture underneath, as in a scan with a text layer."""
    with pymupdf.open() as document:
        page = document.new_page()
        picture = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 40, 40), False)
        picture.clear_with(200)
        page.insert_image((80, 380, 360, 520), pixmap=picture)
        start = pymupdf.Point(100, 500)
        page.insert_text(
            start, "Email: ana.correia@example.com", fontsize=11,
            morph=(start, pymupdf.Matrix(17)),
        )
        pdf_data = document.tobytes()

    with pytest.raises(ValueError, match="(?i)review"):
        reconstruct_pdf_with_report(
            pdf_data,
            [Span(1, "ana.correia@example.com", Category.CONTACT)],
        )


def test_redaction_result_is_read_back(monkeypatch):
    """Even when the box check is fooled, the words left after the
    redaction are compared with the words that had to stay."""
    monkeypatch.setattr(pdf_reconstructor, "_guard_boxes", lambda word: [])
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((100, 400), "Ana Correia", rotate=90)
        page.insert_text((90, 380), "PUBLICO")
        pdf_data = document.tobytes()
    number = _line_of(pdf_data, "Ana Correia")

    with pytest.raises(ValueError, match="(?i)changed unmarked.*review"):
        reconstruct_pdf_with_report(
            pdf_data, [Span(number, "Ana Correia", Category.NAME)]
        )


def test_existing_redaction_requires_review():
    """Do not apply an input annotation that would erase public text."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Ana Correia")
        page.insert_text((72, 110), "Public department")
        page.add_redact_annot(page.search_for("Public department")[0])
        pdf_data = document.tobytes()

    with pytest.raises(ValueError, match="(?i)review"):
        reconstruct_pdf_with_report(
            pdf_data, [Span(1, "Ana Correia", Category.NAME)]
        )

    with pymupdf.open(stream=pdf_data, filetype="pdf") as document:
        assert "Public department" in document[0].get_text()


def test_complex_layout_preserves_public_words_and_table_lines():
    """Redact selected entities across tables, columns and pages."""
    selected = [
        ("Ana Correia", Category.NAME, 0),
        ("123456789", Category.ID, 0),
        ("912 345 678", Category.CONTACT, 0),
        ("ana@example.com", Category.CONTACT, 0),
        ("PT50 0002 0123 1234 5678 9015 4", Category.FINANCIAL, 0),
        ("Ana Correia", Category.NAME, 1),
    ]
    sensitive_tokens = {
        word for text, _, _ in selected for word in text.split()
    }
    public_words = []
    table_paths = []

    with pymupdf.open() as document:
        page = document.new_page()
        columns = [36, 170, 255, 360, 559]
        for x in columns:
            page.draw_line((x, 60), (x, 132))
        for y in [60, 92, 132]:
            page.draw_line((36, y), (559, y))

        for x, label in zip(columns, ["Nome", "NIF", "Telefone", "Email"]):
            page.insert_text((x + 4, 80), label, fontsize=10)
        for x, value in zip(columns, [
            "Ana Correia", "123456789", "912 345 678", "ana@example.com",
        ]):
            page.insert_text((x + 4, 116), value, fontsize=10)
        page.insert_text((36, 160), "IBAN:", fontsize=10)
        page.insert_text(
            (80, 160), "PT50 0002 0123 1234 5678 9015 4", fontsize=10
        )
        page.insert_text((36, 210), "Public left column")
        page.insert_text((330, 210), "Public right column")
        table_paths = [path["items"] for path in page.get_drawings()]

        page = document.new_page()
        page.insert_text((72, 72), "Ana Correia")
        page.insert_text((72, 110), "Public summary")
        page.insert_text((72, 160), "Ana Correia approved the layout")
        document.set_metadata({"author": "Private Author"})
        document.set_xml_metadata(
            '<x:xmpmeta xmlns:x="adobe:ns:meta/">Private XML</x:xmpmeta>'
        )

        for page_index, page in enumerate(document):
            public_words.append({
                (word[4], tuple(word[:4]))
                for word in page.get_text("words")
                if word[4] not in sensitive_tokens
                or (page_index == 1 and word[1] > 140)
            })
        pdf_data = document.tobytes()

    lines = extract_text_from_bytes(pdf_data).splitlines()
    spans = []
    for text, category, occurrence in selected:
        matches = [
            number for number, line in enumerate(lines, 1) if text in line
        ]
        spans.append(Span(matches[occurrence], text, category))

    result, unmatched = reconstruct_pdf_with_report(pdf_data, spans)

    assert unmatched == []
    with pymupdf.open(stream=result, filetype="pdf") as document:
        assert len(document) == 2
        assert not document.metadata.get("author")
        assert not document.get_xml_metadata()
        assert sum(page.get_text().count("*") for page in document) == 16
        assert "Ana Correia" not in document[0].get_text()
        assert document[1].get_text().count("Ana Correia") == 1
        assert "Ana Correia approved the layout" in document[1].get_text()
        for page_index, page in enumerate(document):
            actual_words = {
                (word[4], tuple(word[:4])) for word in page.get_text("words")
            }
            assert public_words[page_index] <= actual_words
        actual_paths = [path["items"] for path in document[0].get_drawings()]
        assert all(path in actual_paths for path in table_paths)


def test_redaction_is_transparent_over_coloured_cells():
    """The text is removed but the cell colour underneath stays."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.draw_rect((60, 50, 300, 90), color=None, fill=(0.75, 0.85, 1))
        page.insert_text((72, 75), "Nome: Ana Correia")
        area = page.search_for("Ana Correia")[0]
        pdf_data = document.tobytes()

    result = reconstruct_pdf(
        pdf_data, [Span(1, "Ana Correia", Category.NAME)]
    )

    with pymupdf.open(stream=result, filetype="pdf") as document:
        page = document[0]
        assert "Ana" not in page.get_text()
        # Inside the redacted area, right of the asterisks.
        pixel = page.get_pixmap().pixel(int(area.x1) - 2, int(area.y1) - 2)
        assert pixel == (191, 216, 255)


def test_challenge_pdf_rebuilds_with_the_extracted_text():
    """Word PDFs end every line with a space that extraction drops (#14):
    the rebuild must still line up with the extracted text."""
    pdf_data = CHALLENGE_PDF.read_bytes()
    lines = extract_text_from_bytes(pdf_data).split("\n")
    spans = [
        Span(number, text, Category.NAME)
        for text in ("Maria Conceição Oliveira Santos", "Carlos Mendes")
        for number, line in enumerate(lines, 1) if text in line
    ]

    result, unmatched = reconstruct_pdf_with_report(pdf_data, spans)

    assert unmatched == []
    with pymupdf.open(stream=result, filetype="pdf") as document:
        text = "".join(page.get_text() for page in document)
    assert "Maria Conceição" not in text
    assert "Carlos Mendes" not in text
    assert "Relatório de Admissão - Centro Médico Lisboa" in text


@pytest.mark.skipif(not ocr_language(), reason="Tesseract is not installed")
def test_scanned_pdf_erases_the_masked_pixels(scanned_pdf):
    """No text layer: the name is found by OCR and erased from the image."""
    pdf_data = scanned_pdf(["Nome: Ana Correia", "NIF: 123456789"])

    result, unmatched = reconstruct_pdf_with_report(
        pdf_data, [Span(1, "Ana Correia", Category.NAME)]
    )

    assert unmatched == []
    with pymupdf.open(stream=result, filetype="pdf") as document:
        page = document[0]
        ocr = page.get_textpage_ocr(
            language=ocr_language(), dpi=300, full=True,
        )
        seen = page.get_text("text", textpage=ocr)
    assert "Ana" not in seen
    assert "Correia" not in seen
    assert "123456789" in seen
