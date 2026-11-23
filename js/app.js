'use strict';
const $ = id => document.getElementById(id);
const API = 'php/api.php';
const OSRM = 'https://router.project-osrm.org';
const state = { bins: [], selected: 'C-05', level: 'all', unit: 0, route: null, base: null, routing: null, routeError: '', loaded: false };
const labels = { all: 'Todos', full: 'Lleno', medium: 'Medio', normal: 'Normal', unknown: 'Sin lectura' };
let map;
let markers;
let routeLayer;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function status(bin) {
  if (bin.level === null) return 'unknown';
  if (bin.level >= 80) return 'full';
  return bin.level >= 60 ? 'medium' : 'normal';
}

function percentage(bin) {
  return bin.level === null ? '—' : bin.level + '%';
}

function filtered() {
  return state.bins.filter(bin => (!state.unit || bin.unit === state.unit)
    && (state.level === 'all' || status(bin) === state.level));
}

function selectBin(bin, source) {
  if (!filtered().includes(bin)) state.level = 'all';
  state.selected = bin.id;
  render();
  Array.from($(source).querySelectorAll('[data-id]')).find(node => node.dataset.id === bin.id)?.focus();
}

function binButton(bin, source) {
  const node = button(undefined, () => selectBin(bin, source), 'bin ' + status(bin));
  node.dataset.id = bin.id;
  node.setAttribute('aria-current', bin.id === state.selected);
  const body = element('span');
  body.append(element('strong', bin.name), element('small', bin.id + ' · Unidad ' + bin.unit));
  node.append(element('span', percentage(bin), 'badge'), body);
  return node;
}

function filters(id, values, current, apply) {
  $(id).replaceChildren(...values.map(([value, label]) => {
    const node = button(label, () => {
      apply(value);
      render();
      $(id).querySelector('[aria-pressed=true]')?.focus();
    });
    node.setAttribute('aria-pressed', value === current);
    return node;
  }));
}

function render() {
  const bins = filtered().sort((a, b) => (b.level ?? -1) - (a.level ?? -1));
  const full = state.bins.filter(bin => status(bin) === 'full');
  const measured = state.bins.filter(bin => bin.level !== null);
  const average = measured.length ? Math.round(measured.reduce((sum, bin) => sum + bin.level, 0) / measured.length) + '%' : '—';
  $('stats').replaceChildren(...[[state.bins.length, 'Contenedores'], [full.length, 'Por recolectar'], [average, 'Llenado medio'], [measured.length, 'Con lectura']].map(([value, label]) => {
    const node = element('div', undefined, 'stat');
    node.append(element('strong', value), element('small', label));
    return node;
  }));
  filters('levels', Object.entries(labels), state.level, value => { state.level = value; });
  filters('units', [[0, 'Todas'], [1, 'Unidad 1'], [2, 'Unidad 2'], [3, 'Unidad 3']], state.unit, value => {
    state.unit = value;
    clearRoute();
  });
  $('bins').replaceChildren(...(bins.length ? bins.map(bin => binButton(bin, 'bins')) : [element('p', 'Sin contenedores para estos filtros.')]));
  const urgent = state.unit ? full.filter(bin => bin.unit === state.unit) : full;
  $('showAlerts').textContent = 'Alertas (' + urgent.length + ')';
  $('alerts').replaceChildren(element('h2', 'Contenedores por recolectar'), ...(
    urgent.length ? urgent.sort((a, b) => b.level - a.level).map(bin => binButton(bin, 'alerts')) : [element('p', 'Sin contenedores llenos.')]));
  const selected = bins.find(bin => bin.id === state.selected) ?? bins[0];
  state.selected = selected?.id;
  showDetails(selected);
  drawMap(bins);
  showRoute();
}

function located(point) {
  return Number.isFinite(point?.latitud) && Number.isFinite(point?.longitud);
}

function latLng(point) {
  return [point.latitud, point.longitud];
}

function initMap() {
  if (!window.L) return;
  map = L.map('map', { preferCanvas: true }).setView([19.4326, -99.1332], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  markers = L.layerGroup().addTo(map);
}

function drawMap(bins) {
  if (!map) return;
  markers.clearLayers();
  routeLayer.clearLayers();
  if (state.route) {
    L.geoJSON(state.route.geometry, {
      style: { color: '#8b42e0', weight: 6, opacity: 0.9 },
    }).addTo(routeLayer);
  }
  if (located(state.base)) {
    L.circleMarker(latLng(state.base), { radius: 9, color: '#143b57', fillColor: '#68d8ff', fillOpacity: 1 })
      .bindTooltip('Base', { permanent: true, direction: 'top' }).addTo(markers);
  }
  const stops = new Map(state.route?.stops.map((bin, index) => [bin.id, index + 1]));
  const colors = { full: '#c73820', medium: '#a96500', normal: '#157553', unknown: '#48636c' };
  for (const bin of state.bins.filter(item => located(item) && (bins.includes(item) || stops.has(item.id)))) {
    const active = bin.id === state.selected;
    const marker = L.circleMarker(latLng(bin), {
      radius: active ? 13 : 10, color: active ? '#151e4b' : '#fff', weight: 3,
      fillColor: colors[status(bin)], fillOpacity: 1,
    }).addTo(markers);
    const caption = stops.has(bin.id) ? stops.get(bin.id) + ' · ' : '';
    marker.bindTooltip(element('span', caption + bin.name + ' · ' + percentage(bin)),
      { permanent: stops.has(bin.id), direction: 'top', offset: [0, -8] });
    marker.on('click', () => selectBin(bin, 'bins'));
  }
}

function showRoute() {
  $('routeButton').disabled = !state.loaded || !map || Boolean(state.routing);
  $('routeButton').textContent = state.routing ? 'Calculando…' : 'Generar ruta';
  const info = $('routeInfo');
  const route = state.route;
  const missing = state.bins.filter(bin => !located(bin)).length;
  const summary = state.routing ? 'Calculando por calles…'
    : state.routeError || (route
      ? route.stops.length + ' paradas · ' + (route.distance / 1000).toFixed(1) + ' km · ' + Math.ceil(route.duration / 60) + ' min de manejo'
      : 'Ruta desde la base para contenedores al 80 % o más.');
  info.replaceChildren(element('p', summary));
  if (missing) info.append(element('p', missing + ' contenedores todavía no tienen coordenadas.'));
  if (route) {
    const list = element('ol');
    list.append(...route.stops.map(bin => element('li', bin.name + ' · ' + percentage(bin))));
    info.append(list);
    if (route.omitted.length) info.append(element('p', 'Sin coordenadas, fuera de la ruta: ' + route.omitted.map(bin => bin.id).join(', ')));
  }
}

function showDetails(bin) {
  if (!bin) {
    $('details').replaceChildren(element('p', 'Selecciona un contenedor.'));
    return;
  }
  const reading = element('div', undefined, 'reading ' + status(bin));
  const ring = element('span', undefined, 'ring');
  ring.style.setProperty('--level', (bin.level ?? 0) + '%');
  ring.setAttribute('aria-hidden', 'true');
  const value = element('div');
  value.append(element('strong', percentage(bin)), element('p', labels[status(bin)]));
  reading.append(ring, value);
  const label = element('label', 'Unidad asignada');
  label.htmlFor = 'assigned';
  const unit = element('select');
  unit.id = 'assigned';
  for (const number of [1, 2, 3]) unit.add(new Option('Unidad ' + number, number));
  unit.value = bin.unit;
  unit.addEventListener('change', () => update(bin, { unit: Number(unit.value) }, 'Unidad actualizada.'));
  const collect = button('Marcar como recolectado', () => update(bin, { collect: true }, 'Recolección registrada.'), 'accent');
  collect.disabled = !bin.level;
  $('details').replaceChildren(element('h2', bin.name), element('small', bin.id + ' · ' +
    (bin.recordedAt ? 'Lectura: ' + new Date(bin.recordedAt).toLocaleString('es-MX') : 'Sin lectura')), reading, label, unit, collect);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) throw new Error(data?.error || 'No se pudo consultar el servidor.');
  return data;
}

function message(value) {
  $('message').textContent = value;
  $('message').hidden = !value;
}

async function update(bin, changes, confirmation) {
  clearRoute();
  showRoute();
  $('assigned').disabled = true;
  $('details').querySelector('button').disabled = true;
  try {
    await request(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: bin.id, ...changes }) });
    await loadData();
    clearRoute();
    message(confirmation);
  } catch (error) {
    message(error.message);
  } finally {
    render();
  }
}

function tab(showMap) {
  $('mapView').hidden = !showMap;
  $('alerts').hidden = showMap;
  $('showMap').setAttribute('aria-pressed', showMap);
  $('showAlerts').setAttribute('aria-pressed', !showMap);
  if (showMap) requestAnimationFrame(() => map?.invalidateSize());
}

$('showMap').onclick = () => tab(true);
$('showAlerts').onclick = () => tab(false);
function clearRoute() {
  state.routing?.abort();
  state.routing = null;
  state.route = null;
  state.routeError = '';
}

function osrmCoordinates(points) {
  return points.map(point => point.longitud + ',' + point.latitud).join(';');
}

async function osrm(service, points, options, signal) {
  const response = await fetch(OSRM + '/' + service + '/v1/driving/' + osrmCoordinates(points) + '?' + options, { signal });
  const data = await response.json();
  if (!response.ok || data.code !== 'Ok') {
    throw new Error('OSRM no encontró un recorrido vehicular. Revisa que los puntos estén cerca de calles accesibles.');
  }
  return data;
}

function orderStops(bins, durations) {
  const remaining = bins.map((_, index) => index + 1);
  const stops = [];
  let current = 0;
  while (remaining.length) {
    const reachable = remaining.filter(index => Number.isFinite(durations[current]?.[index]));
    reachable.sort((a, b) => durations[current][a] - durations[current][b]
      || bins[b - 1].level - bins[a - 1].level || bins[a - 1].id.localeCompare(bins[b - 1].id));
    if (!reachable.length) {
      throw new Error('No hay acceso vehicular hacia: ' + remaining.map(index => bins[index - 1].id).join(', ') + '.');
    }
    current = reachable[0];
    remaining.splice(remaining.indexOf(current), 1);
    stops.push(bins[current - 1]);
  }
  return stops;
}

$('routeButton').onclick = async () => {
  clearRoute();
  tab(true);
  const candidates = state.bins.filter(bin => status(bin) === 'full' && (!state.unit || bin.unit === state.unit));
  const pending = candidates.filter(located);
  const omitted = candidates.filter(bin => !located(bin));
  if (!located(state.base) || !pending.length) {
    state.routeError = !located(state.base) ? 'Configura las coordenadas de la base en PostgreSQL.'
      : candidates.length ? 'Los contenedores llenos de esta selección todavía no tienen coordenadas.'
        : 'No hay contenedores llenos para esta selección.';
    render();
    return;
  }

  const controller = new AbortController();
  state.routing = controller;
  const timer = setTimeout(() => controller.abort(), 25000);
  render();
  try {
    const options = { radiuses: Array(pending.length + 1).fill(50).join(';') };
    const { durations } = await osrm('table', [state.base, ...pending],
      new URLSearchParams({ ...options, annotations: 'duration' }), controller.signal);
    const stops = orderStops(pending, durations);
    const { routes } = await osrm('route', [state.base, ...stops],
      new URLSearchParams({ ...options, overview: 'full', geometries: 'geojson' }), controller.signal);
    if (state.routing !== controller) return;
    const route = routes?.[0];
    if (!route?.geometry) throw new Error('OSRM no devolvió un trazado.');
    state.route = { ...route, stops, omitted };
    map.invalidateSize();
    map.fitBounds(L.geoJSON(route.geometry).getBounds(), { padding: [30, 30], maxZoom: 17 });
  } catch (error) {
    if (state.routing !== controller) return;
    state.routeError = error.name === 'AbortError' ? 'OSRM tardó demasiado. Vuelve a intentar.'
      : error instanceof TypeError ? 'No se pudo conectar con el servicio de rutas. Revisa tu conexión.'
        : error.message;
  } finally {
    clearTimeout(timer);
    if (state.routing === controller) {
      state.routing = null;
      render();
    }
  }
};

async function loadData() {
  const data = await request(API, { cache: 'no-store' });
  if (!Array.isArray(data.bins)) throw new Error('Actualiza php/api.php a la versión que devuelve coordenadas.');
  state.bins = data.bins;
  state.base = data.base;
  state.loaded = true;
}

function theme(light) {
  document.documentElement.classList.toggle('light', light);
  $('theme').textContent = light ? 'Tema oscuro' : 'Tema claro';
}

theme(localStorage.getItem('ecoruta-theme') === 'light');
$('theme').onclick = () => {
  const light = !document.documentElement.classList.contains('light');
  theme(light);
  localStorage.setItem('ecoruta-theme', light ? 'light' : 'dark');
};

(async () => {
  $('mode').textContent = '· PostgreSQL';
  $('routeButton').disabled = true;
  try {
    initMap();
    await loadData();
    const points = [state.base, ...state.bins].filter(located).map(latLng);
    if (map && points.length) map.fitBounds(points, { padding: [25, 25], maxZoom: 16 });
    if (!map) message('Leaflet no cargó. Revisa tu conexión a internet para activar el mapa.');
  } catch (error) {
    message(error.message);
  }
  render();
})();