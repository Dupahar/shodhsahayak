const cors = require('cors');
const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { scrapeProposals } = require('./scraper');

const app = express();
const port = process.env.PORT || 3000;

if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/(\?|&)sslmode=require/, '');
}

app.use(cors({ origin: '*' }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.'
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/proposals',
  ssl: false
});

app.use(async (req, res, next) => {
  try {
    const client = await pool.connect();
    client.release();
    next();
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({ error: 'Database connection error', details: err.message });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date() });
});

app.get('/api/proposals', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proposals ORDER BY deadline DESC');
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error('Failed to retrieve proposals:', err);
    res.status(500).json({ success: false, error: 'Failed to retrieve proposals', details: err.message });
  }
});

app.get('/api/proposals/agency/:agency', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM proposals WHERE agency ILIKE $1 ORDER BY deadline DESC',
      [`%${req.params.agency}%`]
    );
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error(`Failed to retrieve proposals for agency ${req.params.agency}:`, err);
    res.status(500).json({ success: false, error: 'Failed to retrieve proposals by agency', details: err.message });
  }
});

// ✅ Open scrape endpoint — no auth required
app.post('/api/scrape', (req, res) => {
  res.status(202).json({ success: true, message: 'Scrape initiated, this may take a minute...' });
  scrapeProposals()
    .then(() => console.log('Manual scrape completed successfully'))
    .catch(err => console.error('Manual scrape failed:', err));
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Research Proposals API</title></head>
      <body>
        <h1>Research Proposals API</h1>
        <p>Endpoints:</p>
        <ul>
          <li><code>GET /api/proposals</code></li>
          <li><code>GET /api/proposals/agency/:agency</code></li>
          <li><code>POST /api/scrape</code> (public)</li>
          <li><code>GET /health</code></li>
        </ul>
      </body>
    </html>
  `);
});

app.listen(port, () => console.log(`Server running on port ${port}`));
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
