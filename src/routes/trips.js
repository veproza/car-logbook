import { Router } from 'express';
import { db } from '../db.js';
import { listTrips, getTrip, setTripTags } from '../models/trips.js';
import { evaluateAutoTrips } from '../autoTrips.js';

export const trips = Router();

const parseTagIds = (v) =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
    .map((x) => Number(x))
    .filter(Number.isFinite);

trips.get('/', (req, res) => {
  res.json(listTrips({
    from: req.query.from,
    to: req.query.to,
    tagIds: req.query.tags ? parseTagIds(req.query.tags) : undefined,
  }));
});

trips.get('/:id', (req, res) => {
  const trip = getTrip(req.params.id);
  if (!trip) return res.status(404).json({ error: 'trip not found' });
  res.json(trip);
});

// Manually create a trip from two existing checkpoints.
trips.post('/', (req, res) => {
  const b = req.body || {};
  const start = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(b.start_checkpoint_id);
  const end = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(b.end_checkpoint_id);
  if (!start || !end) return res.status(400).json({ error: 'valid start_checkpoint_id and end_checkpoint_id are required' });
  if (Date.parse(end.time) < Date.parse(start.time)) {
    return res.status(400).json({ error: 'end checkpoint must not be before start checkpoint' });
  }
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO trips (start_checkpoint_id, end_checkpoint_id, note, auto_generated)
    VALUES (?, ?, ?, 0)
  `).run(start.id, end.id, b.note || null);
  setTripTags(lastInsertRowid, parseTagIds(b.tag_ids));
  res.status(201).json(getTrip(lastInsertRowid));
});

// Update note and/or tags.
trips.put('/:id', (req, res) => {
  const trip = getTrip(req.params.id);
  if (!trip) return res.status(404).json({ error: 'trip not found' });
  if (req.body.note !== undefined) {
    db.prepare('UPDATE trips SET note = ? WHERE id = ?').run(req.body.note || null, trip.id);
  }
  if (req.body.tag_ids !== undefined) setTripTags(trip.id, parseTagIds(req.body.tag_ids));
  res.json(getTrip(trip.id));
});

trips.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'trip not found' });
  res.status(204).end();
});

// Force a re-evaluation of place-driven auto trips.
trips.post('/evaluate', (_req, res) => {
  res.json({ tripsCreated: evaluateAutoTrips() });
});

// Merge several trips into one spanning from the earliest start checkpoint to the
// latest end checkpoint. Tags are unioned, notes joined, and the originals removed.
trips.post('/merge', (req, res) => {
  const ids = parseTagIds(req.body?.trip_ids);
  const selected = [...new Set(ids)].map((id) => getTrip(id)).filter(Boolean);
  if (selected.length < 2) {
    return res.status(400).json({ error: 'select at least two existing trips to merge' });
  }

  const startCp = selected.reduce((a, b) => (a.start_time <= b.start_time ? a : b)).start_checkpoint_id;
  const endCp = selected.reduce((a, b) => (a.end_time >= b.end_time ? a : b)).end_checkpoint_id;
  const tagIds = [...new Set(selected.flatMap((t) => t.tags.map((g) => g.id)))];
  const note = selected.map((t) => t.note).filter(Boolean).join(' / ') || null;

  const mergedId = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO trips (start_checkpoint_id, end_checkpoint_id, note, auto_generated) VALUES (?, ?, ?, 0)')
      .run(startCp, endCp, note);
    setTripTags(lastInsertRowid, tagIds);
    const del = db.prepare('DELETE FROM trips WHERE id = ?');
    for (const t of selected) del.run(t.id);
    return lastInsertRowid;
  })();

  res.status(201).json(getTrip(mergedId));
});
