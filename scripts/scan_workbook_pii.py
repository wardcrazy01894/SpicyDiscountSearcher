#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Scan the source workbook's XML for personal data before it ships.

An .xlsx is a zip of XML, and gitleaks drops the file by extension before any
repo config applies -- `.gitleaks.toml` says so itself. So the one binary in
this repo is the one file no scanner reads, and that is exactly how a
contributor's name and an internal staging host reached a public repo in
commit 9bbf418 ("Scrub a contributor's name and a staging host from the
workbook"). Rewriting history got them off `main`; nothing stopped the next
revision of the workbook from carrying the same thing in again.

This unzips the workbook and reads the parts a spreadsheet hides:

  xl/comments*.xml        legacy cell comments -- the `<author>` element is the
                          field that leaked, and comment *text* can be signed
  xl/threadedComments/    modern comment bodies (Excel 365, Excel for the web)
  xl/persons/*.xml        the commenter's real name, as a displayName attribute
  docProps/core.xml       `dc:creator` / `cp:lastModifiedBy`, stamped by Excel
  xl/sharedStrings.xml    every string in every cell, including URLs

The host check is an allowlist of exact hostnames, not a pattern. A
suffix rule would have let `stay-stg.hilton.com` through on the strength of
`hilton.com`, which is the precise mistake that shipped. Any host not named
below fails the job and needs a human to decide it belongs -- that is the
point, and adding a legitimate one is a one-line edit with a reviewer.
"""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "data" / "source"
WORKBOOK = SOURCE_DIR / "Hotel & Car Rental Corporate Codes.xlsx"

# Hosts the workbook is allowed to mention. Two OOXML namespace domains that
# every .xlsx contains, plus the four booking/reference sites the codes cite.
ALLOWED_HOSTS = frozenset(
    {
        # Namespace boilerplate. Every OOXML producer writes these; they are
        # not content and never identify anyone. `purl.org` and `w3.org` come
        # from docProps/core.xml's Dublin Core and XMLSchema declarations --
        # this workbook has no docProps part at all today, but the remediation
        # this very script prints ("editing it in Excel is enough") is exactly
        # what creates one, which would have turned a required check red on a
        # clean file. `schemas.libreoffice.org` is the same story one step
        # further along: a contributor without Excel reaches for LibreOffice,
        # which writes a loext namespace into xl/workbook.xml on every save.
        "schemas.microsoft.com",
        "schemas.openxmlformats.org",
        "schemas.libreoffice.org",
        "purl.org",
        "w3.org",
        "www.w3.org",
        # Booking and reference sites the codes cite.
        "goingawesomeplaces.com",
        "stay.hilton.com",
        "www.emeraldaisle.com",
        "www.hotelcorporatecodes.com",
    }
)

# Title-cased phrases that are not people. This workbook is a list of employers
# and hotel brands, so "two capitalised words" alone would fire on a note
# reading "-Hampton Inn" or "-Americas Only". A gate that cries wolf is a gate
# somebody switches off.
NOT_PEOPLE_WORDS = frozenset(
    {
        "only",
        "valid",
        "expired",
        "rate",
        "rates",
        "code",
        "codes",
        "corporate",
        "discount",
        "inn",
        "suites",
        "hotel",
        "hotels",
        "resort",
        "club",
        "western",
        "longer",
        "americas",
        "emea",
        "apac",
    }
)

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
AUTHOR_RE = re.compile(r"<author>(.*?)</author>", re.DOTALL)
CREATOR_RE = re.compile(r"<(?:dc:creator|cp:lastModifiedBy)>(.*?)</", re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")

# Excel 365 and Excel for the web write *threaded* comments, which are a
# different pair of parts entirely: the body in xl/threadedComments/, and the
# commenter's real name as a displayName attribute in xl/persons/. A workbook
# edited in modern Excel puts the name here and nowhere else, so checking only
# the legacy <author> element covers the format this workbook happens to use
# and none of the format the next edit will use.
DISPLAY_NAME_RE = re.compile(r"""displayName\s*=\s*(["'])(.*?)\1""")

# Excel writes a legacy comments part alongside every threaded comment, whose
# author element holds the thread's GUID rather than a person: `tc={1B2C-...}`.
# Machine boilerplate, and unlike an unrecognised host there is no allowlist to
# add it to -- a contributor who hit this would face a red required check with
# no way out but patching this file.
THREAD_ID_RE = re.compile(r"^tc=\{[0-9A-Fa-f-]+\}$")

# Producers stamp their own name into dc:creator when nobody set one. openpyxl
# does it on every save -- and openpyxl is this repo's own workbook tooling, so
# scripting the scrub, the most natural way to fix a leak, would have failed
# the gate on the fix. Same category as the namespace hosts: boilerplate, not a
# person. Matched whole and case-insensitively, so "Calc Jenkins" is still a
# name.
# A part stored as binary that can still carry text. In a .xlsb the strings,
# sheets and comments all live in these; `vbaProject.bin` holds macro source.
CONTENT_BEARING_BINARY_RE = re.compile(r"\.bin$", re.IGNORECASE)

# Binary parts that hold no words: page setup, images, embedded fonts. An
# ordinary .xlsx with a configured printer has printerSettings1.bin and nothing
# else binary, so without this every such workbook would fail.
BENIGN_BINARY_RE = re.compile(
    r"printerSettings|/media/|/fonts?/|\.(?:png|jpe?g|gif|bmp|tiff?|emf|wmf)$",
    re.IGNORECASE,
)

# openpyxl writes the literal string "None" as the author of a comment nobody
# signed. Same argument as PRODUCER_NAMES and the tc={GUID} shim: an openpyxl
# round-trip of this repo's own workbook produced two of these, so the tooling
# the repo already uses would have failed the gate on a clean file.
NON_PERSON_AUTHORS = frozenset({"none", "null", "unknown", "user", "author"})

PRODUCER_NAMES = frozenset(
    {
        "openpyxl",
        "microsoft excel",
        "microsoft office user",
        "libreoffice",
        "libreoffice calc",
        "calc",
        "apache poi",
        "google sheets",
        "xlsxwriter",
        "pandas",
    }
)

# One comment at a time. Stripping tags from a whole part and then anchoring on
# end-of-line finds a signature only when it is the *last* comment in the part:
# a second sticky note anywhere after it joins on and the anchor never matches.
# This workbook already carries an unrelated note ("Not valid (as of 4/13/22)"),
# so had the leaked name landed on that sheet, a part-wide scan would have
# reported nothing at all on the very incident it exists to catch.
COMMENT_BLOCK_RE = re.compile(
    r"<(comment|threadedComment)\b[^>]*>(.*?)</\1>", re.DOTALL
)

# A hand-typed sign-off: a dash near the end of a line, then a name. This is the
# shape the leak actually took -- "...I can't see anything\n\t-Demilade Boyejo"
# -- and an <author> check cannot see it, because the name was in the comment
# *body*, not the element Excel fills in.
#
# The name is captured loosely and validated in Python: a character class like
# [A-Z][a-z]+ is ASCII-only and would miss "José García" or "Ana Müller", which
# is not exotic for a workbook with an EMEA contributor thread. Horizontal
# whitespace only, so the match cannot run across a line break.
# The trailing class matters: "-Ada Lovelace." and "-Ada Lovelace (EMEA)" are
# the same sign-off, and anchoring hard on the name lost both.
SIGNOFF_RE = re.compile(
    r"[-~–—]{1,2}[ \t]*([^\W\d_][\w'’\-]*(?:[ \t]+[^\W\d_][\w'’\-]*)+)"
    r"[ \t]*[.!,;)\]]*[ \t]*(?:\([^)]*\))?[ \t]*$",
    re.MULTILINE,
)

HOST_RE = re.compile(r"https?://([A-Za-z0-9.-]+)")

# Hosts written without a scheme. The workbook already does this -- hyperlink
# display text reads "www.hotelcorporatecodes.com/87/marriott-hotels-..." with
# no https:// in front of it -- so a scheme-anchored pattern alone would miss
# "stay-stg.hilton.com/fortive" pasted the same way, which is exactly how the
# host that leaked was written in the cell.
# Email addresses are removed from the text before this runs, rather than
# excluded by a lookbehind: blocking a leading "." also blinded the pattern to
# "...stay-stg.hilton.com", where it matched from the wrong character and
# reported a host nobody wrote.
BARE_HOST_RE = re.compile(
    r"(?<![\w])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+"
    r"(?:com|net|org|io|co|uk|de|fr|eu|gov|edu|info|biz|travel))\b",
    re.IGNORECASE,
)

# Substrings that mark a non-production host. Checked *before* the allowlist,
# so widening ALLOWED_HOSTS in a hurry cannot wave one of these through -- which
# is the whole point of keeping a second rule, and was not true when this list
# was consulted after the allowlist had already returned.
SUSPICIOUS_HOST_MARKERS = (
    "-stg",
    "stg-",
    "staging",
    "-dev",
    "dev-",
    "-uat",
    "uat-",
    "-test",
    "test-",
    "internal",
    "intranet",
    "corp.",
    "localhost",
)


def looks_like_a_person(phrase: str) -> bool:
    """Two or more capitalised words that are not workbook vocabulary.

    Two words is what separates "Demilade Boyejo" from this workbook's real
    margin notes -- "- Americas only", "-Hilton only". Capitalisation is
    checked here rather than in the pattern so that non-ASCII capitals count.

    The word list is the second half of that: capitalisation alone still fires
    on "-Hampton Inn" or "-Not Valid", and one re-capitalised margin note
    red-lining a required check is how a gate stops being trusted.
    """
    words = phrase.split()
    if len(words) < 2 or not all(word[:1].isupper() for word in words):
        return False
    return not any(word.strip(".,").lower() in NOT_PEOPLE_WORDS for word in words)


def comment_bodies(text: str) -> list[str]:
    """The readable text of each comment in a part, one entry per comment.

    Tags inside a comment are dropped without a separator on purpose: Excel
    splits one comment across several <r><t> runs whenever the formatting
    changes mid-sentence, so "<t>-Demilade </t><t>Boyejo</t>" is a single
    sentence and joining it with anything but "" would break the name in half.
    """
    return [TAG_RE.sub("", body) for _, body in COMMENT_BLOCK_RE.findall(text)]


def check_host(name: str, host: str) -> str | None:
    """One hostname, or None if it is allowed."""
    lowered = host.lower().rstrip(".")
    marker = next((m for m in SUSPICIOUS_HOST_MARKERS if m in lowered), None)
    if marker:
        return f"{name}: non-production host {host!r} (matched {marker!r})"
    if lowered in ALLOWED_HOSTS:
        return None
    return (
        f"{name}: unrecognised host {host!r} -- if it belongs, "
        f"add it to ALLOWED_HOSTS in {Path(__file__).name}"
    )


def scan(workbook: Path) -> list[str]:
    """Return a list of problems; empty means the workbook is clean."""
    problems: list[str] = []
    unreadable: list[str] = []

    with zipfile.ZipFile(workbook) as archive:
        for name in archive.namelist():
            if not name.endswith((".xml", ".vml", ".rels")):
                if CONTENT_BEARING_BINARY_RE.search(name) and not BENIGN_BINARY_RE.search(name):
                    unreadable.append(name)
                continue
            text = archive.read(name).decode("utf-8", errors="replace")

            for email in sorted(set(EMAIL_RE.findall(text))):
                problems.append(f"{name}: email address {email!r}")

            # An author is a named human. Excel writes an empty element when
            # the comment is anonymous, which is the state we want to hold.
            for author in sorted(set(AUTHOR_RE.findall(text))):
                stripped = author.strip()
                if (
                    stripped
                    and not THREAD_ID_RE.match(stripped)
                    and stripped.lower() not in NON_PERSON_AUTHORS
                    and stripped.lower() not in PRODUCER_NAMES
                ):
                    problems.append(f"{name}: comment author {stripped!r}")

            for creator in sorted(set(CREATOR_RE.findall(text))):
                stripped = creator.strip()
                if stripped and stripped.lower() not in PRODUCER_NAMES:
                    problems.append(f"{name}: document author {stripped!r}")

            # Threaded comments keep the commenter in xl/persons/, never in an
            # <author> element.
            for _, person in sorted(set(DISPLAY_NAME_RE.findall(text))):
                if person.strip():
                    problems.append(f"{name}: comment author {person.strip()!r}")

            # Sign-offs hide in the comment body, so read what Excel shows.
            # Per comment, never per part -- see COMMENT_BLOCK_RE.
            signatures: set[str] = set()
            for body in comment_bodies(text):
                for candidate in SIGNOFF_RE.findall(body):
                    if looks_like_a_person(candidate):
                        signatures.add(candidate.strip())
            for signature in sorted(signatures):
                problems.append(f"{name}: comment signed {signature!r}")

            # Emails out first, so a domain already reported as part of an
            # address is not reported a second time as a host.
            hostless = EMAIL_RE.sub(" ", text)
            hosts = set(HOST_RE.findall(hostless)) | set(BARE_HOST_RE.findall(hostless))
            for host in sorted(hosts):
                problem = check_host(name, host)
                if problem:
                    problems.append(problem)

    # "I could not read this part" is not "this part is clean", and a gate that
    # says the second when it means the first is worse than no gate.
    #
    # Counting *readable* parts was the wrong test and never fired: OPC requires
    # `[Content_Types].xml` in every package, so a .xlsb always has at least one
    # XML member. A spec-faithful .xlsb carrying a name and a staging host in
    # `xl/sharedStrings.bin` scanned green. The right question is whether
    # anything was skipped that could hold text.
    for name in unreadable:
        problems.append(
            f"{name}: not XML, so its contents cannot be scanned -- this part "
            f"cannot be cleared"
        )

    return problems


def main() -> int:
    # Every workbook under data/source, not the one path that exists today: a
    # second one dropped in beside it would otherwise be silently unscanned,
    # which is the same shape of blind spot this script exists to close.
    # Every spreadsheet format, not just the one extension in use today: a
    # macro-enabled .xlsm is the same zip of XML and would have been scanned by
    # nothing at all.
    workbooks = sorted(
        book for pattern in ("*.xlsx", "*.xlsm", "*.xlsb") for book in SOURCE_DIR.glob(pattern)
    )
    if not workbooks:
        print(f"no workbook found under {SOURCE_DIR}", file=sys.stderr)
        return 1

    # Attributed per book, so two books do not produce one undifferentiated list.
    problems: list[str] = []
    for book in workbooks:
        try:
            problems.extend(f"{book.name}: {problem}" for problem in scan(book))
        except (zipfile.BadZipFile, OSError) as error:
            # Per book, so one unreadable file does not hide the ones sorted
            # after it behind a traceback. Unreadable is still a problem: it
            # means this book was not cleared.
            problems.append(f"{book.name}: could not be opened ({error})")
    if problems:
        print(f"{len(problems)} problem(s) found:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            "\nThe workbook ships in a public repo. Scrub the file itself -- "
            "editing it in Excel is enough; do not rewrite git history to "
            "paper over a fresh commit.",
            file=sys.stderr,
        )
        return 1

    for book in workbooks:
        print(f"{book.name}: no personal data found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
