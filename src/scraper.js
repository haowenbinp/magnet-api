/**
 * src/scraper.js
 * 从公开磁力索引站抓取磁力链接
 *
 * 数据源优先级:
 *   1. 1337x.to     — 综合片源最全
 *   2. nyaa.si      — 日漫 / 亚洲内容
 *   3. thepiratebay.org (镜像)
 *
 * 依赖: cheerio (HTML 解析)、node-fetch (HTTP)
 */

const fetch   = require('node-fetch');
const cheerio = require('cheerio');

// ─── 请求公共配置 ──────────────────────────────────────────────────────────────
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const TIMEOUT_MS = 12000;

async function fetchHTML(targetUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, {
      headers: HEADERS,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${targetUrl}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/** 从文件名 / 标题中提取画质信息 */
function parseQuality(text) {
  const t = text.toUpperCase();
  if (t.includes('2160') || t.includes('4K') || t.includes('UHD'))  return '4K';
  if (t.includes('1080'))  return '1080P';
  if (t.includes('720'))   return '720P';
  if (t.includes('480'))   return '480P';
  return 'SD';
}

/** 从文件名中提取编码格式 */
function parseCodec(text) {
  const t = text.toUpperCase();
  if (t.includes('X265') || t.includes('H.265') || t.includes('HEVC')) return 'H.265';
  if (t.includes('X264') || t.includes('H.264') || t.includes('AVC'))  return 'H.264';
  if (t.includes('AV1'))  return 'AV1';
  return '';
}

/** 从文件名中提取 HDR 信息 */
function parseHDR(text) {
  const t = text.toUpperCase();
  if (t.includes('DOLBY VISION') || t.includes('DV')) return 'Dolby Vision';
  if (t.includes('HDR10PLUS') || t.includes('HDR10+')) return 'HDR10+';
  if (t.includes('HDR10')) return 'HDR10';
  if (t.includes('HDR'))   return 'HDR';
  return '';
}

/** 从文件名中提取音频格式 */
function parseAudio(text) {
  const t = text.toUpperCase();
  if (t.includes('DOLBY ATMOS') || t.includes('ATMOS')) return 'Dolby Atmos';
  if (t.includes('DTS-HD'))  return 'DTS-HD MA';
  if (t.includes('DTS'))     return 'DTS';
  if (t.includes('TRUEHD'))  return 'TrueHD';
  if (t.includes('AAC'))     return 'AAC';
  if (t.includes('AC3'))     return 'AC3';
  return '';
}

/** 格式化文件大小为可读字符串 */
function formatSize(raw) {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

/** 规范化磁力链接（确保包含 dn 参数） */
function normalizeMagnet(magnet, title) {
  if (!magnet || !magnet.startsWith('magnet:')) return null;
  if (!magnet.includes('&dn=') && title) {
    magnet += '&dn=' + encodeURIComponent(title);
  }
  return magnet;
}

// ─── 数据源 1: 1337x ──────────────────────────────────────────────────────────
const BASE_1337X = 'https://www.1337x.to';

async function scrape1337x(query, page = 1) {
  const searchUrl = `${BASE_1337X}/search/${encodeURIComponent(query)}/${page}/`;
  let html;
  try {
    html = await fetchHTML(searchUrl);
  } catch (e) {
    console.warn('[1337x] fetch failed:', e.message);
    return [];
  }

  const $ = cheerio.load(html);
  const rows = [];

  $('table.table-list tbody tr').each((i, el) => {
    const nameEl  = $(el).find('.name a').last();
    const title   = nameEl.text().trim();
    const detailPath = nameEl.attr('href');
    const size    = $(el).find('td.size').text().trim().replace(/\n.*/,'').trim();
    const seeds   = parseInt($(el).find('td.seeds').text().trim()) || 0;
    const leeches = parseInt($(el).find('td.leeches').text().trim()) || 0;

    if (!title || !detailPath) return;

    rows.push({
      _source: '1337x',
      _detailUrl: BASE_1337X + detailPath,
      title,
      size: formatSize(size),
      seeds,
      leeches,
      quality: parseQuality(title),
      codec: parseCodec(title),
      hdr: parseHDR(title),
      audio: parseAudio(title),
      magnet: null, // 需要二次请求详情页获取
    });
  });

  return rows;
}

/** 从 1337x 详情页抓取磁力链接 */
async function fetch1337xMagnet(detailUrl) {
  try {
    const html = await fetchHTML(detailUrl);
    const $ = cheerio.load(html);
    const magnet = $('a[href^="magnet:"]').first().attr('href');
    return magnet || null;
  } catch (e) {
    console.warn('[1337x] magnet fetch failed:', e.message);
    return null;
  }
}

// ─── 数据源 2: nyaa.si ────────────────────────────────────────────────────────
const BASE_NYAA = 'https://nyaa.si';

async function scrapeNyaa(query, page = 1) {
  const searchUrl = `${BASE_NYAA}/?f=0&c=0_0&q=${encodeURIComponent(query)}&p=${page}`;
  let html;
  try {
    html = await fetchHTML(searchUrl);
  } catch (e) {
    console.warn('[nyaa] fetch failed:', e.message);
    return [];
  }

  const $ = cheerio.load(html);
  const rows = [];

  $('table.torrent-list tbody tr').each((i, el) => {
    const nameEl = $(el).find('td:nth-child(2) a').last();
    const title  = nameEl.text().trim();
    const magnet = $(el).find('a[href^="magnet:"]').attr('href');
    const size   = $(el).find('td:nth-child(4)').text().trim();
    const seeds  = parseInt($(el).find('td:nth-child(6)').text().trim()) || 0;
    const leeches = parseInt($(el).find('td:nth-child(7)').text().trim()) || 0;

    if (!title || !magnet) return;

    rows.push({
      _source: 'nyaa',
      title,
      size: formatSize(size),
      seeds,
      leeches,
      quality: parseQuality(title),
      codec: parseCodec(title),
      hdr: parseHDR(title),
      audio: parseAudio(title),
      magnet: normalizeMagnet(magnet, title),
    });
  });

  return rows;
}

// ─── 数据源 3: The Pirate Bay (镜像) ─────────────────────────────────────────
const BASE_TPB = 'https://apibay.org';

async function scrapeTPB(query) {
  // apibay 提供 JSON API，无需解析 HTML
  const searchUrl = `${BASE_TPB}/q.php?q=${encodeURIComponent(query)}&cat=0`;
  let data;
  try {
    const res = await fetch(searchUrl, { headers: HEADERS });
    data = await res.json();
  } catch (e) {
    console.warn('[TPB] fetch failed:', e.message);
    return [];
  }

  if (!Array.isArray(data)) return [];

  return data
    .filter(item => item.info_hash && item.name !== 'No results returned')
    .map(item => {
      const magnet =
        `magnet:?xt=urn:btih:${item.info_hash}` +
        `&dn=${encodeURIComponent(item.name)}` +
        `&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce` +
        `&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce`;

      const sizeBytes = parseInt(item.size) || 0;
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(0);
      const sizeStr = sizeBytes > 1073741824
        ? (sizeBytes / 1073741824).toFixed(2) + ' GB'
        : sizeMB + ' MB';

      return {
        _source: 'tpb',
        title: item.name,
        size: sizeStr,
        seeds: parseInt(item.seeders) || 0,
        leeches: parseInt(item.leechers) || 0,
        quality: parseQuality(item.name),
        codec: parseCodec(item.name),
        hdr: parseHDR(item.name),
        audio: parseAudio(item.name),
        magnet,
      };
    });
}

// ─── 健康度评分 ────────────────────────────────────────────────────────────────
function healthScore(seeds, leeches) {
  if (seeds >= 100) return 5;
  if (seeds >= 30)  return 4;
  if (seeds >= 10)  return 3;
  if (seeds >= 3)   return 2;
  return 1;
}

// ─── 主入口 ────────────────────────────────────────────────────────────────────
async function searchMagnets(query, page = 1) {
  console.log(`[scraper] searching: "${query}" ...`);

  // 并发抓取三个源
  const [r1337x, rNyaa, rTPB] = await Promise.allSettled([
    scrape1337x(query, page),
    scrapeNyaa(query, page),
    scrapeTPB(query),
  ]);

  let results = [
    ...(r1337x.status === 'fulfilled' ? r1337x.value : []),
    ...(rNyaa.status  === 'fulfilled' ? rNyaa.value  : []),
    ...(rTPB.status   === 'fulfilled' ? rTPB.value   : []),
  ];

  // 1337x 需要二次请求详情页拿磁力链接（并发，最多 5 个，避免被封）
  const need = results.filter(r => r._source === '1337x' && !r.magnet).slice(0, 5);
  await Promise.allSettled(
    need.map(async r => {
      r.magnet = await fetch1337xMagnet(r._detailUrl);
      if (r.magnet) r.magnet = normalizeMagnet(r.magnet, r.title);
    })
  );

  // 过滤掉没有磁力链接的结果
  results = results.filter(r => r.magnet);

  // 按种子数排序
  results.sort((a, b) => b.seeds - a.seeds);

  // 格式化输出，移除内部字段
  return results.map(r => ({
    source:   r._source,
    title:    r.title,
    magnet:   r.magnet,
    size:     r.size,
    seeds:    r.seeds,
    leeches:  r.leeches,
    health:   healthScore(r.seeds, r.leeches),  // 1-5
    quality:  r.quality,
    codec:    r.codec,
    hdr:      r.hdr,
    audio:    r.audio,
  }));
}

module.exports = { searchMagnets };
