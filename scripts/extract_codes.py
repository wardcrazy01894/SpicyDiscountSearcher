#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl>=3.1"]
# ///
"""Convert the corporate-codes workbook into src/data/codes.generated.json.

The workbook is a human-maintained spreadsheet: codes live in loosely typed
cells that mix several codes per cell ("A541100 or A541105"), carry
parenthetical asides ("5232 (PCW - yes the W and C are flipped)"), sometimes
hold a booking URL instead of a code, and get mangled into floats by Excel
("260290.0"). Everything below exists to turn that into clean records.

Run:  ./scripts/extract_codes.py
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
WORKBOOK = ROOT / "data" / "source" / "Hotel & Car Rental Corporate Codes.xlsx"
OUT = ROOT / "src" / "data" / "codes.generated.json"

# Sheet -> ordered vendor id per column, starting at column B (column A is the
# company name). `None` skips a column (comments, duplicate Hyatt column, ...).
SHEET_LAYOUTS: dict[str, list[str | None]] = {
    "Corp Codes": [
        "hilton",
        "marriott",
        "hyatt",
        None,  # duplicate Hyatt column
        "hertz",
        "avis",
        "budget",
        "enterprise",  # header reads "Enterprise / National"; shared contract ids
        "sixt",
        None,  # Comments
    ],
    "Codes": ["starwood", "marriott", "hilton", "hyatt", "hertz", "avis"],
    "Marriott Codes": ["starwood", "marriott", "hilton", "hyatt", "hertz", "avis"],
}

# Tokens that survive the shape check but are obviously prose, not codes.
STOPWORDS = {
    "OR",
    "AND",
    "THE",
    "YES",
    "NO",
    "N/A",
    "NA",
    "NONE",
    "TBD",
    "X",
    "CODE",
    "RATE",
    "KEY",
    "ACCOUNT",
    "NUMBER",
    "CORP",
    "CORPORATE",
    "ID",
    "NEW",
    "OLD",
    "USE",
    "ONLY",
}

URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
PAREN_RE = re.compile(r"\(([^)]*)\)")
CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9+\-]{1,15}$")


def clean_cell(raw: object) -> str:
    """Normalise a raw cell into a trimmed string, undoing Excel's float coercion."""
    if raw is None:
        return ""
    text = str(raw).strip()
    # Excel turns numeric-looking codes into floats: 260290.0 -> 260290.
    if re.fullmatch(r"\d+\.0", text):
        text = text[:-2]
    return re.sub(r"\s+", " ", text)


def looks_like_code(token: str, *, allow_letters_only: bool = True) -> bool:
    token = token.upper()
    if token in STOPWORDS or not CODE_RE.fullmatch(token):
        return False
    if any(ch.isdigit() for ch in token):
        return True
    # Letter-only codes are real (Marriott uses ACC, DTC, MMM) but they also
    # match ordinary words, so callers disable them for prose-heavy cells where
    # "Hampton Inn" would otherwise yield a bogus INN code.
    return allow_letters_only and len(token) <= 4


def tokenize(text: str) -> list[str]:
    # `or` first so "A541100 or A541105" survives; then slashes and commas,
    # then whitespace for cells like "D486600 TH15900".
    parts = re.split(r"\bor\b|[/,;]|\s+", text, flags=re.IGNORECASE)
    return [tok for tok in (p.strip(" .:*-") for p in parts) if tok]


def split_codes(text: str) -> tuple[list[str], list[str]]:
    """Return (codes, leftover prose tokens) for one cell's text.

    A cell that is nothing but code-shaped tokens is trusted completely. Once
    prose appears, letter-only tokens stop counting as codes, because a cell
    like "Hampton Inn, Homewood Suites" is a brand list, not a code list.
    """
    tokens = tokenize(text)
    prose = [
        tok
        for tok in tokens
        if not looks_like_code(tok) and tok.upper() not in STOPWORDS
    ]
    allow_letters_only = not prose
    codes: list[str] = []
    for token in tokens:
        code = token.upper()
        if looks_like_code(code, allow_letters_only=allow_letters_only):
            if code not in codes:
                codes.append(code)
    return codes, prose


def parse_cell(text: str) -> tuple[list[str], str | None, str | None]:
    """Return (codes, note, url) for one spreadsheet cell."""
    if not text:
        return [], None, None

    url_match = URL_RE.search(text)
    url = url_match.group(0).rstrip(".,;") if url_match else None
    if url:
        text = URL_RE.sub(" ", text)

    # Extract parentheticals before splitting: they often contain '/' and 'or',
    # e.g. "92836100 (Doubletree, Embassy Suites, Hampton)".
    notes = [n.strip() for n in PAREN_RE.findall(text) if n.strip()]
    text = PAREN_RE.sub(" ", text)

    codes, prose = split_codes(text)
    # Whatever the cell said that wasn't a code is still useful context
    # ("Doubletree, Embassy Suites only"), so keep it as a note in its original
    # casing rather than the uppercased token form.
    leftover = " ".join(prose).strip(" .:*-")
    if leftover:
        notes.append(leftover)

    note = "; ".join(dict.fromkeys(notes)) or None
    return codes, note, url


# Marks of a remark rather than an employer, whatever its length. Tested
# against the *name*, so a qualifier is still lifted rather than condemning the
# whole cell: "Nestle (100% subsidiary)" is Nestle with a note.
REMARK_RE = re.compile(
    r"^[A-Za-z]+:"  # "NOTE: have not been confirmed"
    r"|%"  # nobody writes a percentage into their own name
    r"|\bYMMV\b",
    re.IGNORECASE,
)

# Tested against the original, because stripping decoration removes the very
# dots that make an ellipsis recognisable.
ELLIPSIS_RE = re.compile(r"\.{2,}")

# A sentence boundary: lowercase, full stop, capital. Case-sensitive on
# purpose — with IGNORECASE this also matched "St. Jude Medical", because
# [a-z]{2} then happily accepted "St".
SENTENCE_RE = re.compile(r"[a-z]{2}\.\s+[A-Z]")

# How many words before a sentence boundary means prose rather than a name.
# "Sun Microsystems Inc. USA" is four words and a legitimate employer.
SENTENCE_WORDS = 5

# Longer than any employer writes its own name.
MAX_NAME_WORDS = 8

# A bare number leading the company column is a code someone typed one cell to
# the left. Six digits minimum, so "1-800 Contacts", "1901 Group" and "24-7
# Intouch" keep their names.
LEADING_CODE_RE = re.compile(r"^(\d[\d-]{5,})\s+(.*)$")

# Separators and decoration left behind once a parenthetical comes out, e.g.
# "Booz & Co (Now Strategy&) ///".
NAME_EDGE = " -–—/*.,;:"

# Where codes go when the cell beside them was a remark, not an employer. They
# are still real codes; only the attribution was invented.
UNATTRIBUTED = "Unattributed"

# Rows the parser looked at and could not use. Every `continue` below is a
# decision to drop somebody's data, and until now each was silent: the summary
# at the end counts what was *kept*, so a change that quietly lost forty
# employers still printed a healthy-looking total. "Benjamin Moore" was lost
# this way for the entire life of the file. Reported to stderr, so the `data`
# job shows it and a reviewer can see the number move.
SKIPPED: list[str] = []

# Words that appear before an employer's name on the Hilton sheet and are not
# part of it. A list of known typos rather than a shape rule: "short lowercase
# word" would also strip the particles out of "de Beers" and "el Corte Ingles".
LEADING_TYPOS = {"is"}

# An account or N-number, as opposed to an employer whose name happens to be
# code-shaped ("3M", "BP", "UTC"). Six digits matches LEADING_CODE_RE, which
# makes the same call about the same kind of token.
# [0-9] rather than \d: \d is Unicode-wide in Python, so Arabic-Indic digits
# would match here while CODE_RE (ASCII-only) rejects them, and the two need to
# agree about what a number is.
ACCOUNT_NUMBER_RE = re.compile(r"[Nn]?[0-9]{6,}")


def parse_company(text: str) -> tuple[str | None, str | None]:
    """Split a company cell into a name and whatever qualified it.

    The workbook's first column is a name column by convention only. It also
    holds parenthetical asides ("CareerBuilder (Americas Only)"), stray codes,
    and outright prose — and every one of those became a company in its own
    right, published in the extension's picker as though it were an employer.

    Returns (None, original) when the cell is not a name at all. The codes
    beside it are usually real — "(LON, AMS)" and "(Americas only)" qualify a
    perfectly good Hilton rate — so the caller files them under UNATTRIBUTED
    and keeps the original text as the note. Dropping them would throw away
    working codes to fix a naming problem.
    """
    if not text:
        return None, None

    notes: list[str] = []

    def take(match: re.Match[str]) -> str:
        notes.append(match.group(1).strip())
        return " "

    name = (
        re.sub(r"\s+", " ", re.sub(r"\(([^)]*)\)", take, text)).strip(NAME_EDGE).strip()
    )

    while True:
        leading = LEADING_CODE_RE.match(name)
        if not leading:
            break
        notes.append(leading.group(1))
        name = leading.group(2).strip()

    words = name.split()
    # Nothing left once the qualifiers came out, an outright remark, too long
    # for a name, or sentence-shaped *and* long enough that the stop is not an
    # abbreviation. A lowercase-first rule used to live here too; it rejected
    # "eBay Enterprise Global" and caught nothing these do not.
    prose = (
        not name
        or ELLIPSIS_RE.search(text)
        or REMARK_RE.search(name)
        or len(words) > MAX_NAME_WORDS
        or (SENTENCE_RE.search(name) and len(words) > SENTENCE_WORDS)
    )
    if prose:
        return None, re.sub(r"\s+", " ", text).strip()

    return name, "; ".join(n for n in notes if n) or None


def parse_hilton_sheet(rows: list[tuple[object, ...]]) -> list[dict]:
    """The 'Hilton Code' sheet is free text: 'N0001542 / 0232757100 3M'.

    Leading code-shaped tokens belong to Hilton; the remainder is the company.

    Every code on this sheet carries a digit -- the whole sheet is
    "N-number / account-number Employer". Letter-only tokens are therefore
    never codes here, they are the first words of the employer's name, so this
    is the one caller that must switch that branch off. Leaving it on ate
    'BANK' and 'OF' out of "Bank of America", merged "Koch Industries" and
    "Shaw Industries" into a single company called "Industries", and dropped
    "BP", "Dell" and "UPS" entirely -- their names are *nothing but*
    code-shaped words, so the loop consumed the row and left no company at all.
    """
    records: list[dict] = []
    for row in rows:
        line = clean_cell(row[0] if row else None)
        if not line:
            continue
        tokens = [t for t in re.split(r"[/\s]+", line) if t]
        # A single stray character ahead of the codes is decoration, not data:
        # row 24 reads "à / 560002892 Benjamin Moore and Company", and bailing
        # on it collected no codes and skipped a real employer. CODE_RE needs
        # two characters, so a one-character token can never be a code and no
        # further test is needed -- "3M" is two.
        if tokens and len(tokens[0]) == 1:
            tokens = tokens[1:]
        codes: list[str] = []
        idx = 0
        # Never consume the last token. Every row on this sheet ends with the
        # employer, so a row whose name is *entirely* code-shaped has nothing
        # left to be the company and gets dropped wholesale. That is how "3M" --
        # the example in this very docstring -- lost both its Hilton codes.
        # ("BP", "Dell" and "UPS" were lost the same way but are recovered by
        # the letters-only rule above, since none of them carries a digit; 3M
        # does, so it needs this.) Reserving the final token is safe because a
        # row that is nothing but codes is not a row this sheet contains -- and
        # if one ever appears, it is reported below rather than published with a
        # code as its company name.
        while idx < len(tokens) - 1 and looks_like_code(
            tokens[idx].upper(), allow_letters_only=False
        ):
            code = tokens[idx].upper()
            if code not in codes:
                codes.append(code)
            idx += 1
        # Same treatment as the grid sheets: this column is free text, so it
        # also holds bare qualifiers ("(Americas only)") and outright prose,
        # every one of which became its own company in the picker.
        rest = tokens[idx:]
        # One known typo in the source, named rather than described: row 30
        # reads "... 560047583 is Campbell Hausfield and Powerex". A general
        # "short lowercase word" rule would also eat the particles in real
        # names -- "de Beers", "von der Heyden", "el Corte Ingles" -- so the
        # rule is a list, and adding to it is a decision somebody makes.
        while rest and rest[0].lower() in LEADING_TYPOS:
            rest = rest[1:]
        # Nothing but codes: reserving the last token above would otherwise
        # publish it as the company name and lose it as a code. No such row
        # exists in the workbook today; this is here so that if one appears it
        # is reported rather than quietly turned into a fictitious employer.
        #
        # Tested against the account-number shape, not against `looks_like_code`
        # — every real employer here is code-shaped enough to pass that, which
        # is the whole reason the last token is reserved. "3M" is a company;
        # "0232757100" is an account. Six digits is the same floor
        # LEADING_CODE_RE uses for the same judgement.
        if len(rest) == 1 and ACCOUNT_NUMBER_RE.fullmatch(rest[0]):
            SKIPPED.append(f"Hilton Code (no employer): {line[:80]}")
            continue
        company, note = parse_company(" ".join(rest).strip(" -–—"))
        if not codes or (not company and not note):
            SKIPPED.append(f"Hilton Code: {line[:80]}")
            continue
        if not company:
            company = UNATTRIBUTED
        for code in codes:
            records.append(
                {
                    "company": company,
                    "vendor": "hilton",
                    "code": code,
                    "note": note,
                    "url": None,
                    "source": "Hilton Code",
                }
            )
    return records


def parse_grid_sheet(name: str, rows: list[tuple[object, ...]]) -> list[dict]:
    layout = SHEET_LAYOUTS[name]
    records: list[dict] = []
    # enumerate from 2: row 0 is the header, and spreadsheet rows are 1-based,
    # so this is the number you type into the Name Box to find the row.
    for index, row in enumerate(rows[1:], start=2):
        raw_company = clean_cell(row[0] if row else None)
        # The 'Corp Codes' header cell doubles as a stray Hilton link; skip
        # anything that isn't a plain company name.
        if not raw_company:
            continue
        if URL_RE.search(raw_company):
            # Reported rather than dropped in silence. Nothing is lost to these
            # today -- three of the four have no codes beside them, and the
            # fourth duplicates a row on another sheet -- but a URL row that
            # carried the only copy of a code would vanish exactly the way
            # Benjamin Moore did, and the summary would still look healthy.
            # The count of codes is what tells those two apart, so say it.
            codes_here = sum(
                len(parse_cell(clean_cell(row[col]))[0])
                for col in range(1, len(row))
                if col - 1 < len(layout) and layout[col - 1]
            )
            SKIPPED.append(
                f"{name} row {index} (url in the name column, "
                f"{codes_here} code(s) beside it): {raw_company[:60]}"
            )
            continue
        company, company_note = parse_company(raw_company)
        if not company:
            # Rejected text still names *something*; an empty cell names
            # nothing and stays skipped, as it always was.
            if not company_note:
                SKIPPED.append(f"{name}: {raw_company[:80]}")
                continue
            company = UNATTRIBUTED
        for offset, vendor in enumerate(layout):
            if vendor is None:
                continue
            col = offset + 1
            if col >= len(row):
                break
            codes, cell_note, url = parse_cell(clean_cell(row[col]))
            note = "; ".join(n for n in (company_note, cell_note) if n) or None
            for code in codes:
                records.append(
                    {
                        "company": company,
                        "vendor": vendor,
                        "code": code,
                        "note": note,
                        "url": url,
                        "source": name,
                    }
                )
            # A cell holding only a booking URL (Deloitte's Hilton link) is
            # still worth keeping even with no code alongside it.
            if not codes and url:
                records.append(
                    {
                        "company": company,
                        "vendor": vendor,
                        "code": None,
                        "note": note,
                        "url": url,
                        "source": name,
                    }
                )
    return records


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main() -> int:
    if not WORKBOOK.exists():
        print(f"missing workbook: {WORKBOOK}", file=sys.stderr)
        return 1

    workbook = openpyxl.load_workbook(WORKBOOK, data_only=True)
    SKIPPED.clear()
    records: list[dict] = []
    for sheet in workbook.worksheets:
        rows = list(sheet.iter_rows(values_only=True))
        if sheet.title in SHEET_LAYOUTS:
            records.extend(parse_grid_sheet(sheet.title, rows))
        elif sheet.title == "Hilton Code":
            records.extend(parse_hilton_sheet(rows))

    # Merge duplicates across sheets, keeping every source that vouches for the
    # code and the first non-empty note/url we saw.
    merged: dict[tuple[str, str, str | None], dict] = {}
    for rec in records:
        key = (slugify(rec["company"]), rec["vendor"], rec["code"])
        existing = merged.get(key)
        if existing is None:
            rec = dict(rec)
            rec["sources"] = [rec.pop("source")]
            merged[key] = rec
            continue
        if rec["source"] not in existing["sources"]:
            existing["sources"].append(rec["source"])
        existing["note"] = existing["note"] or rec["note"]
        existing["url"] = existing["url"] or rec["url"]

    by_company: dict[str, dict] = {}
    for rec in merged.values():
        slug = slugify(rec["company"])
        entry = by_company.setdefault(
            slug, {"slug": slug, "name": rec["company"], "codes": []}
        )
        entry["codes"].append(
            {
                "vendor": rec["vendor"],
                "code": rec["code"],
                "note": rec["note"],
                "url": rec["url"],
                "sources": sorted(rec["sources"]),
            }
        )

    companies = sorted(by_company.values(), key=lambda c: c["name"].lower())
    for company in companies:
        company["codes"].sort(key=lambda c: (c["vendor"], c["code"] or ""))

    payload = {
        "$comment": (
            "GENERATED by scripts/extract_codes.py from "
            "data/source/Hotel & Car Rental Corporate Codes.xlsx. Do not edit by hand."
        ),
        "schemaVersion": 1,
        "companies": companies,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n")

    per_vendor: dict[str, int] = defaultdict(int)
    for company in companies:
        for code in company["codes"]:
            per_vendor[code["vendor"]] += 1
    total = sum(per_vendor.values())
    print(f"wrote {OUT.relative_to(ROOT)}: {len(companies)} companies, {total} codes")
    for vendor, count in sorted(per_vendor.items(), key=lambda kv: -kv[1]):
        print(f"  {vendor:12} {count}")

    # Counting only what was kept is how a parser loses employers quietly.
    if SKIPPED:
        print(f"\nskipped {len(SKIPPED)} row(s) that named something:", file=sys.stderr)
        for line in SKIPPED:
            print(f"  - {line}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
