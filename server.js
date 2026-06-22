/**
 * magnet-api  —  磁力片源抓取 & 影片元数据 API
 * 运行: node server.js
 */

const http = require('http');
const url  = require('url');
const { searchMagnets }                          = require('./src/scraper');
const { fetchMovieMeta }                         = require('./src/meta');
const { discoverContent, discoverAnimation, searchMulti } = require('./src/discover');

const PORT = process.env.PORT || 3000;

console.log('[ENV] PORT:', PORT);
console.log('[ENV] TMDB_API_KEY:', process.env.TMDB_API_KEY ? '已读取 (' + process.env.TMDB_API_KEY.length + '位)' : '未读取');

const ROUTES = {
  '/api/search':    handleSearch,    // GET /api/search?q=xxx&page=1
  '/api/meta':      handleMeta,      // GET /api/meta?title=xxx&year=2024&type=movie|tv
  '/api/health':    handleHealth,    // GET /api/health
  '/api/discover':  handleDiscover,  // GET /api/discover?type=movie|tv|animation&range=year|all&page=1
  '/api/search/multi': handleSearchMulti, // GET /api/search/multi?q=蝙蝠侠&page=1
};

const server = http.createServer(async (req, res) => {
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

// ─── 原有路由 ──────────────────────────────────────────────────────────────────

async function handleHealth(query, res) {
  res.writeHead(200);
  res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
}

async function handleSearch(query, res) {
  const q      = (query.q      || '').trim();
  const page   = parseInt(query.page) || 1;
  const imdbId = (query.imdbId || '').trim() || null;
  if (!q) { res.writeHead(400); return res.end(JSON.stringify({ error: '缺少参数 q' })); }
  console.log(`[SEARCH] "${q}" page=${page} imdbId=${imdbId||'none'}`);
  const results = await searchMagnets(q, page, imdbId);
  res.writeHead(200);
  res.end(JSON.stringify({ query: q, page, total: results.length, results }));
}

async function handleMeta(query, res) {
  const title = (query.title || '').trim();
  const year  = query.year  || '';
  const type  = query.type  || 'movie';
  if (!title) { res.writeHead(400); return res.end(JSON.stringify({ error: '缺少参数 title' })); }
  console.log(`[META] "${title}" year=${year} type=${type}`);
  const meta = await fetchMovieMeta(title, year, type);
  res.writeHead(200);
  res.end(JSON.stringify(meta));
}

// ─── 新路由 ───────────────────────────────────────────────────────────────────

/**
 * GET /api/discover
 *   type:  movie | tv | animation   (默认 movie)
 *   range: year | all               (默认 year，近一年)
 *   page:  1-based                  (默认 1)
 *
 * 响应: { page, totalPages, totalResults, results: [...] }
 */
async function handleDiscover(query, res) {
  const type  = (query.type  || 'movie').toLowerCase();
  const range = (query.range || 'year').toLowerCase();
  const page  = parseInt(query.page) || 1;

  console.log(`[DISCOVER] type=${type} range=${range} page=${page}`);

  let data;
  if (type === 'animation') {
    data = await discoverAnimation(range, page);
  } else {
    data = await discoverContent(type, range, page);
  }

  res.writeHead(200);
  res.end(JSON.stringify(data));
}

/**
 * GET /api/search/multi
 *   q:    搜索关键词（支持中文）
 *   page: 1-based（默认 1）
 *
 * 响应: { query, page, totalPages, totalResults, results: [...] }
 * results 同时包含电影、剧集、动画，每条含 mediaType 字段
 */
async function handleSearchMulti(query, res) {
  const q    = (query.q    || '').trim();
  const page = parseInt(query.page) || 1;
  if (!q) { res.writeHead(400); return res.end(JSON.stringify({ error: '缺少参数 q' })); }
  console.log(`[SEARCH/MULTI] "${q}" page=${page}`);
  const data = await searchMulti(q, page);
  res.writeHead(200);
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  console.log(`\n🎬  magnet-api running → http://localhost:${PORT}`);
  console.log(`   GET /api/health`);
  console.log(`   GET /api/search?q=星际穿越`);
  console.log(`   GET /api/search?q=Interstellar&imdbId=tt0816692  ← 携带 IMDB ID 可启用 Torrentio 源`);
  console.log(`   GET /api/meta?title=Interstellar&year=2014`);
  console.log(`   GET /api/discover?type=movie&range=year&page=1`);
  console.log(`   GET /api/discover?type=animation&range=all&page=1`);
  console.log(`   GET /api/search/multi?q=蝙蝠侠\n`);
});
