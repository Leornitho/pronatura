"use strict";

/* global grist, L, proj4 */

// ---- Grist column mapping names -------------------------------------------------
const EGRID = 'EGRID';
const Name = 'Name';
const Layer = 'Layer';
const GeoJSON = 'GeoJSON';
const Area = 'Area';
const Label = 'Label';
const ManualGeoJSON = 'ManualGeoJSON';
const ManualArea = 'ManualArea';

// Table des parcelles : la géométrie de chaque parcelle téléchargée pour une réserve y est aussi enregistrée
// (utilisée par le PDF du plan de gestion pour dessiner les parcelles et leurs numéros).
const PARCELS_TABLE = 'Parcels', PARCEL_EGRID = 'EGRID', PARCEL_GEOJSON = 'parcel_GeoJSON', PARCEL_AREA = 'area_from_GeoJSON';

// Mesure du temps de chargement, affichée dans la barre du haut (mettre false pour la masquer).
const SHOW_TIMING = true;
const T = { code: performance.now() };
const sec = ms => (ms / 1000).toLocaleString('fr-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s';
function timingText() {
  if (!SHOW_TIMING || !T.render) return '';
  const libs = Math.max(0, ...performance.getEntriesByType('resource')
    .filter(r => /\.js(\?|$)/.test(r.name) && /leaflet|proj4|grist-plugin-api/.test(r.name)).map(r => r.responseEnd));
  const parts = [`bibliothèques ${sec(libs)}`, `code ${sec(T.code)}`, `données ${sec(T.data)}`];
  if (T.fetch) parts.push(`géoportail ${sec(T.fetch)}`);
  parts.push(`carte ${sec(T.render)}`);
  if (T.nat) parts.push(`couches nature ${sec(T.nat)}`);
  return ` — ⏱ ${parts.join(' → ')}`;
}

// ---- Swiss coordinate system (CH1903+ / LV95) ------------------------------------
proj4.defs('EPSG:2056', '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs');

// ---- Map setup --------------------------------------------------------------------
// Emprise du canton de Fribourg (vue par défaut tant qu'aucune réserve n'est sélectionnée)
const FR_BOUNDS = L.latLngBounds([46.43, 6.74], [47.02, 7.39]);
const map = L.map('map').fitBounds(FR_BOUNDS);

// Fonds swisstopo uniquement : les tuiles OpenStreetMap refusent les cartes intégrées
// dans Grist (pas d'en-tête « Referer » depuis le widget → « tile usage policy »).
const swisstopoGreyLayer = L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg', {
  attribution: '&copy; swisstopo',
  maxZoom: 19,
  maxNativeZoom: 18
});

const swissimageLayer = L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg', {
  attribution: '&copy; swisstopo SWISSIMAGE',
  maxZoom: 20,
  maxNativeZoom: 20
});

const swisstopoColorLayer = L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg', {
  attribution: '&copy; swisstopo',
  maxZoom: 19,
  maxNativeZoom: 18
}).addTo(map);

L.control.layers({
  'Carte nationale swisstopo (couleur)': swisstopoColorLayer,
  'Carte nationale swisstopo (gris)': swisstopoGreyLayer,
  'Orthophoto SWISSIMAGE': swissimageLayer
}).addTo(map);

// Holds manually-drawn perimeters (one per row, keyed via layer.rowId below).
// Kept on the map permanently (rebuilt on every render) so it can be passed
// once to L.Control.Draw's edit option, letting users reshape/delete these
// shapes directly on the map with the standard leaflet-draw toolbar.
const editableGroup = L.featureGroup().addTo(map);

// ---- French localization for the leaflet-draw toolbar -----------------------------
if (window.L && L.drawLocal) {
  L.drawLocal.draw.toolbar.buttons.polygon = 'Dessiner un périmètre';
  L.drawLocal.draw.toolbar.buttons.rectangle = 'Dessiner un rectangle';
  L.drawLocal.draw.handlers.polygon.tooltip.start = 'Cliquez pour commencer à dessiner le périmètre.';
  L.drawLocal.draw.handlers.polygon.tooltip.cont = 'Cliquez pour continuer à dessiner le périmètre.';
  L.drawLocal.draw.handlers.polygon.tooltip.end = 'Cliquez sur le premier point pour fermer le périmètre.';
  L.drawLocal.draw.handlers.rectangle.tooltip.start = 'Cliquez et glissez pour dessiner un rectangle.';
  L.drawLocal.draw.handlers.simpleshape.tooltip.end = 'Relâchez la souris pour terminer.';
  L.drawLocal.edit.toolbar.buttons.edit = 'Modifier un périmètre';
  L.drawLocal.edit.toolbar.buttons.editDisabled = 'Aucun périmètre à modifier';
  L.drawLocal.edit.toolbar.buttons.remove = 'Supprimer un périmètre';
  L.drawLocal.edit.toolbar.buttons.removeDisabled = 'Aucun périmètre à supprimer';
  L.drawLocal.edit.handlers.edit.tooltip.text = 'Faites glisser les poignées pour modifier le périmètre.';
  L.drawLocal.edit.handlers.edit.tooltip.subtext = 'Cliquez sur Annuler pour ignorer les modifications.';
  L.drawLocal.edit.handlers.remove.tooltip.text = 'Cliquez sur un périmètre pour le supprimer.';
}

const LAYER_COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'];
function colorForLayer(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) { hash = (hash * 31 + name.charCodeAt(i)) >>> 0; }
  return LAYER_COLORS[hash % LAYER_COLORS.length];
}

const statusEl = document.getElementById('status');
const refreshButton = document.getElementById('refresh');
const drawTargetEl = document.getElementById('drawTarget');

function setStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = type === 'error' ? 'error' : type === 'loading' ? 'loading' : '';
}

// Shows which row a newly-drawn perimeter will be saved to (the row last
// selected/clicked in the Grist table). Only relevant once ManualGeoJSON
// is mapped, since that's what enables the draw toolbar.
function updateDrawTarget(rec) {
  if (!(lastMappings && lastMappings[ManualGeoJSON])) {
    drawTargetEl.textContent = '';
    return;
  }
  drawTargetEl.textContent = rec ? `Cible du dessin : ${rec.name || ('#' + rec.id)}` : 'Sélectionnez une ligne pour dessiner son périmètre';
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
let selectedRowId = null;  // row a newly-drawn perimeter will be saved to
let drawControl = null;
let drawing = false;
let followSelection = false; // devient vrai dès que l'utilisateur change de réserve (liste ou clic sur la carte)
let lastCursorId = null;      // vrai pendant un dessin / une modification / une suppression (leaflet-draw)

grist.on('message', (e) => {
  if (e.tableId) { selectedTableId = e.tableId; }
});

// Computes the geodesic area (m²) of a drawn polygon/rectangle layer,
// using leaflet-draw's L.GeometryUtil (accounts for the earth's curvature,
// unlike a flat planar shoelace formula on lat/lng coordinates).
function computeLayerArea(layer) {
  const latlngs = layer.getLatLngs();
  const ring = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
  return Math.round(L.GeometryUtil.geodesicArea(ring) * 100) / 100;
}

// Geodesic area (m²) of a single ring given as [lon, lat] pairs (GeoJSON order).
function ringGeodesicArea(ring) {
  return L.GeometryUtil.geodesicArea(ring.map(([lon, lat]) => L.latLng(lat, lon)));
}

function polygonGeodesicArea(coordinates) {
  if (!coordinates.length) return 0;
  let area = ringGeodesicArea(coordinates[0]);
  for (let i = 1; i < coordinates.length; i++) { area -= ringGeodesicArea(coordinates[i]); } // subtract holes
  return area;
}

// Total geodesic area (m²) of a GeoJSON geometry fetched from the geoportal —
// possibly a Polygon, MultiPolygon, or a GeometryCollection combining several
// parcels (see "Une ou plusieurs parcelles par ligne" in the README).
function computeGeometryArea(geometry) {
  if (!geometry) return 0;
  switch (geometry.type) {
    case 'Polygon':
      return polygonGeodesicArea(geometry.coordinates);
    case 'MultiPolygon':
      return geometry.coordinates.reduce((sum, poly) => sum + polygonGeodesicArea(poly), 0);
    case 'GeometryCollection':
      return (geometry.geometries || []).reduce((sum, g) => sum + computeGeometryArea(g), 0);
    default:
      return 0;
  }
}

// Adds/removes the leaflet-draw toolbar depending on whether ManualGeoJSON
// is mapped — drawing is only meaningful once there's a column to save into.
function ensureDrawControl() {
  const manualColId = lastMappings && lastMappings[ManualGeoJSON];
  if (manualColId && !drawControl) {
    drawControl = new L.Control.Draw({
      position: 'topright',
      draw: {
        polygon: { allowIntersection: false, showArea: true, metric: true },
        rectangle: false,
        polyline: false,
        marker: false,
        circle: false,
        circlemarker: false,
      },
      edit: {
        featureGroup: editableGroup,
      },
    });
    map.addControl(drawControl);
  } else if (!manualColId && drawControl) {
    map.removeControl(drawControl);
    drawControl = null;
  }
}

async function saveManualGeometry(rowId, geometry, area) {
  const values = { [lastMappings[ManualGeoJSON]]: JSON.stringify(geometry) };
  if (lastMappings[ManualArea]) { values[lastMappings[ManualArea]] = area; }
  await grist.docApi.applyUserActions([['UpdateRecord', selectedTableId, rowId, values]]);
}

map.on('draw:drawstart draw:editstart draw:deletestart', () => { drawing = true; });
map.on('draw:drawstop draw:editstop draw:deletestop', () => { drawing = false; });

map.on(L.Draw.Event.CREATED, async (e) => {
  if (!selectedRowId) {
    setStatus('Sélectionnez d\'abord une ligne dans le tableau pour lui associer ce périmètre.', 'error');
    return;
  }
  if (!selectedTableId || !lastMappings || !lastMappings[ManualGeoJSON]) { return; }
  // Show the shape immediately instead of waiting for the Grist round-trip;
  // the next render() rebuilds editableGroup from scratch and replaces it.
  e.layer.rowId = selectedRowId;
  e.layer.setStyle?.({ dashArray: '6,6' });
  editableGroup.addLayer(e.layer);
  try {
    const geometry = e.layer.toGeoJSON().geometry;
    const area = computeLayerArea(e.layer);
    await saveManualGeometry(selectedRowId, geometry, area);
    setStatus('Périmètre manuel enregistré.', 'info');
  } catch (err) {
    console.error(err);
    setStatus(`Erreur lors de l'enregistrement du périmètre : ${err.message}`, 'error');
  }
});

map.on(L.Draw.Event.EDITED, async (e) => {
  if (!selectedTableId || !lastMappings || !lastMappings[ManualGeoJSON]) { return; }
  try {
    const updates = [];
    e.layers.eachLayer((layer) => {
      if (layer.rowId == null) return;
      updates.push(saveManualGeometry(layer.rowId, layer.toGeoJSON().geometry, computeLayerArea(layer)));
    });
    await Promise.all(updates);
    setStatus('Périmètre(s) manuel(s) mis à jour.', 'info');
  } catch (err) {
    console.error(err);
    setStatus(`Erreur lors de la mise à jour du périmètre : ${err.message}`, 'error');
  }
});

map.on(L.Draw.Event.DELETED, async (e) => {
  if (!selectedTableId || !lastMappings || !lastMappings[ManualGeoJSON]) { return; }
  try {
    const rowIds = [];
    e.layers.eachLayer((layer) => { if (layer.rowId != null) rowIds.push(layer.rowId); });
    if (rowIds.length === 0) return;
    const values = { [lastMappings[ManualGeoJSON]]: rowIds.map(() => null) };
    if (lastMappings[ManualArea]) { values[lastMappings[ManualArea]] = rowIds.map(() => null); }
    await grist.docApi.applyUserActions([['BulkUpdateRecord', selectedTableId, rowIds, values]]);
    setStatus('Périmètre(s) manuel(s) supprimé(s).', 'info');
  } catch (err) {
    console.error(err);
    setStatus(`Erreur lors de la suppression du périmètre : ${err.message}`, 'error');
  }
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
      manualGeojson: mappings[ManualGeoJSON] ? rec[mappings[ManualGeoJSON]] : null,
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
    manualGeojson: null,
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
  // Colonne « Any » contenant une liste (ex. $parcels.EGRID) : tableau d'EGRID
  if (Array.isArray(value)) { return value.filter(v => v && v !== 'L').flatMap(v => parseEgridText(v)); }
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
  editableGroup.clearLayers();
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
    // A manually-drawn perimeter overrides the EGRID-derived geometry for
    // that row (used for reserves that only cover part of a parcel).
    const isManual = !!rec.manualGeojson;
    const rawGeojson = isManual ? rec.manualGeojson : rec.geojson;
    if (!rawGeojson) continue;
    let geometry;
    try {
      geometry = typeof rawGeojson === 'string' ? JSON.parse(rawGeojson) : rawGeojson;
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
      style: isManual
        ? { color: colorForLayer(groupName), weight: 2, fillOpacity: 0.25, dashArray: '6,6' }
        : { color: colorForLayer(groupName), weight: 2, fillOpacity: 0.25 }
    });
    // Clic sur une géométrie : zoom et sélection de la ligne dans Grist (les autres widgets suivent).
    featureLayer.on('click', () => {
      if (drawing) return;
      selectedRowId = rec.id;
      followSelection = true;
      zoomToRow(rec.id, false);
      if (grist.setCursorPos) grist.setCursorPos({ rowId: rec.id }).catch(() => {});
    });
    if (rec.name) {
      featureLayer.bindPopup(String(rec.name) + (isManual ? ' (périmètre dessiné à la main)' : ''));
    }

    if (isManual) {
      // Register each drawn sub-layer with its row id and expose it via the
      // persistent editableGroup so the draw control's edit/delete toolbar
      // can reshape or remove it directly on the map.
      featureLayer.eachLayer(l => {
        l.rowId = rec.id;
        editableGroup.addLayer(l);
      });
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

  const overlays = { ...currentGroups };
  if (editableGroup.getLayers().length > 0) {
    overlays['Périmètres manuels'] = editableGroup;
  }
  if (Object.keys(overlays).length > 1) {
    layersControl = L.control.layers(null, overlays, { collapsed: true }).addTo(map);
  }

  // Réserve choisie par l'utilisateur : on zoome dessus. Sinon on garde la vue actuelle
  // (à l'ouverture : l'emprise du canton de Fribourg).
  if (followSelection && selectedRowId) zoomToRow(selectedRowId, false);

  return shown;
}

// Affiche tout de suite les géométries déjà enregistrées dans Grist, puis télécharge en arrière-plan
// celles qui manquent (une seule tentative par ligne et par session, sauf « Actualiser »).
const failedRows = new Set();
async function loadAndRender(forceRefresh) {
  if (!lastMapped) return;
  if (loading) {
    pendingRerun = true;
    pendingForce = pendingForce || forceRefresh;
    return;
  }
  loading = true;
  refreshButton.disabled = true;
  if (forceRefresh) failedRows.clear();

  const mapped = lastMapped.map(r => forceRefresh ? { ...r, geojson: null } : r);
  for (const r of mapped) r.egridList = [];

  // 1. Affichage immédiat de ce qui est déjà en cache
  let shown = renderMap(mapped);
  if (!T.render) T.render = performance.now();
  setStatus(`${shown} réserve(s) affichée(s).${timingText()}`, 'info');

  // 2. Géométries manquantes : EGRID résolus seulement s'il y en a
  const hasEgrid = v => Array.isArray(v) ? v.some(x => x && x !== 'L') : (v != null && v !== '');
  const missing = mapped.filter(r => !r.geojson && !r.manualGeojson && hasEgrid(r.egridRaw) && !failedRows.has(r.id));
  const errors = [];
  if (missing.length) {
    await resolveEgridLists(missing, forceRefresh);
    const toFetch = missing.filter(r => r.egridList.length > 0);
    const updates = []; // {rowId, geojson, area}
    const parcelGeoms = {}; // egrid -> geometry (enregistrée aussi dans la table des parcelles)
    const tFetch = performance.now();

    for (let i = 0; i < toFetch.length; i++) {
      const rec = toFetch[i];
      const geometries = [];
      for (let j = 0; j < rec.egridList.length; j++) {
        const egrid = String(rec.egridList[j]).trim();
        const progress = rec.egridList.length > 1 ? ` (parcelle ${j + 1}/${rec.egridList.length})` : '';
        setStatus(`${shown} réserve(s) affichée(s) · téléchargement des géométries manquantes ${i + 1}/${toFetch.length}${progress}…`, 'loading');
        try {
          const g = await fetchParcelGeometry(egrid);
          geometries.push(g);
          parcelGeoms[egrid] = g;
        } catch (err) {
          errors.push(`${egrid}: ${err.message}`);
          console.error(err);
        }
      }
      if (geometries.length > 0) {
        const combined = geometries.length === 1 ? geometries[0] : { type: 'GeometryCollection', geometries };
        rec.geojson = JSON.stringify(combined);
        updates.push({ rowId: rec.id, geojson: rec.geojson });
      } else {
        failedRows.add(rec.id);
      }
    }
    T.fetch = (T.fetch || 0) + performance.now() - tFetch;

    if (updates.length > 0 && selectedTableId && lastMappings && lastMappings[GeoJSON]) {
      try {
        await grist.docApi.applyUserActions([['BulkUpdateRecord', selectedTableId, updates.map(u => u.rowId),
          { [lastMappings[GeoJSON]]: updates.map(u => u.geojson) }]]);
      } catch (err) {
        console.error('Impossible de mettre en cache la géométrie dans Grist (accès en écriture requis) :', err);
      }
    }

    // Géométrie et surface de chaque parcelle téléchargée -> table des parcelles
    if (Object.keys(parcelGeoms).length > 0) {
      try {
        const pt = await grist.docApi.fetchTable(PARCELS_TABLE);
        const ids = [], geos = [], areas = [];
        (pt.id || []).forEach((id, i) => {
          const g = parcelGeoms[String(pt[PARCEL_EGRID]?.[i] || '').trim()];
          if (g) { ids.push(id); geos.push(JSON.stringify(g)); areas.push(Math.round(computeGeometryArea(g) * 100) / 100); }
        });
        if (ids.length) {
          await grist.docApi.applyUserActions([['BulkUpdateRecord', PARCELS_TABLE, ids, { [PARCEL_GEOJSON]: geos, [PARCEL_AREA]: areas }]]);
        }
      } catch (err) {
        console.error('Impossible d\'enregistrer la géométrie des parcelles :', err);
      }
    }
    if (updates.length) shown = renderMap(mapped);
  }

  if (errors.length > 0) {
    setStatus(`${shown} réserve(s) affichée(s). ${errors.length} erreur(s) : ${errors.join(' ; ')}${timingText()}`, 'error');
  } else if (shown === 0) {
    setStatus('Aucune réserve à afficher (pas de géométrie).', 'error');
  } else {
    setStatus(`${shown} réserve(s) affichée(s).${timingText()}`, 'info');
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

// Zoome sur la géométrie d'une ligne (marge d'un tiers de la carte de chaque côté).
// Renvoie false si la géométrie n'est pas (encore) dessinée : le zoom se fera après le prochain rendu.
function zoomToRow(rowId, openPopup) {
  const layer = recordLayers[rowId];
  if (!layer) return false;
  if (layer.getBounds) {
    const size = map.getSize();
    map.fitBounds(layer.getBounds(), { padding: [size.x / 3, size.y / 3], maxZoom: 18 });
  } else if (layer.getLatLng) {
    map.setView(layer.getLatLng(), 18);
  }
  if (openPopup) layer.openPopup();
  return true;
}

grist.onRecord((record, mappings) => {
  const effectiveMappings = mappings || lastMappings;
  const rec = mapRecord(record, effectiveMappings);
  selectedRowId = rec.id;
  updateDrawTarget(rec);
  // À l'ouverture, Grist place le curseur sur une ligne sans que l'utilisateur ait choisi :
  // on ne zoome qu'à partir du premier changement de réserve.
  if (lastCursorId !== null && rec.id !== lastCursorId) followSelection = true;
  lastCursorId = rec.id;
  if (followSelection) zoomToRow(rec.id, true);
});

grist.onRecords((records, mappings) => {
  if (!T.data) T.data = performance.now();
  if (mappings) { lastMappings = mappings; }
  lastMapped = records.map(r => mapRecord(r, lastMappings));
  ensureDrawControl();
  if (selectedRowId) updateDrawTarget(lastMapped.find(r => r.id === selectedRowId) || null);
  loadAndRender(false);
});


grist.ready({
  columns: [
    { name: EGRID, type: 'Any', title: 'EGRID', description: 'EGRID de la parcelle. Colonne texte (un EGRID, ou plusieurs séparés par des virgules), ou référence/liste de références vers une table de parcelles ayant elle-même une colonne "EGRID"' },
    { name: Name, type: 'Any', title: 'Nom', optional: true, description: 'Nom affiché dans la popup (ex: nom de la réserve ou n° de parcelle)' },
    { name: Layer, type: 'Any', title: 'Réserve', optional: true, description: 'Regroupe les parcelles par réserve/calque, activable/désactivable sur la carte' },
    { name: Label, type: 'Any', title: 'Étiquette', optional: true, description: 'Texte affiché en permanence sur la parcelle (ex: nom de la réserve)' },
    { name: GeoJSON, type: 'Text', title: 'GeoJSON (cache)', optional: true, description: 'Colonne de cache : la géométrie récupérée depuis le géoportail suisse y est enregistrée pour éviter de la re-télécharger à chaque ouverture' },
    { name: ManualGeoJSON, type: 'Text', title: 'Périmètre manuel (GeoJSON)', optional: true, description: 'Colonne texte où enregistrer le périmètre dessiné à la main sur la carte (remplace la géométrie EGRID pour cette ligne, utile quand seule une partie de la parcelle est concernée). Sélectionnez la ligne dans le tableau puis dessinez avec l\'outil polygone/rectangle en haut à droite de la carte' },
    { name: ManualArea, type: 'Numeric', title: 'Surface manuelle (m²)', optional: true, description: 'Colonne numérique où la surface (m²) du périmètre dessiné à la main est automatiquement enregistrée' },
  ],
  requiredAccess: 'full',
  allowSelectBy: true,
});

// ---- Couches nature : fonds WMS lus dans la table Couches_carte -------------------
// Colonnes : nom, groupe, url_wms, couche_wms, actif, afficher_par_defaut, opacite, ordre, source.
// Ajouter / modifier une couche dans la table, puis recharger la page (ou « Relire la table »).
const NAT_TABLE = 'Couches_carte';
const NAT_STORE = 'pn-carte-couches-v1';   // couches cochées et opacités, mémorisées dans ce navigateur
let natLayers = [];                        // { id, nom, groupe, layer, row }
const natCtlEl = L.DomUtil.create('div', 'nat-ctl collapsed');

function natLoadPrefs() { try { return JSON.parse(localStorage.getItem(NAT_STORE) || '{}'); } catch (e) { return {}; } }
function natSavePrefs() {
  try {
    const p = {};
    for (const n of natLayers) p[n.id] = { on: map.hasLayer(n.layer), op: n.layer.options.opacity };
    localStorage.setItem(NAT_STORE, JSON.stringify(p));
  } catch (e) { /* stockage indisponible : sans importance */ }
}

const NatControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    L.DomEvent.disableClickPropagation(natCtlEl);
    L.DomEvent.disableScrollPropagation(natCtlEl);
    return natCtlEl;
  },
});
new NatControl().addTo(map);

function natEsc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function natLoad() {
  for (const n of natLayers) map.removeLayer(n.layer);
  natLayers = [];
  let t;
  try {
    t = await grist.docApi.fetchTable(NAT_TABLE);
  } catch (e) {
    natCtlEl.innerHTML = `<div class="nat-head">🌿 Couches nature <span class="n">(table ${NAT_TABLE} introuvable)</span></div>`;
    return;
  }
  const prefs = natLoadPrefs();
  const rows = (t.id || []).map((id, i) => ({
    id, nom: t.nom?.[i] || '', groupe: t.groupe?.[i] || 'Autres', url: (t.url_wms?.[i] || '').trim(),
    couche: (t.couche_wms?.[i] || '').trim(), actif: !!t.actif?.[i], defaut: !!t.afficher_par_defaut?.[i],
    opacite: t.opacite?.[i], ordre: t.ordre?.[i] ?? 999, source: t.source?.[i] || '',
  })).filter(r => r.actif && r.url && r.couche).sort((a, b) => a.ordre - b.ordre || a.nom.localeCompare(b.nom));

  for (const r of rows) {
    const op = prefs[r.id]?.op ?? (typeof r.opacite === 'number' && r.opacite >= 0 && r.opacite <= 1 ? r.opacite : 0.7);
    const layer = L.tileLayer.wms(r.url, {
      layers: r.couche, format: 'image/png', transparent: true, version: '1.3.0',
      opacity: op, attribution: natEsc(r.source), zIndex: 100 + Math.round(r.ordre || 0), maxZoom: 20,
    });
    const n = { id: r.id, nom: r.nom || r.couche, groupe: r.groupe, layer, row: r };
    layer.on('tileerror', () => { n.err = true; natRender(); });
    layer.on('tileload', () => { if (n.err) { n.err = false; natRender(); } });
    natLayers.push(n);
    const on = prefs[r.id] ? prefs[r.id].on : r.defaut;
    if (on) layer.addTo(map);
  }
  if (!T.nat) T.nat = performance.now();
  natRender();
}

function natRender() {
  const open = !natCtlEl.classList.contains('collapsed');
  const nOn = natLayers.filter(n => map.hasLayer(n.layer)).length;
  const groups = [];
  for (const n of natLayers) { let g = groups.find(x => x.name === n.groupe); if (!g) groups.push(g = { name: n.groupe, items: [] }); g.items.push(n); }
  let h = `<div class="nat-head" data-nat="toggle">🌿 Couches nature${nOn ? ` <span class="n">(${nOn})</span>` : ''}</div><div class="nat-body">`;
  if (!natLayers.length) h += `<div class="nat-foot">Aucune couche active dans la table ${NAT_TABLE}.</div>`;
  for (const g of groups) {
    const all = g.items.every(n => map.hasLayer(n.layer)), some = g.items.some(n => map.hasLayer(n.layer));
    h += `<div class="nat-grp"><label><input type="checkbox" data-nat="grp" data-g="${natEsc(g.name)}" ${all ? 'checked' : ''} ${!all && some ? 'data-mixed="1"' : ''}> ${natEsc(g.name)}</label>`;
    for (const n of g.items) {
      const on = map.hasLayer(n.layer);
      h += `<div class="nat-lyr ${on ? 'on' : ''} ${n.err ? 'err' : ''}"><label title="${natEsc(n.row.couche)}"><input type="checkbox" data-nat="lyr" data-id="${n.id}" ${on ? 'checked' : ''}> ${natEsc(n.nom)}${n.err ? ' ⚠' : ''}</label>
        <input type="range" min="0.1" max="1" step="0.1" value="${n.layer.options.opacity}" data-nat="op" data-id="${n.id}" title="Opacité"></div>`;
    }
    h += `</div>`;
  }
  h += `<div class="nat-foot">Liste : table ${NAT_TABLE} · <a data-nat="reload">Relire la table</a>${natLayers.some(n => n.err) ? '<br>⚠ = la couche ne répond pas (adresse ou nom technique à vérifier).' : ''}</div></div>`;
  natCtlEl.innerHTML = h;
  natCtlEl.classList.toggle('collapsed', !open);
  natCtlEl.querySelectorAll('[data-mixed]').forEach(i => { i.indeterminate = true; });
}

natCtlEl.addEventListener('click', (e) => {
  const el = e.target.closest('[data-nat]');
  if (!el) return;
  const act = el.dataset.nat;
  if (act === 'toggle') { natCtlEl.classList.toggle('collapsed'); return; }
  if (act === 'reload') { natLoad(); return; }
});
natCtlEl.addEventListener('change', (e) => {
  const el = e.target;
  const act = el.dataset.nat;
  if (act === 'lyr') {
    const n = natLayers.find(x => x.id === Number(el.dataset.id));
    if (n) { if (el.checked) n.layer.addTo(map); else map.removeLayer(n.layer); }
  } else if (act === 'grp') {
    for (const n of natLayers.filter(x => x.groupe === el.dataset.g)) { if (el.checked) n.layer.addTo(map); else map.removeLayer(n.layer); }
  } else return;
  natSavePrefs(); natRender();
});
natCtlEl.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.nat !== 'op') return;
  const n = natLayers.find(x => x.id === Number(el.dataset.id));
  if (n) { n.layer.setOpacity(Number(el.value)); natSavePrefs(); }
});

natLoad();
