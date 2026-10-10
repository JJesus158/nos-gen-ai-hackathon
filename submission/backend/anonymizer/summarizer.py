"""Readable summary of an anonymized document. Owner: feature/summary.

The model only ever sees mask()'s output: every hidden word is already
a "*" when the prompt is built, so the summary cannot repeat it. As a
last check, a hidden word that the model could only have guessed is
scrubbed from the summary.
"""

import re
from typing import Optional, Set
from urllib.parse import unquote

from pydantic import BaseModel

from anonymizer import gemini_client, masker

LANGUAGES = {
    "pt-PT": "European Portuguese",
    "en": "English",
}

PROMPT = """<role>
You rewrite anonymized documents so that they read naturally.
</role>

<task>
In the document below every sensitive word was replaced by "*" (one "*"
per hidden word). Rewrite the document as a clear, readable summary that
keeps its purpose, its structure and every fact that is still visible,
and leaves out everything that was hidden.
</task>

<rules>
- Never guess, reconstruct or hint at a hidden value. Refer to hidden
  people and things generically ("the patient", "a relative", "the
  address given").
- Do not copy any "*" into the summary: say it generically or leave the
  detail out. Do not say that words were hidden, except once and briefly
  when a whole section is hidden.
- Spell words normally, with their accents ("relatório", "admissão");
  never escape or percent-encode any character.
- Keep headings and labels that carry no personal data, and keep the
  dates, amounts and institutions that are still visible.
- Write in {{LANGUAGE}}, in short paragraphs; a list is fine for a list
  of items.
- Aim for about a quarter of the original length.
</rules>

<document>
{{DOCUMENT}}
</document>

Return JSON: {"summary": "<the summary>"}"""


class Summary(BaseModel):
    summary: str


def build_prompt(masked_text: str, language: Optional[str] = None) -> str:
    """The prompt for a masked text; language is a code of LANGUAGES."""
    name = LANGUAGES.get(language or "", "the language of the document")
    return PROMPT.replace("{{LANGUAGE}}", name).replace(
        "{{DOCUMENT}}", masked_text,
    )


def summarize(masked: masker.MaskResult,
              language: Optional[str] = None) -> str:
    """The masked document rewritten as a readable summary.

    Only masked.text reaches the model. ValueError if it answers nothing.
    """
    prompt = build_prompt(masked.text, language)
    summary = gemini_client.generate_json(prompt, Summary).summary
    summary = _without_stars(_decode(summary)).strip()
    if not summary:
        raise ValueError("The model returned an empty summary")
    return scrub(summary, hidden_words(masked))


def _without_stars(summary: str) -> str:
    """A "*" the model copied from the text says nothing: drop it, with
    the space before it ("do sexo *, de" -> "do sexo, de")."""
    return re.sub(r" ?\*+", "", summary)


def _decode(summary: str) -> str:
    """Some models percent-encode accents in their JSON ("Relat%C3%B3rio");
    undo it when every %XX decodes as UTF-8, else leave the text alone."""
    if not re.search(r"%[0-9A-Fa-f]{2}", summary):
        return summary
    try:
        return unquote(summary, errors="strict")
    except UnicodeDecodeError:
        return summary


def hidden_words(masked: masker.MaskResult) -> Set[str]:
    """Words the model never saw: the masked ones, lowercased and without
    their edge punctuation, minus any that stay visible elsewhere in the
    text (a masked "Lisboa" in the address is still in the hospital's
    name) and one-character ones."""
    visible = {_core(token).lower() for token in masked.text.split()}
    hidden = {_core(word.word).lower() for word in masked.words}
    return {word for word in hidden - visible if len(word) >= 2}


def scrub(summary: str, hidden: Set[str]) -> str:
    """Every hidden word still in the summary becomes "*"; the sentence
    punctuation around it stays, like mask() does."""
    if not hidden:
        return summary

    def replace(match: re.Match) -> str:
        token = match.group()
        start, end = masker._trim(token, 0, len(token))
        if token[start:end].lower() in hidden:
            return token[:start] + masker.MASK + token[end:]
        return token

    return masker._WORD.sub(replace, summary)


def _core(token: str) -> str:
    start, end = masker._trim(token, 0, len(token))
    return token[start:end]
