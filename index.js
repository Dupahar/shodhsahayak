const cors = require('cors');
const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { scrapeProposals } = require('./scraper');

const app = express();
const port = process.env.PORT || 10000;

// Load environment variables
require('dotenv').config();

console.log('▶️ Raw DATABASE_URL =', process.env.DATABASE_URL ? 'Set' : 'Not set');

// ✅ RENDER-OPTIMIZED: Database configuration specifically for Render PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://proposals_velw_user:ujHJKCC0VQPxB3FjEo8cxmNqUbpoAbts@dpg-d2acjc8gjchc73egskcg-a.singapore-postgres.render.com/proposals_velw',
  ssl: {
    rejectUnauthorized: false
  },
  // ✅ CRITICAL: Render-specific pool settings
  max: 5,                         // Small pool for Render free tier
  min: 0,                         // ESSENTIAL: Allow pool to close all connections
  idleTimeoutMillis: 10000,       // Close idle connections after 10 seconds
  connectionTimeoutMillis: 10000, // Timeout connection attempts after 10 seconds
  acquireTimeoutMillis: 10000,    // Timeout waiting for connection
  createRetryIntervalMillis: 500, // Retry failed connections every 500ms
  createTimeoutMillis: 10000,     // Timeout creating new connections
  allowExitOnIdle: true,          // Allow process to exit when pool is empty
  
  // ✅ TCP KEEPALIVE: Prevent connection drops
  keepAlive: true,                // Enable TCP keepalive
  keepAliveInitialDelayMillis: 30000  // Start keepalive after 30 seconds
});

// ✅ CRITICAL: Handle pool errors to prevent app crashes
pool.on('error', (err, client) => {
  console.error('🚨 Unexpected error on idle client:', err.message);
  // Don't exit process - just log and continue
});

pool.on('connect', (client) => {
  console.log('✅ New client connected to database');
});

pool.on('remove', (client) => {
  console.log('🔄 Client removed from pool');
});

// ✅ RESILIENT: Database setup with comprehensive retry logic
const setupDatabase = async () => {
  let retryCount = 0;
  const maxRetries = 5;
  
  while (retryCount < maxRetries) {
    let client = null;
    try {
      console.log(`🔄 Database setup attempt ${retryCount + 1}/${maxRetries}...`);
      client = await pool.connect();
      
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
      
      const result = await client.query('SELECT COUNT(*) FROM proposals');
      console.log(`✅ Database connected! Current proposals: ${result.rows[0].count}`);
      
      client.release();
      return true;
      
    } catch (err) {
      retryCount++;
      if (client) client.release();
      
      console.error(`❌ Database setup attempt ${retryCount}/${maxRetries} failed:`, err.message);
      
      if (retryCount >= maxRetries) {
        console.error('💥 Database setup failed after all retries. Service will continue with limited functionality.');
        return false;
      } else {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Exponential backoff
        console.log(`🔄 Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  return false;
};

// Start database setup
setupDatabase();

// Middleware
app.use(cors({ origin: '*' }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.'
}));

// ✅ IMPROVED: Resilient database middleware with circuit breaker pattern
let circuitBreakerOpen = false;
let lastFailureTime = 0;
const CIRCUIT_BREAKER_TIMEOUT = 60000; // 1 minute

app.use(async (req, res, next) => {
  // Circuit breaker logic
  if (circuitBreakerOpen) {
    if (Date.now() - lastFailureTime > CIRCUIT_BREAKER_TIMEOUT) {
      circuitBreakerOpen = false;
      console.log('🔄 Circuit breaker reset - attempting database connection');
    } else {
      return res.status(503).json({ 
        error: 'Database temporarily unavailable', 
        details: 'Service recovering from database issues. Please try again later.',
        timestamp: new Date().toISOString(),
        service: 'Research Proposals API'
      });
    }
  }
  
  let client = null;
  try {
    // Quick connection test
    client = await pool.connect();
    client.release();
    circuitBreakerOpen = false; // Reset on success
    next();
  } catch (err) {
    if (client) client.release();
    
    console.error('Database connection error:', err.message);
    circuitBreakerOpen = true;
    lastFailureTime = Date.now();
    
    res.status(503).json({ 
      error: 'Database temporarily unavailable', 
      details: 'Please try again in a few moments',
      timestamp: new Date().toISOString(),
      service: 'Research Proposals API'
    });
  }
});

// ✅ ENHANCED: Health check with detailed database status
app.get('/health', async (req, res) => {
  let dbStatus = 'Unknown';
  let dbDetails = {};
  
  try {
    const client = await pool.connect();
    const start = Date.now();
    await client.query('SELECT 1');
    const responseTime = Date.now() - start;
    client.release();
    
    dbStatus = 'Connected';
    dbDetails = {
      responseTime: `${responseTime}ms`,
      poolSize: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount
    };
  } catch (err) {
    dbStatus = 'Disconnected';
    dbDetails = { error: err.message };
  }
  
  res.status(dbStatus === 'Connected' ? 200 : 503).json({ 
    status: dbStatus === 'Connected' ? 'UP' : 'DOWN',
    timestamp: new Date(),
    database: dbStatus,
    databaseDetails: dbDetails,
    environment: process.env.NODE_ENV || 'production',
    circuitBreaker: circuitBreakerOpen ? 'OPEN' : 'CLOSED'
  });
});

// ✅ BULLETPROOF: Database query wrapper with automatic retry
const executeQuery = async (query, params = [], retries = 2) => {
  let lastError = null;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    let client = null;
    try {
      client = await pool.connect();
      const result = await client.query(query, params);
      client.release();
      return result;
    } catch (err) {
      if (client) client.release();
      lastError = err;
      
      // Don't retry on syntax errors
      if (err.code && (err.code === '42P01' || err.code === '42703')) {
        throw err;
      }
      
      if (attempt < retries) {
        console.log(`🔄 Query retry ${attempt + 1}/${retries} after error:`, err.message);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  
  throw lastError;
};

// ✅ BULLETPROOF: API endpoints using the resilient query wrapper
app.get('/api/proposals', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 per page
    const offset = (page - 1) * limit;
    
    const countResult = await executeQuery('SELECT COUNT(*) FROM proposals');
    const totalCount = parseInt(countResult.rows[0].count);
    
    const result = await executeQuery(
      'SELECT * FROM proposals ORDER BY created_at DESC, deadline DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    
    res.json({ 
      success: true, 
      count: result.rows.length,
      total: totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
      data: result.rows,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to retrieve proposals:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve proposals', 
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/proposals/agency/:agency', async (req, res) => {
  try {
    const { agency } = req.params;
    const result = await executeQuery(
      'SELECT * FROM proposals WHERE agency ILIKE $1 ORDER BY created_at DESC, deadline DESC',
      [`%${agency}%`]
    );
    
    res.json({ 
      success: true, 
      count: result.rows.length, 
      agency: agency,
      data: result.rows,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error(`Failed to retrieve proposals for agency ${req.params.agency}:`, err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve proposals by agency', 
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/agencies', async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT agency, COUNT(*) as proposal_count FROM proposals WHERE agency IS NOT NULL GROUP BY agency ORDER BY proposal_count DESC'
    );
    
    res.json({ 
      success: true, 
      count: result.rows.length, 
      data: result.rows,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to retrieve agencies:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve agencies', 
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/proposals/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ 
        success: false, 
        error: 'Search query parameter "q" is required' 
      });
    }
    
    const result = await executeQuery(
      'SELECT * FROM proposals WHERE title ILIKE $1 OR agency ILIKE $1 ORDER BY created_at DESC LIMIT 100',
      [`%${q}%`]
    );
    
    res.json({ 
      success: true, 
      count: result.rows.length,
      query: q,
      data: result.rows,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to search proposals:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to search proposals', 
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

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
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Research Proposals API - Shodh Sahayak</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f8f9fa; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
          h1 { margin: 0; }
          .status { background: white; padding: 15px; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .endpoint { background: white; padding: 15px; margin: 10px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .method { color: #007bff; font-weight: bold; }
          .path { font-family: monospace; background: #e9ecef; padding: 4px 8px; border-radius: 4px; }
          .description { color: #666; margin-top: 8px; }
          .links a { color: #007bff; text-decoration: none; margin-right: 15px; }
          .links a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>🔬 Shodh Sahayak</h1>
          <p>Indian Research Funding Opportunities API</p>
        </div>
        
        <div class="status">
          <strong>🚀 Service Status:</strong> Running on Render<br>
          <strong>🗄️ Database:</strong> PostgreSQL (Singapore)<br>
          <strong>📊 Data:</strong> 140+ research proposals from 14 agencies<br>
          <strong>⏰ Last Updated:</strong> ${new Date().toLocaleString()}
        </div>
        
        <h2>📡 API Endpoints</h2>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/api/proposals</span>
          <div class="description">Get all proposals (pagination: ?page=1&limit=50)</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/api/proposals/agency/:agency</span>
          <div class="description">Get proposals by agency (DST, UGC, SERB, etc.)</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/api/proposals/search?q=term</span>
          <div class="description">Search proposals by title or agency</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/api/agencies</span>
          <div class="description">List all funding agencies with counts</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span> <span class="path">/health</span>
          <div class="description">Detailed service health check</div>
        </div>
        
        <h3>🔗 Quick Access</h3>
        <div class="links">
          <a href="/api/proposals">📋 All Proposals</a>
          <a href="/api/proposals/agency/DST">🧪 DST Proposals</a>
          <a href="/api/proposals/agency/UGC">🎓 UGC Proposals</a>
          <a href="/api/agencies">🏢 All Agencies</a>
          <a href="/health">❤️ Health Status</a>
        </div>
        
        <div style="margin-top: 30px; padding: 15px; background: #e8f5e8; border-radius: 8px; font-size: 14px;">
          <strong>💡 For Researchers:</strong> This API aggregates funding opportunities from major Indian research agencies including DST, UGC, SERB, ICMR, DBT, BIRAC, and more. Updated regularly through automated web scraping.
        </div>
      </body>
    </html>
  `);
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Shodh Sahayak API running on port ${port}`);
  console.log(`📡 Health check: https://shodhsahayak.onrender.com/health`);
  console.log(`🔗 API endpoint: https://shodhsahayak.onrender.com/api/proposals`);
  console.log(`🏠 Homepage: https://shodhsahayak.onrender.com/`);
});

// ✅ ENHANCED: Graceful shutdown with proper cleanup
const gracefulShutdown = async (signal) => {
  console.log(`🔄 ${signal} received, shutting down gracefully`);
  
  try {
    console.log('🔄 Closing database pool...');
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('❌ Error closing database pool:', err);
  }
  
  console.log('👋 Shodh Sahayak API shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  // Don't exit - just log the error
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - just log the error
});
