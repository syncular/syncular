import { execFileSync } from 'node:child_process';

const ACCOUNT_ID = '336bfd20ccb2f56e24ac0afeca6b4837';
const DATASET = 'syncular_docs_engagement';

const args = process.argv.slice(2);
const daysFlag = args.indexOf('--days');
const days = daysFlag >= 0 ? Number(args[daysFlag + 1]) : 7;
const jsonOutput = args.includes('--json');

if (!Number.isInteger(days) || days < 1 || days > 90) {
  throw new Error('--days must be an integer from 1 to 90');
}

const token = (() => {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return process.env.CLOUDFLARE_API_TOKEN;
  }

  try {
    const output = execFileSync(
      'bunx',
      ['wrangler', 'auth', 'token', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(output).token;
  } catch {
    throw new Error(
      'No Cloudflare token available. Run `bunx wrangler login` or set CLOUDFLARE_API_TOKEN with Account Analytics Read.',
    );
  }
})();

const query = async (sql) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/plain',
      },
      body: sql,
    },
  );
  const result = await response.json();
  if (!response.ok || result.success === false) {
    const message = result.errors?.map((error) => error.message).join('; ');
    throw new Error(message || `Cloudflare analytics query failed (${response.status})`);
  }
  return result.data ?? result.result?.data ?? [];
};

const timeFilter = `timestamp >= NOW() - INTERVAL '${days}' DAY`;
const reportFilter = "blob5 != 'bot' AND blob9 != 'verification'";

const [content, acquisition, countries] = await Promise.all([
  query(`
    SELECT
      blob1 AS event,
      blob2 AS path,
      SUM(_sample_interval) AS events,
      SUM(_sample_interval * double2) / SUM(_sample_interval) AS avg_active_seconds,
      SUM(_sample_interval * double3) / SUM(_sample_interval) AS avg_scroll_depth
    FROM ${DATASET}
    WHERE ${timeFilter} AND ${reportFilter}
    GROUP BY event, path
    ORDER BY events DESC
    LIMIT 100
  `),
  query(`
    SELECT
      blob3 AS referrer,
      blob8 AS utm_source,
      blob9 AS utm_medium,
      blob10 AS utm_campaign,
      SUM(_sample_interval) AS page_views
    FROM ${DATASET}
    WHERE ${timeFilter} AND ${reportFilter} AND blob1 = 'page_view'
    GROUP BY referrer, utm_source, utm_medium, utm_campaign
    ORDER BY page_views DESC
    LIMIT 50
  `),
  query(`
    SELECT blob4 AS country, SUM(_sample_interval) AS page_views
    FROM ${DATASET}
    WHERE ${timeFilter} AND ${reportFilter} AND blob1 = 'page_view'
    GROUP BY country
    ORDER BY page_views DESC
    LIMIT 50
  `),
]);

const number = (value) => Number(value ?? 0);
const byPath = new Map();
for (const row of content) {
  const current = byPath.get(row.path) ?? {
    path: row.path,
    pageViews: 0,
    articleReads: 0,
    readRate: '—',
    avgActiveSeconds: '—',
    avgScrollDepth: '—',
  };
  if (row.event === 'page_view') current.pageViews = number(row.events);
  if (row.event === 'article_read') {
    current.articleReads = number(row.events);
    current.avgActiveSeconds = number(row.avg_active_seconds).toFixed(0);
    current.avgScrollDepth = `${(number(row.avg_scroll_depth) * 100).toFixed(0)}%`;
  }
  byPath.set(row.path, current);
}

const pages = [...byPath.values()]
  .map((row) => ({
    ...row,
    readRate:
      row.path.startsWith('/blog/') &&
      row.path !== '/blog/' &&
      row.pageViews > 0
        ? `${((row.articleReads / row.pageViews) * 100).toFixed(1)}%`
        : '—',
  }))
  .sort((a, b) => b.pageViews - a.pageViews);

const report = { days, pages, acquisition, countries };
if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Syncular engagement — last ${days} day${days === 1 ? '' : 's'}`);
  console.log('\nContent');
  console.table(pages);
  console.log('\nAcquisition');
  console.table(acquisition);
  console.log('\nCountries');
  console.table(countries);
}
