const cors = require('cors');
const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { scrapeProposals } = require('./scraper');

const app = express();
const port = process.env.PORT || 3000;

// Load environment variables
require('dotenv').config();

// Debug raw DATABASE_URL to verify env var
console.log('▶️ Raw DATABASE_URL =', process.env.DATABASE_URL ? 'Set' : 'Not set');

// ✅ FIXED: Use the same database configuration as your working scraper
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://proposals_velw_user:ujHJKCC0VQPxB3FjEo8cxmNqUbpoAbts@dpg-d2acjc8gjchc73egskcg-a.singapore-postgres.render.com/proposals_velw',
  ssl: {
    rejectUnauthorized: false  // ✅ Match scraper.js SSL configuration
  }
});

// ✅ FIXED: Ensure table exists with proper schema matching scraper.js
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proposals (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        agency TEXT,
        from_date TEXT,
        deadline TEXT,
        link TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(title, link)
      );
    `);
    console.log('✅ Table "proposals" verified/created with proper schema.');
  } catch (err) {
    console.error('❌ Failed to create/verify proposals table:', err);
  }
})();

app.use(cors({ origin: '*' }));

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.'
}));

// ✅ IMPROVED: Better database connection middleware with detailed error info
app.use(async (req, res, next) => {
  try {
    const client = await pool.connect();
    client.release();
    next();
  } catch (err) {
    console.error('Database connection error:', err);
    res.status(500).json({ 
      error: 'Database connection error', 
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'UP', 
    timestamp: new Date(),
    database: 'Connected',
    environment: process.env.NODE_ENV || 'development'
  });
});

// ✅ IMPROVED: Get all proposals with better error handling and pagination
app.get('/api/proposals', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    
    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) FROM proposals');
    const totalCount = parseInt(countResult.rows[0].count);
    
    // Get proposals with pagination
    const result = await pool.query(
      'SELECT * FROM proposals ORDER BY created_at DESC, deadline DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    
    res.json({ 
      success: true, 
      count: result.rows.length,
      total: totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
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

// Get proposals by agency
app.get('/api/proposals/agency/:agency', async (req, res) => {
  try {
    const { agency } = req.params;
    const result = await pool.query(
      'SELECT * FROM proposals WHERE agency ILIKE $1 ORDER BY created_at DESC, deadline DESC',
      [`%${agency}%`]
    );
    res.json({ 
      success: true, 
      count: result.rows.length, 
      agency: agency,
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

// ✅ NEW: Get unique agencies
app.get('/api/agencies', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT agency, COUNT(*) as proposal_count FROM proposals WHERE agency IS NOT NULL GROUP BY agency ORDER BY proposal_count DESC'
    );
    res.json({ 
      success: true, 
      count: result.rows.length, 
      data: result.rows 
    });
  } catch (err) {
    console.error('Failed to retrieve agencies:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve agencies', 
      details: err.message 
    });
  }
});

// ✅ NEW: Search proposals
app.get('/api/proposals/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ 
        success: false, 
        error: 'Search query parameter "q" is required' 
      });
    }
    
    const result = await pool.query(
      'SELECT * FROM proposals WHERE title ILIKE $1 OR agency ILIKE $1 ORDER BY created_at DESC',
      [`%${q}%`]
    );
    
    res.json({ 
      success: true, 
      count: result.rows.length,
      query: q,
      data: result.rows 
    });
  } catch (err) {
    console.error('Failed to search proposals:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to search proposals', 
      details: err.message 
    });
  }
});

// ✅ IMPROVED: Manual scrape trigger with better response
app.post('/api/scrape', async (req, res) => {
  try {
    // Check if scraping is already in progress (you could implement a flag)
    res.status(202).json({ 
      success: true, 
      message: 'Scrape initiated, this may take a few minutes...',
      timestamp: new Date().toISOString()
    });
    
    // Run scraping in background
    scrapeProposals()
      .then(() => {
        console.log('✅ Manual scrape completed successfully at', new Date().toISOString());
      })
      .catch(err => {
        console.error('❌ Manual scrape failed:', err);
      });
      
  } catch (err) {
    console.error('Failed to initiate scrape:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to initiate scrape', 
      details: err.message 
    });
  }
});

// ✅ IMPROVED: Enhanced homepage with better documentation
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Research Proposals API</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
          h1 { color: #333; }
          .endpoint { background: #f4f4f4; padding: 10px; margin: 10px 0; border-radius: 5px; }
          .method { color: #007bff; font-weight: bold; }
          .path { font-family: monospace; background: #e9ecef; padding: 2px 5px; border-radius: 3px; }
          .description { color: #666; margin-top: 5px; }
        </style>
      </head>
      <body>
        <h1>🔬 Research Proposals API</h1>
        <p>Indian research funding opportunities aggregator</p>
        
        <h2>Available Endpoints:</h2>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/api/proposals</span>
          <div class="description">Get all proposals (supports pagination: ?page=1&limit=50)</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/api/proposals/agency/:agency</span>
          <div class="description">Get proposals by agency (e.g., /api/proposals/agency/DST)</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/api/proposals/search</span>
          <div class="description">Search proposals (?q=your_search_term)</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/api/agencies</span>
          <div class="description">Get list of all agencies with proposal counts</div>
        </div>
        
        <div class="endpoint">
          <span class="method">POST</span> <span class="path">/api/scrape</span>
          <div class="description">Manually trigger scraping process</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/health</span>
          <div class="description">API health check</div>
        </div>
        
        <h3>🚀 Quick Examples:</h3>
        <ul>
          <li><a href="/api/proposals">View all proposals</a></li>
          <li><a href="/api/proposals/agency/DST">DST proposals</a></li>
          <li><a href="/api/agencies">All agencies</a></li>
          <li><a href="/health">Health check</a></li>
        </ul>
      </body>
    </html>
  `);
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📡 Health check: http://localhost:${port}/health`);
  console.log(`🔗 API endpoint: http://localhost:${port}/api/proposals`);
  console.log(`🏠 Homepage: http://localhost:${port}/`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  process.exit(0);
});
