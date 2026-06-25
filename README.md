# 🚗 Car Logbook

A local mileage logbook for accounting — track how many kilometers were driven for
**business** vs **personal** reasons. You feed the car's position and odometer as
*checkpoints*; these are grouped into *trips* (manually or automatically via *places*),
tagged, and summed in a filterable report.

Built with **Node.js + Express** and **SQLite** (`better-sqlite3`). No authentication —
it is designed to run on your own machine.

## Concepts

- **Checkpoint** — a data point: `time`, `latitude`, `longitude`, `mileage` (odometer)
  and optional free-form `metadata`. The main way data enters the system, typically
  via the API from a phone/GPS tracker.
- **Trip** — a journey between two checkpoints. Its distance is simply
  `end.mileage − start.mileage`. A trip carries any number of **tags**.
- **Tag** — a label such as `business` or `personal`, used to classify trips and to
  slice the report.
- **Place** — a geofence (`latitude`, `longitude`, `radius` in meters) plus a dwell
  `duration`. When a checkpoint falls inside the radius and no newer checkpoint appears
  for `duration`, a trip is auto-generated from the previous trip boundary up to that
  checkpoint. A place either applies **its own tags**, or — if `inherit_last_trip_tags`
  is set — copies the **previous trip's tags** (the "home" case, so both the
  Home→Work and Work→Home legs end up tagged the same).

## Run

```bash
npm install
npm run seed      # optional: loads a home<->work commute example
npm start         # http://localhost:3000
```

`npm run dev` starts with auto-reload. Environment variables:

| var | default | meaning |
|-----|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/logbook.db` | SQLite file location |
| `EVAL_INTERVAL_MS` | `60000` | how often settled dwells are re-checked |

## Run with Docker

```bash
docker compose up --build      # http://localhost:3000
```

Or with plain Docker:

```bash
docker build -t car-logbook .
docker run -p 3000:3000 -v logbook-data:/data car-logbook
```

The image is a multi-stage build on `node:20-slim` running as the non-root `node`
user, with a `/api/health` healthcheck. Inside the container the database lives at
`DB_PATH=/data/logbook.db`; the `/data` volume keeps it across restarts. The browser
loads Material Web and Leaflet from public CDNs, so the **client** needs internet
access (the server does not).

> If you bind-mount a host directory instead of a named volume (e.g.
> `-v "$PWD/data:/data"`), make sure it's writable by the container's `node` user
> (uid 1000), otherwise SQLite can't create the database file.

### Updating

The Compose service **builds** the image from the GitHub repo (`build.context` is the
git URL) and tags it locally as `car-logbook`. That name is just a local tag — the image
is **not** published to any registry. So to update, rebuild from git; do **not** pull:

```bash
docker compose up -d --build      # re-clones main, rebuilds, restarts
```

To force a clean rebuild (ignore the layer cache):

```bash
docker compose build --pull --no-cache
docker compose up -d
```

> ⚠️ Don't run `docker compose pull` for this stack. Because the image has no registry
> prefix, Docker tries to fetch `docker.io/library/car-logbook` from Docker Hub and fails
> with `pull access denied ... repository does not exist`. This is expected — the image is
> built locally, not pulled. (It's not a DNS problem.)

## How auto-trip generation works

Dwells are detected both when a checkpoint is ingested and on a periodic timer (a
checkpoint only becomes "settled" once enough wall-clock time has passed with no newer
checkpoint). Evaluation is idempotent: it only closes trips for dwells occurring after
the most recent trip boundary, and never creates a zero-distance trip from repeated
stationary pings.

## API

All endpoints are under `/api`. Bodies and responses are JSON.

### Checkpoints
- `GET /checkpoints?from=&to=` — list (newest first)
- `POST /checkpoints` — ingest one. Required: `latitude`/`lat`, `longitude`/`lon`,
  `mileage`/`odometer`. Optional: `time` (ISO, defaults to now), `metadata` (any JSON).
  Returns `{ checkpoint, tripsCreated }`.
- `GET /checkpoints/:id`, `DELETE /checkpoints/:id`
- `POST /checkpoints/bulk` — import many at once from pasted **TSV** text
  (`{ "tsv": "..." }`). Columns, tab-separated: `created  lat  lng  mileage
  [battery] [remaining range]`. Decimal commas (`50,0904`) and an optional header
  row are accepted; `battery`/`range` go into `metadata`. Rows missing a timestamp,
  coordinates or mileage are skipped. Returns
  `{ imported, skipped, tripsCreated, errors: [{ line, reason, raw }] }`. Also
  available in the UI under **Checkpoints → Bulk import (TSV)** (paste or file upload).

```bash
curl -X POST localhost:3000/api/checkpoints \
  -H 'Content-Type: application/json' \
  -d '{"lat":50.1,"lon":14.1,"mileage":1015,"time":"2026-06-01T08:35:00Z"}'
```

### Trips
- `GET /trips?from=&to=&tags=1,2` — list with computed `distance` and tags
- `POST /trips` — manual: `{ start_checkpoint_id, end_checkpoint_id, note?, tag_ids? }`
- `PUT /trips/:id` — update `note` and/or `tag_ids`
- `DELETE /trips/:id`
- `POST /trips/evaluate` — force place-driven auto-generation

### Tags — `GET/POST/PUT/DELETE /tags`
### Places — `GET/POST/PUT/DELETE /places`
`POST /places` body: `{ name, latitude, longitude, radius, duration, inherit_last_trip_tags?, tag_ids? }`
(`duration` in **seconds**).

### Report
- `GET /reports/summary?from=&to=&tags=` — totals plus a per-tag breakdown.
  A multi-tagged trip contributes to each of its tags, so per-tag distances can exceed
  the de-duplicated `totalDistance`.

## Web UI

Open `http://localhost:3000`. Tabs: **Report** (mileage totals and per-tag breakdown
with date/tag filters), **Trips** (filter, manual create, edit tags/notes, re-evaluate),
**Checkpoints**, **Places**, and **Tags**.

- **Map preview** — items with coordinates (checkpoints, places, and both ends of each
  trip) have a 📍 button: hover to preview the location on a Leaflet/OpenStreetMap map,
  click to pin it for panning/zooming.
- **Build trips from checkpoints** — in the Checkpoints list, click **Start trip** on a
  checkpoint, then **End trip** on a later one to create the trip. These buttons appear
  only on checkpoints that aren't already inside a trip (a trip's own start/end
  checkpoints stay eligible, so trips can be chained back-to-back).

## Project layout

```
src/
  server.js          Express app, static hosting, periodic dwell evaluator
  db.js              SQLite connection + schema
  autoTrips.js       place-driven trip generation
  models/trips.js    trip queries, distance, tag helpers
  routes/            checkpoints, trips, tags, places, reports
  util/geo.js        haversine distance / geofence test
  seed.js            sample commute data
public/              static single-page UI (vanilla JS)
```
