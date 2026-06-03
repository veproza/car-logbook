import { db } from '../db.js';
import { isWithin } from '../util/geo.js';

// Full trip row joined with its start/end checkpoints and computed distance.
const TRIP_BASE = `
  SELECT
    t.id, t.note, t.auto_generated, t.place_id, t.created_at,
    t.start_checkpoint_id, t.end_checkpoint_id,
    sc.time      AS start_time,
    sc.mileage   AS start_mileage,
    sc.latitude  AS start_latitude,
    sc.longitude AS start_longitude,
    ec.time      AS end_time,
    ec.mileage   AS end_mileage,
    ec.latitude  AS end_latitude,
    ec.longitude AS end_longitude,
    (ec.mileage - sc.mileage) AS distance,
    p.name       AS place_name
  FROM trips t
  JOIN checkpoints sc ON sc.id = t.start_checkpoint_id
  JOIN checkpoints ec ON ec.id = t.end_checkpoint_id
  LEFT JOIN places p ON p.id = t.place_id
`;

const tagsStmt = db.prepare(`
  SELECT tg.id, tg.name, tg.color
  FROM trip_tags tt JOIN tags tg ON tg.id = tt.tag_id
  WHERE tt.trip_id = ?
  ORDER BY tg.name
`);

export function tripTags(tripId) {
  return tagsStmt.all(tripId);
}

export function tripTagIds(tripId) {
  return tripTags(tripId).map((t) => t.id);
}

const insertTagStmt = db.prepare('INSERT OR IGNORE INTO trip_tags (trip_id, tag_id) VALUES (?, ?)');
const clearTagsStmt = db.prepare('DELETE FROM trip_tags WHERE trip_id = ?');

export const setTripTags = db.transaction((tripId, tagIds) => {
  clearTagsStmt.run(tripId);
  for (const tagId of tagIds || []) insertTagStmt.run(tripId, tagId);
});

const placesForMatchStmt = db.prepare('SELECT id, name, latitude, longitude, radius FROM places');

// First place whose geofence contains the point, as a compact { id, name }.
function placeAt(lat, lng, places) {
  if (lat == null || lng == null) return null;
  const p = places.find((pl) => isWithin(pl, lat, lng));
  return p ? { id: p.id, name: p.name } : null;
}

function hydrate(row, places = placesForMatchStmt.all()) {
  return {
    ...row,
    auto_generated: !!row.auto_generated,
    tags: tripTags(row.id),
    start_place: placeAt(row.start_latitude, row.start_longitude, places),
    end_place: placeAt(row.end_latitude, row.end_longitude, places),
  };
}

export function getTrip(id) {
  const row = db.prepare(`${TRIP_BASE} WHERE t.id = ?`).get(id);
  return row ? hydrate(row) : null;
}

/**
 * List trips with optional filters: { from, to, tagIds }.
 * `from`/`to` filter on the trip end time (ISO strings). `tagIds` matches trips
 * carrying ANY of the given tags.
 */
export function listTrips({ from, to, tagIds } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('ec.time >= ?'); params.push(from); }
  if (to) { where.push('ec.time <= ?'); params.push(to); }
  if (tagIds && tagIds.length) {
    where.push(`t.id IN (SELECT trip_id FROM trip_tags WHERE tag_id IN (${tagIds.map(() => '?').join(',')}))`);
    params.push(...tagIds);
  }
  const sql = `${TRIP_BASE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ec.time DESC`;
  const places = placesForMatchStmt.all();
  return db.prepare(sql).all(...params).map((row) => hydrate(row, places));
}

/** The most recent trip by end-checkpoint time (the timeline boundary for auto-generation). */
export function lastTrip() {
  const row = db.prepare(`${TRIP_BASE} ORDER BY ec.time DESC, t.id DESC LIMIT 1`).get();
  return row ? hydrate(row) : null;
}
