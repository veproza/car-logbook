import { Router } from 'express';
import { db } from '../db.js';
import { evaluateAutoTrips } from '../autoTrips.js';
import { isWithin } from '../util/geo.js';

export const checkpoints = Router();

const insertStmt = db.prepare(`
  INSERT INTO checkpoints (time, latitude, longitude, mileage, metadata)
  VALUES (@time, @latitude, @longitude, @mileage, @metadata)
`);

// List checkpoints, newest first, with optional from/to time filters.
checkpoints.get('/', (req, res) => {
  const { from, to } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('time >= ?'); params.push(from); }
  if (to) { where.push('time <= ?'); params.push(to); }
  const sql = `SELECT * FROM checkpoints ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY time DESC, id DESC`;
  res.json(annotateCheckpoints(db.prepare(sql).all(...params).map(decode)));
});

// Annotates each checkpoint with:
//  - `place`: the first Place whose geofence contains it ({ id, name } or null);
//  - `selectable`: eligible for manual trip building unless it lies strictly inside
//    an existing trip's span. The trips' own start/end checkpoints stay eligible so
//    trips can be chained end-to-start.
function annotateCheckpoints(rows) {
  const trips = db.prepare(`
    SELECT t.start_checkpoint_id AS s, t.end_checkpoint_id AS e, sc.time AS st, ec.time AS et
    FROM trips t
    JOIN checkpoints sc ON sc.id = t.start_checkpoint_id
    JOIN checkpoints ec ON ec.id = t.end_checkpoint_id
  `).all();
  const boundary = new Set();
  for (const t of trips) { boundary.add(t.s); boundary.add(t.e); }
  const places = db.prepare('SELECT id, name, latitude, longitude, radius FROM places').all();
  return rows.map((c) => {
    const p = places.find((pl) => isWithin(pl, c.latitude, c.longitude));
    return {
      ...c,
      place: p ? { id: p.id, name: p.name } : null,
      selectable: boundary.has(c.id) || !trips.some((t) => c.time > t.st && c.time < t.et),
    };
  });
}

checkpoints.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'checkpoint not found' });
  res.json(decode(row));
});

// Ingest a checkpoint (the primary API). Accepts lat/lon aliases and optional
// metadata, then re-evaluates auto-generated trips.
checkpoints.post('/', (req, res) => {
  const b = req.body || {};
  const latitude = num(b.latitude ?? b.lat);
  const longitude = num(b.longitude ?? b.lon ?? b.lng);
  const mileage = num(b.mileage ?? b.odometer);
  const time = b.time ? new Date(b.time).toISOString() : new Date().toISOString();

  if (latitude == null || longitude == null || mileage == null) {
    return res.status(400).json({ error: 'latitude, longitude and mileage are required numbers' });
  }

  const metadata = b.metadata == null ? null : JSON.stringify(b.metadata);
  const { lastInsertRowid } = insertStmt.run({ time, latitude, longitude, mileage, metadata });

  const tripsCreated = evaluateAutoTrips();
  const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(lastInsertRowid);
  res.status(201).json({ checkpoint: decode(row), tripsCreated });
});

// Bulk-import checkpoints from pasted TSV text. Columns (tab-separated):
//   created  lat  lng  mileage  [battery]  [remaining range]
// Decimal commas (50,0904) and an optional header row are accepted. Rows
// missing a timestamp, latitude, longitude or mileage are skipped and reported.
checkpoints.post('/bulk', (req, res) => {
  const tsv = req.body?.tsv;
  if (typeof tsv !== 'string' || !tsv.trim()) {
    return res.status(400).json({ error: 'tsv text is required' });
  }

  const parsed = [];
  const errors = [];
  tsv.split(/\r?\n/).forEach((line, idx) => {
    if (!line.trim()) return;
    const cells = line.split('\t');
    const time = parseTimestamp(cells[0]);
    if (!time) {
      // A header / label line never has a timestamp in the first cell; skip it
      // silently. Anything else with an unparseable timestamp is a real error.
      if (!/lat|lng|lon|created|mileage|time|battery|range/i.test(line)) {
        errors.push({ line: idx + 1, reason: 'unparseable timestamp', raw: line.trim() });
      }
      return;
    }
    const latitude = parseEuroNumber(cells[1]);
    const longitude = parseEuroNumber(cells[2]);
    const mileage = parseEuroNumber(cells[3]);
    if (latitude == null || longitude == null || mileage == null) {
      errors.push({ line: idx + 1, reason: 'missing latitude, longitude or mileage', raw: line.trim() });
      return;
    }
    const metadata = {};
    const battery = parseEuroNumber(cells[4]);
    const range = parseEuroNumber(cells[5]);
    if (battery != null) metadata.battery = battery;
    if (range != null) metadata.remainingRange = range;
    parsed.push({
      time, latitude, longitude, mileage,
      metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    });
  });

  const insertMany = db.transaction((rows) => { for (const r of rows) insertStmt.run(r); });
  insertMany(parsed);
  const tripsCreated = parsed.length ? evaluateAutoTrips() : 0;
  res.status(201).json({ imported: parsed.length, skipped: errors.length, tripsCreated, errors });
});

checkpoints.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM checkpoints WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'checkpoint not found' });
  res.status(204).end();
});

function decode(row) {
  return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Parse a number that may use a decimal comma (e.g. "50,0904"); blank -> null.
function parseEuroNumber(v) {
  if (v == null) return null;
  const t = String(v).trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Parse "YYYY-MM-DD HH:MM:SS(.ffffff)?" (local time) into an ISO string.
function parseTimestamp(v) {
  const m = String(v ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = frac ? Number((frac + '000').slice(0, 3)) : 0;
  const date = new Date(+y, +mo - 1, +d, +h, +mi, +s, ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
