"""Tests use the example bulletin printed in WPC's own decoding guide."""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fronts  # noqa: E402

SAMPLE = """\
CODED SURFACE FRONTAL POSITIONS (IAC FLEET)
NWS WEATHER PREDICTION CENTER COLLEGE PARK MD
VALID 120612Z
HIGHS 1036 4391169 1037 4051079 1031 3850701 1033 4901183
1026 3220892 1022 3571272
LOWS 1018 4681013 1017 3420986 998 5040817 1002 5770777 999 7491590 998
6820769 999 7611335 986 6300408 985 6910524 994 6410555 968 5410273
STNRY 2660729 2530763 2350807 2230836 2060863 1820877 1580880
TROF 3410986 3291003 3191023 3121044
COLD 4440850 4290863 4160879 4030904 3980931 4050954 4180966
OCFNT 5030817 4830826 4620838 4440850
WARM 5641373 5481339 5251313 4981295 4921292 4711283 4531278
TROF 3211165 3441198 3661223 3941243
COLD 5631375 5161360 4651357 4181371 3941386
$$
"""

REF = datetime(2026, 12, 6, 15, tzinfo=timezone.utc)


def test_position_decoding():
    assert fronts.decode_position("4391169") == (43.9, -116.9)
    assert fronts.decode_position("4440850") == (44.4, -85.0)
    assert fronts.decode_position("60144") == (60.0, -144.0)  # 1-degree format


def test_valid_time():
    gj = fronts.parse_bulletin(SAMPLE, REF)
    assert gj["properties"]["valid"] == "2026-12-06T12:00:00Z"


def test_valid_time_year_rollover():
    # Bulletin for Dec 31 read on Jan 1 must not jump to the following December.
    ref = datetime(2027, 1, 1, 1, tzinfo=timezone.utc)
    gj = fronts.parse_bulletin("VALID 123121Z\nCOLD 4440850 4290863\n", ref)
    assert gj["properties"]["valid"] == "2026-12-31T21:00:00Z"


def test_counts_and_types():
    gj = fronts.parse_bulletin(SAMPLE, REF)
    lines = [f for f in gj["features"] if f["properties"]["kind"] == "front"]
    types = sorted(f["properties"]["type"] for f in lines)
    assert types == ["COLD", "COLD", "OCFNT", "STNRY", "TROF", "TROF", "WARM"]
    assert sum(f["properties"]["kind"] == "high" for f in gj["features"]) == 6
    assert sum(f["properties"]["kind"] == "low" for f in gj["features"]) == 11


def test_cold_front_geometry_matches_wpc_guide():
    gj = fronts.parse_bulletin(SAMPLE, REF)
    cold = [f for f in gj["features"] if f["properties"].get("type") == "COLD"][0]
    coords = cold["geometry"]["coordinates"]
    assert coords[0] == [-85.0, 44.4]
    assert coords[-1] == [-96.6, 41.8]
    assert len(coords) == 7


def test_pressure_centers_across_wrapped_lines():
    gj = fronts.parse_bulletin(SAMPLE, REF)
    lows = {(f["properties"]["pressure_mb"], tuple(f["geometry"]["coordinates"]))
            for f in gj["features"] if f["properties"]["kind"] == "low"}
    # "998" ends one line and its position starts the next.
    assert (998, (-76.9, 68.2)) in lows
    assert (1018, (-101.3, 46.8)) in lows


def test_intensity_words_old_format():
    gj = fronts.parse_bulletin("VALID 020603Z\nOCFNT WK 60144 59137 55131 51129 49129\n", REF)
    f = gj["features"][0]
    assert f["properties"]["intensity"] == "WK" and len(f["geometry"]["coordinates"]) == 5


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
