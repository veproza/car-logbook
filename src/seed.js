// Populates the database with a small "home <-> work" commute example that
// demonstrates place-driven automatic trip generation. Run with `npm run seed`.
import { db } from './db.js';
import { evaluateAutoTrips } from './autoTrips.js';

console.log('Resetting data…');
db.exec(`
  DELETE FROM trip_tags; DELETE FROM place_tags; DELETE FROM trips;
  DELETE FROM places; DELETE FROM tags; DELETE FROM checkpoints;
`);

const tag = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)');
const business = tag.run('business', '#3b82f6').lastInsertRowid;
const personal = tag.run('personal', '#22c55e').lastInsertRowid;

const HOME = { lat: 50.0000, lon: 14.0000 };
const WORK = { lat: 50.1000, lon: 14.1000 };

const place = db.prepare(`
  INSERT INTO places (name, latitude, longitude, radius, duration, inherit_last_trip_tags)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const homeId = place.run('Home', HOME.lat, HOME.lon, 150, 1800, 1).lastInsertRowid; // inherits previous trip tags
const workId = place.run('Work', WORK.lat, WORK.lon, 150, 1800, 0).lastInsertRowid;
db.prepare('INSERT INTO place_tags (place_id, tag_id) VALUES (?, ?)').run(workId, business);

const cp = db.prepare('INSERT INTO checkpoints (time, latitude, longitude, mileage) VALUES (?, ?, ?, ?)');
const days = ['2026-06-01', '2026-06-02'];
let mileage = 1000;
for (const day of days) {
  cp.run(`${day}T08:00:00.000Z`, HOME.lat, HOME.lon, mileage);        // leave home
  cp.run(`${day}T08:35:00.000Z`, WORK.lat, WORK.lon, mileage += 15);  // arrive work (15 km)
  cp.run(`${day}T17:30:00.000Z`, HOME.lat, HOME.lon, mileage += 15);  // arrive home (15 km)
}

const created = evaluateAutoTrips();
console.log(`Seeded ${days.length} commute day(s); generated ${created} trip(s).`);
console.log('Tags:', { business, personal });
db.close();
