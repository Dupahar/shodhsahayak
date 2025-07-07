const cors = require('cors');
const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { scrapeProposals } = require('./scraper');

const app = express();
const port = process.env.PORT || 3000;

// If DATABASE_URL is provided, remove any sslmode parameters from the URL
if (process.env.DATABASE_URL) {
  // This removes '?sslmode=require' or '&sslmode=require' from the connection string
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/(\?|&)sslmode=require/, '');
}

// Apply CORS middleware before defining routes
app.use(cors({
  origin: '*' // For development only; restrict in production
}));

// Rate limiting (100 requests/15 minutes)
const limiter = rateLimit({ 
  windowMs: 15 * 60 * 1000, 
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.'
});
app.use(limiter);

// Database connection with SSL disabled unconditionally
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/proposals',
  ssl: false
});

// Middleware to test database connection
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

// Basic health check endpoint (use this to wake up the service)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date() });
});

// API endpoint to get all proposals
app.get('/api/proposals', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proposals ORDER BY deadline DESC');
    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (err) {
    console.error('Failed to retrieve proposals:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve proposals',
      details: err.message
    });
  }
});

// API endpoint to get proposals by agency
app.get('/api/proposals/agency/:agency', async (req, res) => {
  try {
    const { agency } = req.params;
    const result = await pool.query(
      'SELECT * FROM proposals WHERE agency ILIKE $1 ORDER BY deadline DESC',
      [`%${agency}%`]
    );
    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (err) {
    console.error(`Failed to retrieve proposals for agency ${req.params.agency}:`, err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve proposals by agency',
      details: err.message
    });
  }
});

// API endpoint to manually trigger a scrape (protected by a simple token)
app.post('/api/scrape', async (req, res) => {
  const apiToken = req.headers['x-api-token'];
  
  if (apiToken !== process.env.API_TOKEN) {
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized' 
    });
  }
  
  try {
    res.status(202).json({ 
      success: true, 
      message: 'Scrape initiated, this may take a minute...' 
    });
    
    // Run scraping in the background
    scrapeProposals()
      .then(() => console.log('Manual scrape completed successfully'))
      .catch(err => console.error('Manual scrape failed:', err));
  } catch (err) {
    console.error('Failed to initiate scrape:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to initiate scrape',
      details: err.message
    });
  }
});

// Serve a simple HTML page for the root route
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Research Proposals API</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          h1 { color: #333; }
          ul { line-height: 1.6; }
          code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
        </style>
      </head>
      <body>
        <h1>Research Proposals API</h1>
        <p>Available endpoints:</p>
        <ul>
          <li><code>GET /api/proposals</code> - Retrieve all proposals</li>
          <li><code>GET /api/proposals/agency/:agency</code> - Retrieve proposals by agency</li>
          <li><code>GET /health</code> - API health check</li>
        </ul>
      </body>
    </html>
  `);
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`- Health check: http://localhost:${port}/health`);
  console.log(`- API endpoint: http://localhost:${port}/api/proposals`);
});

// Handle shutdown gracefully
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  process.exit(0);
});
