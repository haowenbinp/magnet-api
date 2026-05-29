/**
 * src/meta.js
 * 影片元数据抓取 — 封面、演员、简介、时长、评分
 *
 * 数据源: The Movie Database (TMDB) 公开 API
 *   - 免费注册获取 API Key: https://www.themoviedb.org/settings/api
 *   - 将 Key 填入 .env 文件: TMDB_API_KEY=你的key
 *
 * 如未配置 Key，自动降级到 OMDB (每天 1000 次免费)
 */

const fetch = require('node-fetch');

// 从环境变量读取（生产中通过 .env 注入）
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const OMDB_KEY = process.env.OMDB_API_KEY || '';

const TMDB_BASE   = 'https://api.themoviedb.org/3';
const TMDB_IMAGE  = 'https://image.tmdb.org/t/p';
const OMDB_BASE   = 'https://www.omdbapi.com';

const TIMEOUT_MS  = 8000;

async function apiFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────

async function fetchFromTMDB(title, year) {
  if (!TMDB_KEY) return null;

  // 1. 搜索影片
  const yearParam = year ? `&year=${year}` : '';
  const searchUrl =
    `${TMDB_BASE}/search/movie?api_key=${TMDB_KEY}` +
    `&query=${encodeURIComponent(title)}` +
    `&language=zh-CN${yearParam}`;

  let searchData;
  try {
    searchData = await apiFetch(searchUrl);
  } catch (e) {
    console.warn('[TMDB] search failed:', e.message);
    return null;
  }

  const movie = searchData.results && searchData.results[0];
  if (!movie) return null;

  // 2. 获取详情 + 演职员表
  const detailUrl =
    `${TMDB_BASE}/movie/${movie.id}?api_key=${TMDB_KEY}` +
    `&language=zh-CN&append_to_response=credits,images`;

  let detail;
  try {
    detail = await apiFetch(detailUrl);
  } catch (e) {
    console.warn('[TMDB] detail failed:', e.message);
    // 降级：用搜索结果
    detail = movie;
  }

  // 3. 提取演员（前 8 名）
  const cast = (detail.credits && detail.credits.cast
    ? detail.credits.cast.slice(0, 8)
    : []
  ).map(c => ({
    name:      c.name,
    character: c.character,
    photo:     c.profile_path
      ? `${TMDB_IMAGE}/w185${c.profile_path}`
      : null,
  }));

  // 4. 提取导演
  const directors = detail.credits && detail.credits.crew
    ? detail.credits.crew
        .filter(c => c.job === 'Director')
        .map(c => c.name)
    : [];

  // 5. 类型标签
  const genres = (detail.genres || []).map(g => g.name);

  // 6. 运行时长转为 HH:MM
  const runtime = detail.runtime || movie.runtime;
  const runtimeStr = runtime
    ? `${Math.floor(runtime / 60)}h ${runtime % 60}m`
    : '';

  return {
    tmdbId:       detail.id || movie.id,
    title:        detail.title || movie.title,
    originalTitle:detail.original_title || movie.original_title,
    year:         (detail.release_date || movie.release_date || '').slice(0, 4),
    overview:     detail.overview || movie.overview || '',
    poster:       detail.poster_path
      ? `${TMDB_IMAGE}/w500${detail.poster_path}`
      : null,
    backdrop:     detail.backdrop_path
      ? `${TMDB_IMAGE}/w1280${detail.backdrop_path}`
      : null,
    rating:       (detail.vote_average || movie.vote_average || 0).toFixed(1),
    voteCount:    detail.vote_count || movie.vote_count || 0,
    runtime:      runtimeStr,
    runtimeMin:   runtime || 0,
    genres,
    directors,
    cast,
    language:     detail.original_language || '',
    countries:    (detail.production_countries || []).map(c => c.name),
    source:       'tmdb',
  };
}

// ─── OMDB 降级 ────────────────────────────────────────────────────────────────

async function fetchFromOMDB(title, year) {
  const key = OMDB_KEY || 'trilogy'; // trilogy 是一个公开演示 key，有限额
  const yearParam = year ? `&y=${year}` : '';
  const url =
    `${OMDB_BASE}/?apikey=${key}` +
    `&t=${encodeURIComponent(title)}${yearParam}&plot=full`;

  let data;
  try {
    data = await apiFetch(url);
  } catch (e) {
    console.warn('[OMDB] fetch failed:', e.message);
    return null;
  }

  if (data.Response === 'False') return null;

  const runtime = parseInt(data.Runtime) || 0;
  const runtimeStr = runtime
    ? `${Math.floor(runtime / 60)}h ${runtime % 60}m`
    : data.Runtime || '';

  const cast = (data.Actors || '')
    .split(',')
    .map(n => n.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map(name => ({ name, character: '', photo: null }));

  const rating = data.Ratings
    ? (data.Ratings.find(r => r.Source === 'Internet Movie Database') || {}).Value || ''
    : '';

  return {
    title:        data.Title,
    originalTitle:data.Title,
    year:         data.Year,
    overview:     data.Plot || '',
    poster:       data.Poster !== 'N/A' ? data.Poster : null,
    backdrop:     null,
    rating:       rating.replace('/10', ''),
    voteCount:    0,
    runtime:      runtimeStr,
    runtimeMin:   runtime,
    genres:       (data.Genre || '').split(',').map(g => g.trim()).filter(Boolean),
    directors:    (data.Director || '').split(',').map(d => d.trim()).filter(Boolean),
    cast,
    language:     data.Language || '',
    countries:    (data.Country || '').split(',').map(c => c.trim()).filter(Boolean),
    source:       'omdb',
  };
}

// ─── 主入口 ────────────────────────────────────────────────────────────────────

async function fetchMovieMeta(title, year = '') {
  // 优先 TMDB（中文数据更好），其次 OMDB
  let meta = await fetchFromTMDB(title, year);
  if (!meta) {
    meta = await fetchFromOMDB(title, year);
  }

  if (!meta) {
    return {
      title,
      year,
      overview:  '',
      poster:    null,
      backdrop:  null,
      rating:    '',
      runtime:   '',
      genres:    [],
      directors: [],
      cast:      [],
      source:    'none',
    };
  }

  return meta;
}

module.exports = { fetchMovieMeta };
