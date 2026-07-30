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


def parse_hilton_sheet(rows: list[tuple[object, ...]]) -> list[dict]:
    """The 'Hilton Code' sheet is free text: 'N0001542 / 0232757100 3M'.

    Leading code-shaped tokens belong to Hilton; the remainder is the company.
    """
    records: list[dict] = []
    for row in rows:
        line = clean_cell(row[0] if row else None)
        if not line:
            continue
        tokens = [t for t in re.split(r"[/\s]+", line) if t]
        codes: list[str] = []
        idx = 0
        while idx < len(tokens) and looks_like_code(tokens[idx].upper()):
            code = tokens[idx].upper()
            if code not in codes:
                codes.append(code)
            idx += 1
        company = " ".join(tokens[idx:]).strip(" -–—")
        if not company or not codes:
            continue
        for code in codes:
            records.append(
                {
                    "company": company,
                    "vendor": "hilton",
                    "code": code,
                    "note": None,
                    "url": None,
                    "source": "Hilton Code",
                }
            )
    return records


def parse_grid_sheet(name: str, rows: list[tuple[object, ...]]) -> list[dict]:
    layout = SHEET_LAYOUTS[name]
    records: list[dict] = []
    for row in rows[1:]:  # row 0 is the header
        company = clean_cell(row[0] if row else None)
        # The 'Corp Codes' header cell doubles as a stray Hilton link; skip
        # anything that isn't a plain company name.
        if not company or URL_RE.search(company):
            continue
        for offset, vendor in enumerate(layout):
            if vendor is None:
                continue
            col = offset + 1
            if col >= len(row):
                break
            codes, note, url = parse_cell(clean_cell(row[col]))
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
