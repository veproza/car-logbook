import { Router } from 'express';
import { db } from '../db.js';

export const tags = Router();

tags.get('/', (_req, res) => {
  res.json(db.prepare('SELECT * FROM tags ORDER BY name').all());
});

tags.post('/', (req, res) => {
  const name = (req.body?.name || '').trim();
  const color = req.body?.color || null;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').run(name, color);
    res.status(201).json(db.prepare('SELECT * FROM tags WHERE id = ?').get(lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'tag already exists' });
    throw e;
  }
});

tags.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'tag not found' });
  const name = (req.body?.name ?? existing.name).trim();
  const color = req.body?.color ?? existing.color;
  db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, req.params.id);
  res.json(db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id));
});

tags.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'tag not found' });
  res.status(204).end();
});
