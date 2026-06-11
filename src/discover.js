const https = require('https');
const http  = require('http');
const TMDB_KEY  = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p';
const TIMEOUT   = 10000;
const ANIMATION_GENRE_ID = 16;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { 'User-Agent': 'VORTEX-App/1.0', 'Accept': 'application/json' }, timeout: TIMEOUT }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return httpGet(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => data += c); res.on('end', () => resolve(data));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}
async function getJSON(url) { const text = await httpGet(url); if (text.trimStart().startsWith('<')) throw new Error('Got HTML'); return JSON.parse(text); }

function formatItem(item, mediaType) {
  const isTv = mediaType === 'tv' || item.media_type === 'tv';
  return {
    tmdbId: item.id, title: item.title || item.name || '',
    originalTitle: item.original_title || item.original_name || '',
    year: (item.release_date || item.first_air_date || '').slice(0, 4),
    overview: item.overview || '',
    poster:   item.poster_path   ? `${TMDB_IMG}/w500${item.poster_path}`    : null,
    backdrop: item.backdrop_path ? `${TMDB_IMG}/w1280${item.backdrop_path}` : null,
    rating: (item.vote_average || 0).toFixed(1), ratingSource: 'tmdb',
    voteCount: item.vote_count || 0,
    mediaType: isTv ? 'tv' : 'movie', type: isTv ? 'tv' : 'movie',
    genreIds: item.genre_ids || [], popularity: item.popularity || 0,
  };
}

async function discoverContent(mediaType, range = 'year', page = 1) {
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY not set');
  let dateParams = '';
  if (range === 'year') {
    const now = new Date(); const oneYearAgo = new Date(now); oneYearAgo.setFullYear(now.getFullYear() - 1);
    const to = now.toISOString().slice(0,10); const from = oneYearAgo.toISOString().slice(0,10);
    dateParams = mediaType === 'movie' ? `&release_date.gte=${from}&release_date.lte=${to}` : `&first_air_date.gte=${from}&first_air_date.lte=${to}`;
  }
  const endpoint = mediaType === 'movie' ? 'movie' : 'tv';
  const sortBy = mediaType === 'movie' ? 'popularity.desc' : 'popularity.desc';
  const url = `${TMDB_BASE}/discover/${endpoint}?api_key=${TMDB_KEY}&language=zh-CN&sort_by=${sortBy}${dateParams}&vote_count.gte=10&page=${page}`;
  const data = await getJSON(url);
  return { page, totalPages: data.total_pages || 1, totalResults: data.total_results || 0, results: (data.results || []).map(i => formatItem(i, mediaType)) };
}

async function discoverAnimation(range = 'year', page = 1) {
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY not set');
  let dateParams = '';
  if (range === 'year') {
    const now = new Date(); const oneYearAgo = new Date(now); oneYearAgo.setFullYear(now.getFullYear() - 1);
    dateParams = `&release_date.gte=${oneYearAgo.toISOString().slice(0,10)}&release_date.lte=${now.toISOString().slice(0,10)}`;
  }
  const [movData, tvData] = await Promise.allSettled([
    getJSON(`${TMDB_BASE}/discover/movie?api_key=${TMDB_KEY}&language=zh-CN&with_genres=${ANIMATION_GENRE_ID}&sort_by=popularity.desc${dateParams}&vote_count.gte=5&page=${page}`),
    getJSON(`${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&language=zh-CN&with_genres=${ANIMATION_GENRE_ID}&sort_by=popularity.desc${dateParams}&vote_count.gte=5&page=${page}`),
  ]);
  const mov = movData.status === 'fulfilled' ? (movData.value.results || []).map(i => formatItem(i, 'movie')) : [];
  const tv  = tvData.status  === 'fulfilled' ? (tvData.value.results  || []).map(i => formatItem(i, 'tv'))   : [];
  const merged = [...mov, ...tv].sort((a, b) => b.popularity - a.popularity);
  return { page, results: merged, totalResults: merged.length };
}

async function searchMulti(query, page = 1) {
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY not set');
  const url = `${TMDB_BASE}/search/multi?api_key=${TMDB_KEY}&language=zh-CN&query=${encodeURIComponent(query)}&page=${page}&include_adult=false`;
  const data = await getJSON(url);
  const results = (data.results || [])
    .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
    .map(item => { const f = formatItem(item, item.media_type); if ((item.genre_ids||[]).includes(ANIMATION_GENRE_ID)) f.isAnimation = true; return f; });
  return { query, page, totalPages: data.total_pages || 1, totalResults: data.total_results || 0, results };
}

module.exports = { discoverContent, discoverAnimation, searchMulti };
