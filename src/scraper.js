/**
 * src/scraper.js — 零依赖版本，使用 Node.js 内置 https 模块
 */
const https = require('https');
const http  = require('http');

const TIMEOUT_MS = 12000;

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        ...extraHeaders,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

async function getJSON(url, headers = {}) {
  const text = await httpGet(url, headers);
  if (text.trimStart().startsWith('<')) throw new Error('Got HTML instead of JSON');
  return JSON.parse(text);
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function parseQuality(t) {
  t = t.toUpperCase();
  if (t.includes('2160') || t.includes('4K') || t.includes('UHD')) return '4K';
  if (t.includes('1080')) return '1080P';
  if (t.includes('720'))  return '720P';
  if (t.includes('480'))  return '480P';
  return 'SD';
}
function parseCodec(t) {
  t = t.toUpperCase();
  if (t.includes('X265') || t.includes('H265') || t.includes('HEVC')) return 'H.265';
  if (t.includes('X264') || t.includes('H264') || t.includes('AVC'))  return 'H.264';
  if (t.includes('AV1')) return 'AV1';
  return '';
}
function parseHDR(t) {
  t = t.toUpperCase();
  if (t.includes('DOLBY VISION') || t.includes('.DV.')) return 'Dolby Vision';
  if (t.includes('HDR10+')) return 'HDR10+';
  if (t.includes('HDR10'))  return 'HDR10';
  if (t.includes('HDR'))    return 'HDR';
  return '';
}
function parseAudio(t) {
  t = t.toUpperCase();
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

// ── YTS API ───────────────────────────────────────────────────────────────────
async function scrapeYTS(query) {
  try {
    const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20&sort_by=seeds`;
    const data = await getJSON(url);
    const movies = data?.data?.movies || [];
    const results = [];
    for (const movie of movies) {
      for (const t of (movie.torrents || [])) {
        const name = `${movie.title} (${movie.year}) ${t.quality} ${t.type}`;
        results.push({
          _source: 'yts',
          title:   name,
          magnet:  makeMagnet(t.hash, name),
          size:    t.size || '',
          seeds:   t.seeds  || 0,
          leeches: t.peers  || 0,
          quality: t.quality.includes('2160') ? '4K' : parseQuality(t.quality),
          codec:   parseCodec(t.type + ' ' + (t.video_codec || '')),
          hdr:     parseHDR(name),
          audio:   t.audio_channels || '',
        });
      }
    }
    console.log(`[YTS] ${results.length} results for "${query}"`);
    return results;
  } catch (e) {
    console.warn('[YTS] failed:', e.message);
    return [];
  }
}

// ── EZTV API ──────────────────────────────────────────────────────────────────
async function scrapeEZTV(query) {
  try {
    const url = `https://eztv.re/api/get-torrents?limit=20&page=1&Keywords=${encodeURIComponent(query)}`;
    const data = await getJSON(url);
    const torrents = data?.torrents || [];
    console.log(`[EZTV] ${torrents.length} results for "${query}"`);
    return torrents.map(t => ({
      _source: 'eztv',
      title:   t.title || t.filename || '',
      magnet:  t.magnet_url || makeMagnet(t.hash, t.title),
      size:    t.size_bytes ? (t.size_bytes / 1073741824).toFixed(2) + ' GB' : '',
      seeds:   parseInt(t.seeds)  || 0,
      leeches: parseInt(t.peers)  || 0,
      quality: parseQuality(t.title || ''),
      codec:   parseCodec(t.title  || ''),
      hdr:     parseHDR(t.title    || ''),
      audio:   parseAudio(t.title  || ''),
    })).filter(t => t.magnet && t.title);
  } catch (e) {
    console.warn('[EZTV] failed:', e.message);
    return [];
  }
}

// ── TPB via apibay ────────────────────────────────────────────────────────────
async function scrapeTPB(query) {
  const mirrors = [
    `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`,
    `https://apibay.pro/q.php?q=${encodeURIComponent(query)}&cat=0`,
  ];
  for (const url of mirrors) {
    try {
      const data = await getJSON(url);
      if (!Array.isArray(data)) continue;
      const results = data
        .filter(item => item.info_hash && item.name !== 'No results returned')
        .map(item => {
          const bytes = parseInt(item.size) || 0;
          return {
            _source: 'tpb',
            title:   item.name,
            magnet:  makeMagnet(item.info_hash, item.name),
            size:    bytes > 1073741824 ? (bytes/1073741824).toFixed(2)+' GB' : (bytes/1048576).toFixed(0)+' MB',
            seeds:   parseInt(item.seeders)  || 0,
            leeches: parseInt(item.leechers) || 0,
            quality: parseQuality(item.name),
            codec:   parseCodec(item.name),
            hdr:     parseHDR(item.name),
            audio:   parseAudio(item.name),
          };
        });
      console.log(`[TPB] ${results.length} results via ${url}`);
      return results;
    } catch (e) {
      console.warn(`[TPB] ${url} failed:`, e.message);
    }
  }
  return [];
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
async function searchMagnets(query) {
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
  ].filter(r => r.magnet && r.title);

  // 去重
  const seen = new Set();
  results = results.filter(r => {
    const key = (r.magnet.match(/btih:([a-fA-F0-9]+)/i)||[])[1] || r.title;
    if (seen.has(key.toLowerCase())) return false;
    seen.add(key.toLowerCase()); return true;
  });

  results.sort((a, b) => b.seeds - a.seeds);
  console.log(`[scraper] total ${results.length} after dedup`);

  return results.map(r => ({
    source: r._source, title: r.title, magnet: r.magnet,
    size: r.size, seeds: r.seeds, leeches: r.leeches,
    health: healthScore(r.seeds), quality: r.quality,
    codec: r.codec, hdr: r.hdr, audio: r.audio,
  }));
}

module.exports = { searchMagnets };
