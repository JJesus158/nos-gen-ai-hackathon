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
