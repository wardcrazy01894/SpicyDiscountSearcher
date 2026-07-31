"""Unit tests for the workbook parser.

The `data` CI job pins the generated JSON byte-for-byte against the workbook,
which catches drift between the two but says nothing about whether the parsing
is *right*: change the parser and commit the regenerated output together and it
stays green no matter how wrong the result. These cover the decisions, not the
bytes — the heuristics that decide whether "Hampton Inn" becomes a code called
INN, or a margin note becomes a company.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "extract_codes.py"
spec = importlib.util.spec_from_file_location("extract_codes", SCRIPT)
assert spec and spec.loader
extract_codes = importlib.util.module_from_spec(spec)
sys.modules["extract_codes"] = extract_codes
spec.loader.exec_module(extract_codes)


class TestLooksLikeCode:
    @pytest.mark.parametrize("token", ["A541100", "N0156333", "260290", "XZ42PWC", "D008400+"])
    def test_accepts_real_codes(self, token: str) -> None:
        assert extract_codes.looks_like_code(token)

    @pytest.mark.parametrize("token", ["", "A", "or", "and", "the"])
    def test_rejects_noise(self, token: str) -> None:
        assert not extract_codes.looks_like_code(token)

    def test_letters_only_can_be_refused(self) -> None:
        # The guard that stops "Hampton Inn" yielding a code called INN.
        assert extract_codes.looks_like_code("INN")
        assert not extract_codes.looks_like_code("INN", allow_letters_only=False)


class TestSplitCodes:
    def test_splits_several_codes_in_one_cell(self) -> None:
        codes, _ = extract_codes.split_codes("A541100 or A541105")
        assert codes == ["A541100", "A541105"]

    def test_undoes_excels_float_coercion(self) -> None:
        # Excel turns 260290 into 260290.0, and racing "260290.0" races a code
        # that does not exist. clean_cell owns the fix, so go through it —
        # split_codes alone drops the token entirely.
        codes, _ = extract_codes.split_codes(extract_codes.clean_cell("260290.0"))
        assert codes == ["260290"]
        assert extract_codes.split_codes("260290.0")[0] == [], (
            "if split_codes ever learns to do this itself, the pipeline has two "
            "places undoing the same Excel artefact"
        )

    def test_uppercases(self) -> None:
        codes, _ = extract_codes.split_codes("xz42pwc")
        assert codes == ["XZ42PWC"]


class TestParseCell:
    def test_lifts_a_parenthetical_into_a_note(self) -> None:
        codes, note, url = extract_codes.parse_cell("A541100 (expired 2022)")
        assert codes == ["A541100"]
        assert note == "expired 2022"
        assert url is None

    def test_keeps_a_booking_url_with_no_code(self) -> None:
        codes, _, url = extract_codes.parse_cell("https://stay.hilton.com/deloitte/")
        assert codes == []
        assert url == "https://stay.hilton.com/deloitte/"

    def test_prose_yields_no_code(self) -> None:
        codes, _, _ = extract_codes.parse_cell("ask your travel desk")
        assert codes == []


class TestParseCompany:
    """The first column is a name column by convention only."""

    @pytest.mark.parametrize("name", ["3M", "IBM", "PwC", "Campbell Hausfield and Powerex"])
    def test_keeps_real_names(self, name: str) -> None:
        assert extract_codes.parse_company(name) == (name, None)

    def test_lifts_a_qualifier_even_when_the_qualifier_reads_like_a_remark(self) -> None:
        # Testing the remark patterns against the raw cell rejected the whole
        # thing; they belong against the name, after the lift.
        assert extract_codes.parse_company("Nestle (100% subsidiary)") == (
            "Nestle",
            "100% subsidiary",
        )

    def test_lifts_a_qualifier_out_of_the_name(self) -> None:
        assert extract_codes.parse_company("CareerBuilder (Americas Only)") == (
            "CareerBuilder",
            "Americas Only",
        )

    def test_strips_a_code_typed_into_the_name_column(self) -> None:
        name, note = extract_codes.parse_company("(for HGVC only) 0302844100 Siemens")
        assert name == "Siemens"
        assert note == "for HGVC only; 0302844100"

    @pytest.mark.parametrize(
        "prose",
        [
            # One fixture per guard, each rejected by that guard ALONE. The
            # first version of these tests used realistic prose, which every
            # guard caught — so deleting any single guard left all of them
            # green and none of the three decisions was actually pinned.
            pytest.param("Acme 50% owned", id="percent-only"),
            pytest.param("NOTE: still to confirm", id="label-only"),
            pytest.param("Acme Holdings and more...", id="ellipsis-only"),
            pytest.param("Acme YMMV", id="ymmv-only"),
            pytest.param("Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota", id="too-long"),
            # Six words: past SENTENCE_WORDS but inside MAX_NAME_WORDS, so the
            # sentence rule is the only thing that can reject it.
            pytest.param("Renamed last year. Check before booking", id="sentence-only"),
            # And the ones actually in the workbook.
            pytest.param("(Americas only)", id="qualifier-only"),
            pytest.param("(LON, AMS)", id="cities-only"),
        ],
    )
    def test_refuses_to_call_a_remark_a_company(self, prose: str) -> None:
        name, note = extract_codes.parse_company(prose)
        assert name is None
        # The text survives as provenance — the codes beside it are usually
        # real, so the caller files them under Unattributed rather than
        # dropping them.
        assert note == prose

    def test_an_empty_cell_names_nothing_at_all(self) -> None:
        assert extract_codes.parse_company("") == (None, None)

    @pytest.mark.parametrize(
        "name",
        [
            # Being too eager here is the quiet failure: the employer's codes
            # still ship, filed under Unattributed, where nobody can find them
            # by name and nothing goes red.
            "St. Jude Medical",
            "A.G. Edwards & Sons",
            "Sun Microsystems Inc. USA",
            "eBay Enterprise Global",
            "lululemon athletica inc",
            "1-800 Contacts",
            "1901 Group",
            "Ernst & Young LLP Global Business Travel",
            # Six words, so past SENTENCE_WORDS: only SENTENCE_RE staying
            # case-sensitive keeps this. With IGNORECASE, [a-z]{2} matches "St".
            "St. Jude Medical Center Travel Office",
        ],
    )
    def test_does_not_refuse_a_real_employer(self, name: str) -> None:
        assert extract_codes.parse_company(name)[0] == name

    def test_strips_decoration_left_by_a_removed_parenthetical(self) -> None:
        # Otherwise "Booz & Co ///" wins the slug merge against a clean
        # "Booz & Co" and the published name gets worse, not better.
        assert extract_codes.parse_company("Booz & Co (Now Strategy&) ///")[0] == "Booz & Co"


class TestParseHiltonSheet:
    """The 'Hilton Code' sheet had no tests, which is how it shipped 24 codes
    that were words cut off the front of employers' names.

    Every row here is "N-number / account-number Employer", so every real code
    on this sheet carries a digit. That is the property the parser leans on.
    """

    @staticmethod
    def parse(*lines: str) -> list[dict]:
        return extract_codes.parse_hilton_sheet([(line,) for line in lines])

    def test_reads_the_ordinary_shape(self) -> None:
        records = self.parse("N0001542 / 0232757100 3M")
        assert [r["code"] for r in records] == ["N0001542", "0232757100"]
        assert {r["company"] for r in records} == {"3M"}

    def test_does_not_eat_a_multi_word_employer(self) -> None:
        # "Bank of America" shipped as codes BANK and OF, under a company
        # called "America".
        records = self.parse("N0710081 / 0052752100 Bank of America")
        assert [r["code"] for r in records] == ["N0710081", "0052752100"]
        assert {r["company"] for r in records} == {"Bank of America"}

    def test_keeps_two_employers_apart(self) -> None:
        # Both collapsed to a company called "Industries" and merged into one
        # six-code entry belonging to neither.
        records = self.parse(
            "N0870150 / 0560001396 Koch Industries",
            "N9886588 / 0550000139 Shaw Industries",
        )
        assert {r["company"] for r in records} == {"Koch Industries", "Shaw Industries"}

    @pytest.mark.parametrize(
        ("line", "company", "codes"),
        [
            # A name that is *entirely* code-shaped left nothing to be the
            # company, so the row was dropped whole — both codes with it.
            # BP/Dell/Sixt carry no digit, so the letters-only rule alone
            # recovers them. 3M does carry one, and is the row that needs the
            # reserved last token — mutation testing showed the others pass
            # without it, so it has to be in this list for the rule to be
            # pinned here at all.
            ("N0001542 / 0232757100 3M", "3M", ["N0001542", "0232757100"]),
            ("N2728493 / 2728493 BP", "BP", ["N2728493", "2728493"]),
            ("N7654328 / 550000750 Dell", "Dell", ["N7654328", "550000750"]),
            ("0002709212 Sixt", "Sixt", ["0002709212"]),
        ],
    )
    def test_a_code_shaped_name_is_not_eaten(
        self, line: str, company: str, codes: list[str]
    ) -> None:
        records = self.parse(line)
        assert [r["code"] for r in records] == codes
        assert {r["company"] for r in records} == {company}

    def test_recovers_a_row_behind_a_stray_character(self) -> None:
        # Row 24: the leading "à" is not code-shaped, so the loop collected
        # nothing and a real employer was skipped in silence.
        records = self.parse("à / 560002892 Benjamin Moore and Company")
        assert [r["code"] for r in records] == ["560002892"]
        assert {r["company"] for r in records} == {"Benjamin Moore and Company"}

    def test_drops_a_lowercase_typo_before_the_name(self) -> None:
        records = self.parse("N2687918 / 560047583 is Campbell Hausfield and Powerex")
        assert {r["company"] for r in records} == {"Campbell Hausfield and Powerex"}

    def test_still_refuses_a_margin_note(self) -> None:
        # This one produced three codes — LET, ME and ADD — off the front of a
        # sentence. It is a note, so it should yield nothing at all.
        extract_codes.SKIPPED.clear()
        records = self.parse("Let me add a few I've umulated for EMEA. Again, YMMV.")
        assert records == []
        assert extract_codes.SKIPPED, "a dropped row must not be dropped silently"

    def test_a_qualifier_still_lands_under_unattributed(self) -> None:
        # Row 56 is a real employer row — "Fiat (Americas only)" — and Fiat was
        # absent from the database entirely because FIAT was eaten as a code.
        records = self.parse("N0394181 / 0000394181 Fiat (Americas only)")
        assert [r["code"] for r in records] == ["N0394181", "0000394181"]
        assert {r["company"] for r in records} == {"Fiat"}
        assert all(r["note"] == "Americas only" for r in records)

    def test_records_what_it_skips(self) -> None:
        extract_codes.SKIPPED.clear()
        self.parse("NOTE: these have not been confirmed")
        assert len(extract_codes.SKIPPED) == 1

    def test_refuses_to_make_a_company_out_of_an_account_number(self) -> None:
        # Reserving the last token has to not publish it as an employer when
        # the row genuinely has none. No such row is in the workbook; the point
        # is that if one appears it is reported rather than invented.
        extract_codes.SKIPPED.clear()
        records = self.parse("N1234567 / 0001234567")
        assert records == []
        assert extract_codes.SKIPPED

    def test_an_employer_whose_name_is_code_shaped_is_still_an_employer(self) -> None:
        # The other side of the same rule, and the reason it tests the account
        # -number shape rather than looks_like_code: "3M" passes the latter.
        records = self.parse("N0001542 / 0232757100 3M")
        assert {r["company"] for r in records} == {"3M"}
        assert [r["code"] for r in records] == ["N0001542", "0232757100"]

    @pytest.mark.parametrize(
        "line",
        [
            "N1111111 / 0002222222 de Beers Group",
            "N1111111 / 0002222222 von der Heyden Group",
            "N1111111 / 0002222222 el Corte Ingles",
        ],
    )
    def test_keeps_the_particles_in_a_real_name(self, line: str) -> None:
        # A "short lowercase word" rule would eat these. The typo list is a
        # list for exactly this reason.
        company = next(iter({r["company"] for r in self.parse(line)}))
        assert company.split()[0] in {"de", "von", "el"}


class TestParseGridSheet:
    def test_reports_a_url_where_the_employer_should_be(self) -> None:
        # Nothing is lost to these in today's workbook, but a URL row carrying
        # the only copy of a code would vanish exactly the way Benjamin Moore
        # did — and the summary would still look healthy. The code count in the
        # message is what tells a harmless duplicate from a real loss.
        extract_codes.SKIPPED.clear()
        rows = [
            ("Company", "Hilton", "Marriott"),
            ("http://www.hotelcorporatecodes.com/83/x", "92836100", None),
        ]
        records = extract_codes.parse_grid_sheet("Corp Codes", rows)
        assert records == []
        assert len(extract_codes.SKIPPED) == 1
        assert "1 code(s) beside it" in extract_codes.SKIPPED[0]
        assert "row 2" in extract_codes.SKIPPED[0]

    def test_an_empty_row_is_not_worth_reporting(self) -> None:
        # Padding at the bottom of a sheet names nothing and never did.
        extract_codes.SKIPPED.clear()
        extract_codes.parse_grid_sheet("Corp Codes", [("Company", "Hilton"), (None, None)])
        assert extract_codes.SKIPPED == []


class TestSlugify:
    def test_collapses_punctuation(self) -> None:
        assert extract_codes.slugify("Ernst & Young") == "ernst-young"
        assert extract_codes.slugify("  Booz & Co  ///") == "booz-co"
