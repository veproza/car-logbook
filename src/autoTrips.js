import { db } from './db.js';
import { isWithin } from './util/geo.js';
import { lastTrip, tripTagIds, setTripTags } from './models/trips.js';

const placesStmt = db.prepare('SELECT * FROM places');
const placeTagsStmt = db.prepare('SELECT tag_id FROM place_tags WHERE place_id = ?');
const insertTripStmt = db.prepare(`
  INSERT INTO trips (start_checkpoint_id, end_checkpoint_id, auto_generated, place_id)
  VALUES (?, ?, 1, ?)
`);

const secondsBetween = (aIso, bIso) => (Date.parse(bIso) - Date.parse(aIso)) / 1000;

/** First configured place whose radius contains the checkpoint, or null. */
function placeFor(checkpoint, places) {
  return places.find((p) => isWithin(p, checkpoint.latitude, checkpoint.longitude)) || null;
}

/**
 * Materialize auto-generated trips for any settled dwell that occurred after the
 * last known trip boundary. A dwell is a checkpoint inside a place where no new
 * checkpoint appeared for at least the place's `duration` (the gap to the next
 * checkpoint, or to `now` for the latest checkpoint).
 *
 * Each dwell closes a trip running from the previous boundary up to the dwell
 * checkpoint. Stationary repeat pings (no odometer change) never form a trip.
 * Idempotent and safe to call repeatedly.
 *
 * @returns {number} count of trips created
 */
export const evaluateAutoTrips = db.transaction((nowIso = new Date().toISOString()) => {
  const places = placesStmt.all();
  if (places.length === 0) return 0;

  const boundary = lastTrip();
  // Start from the last trip's end checkpoint, or the very first checkpoint ever.
  let startCp = boundary
    ? db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(boundary.end_checkpoint_id)
    : db.prepare('SELECT * FROM checkpoints ORDER BY time ASC, id ASC LIMIT 1').get();
  if (!startCp) return 0;

  // Candidate checkpoints strictly after the boundary, in chronological order.
  const candidates = db
    .prepare('SELECT * FROM checkpoints WHERE time > ? OR (time = ? AND id > ?) ORDER BY time ASC, id ASC')
    .all(startCp.time, startCp.time, startCp.id);

  let prevTagIds = boundary ? tripTagIds(boundary.id) : [];
  let created = 0;

  for (let i = 0; i < candidates.length; i++) {
    const cp = candidates[i];
    const next = candidates[i + 1];
    const gapAfter = secondsBetween(cp.time, next ? next.time : nowIso);
    const place = placeFor(cp, places);

    if (!place || gapAfter < place.duration) continue;

    // A real journey only: the odometer must have advanced since the start.
    if (cp.mileage <= startCp.mileage) continue;

    const tagIds = place.inherit_last_trip_tags
      ? prevTagIds
      : placeTagsStmt.all(place.id).map((r) => r.tag_id);

    const { lastInsertRowid } = insertTripStmt.run(startCp.id, cp.id, place.id);
    setTripTags(lastInsertRowid, tagIds);

    prevTagIds = tagIds;
    startCp = cp;
    created++;
  }

  return created;
});
