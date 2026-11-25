'use strict';
const $ = id => document.getElementById(id);
const API = 'php/api.php';
const OSRM = 'https://router.project-osrm.org';
const state = { bins: [], selected: 'C-05', level: 'all', unit: 0, route: null, truck: null, base: null, routing: null, routeError: '', loaded: false };
const labels = { all: 'Todos', full: 'Lleno', medium: 'Medio', normal: 'Normal', unknown: 'Sin lectura' };
let map;
let markers;
let routeLayer;
let drawnRoute;
let collecting = 0;

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
  const body = element('span', undefined, 'bin-body');
  body.append(element('strong', bin.name), element('small', bin.id + ' · Unidad ' + bin.unit));
  if (source === 'bins') {
    const bar = element('span', undefined, 'level-bar');
    bar.style.setProperty('--level', Math.max(0, Math.min(100, bin.level ?? 0)) + '%');
    bar.setAttribute('aria-hidden', 'true');
    body.append(bar);
    node.append(element('span', percentage(bin), 'badge'), body);
  } else {
    body.querySelector('strong').textContent = bin.name + (bin.level === null ? '' : ' al ' + percentage(bin));
    if (bin.level === null) body.querySelector('small').textContent += ' · Sin lectura';
    node.append(body);
  }
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
  const selected = bins.find(bin => bin.id === state.selected) ?? bins[0];
  state.selected = selected?.id;
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
  if (!urgent.length && !collecting && (state.route || state.routing)) clearRoute(true);
  $('showAlerts').textContent = 'Alertas (' + urgent.length + ')';
  const unread = state.bins.filter(bin => status(bin) === 'unknown' && (!state.unit || bin.unit === state.unit));
  const alertHeading = element('div', undefined, 'alert-heading');
  alertHeading.append(element('h2', 'Alertas'), element('small', urgent.length + ' activas'));
  const alertList = [...urgent.sort((a, b) => b.level - a.level), ...unread];
  $('alerts').replaceChildren(alertHeading, ...(alertList.length
    ? alertList.map(bin => binButton(bin, 'alerts'))
    : [element('p', 'Sin alertas para esta selección.')]));
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
  map = L.map('map', { zoomControl: false }).setView([19.4326, -99.1332], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  markers = L.layerGroup().addTo(map);
}

function drawMap(bins) {
  if (!map) return;
  markers.clearLayers();
  if (drawnRoute !== state.route) {
    routeLayer.clearLayers();
    drawnRoute = state.route;
    if (drawnRoute?.geometry) {
      L.geoJSON(drawnRoute.geometry, {
        style: { color: '#00e5ff', weight: 4, dashArray: '13 9', className: 'route-path' },
      }).addTo(routeLayer);
    }
  }
  if (located(state.base) && (!state.truck || state.truck.id)) {
    const icon = L.divIcon({ className: 'map-pin base-pin', html: '⌂', iconSize: [42, 42] });
    L.marker(latLng(state.base), { icon, title: 'Base' })
      .bindTooltip('Base', { direction: 'top' }).addTo(markers);
  }
  const stops = new Map(state.route?.stops.map((bin, index) => [bin.id, index + 1]));
  for (const bin of state.bins.filter(item => located(item) && (bins.includes(item) || stops.has(item.id)))) {
    const active = bin.id === state.selected;
    const size = status(bin) === 'full' || active ? 42 : 34;
    const icon = L.divIcon({
      className: 'map-pin ' + status(bin) + (active ? ' selected-pin' : ''),
      html: element('span', bin.level ?? '—'),
      iconSize: [size, size],
    });
    const marker = L.marker(latLng(bin), { icon, title: bin.name + ' · ' + percentage(bin) }).addTo(markers);
    const caption = stops.has(bin.id) ? stops.get(bin.id) + ' · ' : '';
    marker.bindTooltip(element('span', caption + bin.name + ' · ' + percentage(bin)),
      { direction: 'top', offset: [0, -14] });
    marker.on('click', () => selectBin(bin, 'bins'));
  }
  if (state.truck) {
    const icon = L.divIcon({ className: 'map-pin truck-pin', html: '🚛', iconSize: [44, 44] });
    const title = 'Camión · ' + (state.truck.name ?? 'Base');
    L.marker(latLng(state.truck), { icon, title, alt: title, zIndexOffset: 1000, interactive: false })
      .addTo(markers);
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
      ? route.stops.length + (route.stops.length === 1 ? ' parada · ' : ' paradas · ') + (route.distance / 1000).toFixed(1) + ' km · ' + Math.ceil(route.duration / 60) + ' min de manejo'
      : 'Ruta desde la base para contenedores al 80 % o más.');
  info.replaceChildren(element('p', summary));
  if (missing) info.append(element('p', missing + ' contenedores todavía no tienen coordenadas.'));
  if (route) {
    const list = element('ol');
    const readings = new Map(state.bins.map(bin => [bin.id, bin]));
    list.append(...route.stops.map(bin => element('li', bin.name + ' · ' + percentage(readings.get(bin.id) ?? bin))));
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

function advanceRoute(id, legs) {
  const route = state.route;
  if (!route || route.legs !== legs || !route.stops.some(stop => stop.id === id)) return;
  route.collected.add(id);
  const next = route.stops.findIndex(stop => !route.collected.has(stop.id));
  if (next === 0) return;

  state.truck = route.stops[next < 0 ? route.stops.length - 1 : next - 1];
  if (next < 0) {
    clearRoute(true);
    return;
  }
  const remainingLegs = legs.slice(route.offset + next);
  const coordinates = [];
  for (const leg of remainingLegs) {
    for (const step of leg.steps) {
      for (const point of step.geometry.coordinates) {
        const previous = coordinates.at(-1);
        if (previous?.[0] !== point[0] || previous?.[1] !== point[1]) coordinates.push(point);
      }
    }
  }
  state.route = {
    ...route,
    stops: route.stops.slice(next),
    offset: route.offset + next,
    geometry: coordinates.length > 1 ? { type: 'LineString', coordinates } : null,
    distance: remainingLegs.reduce((sum, leg) => sum + leg.distance, 0),
    duration: remainingLegs.reduce((sum, leg) => sum + leg.duration, 0),
  };
}

async function update(bin, changes, confirmation) {
  const legs = state.route?.legs;
  $('assigned').disabled = true;
  $('details').querySelector('button').disabled = true;
  if (changes.collect) collecting += 1;
  try {
    await request(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: bin.id, ...changes }) });
    if (changes.collect) advanceRoute(bin.id, legs);
    await loadData();
    message(confirmation);
  } catch (error) {
    message(error.message);
  } finally {
    if (changes.collect) collecting -= 1;
    render();
  }
}

function tab(showMap) {
  $('showMap').setAttribute('aria-pressed', showMap);
  $('showAlerts').setAttribute('aria-pressed', !showMap);
  if (showMap) requestAnimationFrame(() => map?.invalidateSize());
}

$('showMap').onclick = () => tab(true);
$('showAlerts').onclick = () => {
  tab(false);
  $('alerts').scrollIntoView({ block: 'nearest' });
  $('alerts').querySelector('button')?.focus({ preventScroll: true });
};
function clearRoute(keepTruck = false) {
  state.routing?.abort();
  state.routing = null;
  state.route = null;
  if (!keepTruck) state.truck = null;
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

function stopOrders(bins, durations) {
  const stops = bins.map((_, index) => ({ index: index + 1, bit: 1n << BigInt(index) }));
  let paths = [{ order: [], last: 0, visited: 0n, duration: 0 }];

  // Keep the best prefix for each visited set and endpoint. Limit the search for larger fleets.
  for (let depth = 0; depth < stops.length; depth += 1) {
    const next = new Map();
    for (const path of paths) {
      for (const { index, bit } of stops) {
        const travel = durations[path.last]?.[index];
        if ((path.visited & bit) || !Number.isFinite(travel)) continue;
        const visited = path.visited | bit;
        const key = visited + '/' + index;
        const duration = path.duration + travel;
        if (!next.has(key) || duration < next.get(key).duration) {
          next.set(key, { order: [...path.order, index], last: index, visited, duration });
        }
      }
    }
    paths = [...next.values()].sort((a, b) => a.duration - b.duration);
    if (stops.length > 11) paths = paths.slice(0, 256);
  }

  if (!paths.length) throw new Error('No se encontró un orden con acceso vehicular a todas las paradas.');
  return paths.slice(0, 3).map(path => path.order.map(index => bins[index - 1]));
}

function routeConflicts(coordinates) {
  const edges = new Set();
  let repeated = 0;
  const segments = [];
  const visits = new Map();
  for (let i = 1; i < coordinates.length - 1; i += 1) {
    const [x, y] = coordinates[i];
    const key = coordinates[i].join(',');
    const angles = [coordinates[i - 1], coordinates[i + 1]]
      .map(([otherX, otherY]) => Math.atan2(otherY - y, otherX - x));
    if (!visits.has(key)) visits.set(key, []);
    visits.get(key).push(angles);
  }
  for (let i = 1; i < coordinates.length; i += 1) {
    const a = coordinates[i - 1];
    const b = coordinates[i];
    const endpoints = [a.join(','), b.join(',')].sort();
    if (endpoints[0] === endpoints[1]) continue;
    const key = endpoints.join('/');
    if (edges.has(key)) {
      repeated += L.latLng(a[1], a[0]).distanceTo([b[1], b[0]]);
      continue;
    }
    edges.add(key);
    segments.push({ a, b, left: Math.min(a[0], b[0]), right: Math.max(a[0], b[0]) });
  }
  segments.sort((a, b) => a.left - b.left);
  const side = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  let crossings = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const first = segments[i];
    for (let j = i + 1; j < segments.length && segments[j].left <= first.right; j += 1) {
      const second = segments[j];
      if (side(first.a, first.b, second.a) * side(first.a, first.b, second.b) < 0
        && side(second.a, second.b, first.a) * side(second.a, second.b, first.b) < 0) crossings += 1;
    }
  }
  for (const junction of visits.values()) {
    for (let i = 0; i < junction.length; i += 1) {
      for (let j = i + 1; j < junction.length; j += 1) {
        const rays = [...junction[i], ...junction[j]].sort((a, b) => a - b);
        if (new Set(rays).size === 4 && junction[i].includes(rays[0]) === junction[i].includes(rays[2])) {
          crossings += 1;
        }
      }
    }
  }
  return { crossings, repeated };
}

async function bestStreetRoute(base, orders, options, signal) {
  const fetchRoute = async stops => {
    const { routes } = await osrm('route', [base, ...stops], options, signal);
    const route = routes?.[0];
    if (!route?.geometry?.coordinates?.length || route.legs?.length !== stops.length
      || route.legs.some(leg => !leg.steps?.length)) {
      throw new Error('OSRM no devolvió el trazado de todas las paradas.');
    }
    return { ...route, stops, ...routeConflicts(route.geometry.coordinates) };
  };
  let primary;
  let routeError;
  const remaining = [...orders];
  while (!primary && remaining.length && !signal.aborted) {
    try {
      primary = await fetchRoute(remaining.shift());
    } catch (error) {
      routeError = error;
    }
  }
  if (!primary) throw routeError ?? new DOMException('Ruta cancelada', 'AbortError');
  if ((!primary.crossings && !primary.repeated) || !remaining.length) return primary;
  const alternatives = await Promise.allSettled(remaining.map(fetchRoute));
  const routes = [primary, ...alternatives.filter(result => result.status === 'fulfilled').map(result => result.value)];
  return routes.sort((a, b) => a.crossings - b.crossings || a.repeated - b.repeated || a.duration - b.duration)[0];
}

$('routeButton').onclick = async () => {
  clearRoute();
  tab(true);
  const base = state.base;
  const candidates = state.bins.filter(bin => status(bin) === 'full' && (!state.unit || bin.unit === state.unit));
  const pending = candidates.filter(located);
  const omitted = candidates.filter(bin => !located(bin));
  if (!located(base) || !pending.length) {
    state.routeError = !located(base) ? 'Configura las coordenadas de la base en PostgreSQL.'
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
    const { durations } = await osrm('table', [base, ...pending],
      new URLSearchParams({ ...options, annotations: 'duration' }), controller.signal);
    const route = await bestStreetRoute(base, stopOrders(pending, durations),
      new URLSearchParams({ ...options, overview: 'full', geometries: 'geojson', steps: 'true' }), controller.signal);
    if (state.routing !== controller) return;
    state.route = { ...route, omitted, collected: new Set(), offset: 0 };
    state.truck = base;
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
  $('mode').textContent = '';
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