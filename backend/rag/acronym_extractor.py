"""Auto-extract acronym definitions from paper text using pattern matching.

Looks for patterns like:
  - "Vision-Language Model (VLM)"
  - "(VLM) Vision-Language Model"
  - "VLM, or Vision-Language Model"

No spaCy dependency: uses regex-based extraction which is fast and works
well for academic papers where acronyms are formally introduced.
"""

import re
from collections import Counter

# Pattern: "Full Form (ACRONYM)" or "Full Form [ACRONYM]"
PATTERN_FULL_THEN_ACRO = re.compile(
    r'([A-Z][a-z]+(?:[\s\-]+[A-Za-z]+){1,5})\s*\(([A-Z][A-Z0-9\-]{1,10})\)'
)

# Pattern: "(ACRONYM) Full Form" at start of definition
PATTERN_ACRO_THEN_FULL = re.compile(
    r'\(([A-Z][A-Z0-9\-]{1,10})\)\s+([A-Z][a-z]+(?:[\s\-]+[a-z]+){1,5})'
)

# Pattern: "ACRONYM, or Full Form" / "ACRONYM (Full Form)"
PATTERN_ACRO_OR_FULL = re.compile(
    r'\b([A-Z][A-Z0-9]{1,10}),?\s+(?:or|i\.e\.|that is)\s+([A-Za-z]+(?:[\s\-]+[a-z]+){1,5})'
)


def extract_acronyms_from_text(text: str) -> dict:
    """Extract acronym -> full form mappings from a text block.

    Returns dict of {acronym: full_form}.
    """
    found = {}

    for match in PATTERN_FULL_THEN_ACRO.finditer(text):
        full_form = match.group(1).strip()
        acronym = match.group(2).strip()
        # Validate: acronym letters should roughly match full form initials
        if _validate_acronym(acronym, full_form):
            found[acronym] = full_form

    for match in PATTERN_ACRO_THEN_FULL.finditer(text):
        acronym = match.group(1).strip()
        full_form = match.group(2).strip()
        if _validate_acronym(acronym, full_form):
            found[acronym] = full_form

    for match in PATTERN_ACRO_OR_FULL.finditer(text):
        acronym = match.group(1).strip()
        full_form = match.group(2).strip()
        if len(acronym) >= 2 and len(full_form.split()) >= 2:
            found[acronym] = full_form

    return found


def _validate_acronym(acronym: str, full_form: str) -> bool:
    """Check if acronym plausibly matches the full form.

    E.g., "CNN" should match "Convolutional Neural Network" because
    initials C, N, N match.
    """
    if len(acronym) < 2:
        return False
    words = full_form.split()
    if len(words) < 2:
        return False
    # Check if first letters of words match acronym letters (loosely)
    initials = ''.join(w[0].upper() for w in words if w[0].isupper() or len(w) > 3)
    # Allow partial match (acronym might skip small words like "of", "and")
    match_count = sum(1 for c in acronym.upper() if c in initials)
    return match_count >= len(acronym) * 0.5


def extract_acronyms_from_chunks(chunks_text: list) -> dict:
    """Extract acronyms from a list of chunk texts.

    Returns dict of {acronym: {full_form, count}} sorted by frequency.
    """
    all_acronyms = {}
    counts = Counter()

    for text in chunks_text:
        found = extract_acronyms_from_text(text)
        for acr, full in found.items():
            if acr not in all_acronyms:
                all_acronyms[acr] = full
            counts[acr] += 1

    # Sort by frequency
    result = {}
    for acr, count in counts.most_common():
        result[acr] = {
            'full_form': all_acronyms[acr],
            'count': count,
        }

    return result
