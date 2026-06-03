import { Router } from 'express';
import { listTrips } from '../models/trips.js';

export const reports = Router();

const parseTagIds = (v) =>
  (typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : [])
    .map((x) => Number(x))
    .filter(Number.isFinite);

/**
 * Mileage summary for trips matching { from, to, tags }, broken down by tag.
 * A trip with multiple tags contributes its distance to each of its tags, so
 * per-tag distances may sum to more than the (de-duplicated) total.
 */
reports.get('/summary', (req, res) => {
  const trips = listTrips({
    from: req.query.from,
    to: req.query.to,
    tagIds: req.query.tags ? parseTagIds(req.query.tags) : undefined,
  });

  const byTag = new Map();
  let totalDistance = 0;
  let untaggedDistance = 0;

  for (const trip of trips) {
    const dist = trip.distance || 0;
    totalDistance += dist;
    if (trip.tags.length === 0) {
      untaggedDistance += dist;
      continue;
    }
    for (const tag of trip.tags) {
      const entry = byTag.get(tag.id) || { tag, distance: 0, trips: 0 };
      entry.distance += dist;
      entry.trips += 1;
      byTag.set(tag.id, entry);
    }
  }

  res.json({
    filters: { from: req.query.from || null, to: req.query.to || null },
    totalTrips: trips.length,
    totalDistance,
    untaggedDistance,
    byTag: [...byTag.values()].sort((a, b) => b.distance - a.distance),
  });
});
