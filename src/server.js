import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { checkpoints } from './routes/checkpoints.js';
import { trips } from './routes/trips.js';
import { tags } from './routes/tags.js';
import { places } from './routes/places.js';
import { reports } from './routes/reports.js';
import { evaluateAutoTrips } from './autoTrips.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, '..', 'public')));

app.use('/api/checkpoints', checkpoints);
app.use('/api/trips', trips);
app.use('/api/tags', tags);
app.use('/api/places', places);
app.use('/api/reports', reports);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Centralized error handler so route throws become clean JSON 500s.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'internal error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Car logbook running at http://localhost:${PORT}`);
});

// A checkpoint inside a place only becomes a "settled" dwell once enough wall
// time has passed with no newer checkpoint. POSTing checkpoints can't detect
// that on its own, so re-evaluate on a timer too.
const EVAL_INTERVAL_MS = Number(process.env.EVAL_INTERVAL_MS || 60000);
setInterval(() => {
  try {
    const n = evaluateAutoTrips();
    if (n) console.log(`Auto-generated ${n} trip(s)`);
  } catch (e) {
    console.error('Auto-trip evaluation failed:', e);
  }
}, EVAL_INTERVAL_MS).unref();
