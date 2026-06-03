/**
 * src/meta.js
 * 影片元数据：TMDB 提供封面/演员/简介 + 豆瓣补充评分
 */

let fetchFn;
async function getFetch() {
  if (!fetchFn) { const m = await import('node-fetch'); fetchFn = m.default; }
  return fetchFn;
}

const TMDB_KEY   = process.env.TMDB_API_KEY || '';
const TMDB_BASE  = 'https://api.themoviedb.org/3';
const TMDB_IMG   = 'https://image.tmdb.org/t/p';
const TIMEOUT_MS = 8000;

// ─── 通用 fetch ───────────────────────────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  const fetch = await getFetch();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', ...opts.headers },
      ...opts,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return opts.text ? await res.text() : await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── 豆瓣评分（搜索页解析）────────────────────────────────────────────────────
async function fetchDoubanRating(title, year) {
  try {
    const q   = year ? `${title} ${year}` : title;
    const url = `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(q)}`;
    const html = await apiFetch(url, {
      text: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.douban.com/',
      },
    });

    // 解析评分：<span class="rating_nums">8.5</span>
    const ratingMatch = html.match(/rating_nums[^>]*>([\d.]+)<\/span>/);
    if (ratingMatch) return ratingMatch[1];

    // 备用：<span class="number">8.5</span>
    const numMatch = html.match(/"number">([\d.]+)<\/span>/);
    if (numMatch) return numMatch[1];

    return null;
  } catch (e) {
    console.warn('[豆瓣] rating fetch failed:', e.message);
    return null;
  }
}

// ─── 豆瓣 API（非官方镜像，作为备选）─────────────────────────────────────────
async function fetchDoubanAPI(title, year) {
  try {
    const q   = encodeURIComponent(title);
    const url = `https://movie.douban.com/j/subject_suggest?q=${q}`;
    const data = await apiFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://movie.douban.com/',
      },
    });

    if (!Array.isArray(data) || !data.length) return null;

    // 找年份最接近的结果
    const match = year
      ? data.find(d => d.year === String(year)) || data[0]
      : data[0];

    return {
      doubanId:     match.id,
      doubanRating: match.rating || null,
      doubanTitle:  match.title  || null,
    };
  } catch (e) {
    console.warn('[豆瓣API] failed:', e.message);
    return null;
  }
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────
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

  const genres  = (detail.genres || []).map(g => g.name);
  const runtime = detail.runtime || movie.runtime;

  return {
    tmdbId:        detail.id || movie.id,
    title:         detail.title || movie.title,
    originalTitle: detail.original_title || movie.original_title,
    year:          (detail.release_date || movie.release_date || '').slice(0, 4),
    overview:      detail.overview || movie.overview || '',
    poster:        detail.poster_path   ? `${TMDB_IMG}/w500${detail.poster_path}`   : null,
    backdrop:      detail.backdrop_path ? `${TMDB_IMG}/w1280${detail.backdrop_path}` : null,
    tmdbRating:    (detail.vote_average || movie.vote_average || 0).toFixed(1),
    runtime:       runtime ? `${Math.floor(runtime/60)}h ${runtime%60}m` : '',
    runtimeMin:    runtime || 0,
    genres, directors, cast,
    language:      detail.original_language || '',
    countries:     (detail.production_countries || []).map(c => c.name),
  };
}

// ─── 主入口 ────────────────────────────────────────────────────────────────────
async function fetchMovieMeta(title, year = '') {
  // 并发：TMDB + 豆瓣评分同时请求
  const [tmdbRes, doubanRes] = await Promise.allSettled([
    fetchFromTMDB(title, year),
    fetchDoubanAPI(title, year),
  ]);

  const tmdb   = tmdbRes.status   === 'fulfilled' ? tmdbRes.value   : null;
  const douban = doubanRes.status === 'fulfilled' ? doubanRes.value : null;

  if (!tmdb) {
    return { title, year, overview:'', poster:null, backdrop:null,
             rating:'', ratingSource:'', runtime:'', genres:[],
             directors:[], cast:[], source:'none' };
  }

  // 豆瓣评分优先，降级用 TMDB 评分
  const doubanRating = douban?.doubanRating || null;
  const rating       = doubanRating || tmdb.tmdbRating;
  const ratingSource = doubanRating ? 'douban' : 'tmdb';

  return {
    ...tmdb,
    rating,
    ratingSource,  // 前端用来显示"豆瓣 X.X"或"TMDB X.X"
    doubanId:    douban?.doubanId    || null,
    doubanTitle: douban?.doubanTitle || null,
    source: 'tmdb+douban',
  };
}

module.exports = { fetchMovieMeta };
