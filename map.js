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

// ---- Swiss coordinate system (CH1903+ / LV95) ------------------------------------
proj4.defs('EPSG:2056', '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs');

// ---- Map setup --------------------------------------------------------------------
const map = L.map('map').setView([46.8, 8.2], 9);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19
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
        rectangle: { showArea: true, metric: true },
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
  const updates = []; // {rowId, geojson, area}

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
      const area = Math.round(computeGeometryArea(combined) * 100) / 100;
      updates.push({ rowId: rec.id, geojson: rec.geojson, area });
    }
  }

  if (updates.length > 0 && selectedTableId && lastMappings && (lastMappings[GeoJSON] || lastMappings[Area])) {
    try {
      const values = {};
      if (lastMappings[GeoJSON]) { values[lastMappings[GeoJSON]] = updates.map(u => u.geojson); }
      if (lastMappings[Area]) { values[lastMappings[Area]] = updates.map(u => u.area); }
      await grist.docApi.applyUserActions([[
        'BulkUpdateRecord',
        selectedTableId,
        updates.map(u => u.rowId),
        values
      ]]);
    } catch (err) {
      console.error('Impossible de mettre en cache la géométrie/surface dans Grist (accès en écriture requis) :', err);
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
  selectedRowId = rec.id;
  updateDrawTarget(rec);
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
  ensureDrawControl();
  loadAndRender(false);
});

grist.ready({
  columns: [
    { name: EGRID, type: 'Any', title: 'EGRID', description: 'EGRID de la parcelle. Colonne texte (un EGRID, ou plusieurs séparés par des virgules), ou référence/liste de références vers une table de parcelles ayant elle-même une colonne "EGRID"' },
    { name: Name, type: 'Any', title: 'Nom', optional: true, description: 'Nom affiché dans la popup (ex: nom de la réserve ou n° de parcelle)' },
    { name: Layer, type: 'Any', title: 'Réserve', optional: true, description: 'Regroupe les parcelles par réserve/calque, activable/désactivable sur la carte' },
    { name: Label, type: 'Any', title: 'Étiquette', optional: true, description: 'Texte affiché en permanence sur la parcelle (ex: nom de la réserve)' },
    { name: GeoJSON, type: 'Text', title: 'GeoJSON (cache)', optional: true, description: 'Colonne de cache : la géométrie récupérée depuis le géoportail suisse y est enregistrée pour éviter de la re-télécharger à chaque ouverture' },
    { name: Area, type: 'Numeric', title: 'Surface (m²)', optional: true, description: 'Colonne numérique où la surface (m²) de la géométrie EGRID est automatiquement enregistrée à chaque téléchargement depuis le géoportail (recalculée lors d\'un "Actualiser depuis le géoportail")' },
    { name: ManualGeoJSON, type: 'Text', title: 'Périmètre manuel (GeoJSON)', optional: true, description: 'Colonne texte où enregistrer le périmètre dessiné à la main sur la carte (remplace la géométrie EGRID pour cette ligne, utile quand seule une partie de la parcelle est concernée). Sélectionnez la ligne dans le tableau puis dessinez avec l\'outil polygone/rectangle en haut à droite de la carte' },
    { name: ManualArea, type: 'Numeric', title: 'Surface manuelle (m²)', optional: true, description: 'Colonne numérique où la surface (m²) du périmètre dessiné à la main est automatiquement enregistrée' },
  ],
  requiredAccess: 'full',
  allowSelectBy: true,
});
