const cors = require('cors');
const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { scrapeProposals } = require('./scraper');

const app = express();
const port = process.env.PORT || 3000;

// Load environment variables
require('dotenv').config();

console.log('▶️ Raw DATABASE_URL =', process.env.DATABASE_URL ? 'Set' : 'Not set');

// ✅ FIXED: Improved PostgreSQL configuration for Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://proposals_velw_user:ujHJKCC0VQPxB3FjEo8cxmNqUbpoAbts@dpg-d2acjc8gjchc73egskcg-a.singapore-postgres.render.com/proposals_velw',
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,                    // Maximum number of connections in pool
  min: 0,                     // Minimum connections (important for Render)
  idleTimeoutMillis: 30000,   // Close idle clients after 30 seconds
  connectionTimeoutMillis: 20000, // Wait 20 seconds for connection
  acquireTimeoutMillis: 20000,    // Wait 20 seconds to acquire connection
  createRetryIntervalMillis: 200, // Retry interval for failed connections
  createTimeoutMillis: 20000      // Timeout for creating connections
});

// ✅ CRITICAL: Handle pool errors to prevent crashes
pool.on('error', (err, client) => {
  console.error('🚨 Unexpected error on idle client', err);
  // Don't exit process, just log the error
});

// ✅ IMPROVED: Better database setup with error handling
(async () => {
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries) {
    try {
      const client = await pool.connect();
      await client.query(`
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
      client.release();
      console.log('✅ Table "proposals" verified/created with proper schema.');
      break;
    } catch (err) {
      retryCount++;
      console.error(`❌ Database setup attempt ${retryCount}/${maxRetries} failed:`, err.message);
      
      if (retryCount >= maxRetries) {
        console.error('💥 Database setup failed after all retries. Service will continue but may have issues.');
      } else {
        console.log(`🔄 Retrying database setup in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
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

// ✅ IMPROVED: Resilient database connection middleware
app.use(async (req, res, next) => {
  let client = null;
  try {
    client = await pool.connect();
    client.release();
    next();
  } catch (err) {
    console.error('Database connection error:', err.message);
    
    // ✅ BETTER: Provide more helpful error response
    res.status(503).json({ 
      error: 'Database temporarily unavailable', 
      details: 'Please try again in a few moments',
      timestamp: new Date().toISOString(),
      service: 'Research Proposals API'
    });
  }
});

// Health check endpoint with database status
app.get('/health', async (req, res) => {
  let dbStatus = 'Unknown';
  
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    dbStatus = 'Connected';
  } catch (err) {
    dbStatus = 'Disconnected';
  }
  
  res.status(200).json({ 
    status: 'UP', 
    timestamp: new Date(),
    database: dbStatus,
    environment: process.env.NODE_ENV || 'production'
  });
});

// ✅ IMPROVED: Better error handling for all API endpoints
app.get('/api/proposals', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    
    const countResult = await client.query('SELECT COUNT(*) FROM proposals');
    const totalCount = parseInt(countResult.rows[0].count);
    
    const result = await client.query(
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
  } finally {
    client.release();
  }
});

// Get proposals by agency
app.get('/api/proposals/agency/:agency', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { agency } = req.params;
    const result = await client.query(
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
  } finally {
    client.release();
  }
});

// Get unique agencies
app.get('/api/agencies', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
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
  } finally {
    client.release();
  }
});

// Search proposals
app.get('/api/proposals/search', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ 
        success: false, 
        error: 'Search query parameter "q" is required' 
      });
    }
    
    const result = await client.query(
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
  } finally {
    client.release();
  }
});

// Manual scrape trigger
app.post('/api/scrape', async (req, res) => {
  try {
    res.status(202).json({ 
      success: true, 
      message: 'Scrape initiated, this may take a few minutes...',
      timestamp: new Date().toISOString()
    });
    
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

// Homepage
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
          .status { background: #d4edda; border: 1px solid #c3e6cb; padding: 10px; border-radius: 5px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <h1>🔬 Research Proposals API</h1>
        <div class="status">
          <strong>Service Status:</strong> Running on Render 🚀<br>
          <strong>Database:</strong> PostgreSQL (Singapore)<br>
          <strong>Last Updated:</strong> ${new Date().toISOString()}
        </div>
        
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
          <div class="description">API health check with database status</div>
        </div>
        
        <h3>🚀 Quick Test:</h3>
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
  console.log(`📡 Health check: https://shodhsahayak.onrender.com/health`);
  console.log(`🔗 API endpoint: https://shodhsahayak.onrender.com/api/proposals`);
  console.log(`🏠 Homepage: https://shodhsahayak.onrender.com/`);
});

// ✅ IMPROVED: Graceful shutdown with proper cleanup
process.on('SIGTERM', async () => {
  console.log('🔄 SIGTERM received, shutting down gracefully');
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('❌ Error closing database pool:', err);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🔄 SIGINT received, shutting down gracefully');
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('❌ Error closing database pool:', err);
  }
  process.exit(0);
});
