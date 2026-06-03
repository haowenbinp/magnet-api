/**
 * src/meta.js — 零依赖版本，支持电影(movie)和剧集(tv)
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
      ? data.find(d => d.year === String(year)) || data[0]
      : data[0];
    if (match?.rating) {
      return { rating: String(match.rating), id: match.id, title: match.title };
    }
  } catch (e) {
    console.warn('[豆瓣] failed:', e.message);
  }
  return null;
}

// ── TMDB 电影 ─────────────────────────────────────────────────────────────────
async function fetchMovie(title, year) {
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
    } catch (e) {}

    const cast = (detail.credits?.cast || []).slice(0, 10).map(c => ({
      name: c.name, character: c.character,
      photo: c.profile_path ? `${TMDB_IMG}/w185${c.profile_path}` : null,
    }));
    const directors = (detail.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name);
    const runtime = detail.runtime || movie.runtime;

    return {
      mediaType:     'movie',
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
    console.warn('[TMDB movie] failed:', e.message);
    return null;
  }
}

// ── TMDB 剧集 ─────────────────────────────────────────────────────────────────
async function fetchTV(title, year) {
  if (!TMDB_KEY) return null;
  try {
    const yearParam = year ? `&first_air_date_year=${year}` : '';
    const searchData = await getJSON(
      `${TMDB_BASE}/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&language=zh-CN${yearParam}`
    );
    const show = searchData.results?.[0];
    if (!show) return null;

    let detail = show;
    try {
      detail = await getJSON(
        `${TMDB_BASE}/tv/${show.id}?api_key=${TMDB_KEY}&language=zh-CN&append_to_response=credits,aggregate_credits`
      );
    } catch (e) {}

    // 演员：优先 aggregate_credits（更全）
    const castSrc = detail.aggregate_credits?.cast || detail.credits?.cast || [];
    const cast = castSrc.slice(0, 10).map(c => ({
      name: c.name, character: (c.roles?.[0]?.character || c.character || ''),
      photo: c.profile_path ? `${TMDB_IMG}/w185${c.profile_path}` : null,
    }));

    // 创作者
    const creators = (detail.created_by || []).map(c => c.name);

    // 季数/集数信息
    const seasons  = detail.number_of_seasons  || 0;
    const episodes = detail.number_of_episodes || 0;
    const statusMap = {
      'Returning Series': '连载中',
      'Ended': '已完结',
      'Canceled': '已取消',
      'In Production': '制作中',
    };
    const statusCN = statusMap[detail.status] || detail.status || '';

    // 单集时长
    const epRuntime = detail.episode_run_time?.[0] || 0;
    const runtimeStr = epRuntime ? `${epRuntime}分钟/集` : '';

    return {
      mediaType:     'tv',
      tmdbId:        detail.id || show.id,
      title:         detail.name || show.name,
      originalTitle: detail.original_name || show.original_name,
      year:          (detail.first_air_date || show.first_air_date || '').slice(0, 4),
      overview:      detail.overview || show.overview || '',
      poster:        detail.poster_path   ? `${TMDB_IMG}/w500${detail.poster_path}`    : null,
      backdrop:      detail.backdrop_path ? `${TMDB_IMG}/w1280${detail.backdrop_path}` : null,
      tmdbRating:    (detail.vote_average || show.vote_average || 0).toFixed(1),
      runtime:       runtimeStr,
      runtimeMin:    epRuntime,
      seasons, episodes, statusCN,
      genres:        (detail.genres || []).map(g => g.name),
      directors:     creators,
      cast,
      language:  detail.original_language || '',
      countries: (detail.production_countries || []).map(c => c.name),
      networks:  (detail.networks || []).map(n => n.name),
    };
  } catch (e) {
    console.warn('[TMDB tv] failed:', e.message);
    return null;
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
async function fetchMovieMeta(title, year = '', type = 'movie') {
  const fetchFn = type === 'tv' ? fetchTV : fetchMovie;

  const [tmdbRes, doubanRes] = await Promise.allSettled([
    fetchFn(title, year),
    fetchDoubanRating(title, year),
  ]);

  const tmdb   = tmdbRes.status   === 'fulfilled' ? tmdbRes.value   : null;
  const douban = doubanRes.status === 'fulfilled' ? doubanRes.value : null;

  if (!tmdb) {
    return { title, year, overview:'', poster:null, backdrop:null,
             rating:'', ratingSource:'none', runtime:'', genres:[],
             directors:[], cast:[], source:'none', mediaType: type };
  }

  const rating       = douban?.rating || tmdb.tmdbRating;
  const ratingSource = douban?.rating ? 'douban' : 'tmdb';

  return { ...tmdb, rating, ratingSource, doubanId: douban?.id || null, source: 'tmdb+douban' };
}

module.exports = { fetchMovieMeta };
