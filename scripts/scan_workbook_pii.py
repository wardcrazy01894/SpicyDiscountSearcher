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
        # clean file.
        "schemas.microsoft.com",
        "schemas.openxmlformats.org",
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

    with zipfile.ZipFile(workbook) as archive:
        for name in archive.namelist():
            if not name.endswith((".xml", ".vml", ".rels")):
                continue
            text = archive.read(name).decode("utf-8", errors="replace")

            for email in sorted(set(EMAIL_RE.findall(text))):
                problems.append(f"{name}: email address {email!r}")

            # An author is a named human. Excel writes an empty element when
            # the comment is anonymous, which is the state we want to hold.
            for author in sorted(set(AUTHOR_RE.findall(text))):
                if author.strip():
                    problems.append(f"{name}: comment author {author.strip()!r}")

            for creator in sorted(set(CREATOR_RE.findall(text))):
                if creator.strip():
                    problems.append(f"{name}: document author {creator.strip()!r}")

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

    return problems


def main() -> int:
    # Every workbook under data/source, not the one path that exists today: a
    # second one dropped in beside it would otherwise be silently unscanned,
    # which is the same shape of blind spot this script exists to close.
    workbooks = sorted(SOURCE_DIR.glob("*.xlsx"))
    if not workbooks:
        print(f"no workbook found under {SOURCE_DIR}", file=sys.stderr)
        return 1

    problems = [problem for book in workbooks for problem in scan(book)]
    if problems:
        names = ", ".join(book.name for book in workbooks)
        print(f"{len(problems)} problem(s) in {names}:", file=sys.stderr)
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
