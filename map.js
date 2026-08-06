"use strict";

/* global grist, L, proj4 */

// ---- Grist column mapping names -------------------------------------------------
const EGRID = 'EGRID';
const Name = 'Name';
const Layer = 'Layer';
const GeoJSON = 'GeoJSON';

// ---- Swiss coordinate system (CH1903+ / LV95) ------------------------------------
proj4.defs('EPSG:2056', '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs');

// ---- Map setup --------------------------------------------------------------------
const map = L.map('map').setView([46.8, 8.2], 9);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19
}).addTo(map);

const LAYER_COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'];
function colorForLayer(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) { hash = (hash * 31 + name.charCodeAt(i)) >>> 0; }
  return LAYER_COLORS[hash % LAYER_COLORS.length];
}

const statusEl = document.getElementById('status');
const refreshButton = document.getElementById('refresh');

function setStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = type === 'error' ? 'error' : type === 'loading' ? 'loading' : '';
}

// ---- Swiss geoportal lookup (geo.admin.ch) -----------------------------------------
function parseBox2d(box2d) {
  const match = box2d.match(/BOX\(([-0-9\.]+) ([-0-9\.]+),([-0-9\.]+) ([-0-9\.]+)\)/);
  if (!match) return null;
  return {
    minX: parseFloat(match[1]),
    minY: parseFloat(match[2]),
    maxX: parseFloat(match[3]),
    maxY: parseFloat(match[4])
  };
}

function toLatLng(coord) {
  const [x, y] = coord;
  const [lon, lat] = proj4('EPSG:2056', 'EPSG:4326', [x, y]);
  return [lon, lat];
}

function convertGeometryToGeoJSON(geometry) {
  if (!geometry || !geometry.coordinates) return null;

  const convertCoords = coords => {
    if (typeof coords[0] === 'number') {
      return toLatLng(coords);
    }
    return coords.map(convertCoords);
  };

  return {
    type: geometry.type,
    coordinates: convertCoords(geometry.coordinates)
  };
}

// Returns a GeoJSON geometry (already reprojected to WGS84) for the given EGRID.
async function fetchParcelGeometry(egrid) {
  const searchUrl = `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(egrid)}&origins=ch.kantone.cadastralparcel&sr=2056&lang=fr&limit=1`;
  const searchRes = await fetch(searchUrl);
  const searchJson = await searchRes.json();
  const result = searchJson.results?.[0];
  if (!result) {
    throw new Error(`Aucune parcelle trouvée pour EGRID ${egrid}`);
  }

  const box2d = result.attrs?.geom_st_box2d;
  const bbox = parseBox2d(box2d);
  if (!bbox) {
    throw new Error(`Impossible de parser geom_st_box2d pour ${egrid}`);
  }

  const centerX = (bbox.minX + bbox.maxX) / 2;
  const centerY = (bbox.minY + bbox.maxY) / 2;
  const mapExtent = `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`;

  const identifyUrl = [
    `https://api3.geo.admin.ch/rest/services/ech/MapServer/identify`,
    `?geometry=${centerX},${centerY}`,
    `&geometryFormat=geojson`,
    `&sr=2056`,
    `&imageDisplay=400,400,96`,
    `&layers=all:ch.kantone.cadastralparcel`,
    `&mapExtent=${mapExtent}`,
    `&tolerance=1`,
    `&returnGeometry=true`
  ].join('');

  const identRes = await fetch(identifyUrl);
  const identJson = await identRes.json();
  const feature = identJson.results?.[0];
  if (!feature?.geometry) {
    throw new Error(`Aucune géométrie trouvée pour ${egrid}`);
  }

  return convertGeometryToGeoJSON(feature.geometry);
}

// ---- Grist wiring -------------------------------------------------------------------
let selectedTableId = null;
let currentGroups = {}; // layerName -> L.featureGroup
let recordLayers = {};  // rowId -> L.Layer (for click-to-select)
let layersControl = null;
let lastMapped = null;  // last mapped records, so the refresh button can re-run
let lastMappings = null;
let loading = false;
let pendingRerun = false;
let pendingForce = false;

grist.on('message', (e) => {
  if (e.tableId) { selectedTableId = e.tableId; }
});

function mapRecord(rec, mappings) {
  if (mappings) {
    return {
      id: rec.id,
      egrid: mappings[EGRID] ? rec[mappings[EGRID]] : null,
      name: mappings[Name] ? rec[mappings[Name]] : null,
      layer: mappings[Layer] ? rec[mappings[Layer]] : null,
      geojson: mappings[GeoJSON] ? rec[mappings[GeoJSON]] : null,
    };
  }
  // Fallback for widgets configured before column mapping existed.
  return {
    id: rec.id,
    egrid: rec[EGRID] ?? null,
    name: rec[Name] ?? null,
    layer: rec[Layer] ?? null,
    geojson: rec[GeoJSON] ?? null,
  };
}

function clearMap() {
  for (const name in currentGroups) { map.removeLayer(currentGroups[name]); }
  currentGroups = {};
  recordLayers = {};
  if (layersControl) {
    map.removeControl(layersControl);
    layersControl = null;
  }
}

function renderMap(mapped) {
  clearMap();

  const bounds = L.latLngBounds([]);
  let shown = 0;

  for (const rec of mapped) {
    if (!rec.geojson) continue;
    let geometry;
    try {
      geometry = typeof rec.geojson === 'string' ? JSON.parse(rec.geojson) : rec.geojson;
    } catch (e) {
      console.error(`GeoJSON invalide pour la ligne ${rec.id} (${rec.egrid})`, e);
      continue;
    }
    if (!geometry) continue;

    const groupName = rec.layer ? String(rec.layer) : 'Parcelles';
    if (!currentGroups[groupName]) {
      currentGroups[groupName] = L.featureGroup().addTo(map);
    }

    const label = rec.name ? `${rec.name} (${rec.egrid})` : rec.egrid;
    const featureLayer = L.geoJSON({
      type: 'Feature',
      properties: { EGRID: rec.egrid, Name: rec.name, Layer: rec.layer },
      geometry
    }, {
      style: { color: colorForLayer(groupName), weight: 2, fillOpacity: 0.25 }
    }).bindPopup(label);

    currentGroups[groupName].addLayer(featureLayer);
    recordLayers[rec.id] = featureLayer;
    bounds.extend(featureLayer.getBounds());
    shown++;
  }

  const groupNames = Object.keys(currentGroups);
  if (groupNames.length > 1) {
    layersControl = L.control.layers(null, currentGroups, { collapsed: true }).addTo(map);
  }

  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [20, 20] });
  }

  return shown;
}

// Fetch geometry for records missing a cached GeoJSON value, cache it back to Grist
// (when the GeoJSON column is mapped and the widget has write access), then render.
async function loadAndRender(forceRefresh) {
  if (!lastMapped) return;
  if (loading) {
    pendingRerun = true;
    pendingForce = pendingForce || forceRefresh;
    return;
  }
  loading = true;
  refreshButton.disabled = true;

  const mapped = lastMapped.map(r => forceRefresh ? { ...r, geojson: null } : r);
  const toFetch = mapped.filter(r => r.egrid && !r.geojson);
  const errors = [];
  const updates = []; // {rowId, geojson}

  for (let i = 0; i < toFetch.length; i++) {
    const rec = toFetch[i];
    setStatus(`Chargement des géométries... (${i + 1}/${toFetch.length})`, 'loading');
    try {
      const geometry = await fetchParcelGeometry(String(rec.egrid).trim());
      rec.geojson = JSON.stringify(geometry);
      updates.push({ rowId: rec.id, geojson: rec.geojson });
    } catch (err) {
      errors.push(`${rec.egrid}: ${err.message}`);
      console.error(err);
    }
  }

  if (updates.length > 0 && selectedTableId && lastMappings && lastMappings[GeoJSON]) {
    try {
      await grist.docApi.applyUserActions([[
        'BulkUpdateRecord',
        selectedTableId,
        updates.map(u => u.rowId),
        { [lastMappings[GeoJSON]]: updates.map(u => u.geojson) }
      ]]);
    } catch (err) {
      console.error('Impossible de mettre en cache les géométries dans Grist (accès en écriture requis) :', err);
    }
  }

  const shown = renderMap(mapped);

  if (errors.length > 0) {
    setStatus(`${shown} parcelle(s) affichée(s). ${errors.length} erreur(s) : ${errors.join(' ; ')}`, 'error');
  } else if (shown === 0) {
    setStatus('Aucune parcelle à afficher. Vérifiez la colonne EGRID.', 'error');
  } else {
    setStatus(`${shown} parcelle(s) affichée(s).`, 'info');
  }

  loading = false;
  refreshButton.disabled = false;

  if (pendingRerun) {
    pendingRerun = false;
    const rerunForce = pendingForce;
    pendingForce = false;
    loadAndRender(rerunForce);
  }
}

refreshButton.addEventListener('click', () => loadAndRender(true));

grist.onRecord((record, mappings) => {
  const effectiveMappings = mappings || lastMappings;
  const rec = mapRecord(record, effectiveMappings);
  const layer = recordLayers[rec.id];
  if (layer) {
    map.panTo(layer.getBounds ? layer.getBounds().getCenter() : layer.getLatLng());
    layer.openPopup();
  }
});

grist.onRecords((records, mappings) => {
  if (mappings) { lastMappings = mappings; }
  lastMapped = records.map(r => mapRecord(r, lastMappings));
  loadAndRender(false);
});

grist.ready({
  columns: [
    { name: EGRID, type: 'Text', title: 'EGRID', description: 'Identifiant fédéral de la parcelle (ex: CH772637125650)' },
    { name: Name, type: 'Any', title: 'Nom', optional: true, description: 'Nom affiché dans la popup (ex: nom de la réserve ou n° de parcelle)' },
    { name: Layer, type: 'Any', title: 'Réserve', optional: true, description: 'Regroupe les parcelles par réserve/calque, activable/désactivable sur la carte' },
    { name: GeoJSON, type: 'Text', title: 'GeoJSON (cache)', optional: true, description: 'Colonne de cache : la géométrie récupérée depuis le géoportail suisse y est enregistrée pour éviter de la re-télécharger à chaque ouverture' },
  ],
  requiredAccess: 'full',
  allowSelectBy: true,
});
