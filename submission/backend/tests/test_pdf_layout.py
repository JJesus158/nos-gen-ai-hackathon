"""Regression tests for the API offset -> original PDF geometry mapping."""
from pathlib import Path

import pymupdf
import pytest
from fastapi.testclient import TestClient

from anonymizer import detector
from anonymizer.extract import extract_layout_from_bytes
from anonymizer.spans import Category, Span
from api import main

SAMPLE = Path(__file__).resolve().parents[3] / 'raw_data/document_to_anonymize.pdf'


def utf16(value):
    return len(value.encode('utf-16-le')) // 2


def range_for(text, value, after=0):
    index = text.index(value, after)
    return utf16(text[:index]), utf16(text[:index + len(value)])


def box_text(document, box):
    page = document[box['page'] - 1]
    rect = pymupdf.Rect(box['x'], box['y'],
                       box['x'] + box['width'], box['y'] + box['height'])
    return page.get_textbox(rect * page.transformation_matrix).strip()


def test_sample_text_is_unchanged_and_every_visible_character_has_an_offset():
    layout = extract_layout_from_bytes(SAMPLE.read_bytes())
    with pymupdf.open(SAMPLE) as document:
        previous_text = '\n'.join(
            line.rstrip() for page in document
            for line in page.get_text('text', sort=False).split('\n') if line.strip()
        )
    assert layout.text == previous_text
    encoded = layout.text.encode('utf-16-le')
    for char in layout.characters:
        assert encoded[char.start * 2:char.end * 2].decode('utf-16-le') == char.text
        if not char.text.isspace():
            assert layout.boxes_for(char.start, char.end)


@pytest.mark.parametrize('value', [
    'Maria Conceição Oliveira Santos', '12/03/1978', '097865413',
    '12345678-9ZX0', 'Rua das Flores, 123, Apt 45, Sacavém, Lisboa',
    '+351 912 345 678', 'maria.santos@emailpessoal.pt', '11223344556',
])
def test_api_sample_boxes_cover_the_exact_value_not_its_first_word(monkeypatch, value):
    layout = extract_layout_from_bytes(SAMPLE.read_bytes())
    start, end = range_for(layout.text, value)
    line = layout.text[:layout.text.index(value)].count('\n') + 1
    monkeypatch.setattr(detector, 'detect', lambda text: [Span(line, value, Category.ID, '')])
    response = TestClient(main.app).post('/api/documents/analyze', files={
        'file': ('sample.pdf', SAMPLE.read_bytes(), 'application/pdf'),
    })
    assert response.status_code == 200
    entity = response.json()['entities'][0]
    assert (entity['start'], entity['end']) == (start, end)
    assert len(entity['boxes']) == 1
    box = entity['boxes'][0]
    assert (box['start'], box['end']) == (start, end)
    with pymupdf.open(SAMPLE) as document:
        assert box_text(document, box) == value


def test_identical_values_on_same_line_different_lines_and_pages_are_distinct():
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), 'Nome: Ana; Contacto: Ana')
        page.insert_text((72, 100), 'Nome: Ana')
        document.new_page().insert_text((72, 72), 'Nome: Ana')
        layout = extract_layout_from_bytes(document.tobytes())
        positions, cursor = [], 0
        for _ in range(4):
            start, end = range_for(layout.text, 'Ana', cursor)
            cursor = end
            box, = layout.boxes_for(start, end)
            assert box_text(document, box) == 'Ana'
            positions.append((box['page'], box['x'], box['y']))
        assert len(set(positions)) == 4
        assert positions[-1][0] == 2


def test_multiline_field_has_separate_boxes_and_preserves_punctuation():
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), 'Morada: Rua Nova, 12')
        page.insert_text((72, 100), 'Lisboa')
        layout = extract_layout_from_bytes(document.tobytes())
        boxes = layout.boxes_for(*range_for(layout.text, 'Rua Nova, 12\nLisboa'))
        assert [box_text(document, box) for box in boxes] == ['Rua Nova, 12', 'Lisboa']
        assert boxes[0]['end'] + 1 == boxes[1]['start']


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_cropped_rotated_pages_use_native_pdf_coordinates(rotation):
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((100, 100), 'Nome: Ana')
        original = extract_layout_from_bytes(document.tobytes())
        expected, = original.boxes_for(*range_for(original.text, 'Ana'))
        page.set_cropbox(pymupdf.Rect(40, 40, 500, 700))
        page.set_rotation(rotation)
        layout = extract_layout_from_bytes(document.tobytes())
        box, = layout.boxes_for(*range_for(layout.text, 'Ana'))
        assert box == pytest.approx(expected)
        page.set_rotation(0)
        assert box_text(document, box) == 'Ana'


def test_unicode_offsets_include_two_utf16_units_for_non_bmp_characters():
    # A rawdict glyph can contain a supplementary Unicode character. Verify the
    # extractor retains JS offsets instead of indexing that string as Python.
    from anonymizer.extract import _extract_layout

    class Page:
        transformation_matrix = pymupdf.Matrix(1, 0, 0, -1, 0, 800)
        rotation = 0

        def set_rotation(self, rotation):
            self.rotation = rotation

        def get_text(self, *args, **kwargs):
            return {'blocks': [{'type': 0, 'lines': [{'spans': [{'chars': [
                {'c': char, 'bbox': (10 * i, 20, 10 * i + 10, 30)}
                for i, char in enumerate('😀 Nome: João  ')
            ]}]}]}]}

    layout = _extract_layout([Page()])
    assert layout.text == '😀 Nome: João'
    box, = layout.boxes_for(9, 13)
    assert (box['start'], box['end'], box['x'], box['width']) == (9, 13, 80, 40)
