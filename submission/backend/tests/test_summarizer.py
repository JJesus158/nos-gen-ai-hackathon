import json

from anonymizer import gemini_client, masker, summarizer
from anonymizer.spans import Category, Span

TEXT = (
    "Relatório - Centro Médico Lisboa\n"
    "Nome: Ana Correia (34 anos)\n"
    "Morada: Rua das Flores, Lisboa\n"
    "Histórico: diabetes há 5 anos"
)
SPANS = [
    Span(2, "Ana Correia", Category.NAME),
    Span(2, "34", Category.AGE),
    Span(3, "Rua das Flores, Lisboa", Category.CONTACT),
]


def test_prompt_holds_the_masked_text_and_the_language():
    masked = masker.mask(TEXT, SPANS)
    prompt = summarizer.build_prompt(masked, "pt-PT")
    assert masked in prompt
    assert "Ana" not in prompt and "Flores" not in prompt
    assert "Write in European Portuguese" in prompt
    assert "Write in English" in summarizer.build_prompt(masked, "en")
    assert "the language of the document" in summarizer.build_prompt(masked)


def test_hidden_words_leave_out_what_is_still_visible():
    masked = masker.mask_with_positions(TEXT, SPANS)
    # "Lisboa" and "anos" are masked on one line but visible on another.
    assert summarizer.hidden_words(masked) == {
        "ana", "correia", "34", "rua", "das", "flores",
    }


def test_scrub_masks_hidden_words_and_keeps_punctuation():
    hidden = {"ana", "correia", "flores"}
    assert summarizer.scrub(
        "A paciente, Ana Correia, mora na Rua das Flores.", hidden,
    ) == "A paciente, * *, mora na Rua das *."
    assert summarizer.scrub("Sem nomes.", hidden) == "Sem nomes."
    assert summarizer.scrub("Qualquer texto", set()) == "Qualquer texto"


def test_summarize_sends_only_the_masked_text(monkeypatch):
    prompts = []

    def fake_call(model, prompt, schema):
        prompts.append(prompt)
        return json.dumps(
            {"summary": "  Relatório de uma paciente de Lisboa. "},
        )

    monkeypatch.setattr(gemini_client, "_call", fake_call)
    masked = masker.mask_with_positions(TEXT, SPANS)

    assert summarizer.summarize(masked, "pt-PT") == (
        "Relatório de uma paciente de Lisboa."
    )
    assert len(prompts) == 1
    assert "Ana" not in prompts[0] and "Flores" not in prompts[0]
    assert "Nome: * * (* anos)" in prompts[0]


def test_summarize_decodes_percent_encoded_accents(monkeypatch):
    answers = iter([
        {"summary": "Relat%C3%B3rio de admiss%C3%A3o, 50%25 conclu%C3%ADdo."},
        {"summary": "Taxa de 50%2 e 100%zz."},
    ])
    monkeypatch.setattr(
        gemini_client, "_call", lambda m, p, s: json.dumps(next(answers)),
    )
    masked = masker.mask_with_positions(TEXT, SPANS)

    assert summarizer.summarize(masked) == (
        "Relatório de admissão, 50% concluído."
    )
    # Not an encoding: left as it is.
    assert summarizer.summarize(masked, "en") == "Taxa de 50%2 e 100%zz."


def test_summarize_drops_stars_the_model_copied(monkeypatch):
    monkeypatch.setattr(gemini_client, "_call", lambda m, p, s: json.dumps(
        {"summary": "Paciente do sexo *, assinado * por um clínico. **"}))
    masked = masker.mask_with_positions(TEXT, SPANS)

    assert summarizer.summarize(masked) == (
        "Paciente do sexo, assinado por um clínico."
    )


def test_summarize_scrubs_a_guessed_name_and_rejects_nothing(monkeypatch):
    answers = iter([{"summary": "A paciente Ana vive em Lisboa."},
                    {"summary": " * "}])
    monkeypatch.setattr(
        gemini_client, "_call", lambda m, p, s: json.dumps(next(answers)),
    )
    masked = masker.mask_with_positions(TEXT, SPANS)

    assert summarizer.summarize(masked) == "A paciente * vive em Lisboa."
    try:
        summarizer.summarize(masked, "en")
    except ValueError:
        pass
    else:
        raise AssertionError("an empty summary must be an error")
