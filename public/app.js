// ---------- tiny helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) node.append(k?.nodeType ? k : document.createTextNode(k ?? ''));
  return node;
};

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show ${isError ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 2600);
}

// Show a failure toast including the HTTP status code when available.
function toastError(err, prefix = 'Error') {
  const code = err?.status ? ` (${err.status})` : '';
  toast(`${prefix}${code}: ${err?.message || 'unknown error'}`, true);
}

// Run an async action and surface any failure as an error toast.
async function runAction(fn, prefix = 'Action failed') {
  try { await fn(); }
  catch (err) { toastError(err, prefix); }
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const km = (n) => `${(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
const coord = (v) => Number(v).toFixed(4); // display lat/lng to 4 decimal places
const toIso = (localValue) => (localValue ? new Date(localValue).toISOString() : undefined);

// Material Web button factory.
function button(label, { variant = 'filled', icon, danger, onclick, type = 'button' } = {}) {
  const tag = variant === 'text' ? 'md-text-button' : variant === 'outlined' ? 'md-outlined-button' : 'md-filled-button';
  const b = el(tag, { type });
  if (icon) b.append(el('md-icon', { slot: 'icon' }, icon));
  b.append(label);
  if (danger) b.style.setProperty('--md-text-button-label-text-color', 'var(--md-sys-color-error)');
  if (onclick) b.onclick = onclick;
  return b;
}

function dataTable(headers, rows) {
  const table = el('table');
  table.append(el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))));
  table.append(el('tbody', {}, ...rows));
  return el('div', { className: 'table-wrap' }, table);
}

// ---------- map popup (Leaflet + OpenStreetMap) ----------
// A single shared map instance, re-centered per location. Hovering a map button
// previews it; clicking pins it so it can be panned/zoomed until closed.
const MapPopup = (() => {
  let root, mapDiv, titleEl, map, marker, pinned = false, hideTimer;

  function ensure() {
    if (root) return;
    root = el('div', { id: 'map-popup' });
    titleEl = el('span', { className: 'map-popup-title' });
    const close = el('md-icon-button', { className: 'map-popup-close' });
    close.append(el('md-icon', {}, 'close'));
    close.onclick = hide;
    root.append(el('div', { className: 'map-popup-header' }, titleEl, close));
    mapDiv = el('div', { className: 'map-popup-map' });
    root.append(mapDiv, el('div', { className: 'map-popup-hint muted' }, 'Click the button to pin · scroll to zoom'));
    document.body.append(root);

    map = L.map(mapDiv, { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    root.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    root.addEventListener('mouseleave', () => { if (!pinned) hideTimer = setTimeout(hide, 150); });
    document.addEventListener('click', (e) => {
      if (pinned && !root.contains(e.target) && !e.target.closest?.('.map-btn')) hide();
    });
  }

  function position(anchor) {
    const r = anchor.getBoundingClientRect();
    const w = 320, h = 290, m = 8;
    let left = r.right + m;
    if (left + w > window.innerWidth) left = Math.max(m, r.left - w - m);
    let top = Math.min(r.top, window.innerHeight - h - m);
    root.style.left = `${Math.max(m, left)}px`;
    root.style.top = `${Math.max(m, top)}px`;
  }

  function render(lat, lng, label, anchor) {
    ensure();
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    titleEl.textContent = label;
    position(anchor);
    root.classList.add('show');
    const ll = [lat, lng];
    map.setView(ll, 16);
    marker ? marker.setLatLng(ll) : (marker = L.marker(ll).addTo(map));
    requestAnimationFrame(() => map.invalidateSize());
  }

  function hide() {
    pinned = false;
    root?.classList.remove('show', 'pinned');
  }

  return {
    preview(lat, lng, label, anchor) {
      if (pinned) return;
      clearTimeout(hideTimer);
      render(lat, lng, label, anchor);
    },
    hideIfPreview() {
      if (!pinned) hideTimer = setTimeout(hide, 150);
    },
    pin(lat, lng, label, anchor) {
      pinned = true;
      clearTimeout(hideTimer);
      render(lat, lng, label, anchor);
      root.classList.add('pinned');
    },
  };
})();

// An icon button that previews a location on hover and pins it on click.
function mapButton(lat, lng, label) {
  lat = Number(lat); lng = Number(lng);
  const btn = el('md-icon-button', { className: 'map-btn', title: `Show ${label} on map` });
  btn.append(el('md-icon', {}, 'place'));
  btn.addEventListener('mouseenter', () => MapPopup.preview(lat, lng, label, btn));
  btn.addEventListener('mouseleave', () => MapPopup.hideIfPreview());
  btn.addEventListener('click', () => MapPopup.pin(lat, lng, label, btn));
  return btn;
}

// ---------- shared tag state ----------
let TAGS = [];

async function loadTags() {
  TAGS = await api('/tags');
}

// Renders selectable tag chips into a container; tracks selection in `selected` (a Set of ids).
function renderTagSelector(container, selected) {
  container.innerHTML = '';
  if (TAGS.length === 0) container.append(el('span', { className: 'muted' }, 'no tags yet'));
  for (const tag of TAGS) {
    const chip = el('span', { className: 'chip' + (selected.has(tag.id) ? ' selected' : '') });
    chip.append(el('span', { className: 'dot', style: `background:${tag.color || '#64748b'}` }), tag.name);
    chip.onclick = () => {
      selected.has(tag.id) ? selected.delete(tag.id) : selected.add(tag.id);
      chip.classList.toggle('selected');
    };
    container.append(chip);
  }
}

// A pill naming a matched place at a trip endpoint (departure / destination).
function placePill(name, icon) {
  return el('span', { className: 'place-pill' }, el('md-icon', { className: 'pill-icon' }, icon), name);
}

function tagBadges(tags) {
  const wrap = el('span', { className: 'row-tags' });
  for (const tag of tags) wrap.append(el('span', { className: 'badge', style: `background:${tag.color || '#94a3b8'}` }, tag.name));
  return wrap;
}

// ---------- tabs ----------
const TAB_LOADERS = {};
const PANEL_IDS = ['report', 'trips', 'checkpoints', 'places', 'tags'];
const tabsEl = $('#tabs');
tabsEl.addEventListener('change', () => {
  const id = PANEL_IDS[tabsEl.activeTabIndex ?? 0];
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  $(`#${id}`).classList.add('active');
  TAB_LOADERS[id]?.();
});

// ---------- TAGS ----------
TAB_LOADERS.tags = renderTags;
async function renderTags() {
  await loadTags();
  const list = $('#tags-list');
  list.innerHTML = '';
  if (!TAGS.length) { list.append(el('p', { className: 'muted' }, 'No tags yet.')); return; }
  const rows = TAGS.map((tag) => {
    const del = button('Delete', { variant: 'text', icon: 'delete', danger: true, onclick: () => runAction(async () => {
      await api(`/tags/${tag.id}`, { method: 'DELETE' }); toast('Tag deleted'); renderTags();
    }, 'Delete failed') });
    return el('tr', {}, el('td', {}, tagBadges([tag])), el('td', { className: 'muted' }, tag.color || '—'), el('td', {}, del));
  });
  list.append(dataTable(['Name', 'Color', ''], rows));
}

$('#tag-create').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/tags', { method: 'POST', body: { name: f.name.value, color: f.color.value } });
    f.reset(); f.color.value = '#3b82f6';
    toast('Tag added');
    renderTags();
  } catch (err) { toastError(err, 'Save failed'); }
};

// ---------- CHECKPOINTS ----------
let pendingTripStart = null; // a checkpoint chosen as the start of a new trip
TAB_LOADERS.checkpoints = renderCheckpoints;
async function renderCheckpoints() {
  const [rows, trips] = await Promise.all([api('/checkpoints'), api('/trips')]);
  const list = $('#checkpoints-list');
  list.innerHTML = '';
  // A pending start may have been deleted/consumed; drop it if it's gone.
  if (pendingTripStart && !rows.some((c) => c.id === pendingTripStart.id)) pendingTripStart = null;
  if (!rows.length) { list.append(el('p', { className: 'muted' }, 'No checkpoints yet.')); return; }

  if (pendingTripStart) {
    const cancel = button('Cancel', { variant: 'text', icon: 'close', onclick: () => { pendingTripStart = null; renderCheckpoints(); } });
    list.append(el('div', { className: 'trip-banner' },
      el('md-icon', {}, 'route'),
      el('span', {}, `Trip start set at ${fmtDate(pendingTripStart.time)} — pick a later checkpoint's "End trip".`),
      cancel));
  }

  const { laneCount, cover } = buildTripCoverage(rows, trips);

  const trs = rows.map((c, i) => {
    const del = button('Delete', { variant: 'text', icon: 'delete', danger: true, onclick: () => runAction(async () => {
      await api(`/checkpoints/${c.id}`, { method: 'DELETE' }); toast('Checkpoint deleted'); renderCheckpoints();
    }, 'Delete failed') });
    const actions = el('span', { className: 'cell-actions' });
    const trip = tripControl(c);
    if (trip) actions.append(trip);
    actions.append(mapButton(c.latitude, c.longitude, `Checkpoint #${c.id}`), del);
    return el('tr', { className: pendingTripStart?.id === c.id ? 'pending-start' : '' },
      gutterCell(i, laneCount, cover),
      el('td', {}, fmtDate(c.time)),
      el('td', {}, coord(c.latitude)),
      el('td', {}, coord(c.longitude)),
      el('td', {}, km(c.mileage)),
      el('td', {}, c.place ? placePill(c.place.name, 'place') : el('span', { className: 'muted' }, '—')),
      el('td', {}, actions),
    );
  });
  list.append(dataTable(['', 'Time', 'Latitude', 'Longitude', 'Mileage', 'Place', ''], trs));
}

// Stable, well-spaced color per trip id (golden-angle hues).
const colorForTrip = (id) => `hsl(${Math.round((id * 137.508) % 360)} 65% 60%)`;

// Assigns each trip to a lane (parallel column) so trips that share a boundary
// checkpoint or overlap in time get separate vertical lines, and returns the
// covered row span (top = latest/end row, bot = earliest/start row) per trip.
// `rows` is the checkpoint list ordered newest-first.
function buildTripCoverage(rows, trips) {
  const sorted = [...trips].sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id - b.id);
  const laneTrips = []; // laneTrips[k] = trips already placed in lane k
  for (const t of sorted) {
    let lane = 0;
    while (laneTrips[lane] &&
           laneTrips[lane].some((o) => t.start_time <= o.end_time && o.start_time <= t.end_time)) {
      lane++;
    }
    (laneTrips[lane] ||= []).push(t);
    t._lane = lane;
  }
  const cover = [];
  for (const t of sorted) {
    let top = -1, bot = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].time >= t.start_time && rows[i].time <= t.end_time) { if (top < 0) top = i; bot = i; }
    }
    if (top >= 0) cover.push({ top, bot, lane: t._lane, color: colorForTrip(t.id), id: t.id, note: t.note });
  }
  return { laneCount: laneTrips.length, cover };
}

// Builds the leading gutter cell for row `i`: one vertical line segment per lane
// whose trip covers this checkpoint, with a node dot at the trip's start/end row.
function gutterCell(i, laneCount, cover) {
  const lanes = el('div', { className: 'cp-lanes' });
  for (let l = 0; l < laneCount; l++) {
    const lane = el('div', { className: 'cp-lane' });
    const seg = cover.find((c) => c.lane === l && i >= c.top && i <= c.bot);
    if (seg) {
      const isTop = i === seg.top, isBot = i === seg.bot;
      const variant = isTop && isBot ? 'cp-seg-dot' : isTop ? 'cp-seg-top' : isBot ? 'cp-seg-bot' : 'cp-seg-full';
      const bar = el('div', { className: `cp-seg ${variant}`, title: `Trip #${seg.id}${seg.note ? ': ' + seg.note : ''}` });
      bar.style.setProperty('--c', seg.color);
      lane.append(bar);
      if (isTop || isBot) {
        const dot = el('div', { className: 'cp-node' });
        dot.style.setProperty('--c', seg.color);
        lane.append(dot);
      }
    }
    lanes.append(lane);
  }
  return el('td', { className: 'cp-gutter' }, lanes);
}

// The contextual trip button for a checkpoint row (only on selectable checkpoints):
// "Start trip" when idle, "End trip" once a start is pending and this row is later.
function tripControl(c) {
  if (!c.selectable) return null;
  if (!pendingTripStart) {
    return button('Start trip', { variant: 'text', icon: 'trip_origin', onclick: () => { pendingTripStart = c; renderCheckpoints(); } });
  }
  if (pendingTripStart.id === c.id) {
    return el('span', { className: 'chip selected' }, el('md-icon', { className: 'chip-icon' }, 'trip_origin'), 'Trip start');
  }
  if (c.time > pendingTripStart.time) {
    return button('End trip', { variant: 'text', icon: 'sports_score', onclick: () => runAction(async () => {
      await api('/trips', { method: 'POST', body: { start_checkpoint_id: pendingTripStart.id, end_checkpoint_id: c.id } });
      toast('Trip created');
      pendingTripStart = null;
      renderCheckpoints();
    }, 'Trip creation failed') });
  }
  return null; // earlier than the pending start — can't be an end
}

$('#checkpoint-create').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('/checkpoints', {
      method: 'POST',
      body: {
        time: toIso(f.time.value),
        latitude: f.latitude.value,
        longitude: f.longitude.value,
        mileage: f.mileage.value,
      },
    });
    f.reset();
    toast(r.tripsCreated ? `Checkpoint added · ${r.tripsCreated} trip(s) generated` : 'Checkpoint added');
    renderCheckpoints();
  } catch (err) { toastError(err, 'Save failed'); }
};

$('#prune-btn').addEventListener('click', () => runAction(async () => {
  if (!confirm('Remove checkpoints with <10 m movement and no odometer change since the previous one?\nTrip start/end checkpoints are kept.')) return;
  const r = await api('/checkpoints/prune', { method: 'POST' });
  toast(r.pruned ? `Pruned ${r.pruned} · ${r.remaining} remaining` : 'Nothing to prune');
  renderCheckpoints();
}, 'Prune failed'));

// Load a chosen file into the textarea for review before importing.
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) $('#import-text').value = await file.text();
});

$('#import-btn').addEventListener('click', () => runAction(async () => {
  const tsv = $('#import-text').value;
  if (!tsv.trim()) { toast('Paste TSV or choose a file first', true); return; }
  const r = await api('/checkpoints/bulk', { method: 'POST', body: { tsv } });
  const parts = [`Imported ${r.imported}`];
  if (r.skipped) parts.push(`skipped ${r.skipped}`);
  if (r.tripsCreated) parts.push(`${r.tripsCreated} trip(s) generated`);
  toast(parts.join(' · '));
  renderImportResult(r);
  renderCheckpoints();
}, 'Import failed'));

function renderImportResult(r) {
  const box = $('#import-result');
  box.innerHTML = '';
  box.append(el('p', { className: 'muted' },
    `Imported ${r.imported} · skipped ${r.skipped}${r.tripsCreated ? ` · ${r.tripsCreated} trip(s) generated` : ''}`));
  if (!r.errors?.length) return;
  const list = el('ul', { className: 'import-errors' });
  for (const e of r.errors) list.append(el('li', {}, `line ${e.line}: ${e.reason}`));
  box.append(list);
}

// ---------- PLACES ----------
const placeCreateTags = new Set();
TAB_LOADERS.places = renderPlaces;
async function renderPlaces() {
  await loadTags();
  renderTagSelector($('#place-create-tags'), placeCreateTags);
  const places = await api('/places');
  const list = $('#places-list');
  list.innerHTML = '';
  if (!places.length) { list.append(el('p', { className: 'muted' }, 'No places yet.')); return; }
  const cards = el('div', { className: 'cards' });
  for (const p of places) {
    const del = button('Delete', { variant: 'text', icon: 'delete', danger: true, onclick: () => runAction(async () => {
      await api(`/places/${p.id}`, { method: 'DELETE' }); toast('Place deleted'); renderPlaces();
    }, 'Delete failed') });
    cards.append(el('div', { className: 'card' },
      el('h3', {}, p.name),
      el('div', { className: 'meta' }, `${p.latitude}, ${p.longitude} · r=${p.radius} m`),
      el('div', { className: 'meta' }, `Dwell: ${Math.round(p.duration / 60)} min`),
      el('div', { className: 'meta' }, p.inherit_last_trip_tags ? '↻ inherits previous trip tags' : 'uses own tags'),
      el('div', { style: 'margin-top:.6rem' }, tagBadges(p.tags)),
      el('div', { className: 'actions' }, mapButton(p.latitude, p.longitude, p.name), del),
    ));
  }
  list.append(cards);
}

$('#place-create').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/places', {
      method: 'POST',
      body: {
        name: f.name.value,
        latitude: f.latitude.value,
        longitude: f.longitude.value,
        radius: f.radius.value,
        duration: Number(f.duration_min.value) * 60,
        inherit_last_trip_tags: f.inherit_last_trip_tags.checked,
        tag_ids: [...placeCreateTags],
      },
    });
    f.reset(); placeCreateTags.clear();
    toast('Place added');
    renderPlaces();
  } catch (err) { toastError(err, 'Save failed'); }
};

// ---------- TRIPS ----------
const tripFilterTags = new Set();
const tripCreateTags = new Set();
const selectedTrips = new Set(); // trip ids checked for merging
TAB_LOADERS.trips = renderTripsTab;

// Show the Merge button (with a count) once two or more trips are selected.
function updateMergeBar() {
  const btn = $('#merge-btn');
  btn.style.display = selectedTrips.size >= 2 ? '' : 'none';
  $('#merge-count').textContent = selectedTrips.size >= 2 ? ` (${selectedTrips.size})` : '';
}

$('#merge-btn').onclick = () => runAction(async () => {
  const ids = [...selectedTrips];
  if (ids.length < 2) return;
  const merged = await api('/trips/merge', { method: 'POST', body: { trip_ids: ids } });
  toast(`Merged ${ids.length} trips into #${merged.id}`);
  selectedTrips.clear();
  renderTrips();
}, 'Merge failed');

async function renderTripsTab() {
  await loadTags();
  renderTagSelector($('#trip-tag-filter'), tripFilterTags);
  renderTagSelector($('#trip-create-tags'), tripCreateTags);
  await populateCheckpointSelects();
  await renderTrips();
}

async function populateCheckpointSelects() {
  const rows = await api('/checkpoints');
  for (const name of ['start_checkpoint_id', 'end_checkpoint_id']) {
    const sel = $(`#trip-create [name="${name}"]`);
    sel.innerHTML = '';
    for (const c of rows) {
      sel.append(el('md-select-option', { value: String(c.id) },
        el('div', { slot: 'headline' }, `#${c.id} · ${fmtDate(c.time)} · ${km(c.mileage)}`)));
    }
  }
}

async function renderTrips() {
  const f = $('#trip-filters');
  const params = new URLSearchParams();
  if (f.from.value) params.set('from', toIso(f.from.value));
  if (f.to.value) params.set('to', toIso(f.to.value + 'T23:59:59'));
  if (tripFilterTags.size) params.set('tags', [...tripFilterTags].join(','));
  const trips = await api(`/trips?${params}`);

  // Drop selections that are no longer visible (e.g. filtered out), then refresh the bar.
  const visible = new Set(trips.map((t) => t.id));
  for (const id of [...selectedTrips]) if (!visible.has(id)) selectedTrips.delete(id);
  updateMergeBar();

  const list = $('#trips-list');
  list.innerHTML = '';
  if (!trips.length) { list.append(el('p', { className: 'muted' }, 'No trips match.')); return; }

  const rows = trips.map((t) => {
    const cb = el('md-checkbox', { checked: selectedTrips.has(t.id), 'aria-label': `Select trip #${t.id}` });
    cb.addEventListener('change', () => {
      cb.checked ? selectedTrips.add(t.id) : selectedTrips.delete(t.id);
      updateMergeBar();
    });
    // Row 1: times (each with a map button). Row 2: place context + auto pill.
    const timesRow = el('div', { className: 'when-times' },
      fmtDate(t.start_time), mapButton(t.start_latitude, t.start_longitude, `Trip #${t.id} · start`),
      el('span', { className: 'arrow' }, '→'),
      fmtDate(t.end_time), mapButton(t.end_latitude, t.end_longitude, `Trip #${t.id} · end`),
    );
    const locRow = el('div', { className: 'when-loc' });
    if (t.start_place) locRow.append(placePill(t.start_place.name, 'trip_origin'));
    if (t.start_place && t.end_place) locRow.append(el('span', { className: 'arrow' }, '→'));
    if (t.end_place) locRow.append(placePill(t.end_place.name, 'place'));
    if (t.auto_generated) locRow.append(el('span', { className: 'auto-badge' }, el('md-icon', {}, 'bolt'), 'auto'));
    if (!locRow.childNodes.length) locRow.append(el('span', { className: 'muted' }, '—'));
    const when = el('td', { className: 'trip-when' }, timesRow, locRow);

    const editTags = button('Edit tags', { variant: 'text', icon: 'edit', onclick: () => openTagEditor(t) });
    const tagsCell = el('td', {}, tagBadges(t.tags), ' ', editTags);

    const noteInput = el('input', { className: 'inline', value: t.note || '', placeholder: '—' });
    noteInput.onchange = (ev) => runAction(async () => {
      await api(`/trips/${t.id}`, { method: 'PUT', body: { note: ev.target.value } });
      toast('Note saved');
    }, 'Save failed');

    const del = button('Delete', { variant: 'text', icon: 'delete', danger: true, onclick: () => runAction(async () => {
      await api(`/trips/${t.id}`, { method: 'DELETE' }); toast('Trip deleted'); renderTrips();
    }, 'Delete failed') });

    return el('tr', {}, el('td', {}, cb), when, el('td', {}, km(t.distance)), tagsCell, el('td', {}, noteInput), el('td', {}, del));
  });
  list.append(dataTable(['', 'When', 'Distance', 'Tags', 'Note', ''], rows));
}

// Inline tag editor card prepended above the trips table.
async function openTagEditor(trip) {
  const selected = new Set(trip.tags.map((t) => t.id));
  const box = el('div', { className: 'tag-filter', style: 'margin:.6rem 0' });
  renderTagSelector(box, selected);
  const save = button('Save tags', { icon: 'save', onclick: () => runAction(async () => {
    await api(`/trips/${trip.id}`, { method: 'PUT', body: { tag_ids: [...selected] } });
    toast('Tags updated');
    renderTrips();
  }, 'Save failed') });
  const dialog = el('div', { className: 'card', style: 'margin-bottom:1rem' },
    el('strong', {}, `Tags for trip #${trip.id}`), box, save);
  $('#trips-list').prepend(dialog);
}

$('#trip-filters').onsubmit = (e) => { e.preventDefault(); renderTrips(); };
$('#evaluate-btn').onclick = () => runAction(async () => {
  const r = await api('/trips/evaluate', { method: 'POST' });
  toast(r.tripsCreated ? `${r.tripsCreated} trip(s) generated` : 'No new trips');
  renderTrips();
}, 'Evaluation failed');

$('#trip-create').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/trips', {
      method: 'POST',
      body: {
        start_checkpoint_id: Number(f.start_checkpoint_id.value),
        end_checkpoint_id: Number(f.end_checkpoint_id.value),
        note: f.note.value,
        tag_ids: [...tripCreateTags],
      },
    });
    f.note.value = ''; tripCreateTags.clear(); renderTagSelector($('#trip-create-tags'), tripCreateTags);
    toast('Trip created');
    renderTrips();
  } catch (err) { toastError(err, 'Save failed'); }
};

// ---------- REPORT ----------
const reportFilterTags = new Set();
TAB_LOADERS.report = renderReportTab;

async function renderReportTab() {
  await loadTags();
  renderTagSelector($('#report-tag-filter'), reportFilterTags);
  await runReport();
}

async function runReport() {
  const f = $('#report-filters');
  const params = new URLSearchParams();
  if (f.from.value) params.set('from', toIso(f.from.value));
  if (f.to.value) params.set('to', toIso(f.to.value + 'T23:59:59'));
  if (reportFilterTags.size) params.set('tags', [...reportFilterTags].join(','));
  const r = await api(`/reports/summary?${params}`);

  const out = $('#report-output');
  out.innerHTML = '';

  const stats = el('div', { className: 'report-summary' });
  stats.append(
    statCard(km(r.totalDistance), 'Total distance'),
    statCard(String(r.totalTrips), 'Trips'),
    statCard(km(r.untaggedDistance), 'Untagged'),
  );
  out.append(stats);

  if (!r.byTag.length) { out.append(el('p', { className: 'muted' }, 'No tagged trips in range.')); return; }
  const rows = r.byTag.map((row) => el('tr', {},
    el('td', {}, tagBadges([row.tag])),
    el('td', {}, String(row.trips)),
    el('td', {}, km(row.distance)),
  ));
  out.append(dataTable(['Tag', 'Trips', 'Distance'], rows));
}

const statCard = (value, label) => el('div', { className: 'stat' }, el('div', { className: 'value' }, value), el('div', { className: 'label' }, label));

$('#report-filters').onsubmit = (e) => { e.preventDefault(); runReport(); };

// ---------- boot ----------
renderReportTab();
