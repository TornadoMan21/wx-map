"""Build the model data files the web map reads: 2 m temperature and 2 m dew point over the CONUS.

Real mode reads WeatherNext 3 statistics from the Zarr bucket on Google Cloud Storage. It reads Google's precomputed ensemble-mean fields (no billing project needed).

    python scripts/generate_data.py --out site/data

Synthetic mode writes made-up smooth fields so the web page can be developed offline. The
manifest is flagged synthetic and the page shows a banner, so it can never pass for a forecast.

    python scripts/generate_data.py --synthetic --out site/data

Output per forecast hour:  <out>/h<LEAD>.json
    {"t": [...], "td": [...]}  flat row-major arrays, rows run SOUTH -> NORTH, columns WEST -> EAST,
    values are integer tenths of a degree F; -32768 marks missing.
Plus <out>/manifest.json describing the grid, init time and available hours.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from datetime import datetime, timedelta, timezone

import numpy as np

# CONUS box in conventional -180..180 longitudes.
LAT_MIN, LAT_MAX = 24.0, 50.5
LON_MIN, LON_MAX = -125.0, -66.0
MISSING = -32768


def k_to_tenths_f(arr_k: np.ndarray) -> np.ndarray:
    f = (arr_k - 273.15) * 9.0 / 5.0 + 32.0
    out = np.full(f.shape, MISSING, dtype=np.int32)
    ok = np.isfinite(f)
    out[ok] = np.rint(f[ok] * 10).astype(np.int32)
    return out


def write_hour(out_dir: str, lead_h: int, t_tenths_f: np.ndarray, td_tenths_f: np.ndarray):
    with open(os.path.join(out_dir, f"h{lead_h:03d}.json"), "w") as f:
        json.dump({"t": t_tenths_f.ravel().tolist(), "td": td_tenths_f.ravel().tolist()}, f, separators=(",", ":"))


def write_manifest(out_dir, init, hours, grid, source, synthetic):
    manifest = {
        "model": "WeatherNext 3 (ensemble mean)" if not synthetic else "SYNTHETIC TEST DATA - NOT A FORECAST",
        "synthetic": synthetic,
        "source": source,
        "init": init.strftime("%Y-%m-%dT%H:00:00Z"),
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:00Z"),
        "units": "tenths of a degree F",
        "grid": grid,
        "hours": [{"lead": h, "valid": (init + timedelta(hours=h)).strftime("%Y-%m-%dT%H:00:00Z"), "file": f"h{h:03d}.json"} for h in hours],
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)


# ---------------------------------------------------------------- synthetic
def synthetic(out_dir: str, hours, init: datetime):
    lats = np.arange(LAT_MIN, LAT_MAX + 1e-6, 0.25)
    lons = np.arange(LON_MIN, LON_MAX + 1e-6, 0.25)
    LON, LAT = np.meshgrid(lons, lats)
    for h in hours:
        valid = init + timedelta(hours=h)
        diurnal = 8 * math.cos((valid.hour - 20) / 24 * 2 * math.pi)       # peak ~20Z
        front = 12 * np.tanh((LON + 95 + 0.4 * h - 0.5 * (LAT - 37)) / 6)   # a drifting "cold front"
        t = 78 - 1.1 * (LAT - 25) + diurnal + front + 3 * np.sin(LON / 4)
        td = np.minimum(t - 4, 70 - 0.9 * (LAT - 25) + 0.15 * (LON + 100) * 0 + 5 * np.tanh(-(LON + 95 + 0.4 * h) / 8))
        write_hour(out_dir, h, ((t - 0) * 10).astype(np.int32), (td * 10).astype(np.int32))
    grid = {"lat0": LAT_MIN, "lon0": LON_MIN, "dlat": 0.25, "dlon": 0.25, "nlat": len(lats), "nlon": len(lons)}
    write_manifest(out_dir, init, hours, grid, "synthetic", True)


# ---------------------------------------------------------------- real
# Google publishes precomputed ensemble statistics (_mean, _p10 ... _p90) in a separate, NOT Requester-Pays
# bucket, with one continuous hourly lead_time axis. Reading the mean from there is ~64x less data than
# averaging the raw members ourselves.
STATS_BUCKET = "weathernext3_statistics_spatial"
STATS_ROOT = "weathernext_3_0_0_statistics/zarr/2026_to_present/"


def make_store(prefix: str | None = None):
    """GCS store for the statistics bucket. Uses your Google login if there is one, anonymous otherwise."""
    from obstore.store import GCSStore
    kwargs = {"prefix": prefix} if prefix else {}
    try:
        import google.auth
        from obstore.auth.google import GoogleCredentialProvider
        # Ask for scopes explicitly: impersonated / federated logins (used by the GitHub job) need them.
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        return GCSStore(STATS_BUCKET, credential_provider=GoogleCredentialProvider(creds), **kwargs)
    except Exception:
        return GCSStore(STATS_BUCKET, skip_signature=True, **kwargs)


def open_store(prefix: str):
    import zarr
    return zarr.storage.ObjectStore(make_store(prefix))


def list_init_prefixes() -> list[str]:
    """Run folders (YYYYMMDD_HHhr_NN_preds), newest first."""
    listing = make_store().list_with_delimiter(STATS_ROOT)
    names = sorted((p.rstrip("/").split("/")[-1] for p in listing["common_prefixes"]), reverse=True)
    names = [n for n in names if n.endswith("_preds")]
    if not names:
        raise RuntimeError("No *_preds run folders found under " + STATS_ROOT)
    return [f"{STATS_ROOT}{n}/predictions.zarr" for n in names]


def chunk_estimate(da, picks):
    """Estimate what reading `picks` ({dim: integer positions}) downloads: (chunks_needed, uncompressed_bytes_per_chunk)."""
    n, per = 1, da.dtype.itemsize
    for dim, sizes in zip(da.dims, da.chunks):
        cs = max(sizes)
        per *= cs
        pos = picks.get(dim)
        if pos is None:
            pos = range(da.sizes[dim])
        n *= len({int(q) // cs for q in pos})
    return n, per


def pick_var(ds, base: str) -> str:
    """Find the ensemble-mean variable for `base` (e.g. temperature_2m -> temperature_2m_mean)."""
    for name in (f"{base}_mean", base):
        if name in ds.data_vars:
            return name
    cands = [v for v in ds.data_vars if v.startswith(base) and "mean" in v]
    if cands:
        return cands[0]
    raise SystemExit(f"No mean variable for {base}. Variables here: {sorted(ds.data_vars)[:60]}")


def real(out_dir: str, hours, prefix: str | None, stride: int, dry_run: bool):
    import xarray as xr

    # A run folder can exist before Google has finished writing it; unwritten chunks read back as all-NaN.
    # So test the last requested hour and step back to an earlier run if it is empty.
    candidates = [prefix] if prefix else list_init_prefixes()[:6]
    ds = None
    for cand in candidates:
        print("trying", cand, flush=True)
        try:
            d = xr.open_zarr(open_store(cand), chunks={})
            v = pick_var(d, "temperature_2m")
            lv = d["lead_time"].values
            last = max((h for h in hours if np.timedelta64(h, "h") in lv), default=None)
            if last is None:
                print("   no requested hours in this run, skipping")
                continue
            probe = d[v].isel(lead_time=int(np.where(lv == np.timedelta64(last, "h"))[0][0])).sel(
                **{next(k for k in d[v].dims if k.startswith("lat")): slice(35, 40) if d[next(k for k in d[v].dims if k.startswith("lat"))].values[0] < d[next(k for k in d[v].dims if k.startswith("lat"))].values[-1] else slice(40, 35)})
            if not np.isfinite(probe.values).any():
                print(f"   +{last} h is empty (run still being written?) - trying an earlier run")
                continue
            ds, prefix = d, cand
            break
        except Exception as e:
            print("   could not use this run:", type(e).__name__, e)
    if ds is None:
        raise SystemExit("No complete run found among the newest ones. Try again later, or pass --init-prefix.")
    print("using", prefix, flush=True)
    vt, vd = pick_var(ds, "temperature_2m"), pick_var(ds, "dewpoint_temperature_2m")
    da = ds[vt]
    print("variables      :", vt, "/", vd)
    print("variable dims  :", dict(da.sizes))
    print("zarr chunk size:", {d: max(c) for d, c in zip(da.dims, da.chunks)}, flush=True)

    ylat = next(d for d in da.dims if d.startswith("lat"))
    xlon = next(d for d in da.dims if d.startswith("lon"))
    lon_lo, lon_hi = LON_MIN % 360, LON_MAX % 360                    # dataset longitudes are 0-360
    lat_idx = np.where((ds[ylat].values >= LAT_MIN) & (ds[ylat].values <= LAT_MAX))[0]
    lon_idx = np.where((ds[xlon].values >= lon_lo) & (ds[xlon].values <= lon_hi))[0]

    lead_vals = ds["lead_time"].values
    avail = sorted(int(v / np.timedelta64(1, "h")) for v in lead_vals)
    print(f"lead_time      : {avail[0]}..{avail[-1]} h ({len(avail)} values)")
    hours = [h for h in hours if h in avail]
    if not hours:
        raise SystemExit(f"None of the requested hours exist in this run (available {avail[0]}..{avail[-1]} h)")
    lead_pos = [int(np.where(lead_vals == np.timedelta64(h, "h"))[0][0]) for h in hours]

    picks = {"lead_time": np.array(lead_pos), ylat: lat_idx, xlon: lon_idx}
    chunks_n, per = chunk_estimate(da, picks)
    print(f"\nPlan: {len(hours)} hours x 2 variables (ensemble mean), grid stride {stride}", flush=True)
    print(f"      about {2 * chunks_n} chunk reads, up to ~{2 * chunks_n * per / 1e9:.2f} GB uncompressed "
          f"(compressed transfer is usually smaller)", flush=True)
    if dry_run:
        print("Dry run: nothing downloaded. Re-run without --dry-run to fetch it.")
        return

    sub = ds[[vt, vd]].isel(**{ylat: lat_idx[::stride], xlon: lon_idx[::stride]}).isel(lead_time=lead_pos)
    sub = sub.sortby(ylat).sortby(xlon)                              # south->north, west->east
    lats, lons = sub[ylat].values, sub[xlon].values
    init = datetime.fromtimestamp(int(ds["init_time"].values.astype("datetime64[s]").astype("int64")), tz=timezone.utc)

    import time
    from dask.diagnostics import ProgressBar
    t0 = time.time()
    print("Downloading (progress bar below)...", flush=True)
    with ProgressBar():
        snap = sub.load()
    print(f"Downloaded in {time.time() - t0:.0f} s. Writing files...", flush=True)

    for i, h in enumerate(hours):
        one = snap.isel(lead_time=i)
        t_arr, d_arr = k_to_tenths_f(one[vt].values), k_to_tenths_f(one[vd].values)
        write_hour(out_dir, h, t_arr, d_arr)
        ok = t_arr != MISSING
        rng = f"T {t_arr[ok].min() / 10:.0f}..{t_arr[ok].max() / 10:.0f} F" if ok.any() else "NO VALID DATA"
        print(f"  +{h:03d}h written  ({ok.mean() * 100:.0f}% valid, {rng})", flush=True)
    grid = {"lat0": float(lats[0]), "lon0": float(lons[0] - 360 if lons[0] > 180 else lons[0]),
            "dlat": float(np.median(np.diff(lats))), "dlon": float(np.median(np.diff(lons))),
            "nlat": int(len(lats)), "nlon": int(len(lons))}
    write_manifest(out_dir, init, hours, grid, f"gs://{STATS_BUCKET}/{prefix}", False)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="site/data")
    ap.add_argument("--hours", default="3-48:3", help="START-END:STEP forecast hours (default 3-48:3; hours missing from the run are skipped)")
    ap.add_argument("--init-prefix", help="explicit Zarr prefix inside the bucket (default: newest run)")
    ap.add_argument("--synthetic", action="store_true", help="write fake data for offline page development")
    ap.add_argument("--stride", type=int, default=2, help="keep every Nth 0.1 deg grid point (2 = 0.2 deg, smaller files)")
    ap.add_argument("--dry-run", action="store_true", help="open the dataset, print the estimated download size, and stop")
    args = ap.parse_args()

    a, rest = args.hours.split("-", 1)
    b, step = rest.split(":")
    hours = list(range(int(a), int(b) + 1, int(step)))
    os.makedirs(args.out, exist_ok=True)

    if args.synthetic:
        now = datetime.now(timezone.utc)
        synthetic(args.out, hours, now.replace(hour=now.hour // 6 * 6, minute=0, second=0, microsecond=0))
    else:
        real(args.out, hours, args.init_prefix, args.stride, args.dry_run)
    print("done ->", args.out)


if __name__ == "__main__":
    main()
