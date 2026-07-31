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

  xl/comments*.xml        cell comments -- the `<author>` element is the field
                          that leaked, and comment *text* can be signed by hand
  xl/drawings/*.vml       the comment boxes' own copy of the author name
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
WORKBOOK = ROOT / "data" / "source" / "Hotel & Car Rental Corporate Codes.xlsx"

# Hosts the workbook is allowed to mention. Two OOXML namespace domains that
# every .xlsx contains, plus the four booking/reference sites the codes cite.
ALLOWED_HOSTS = frozenset(
    {
        "schemas.microsoft.com",
        "schemas.openxmlformats.org",
        "goingawesomeplaces.com",
        "stay.hilton.com",
        "www.emeraldaisle.com",
        "www.hotelcorporatecodes.com",
    }
)

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
HOST_RE = re.compile(r"https?://([A-Za-z0-9.-]+)")
AUTHOR_RE = re.compile(r"<author>(.*?)</author>", re.DOTALL)
CREATOR_RE = re.compile(r"<(?:dc:creator|cp:lastModifiedBy)>(.*?)</", re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")

# A hand-typed sign-off: a dash at the end of a comment followed by two or more
# capitalised words. This is the shape the leaked name actually took --
# "...I can't see anything\n\t-Demilade Boyejo" -- and an `<author>` check alone
# does not see it, because the name was in the comment *body*, not the element
# Excel fills in. Two words is the discriminator that keeps "- Americas only"
# and "-Hilton only" (real notes in this workbook) from tripping it.
SIGNOFF_RE = re.compile(
    r"[-~—]{1,2}\s*([A-Z][a-z]+(?:\s+[A-Z][A-Za-z'\-]+)+)\s*$",
    re.MULTILINE,
)

# Substrings that mark a non-production host. Redundant against the allowlist
# above -- kept so that if someone widens the allowlist in a hurry, the obvious
# case still gets a second look rather than sailing through.
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

            # Sign-offs hide in the comment body, so read the text Excel shows
            # rather than the elements it fills in.
            if "comments" in name or name.endswith(".vml"):
                body = TAG_RE.sub("", text)
                for signature in sorted(set(SIGNOFF_RE.findall(body))):
                    problems.append(
                        f"{name}: comment signed {signature.strip()!r}"
                    )

            for host in sorted(set(HOST_RE.findall(text))):
                lowered = host.lower()
                if lowered in ALLOWED_HOSTS:
                    continue
                marker = next(
                    (m for m in SUSPICIOUS_HOST_MARKERS if m in lowered), None
                )
                if marker:
                    problems.append(
                        f"{name}: non-production host {host!r} (matched {marker!r})"
                    )
                else:
                    problems.append(
                        f"{name}: unrecognised host {host!r} -- if it belongs, "
                        f"add it to ALLOWED_HOSTS in {Path(__file__).name}"
                    )

    return problems


def main() -> int:
    if not WORKBOOK.exists():
        print(f"workbook not found: {WORKBOOK}", file=sys.stderr)
        return 1

    problems = scan(WORKBOOK)
    if problems:
        print(
            f"{len(problems)} problem(s) in {WORKBOOK.name}:",
            file=sys.stderr,
        )
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            "\nThe workbook ships in a public repo. Scrub the file itself -- "
            "editing it in Excel is enough; do not rewrite git history to "
            "paper over a fresh commit.",
            file=sys.stderr,
        )
        return 1

    print(f"{WORKBOOK.name}: no personal data found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
