const cors = require('cors');
const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { scrapeProposals } = require('./scraper');

const app = express();
const port = process.env.PORT || 10000;

require('dotenv').config();

console.log('▶️ Raw DATABASE_URL =', process.env.DATABASE_URL ? 'Set' : 'Not set');

// ✅ RENDER-OPTIMIZED: Pool configuration based on community best practices
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://proposals_velw_user:ujHJKCC0VQPxB3FjEo8cxmNqUbpoAbts@dpg-d2acjc8gjchc73egskcg-a.singapore-postgres.render.com/proposals_velw',
  ssl: { rejectUnauthorized: false },
  
  // ✅ CRITICAL: Render-specific settings that prevent connection drops
  max: 3,                           // Very small pool for Render free tier
  min: 0,                          // ESSENTIAL: Allow pool to close all connections[2]
  idleTimeoutMillis: 5000,         // Aggressively close idle connections (5 seconds)
  connectionTimeoutMillis: 8000,   // Quick timeout for new connections
  acquireTimeoutMillis: 8000,      // Quick timeout waiting for connection
  createRetryIntervalMillis: 200,  // Fast retry for failed connections
  createTimeoutMillis: 8000,       // Timeout creating connections
  allowExitOnIdle: true,           // Allow process to exit when pool empty
  
  // ✅ TCP KEEPALIVE: Prevents connection drops[8]
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000  // Start keepalive after 10 seconds
});

// ✅ CRITICAL: Error handling to prevent app crashes
pool.on('error', (err, client) => {
  console.error('🚨 Pool error (non-fatal):', err.message);
  // Don't exit - this is expected behavior on Render
});

pool.on('connect', () => console.log('✅ New DB client connected'));
pool.on('remove', () => console.log('🔄 DB client removed from pool'));

// ✅ ROBUST: Database setup with intelligent retry
const setupDatabase = async () => {
  const maxRetries = 8;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    attempt++;
    let client = null;
    
    try {
      console.log(`🔄 Database setup attempt ${attempt}/${maxRetries}...`);
      
      // Use shorter timeout for each attempt
      client = await Promise.race([
        pool.connect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 5000)
        )
      ]);
      
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
      console.log(`✅ Database connected! Proposals count: ${result.rows[0].count}`);
      
      client.release();
      return true;
      
    } catch (err) {
      if (client) {
        try { client.release(); } catch (releaseErr) { /* ignore */ }
      }
      
      console.error(`❌ Setup attempt ${attempt}/${maxRetries} failed:`, err.message);
      
      if (attempt >= maxRetries) {
        console.error('💥 Database setup failed completely. Starting in degraded mode.');
        return false;
      }
      
      // Exponential backoff with jitter
      const delay = Math.min(1000 * Math.pow(1.5, attempt) + Math.random() * 1000, 10000);
      console.log(`🔄 Retrying in ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
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
  max: 200,  // Increased limit
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
}));

// ✅ IMPROVED: Resilient connection middleware with circuit breaker
let circuitBreakerOpen = false;
let consecutiveFailures = 0;
let lastFailureTime = 0;
const CIRCUIT_BREAKER_TIMEOUT = 30000; // 30 seconds
const FAILURE_THRESHOLD = 3;

const testDatabaseConnection = async () => {
  let client = null;
  try {
    client = await Promise.race([
      pool.connect(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), 3000)
      )
    ]);
    
    await client.query('SELECT 1');
    client.release();
    
    // Reset circuit breaker on success
    consecutiveFailures = 0;
    circuitBreakerOpen = false;
    return true;
    
  } catch (err) {
    if (client) {
      try { client.release(); } catch (releaseErr) { /* ignore */ }
    }
    
    consecutiveFailures++;
    lastFailureTime = Date.now();
    
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      circuitBreakerOpen = true;
      console.log('🚨 Circuit breaker OPENED due to consecutive failures');
    }
    
    throw err;
  }
};

app.use(async (req, res, next) => {
  // Check circuit breaker
  if (circuitBreakerOpen) {
    if (Date.now() - lastFailureTime > CIRCUIT_BREAKER_TIMEOUT) {
      console.log('🔄 Circuit breaker reset attempt...');
      try {
        await testDatabaseConnection();
        console.log('✅ Circuit breaker CLOSED - database recovered');
      } catch (err) {
        console.log('❌ Circuit breaker remains OPEN - database still failing');
      }
    }
    
    if (circuitBreakerOpen) {
      return res.status(503).json({
        error: 'Database temporarily unavailable',
        details: 'Service recovering from database issues. Please try again later.',
        timestamp: new Date().toISOString(),
        service: 'Research Proposals API',
        retryAfter: Math.round((CIRCUIT_BREAKER_TIMEOUT - (Date.now() - lastFailureTime)) / 1000)
      });
    }
  }
  
  // Quick connection test
  try {
    await testDatabaseConnection();
    next();
  } catch (err) {
    console.error('Database connection error:', err.message);
    res.status(503).json({
      error: 'Database temporarily unavailable',
      details: 'Connection issues detected. Please try again in a moment.',
      timestamp: new Date().toISOString(),
      service: 'Research Proposals API'
    });
  }
});

// ✅ BULLETPROOF: Query wrapper with automatic retry and proper cleanup
const executeQuery = async (query, params = [], maxRetries = 3) => {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let client = null;
    try {
      client = await Promise.race([
        pool.connect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 5000)
        )
      ]);
      
      const result = await client.query(query, params);
      client.release();
      return result;
      
    } catch (err) {
      lastError = err;
      if (client) {
        try { client.release(); } catch (releaseErr) { /* ignore */ }
      }
      
      // Don't retry on syntax errors
      if (err.code && ['42P01', '42703', '23505'].includes(err.code)) {
        throw err;
      }
      
      if (attempt < maxRetries) {
        const delay = 500 * attempt;
        console.log(`🔄 Query retry ${attempt}/${maxRetries} in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
};

// ✅ ENHANCED: Health check with detailed diagnostics
app.get('/health', async (req, res) => {
  const health = {
    status: 'UP',
    timestamp: new Date().toISOString(),
    service: 'Research Proposals API',
    database: 'Unknown',
    pool: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount
    },
    circuitBreaker: circuitBreakerOpen ? 'OPEN' : 'CLOSED',
    consecutiveFailures
  };
  
  try {
    const start = Date.now();
    const client = await pool.connect();
    await client.query('SELECT 1');
    const responseTime = Date.now() - start;
    client.release();
    
    health.database = 'Connected';
    health.responseTime = `${responseTime}ms`;
    res.status(200).json(health);
    
  } catch (err) {
    health.status = 'DEGRADED';
    health.database = 'Disconnected';
    health.error = err.message;
    res.status(503).json(health);
  }
});

// ✅ BULLETPROOF: API endpoints using resilient query wrapper
app.get('/api/proposals', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    
    const [countResult, dataResult] = await Promise.all([
      executeQuery('SELECT COUNT(*) FROM proposals'),
      executeQuery(
        'SELECT * FROM proposals ORDER BY created_at DESC, deadline DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      )
    ]);
    
    const totalCount = parseInt(countResult.rows[0].count);
    
    res.json({
      success: true,
      count: dataResult.rows.length,
      total: totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
      data: dataResult.rows,
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('Failed to retrieve proposals:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve proposals',
      details: process.env.NODE_ENV === 'development' ? err.message : 'Database error',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/proposals/agency/:agency', async (req, res) => {
  try {
    const { agency } = req.params;
    const result = await executeQuery(
      'SELECT * FROM proposals WHERE agency ILIKE $1 ORDER BY created_at DESC LIMIT 200',
      [`%${agency}%`]
    );
    
    res.json({
      success: true,
      count: result.rows.length,
      agency,
      data: result.rows,
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error(`Failed to retrieve agency proposals:`, err);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve agency proposals',
      details: process.env.NODE_ENV === 'development' ? err.message : 'Database error',
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
      details: process.env.NODE_ENV === 'development' ? err.message : 'Database error',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/proposals/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters'
      });
    }
    
    const result = await executeQuery(
      'SELECT * FROM proposals WHERE title ILIKE $1 OR agency ILIKE $1 ORDER BY created_at DESC LIMIT 100',
      [`%${q.trim()}%`]
    );
    
    res.json({
      success: true,
      count: result.rows.length,
      query: q.trim(),
      data: result.rows,
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('Failed to search proposals:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to search proposals',
      details: process.env.NODE_ENV === 'development' ? err.message : 'Database error',
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/scrape', async (req, res) => {
  res.status(202).json({
    success: true,
    message: 'Scrape initiated, this may take a few minutes...',
    timestamp: new Date().toISOString()
  });
  
  scrapeProposals()
    .then(() => console.log('✅ Manual scrape completed'))
    .catch(err => console.error('❌ Manual scrape failed:', err));
});

// Homepage with status information
app.get('/', (req, res) => {
  const statusColor = circuitBreakerOpen ? '#dc3545' : '#28a745';
  const statusText = circuitBreakerOpen ? 'Database Issues Detected' : 'Service Operational';
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Shodh Sahayak - Research Proposals API</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f8f9fa; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
          .status { background: white; padding: 15px; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-left: 4px solid ${statusColor}; }
          .endpoint { background: white; padding: 15px; margin: 10px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .method { color: #007bff; font-weight: bold; padding: 2px 6px; background: #e3f2fd; border-radius: 3px; }
          .path { font-family: monospace; background: #e9ecef; padding: 4px 8px; border-radius: 4px; margin: 0 5px; }
          .links a { color: #007bff; text-decoration: none; margin-right: 15px; }
          .links a:hover { text-decoration: underline; }
          .status-indicator { color: ${statusColor}; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>🔬 Shodh Sahayak</h1>
          <p>Indian Research Funding Opportunities API</p>
        </div>
        
        <div class="status">
          <h3>🚀 Service Status</h3>
          <div class="status-indicator">● ${statusText}</div>
          <div style="margin-top: 10px; font-size: 14px; color: #666;">
            <strong>Database:</strong> PostgreSQL (Singapore)<br>
            <strong>Pool Status:</strong> ${pool.totalCount} total, ${pool.idleCount} idle<br>
            <strong>Last Updated:</strong> ${new Date().toLocaleString()}
          </div>
        </div>
        
        <h2>📡 API Endpoints</h2>
        
        <div class="endpoint">
          <span class="method">GET</span><span class="path">/api/proposals</span>
          <div style="margin-top: 8px; color: #666;">Get all research proposals (supports pagination)</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span><span class="path">/api/proposals/agency/:agency</span>
          <div style="margin-top: 8px; color: #666;">Get proposals by funding agency (DST, UGC, SERB, etc.)</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span><span class="path">/api/proposals/search</span>
          <div style="margin-top: 8px; color: #666;">Search proposals by title or agency (?q=search_term)</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span><span class="path">/api/agencies</span>
          <div style="margin-top: 8px; color: #666;">List all funding agencies with proposal counts</div>
        </div>
        
        <div class="endpoint">
          <span class="method">GET</span><span class="path">/health</span>
          <div style="margin-top: 8px; color: #666;">Detailed service and database health check</div>
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
          <strong>💡 For Researchers:</strong> This API aggregates 140+ funding opportunities from major Indian research agencies. Data is updated regularly through automated scraping.
        </div>
      </body>
    </html>
  `);
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Shodh Sahayak API running on port ${port}`);
  console.log(`📡 Health: https://shodhsahayak.onrender.com/health`);
  console.log(`🔗 API: https://shodhsahayak.onrender.com/api/proposals`);
  console.log(`🏠 Home: https://shodhsahayak.onrender.com/`);
});

// ✅ GRACEFUL SHUTDOWN: Proper cleanup on termination
const gracefulShutdown = async (signal) => {
  console.log(`🔄 ${signal} received, shutting down gracefully...`);
  
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('❌ Error closing pool:', err.message);
  }
  
  console.log('👋 Shodh Sahayak shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions gracefully
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message);
  // Don't exit - log and continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection:', reason);
  // Don't exit - log and continue
});
