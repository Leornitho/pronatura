"use strict";

/* global grist, L, proj4 */

// ---- Grist column mapping names -------------------------------------------------
const EGRID = 'EGRID';
const Name = 'Name';
const Layer = 'Layer';
const GeoJSON = 'GeoJSON';
const Label = 'Label';

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

const CADASTRAL_LAYER = 'ch.kantone.cadastralwebmap-farbe';

// Returns a GeoJSON geometry (already reprojected to WGS84) for the given EGRID.
async function fetchParcelGeometry(egrid) {
  const searchUrl = `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=${encodeURIComponent(egrid)}&type=locations&origins=parcel&sr=2056&lang=fr&limit=1`;
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
    `?geometryType=esriGeometryPoint`,
    `&geometry=${centerX},${centerY}`,
    `&geometryFormat=geojson`,
    `&sr=2056`,
    `&imageDisplay=400,400,96`,
    `&layers=all:${CADASTRAL_LAYER}`,
    `&mapExtent=${mapExtent}`,
    `&tolerance=1`,
    `&returnGeometry=true`
  ].join('');

  const identRes = await fetch(identifyUrl);
  const identJson = await identRes.json();
  const results = identJson.results || [];
  // identify can return multiple overlapping features (e.g. neighbouring parcels
  // sharing the search point) — pick the one whose EGRID actually matches.
  const feature = results.find(f => f.properties?.egris_egrid === egrid) || results[0];
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
      egridRaw: mappings[EGRID] ? rec[mappings[EGRID]] : null,
      name: mappings[Name] ? rec[mappings[Name]] : null,
      layer: mappings[Layer] ? rec[mappings[Layer]] : null,
      geojson: mappings[GeoJSON] ? rec[mappings[GeoJSON]] : null,
      label: mappings[Label] ? rec[mappings[Label]] : null,
    };
  }
  // Fallback for widgets configured before column mapping existed.
  return {
    id: rec.id,
    egridRaw: rec[EGRID] ?? null,
    name: rec[Name] ?? null,
    layer: rec[Layer] ?? null,
    geojson: rec[GeoJSON] ?? null,
    label: rec[Label] ?? null,
  };
}

// The EGRID field can be mapped to a Text column (one EGRID, or several
// separated by commas/semicolons/newlines) or to a Ref/RefList column
// pointing at a parcels table that itself has an "EGRID" column. This is
// resolved once per data load and cached until the mapping changes.
let egridKindCache = null; // { key, kind: 'text' | 'ref', refTableId }

async function getEgridMappingKind() {
  const colId = lastMappings && lastMappings[EGRID];
  const key = `${selectedTableId}:${colId}`;
  if (egridKindCache?.key === key) { return egridKindCache; }
  if (!selectedTableId || !colId) {
    egridKindCache = { key, kind: 'text' };
    return egridKindCache;
  }
  try {
    const [tables, columns] = await Promise.all([
      grist.docApi.fetchTable('_grist_Tables'),
      grist.docApi.fetchTable('_grist_Tables_column'),
    ]);
    const tableRef = tables.id[tables.tableId.indexOf(selectedTableId)];
    const idx = columns.id.findIndex((_, i) => columns.parentId[i] === tableRef && columns.colId[i] === colId);
    const type = idx !== -1 ? (columns.type[idx] || 'Text') : 'Text';
    if (type.startsWith('Ref:') || type.startsWith('RefList:')) {
      const refTableId = type.startsWith('Ref:') ? type.slice(4) : type.slice(8);
      egridKindCache = { key, kind: 'ref', refTableId };
    } else {
      egridKindCache = { key, kind: 'text' };
    }
  } catch (e) {
    console.error('Impossible de déterminer le type de la colonne EGRID :', e);
    egridKindCache = { key, kind: 'text' };
  }
  return egridKindCache;
}

let refEgridMapCache = null; // { refTableId, map: {rowId: egrid} }

// Fetches the referenced parcels table and indexes it by row id -> EGRID
// value (the referenced table must have a column with colId "EGRID").
async function getRefTableEgridMap(refTableId, forceRefresh) {
  if (!forceRefresh && refEgridMapCache?.refTableId === refTableId) { return refEgridMapCache.map; }
  const table = await grist.docApi.fetchTable(refTableId);
  const map = {};
  if (table?.id && table[EGRID]) {
    for (let i = 0; i < table.id.length; i++) {
      map[table.id[i]] = table[EGRID][i];
    }
  } else {
    console.error(`La table référencée "${refTableId}" ne contient pas de colonne "EGRID".`);
  }
  refEgridMapCache = { refTableId, map };
  return map;
}

function parseEgridText(value) {
  if (value == null) { return []; }
  return String(value).split(/[\n,;]+/).map(v => v.trim()).filter(Boolean);
}

// Populates rec.egridList (array of EGRID strings) on every record, resolving
// either a delimited text value or Ref/RefList row ids against the parcels table.
async function resolveEgridLists(mapped, forceRefresh) {
  const kindInfo = await getEgridMappingKind();
  let refMap = null;
  if (kindInfo.kind === 'ref') {
    refMap = await getRefTableEgridMap(kindInfo.refTableId, forceRefresh);
  }
  for (const rec of mapped) {
    if (kindInfo.kind === 'ref') {
      const raw = rec.egridRaw;
      const rowIds = Array.isArray(raw) ? raw.slice(1) : (typeof raw === 'number' ? [raw] : []);
      rec.egridList = rowIds.map(id => refMap[id]).filter(Boolean);
    } else {
      rec.egridList = parseEgridText(rec.egridRaw);
    }
  }
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
      console.error(`GeoJSON invalide pour la ligne ${rec.id} (${(rec.egridList || []).join(', ')})`, e);
      continue;
    }
    if (!geometry) continue;

    const egridDisplay = (rec.egridList || []).join(', ');
    const groupName = rec.layer ? String(rec.layer) : 'Parcelles';
    if (!currentGroups[groupName]) {
      currentGroups[groupName] = L.featureGroup().addTo(map);
    }

    const featureLayer = L.geoJSON({
      type: 'Feature',
      properties: { EGRID: egridDisplay, Name: rec.name, Layer: rec.layer, Label: rec.label },
      geometry
    }, {
      style: { color: colorForLayer(groupName), weight: 2, fillOpacity: 0.25 }
    });
    if (rec.name) {
      featureLayer.bindPopup(String(rec.name));
    }

    if (rec.label) {
      // A centroid marker (rather than binding the tooltip on featureLayer directly)
      // keeps exactly one label per row even when its geometry is a GeometryCollection
      // combining several parcels — bindTooltip on a multi-sublayer group would repeat
      // the label once per sublayer.
      const labelMarker = L.marker(featureLayer.getBounds().getCenter(), {
        icon: L.divIcon({ className: '', iconSize: [0, 0] }),
        interactive: false,
      }).bindTooltip(String(rec.label), { permanent: true, direction: 'center', className: 'parcel-label' });
      currentGroups[groupName].addLayer(labelMarker);
    }

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
  await resolveEgridLists(mapped, forceRefresh);
  const toFetch = mapped.filter(r => r.egridList.length > 0 && !r.geojson);
  const errors = [];
  const updates = []; // {rowId, geojson}

  for (let i = 0; i < toFetch.length; i++) {
    const rec = toFetch[i];
    const geometries = [];
    for (let j = 0; j < rec.egridList.length; j++) {
      const egrid = rec.egridList[j];
      const progress = rec.egridList.length > 1 ? ` (parcelle ${j + 1}/${rec.egridList.length})` : '';
      setStatus(`Chargement des géométries... (${i + 1}/${toFetch.length})${progress}`, 'loading');
      try {
        geometries.push(await fetchParcelGeometry(String(egrid).trim()));
      } catch (err) {
        errors.push(`${egrid}: ${err.message}`);
        console.error(err);
      }
    }
    if (geometries.length > 0) {
      const combined = geometries.length === 1 ? geometries[0] : { type: 'GeometryCollection', geometries };
      rec.geojson = JSON.stringify(combined);
      updates.push({ rowId: rec.id, geojson: rec.geojson });
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
  if (!layer) return;
  if (layer.getBounds) {
    // Padding of a third of the viewport on each side leaves the geometry
    // occupying roughly the middle third of the map, with context around it.
    const size = map.getSize();
    map.fitBounds(layer.getBounds(), { padding: [size.x / 3, size.y / 3] });
  } else if (layer.getLatLng) {
    map.setView(layer.getLatLng(), 18);
  }
  layer.openPopup();
});

grist.onRecords((records, mappings) => {
  if (mappings) { lastMappings = mappings; }
  lastMapped = records.map(r => mapRecord(r, lastMappings));
  loadAndRender(false);
});

grist.ready({
  columns: [
    { name: EGRID, type: 'Any', title: 'EGRID', description: 'EGRID de la parcelle. Colonne texte (un EGRID, ou plusieurs séparés par des virgules), ou référence/liste de références vers une table de parcelles ayant elle-même une colonne "EGRID"' },
    { name: Name, type: 'Any', title: 'Nom', optional: true, description: 'Nom affiché dans la popup (ex: nom de la réserve ou n° de parcelle)' },
    { name: Layer, type: 'Any', title: 'Réserve', optional: true, description: 'Regroupe les parcelles par réserve/calque, activable/désactivable sur la carte' },
    { name: Label, type: 'Any', title: 'Étiquette', optional: true, description: 'Texte affiché en permanence sur la parcelle (ex: nom de la réserve)' },
    { name: GeoJSON, type: 'Text', title: 'GeoJSON (cache)', optional: true, description: 'Colonne de cache : la géométrie récupérée depuis le géoportail suisse y est enregistrée pour éviter de la re-télécharger à chaque ouverture' },
  ],
  requiredAccess: 'full',
  allowSelectBy: true,
});
