import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'logbook.db');

// Ensure the data directory exists.
import { mkdirSync } from 'node:fs';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS checkpoints (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    time       TEXT    NOT NULL,                       -- ISO 8601 timestamp
    latitude   REAL    NOT NULL,
    longitude  REAL    NOT NULL,
    mileage    REAL    NOT NULL,                       -- odometer reading
    metadata   TEXT,                                   -- arbitrary JSON
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_checkpoints_time ON checkpoints(time);

  CREATE TABLE IF NOT EXISTS tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL UNIQUE,
    color TEXT
  );

  CREATE TABLE IF NOT EXISTS places (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                   TEXT    NOT NULL,
    latitude               REAL    NOT NULL,
    longitude              REAL    NOT NULL,
    radius                 REAL    NOT NULL,            -- meters
    duration               INTEGER NOT NULL,           -- dwell seconds that triggers a trip
    inherit_last_trip_tags INTEGER NOT NULL DEFAULT 0, -- 1 = copy tags from the previous trip (e.g. "home")
    created_at             TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trips (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    start_checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id),
    end_checkpoint_id   INTEGER NOT NULL REFERENCES checkpoints(id),
    note                TEXT,
    auto_generated      INTEGER NOT NULL DEFAULT 0,
    place_id            INTEGER REFERENCES places(id) ON DELETE SET NULL,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trip_tags (
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (trip_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS place_tags (
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (place_id, tag_id)
  );
`);

export { DB_PATH };
