"""Shared contract between the extract, detect and mask steps."""

from dataclasses import dataclass
from enum import Enum


class Category(str, Enum):
    """Kinds of sensitive data. Starting list, refine as we learn."""

    NAME = "NAME"
    ID = "ID"
    CONTACT = "CONTACT"
    DOB = "DOB"
    FINANCIAL = "FINANCIAL"
    HEALTH = "HEALTH"
    SPECIAL = "SPECIAL"
    PRIVATE_LIFE = "PRIVATE_LIFE"
    AGE = "AGE"
    OCCUPATION = "OCCUPATION"
    CLINICIAN = "CLINICIAN"
    SEX = "SEX"


@dataclass(frozen=True)
class Span:
    """One piece of sensitive text found in the document.

    line: 1-based index of the line in the extracted text.
    text: the sensitive text exactly as it appears in that line.
    category: what kind of sensitive data it is.
    reason: short justification, kept for explicability and review.
    """

    line: int
    text: str
    category: Category
    reason: str = ""
