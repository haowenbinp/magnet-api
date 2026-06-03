/**
 * src/scraper.js
 * 磁力片源抓取 — 使用有官方 JSON API 的数据源，云端稳定可用
 *
 * 数据源:
 *   1. YTS API      — 高质量电影资源，官方 JSON API
 *   2. EZTV API     — 剧集资源，官方 JSON API
 *   3. Jackett 兼容  — apibay (TPB) JSON，带容错
 */

let fetchFn;
async function getFetch() {
  if (!fetchFn) { const m = await import('node-fetch'); fetchFn = m.default; }
  return fetchFn;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};
const TIMEOUT_MS = 12000;

async function safeFetch(url, asText = false) {
  const fetch = await getFetch();
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (asText) return await res.text();
    const text = await res.text();
    // 确保返回的是 JSON，不是 HTML
    if (text.trimStart().startsWith('<')) throw new Error('Got HTML instead of JSON');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function parseQuality(text) {
  const t = text.toUpperCase();
  if (t.includes('2160') || t.includes('4K') || t.includes('UHD')) return '4K';
  if (t.includes('1080')) return '1080P';
  if (t.includes('720'))  return '720P';
  if (t.includes('480'))  return '480P';
  return 'SD';
}
function parseCodec(text) {
  const t = text.toUpperCase();
  if (t.includes('X265') || t.includes('H265') || t.includes('HEVC')) return 'H.265';
  if (t.includes('X264') || t.includes('H264') || t.includes('AVC'))  return 'H.264';
  if (t.includes('AV1')) return 'AV1';
  return '';
}
function parseHDR(text) {
  const t = text.toUpperCase();
  if (t.includes('DOLBY VISION') || t.includes('.DV.')) return 'Dolby Vision';
  if (t.includes('HDR10+')) return 'HDR10+';
  if (t.includes('HDR10'))  return 'HDR10';
  if (t.includes('HDR'))    return 'HDR';
  return '';
}
function parseAudio(text) {
  const t = text.toUpperCase();
  if (t.includes('ATMOS'))  return 'Dolby Atmos';
  if (t.includes('DTS-HD')) return 'DTS-HD MA';
  if (t.includes('TRUEHD')) return 'TrueHD';
  if (t.includes('DTS'))    return 'DTS';
  if (t.includes('AAC'))    return 'AAC';
  if (t.includes('AC3'))    return 'AC3';
  return '';
}
function healthScore(seeds) {
  if (seeds >= 100) return 5;
  if (seeds >= 30)  return 4;
  if (seeds >= 10)  return 3;
  if (seeds >= 3)   return 2;
  return 1;
}
function makeMagnet(hash, name) {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`
    + `&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`
    + `&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce`
    + `&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce`;
}

// ── 数据源 1: YTS API ─────────────────────────────────────────────────────────
// 官方文档: https://yts.mx/api
async function scrapeYTS(query) {
  const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20&sort_by=seeds`;
  try {
    const data = await safeFetch(url);
    const movies = data?.data?.movies || [];
    const results = [];
    for (const movie of movies) {
      for (const torrent of (movie.torrents || [])) {
        const name = `${movie.title} (${movie.year}) ${torrent.quality} ${torrent.type}`;
        const sizeGB = torrent.size || '';
        results.push({
          _source: 'yts',
          title:   name,
          magnet:  makeMagnet(torrent.hash, name),
          size:    sizeGB,
          seeds:   torrent.seeds   || 0,
          leeches: torrent.peers   || 0,
          quality: torrent.quality.includes('2160') ? '4K' : parseQuality(torrent.quality),
          codec:   torrent.video_codec || parseCodec(torrent.type),
          hdr:     torrent.is_repack ? 'HDR' : parseHDR(name),
          audio:   torrent.audio_channels || '',
        });
      }
    }
    console.log(`[YTS] found ${results.length} torrents for "${query}"`);
    return results;
  } catch (e) {
    console.warn('[YTS] failed:', e.message);
    return [];
  }
}

// ── 数据源 2: EZTV API ────────────────────────────────────────────────────────
// 官方文档: https://eztv.re/api/
async function scrapeEZTV(query) {
  const url = `https://eztv.re/api/get-torrents?limit=20&page=1&Keywords=${encodeURIComponent(query)}`;
  try {
    const data = await safeFetch(url);
    const torrents = data?.torrents || [];
    return torrents.map(t => ({
      _source: 'eztv',
      title:   t.title || t.filename,
      magnet:  t.magnet_url || makeMagnet(t.hash, t.title),
      size:    t.size_bytes ? (t.size_bytes / 1073741824).toFixed(2) + ' GB' : '',
      seeds:   parseInt(t.seeds)   || 0,
      leeches: parseInt(t.peers)   || 0,
      quality: parseQuality(t.title),
      codec:   parseCodec(t.title),
      hdr:     parseHDR(t.title),
      audio:   parseAudio(t.title),
    })).filter(t => t.magnet);
  } catch (e) {
    console.warn('[EZTV] failed:', e.message);
    return [];
  }
}

// ── 数据源 3: TPB via apibay ──────────────────────────────────────────────────
async function scrapeTPB(query) {
  // 尝试多个镜像
  const mirrors = [
    `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`,
    `https://apibay.pro/q.php?q=${encodeURIComponent(query)}&cat=0`,
  ];
  for (const url of mirrors) {
    try {
      const data = await safeFetch(url);
      if (!Array.isArray(data)) continue;
      const results = data
        .filter(item => item.info_hash && item.name !== 'No results returned')
        .map(item => {
          const sizeBytes = parseInt(item.size) || 0;
          const sizeStr = sizeBytes > 1073741824
            ? (sizeBytes / 1073741824).toFixed(2) + ' GB'
            : (sizeBytes / 1048576).toFixed(0) + ' MB';
          return {
            _source: 'tpb',
            title:   item.name,
            magnet:  makeMagnet(item.info_hash, item.name),
            size:    sizeStr,
            seeds:   parseInt(item.seeders)  || 0,
            leeches: parseInt(item.leechers) || 0,
            quality: parseQuality(item.name),
            codec:   parseCodec(item.name),
            hdr:     parseHDR(item.name),
            audio:   parseAudio(item.name),
          };
        });
      console.log(`[TPB] found ${results.length} via ${url}`);
      return results;
    } catch (e) {
      console.warn(`[TPB] ${url} failed:`, e.message);
    }
  }
  return [];
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
async function searchMagnets(query, page = 1) {
  console.log(`[scraper] searching: "${query}"`);

  const [rYTS, rEZTV, rTPB] = await Promise.allSettled([
    scrapeYTS(query),
    scrapeEZTV(query),
    scrapeTPB(query),
  ]);

  let results = [
    ...(rYTS.status  === 'fulfilled' ? rYTS.value  : []),
    ...(rEZTV.status === 'fulfilled' ? rEZTV.value : []),
    ...(rTPB.status  === 'fulfilled' ? rTPB.value  : []),
  ].filter(r => r.magnet);

  // 去重（同 hash）
  const seen = new Set();
  results = results.filter(r => {
    const hash = (r.magnet.match(/btih:([a-fA-F0-9]+)/i) || [])[1] || r.title;
    if (seen.has(hash)) return false;
    seen.add(hash); return true;
  });

  // 排序：种子数降序
  results.sort((a, b) => b.seeds - a.seeds);

  console.log(`[scraper] total ${results.length} results`);

  return results.map(r => ({
    source:  r._source,
    title:   r.title,
    magnet:  r.magnet,
    size:    r.size,
    seeds:   r.seeds,
    leeches: r.leeches,
    health:  healthScore(r.seeds),
    quality: r.quality,
    codec:   r.codec,
    hdr:     r.hdr,
    audio:   r.audio,
  }));
}

module.exports = { searchMagnets };
