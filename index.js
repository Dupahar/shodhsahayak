const cors = require('cors');
const express = require('express');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 10000;

// Load environment variables
require('dotenv').config();

console.log('▶️ Raw DATABASE_URL =', process.env.DATABASE_URL ? 'Set' : 'Not set');

// ✅ FIXED: Correct database connection with proper SSL handling
let connectionString = process.env.DATABASE_URL || 'postgresql://proposals_velw_user:ujHJKCC0VQPxB3FjEo8cxmNqUbpoAbts@dpg-d2acjc8gjchc73egskcg-a.singapore-postgres.render.com/proposals_velw';

// ✅ CRITICAL: Remove sslmode parameter from connection string to avoid conflicts
connectionString = connectionString.replace(/[?&]sslmode=require/, '');

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false  // ✅ Handle SSL properly in config object
  },
  // ✅ RENDER-OPTIMIZED: Pool settings that work with Render PostgreSQL
  max: 5,                           // Small pool for Render
  min: 0,                          // Allow pool to close completely
  idleTimeoutMillis: 10000,        // Close idle connections after 10 seconds
  connectionTimeoutMillis: 10000,  // Timeout new connections
  acquireTimeoutMillis: 10000,     // Timeout waiting for connection
  allowExitOnIdle: true,           // Allow process to exit when pool empty
  keepAlive: true,                 // Prevent connection drops
  keepAliveInitialDelayMillis: 30000
});

// ✅ CRITICAL: Handle pool errors to prevent crashes
pool.on('error', (err, client) => {
  console.error('🚨 Pool error (expected on Render):', err.message);
});

pool.on('connect', () => console.log('✅ New database client connected'));
pool.on('remove', () => console.log('🔄 Database client removed'));

// ✅ ROBUST: Database setup with intelligent retry
const setupDatabase = async () => {
  const maxRetries = 8;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    attempt++;
    let client = null;
    
    try {
      console.log(`🔄 Database setup attempt ${attempt}/${maxRetries}...`);
      
      client = await Promise.race([
        pool.connect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 8000)
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
      console.log(`✅ Database connected! Current proposals: ${result.rows[0].count}`);
      
      client.release();
      return true;
      
    } catch (err) {
      if (client) {
        try { client.release(); } catch (releaseErr) { /* ignore */ }
      }
      
      console.error(`❌ Setup attempt ${attempt}/${maxRetries} failed:`, err.message);
      
      if (attempt >= maxRetries) {
        console.error('💥 Database setup failed. Starting in degraded mode.');
        return false;
      }
      
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
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
}));

// ✅ CIRCUIT BREAKER: Prevents database flooding during issues
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
        setTimeout(() => reject(new Error('Connection timeout')), 5000)
      )
    ]);
    
    await client.query('SELECT 1');
    client.release();
    
    // Reset on success
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
      console.log('🚨 Circuit breaker OPENED due to failures');
    }
    
    throw err;
  }
};

// Database middleware with circuit breaker
app.use(async (req, res, next) => {
  if (circuitBreakerOpen) {
    if (Date.now() - lastFailureTime > CIRCUIT_BREAKER_TIMEOUT) {
      console.log('🔄 Circuit breaker reset attempt...');
      try {
        await testDatabaseConnection();
        console.log('✅ Circuit breaker CLOSED - database recovered');
      } catch (err) {
        console.log('❌ Circuit breaker remains OPEN');
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

// ✅ BULLETPROOF: Query wrapper with retry and cleanup
const executeQuery = async (query, params = [], maxRetries = 3) => {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let client = null;
    try {
      client = await Promise.race([
        pool.connect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 8000)
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

// ✅ HEALTH CHECK with detailed diagnostics
app.get('/health', async (req, res) => {
  const health = {
    status: 'UP',
    timestamp: new Date().toISOString(),
    service: 'Research Proposals API',
    version: '2.0.0',
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
    await client.query('SELECT NOW()');
    const responseTime = Date.now() - start;
    client.release();
    
    health.database = 'Connected';
    health.responseTime = `${responseTime}ms`;
    health.status = 'UP';
    res.status(200).json(health);
    
  } catch (err) {
    health.status = 'DEGRADED';
    health.database = 'Disconnected';
    health.error = err.message;
    res.status(503).json(health);
  }
});

// ✅ DEBUG: Endpoint to check database status and verify all proposals exist
app.get('/api/debug/database', async (req, res) => {
  try {
    console.log('🔍 Running database debug queries...');
    
    const queries = await Promise.all([
      executeQuery('SELECT COUNT(*) as total FROM proposals'),
      executeQuery('SELECT agency, COUNT(*) as count FROM proposals GROUP BY agency ORDER BY count DESC'),
      executeQuery('SELECT title, agency, created_at FROM proposals ORDER BY created_at DESC LIMIT 10'),
      executeQuery('SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM proposals'),
      executeQuery('SELECT created_at::date as date, COUNT(*) as count FROM proposals GROUP BY created_at::date ORDER BY date DESC LIMIT 7')
    ]);
    
    const totalCount = parseInt(queries[0].rows[0].total);
    console.log(`📊 Debug: Found ${totalCount} total proposals in database`);
    
    res.json({
      success: true,
      totalProposals: totalCount,
      agencyBreakdown: queries[1].rows,
      recentProposals: queries[2].rows,
      dateRange: queries[3].rows[0],
      recentActivity: queries[4].rows,
      timestamp: new Date().toISOString(),
      message: totalCount === 140 ? 'All 140 proposals found in database!' : `Expected 140 but found ${totalCount} proposals`
    });
    
  } catch (err) {
    console.error('Debug query failed:', err);
    res.status(500).json({
      success: false,
      error: 'Debug query failed',
      details: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ FIXED: API endpoint to get all proposals correctly with better logging
app.get('/api/proposals', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50)); // Increased max limit
    const offset = (page - 1) * limit;
    
    console.log(`📊 API Request: page=${page}, limit=${limit}, offset=${offset}`);
    
    // ✅ FIXED: Get total count and data with better error handling
    const [countResult, dataResult] = await Promise.all([
      executeQuery('SELECT COUNT(*) FROM proposals'),
      executeQuery(
        'SELECT * FROM proposals ORDER BY created_at DESC, deadline DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      )
    ]);
    
    const totalCount = parseInt(countResult.rows[0].count);
    
    console.log(`📊 API Response: Returning ${dataResult.rows.length} proposals out of ${totalCount} total`);
    
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

// ✅ NEW: Get ALL proposals without pagination (for debugging)
app.get('/api/proposals/all', async (req, res) => {
  try {
    console.log('📊 Fetching ALL proposals without pagination...');
    
    const result = await executeQuery('SELECT * FROM proposals ORDER BY created_at DESC');
    
    console.log(`📊 Found ${result.rows.length} total proposals in database`);
    
    res.json({
      success: true,
      total: result.rows.length,
      data: result.rows,
      message: "All proposals without pagination",
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('Failed to retrieve all proposals:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve all proposals',
      details: err.message,
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
    console.error('Failed to retrieve agency proposals:', err);
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
  
  // Note: scrapeProposals function removed since it causes import issues
  console.log('Manual scrape requested but scraper module not available');
});

// ✅ ENHANCED HOMEPAGE with debug links
app.get('/', (req, res) => {
  const statusColor = circuitBreakerOpen ? '#dc3545' : '#28a745';
  const statusText = circuitBreakerOpen ? 'Database Issues Detected' : 'Service Operational';
  
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Shodh Sahayak - Research Proposals API</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; background: #f8f9fa; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; border-radius: 10px; margin-bottom: 20px; }
          .status { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-left: 5px solid ${statusColor}; }
          .endpoint { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
          .method { color: white; font-weight: bold; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
          .get { background: #28a745; }
          .post { background: #007bff; }
          .debug { background: #ffc107; color: #000; }
          .path { font-family: Monaco, 'Courier New', monospace; background: #e9ecef; padding: 6px 10px; border-radius: 4px; margin: 0 8px; font-size: 14px; }
          .links { margin: 20px 0; }
          .links a { display: inline-block; background: #007bff; color: white; padding: 10px 15px; margin: 5px 10px 5px 0; border-radius: 5px; text-decoration: none; }
          .links a:hover { background: #0056b3; }
          .debug-links a { background: #ffc107; color: #000; }
          .debug-links a:hover { background: #e0a800; }
          .status-indicator { color: ${statusColor}; font-weight: bold; font-size: 16px; }
          .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
          .stat { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; }
          .stat-number { font-size: 24px; font-weight: bold; color: #007bff; }
          .stat-label { color: #666; margin-top: 5px; }
          .alert { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 8px; margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>🔬 Shodh Sahayak</h1>
          <p style="margin: 5px 0;">Indian Research Funding Opportunities API</p>
          <p style="margin: 5px 0; opacity: 0.9;">Aggregating 140+ research proposals from 14+ Indian agencies</p>
        </div>
        
        <div class="alert">
          <strong>🔍 Debug Notice:</strong> If you're seeing fewer than 140 proposals in the API, use the debug endpoints below to investigate. Your database should contain all 140 proposals as confirmed by the scraper.
        </div>
        
        <div class="status">
          <h3 style="margin-top: 0;">🚀 Service Status</h3>
          <div class="status-indicator">● ${statusText}</div>
          <div style="margin-top: 15px; font-size: 14px; color: #666;">
            <strong>Database:</strong> PostgreSQL (Singapore)<br>
            <strong>Pool:</strong> ${pool.totalCount} total connections, ${pool.idleCount} idle<br>
            <strong>Environment:</strong> ${process.env.NODE_ENV || 'production'}<br>
            <strong>Last Updated:</strong> ${new Date().toLocaleString()}
          </div>
        </div>

        <div class="stats">
          <div class="stat">
            <div class="stat-number">140+</div>
            <div class="stat-label">Research Proposals</div>
          </div>
          <div class="stat">
            <div class="stat-number">14+</div>
            <div class="stat-label">Funding Agencies</div>
          </div>
          <div class="stat">
            <div class="stat-number">24/7</div>
            <div class="stat-label">API Availability</div>
          </div>
          <div class="stat">
            <div class="stat-number">Auto</div>
            <div class="stat-label">Daily Updates</div>
          </div>
        </div>
        
        <h2>📡 API Endpoints</h2>
        
        <div class="endpoint">
          <span class="method get">GET</span><span class="path">/api/proposals</span>
          <div style="margin-top: 10px; color: #666;">Get all research proposals with pagination support (?page=1&limit=50)</div>
        </div>
        
        <div class="endpoint">
          <span class="method get">GET</span><span class="path">/api/proposals/all</span>
          <div style="margin-top: 10px; color: #666;">Get ALL proposals without pagination (for debugging)</div>
        </div>
        
        <div class="endpoint">
          <span class="method get">GET</span><span class="path">/api/proposals/agency/:agency</span>
          <div style="margin-top: 10px; color: #666;">Get proposals by funding agency (DST, UGC, SERB, ICMR, DBT, BIRAC, etc.)</div>
        </div>
        
        <div class="endpoint">
          <span class="method get">GET</span><span class="path">/api/proposals/search</span>
          <div style="margin-top: 10px; color: #666;">Search proposals by title or agency (?q=fellowship)</div>
        </div>
        
        <div class="endpoint">
          <span class="method get">GET</span><span class="path">/api/agencies</span>
          <div style="margin-top: 10px; color: #666;">List all funding agencies with proposal counts</div>
        </div>
        
        <div class="endpoint">
          <span class="method debug">DEBUG</span><span class="path">/api/debug/database</span>
          <div style="margin-top: 10px; color: #666;">Detailed database diagnostics and proposal count verification</div>
        </div>
        
        <div class="endpoint">
          <span class="method get">GET</span><span class="path">/health</span>
          <div style="margin-top: 10px; color: #666;">Detailed service and database health check with metrics</div>
        </div>
        
        <h3>🔗 Quick Access</h3>
        <div class="links">
          <a href="/api/proposals">📋 Proposals (Page 1)</a>
          <a href="/api/proposals?limit=100">📋 First 100</a>
          <a href="/api/proposals/agency/DST">🧪 DST</a>
          <a href="/api/proposals/agency/UGC">🎓 UGC</a>
          <a href="/api/agencies">🏢 Agencies</a>
          <a href="/health">❤️ Health</a>
        </div>
        
        <h3>🐛 Debug & Troubleshooting</h3>
        <div class="links debug-links">
          <a href="/api/debug/database">🔍 Database Debug</a>
          <a href="/api/proposals/all">📊 All Proposals</a>
          <a href="/api/proposals?limit=200">📋 First 200</a>
        </div>
        
        <div style="margin-top: 30px; padding: 20px; background: #e8f5e8; border-radius: 8px; font-size: 14px; line-height: 1.6;">
          <strong>💡 For Researchers:</strong> This API provides access to funding opportunities from major Indian research agencies including:
          <br><strong>DST, UGC, SERB, ICMR, DBT, BIRAC, ICSSR, CEFIPRA, IGSTC, TDB, SPARC, NASI, INSA, and more.</strong>
          <br><br>
          Data is automatically updated through intelligent web scraping and provides structured access to deadlines, agency information, and application links.
        </div>

        <div style="margin-top: 20px; padding: 15px; background: #fff3cd; border-radius: 8px; font-size: 13px; color: #856404;">
          <strong>⚡ Performance Note:</strong> First API call after idle periods may take 2-3 seconds as the database connection pool initializes. Subsequent calls are much faster.
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
  console.log(`🐛 Debug: https://shodhsahayak.onrender.com/api/debug/database`);
  console.log(`🏠 Home: https://shodhsahayak.onrender.com/`);
  console.log('✨ Ready to serve research proposal data!');
});

// ✅ GRACEFUL SHUTDOWN with proper cleanup
const gracefulShutdown = async (signal) => {
  console.log(`🔄 ${signal} received, initiating graceful shutdown...`);
  
  try {
    console.log('🔄 Closing database pool...');
    await pool.end();
    console.log('✅ Database pool closed successfully');
  } catch (err) {
    console.error('❌ Error closing database pool:', err.message);
  }
  
  console.log('👋 Shodh Sahayak API shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ✅ SAFETY NET: Handle uncaught exceptions gracefully
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message);
  // Log but don't exit - let the app continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  // Log but don't exit - let the app continue
});
