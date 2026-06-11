const http = require('http');
const url  = require('url');
const { searchMagnets } = require('./src/scraper');
const { fetchMovieMeta } = require('./src/meta');
const { discoverContent, discoverAnimation, searchMulti } = require('./src/discover');

const PORT = process.env.PORT || 3000;
console.log('[ENV] PORT:', PORT);
console.log('[ENV] TMDB_API_KEY:', process.env.TMDB_API_KEY ? '已读取 (' + process.env.TMDB_API_KEY.length + '位)' : '未读取');

const ROUTES = {
  '/api/search':       handleSearch,
  '/api/meta':         handleMeta,
  '/api/health':       handleHealth,
  '/api/discover':     handleDiscover,
  '/api/search/multi': handleSearchMulti,
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const parsed = url.parse(req.url, true);
  const handler = ROUTES[parsed.pathname];
  if (!handler) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Not found' })); }
  try { await handler(parsed.query, res); }
  catch (err) { console.error('[ERROR]', err.message); res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
});

async function handleHealth(query, res) { res.writeHead(200); res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() })); }
async function handleSearch(query, res) {
  const q = (query.q || '').trim(); const page = parseInt(query.page) || 1;
  if (!q) { res.writeHead(400); return res.end(JSON.stringify({ error: '缺少参数 q' })); }
  console.log(`[SEARCH] "${q}" page=${page}`);
  const results = await searchMagnets(q, page);
  res.writeHead(200); res.end(JSON.stringify({ query: q, page, total: results.length, results }));
}
async function handleMeta(query, res) {
  const title = (query.title || '').trim(); const year = query.year || ''; const type = query.type || 'movie';
  if (!title) { res.writeHead(400); return res.end(JSON.stringify({ error: '缺少参数 title' })); }
  console.log(`[META] "${title}" year=${year} type=${type}`);
  const meta = await fetchMovieMeta(title, year, type);
  res.writeHead(200); res.end(JSON.stringify(meta));
}
async function handleDiscover(query, res) {
  const type = (query.type || 'movie').toLowerCase();
  const range = (query.range || 'year').toLowerCase();
  const page = parseInt(query.page) || 1;
  console.log(`[DISCOVER] type=${type} range=${range} page=${page}`);
  const data = type === 'animation' ? await discoverAnimation(range, page) : await discoverContent(type, range, page);
  res.writeHead(200); res.end(JSON.stringify(data));
}
async function handleSearchMulti(query, res) {
  const q = (query.q || '').trim(); const page = parseInt(query.page) || 1;
  if (!q) { res.writeHead(400); return res.end(JSON.stringify({ error: '缺少参数 q' })); }
  console.log(`[SEARCH/MULTI] "${q}" page=${page}`);
  const data = await searchMulti(q, page);
  res.writeHead(200); res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  console.log(`\n🎬  magnet-api running → http://localhost:${PORT}`);
  console.log(`   GET /api/health`);
  console.log(`   GET /api/search?q=xxx`);
  console.log(`   GET /api/meta?title=xxx`);
  console.log(`   GET /api/discover?type=movie&range=year`);
  console.log(`   GET /api/search/multi?q=蝙蝠侠\n`);
});
