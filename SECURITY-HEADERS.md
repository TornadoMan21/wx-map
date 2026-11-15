# Security headers for the Render static site

Render static sites set response headers in the dashboard: **Service → Settings → Headers**.
Add one row per header below, with Request Path `/*`. Values are sent exactly as written.

| Header name | Value |
| --- | --- |
| Content-Security-Policy | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://server.arcgisonline.com https://opengeo.ncep.noaa.gov; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
| X-Content-Type-Options | `nosniff` |
| X-Frame-Options | `DENY` |
| Referrer-Policy | `strict-origin-when-cross-origin` |
| Permissions-Policy | `geolocation=(), camera=(), microphone=(), payment=(), usb=()` |
| Cross-Origin-Opener-Policy | `same-origin` |
| Strict-Transport-Security | `max-age=31536000` |

## What the Content-Security-Policy allows

- Scripts, fonts and data files: only this site's own files (Leaflet and the fonts are self-hosted in `vendor/`).
- Styles: this site plus inline styles (the page and the legends use inline styles).
- Images: this site, `data:` images, Esri map tiles (`server.arcgisonline.com`) and NOAA radar (`opengeo.ncep.noaa.gov`).
- Nothing may embed this page in a frame, load plugins, or submit forms elsewhere.

## If you change something

- Adding a CARTO background map: add `https://basemaps.cartocdn.com` to `img-src`.
- Adding another data or tile source: add its host to `img-src` (images) or `connect-src` (fetch requests).
- If a layer stops showing after a change, open the browser console (F12): blocked requests are reported as "Content Security Policy" errors that name the blocked host.
