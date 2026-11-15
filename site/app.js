(function () {
  "use strict";
  const W = window.WxLib;
  const $ = (id) => document.getElementById(id);

  const map = L.map("map", { minZoom: 3, maxZoom: 12, zoomControl: false, worldCopyJump: false, zoomSnap: 0.25 });
  L.control.zoom({ position: "topright" }).addTo(map);   // top-right so it is not hidden behind the control panel
  // Leave room for the control panel on wide screens so the CONUS isn't hidden under it.
  const wide = window.innerWidth > 760;
  map.fitBounds([[24, -125], [50.5, -66]], { paddingTopLeft: [wide ? 310 : 10, 50], paddingBottomRight: [10, 10] });

  map.createPane("radar"); map.getPane("radar").style.zIndex = 410; map.getPane("radar").style.pointerEvents = "none";
  map.createPane("radarsites"); map.getPane("radarsites").style.zIndex = 440;
  map.createPane("borders"); map.getPane("borders").style.zIndex = 420; map.getPane("borders").style.pointerEvents = "none";
  map.createPane("fronts"); map.getPane("fronts").style.zIndex = 430;
  map.createPane("labels"); map.getPane("labels").style.zIndex = 450; map.getPane("labels").classList.add("leaflet-labels-pane");

  // Plain white background (no basemap tiles) so the model colours are not tinted by map colours.
  // Geography comes from the bundled state outlines below.
  document.getElementById("map").style.background = "#ffffff";

  // Background map. The CARTO key lives in config.js. With no key, Esri's light-gray map is used instead.
  // NOTE: a key in a public web page is visible to anyone, so restrict it to your site's domain in CARTO's dashboard.
  const CARTO_KEY = window.CARTO_KEY || "";
  const base = CARTO_KEY ? "https://basemaps.cartocdn.com/rastertiles/" : null;
  const kq = "?key=" + encodeURIComponent(CARTO_KEY);
  const CARTO_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
  const streetLayers = base ? [
    L.tileLayer(base + "light_nolabels/{z}/{x}/{y}{r}.png" + kq, { attribution: CARTO_ATTR, maxZoom: 19, zIndex: 1 }),
  ] : [
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles &copy; Esri", maxNativeZoom: 16, maxZoom: 19, zIndex: 1 }),
  ];
  function setStreet(on) { streetLayers.forEach((l) => (on ? l.addTo(map) : map.removeLayer(l))); }
  document.getElementById("chk-street").addEventListener("change", (e) => setStreet(e.target.checked));
  setStreet(document.getElementById("chk-street").checked);

  // State outlines are bundled with the page (site/states.json), so geography is always visible,
  // drawn above the colour fill, whether or not any tile server works.
  fetch("states.json").then((r) => r.json()).then((gj) => {
    L.geoJSON(gj, { pane: "borders", interactive: false, style: { color: "#1b2530", weight: 1, opacity: 0.65 } }).addTo(map);
  }).catch(() => {});

  // ------------------------------------------------------------ cities (name + model value)
  const cityLayer = L.layerGroup().addTo(map);
  const MIN_ZOOM = { 1: 3, 2: 5, 3: 6 };           // big cities at the national view, more as you zoom in
  let cities = [];
  fetch("cities.json").then((r) => r.json()).then((c) => { cities = c; refreshCities(); }).catch(() => {});
  function refreshCities() {
    cityLayer.clearLayers();
    const z = map.getZoom();
    const key = map.hasLayer(layers.temp) ? "t" : map.hasLayer(layers.dew) ? "td" : null;
    cities.forEach((c) => {
      if (z < MIN_ZOOM[c.t]) return;
      let txt = c.n;
      if (key && state.cur && state.grid) {
        const v = W.sampleGrid(state.grid, state.cur[key], c.lat, c.lon);
        if (v === v) txt += ` ${Math.round(v)}&deg;`;
      }
      L.marker([c.lat, c.lon], {
        pane: "labels", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "city", iconSize: [0, 0], html: `<span class="cdot"></span><span class="ctxt">${txt}</span>` }),
      }).addTo(cityLayer);
    });
  }
  map.on("zoomend", refreshCities);

  const state = { manifest: null, grid: null, cache: {}, cur: null, hourIdx: 0, frontsValid: null };

  // ------------------------------------------------------------ model layers
  const ModelLayer = L.GridLayer.extend({
    initialize: function (key, scale, options) {
      L.GridLayer.prototype.initialize.call(this, options);
      this._key = key; this._scale = scale;
    },
    createTile: function (coords) {
      const size = this.getTileSize().x;
      const tile = L.DomUtil.create("canvas", "leaflet-tile");
      tile.width = size; tile.height = size;
      if (!state.cur || !state.grid) return tile;
      const ctx = tile.getContext("2d");
      const img = ctx.createImageData(size, size);
      W.renderTile(img.data, state.grid, state.cur[this._key], this._scale, coords.x, coords.y, coords.z, size);
      ctx.putImageData(img, 0, 0);
      return tile;
    },
  });
  const layers = {
    temp: new ModelLayer("t", W.makeScale(W.TEMP_STOPS), { opacity: 0.55, zIndex: 300, updateWhenZooming: false }),
    dew: new ModelLayer("td", W.makeScale(W.DEW_STOPS), { opacity: 0.55, zIndex: 301, updateWhenZooming: false }),
    fronts: L.layerGroup(),
    // Live NOAA radar: CONUS base reflectivity from NOAA/NCEP's public WMS (same source as the NOAA-radar-display app).
    radar: L.tileLayer.wms("https://opengeo.ncep.noaa.gov/geoserver/conus/ows", {
      layers: "conus:conus_bref_qcd", format: "image/png", transparent: true, version: "1.1.1",
      pane: "radar", opacity: 0.8, maxZoom: 12, attribution: "Radar: NOAA/NWS", updateWhenZooming: false,
    }),
  };

  // Radar is live observations, not forecast: it ignores the model-hour slider and refreshes itself.
  const RADAR_REFRESH_MS = 2 * 60 * 1000;
  let radarTimer = null, radarErrors = 0;
  function radarStamp() { const d = new Date(); $("radar-sub").textContent = `${site ? "Single-site radar" : "Live NOAA base reflectivity mosaic"} \u00b7 refreshed ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`; }
  function refreshRadar() {
    radarErrors = 0;
    layers.radar.setParams({ _: Date.now() });   // new query string forces fresh images
    if (siteWms) siteWms.setParams({ _: Date.now() });
    radarStamp();
  }
  layers.radar.on("tileerror", () => {
    if (++radarErrors === 3) $("radar-sub").innerHTML = '<span class="stale">Radar service not responding (will retry)</span>';
  });
  layers.radar.on("tileload", () => { radarErrors = 0; });
  // ---- individual radar sites (NEXRAD): click a dot to view that site's own radar
  const siteLayer = L.layerGroup();
  let sites = null, site = null, siteProduct = "sr_bref", siteWms = null;
  const PRODUCTS = { sr_bref: "Reflectivity", sr_bvel: "Velocity" };

  function clearSite() {
    if (siteWms) { map.removeLayer(siteWms); siteWms = null; }
    site = null;
    if ($("chk-radar").checked) layers.radar.addTo(map);
    $("radar-site").style.display = "none";
    radarStamp();
  }
  function showSite(st, product) {
    siteProduct = product || siteProduct; site = st;
    if (siteWms) map.removeLayer(siteWms);
    map.removeLayer(layers.radar);                     // site view replaces the national mosaic
    const id = st.id.toLowerCase();
    siteWms = L.tileLayer.wms(`https://opengeo.ncep.noaa.gov/geoserver/${id}/ows`, {
      layers: `${id}_${siteProduct}`, format: "image/png", transparent: true, version: "1.1.1",
      pane: "radar", opacity: $("radar-opacity").value / 100, maxZoom: 12, attribution: "Radar: NOAA/NWS", updateWhenZooming: false,
    });
    siteWms.on("tileerror", () => {
      if (++radarErrors === 3) $("radar-site-msg").innerHTML = '<span class="stale">No data from this site right now</span>';
    });
    siteWms.on("tileload", () => { radarErrors = 0; });
    radarErrors = 0; siteWms.addTo(map);
    $("radar-site").style.display = "block";
    $("radar-site-msg").textContent = `${st.id} \u00b7 ${st.n}, ${st.st}`;
    $("radar-product").value = siteProduct;
    map.closePopup();
    radarStamp();
  }
  function sitePopup(st) {
    const div = document.createElement("div");
    div.innerHTML = `<b>${st.id}</b> ${st.n}, ${st.st}<br><span class="sub" style="margin:0">${st.lat.toFixed(2)}, ${st.lon.toFixed(2)}</span><div style="margin-top:6px;display:flex;gap:6px"></div>`;
    const row = div.lastChild;
    Object.entries(PRODUCTS).forEach(([k, label]) => {
      const b = document.createElement("button"); b.textContent = label; b.addEventListener("click", () => showSite(st, k)); row.appendChild(b);
    });
    return div;
  }
  function buildSites() {
    siteLayer.clearLayers();
    sites.forEach((st) => {
      L.circleMarker([st.lat, st.lon], { pane: "radarsites", radius: 5, color: "#fff", weight: 1.5, fillColor: "#1f6fe5", fillOpacity: 0.95 })
        .bindTooltip(`${st.id} ${st.n}`).bindPopup(() => sitePopup(st)).addTo(siteLayer);
    });
  }
  async function loadSites() {
    if (sites) return;
    try { sites = await getJSON("radar-stations.json"); buildSites(); }
    catch (e) { $("radar-sub").innerHTML = '<span class="stale">Radar site list unavailable</span>'; }
  }
  $("radar-product").addEventListener("change", (e) => site && showSite(site, e.target.value));
  $("radar-national").addEventListener("click", clearSite);

  function setRadar(on) {
    if (on) {
      if (!site) layers.radar.addTo(map);
      siteLayer.addTo(map); loadSites(); radarStamp();
      clearInterval(radarTimer); radarTimer = setInterval(refreshRadar, RADAR_REFRESH_MS);
    } else {
      map.removeLayer(layers.radar); if (siteWms) map.removeLayer(siteWms); map.removeLayer(siteLayer); map.closePopup();
      $("radar-site").style.display = "none"; site = null; siteWms = null;
      clearInterval(radarTimer); radarTimer = null;
    }
  }
  $("chk-radar").addEventListener("change", (e) => setRadar(e.target.checked));
  $("radar-opacity").addEventListener("input", (e) => { layers.radar.setOpacity(e.target.value / 100); if (siteWms) siteWms.setOpacity(e.target.value / 100); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && radarTimer) refreshRadar(); });

  function legend(el, stops, lo, hi, step) {
    const scale = W.makeScale(stops);
    const css = [];
    for (let v = lo; v <= hi; v += (hi - lo) / 40) { const c = scale(v).map(Math.round); css.push(`rgb(${c})`); }
    const ticks = [];
    for (let v = lo; v <= hi; v += step) ticks.push(`<span>${v}&deg;</span>`);
    el.innerHTML = `<div class="bar" style="background:linear-gradient(90deg,${css.join(",")})"></div><div class="ticks">${ticks.join("")}</div>`;
  }
  legend($("leg-temp"), W.TEMP_STOPS, -10, 110, 20);
  legend($("leg-dew"), W.DEW_STOPS, 0, 80, 20);

  // ------------------------------------------------------------ fronts
  const FRONT_STYLE = {
    COLD: [{ color: "#1f5fd6", weight: 3.5 }],
    WARM: [{ color: "#d6261f", weight: 3.5 }],
    OCFNT: [{ color: "#8a2be2", weight: 3.5 }],
    STNRY: [{ color: "#1f5fd6", weight: 3.5, dashArray: "12 12" }, { color: "#d6261f", weight: 3.5, dashArray: "12 12", dashOffset: "12" }],
    TROF: [{ color: "#b5651d", weight: 3, dashArray: "2 8", lineCap: "round" }],
  };
  const NAMES = { COLD: "Cold front", WARM: "Warm front", OCFNT: "Occluded front", STNRY: "Stationary front", TROF: "Trough / boundary" };

  function drawFronts(gj) {
    layers.fronts.clearLayers();
    gj.features.forEach((f) => {
      const p = f.properties;
      if (p.kind === "front") {
        const ll = f.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
        (FRONT_STYLE[p.type] || FRONT_STYLE.TROF).forEach((st) =>
          L.polyline(ll, Object.assign({ pane: "fronts", opacity: 0.95, interactive: p.type === "TROF" ? false : true }, st))
            .bindTooltip(NAMES[p.type] || p.type, { sticky: true }).addTo(layers.fronts));
      } else {
        const hi = p.kind === "high";
        const [lon, lat] = f.geometry.coordinates;
        L.marker([lat, lon], {
          pane: "fronts", keyboard: false,
          icon: L.divIcon({
            className: "", iconSize: [40, 40],
            html: `<div class="pc" style="color:${hi ? "#1f5fd6" : "#d6261f"};font-size:26px">${hi ? "H" : "L"}<small>${p.pressure_mb}</small></div>`,
          }),
        }).bindTooltip(`${hi ? "High" : "Low"} ${p.pressure_mb} mb`).addTo(layers.fronts);
      }
    });
  }

  // ------------------------------------------------------------ time + data
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async function loadHour(i) {
    const h = state.manifest.hours[i];
    if (!state.cache[h.file]) state.cache[h.file] = await getJSON(`data/${h.file}`);
    return state.cache[h.file];
  }

  async function showHour(i) {
    state.hourIdx = i;
    const h = state.manifest.hours[i];
    $("when").textContent = W.fmtValid(h.valid);
    $("lead").textContent = `+${h.lead} h`;
    try {
      state.cur = await loadHour(i);
    } catch (e) { $("status").innerHTML = `<span class="stale">Could not load model data: ${e.message}</span>`; return; }
    if (state.hourIdx !== i) return;               // slider moved again while loading
    ["temp", "dew"].forEach((k) => map.hasLayer(layers[k]) && layers[k].redraw());
    refreshCities();
  }

  function setLayer(key, on) { on ? layers[key].addTo(map) : map.removeLayer(layers[key]); if (key !== "fronts") refreshCities(); }
  // Temperature and dew point are mutually exclusive (both would paint over each other); either can be off.
  const OTHER = { "chk-temp": ["chk-dew", "dew"], "chk-dew": ["chk-temp", "temp"] };
  [["chk-temp", "temp"], ["chk-dew", "dew"], ["chk-fronts", "fronts"]].forEach(([id, key]) => {
    const el = $(id);
    el.addEventListener("change", () => {
      if (el.checked && OTHER[id]) { $(OTHER[id][0]).checked = false; setLayer(OTHER[id][1], false); }
      setLayer(key, el.checked);
    });
  });
  $("opacity").addEventListener("input", (e) => { const o = e.target.value / 100; layers.temp.setOpacity(o); layers.dew.setOpacity(o); });

  let sliderTimer;
  $("hour").addEventListener("input", (e) => {
    const i = +e.target.value; const h = state.manifest.hours[i];
    $("when").textContent = W.fmtValid(h.valid); $("lead").textContent = `+${h.lead} h`;
    clearTimeout(sliderTimer); sliderTimer = setTimeout(() => showHour(i), 80);
  });
  $("match").addEventListener("click", () => {
    if (!state.frontsValid) return;
    const { index } = W.nearestHourIndex(state.manifest.hours, state.frontsValid);
    $("hour").value = index; showHour(index);
  });

  map.on("mousemove", (e) => {
    if (!state.cur || !state.grid) return;
    const t = W.sampleGrid(state.grid, state.cur.t, e.latlng.lat, e.latlng.lng);
    const td = W.sampleGrid(state.grid, state.cur.td, e.latlng.lat, e.latlng.lng);
    const f = (v) => (v !== v ? "&ndash;" : Math.round(v) + "&deg;F");
    $("readout").innerHTML = `T ${f(t)} &nbsp; Td ${f(td)}<br><span class="sub" style="margin:0">${e.latlng.lat.toFixed(2)}, ${e.latlng.lng.toFixed(2)}</span>`;
  });

  // Shareable state: index.html#layers=temp,fronts&h=3  (layers: temp, dew, fronts, radar; "none" = all off; h = hour index)
  function applyHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has("layers")) {
      const on = p.get("layers").split(",");
      $("chk-temp").checked = on.includes("temp");
      $("chk-dew").checked = on.includes("dew");
      $("chk-fronts").checked = on.includes("fronts");
      $("chk-radar").checked = on.includes("radar");
      if ($("chk-temp").checked) $("chk-dew").checked = false;
    }
    return p.has("h") ? Math.max(0, parseInt(p.get("h"), 10) || 0) : 0;
  }
  function writeHash() {
    const on = [["temp", "chk-temp"], ["dew", "chk-dew"], ["fronts", "chk-fronts"], ["radar", "chk-radar"]].filter(([, id]) => $(id).checked).map(([k]) => k);
    history.replaceState(null, "", `#layers=${on.join(",") || "none"}&h=${state.hourIdx}`);
  }
  ["chk-temp", "chk-dew", "chk-fronts", "chk-radar", "hour"].forEach((id) => $(id).addEventListener("change", writeHash));

  // ------------------------------------------------------------ boot
  async function boot() {
    const notes = [];
    const startHour = applyHash();
    try {
      const m = await getJSON("data/manifest.json");
      state.manifest = m; state.grid = m.grid;
      if (m.synthetic) { $("banner").style.display = "block"; document.body.classList.add("has-banner"); }
      const slider = $("hour"); slider.max = m.hours.length - 1;
      notes.push(`Model: ${m.model}<br>Run: ${W.fmtValid(m.init)} &middot; built ${W.fmtValid(m.generated)}`);
      const ageH = (Date.now() - new Date(m.generated).getTime()) / 3.6e6;
      if (!m.synthetic && ageH > 12) notes.push(`<span class="stale">Model data is ${Math.round(ageH)} h old</span>`);
      const hi = Math.min(startHour, m.hours.length - 1);
      slider.value = hi;
      await showHour(hi);
    } catch (e) {
      // No model data published (the site runs on public NOAA/NWS data only): hide the model controls.
      [$("chk-temp"), $("chk-dew")].forEach((c) => { c.checked = false; c.closest(".layer").style.display = "none"; });
      [$("when").parentElement, $("hour"), $("match"), $("opacity").parentElement].forEach((el) => { el.style.display = "none"; });
      if (!new URLSearchParams(location.hash.slice(1)).has("layers")) $("chk-radar").checked = true;
      $("foot-src").textContent = "Sources: NOAA/NWS Weather Prediction Center \u00b7 NOAA/NWS radar";
    }
    if (state.manifest) { setLayer("temp", $("chk-temp").checked); setLayer("dew", $("chk-dew").checked); }

    try {
      const gj = await getJSON("data/fronts.json");
      state.frontsValid = gj.properties.valid;
      drawFronts(gj);
      $("fronts-time").textContent = `Fronts: ${W.fmtValid(gj.properties.valid)}`;
      $("fronts-sub").textContent = "NWS Weather Prediction Center analysis (3-hourly)";
      const ageH = (Date.now() - new Date(gj.properties.valid).getTime()) / 3.6e6;
      if (ageH > 9) notes.push(`<span class="stale">Front analysis is ${Math.round(ageH)} h old</span>`);
      if (state.manifest) {
        const { diffHours } = W.nearestHourIndex(state.manifest.hours, gj.properties.valid);
        if (diffHours > 3) notes.push(`Fronts are an analysis at ${W.fmtValid(gj.properties.valid)}; the model hour closest to that is ${Math.round(diffHours)} h away.`);
      }
    } catch (e) {
      $("chk-fronts").checked = false; $("chk-fronts").disabled = true; $("match").disabled = true;
      $("fronts-sub").innerHTML = `<span class="stale">Fronts unavailable</span>`;
      notes.push(`<span class="stale">Fronts layer unavailable: ${e.message}</span>`);
    }
    if ($("chk-fronts").checked) layers.fronts.addTo(map);
    setRadar($("chk-radar").checked);

    if (state.manifest) {
      notes.push("Fronts are the NWS analysis, not model output. Model fields are a 64-member ensemble mean, so they are smoother than any single forecast.");
      notes.push("Radar is live NOAA observations and does not follow the forecast-hour slider. Data: Google DeepMind WeatherNext 3; NOAA/NWS Weather Prediction Center; NOAA/NWS radar.");
    } else {
      notes.push("Fronts are the NWS Weather Prediction Center analysis. Radar is live NOAA observations. Experimental, for general interest only; not for safety decisions. Use weather.gov for official forecasts and warnings.");
    }
    $("status").innerHTML = notes.join("<br>");
  }
  boot();
})();
