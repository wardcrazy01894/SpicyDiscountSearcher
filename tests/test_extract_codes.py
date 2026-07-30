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
            "(Americas only)",
            "(LON, AMS)",
            "a few I have accumulated for EMEA. Again, YMMV.",
            "seems to offer 40% off, with breakfast, provided the booking starts on a Friday",
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


class TestSlugify:
    def test_collapses_punctuation(self) -> None:
        assert extract_codes.slugify("Ernst & Young") == "ernst-young"
        assert extract_codes.slugify("  Booz & Co  ///") == "booz-co"
