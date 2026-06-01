/**
 * src/scraper.js — 使用 ESM-compatible fetch (node-fetch v3)
 */

let fetchFn;
async function getFetch() {
  if (!fetchFn) {
    const mod = await import('node-fetch');
    fetchFn = mod.default;
  }
  return fetchFn;
}

let cheerio;
async function getCheerio() {
  if (!cheerio) cheerio = require('cheerio');
  return cheerio;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const TIMEOUT_MS = 12000;

async function fetchHTML(targetUrl) {
  const fetch = await getFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, { headers: HEADERS, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${targetUrl}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

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
  if (t.includes('X265') || t.includes('H.265') || t.includes('HEVC')) return 'H.265';
  if (t.includes('X264') || t.includes('H.264') || t.includes('AVC'))  return 'H.264';
  if (t.includes('AV1')) return 'AV1';
  return '';
}
function parseHDR(text) {
  const t = text.toUpperCase();
  if (t.includes('DOLBY VISION') || t.includes(' DV ')) return 'Dolby Vision';
  if (t.includes('HDR10+')) return 'HDR10+';
  if (t.includes('HDR10'))  return 'HDR10';
  if (t.includes('HDR'))    return 'HDR';
  return '';
}
function parseAudio(text) {
  const t = text.toUpperCase();
  if (t.includes('ATMOS'))   return 'Dolby Atmos';
  if (t.includes('DTS-HD'))  return 'DTS-HD MA';
  if (t.includes('TRUEHD'))  return 'TrueHD';
  if (t.includes('DTS'))     return 'DTS';
  if (t.includes('AAC'))     return 'AAC';
  if (t.includes('AC3'))     return 'AC3';
  return '';
}
function normalizeMagnet(magnet, title) {
  if (!magnet || !magnet.startsWith('magnet:')) return null;
  if (!magnet.includes('&dn=') && title) magnet += '&dn=' + encodeURIComponent(title);
  return magnet;
}
function healthScore(seeds) {
  if (seeds >= 100) return 5;
  if (seeds >= 30)  return 4;
  if (seeds >= 10)  return 3;
  if (seeds >= 3)   return 2;
  return 1;
}

// ── TPB (JSON API, 最稳定) ────────────────────────────────────────────────────
async function scrapeTPB(query) {
  const fetch = await getFetch();
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter(item => item.info_hash && item.name !== 'No results returned')
      .map(item => {
        const magnet = `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`;
        const sizeBytes = parseInt(item.size) || 0;
        const sizeStr = sizeBytes > 1073741824
          ? (sizeBytes / 1073741824).toFixed(2) + ' GB'
          : (sizeBytes / 1048576).toFixed(0) + ' MB';
        return {
          _source: 'tpb', title: item.name, size: sizeStr,
          seeds: parseInt(item.seeders) || 0, leeches: parseInt(item.leechers) || 0,
          quality: parseQuality(item.name), codec: parseCodec(item.name),
          hdr: parseHDR(item.name), audio: parseAudio(item.name), magnet,
        };
      });
  } catch (e) {
    console.warn('[TPB] failed:', e.message);
    return [];
  }
}

// ── nyaa ─────────────────────────────────────────────────────────────────────
async function scrapeNyaa(query, page = 1) {
  const $ = await getCheerio();
  const url = `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(query)}&p=${page}`;
  try {
    const html = await fetchHTML(url);
    const doc = $.load(html);
    const rows = [];
    doc('table.torrent-list tbody tr').each((i, el) => {
      const nameEl = doc(el).find('td:nth-child(2) a').last();
      const title  = nameEl.text().trim();
      const magnet = doc(el).find('a[href^="magnet:"]').attr('href');
      const size   = doc(el).find('td:nth-child(4)').text().trim();
      const seeds  = parseInt(doc(el).find('td:nth-child(6)').text().trim()) || 0;
      const leeches = parseInt(doc(el).find('td:nth-child(7)').text().trim()) || 0;
      if (!title || !magnet) return;
      rows.push({ _source: 'nyaa', title, size, seeds, leeches,
        quality: parseQuality(title), codec: parseCodec(title),
        hdr: parseHDR(title), audio: parseAudio(title),
        magnet: normalizeMagnet(magnet, title) });
    });
    return rows;
  } catch (e) {
    console.warn('[nyaa] failed:', e.message);
    return [];
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────────
async function searchMagnets(query, page = 1) {
  const [rTPB, rNyaa] = await Promise.allSettled([
    scrapeTPB(query),
    scrapeNyaa(query, page),
  ]);
  let results = [
    ...(rTPB.status  === 'fulfilled' ? rTPB.value  : []),
    ...(rNyaa.status === 'fulfilled' ? rNyaa.value : []),
  ].filter(r => r.magnet);
  results.sort((a, b) => b.seeds - a.seeds);
  return results.map(r => ({
    source: r._source, title: r.title, magnet: r.magnet,
    size: r.size, seeds: r.seeds, leeches: r.leeches,
    health: healthScore(r.seeds), quality: r.quality,
    codec: r.codec, hdr: r.hdr, audio: r.audio,
  }));
}

module.exports = { searchMagnets };
