# CONUS surface weather map

A web map of the continental US with three independent, toggleable layers:

| Layer | Source | Notes |
|---|---|---|
| Surface temperature | Google DeepMind **WeatherNext 3**, `temperature_2m` | 64-member ensemble mean, °F, 6-hourly out to +72 h |
| Dew point | WeatherNext 3, `dewpoint_temperature_2m` | same |
| Fronts & pressure centers | NWS **Weather Prediction Center** high-resolution coded surface bulletin | human-drawn *analysis*, every 3 h — not model output |

The page is static (HTML/JS + JSON files). A scheduled job rebuilds the JSON; there is no server to run.

```
scripts/fronts.py         WPC bulletin  -> site/data/fronts.json   (tested against WPC's own example)
scripts/generate_data.py  WeatherNext 3 -> site/data/h006.json ... + manifest.json
site/                     index.html, app.js, lib.js, states.json  (Leaflet map)
tests/                    python tests/test_fronts.py ; node tests/test_lib.js
.github/workflows/        update.yml - rebuilds data every 3 h and publishes to the `deploy` branch
```

## Run it locally (no Google account needed)

```bash
python scripts/generate_data.py --synthetic      # fake fields so you can see the page; banner says TEST DATA
python scripts/fronts.py --from-file my_bulletin.txt   # or omit --from-file to download the latest from WPC
cd site && python -m http.server 8000            # open http://localhost:8000
```

Share a view with a URL hash: `#layers=temp,fronts&h=3` (layers: `temp`, `dew`, `fronts`, or `none`; `h` = forecast-hour index).

## Real WeatherNext data

```bash
pip install -r requirements.txt
gcloud auth application-default login            # the Google account approved for WeatherNext
python scripts/generate_data.py --project YOUR_GCP_PROJECT
```

The bucket is **Requester Pays**, so reads bill `YOUR_GCP_PROJECT` (this job reads a small CONUS slice).

## Put it on GitHub + Render

1. Push this folder to a GitHub repo (`main` holds code only; `site/data/` is git-ignored).
2. Repo → Settings → Secrets and variables → Actions: add `GCP_SA_KEY` (service-account JSON) and `GCP_BILLING_PROJECT`.
   **Check first** that the service account has WeatherNext access — the approval was granted to your Google account, so a service
   account may need to be added (weathernext@google.com). It also needs the *Service Usage Consumer* role on the billing project.
3. Actions tab → "Update map data" → Run workflow. It creates the `deploy` branch.
4. Render → New → **Static Site** → pick the repo, branch `deploy`, build command empty, publish directory `.`.
   Every 3 hours the workflow pushes a new commit to `deploy` and Render redeploys.

## Before making it public

- **WeatherNext terms.** Real-time WeatherNext output is under Google's experimental-data terms. Read them before publishing derived maps, and keep the attribution. If they require a delay, add a minimum-age filter when choosing the run in `latest_init_prefix`.
- **WPC data** is US-government public domain; credit the NWS Weather Prediction Center.
- **Basemap tiles** are from CARTO, falling back to OpenStreetMap (attribution is in the page). Fine for a small site; heavy traffic needs a tile provider plan.
- **State outlines** (`site/states.json`) are bundled from US Census boundaries via the `us-atlas` package, so geography shows even if tile servers are blocked.

## Known limitations

- Front lines use the standard colors but not the triangle/semicircle barbs; stationary fronts are alternating blue/red dashes.
- The model fill is a rectangle over the CONUS box (includes Canada, Mexico, nearby ocean); it is not clipped to the US outline.
- Fronts are an analysis at one time; the model slider is a forecast. "Match fronts" jumps to the closest model hour.
- Not verified against live data yet: the WPC bulletin URL and the WeatherNext Zarr variable layout (see below).

## Verify on first real run

`generate_data.py` was written from Google's starter notebook but has **not been run against the real bucket**. If it errors, the likely spots are:
the run-folder listing (`latest_init_prefix`), the lat/lon dimension names (found by prefix `lat`/`lon`), and whether `lead_time` of 6/12/… with `lead_subtime` 0 exists for `temperature_2m`.
`fronts.py` tries three WPC URLs and refuses to overwrite the output if nothing parses.
