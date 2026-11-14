// Run: node tests/test_lib.js
const assert = require("assert");
const L = require("../site/lib.js");

const grid = { lat0: 30, lon0: -100, dlat: 1, dlon: 1, nlat: 3, nlon: 3 };
// rows south->north; value = 100*row + 10*col (tenths F) => value/10 = 10*row + col
const arr = [];
for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) arr.push(100 * r + 10 * c);

// exact node, midpoint, and out-of-range
assert.strictEqual(L.sampleGrid(grid, arr, 31, -99), 11);
assert.strictEqual(L.sampleGrid(grid, arr, 30.5, -99.5), 5.5);
assert.ok(Number.isNaN(L.sampleGrid(grid, arr, 29.9, -99)));
assert.ok(Number.isNaN(L.sampleGrid(grid, arr, 31, -97.9)));
// upper/right edge is still inside
assert.strictEqual(L.sampleGrid(grid, arr, 32, -98), 22);
// missing corner -> NaN, not a bogus value
const holey = arr.slice(); holey[4] = L.MISSING;
assert.ok(Number.isNaN(L.sampleGrid(grid, holey, 30.5, -99.5)));

// color scale: clamps and interpolates
const s = L.makeScale(L.TEMP_STOPS);
assert.deepStrictEqual(s(-100), L.TEMP_STOPS[0][1]);
assert.deepStrictEqual(s(500), L.TEMP_STOPS[L.TEMP_STOPS.length - 1][1]);
assert.deepStrictEqual(s(32), [150, 225, 235]);
const mid = s(75); // halfway between 70 and 80 stops
assert.deepStrictEqual(mid.map(Math.round), [250, 170, 45]);

// Mercator tile axes: zoom 0 single tile spans the world; center row is the equator, center col lon 0
const ax = L.tileAxes(0, 0, 0, 256);
assert.ok(Math.abs(ax.lons[127] - (-0.703125 + 0.703125 / 2 * 0)) < 1.5);
assert.ok(Math.abs(ax.lats[127]) < 1 && ax.lats[0] > 84 && ax.lats[255] < -84);
// known tile: z=4, x=3, y=6 contains roughly (lat 36, lon -97)? compute inverse and check containment
const z = 4, n = Math.pow(2, z);
const lon = -77.0, lat = 39.0;
const tx = Math.floor(((lon + 180) / 360) * n);
const ty = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
const t = L.tileAxes(tx, ty, z, 256);
assert.ok(lon >= t.lons[0] - 0.2 && lon <= t.lons[255] + 0.2, "lon within tile");
assert.ok(lat <= t.lats[0] + 0.2 && lat >= t.lats[255] - 0.2, "lat within tile");

// renderTile paints inside the grid and leaves outside transparent
const big = { lat0: 24, lon0: -125, dlat: 0.25, dlon: 0.25, nlat: 107, nlon: 237 };
const field = new Array(107 * 237).fill(700);
const buf = new Uint8ClampedArray(256 * 256 * 4);
const paintedIn = L.renderTile(buf, big, field, s, tx, ty, z, 256);
assert.ok(paintedIn > 0, "tile over Maryland should paint");
const buf2 = new Uint8ClampedArray(256 * 256 * 4);
const paintedOut = L.renderTile(buf2, big, field, s, 0, 0, 4, 256); // far NW Pacific/Arctic
assert.strictEqual(paintedOut, 0);

// nearest hour
const hrs = [{ valid: "2026-11-07T00:00:00Z" }, { valid: "2026-11-07T06:00:00Z" }, { valid: "2026-11-07T12:00:00Z" }];
const nh = L.nearestHourIndex(hrs, "2026-11-07T05:00:00Z");
assert.strictEqual(nh.index, 1);
assert.strictEqual(nh.diffHours, 1);
assert.strictEqual(L.fmtValid("2026-11-07T06:00:00Z"), "Sat Nov 7 06Z");

console.log("all lib tests passed");
