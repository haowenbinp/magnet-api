/**
 * src/meta.js
 * TMDB 影片元数据 + 豆瓣评分（通过豆瓣搜索 API 获取）
 */

let fetchFn;
async function getFetch() {
  if (!fetchFn) { const m = await import('node-fetch'); fetchFn = m.default; }
  return fetchFn;
}

const TMDB_KEY  = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p';
const TIMEOUT   = 8000;

async function apiFetch(url, opts = {}) {
  const fetch = await getFetch();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (opts.text) return await res.text();
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── 豆瓣评分：通过豆瓣 subject_suggest 接口 ──────────────────────────────────
async function fetchDoubanRating(title, year) {
  try {
    // 方案1：豆瓣 suggest API（返回包含评分的 JSON）
    const url = `https://movie.douban.com/j/subject_suggest?q=${encodeURIComponent(title)}`;
    const data = await apiFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://movie.douban.com/',
        'Accept': 'application/json, text/javascript, */*',
      },
    });

    if (!Array.isArray(data) || !data.length) return null;

    // 优先匹配年份
    const match = year
      ? data.find(d => d.year === String(year) && d.type === 'movie')
        || data.find(d => d.type === 'movie')
        || data[0]
      : data.find(d => d.type === 'movie') || data[0];

    if (match?.rating) {
      console.log(`[豆瓣] "${title}" → ${match.rating} (id:${match.id})`);
      return { rating: match.rating, id: match.id, title: match.title };
    }
    return null;
  } catch (e) {
    console.warn('[豆瓣] suggest failed:', e.message);
  }

  // 方案2：通过豆瓣 API v2 镜像
  try {
    const url = `https://douban.8610000.xyz/v2/movie/search?q=${encodeURIComponent(title)}&count=3`;
    const data = await apiFetch(url);
    const subjects = data?.subjects || [];
    const match = year
      ? subjects.find(s => s.year === String(year)) || subjects[0]
      : subjects[0];
    if (match?.rating?.average) {
      console.log(`[豆瓣镜像] "${title}" → ${match.rating.average}`);
      return { rating: String(match.rating.average), id: match.id, title: match.title };
    }
  } catch (e) {
    console.warn('[豆瓣镜像] failed:', e.message);
  }

  return null;
}

// ── TMDB ──────────────────────────────────────────────────────────────────────
async function fetchFromTMDB(title, year) {
  if (!TMDB_KEY) return null;

  const yearParam = year ? `&year=${year}` : '';
  const searchUrl = `${TMDB_BASE}/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&language=zh-CN${yearParam}`;

  let searchData;
  try { searchData = await apiFetch(searchUrl); }
  catch (e) { console.warn('[TMDB] search failed:', e.message); return null; }

  const movie = searchData.results?.[0];
  if (!movie) return null;

  const detailUrl = `${TMDB_BASE}/movie/${movie.id}?api_key=${TMDB_KEY}&language=zh-CN&append_to_response=credits`;
  let detail;
  try { detail = await apiFetch(detailUrl); }
  catch (e) { detail = movie; }

  const cast = (detail.credits?.cast || []).slice(0, 10).map(c => ({
    name:      c.name,
    character: c.character,
    photo:     c.profile_path ? `${TMDB_IMG}/w185${c.profile_path}` : null,
  }));

  const directors = (detail.credits?.crew || [])
    .filter(c => c.job === 'Director').map(c => c.name);

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
    directors,
    cast,
    language:  detail.original_language || '',
    countries: (detail.production_countries || []).map(c => c.name),
  };
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
             rating:'', ratingSource:'none', runtime:'',
             genres:[], directors:[], cast:[], source:'none' };
  }

  const rating       = douban?.rating || tmdb.tmdbRating;
  const ratingSource = douban?.rating ? 'douban' : 'tmdb';

  return {
    ...tmdb,
    rating,
    ratingSource,
    doubanId:    douban?.id    || null,
    doubanTitle: douban?.title || null,
    source: 'tmdb+douban',
  };
}

module.exports = { fetchMovieMeta };
