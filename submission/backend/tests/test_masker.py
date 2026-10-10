import unicodedata

from anonymizer.masker import mask, mask_with_positions, runs
from anonymizer.spans import Category, Span


def span(line, text, category=Category.NAME):
    return Span(line=line, text=text, category=category)


# Lines taken from raw_data/document_to_anonymize.pdf.
DOC = "\n".join([
    "A paciente Maria Santos, mulher caucasiana de 47 anos, compareceu "
    "à consulta relatando dores",
    "abdominais intensas. Tem histórico de hipertensão e diabetes tipo 2, "
    "diagnosticada há 5 anos. É",
    "HIV positivo desde 2018, atualmente com carga viral indetectável "
    "graças ao tratamento com",
    "Número do cartão de crédito: 4111 2222 3333 4444 "
    "(validade 09/27, CVV 123)",
    "Rendimento anual declarado: €62.500",
    "Tipo sanguíneo: O+",
    "Nome: António Santos (irmão)",
])

DOC_SPANS = [
    span(1, "Maria Santos"),
    span(1, "caucasiana", Category.SPECIAL),
    span(1, "47", Category.AGE),
    span(1, "dores abdominais intensas", Category.HEALTH),
    span(2, "hipertensão", Category.HEALTH),
    span(2, "diabetes tipo 2", Category.HEALTH),
    span(3, "HIV positivo", Category.HEALTH),
    span(4, "4111 2222 3333 4444", Category.FINANCIAL),
    span(4, "09/27", Category.FINANCIAL),
    span(4, "123", Category.FINANCIAL),
    span(5, "€62.500", Category.FINANCIAL),
    span(6, "O+", Category.HEALTH),
    span(7, "António Santos"),
]


def test_challenge_example():
    assert mask("Nome: Ana Correia", [span(1, "Ana Correia")]) == "Nome: * *"


def test_text_without_spans_is_unchanged():
    text = (
        "Relatório de Admissão - Centro Médico Lisboa\n"
        "Data: 15 de abril de 2025\n"
        "Referência: ADM-2025-04-15-089"
    )
    assert mask(text, []) == text


def test_document_lines():
    assert mask(DOC, DOC_SPANS).split("\n") == [
        "A paciente * *, mulher * de * anos, compareceu "
        "à consulta relatando *",
        "* *. Tem histórico de * e * * *, diagnosticada há 5 anos. É",
        "* * desde 2018, atualmente com carga viral indetectável "
        "graças ao tratamento com",
        "Número do cartão de crédito: * * * * (validade *, CVV *)",
        "Rendimento anual declarado: *",
        "Tipo sanguíneo: *",
        "Nome: * * (irmão)",
    ]


def test_line_and_word_counts_never_change():
    masked = mask(DOC, DOC_SPANS)
    before, after = DOC.split("\n"), masked.split("\n")
    assert len(after) == len(before)
    for original, result in zip(before, after):
        assert len(result.split()) == len(original.split())


def test_values_with_inner_symbols_are_one_word_each():
    text = (
        "Telefone: +351 912 345 678\n"
        "Email: maria.santos@emailpessoal.pt\n"
        "Morada: Rua das Flores, 123, Apt 45, Sacavém, Lisboa\n"
        "Cartão de Cidadão: 12345678-9ZX0"
    )
    spans = [
        span(1, "+351 912 345 678", Category.CONTACT),
        span(2, "maria.santos@emailpessoal.pt", Category.CONTACT),
        span(3, "Rua das Flores, 123, Apt 45, Sacavém, Lisboa",
             Category.CONTACT),
        span(4, "12345678-9ZX0", Category.ID),
    ]
    assert mask(text, spans).split("\n") == [
        "Telefone: * * * *",
        "Email: *",
        "Morada: * * *, *, * *, *, *",
        "Cartão de Cidadão: *",
    ]


def test_punctuation_can_be_masked_too():
    text = "Filhos: 2 (João, 15 anos e Ana, 12 anos)"
    spans = [
        span(1, "João"),
        span(1, "15", Category.AGE),
        span(1, "Ana"),
        span(1, "12", Category.AGE),
    ]
    assert mask(text, spans) == "Filhos: 2 (*, * anos e *, * anos)"
    assert mask(text, spans, keep_punctuation=False) == (
        "Filhos: 2 * * anos e * * anos)"
    )


def test_ages_of_everyone_are_masked():
    text = "\n".join([
        "A paciente Maria Santos, mulher caucasiana de 47 anos,",
        "histórico de cancro da mama (mãe falecida aos 52 anos)",
        "Filhos: 2 (João, 15 anos e Ana, 12 anos)",
        "Tem diabetes tipo 2, diagnosticada há 5 anos.",
    ])
    ages = [
        span(1, "47", Category.AGE),
        span(2, "52", Category.AGE),
        span(3, "15", Category.AGE),
        span(3, "12", Category.AGE),
    ]
    assert mask(text, ages).split("\n") == [
        "A paciente Maria Santos, mulher caucasiana de * anos,",
        "histórico de cancro da mama (mãe falecida aos * anos)",
        "Filhos: 2 (João, * anos e Ana, * anos)",
        "Tem diabetes tipo 2, diagnosticada há 5 anos.",
    ]


def test_characters_between_numbers_stay_in_one_word():
    text = (
        "Hábitos: consome álcool socialmente (2-3 doses por semana)\n"
        "Pressão arterial na admissão: 145/90 mmHg"
    )
    spans = [
        span(1, "2-3", Category.PRIVATE_LIFE),
        span(2, "145/90", Category.HEALTH),
    ]
    assert mask(text, spans).split("\n") == [
        "Hábitos: consome álcool socialmente (* doses por semana)",
        "Pressão arterial na admissão: * mmHg",
    ]


def test_span_text_with_surrounding_punctuation():
    text = "Nome: António Santos (irmão)"
    assert mask(text, [span(1, " António Santos, ")]) == "Nome: * * (irmão)"


def test_mixed_punctuation_around_span_text():
    text = "Nome: António Santos (irmão)"
    assert mask(text, [span(1, "António Santos, )")]) == "Nome: * * (irmão)"
    empty = span(1, "« : »", Category.SEX)
    result = mask_with_positions("Sexo: Feminino", [empty])
    assert result.text == "Sexo: Feminino"
    assert result.unmatched == [empty]


def test_whole_words_only():
    text = "Quarto 2, cama 12"
    assert mask(text, [span(1, "2", Category.ID)]) == "Quarto *, cama 12"


def test_every_occurrence_in_the_line():
    assert mask("Santos e Santos", [span(1, "Santos")]) == "* e *"


def test_overlapping_occurrences_are_all_masked():
    spans = [span(1, "912 912", Category.CONTACT)]
    assert mask("Telefone: 912 912 912", spans) == "Telefone: * * *"


def test_decomposed_accents_belong_to_their_word():
    def nfd(text):
        return unicodedata.normalize("NFD", text)

    assert mask(nfd("Nome: Andréa e André"), [span(1, nfd("André"))]) == (
        nfd("Nome: Andréa e *")
    )
    assert mask(nfd("Nome: José e Jose"), [span(1, "Jose")]) == (
        nfd("Nome: José e *")
    )


def test_part_of_a_word_masks_the_whole_word():
    text = "\n".join([
        "Altura: 1,68m",
        "Peso: 72kg",
        "Prescrição: Metformina 850mg 2x/dia, Losartana 50mg 1x/dia",
    ])
    spans = [
        span(1, "1,68", Category.HEALTH),
        span(2, "72", Category.HEALTH),
        span(3, "Losartana 50", Category.HEALTH),
    ]
    assert mask(text, spans).split("\n") == [
        "Altura: *",
        "Peso: *",
        "Prescrição: Metformina 850mg 2x/dia, * * 1x/dia",
    ]


def test_part_of_a_word_prefers_the_start_of_a_word():
    text = "Metformina 850mg, Losartana 50mg"
    assert mask(text, [span(1, "50", Category.HEALTH)]) == (
        "Metformina 850mg, Losartana *"
    )


def test_text_inside_a_word_masks_that_word():
    assert mask("Código ABC123XYZ", [span(1, "123", Category.ID)]) == (
        "Código *"
    )


def test_a_single_letter_is_never_looked_for_inside_words():
    stray = span(1, "a")
    result = mask_with_positions("Mariana e Anabela", [stray])
    assert result.text == "Mariana e Anabela"
    assert result.unmatched == [stray]


def test_overlapping_spans_mask_each_word_once():
    spans = [span(1, "Maria Santos"), span(1, "Santos")]
    assert mask("Nome: Maria Santos", spans) == "Nome: * *"


def test_spacing_is_preserved():
    text = "Telefone:  +351  912\t345 678"
    spans = [span(1, "+351 912 345 678", Category.CONTACT)]
    assert mask(text, spans) == "Telefone:  *  *\t* *"


def test_trailing_newline_is_preserved():
    assert mask("Nome: Ana\n", [span(1, "Ana")]) == "Nome: *\n"


def test_span_across_a_line_break():
    text = "relatando dores\nabdominais intensas. Tem histórico"
    expected = "relatando *\n* *. Tem histórico"
    for line in (1, 2):
        spans = [span(line, "dores abdominais intensas", Category.HEALTH)]
        assert mask(text, spans) == expected


def test_line_break_occurrence_after_an_earlier_one():
    spans = [span(2, "João João")]
    result = mask_with_positions("Pai: João João\nJoão Silva", spans)
    assert result.text == "Pai: João *\n* Silva"
    assert result.unmatched == []


def test_span_not_found_is_reported_and_not_masked():
    text = "Nome: Ana Correia"
    missing = span(1, "Joana Pereira")
    bad_line = span(5, "Ana")
    result = mask_with_positions(text, [missing, bad_line])
    assert result.text == text
    assert result.unmatched == [missing, bad_line]


def test_positions_point_at_each_star():
    text = "Nome: Ana Correia\nIdade: 47 anos"
    spans = [span(1, "Ana Correia"), span(2, "47", Category.AGE)]
    result = mask_with_positions(text, spans)
    assert result.text == "Nome: * *\nIdade: * anos"
    assert [(w.line, w.column, w.category) for w in result.words] == [
        (1, 6, Category.NAME),
        (1, 8, Category.NAME),
        (2, 7, Category.AGE),
    ]


def test_masked_words_know_their_original_word():
    text = "Filhos: 2 (João, 15 anos e Ana, 12 anos)"
    spans = [span(1, "João"), span(1, "15", Category.AGE)]
    joao, age = mask_with_positions(text, spans).words
    assert (joao.index, joao.word) == (2, "(João,")
    assert text[joao.start:joao.end] == "(João,"
    assert (age.index, age.word, text[age.start:age.end]) == (3, "15", "15")
    # The same word index PyMuPDF gives to the words of this line.
    assert text.split()[joao.index] == "(João,"


def test_runs_group_consecutive_masked_words():
    text = "A paciente Maria Santos, mulher caucasiana de 47 anos"
    spans = [
        span(1, "Maria Santos"),
        span(1, "caucasiana", Category.SPECIAL),
        span(1, "47", Category.AGE),
    ]
    grouped = runs(mask_with_positions(text, spans).words)
    assert [(r.first, r.last) for r in grouped] == [(2, 3), (5, 5), (7, 7)]
    assert grouped[0].categories == [Category.NAME, Category.NAME]
    assert [w.word for w in grouped[0].words] == ["Maria", "Santos,"]


def test_runs_never_cross_lines():
    text = "Nome: Ana\nCorreia Silva"
    spans = [span(1, "Ana"), span(2, "Correia Silva")]
    grouped = runs(mask_with_positions(text, spans).words)
    assert [(r.line, r.first, r.last) for r in grouped] == [
        (1, 1, 1), (2, 0, 1),
    ]


def test_runs_split_on_an_unmasked_word():
    text = "Filhos: 2 (João, 15 anos e Ana, 12 anos)"
    spans = [
        span(1, "2", Category.PRIVATE_LIFE),
        span(1, "João"), span(1, "15", Category.AGE),
        span(1, "Ana"), span(1, "12", Category.AGE),
    ]
    grouped = runs(mask_with_positions(text, spans).words)
    assert [(r.first, r.last) for r in grouped] == [(1, 3), (6, 7)]
    assert runs([]) == []


def test_positions_match_the_masked_text():
    result = mask_with_positions(DOC, DOC_SPANS)
    lines = result.text.split("\n")
    assert all(lines[w.line - 1][w.column] == "*" for w in result.words)
    assert len(result.words) == result.text.count("*")
    assert result.unmatched == []
