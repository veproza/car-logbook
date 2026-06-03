import { Router } from 'express';
import { db } from '../db.js';

export const places = Router();

const placeTagsStmt = db.prepare(`
  SELECT tg.id, tg.name, tg.color
  FROM place_tags pt JOIN tags tg ON tg.id = pt.tag_id
  WHERE pt.place_id = ? ORDER BY tg.name
`);
const clearTagsStmt = db.prepare('DELETE FROM place_tags WHERE place_id = ?');
const addTagStmt = db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');

const setTags = db.transaction((placeId, tagIds) => {
  clearTagsStmt.run(placeId);
  for (const id of tagIds || []) addTagStmt.run(placeId, id);
});

function hydrate(row) {
  return {
    ...row,
    inherit_last_trip_tags: !!row.inherit_last_trip_tags,
    tags: placeTagsStmt.all(row.id),
  };
}

places.get('/', (_req, res) => {
  res.json(db.prepare('SELECT * FROM places ORDER BY name').all().map(hydrate));
});

places.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'place not found' });
  res.json(hydrate(row));
});

places.post('/', (req, res) => {
  const b = req.body || {};
  const err = validate(b);
  if (err) return res.status(400).json({ error: err });
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO places (name, latitude, longitude, radius, duration, inherit_last_trip_tags)
    VALUES (@name, @latitude, @longitude, @radius, @duration, @inherit)
  `).run({
    name: b.name.trim(),
    latitude: Number(b.latitude),
    longitude: Number(b.longitude),
    radius: Number(b.radius),
    duration: Math.round(Number(b.duration)),
    inherit: b.inherit_last_trip_tags ? 1 : 0,
  });
  setTags(lastInsertRowid, b.tag_ids);
  res.status(201).json(hydrate(db.prepare('SELECT * FROM places WHERE id = ?').get(lastInsertRowid)));
});

places.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'place not found' });
  const b = { ...existing, ...req.body };
  const err = validate(b);
  if (err) return res.status(400).json({ error: err });
  db.prepare(`
    UPDATE places SET name=@name, latitude=@latitude, longitude=@longitude,
      radius=@radius, duration=@duration, inherit_last_trip_tags=@inherit WHERE id=@id
  `).run({
    id: existing.id,
    name: String(b.name).trim(),
    latitude: Number(b.latitude),
    longitude: Number(b.longitude),
    radius: Number(b.radius),
    duration: Math.round(Number(b.duration)),
    inherit: b.inherit_last_trip_tags ? 1 : 0,
  });
  if (req.body.tag_ids !== undefined) setTags(existing.id, req.body.tag_ids);
  res.json(hydrate(db.prepare('SELECT * FROM places WHERE id = ?').get(existing.id)));
});

places.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM places WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'place not found' });
  res.status(204).end();
});

function validate(b) {
  if (!b.name || !String(b.name).trim()) return 'name is required';
  for (const f of ['latitude', 'longitude', 'radius', 'duration']) {
    if (!Number.isFinite(Number(b[f]))) return `${f} must be a number`;
  }
  if (Number(b.radius) <= 0) return 'radius must be positive';
  if (Number(b.duration) <= 0) return 'duration must be positive';
  return null;
}
