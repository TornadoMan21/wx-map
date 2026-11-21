/* Pure helpers (no DOM, no Leaflet) so they can be unit-tested in Node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WxLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MISSING = -32768;

  // Degrees F -> RGB. Freezing (32F) sits at the cyan/green boundary so it reads at a glance.
  const TEMP_STOPS = [
    [-20, [75, 0, 130]], [-10, [60, 40, 180]], [0, [40, 80, 220]], [10, [30, 140, 240]],
    [20, [60, 190, 240]], [32, [150, 225, 235]], [40, [120, 200, 150]], [50, [150, 215, 90]],
    [60, [220, 230, 70]], [70, [250, 200, 50]], [80, [250, 140, 40]], [90, [230, 70, 40]],
    [100, [180, 20, 40]], [110, [110, 0, 40]],
  ];
  // Dew point: dry = tan/brown -> humid = green -> teal -> blue -> violet (tropical).
  const DEW_STOPS = [
    [-10, [110, 80, 40]], [10, [170, 130, 70]], [25, [205, 180, 120]], [35, [215, 215, 150]],
    [45, [160, 215, 140]], [55, [90, 195, 115]], [60, [40, 170, 110]], [65, [20, 150, 150]],
    [70, [20, 110, 185]], [75, [70, 60, 200]], [80, [120, 30, 170]],
  ];

  function makeScale(stops) {
    return function (v) {
      if (v <= stops[0][0]) return stops[0][1];
      const last = stops[stops.length - 1];
      if (v >= last[0]) return last[1];
      for (let i = 1; i < stops.length; i++) {
        if (v <= stops[i][0]) {
          const [v0, c0] = stops[i - 1], [v1, c1] = stops[i];
          const f = (v - v0) / (v1 - v0);
          return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
        }
      }
      return last[1];
    };
  }

  // Grid description: {lat0, lon0, dlat, dlon, nlat, nlon}. arr is row-major, rows south->north, tenths of F.
  function sampleGrid(grid, arr, lat, lon) {
    const fy = (lat - grid.lat0) / grid.dlat, fx = (lon - grid.lon0) / grid.dlon;
    if (!(fy >= 0 && fx >= 0 && fy <= grid.nlat - 1 && fx <= grid.nlon - 1)) return NaN;
    const j = Math.min(Math.floor(fy), grid.nlat - 2), i = Math.min(Math.floor(fx), grid.nlon - 2);
    const wy = fy - j, wx = fx - i, n = grid.nlon;
    const a = arr[j * n + i], b = arr[j * n + i + 1], c = arr[(j + 1) * n + i], d = arr[(j + 1) * n + i + 1];
    if (a === MISSING || b === MISSING || c === MISSING || d === MISSING) return NaN;
    return ((a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy) / 10;
  }

  // Web-Mercator pixel row/column -> geographic. Rows depend only on y and columns only on x,
  // so a tile needs just 256 latitudes and 256 longitudes.
  function tileAxes(x, y, z, size) {
    const world = size * Math.pow(2, z);
    const lons = new Float64Array(size), lats = new Float64Array(size);
    for (let p = 0; p < size; p++) {
      lons[p] = ((x * size + p + 0.5) / world) * 360 - 180;
      const n = Math.PI - (2 * Math.PI * (y * size + p + 0.5)) / world;
      lats[p] = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
    }
    return { lats, lons };
  }

  // Fill an RGBA buffer (size*size*4) for one map tile. Returns how many pixels were painted.
  function renderTile(buf, grid, arr, scale, x, y, z, size) {
    const { lats, lons } = tileAxes(x, y, z, size);
    let painted = 0;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const v = sampleGrid(grid, arr, lats[py], lons[px]);
        const o = (py * size + px) * 4;
        if (v !== v) { buf[o + 3] = 0; continue; }
        const c = scale(v);
        buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
        painted++;
      }
    }
    return painted;
  }

  function fmtValid(iso) {
    const d = new Date(iso);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}Z`;
  }

  function nearestHourIndex(hours, iso) {
    const t = new Date(iso).getTime();
    let best = 0, bestDiff = Infinity;
    hours.forEach((h, i) => {
      const diff = Math.abs(new Date(h.valid).getTime() - t);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    return { index: best, diffHours: bestDiff / 3.6e6 };
  }

  return { MISSING, TEMP_STOPS, DEW_STOPS, makeScale, sampleGrid, tileAxes, renderTile, fmtValid, nearestHourIndex };
});
