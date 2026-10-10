import pytest

from anonymizer import detector, gemini_client
from anonymizer.detector import Detection, DetectedSpan
from anonymizer.spans import Category, Span

TEXT = "Nome: Ana Correia\nContacto: Ana Correia, 912 345 678\nFim"


def found(line, text, category=Category.NAME):
    return DetectedSpan(line=line, text=text, category=category, reason="r")


def test_number_lines():
    assert detector.number_lines("a\nb") == "L001| a\nL002| b"


def test_prompt_has_one_placeholder_and_gets_the_document():
    template = detector.PROMPT_PATH.read_text(encoding="utf-8")
    assert template.count(detector.PLACEHOLDER) == 1

    prompt = detector.build_prompt(TEXT)
    assert detector.PLACEHOLDER not in prompt
    assert "L002| Contacto: Ana Correia, 912 345 678" in prompt


def test_detect_fixes_lines_and_drops_duplicates(monkeypatch):
    answer = Detection(spans=[
        found(1, "Ana Correia"),
        found(1, "Ana Correia"),                       # duplicate
        found(3, "912 345 678", Category.CONTACT),     # wrong line
        found(2, "Rui Tavares"),                       # not in document
        found(1, "  "),                                # empty
    ])
    monkeypatch.setattr(
        gemini_client, "generate_json_raw",
        lambda prompt, schema: (answer, answer.model_dump_json()),
    )

    assert detector.detect(TEXT) == [
        Span(1, "Ana Correia", Category.NAME, "r"),
        Span(2, "912 345 678", Category.CONTACT, "r"),
        Span(2, "Rui Tavares", Category.NAME, "r"),    # kept for mask()
    ]


def test_locate_matches_whole_words_only():
    lines = ["Mariana", "Ana"]
    assert detector._locate([found(1, "Ana")], lines) == [
        Span(2, "Ana", Category.NAME, "r"),
    ]


# Values the PDF wraps onto the next line, and numbers glued to a unit.
WRAPPED = [
    "O cliente refere dores ",
    "lombares fortes desde ontem. Mede ",
    "Altura: 1,68m ",
    "Peso: 72kg ",
]


@pytest.mark.parametrize("llm_line, llm_text", [
    (1, "dores lombares fortes"),        # complete value, start line
    (2, "dores lombares fortes"),        # complete value, end line
    (1, "dores \n lombares fortes"),     # LLM echoes the line break
])
def test_locate_splits_value_across_line_break(llm_line, llm_text):
    spans = detector._locate(
        [found(llm_line, llm_text, Category.HEALTH)], WRAPPED,
    )
    assert spans == [
        Span(1, "dores", Category.HEALTH, "r"),
        Span(2, "lombares fortes", Category.HEALTH, "r"),
    ]


@pytest.mark.parametrize("line, text", [(3, "1,68"), (4, "72")])
def test_locate_keeps_number_glued_to_unit(line, text):
    spans = detector._locate([found(line, text, Category.HEALTH)], WRAPPED)
    assert spans == [Span(line, text, Category.HEALTH, "r")]


DOSES = [
    "Dose anterior: 1500mg ",
    "Nota: dose reduzida ",
    "Prescrição: Losartana 50mg 1x/dia ",
]


def test_locate_prefers_start_of_word_for_partial_match():
    """#9: "50" belongs to "50mg" (line 3), not inside "1500mg" (line 1)."""
    spans = detector._locate([found(2, "50", Category.HEALTH)], DOSES)
    assert spans == [Span(3, "50", Category.HEALTH, "r")]


def test_locate_still_finds_text_inside_a_word():
    spans = detector._locate([found(1, "123", Category.ID)], ["ABC123XYZ"])
    assert spans == [Span(1, "123", Category.ID, "r")]


def test_locate_never_matches_one_character_inside_a_word():
    """A single character stays on the LLM's line for mask() to report."""
    spans = detector._locate([found(2, "5", Category.AGE)], DOSES)
    assert spans == [Span(2, "5", Category.AGE, "r")]


@pytest.mark.parametrize("llm_line, kept_line", [(2, 2), (99, 4)])
def test_locate_keeps_unfound_span_on_llm_line(llm_line, kept_line):
    """Nothing is dropped silently: mask() reports it as unmatched."""
    spans = detector._locate([found(llm_line, "Rui Tavares")], WRAPPED)
    assert spans == [Span(kept_line, "Rui Tavares", Category.NAME, "r")]


def test_generate_json_uses_cache(monkeypatch, tmp_path):
    calls = []

    def fake_call(model, prompt, schema):
        calls.append(prompt)
        return '{"spans": []}'

    monkeypatch.setattr(gemini_client, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(gemini_client, "_call", fake_call)

    first = gemini_client.generate_json("same prompt", Detection)
    second = gemini_client.generate_json("same prompt", Detection)

    assert first == second == Detection(spans=[])
    assert len(calls) == 1
