/**
 * src/meta.js — 零依赖版本，使用 Node.js 内置 https 模块
 * TMDB 数据 + 豆瓣评分
 */
const https = require('https');
const http  = require('http');

const TMDB_KEY  = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p';
const TIMEOUT   = 8000;

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...extraHeaders,
      },
      timeout: TIMEOUT,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function getJSON(url, headers = {}) {
  const text = await httpGet(url, headers);
  if (text.trimStart().startsWith('<')) throw new Error('Got HTML');
  return JSON.parse(text);
}

// ── 豆瓣评分 ──────────────────────────────────────────────────────────────────
async function fetchDoubanRating(title, year) {
  try {
    const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`;
    const data = await getJSON(url, {
      'Referer': 'https://movie.douban.com/',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
    });
    if (!Array.isArray(data) || !data.length) return null;
    const match = year
      ? data.find(d => d.year === String(year) && d.type === 'movie')
        || data.find(d => d.type === 'movie') || data[0]
      : data.find(d => d.type === 'movie') || data[0];
    if (match?.rating) {
      console.log(`[豆瓣] "${title}" → ${match.rating}`);
      return { rating: String(match.rating), id: match.id, title: match.title };
    }
  } catch (e) {
    console.warn('[豆瓣] failed:', e.message);
  }
  return null;
}

// ── TMDB ──────────────────────────────────────────────────────────────────────
async function fetchFromTMDB(title, year) {
  if (!TMDB_KEY) return null;
  try {
    const yearParam = year ? `&year=${year}` : '';
    const searchData = await getJSON(
      `${TMDB_BASE}/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&language=zh-CN${yearParam}`
    );
    const movie = searchData.results?.[0];
    if (!movie) return null;

    let detail = movie;
    try {
      detail = await getJSON(
        `${TMDB_BASE}/movie/${movie.id}?api_key=${TMDB_KEY}&language=zh-CN&append_to_response=credits`
      );
    } catch (e) { /* 降级用搜索结果 */ }

    const cast = (detail.credits?.cast || []).slice(0, 10).map(c => ({
      name: c.name, character: c.character,
      photo: c.profile_path ? `${TMDB_IMG}/w185${c.profile_path}` : null,
    }));
    const directors = (detail.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name);
    const runtime = detail.runtime || movie.runtime;

    return {
      tmdbId:        detail.id || movie.id,
      title:         detail.title || movie.title,
      originalTitle: detail.original_title || movie.original_title,
      year:          (detail.release_date || movie.release_date || '').slice(0, 4),
      overview:      detail.overview || movie.overview || '',
      poster:        detail.poster_path   ? `${TMDB_IMG}/w500${detail.poster_path}`    : null,
      backdrop:      detail.backdrop_path ? `${TMDB_IMG}/w1280${detail.backdrop_path}` : null,
      tmdbRating:    (detail.vote_average || movie.vote_average || 0).toFixed(1),
      runtime:       runtime ? `${Math.floor(runtime/60)}h ${runtime%60}m` : '',
      runtimeMin:    runtime || 0,
      genres:        (detail.genres || []).map(g => g.name),
      directors, cast,
      language:  detail.original_language || '',
      countries: (detail.production_countries || []).map(c => c.name),
    };
  } catch (e) {
    console.warn('[TMDB] failed:', e.message);
    return null;
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
async function fetchMovieMeta(title, year = '') {
  const [tmdbRes, doubanRes] = await Promise.allSettled([
    fetchFromTMDB(title, year),
    fetchDoubanRating(title, year),
  ]);
  const tmdb   = tmdbRes.status   === 'fulfilled' ? tmdbRes.value   : null;
  const douban = doubanRes.status === 'fulfilled' ? doubanRes.value : null;

  if (!tmdb) {
    return { title, year, overview:'', poster:null, backdrop:null,
             rating:'', ratingSource:'none', runtime:'', genres:[], directors:[], cast:[], source:'none' };
  }
  const rating       = douban?.rating || tmdb.tmdbRating;
  const ratingSource = douban?.rating ? 'douban' : 'tmdb';
  return { ...tmdb, rating, ratingSource, doubanId: douban?.id || null, source: 'tmdb+douban' };
}

module.exports = { fetchMovieMeta };
