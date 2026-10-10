import pytest

from anonymizer import entities
from anonymizer.spans import Category, Span

TEXT = (
    "Nome: Ana Correia \n"
    "Idade: 34 anos; NIF: 123456789 \n"
    "Contacto: Ana Correia "
)


def span(line, text, category=Category.NAME, reason="r"):
    return Span(line, text, category, reason)


def test_one_entity_per_occurrence_in_document_order():
    found = entities.entities(TEXT, [
        span(3, "Ana Correia"),
        span(1, "Ana Correia"),
        span(2, "123456789", Category.ID),
        span(2, "34", Category.AGE),
    ])

    assert [(e.id, e.type, TEXT[e.start:e.end]) for e in found] == [
        ("entity-1", "NAME", "Ana Correia"),
        ("entity-2", "AGE", "34"),
        ("entity-3", "ID", "123456789"),
        ("entity-4", "NAME", "Ana Correia"),
    ]
    assert all(e.reason == "r" for e in found)


def test_replacement_is_one_star_per_touched_word():
    found = entities.entities("Peso: 72kg, Nome: Rui Tavares ", [
        span(1, "72", Category.HEALTH),
        span(1, "Rui Tavares"),
    ])
    assert [e.replacement for e in found] == ["*", "* *"]


def test_overlapping_occurrences_keep_the_longest():
    found = entities.entities("Dr. Carlos Mendes ", [
        span(1, "Carlos"),
        span(1, "Carlos Mendes", Category.CLINICIAN),
    ])
    assert [(e.type, e.start, e.end) for e in found] == [("CLINICIAN", 4, 17)]


def test_offsets_are_utf16_code_units():
    text = "Nota: 😀 Ana \nFim "
    found = entities.entities(text, [span(1, "Ana")])
    # "😀" is one code point but two UTF-16 units, so JS sees Ana at 9.
    assert (found[0].start, found[0].end) == (9, 12)


def test_mask_selected_masks_only_the_chosen_entities():
    found = entities.entities(TEXT, [
        span(1, "Ana Correia"),
        span(2, "123456789", Category.ID),
        span(3, "Ana Correia"),
    ])
    ids = [e.id for e in found]

    assert entities.mask_selected(TEXT, found, ids) == (
        "Nome: * * \nIdade: 34 anos; NIF: * \nContacto: * * "
    )
    assert entities.mask_selected(TEXT, found, [ids[1]]) == (
        "Nome: Ana Correia \nIdade: 34 anos; NIF: * \nContacto: Ana Correia "
    )
    assert entities.mask_selected(TEXT, found, []) == TEXT


def test_utf16_ranges_become_code_points():
    text = "Nota: 😀 Ana \nFim "
    # JavaScript sees "Ana" at 9..12; in Python it is text[8:11].
    assert entities.code_points(text, 9, 12) == (8, 11)
    assert entities.code_points(text, 6, 8) == (6, 7)      # the emoji
    assert entities.code_points(text, 0, 18) == (0, len(text))


def test_invalid_utf16_ranges_are_rejected():
    text = "Nota: 😀 Ana"    # 12 UTF-16 units, the emoji is 6 and 7
    for start, end in [(-1, 3), (4, 4), (5, 2), (0, 13), (7, 12), (0, 7)]:
        with pytest.raises(ValueError):
            entities.code_points(text, start, end)


def test_a_range_over_a_line_break_gives_one_range_per_line():
    text = "Morada: Rua A,\n12 Lisboa\nFim"
    start, end = text.index("Rua"), text.index(" Lisboa")
    assert entities.line_ranges(text, [(start, end, None)]) == [
        (0, 8, 14, None), (1, 0, 2, None),
    ]
    newline = text.index("\n")
    assert entities.line_ranges(text, [(newline, newline + 1, None)]) == []
    with pytest.raises(ValueError):
        entities.line_ranges(text, [(0, len(text) + 1, None)])


def test_a_range_at_the_start_of_the_text():
    assert entities.line_ranges("Ana\nBeto", [(0, 3, None)]) == [
        (0, 0, 3, None),
    ]
    masked = entities.mask_selected("Ana Rua\nBeto", [], [], [(0, 3, "NAME")])
    assert masked == "* Rua\nBeto"


def test_overlapping_manual_ranges_are_merged():
    text = "Nome: Ana Correia\nFim"
    name = text.index("Ana")
    repeated = [(name, name + 11, "NAME")] * 1000
    overlapping = [(name, name + 3, "NAME"), (name + 2, name + 11, "custom:X")]

    assert entities.manual_ranges(text, repeated) == [
        (0, 6, 17, Category.NAME),
    ]
    assert entities.manual_ranges(text, overlapping) == [
        (0, 6, 17, Category.NAME),
    ]
    assert entities.mask_selected(text, [], [], overlapping) == (
        "Nome: * *\nFim"
    )


def test_manual_ranges_keep_taxonomy_categories_only():
    text = "Nome: Ana\nMatrícula: AB-12"
    manual = [(6, 9, "NAME"), (21, 26, "custom:Matrícula")]
    assert entities.manual_ranges(text, manual) == [
        (0, 6, 9, Category.NAME), (1, 11, 16, None),
    ]
    assert entities.manual_ranges(text, []) == []


def test_manual_range_over_a_line_break_masks_both_lines():
    text = "Morada: Rua A,\n12 Lisboa\nFim"
    manual = [(text.index("Rua"), text.index(" Lisboa"), "CONTACT")]
    assert entities.mask_selected(text, [], [], manual) == (
        "Morada: * *,\n* Lisboa\nFim"
    )


def test_manual_range_masks_only_the_chosen_occurrence():
    text = "Ana e Ana\nAna"
    second = text.index("Ana", 1)
    manual = [(second, second + 3, "NAME")]
    assert entities.mask_selected(text, [], [], manual) == "Ana e *\nAna"


def test_manual_ranges_are_utf16_offsets():
    text = "Nota: 😀 Ana \nFim "
    assert entities.mask_selected(text, [], [], [(9, 12, "NAME")]) == (
        "Nota: 😀 * \nFim "
    )
    with pytest.raises(ValueError):
        entities.mask_selected(text, [], [], [(7, 12, "NAME")])


def test_mask_selected_adds_the_manual_occurrences():
    found = entities.entities(TEXT, [
        span(1, "Ana Correia"),
        span(2, "123456789", Category.ID),
        span(3, "Ana Correia"),
    ])
    age, surname = TEXT.index("34"), TEXT.index("Correia")
    manual = [
        (age, age + 2, "custom:Idade"),
        (surname, surname + 7, "NAME"),     # inside entity-1, selected too
    ]
    selected = ["entity-1", "entity-2"]

    assert entities.mask_selected(TEXT, found, selected, manual) == (
        "Nome: * * \nIdade: * anos; NIF: * \nContacto: Ana Correia "
    )
    assert entities.mask_selected(TEXT, found, selected, []) == (
        entities.mask_selected(TEXT, found, selected)
    )
