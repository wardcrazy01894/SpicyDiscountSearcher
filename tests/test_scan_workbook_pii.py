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
import tempfile
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


def test_still_catches_a_signature_that_is_not_the_last_comment(
    tmp_path: Path,
) -> None:
    """The reason this scanner parses per comment rather than per part.

    Stripping tags from the whole part joins every comment into one string, so
    an end-of-line anchor only ever matched the *final* comment. This workbook
    already carries an unrelated note, so had the leaked name landed on that
    sheet the scanner would have reported nothing at all.
    """
    book = make_workbook(
        tmp_path,
        {
            "xl/comments1.xml": (
                "<comments><commentList>"
                "<comment><text><t>QQ: any IHG codes?\n\t-Ada Lovelace</t></text></comment>"
                "<comment><text><t>Not valid (as of 4/13/22)</t></text></comment>"
                "</commentList></comments>"
            )
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]


def test_catches_a_name_split_across_formatting_runs(tmp_path: Path) -> None:
    """Excel breaks one comment into several <r><t> runs whenever formatting
    changes mid-sentence, which can fall in the middle of a name."""
    book = make_workbook(
        tmp_path,
        {
            "xl/comments1.xml": (
                "<comments><commentList><comment><text>"
                "<r><t>thanks\n\t-Ada </t></r><r><t>Lovelace</t></r>"
                "</text></comment></commentList></comments>"
            )
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]


def test_catches_a_threaded_comment_author(tmp_path: Path) -> None:
    """Excel 365 and Excel for the web write threaded comments, which keep the
    commenter's real name as a displayName attribute in a part the legacy
    <author> check never looks at."""
    book = make_workbook(
        tmp_path,
        {
            "xl/persons/person1.xml": '<person displayName="Ada Lovelace" providerId="AD"/>'
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]


def test_reads_threaded_comment_bodies_too(tmp_path: Path) -> None:
    book = make_workbook(
        tmp_path,
        {
            "xl/threadedComments/threadedComment1.xml": (
                "<threadedComments><threadedComment id='1'>"
                "<text>looks right to me\n-Ana Müller</text>"
                "</threadedComment></threadedComments>"
            )
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1, "a non-ASCII name is still a name"
    assert "Ana Müller" in problems[0]


def test_catches_a_host_written_without_a_scheme(tmp_path: Path) -> None:
    """The workbook writes hyperlink display text with no https:// in front of
    it, so the host that leaked could reappear in exactly that form."""
    book = make_workbook(
        tmp_path,
        {
            "xl/sharedStrings.xml": "<sst><si><t>stay-stg.hilton.com/fortive</t></si></sst>"
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "stay-stg.hilton.com" in problems[0]


def test_a_marker_beats_the_allowlist(tmp_path: Path) -> None:
    """Adding a staging host to ALLOWED_HOSTS in a hurry must not silence it.
    The marker check runs first precisely so the second rule is a real backstop
    rather than a differently-worded message on a decision already made."""
    book = make_workbook(
        tmp_path,
        {
            "xl/sharedStrings.xml": "<sst><si><t>https://staging.example.com/x</t></si></sst>"
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "non-production host" in problems[0]


STOCK_CORE_XML = (
    '<?xml version="1.0"?>'
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/'
    '2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"'
    ' xmlns:dcterms="http://purl.org/dc/terms/"'
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"'
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    "<dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy>"
    "</cp:coreProperties>"
)


def test_a_stock_docprops_part_scans_clean(tmp_path: Path) -> None:
    """The remediation this script prints is "edit it in Excel", and doing that
    is what creates docProps/core.xml. Its Dublin Core and XMLSchema namespace
    declarations are boilerplate, not content — treating them as unrecognised
    hosts would red-line a required check on a file with nothing wrong with it.
    """
    book = make_workbook(tmp_path, {"docProps/core.xml": STOCK_CORE_XML})
    assert scanner.scan(book) == []


def test_a_named_creator_in_that_same_part_is_still_caught(tmp_path: Path) -> None:
    book = make_workbook(
        tmp_path,
        {
            "docProps/core.xml": STOCK_CORE_XML.replace(
                "<dc:creator>", "<dc:creator>Ada Lovelace"
            )
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]


@pytest.mark.parametrize(
    "signoff",
    [
        "-Hampton Inn",
        "-Americas Only",
        "-Not Valid",
        "-Corporate Rate",
        "-Best Western",
    ],
)
def test_title_cased_workbook_vocabulary_is_not_a_person(
    tmp_path: Path, signoff: str
) -> None:
    """Capitalisation alone is not enough in a workbook full of employers and
    hotel brands. One re-capitalised margin note failing a required check is
    how a gate stops being trusted."""
    book = make_workbook(
        tmp_path,
        {
            "xl/comments1.xml": (
                f"<comments><commentList><comment><text><t>note\n{signoff}</t>"
                "</text></comment></commentList></comments>"
            )
        },
    )
    assert scanner.scan(book) == []


@pytest.mark.parametrize(
    "signoff", ["-Ada Lovelace.", "-Ada Lovelace (EMEA)", "-Ada Lovelace,"]
)
def test_a_signature_with_trailing_punctuation_still_counts(
    tmp_path: Path, signoff: str
) -> None:
    book = make_workbook(
        tmp_path,
        {
            "xl/comments1.xml": (
                f"<comments><commentList><comment><text><t>note\n{signoff}</t>"
                "</text></comment></commentList></comments>"
            )
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]


def test_reads_a_single_quoted_display_name(tmp_path: Path) -> None:
    book = make_workbook(
        tmp_path, {"xl/persons/person1.xml": "<person displayName='Ada Lovelace'/>"}
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]


def test_a_libreoffice_save_scans_clean(tmp_path: Path) -> None:
    """Same shape as the docProps case: the tool tells you to edit the file,
    and a contributor without Excel reaches for LibreOffice, which writes its
    own namespace into xl/workbook.xml on every save."""
    book = make_workbook(
        tmp_path,
        {
            "xl/workbook.xml": (
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<extLst><ext xmlns:loext="http://schemas.libreoffice.org/" '
                'uri="{7626C862-2A13-11E5-B345-FEFF819CDC9F}"/></extLst></workbook>'
            )
        },
    )
    assert scanner.scan(book) == []


def test_a_threaded_comment_shim_is_not_a_person(tmp_path: Path) -> None:
    """Excel writes a legacy comments part beside every threaded comment, whose
    author element holds the thread GUID. There is no allowlist for an author,
    so reporting it would leave a contributor with a red required check and no
    way out but patching this file."""
    book = make_workbook(
        tmp_path,
        {
            "xl/comments1.xml": (
                "<comments><authors>"
                "<author>tc={1B2C3D4E-5F60-7A8B-9C0D-1E2F3A4B5C6D}</author>"
                "</authors></comments>"
            )
        },
    )
    assert scanner.scan(book) == []


def test_a_real_author_beside_a_shim_is_still_caught(tmp_path: Path) -> None:
    book = make_workbook(
        tmp_path,
        {
            "xl/comments1.xml": (
                "<comments><authors>"
                "<author>tc={1B2C3D4E-5F60-7A8B-9C0D-1E2F3A4B5C6D}</author>"
                "<author>Ada Lovelace</author>"
                "</authors></comments>"
            )
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]


def test_a_dot_prefixed_host_is_reported_under_its_real_name(tmp_path: Path) -> None:
    """An earlier lookbehind blocked a leading dot, so this matched from the
    wrong character and reported 'stg.hilton.com' — a host nobody wrote. The
    job still failed, which is why nothing caught it; the *name* was wrong.
    """
    book = make_workbook(
        tmp_path,
        {
            "xl/sharedStrings.xml": "<sst><si><t>see ...stay-stg.hilton.com/fortive</t></si></sst>"
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "'stay-stg.hilton.com'" in problems[0]


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
        {
            "xl/sharedStrings.xml": "<sst><si><t>http://stay-stg.hilton.com/x</t></si></sst>"
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "stay-stg.hilton.com" in problems[0]


def test_allows_the_production_host_it_resembles(tmp_path: Path) -> None:
    book = make_workbook(
        tmp_path,
        {
            "xl/sharedStrings.xml": "<sst><si><t>https://stay.hilton.com/x</t></si></sst>"
        },
    )
    assert scanner.scan(book) == []


def test_an_unrecognised_host_needs_a_human(tmp_path: Path) -> None:
    """Not every new host is a leak, but every new host is a decision."""
    book = make_workbook(
        tmp_path,
        {
            "xl/sharedStrings.xml": "<sst><si><t>https://example.com/deals</t></si></sst>"
        },
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
    """Styles and binary parts are noise; only readable XML is scanned.

    Alongside a real XML part, because a book with *nothing* readable is a
    different case with its own test — it is reported rather than cleared.
    """
    book = make_workbook(
        tmp_path,
        {
            "xl/sharedStrings.xml": "<sst><si><t>ok</t></si></sst>",
            "xl/media/image1.png": "ada@example.org",
        },
    )
    assert scanner.scan(book) == []


def test_a_producer_name_is_not_a_person(tmp_path: Path) -> None:
    """openpyxl stamps its own name into dc:creator on every save — and
    openpyxl is this repo's workbook tooling, so scripting the scrub (the most
    natural way to fix a leak) would have failed the gate on the fix."""
    book = make_workbook(
        tmp_path,
        {
            "docProps/core.xml": "<cp:coreProperties><dc:creator>openpyxl</dc:creator></cp:coreProperties>"
        },
    )
    assert scanner.scan(book) == []


def test_a_person_named_in_the_same_field_still_fires(tmp_path: Path) -> None:
    book = make_workbook(
        tmp_path,
        {
            "docProps/core.xml": (
                "<cp:coreProperties><dc:creator>Ada Lovelace</dc:creator></cp:coreProperties>"
            )
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]


def test_reads_relationship_parts(tmp_path: Path) -> None:
    """Where the incident host actually lived. A hyperlink entered as a link
    rather than as display text exists ONLY in a .rels part."""
    book = make_workbook(
        tmp_path,
        {
            "xl/worksheets/_rels/sheet1.xml.rels": (
                '<Relationships><Relationship Id="rId1" '
                'Target="http://stay-stg.hilton.com/fortive/" TargetMode="External"/>'
                "</Relationships>"
            )
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "stay-stg.hilton.com" in problems[0]


def test_a_part_it_cannot_read_is_not_declared_clean(tmp_path: Path) -> None:
    """An OPC package always contains `[Content_Types].xml`, so counting
    *readable* parts never fired — a spec-faithful .xlsb keeps only its
    strings, sheets and comments as .bin and scanned green while carrying the
    incident's own name and staging host. The question is not "did I read
    anything" but "did I skip anything that could hold words".
    """
    book = make_workbook(
        tmp_path,
        {
            "[Content_Types].xml": "<Types/>",
            "_rels/.rels": "<Relationships/>",
            "xl/sharedStrings.bin": "stay-stg.hilton.com",
            "xl/comments1.bin": "-Demilade Boyejo",
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 2
    assert all("cannot be cleared" in p for p in problems)
    assert any("sharedStrings.bin" in p for p in problems)


def test_binary_parts_with_no_words_are_not_flagged(tmp_path: Path) -> None:
    """Page setup, images and fonts hold no text. An ordinary .xlsx with a
    configured printer has printerSettings1.bin, so without this every one of
    them would fail the gate."""
    book = make_workbook(
        tmp_path,
        {
            "[Content_Types].xml": "<Types/>",
            "xl/printerSettings/printerSettings1.bin": "x",
            "xl/media/image1.png": "x",
        },
    )
    assert scanner.scan(book) == []


def test_an_authorless_comment_is_not_a_person(tmp_path: Path) -> None:
    """openpyxl writes the literal string "None" as the author of a comment
    nobody signed. An openpyxl round-trip of this repo's own workbook produced
    two of them — the same argument as the producer-name and tc={GUID} skips:
    the tooling the repo already uses must not fail the gate on a clean file.
    """
    book = make_workbook(
        tmp_path,
        {
            "xl/comments1.xml": "<comments><authors><author>None</author></authors></comments>"
        },
    )
    assert scanner.scan(book) == []


def test_a_marker_beats_an_allowlisted_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reason the marker check runs first. Pinned against an allowlist that
    actually contains the host, because testing it with an unlisted one proves
    only that unlisted hosts fire."""
    monkeypatch.setattr(
        scanner, "ALLOWED_HOSTS", scanner.ALLOWED_HOSTS | {"stay-stg.hilton.com"}
    )
    book = make_workbook(
        tmp_path,
        {
            "xl/sharedStrings.xml": "<sst><si><t>https://stay-stg.hilton.com/x</t></si></sst>"
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "non-production host" in problems[0]


class TestMain:
    """The exit code is the only thing CI consumes, and nothing tested it —
    `main: always return 0` survived the whole suite."""

    @staticmethod
    def source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        source = tmp_path / "source"
        source.mkdir()
        monkeypatch.setattr(scanner, "SOURCE_DIR", source)
        return source

    def test_returns_zero_for_a_clean_book(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        source = self.source(tmp_path, monkeypatch)
        make_workbook(
            source, {"xl/sharedStrings.xml": "<sst><si><t>ok</t></si></sst>"}
        ).rename(source / "clean.xlsx")
        assert scanner.main() == 0

    def test_returns_one_and_names_the_book(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        source = self.source(tmp_path, monkeypatch)
        make_workbook(
            source,
            {
                "xl/sharedStrings.xml": "<sst><si><t>http://stay-stg.hilton.com/x</t></si></sst>"
            },
        ).rename(source / "dirty.xlsx")
        assert scanner.main() == 1
        err = capsys.readouterr().err
        assert "dirty.xlsx: xl/sharedStrings.xml:" in err

    def test_returns_one_when_there_is_nothing_to_scan(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self.source(tmp_path, monkeypatch)
        assert scanner.main() == 1

    def test_a_corrupt_book_is_a_problem_not_a_traceback(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        source = self.source(tmp_path, monkeypatch)
        (source / "corrupt.xlsx").write_bytes(b"not a zip at all")
        make_workbook(source, {"xl/sharedStrings.xml": "<sst/>"}).rename(
            source / "zz-clean.xlsx"
        )
        assert scanner.main() == 1


def test_an_openpyxl_round_trip_of_the_real_workbook_is_clean() -> None:
    """The end-to-end version of the two skips above. Scripting the scrub is
    the natural way to fix a leak in this repo, and openpyxl is what it would
    be scripted with — the gate must not fail on the fix."""
    openpyxl = pytest.importorskip("openpyxl")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "round-trip.xlsx"
        openpyxl.load_workbook(scanner.WORKBOOK).save(out)
        assert scanner.scan(out) == []


def test_catches_a_manager_in_the_app_properties(tmp_path: Path) -> None:
    """`docProps/app.xml` was read and never checked. `<Manager>` is a person's
    name, stamped from the Office installation."""
    book = make_workbook(
        tmp_path,
        {
            "docProps/app.xml": "<Properties><Manager>Ada Lovelace</Manager></Properties>"
        },
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Ada Lovelace" in problems[0]


def test_a_producer_name_in_app_properties_is_still_boilerplate(tmp_path: Path) -> None:
    book = make_workbook(
        tmp_path,
        {
            "docProps/app.xml": "<Properties><Company>Microsoft Excel</Company></Properties>"
        },
    )
    assert scanner.scan(book) == []


def test_catches_a_company_in_the_app_properties(tmp_path: Path) -> None:
    """The other half of the app.xml change, and the half nothing tested:
    dropping `Company` from the pattern left the suite green, because the only
    `Company` case asserted a producer name is *not* reported — which passes
    trivially when the element is never matched at all."""
    book = make_workbook(
        tmp_path,
        {"docProps/app.xml": "<Properties><Company>Contoso Ltd</Company></Properties>"},
    )
    problems = scanner.scan(book)
    assert len(problems) == 1
    assert "Contoso Ltd" in problems[0]
