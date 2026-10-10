from pathlib import Path

import pymupdf
import pytest

from anonymizer.extract import extract_text_from_bytes

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


def test_rotated_sensitive_text_requires_review():
    """Avoid replacing vertical text with an unsafe horizontal mask."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((100, 300), "Ana Correia", rotate=90)
        pdf_data = document.tobytes()

    with pytest.raises(ValueError, match="(?i)review"):
        reconstruct_pdf_with_report(
            pdf_data, [Span(1, "Ana Correia", Category.NAME)]
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
        # Inside the redacted area, left of the centred asterisks.
        pixel = page.get_pixmap().pixel(int(area.x0) + 1, int(area.y1) - 2)
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
