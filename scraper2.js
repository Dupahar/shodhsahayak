const FirecrawlApp = require('@mendable/firecrawl-js').default;
const fs = require('fs');
const { JSDOM } = require('jsdom');

// Initialize FireCrawl with your key
const app = new FirecrawlApp({
  apiKey: "fc-22a6d53819e34fcd9fe2ff7ffa58be05"
});

async function scrapeVit() {
  try {
    const result = await app.scrapeUrl(
      'https://vit.ac.in/research/call-for-proposals',
      {
        formats: ['rawHtml', 'html', 'markdown'], // request all supported types :contentReference[oaicite:1]{index=1}
        onlyMainContent: true,
        waitFor: 5000,
        timeout: 15000
      }
    );

    // Fail fast if not successful
    if (!result.success) throw new Error(`Scrape failed: ${result.error}`);

    // Log what formats you actually got
    console.log('Formats returned:', Object.keys(result.data || {}));

    // Pick the preferred format
    const html = result.data.rawHtml ?? result.data.html ?? null;
    if (!html) throw new Error('No usable HTML returned');

    fs.writeFileSync('debug-vit.html', html);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Now you can safely run your parsing logic here...

    console.log('✅ Scrape succeeded and HTML saved.');

  } catch (err) {
    console.error('❌ Critical Error:', err);
    fs.writeFileSync('error.log', `${new Date().toISOString()}\n${err.stack}`);
    process.exit(1);
  }
}

scrapeVit();
