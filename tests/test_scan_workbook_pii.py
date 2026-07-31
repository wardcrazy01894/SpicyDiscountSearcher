"""Tests for the workbook PII scanner.

The scanner exists because of a specific incident: commit 9bbf418 scrubbed a
contributor's name and an internal staging host out of the workbook, and
nothing in CI could have caught either -- gitleaks drops .xlsx by extension.
So these tests plant the *shape* of what leaked rather than a generic secret:
a name signed into a comment body, and a host that differs from a legitimate
one only by a `-stg` infix.
"""

from __future__ import annotations

import importlib.util
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "scan_workbook_pii.py"

spec = importlib.util.spec_from_file_location("scan_workbook_pii", SCRIPT)
assert spec is not None and spec.loader is not None
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


def make_workbook(tmp_path: Path, members: dict[str, str]) -> Path:
    """Write a minimal .xlsx-shaped zip containing the given XML parts."""
    path = tmp_path / "book.xlsx"
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in members.items():
            archive.writestr(name, text)
    return path


def test_the_committed_workbook_is_clean() -> None:
    """The file actually in the repo must pass, or the gate is unshippable."""
    assert scanner.scan(scanner.WORKBOOK) == []


def test_catches_a_name_signed_into_a_comment_body(tmp_path: Path) -> None:
    """The exact shape that leaked: an <author> element that is correctly
    empty, with the real name typed at the end of the comment instead."""
    book = make_workbook(
        tmp_path,
        {
            "xl/comments1.xml": (
                "<comments><authors><author></author></authors>"
                "<commentList><comment><text><t>QQ: was there a sheet for "
                "IHG codes? I can't see anything\n\t-Ada Lovelace</t></text>"
                "</comment></commentList></comments>"
            )
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]
    assert "signed" in problems[0]


def test_ignores_ordinary_margin_notes(tmp_path: Path) -> None:
    """This workbook is full of dashed qualifiers. They are not signatures,
    and flagging them would train everyone to ignore the scanner."""
    book = make_workbook(
        tmp_path,
        {
            "xl/comments1.xml": (
                "<comments><commentList><comment><text>"
                "<t>Doubletree, Embassy Suites only\n-Americas only</t>"
                "</text></comment></commentList></comments>"
            )
        },
    )
    assert scanner.scan(book) == []


def test_catches_a_staging_host_that_shares_a_real_domain(
    tmp_path: Path,
) -> None:
    """`stay-stg.hilton.com` is why the host check is an allowlist of exact
    names: any suffix rule keyed on `hilton.com` would have passed it."""
    book = make_workbook(
        tmp_path,
        {"xl/sharedStrings.xml": "<sst><si><t>http://stay-stg.hilton.com/x</t></si></sst>"},
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "stay-stg.hilton.com" in problems[0]


def test_allows_the_production_host_it_resembles(tmp_path: Path) -> None:
    book = make_workbook(
        tmp_path,
        {"xl/sharedStrings.xml": "<sst><si><t>https://stay.hilton.com/x</t></si></sst>"},
    )
    assert scanner.scan(book) == []


def test_an_unrecognised_host_needs_a_human(tmp_path: Path) -> None:
    """Not every new host is a leak, but every new host is a decision."""
    book = make_workbook(
        tmp_path,
        {"xl/sharedStrings.xml": "<sst><si><t>https://example.com/deals</t></si></sst>"},
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "example.com" in problems[0]
    assert "ALLOWED_HOSTS" in problems[0]


@pytest.mark.parametrize(
    ("part", "content", "needle"),
    [
        (
            "xl/comments1.xml",
            "<comments><authors><author>Grace Hopper</author></authors></comments>",
            "Grace Hopper",
        ),
        (
            "docProps/core.xml",
            "<cp:coreProperties><dc:creator>Alan Turing</dc:creator>"
            "</cp:coreProperties>",
            "Alan Turing",
        ),
        (
            "xl/sharedStrings.xml",
            "<sst><si><t>ping me at ada@example.org</t></si></sst>",
            "ada@example.org",
        ),
    ],
)
def test_catches_the_other_places_a_name_hides(
    tmp_path: Path, part: str, content: str, needle: str
) -> None:
    book = make_workbook(tmp_path, {part: content})
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert needle in problems[0]


def test_ignores_parts_that_are_not_markup(tmp_path: Path) -> None:
    """Styles and binary parts are noise; only readable XML is scanned."""
    book = make_workbook(tmp_path, {"xl/media/image1.png": "ada@example.org"})
    assert scanner.scan(book) == []
