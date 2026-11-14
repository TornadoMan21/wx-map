"""Fetch and parse the WPC high-resolution coded surface bulletin into GeoJSON.

Bulletin format (https://www.wpc.ncep.noaa.gov/html/read_coded_bull_hrtxt.html):

    VALID 120612Z                       month/day/hour (MMDDHH), UTC
    HIGHS 1036 4391169 1037 4051079     pressure (mb) + position
    LOWS  1018 4681013 ...
    COLD  4440850 4290863 ...           front/trough polyline
    OCFNT / WARM / STNRY / TROF ...

A position is 7 digits: 3 digits latitude (tenths of a degree north) followed
by 4 digits longitude (tenths of a degree WEST). The older 1-degree bulletin
uses 5 digits (2 + 3) and may carry intensity words (WK / MDT / STG); both are
accepted here.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone

# Tried in order. The HR product has lived under both hpc. and wpc. hostnames.
BULLETIN_URLS = [
    "https://www.wpc.ncep.noaa.gov/discussions/codsus_hr",
    "https://www.wpc.ncep.noaa.gov/discussions/codsus_hires",
    "https://www.hpc.ncep.noaa.gov/discussions/codsus_hr",
]

LINE_TYPES = {"COLD", "WARM", "STNRY", "OCFNT", "TROF"}
INTENSITY = {"WK", "MDT", "STG"}
STOP_TOKENS = {"NNNN", "$$"}


def decode_position(tok: str):
    """'4391169' -> (43.9, -116.9) as (lat, lon) with lon in -180..180 (west negative)."""
    if len(tok) == 7:
        lat, lon = int(tok[:3]) / 10.0, int(tok[3:]) / 10.0
    elif len(tok) == 5:
        lat, lon = float(int(tok[:2])), float(int(tok[2:]))
    else:
        raise ValueError(f"not a position token: {tok!r}")
    return lat, -lon


def _valid_datetime(mmddhh: str, ref: datetime) -> datetime:
    month, day, hour = int(mmddhh[0:2]), int(mmddhh[2:4]), int(mmddhh[4:6])
    year = ref.year
    dt = datetime(year, month, day, hour, tzinfo=timezone.utc)
    # A December bulletin read in early January (or the reverse) belongs to the neighbouring year.
    if (dt - ref).days > 200:
        dt = dt.replace(year=year - 1)
    elif (ref - dt).days > 200:
        dt = dt.replace(year=year + 1)
    return dt


def parse_bulletin(text: str, ref: datetime | None = None) -> dict:
    """Return a GeoJSON FeatureCollection with fronts/troughs (LineString) and highs/lows (Point)."""
    ref = ref or datetime.now(timezone.utc)
    valid = None
    features = []
    section = None          # current keyword
    intensity = None
    pending_pressure = None
    current_line = None

    def flush_line():
        nonlocal current_line
        if current_line and len(current_line["coords"]) >= 2:
            features.append({
                "type": "Feature",
                "properties": {"kind": "front", "type": current_line["type"], "intensity": current_line["intensity"]},
                "geometry": {"type": "LineString", "coordinates": current_line["coords"]},
            })
        current_line = None

    tokens = re.findall(r"[A-Z$]+|\d+", text.upper())
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in STOP_TOKENS:
            break
        if tok == "VALID" and i + 1 < len(tokens):
            m = re.fullmatch(r"(\d{6})Z?", tokens[i + 1] + ("Z" if i + 2 < len(tokens) and tokens[i + 2] == "Z" else ""))
            if re.fullmatch(r"\d{6}", tokens[i + 1]):
                valid = _valid_datetime(tokens[i + 1], ref)
                i += 2
                continue
        if tok in ("HIGHS", "LOWS") or tok in LINE_TYPES:
            flush_line()
            section, intensity, pending_pressure = tok, None, None
            if tok in LINE_TYPES:
                current_line = {"type": tok, "intensity": None, "coords": []}
            i += 1
            continue
        if tok in INTENSITY and current_line is not None and not current_line["coords"]:
            current_line["intensity"] = tok
            i += 1
            continue
        if tok.isdigit() and section in ("HIGHS", "LOWS"):
            if len(tok) in (7, 5) and pending_pressure is not None:
                lat, lon = decode_position(tok)
                features.append({
                    "type": "Feature",
                    "properties": {"kind": "high" if section == "HIGHS" else "low", "pressure_mb": pending_pressure},
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                })
                pending_pressure = None
            elif len(tok) in (3, 4):
                pending_pressure = int(tok)
        elif tok.isdigit() and current_line is not None and len(tok) in (7, 5):
            lat, lon = decode_position(tok)
            current_line["coords"].append([lon, lat])
        i += 1
    flush_line()

    return {
        "type": "FeatureCollection",
        "properties": {
            "source": "NWS Weather Prediction Center high-resolution coded surface bulletin",
            "valid": valid.strftime("%Y-%m-%dT%H:00:00Z") if valid else None,
        },
        "features": features,
    }


def fetch_bulletin(urls=BULLETIN_URLS, timeout=30) -> str:
    last_err = None
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "wx-map/0.1 (personal weather map)"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                text = r.read().decode("utf-8", "replace")
            if "VALID" in text.upper():
                return text
            last_err = RuntimeError(f"{url}: response had no VALID line")
        except Exception as e:  # network failures fall through to the next URL
            last_err = e
    raise RuntimeError(f"Could not fetch a WPC coded bulletin: {last_err}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="site/data/fronts.json")
    ap.add_argument("--from-file", help="parse a saved bulletin instead of downloading")
    args = ap.parse_args(argv)
    text = open(args.from_file).read() if args.from_file else fetch_bulletin()
    gj = parse_bulletin(text)
    if not gj["properties"]["valid"] or not gj["features"]:
        sys.exit("Parsed no fronts/valid time - refusing to overwrite output")
    with open(args.out, "w") as f:
        json.dump(gj, f, separators=(",", ":"))
    n_lines = sum(1 for x in gj["features"] if x["properties"]["kind"] == "front")
    print(f"wrote {args.out}: valid {gj['properties']['valid']}, {n_lines} lines, {len(gj['features']) - n_lines} pressure centers")


if __name__ == "__main__":
    main()
