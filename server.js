/**
 * magnet-api  —  磁力片源抓取 & 影片元数据 API
 * 运行: node server.js
 * 端口: 3000
 */

const http = require('http');
const url  = require('url');
const { searchMagnets } = require('./src/scraper');
const { fetchMovieMeta } = require('./src/meta');

const PORT = process.env.PORT || 3000;

// ─── 极简路由 (无需 express 依赖) ─────────────────────────────────────────────
const ROUTES = {
  '/api/search':  handleSearch,   // GET /api/search?q=星际穿越&page=1
  '/api/meta':    handleMeta,     // GET /api/meta?title=Interstellar&year=2014
  '/api/health':  handleHealth,   // GET /api/health
};

const server = http.createServer(async (req, res) => {
  // CORS — 允许 iOS App / 本地前端跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const handler  = ROUTES[pathname];

  if (!handler) {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Not found', path: pathname }));
  }

  try {
    await handler(parsed.query, res);
  } catch (err) {
    console.error('[ERROR]', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ─── 路由处理器 ───────────────────────────────────────────────────────────────

async function handleHealth(query, res) {
  res.writeHead(200);
  res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
}

async function handleSearch(query, res) {
  const q    = (query.q    || '').trim();
  const page = parseInt(query.page) || 1;

  if (!q) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: '缺少参数 q' }));
  }

  console.log(`[SEARCH] "${q}" page=${page}`);
  const results = await searchMagnets(q, page);
  res.writeHead(200);
  res.end(JSON.stringify({ query: q, page, total: results.length, results }));
}

async function handleMeta(query, res) {
  const title = (query.title || '').trim();
  const year  = query.year  || '';
  const type  = query.type  || 'movie'; // 'movie' or 'tv'

  if (!title) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: '缺少参数 title' }));
  }

  console.log(`[META] "${title}" year=${year} type=${type}`);
  const meta = await fetchMovieMeta(title, year, type);
  res.writeHead(200);
  res.end(JSON.stringify(meta));
}

server.listen(PORT, () => {
  console.log(`\n🎬  magnet-api running → http://localhost:${PORT}`);
  console.log(`   GET /api/health`);
  console.log(`   GET /api/search?q=星际穿越`);
  console.log(`   GET /api/meta?title=Interstellar&year=2014\n`);
});
