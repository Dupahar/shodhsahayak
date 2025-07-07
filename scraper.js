const FirecrawlApp = require('@mendable/firecrawl-js').default;
const { parse, isValid } = require('date-fns');

const app = new FirecrawlApp({
  apiKey: "fc-22a6d53819e34fcd9fe2ff7ffa58be05"
});

// ✅ Define this FIRST
const researchUrls = [
  'https://dst.gov.in/call-for-proposals',
  'https://www.dbtindia.gov.in/latest-announcement',
  'https://birac.nic.in/cfp.php',
  'https://www.icmr.gov.in/whatnew.html',
  'https://serb.gov.in/page/show/63',
  'https://www.icssr.org/funding',
  'https://www.cefipra.org/ResearchProjects',
  'https://www.igstc.org/',
  'https://tdb.gov.in/',
  'https://www.ugc.ac.in/',
  'https://sparc.iitkgp.ac.in/',
  'https://www.nasi.org.in/awards.htm',
  'https://insaindia.res.in/',
  'https://vit.ac.in/research/call-for-proposals'
];

const getAgency = (sourceUrl) => {
  // mapping unchanged...
  if (sourceUrl.includes('dst.gov.in')) return 'DST';
  if (sourceUrl.includes('dbtindia.gov.in')) return 'DBT';
  if (sourceUrl.includes('birac.nic.in')) return 'BIRAC';
  if (sourceUrl.includes('icmr.gov.in')) return 'ICMR';
  if (sourceUrl.includes('serb.gov.in')) return 'SERB';
  if (sourceUrl.includes('icssr.org')) return 'ICSSR';
  if (sourceUrl.includes('cefipra.org')) return 'CEFIPRA';
  if (sourceUrl.includes('igstc.org')) return 'IGSTC';
  if (sourceUrl.includes('tdb.gov.in')) return 'TDB';
  if (sourceUrl.includes('ugc.ac.in')) return 'UGC';
  if (sourceUrl.includes('sparc.iitkgp.ac.in')) return 'SPARC';
  if (sourceUrl.includes('nasi.org.in')) return 'NASI';
  if (sourceUrl.includes('insaindia.res.in')) return 'INSA';
  return 'Unknown Agency';
};

const parseDate = (s) => {
  // unchanged...
  if (!s || typeof s !== 'string') return null;
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.match(/rolling|ongoing|continuous|open|throughout/i)) return 'Rolling Deadline';
  const formats = ['dd/MM/yyyy','dd-MM-yyyy','MM/dd/yyyy','yyyy-MM-dd','dd MMM yyyy','dd MMMM yyyy','MMM dd, yyyy','MMMM dd, yyyy','dd/MM/yy','dd-MM-yy'];
  for (const f of formats) {
    try {
      const d = parse(t, f, new Date());
      if (isValid(d)) return d.toISOString().split('T')[0];
    } catch {}
  }
  return t;
};

const extractProposalsFromMarkdown = (md, srcUrl) => {
  const props = [];
  const regex = /\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = regex.exec(md))) {
    const [ , title, link ] = m;
    if (
      title.length >= 10 &&
      title.match(/call|proposal|funding|grant|scheme|research|phd|postdoc|scientist|startup/i)
    ) {
      props.push({
        title: title.trim(),
        agency: getAgency(srcUrl),
        startDate: 'Not specified',
        endDate: 'Not specified',
        link,
        extractedAt: new Date().toISOString()
      });
    }
  }
  return props;
};

(async () => {
  try {
    const all = [];

    for (const url of researchUrls) {
      try {
        console.log(`Scraping ${url}...`);
        const r = await app.scrapeUrl(url, {
          formats: ['markdown'],
          onlyMainContent: true,
          timeout: 15000
        });
        if (!r.success) {
          console.warn(`  ❌ skipped: ${r.error}`);
          continue;
        }
        const md = r.data?.markdown || r.markdown;
        if (!md) {
          console.warn('  ❌ no markdown content');
          continue;
        }

        const found = extractProposalsFromMarkdown(md, url);
        console.log(`  ✅ found ${found.length} direct link(s)`);
        all.push(...found);
        await new Promise(r => setTimeout(r, 500));

      } catch (innerErr) {
        console.warn(`  ❌ error scraping ${url}: ${innerErr.message}`);
      }
    }

    const unique = all.filter((v, i, a) =>
      i === a.findIndex(x => x.title === v.title && x.link === v.link)
    );

    unique.sort((a, b) => {
      const da = new Date(a.endDate), db = new Date(b.endDate);
      if (isNaN(da) && isNaN(db)) return 0;
      if (isNaN(da)) return 1;
      if (isNaN(db)) return -1;
      return da - db;
    });

    console.log('\nFinal Proposals (direct links only):\n', JSON.stringify(unique, null, 2));
  
  } catch (fatalErr) {
    console.error('Fatal error:', fatalErr);
  }
})();
