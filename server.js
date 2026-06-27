const express      = require('express');
const path         = require('path');
const { parse }    = require('node-html-parser');
const mysql        = require('mysql2/promise');
const nodemailer   = require('nodemailer');
const cron         = require('node-cron');

const NEWS_BASE = 'https://edtechhub.com';

// MySQL 연결 풀
const db = mysql.createPool({
  host    : 'localhost',
  user    : 'edtechhub',
  password: 'edtech2024!',
  database: 'edtechhub',
  waitForConnections: true,
  connectionLimit   : 10,
});

// Microsoft 365 메일 전송
const mailer = nodemailer.createTransport({
  host  : 'smtp.office365.com',
  port  : 587,
  secure: false,
  auth  : {
    user: 'sungsoo@dohegroup.com',
    pass: process.env.SMTP_PASS,
  },
  tls: { ciphers: 'SSLv3' },
});

const app   = express();
const TOKEN = process.env.EVENTBRITE_TOKEN;
const ORG_ID= process.env.EVENTBRITE_ORG_ID;
const PORT  = process.env.PORT || 3001;

app.use(express.static(__dirname));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Eventbrite 캐시 ──────────────────────────────────
// SGT 기준 09:00 / 17:00 / 00:00 = UTC 01:00 / 09:00 / 16:00
const cache = { events: null, upcoming: null, updatedAt: null };

async function fetchEventbriteCache() {
  try {
    // /api/events 데이터
    const evUrl = `https://www.eventbriteapi.com/v3/organizations/${ORG_ID}/events/` +
      `?status=live&order_by=start_asc&expand=venue&page_size=50`;
    const evResp = await fetch(evUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (evResp.ok) {
      const data = await evResp.json();

      let orgUrl = `https://www.eventbrite.co.uk/o/dohe-81050166313`;
      const firstEvent = (data.events || [])[0];
      if (firstEvent) {
        try {
          const orgResp = await fetch(
            `https://www.eventbriteapi.com/v3/events/${firstEvent.id}/?expand=organizer`,
            { headers: { Authorization: `Bearer ${TOKEN}` } }
          );
          const orgData = await orgResp.json();
          if (orgData.organizer?.url) orgUrl = orgData.organizer.url;
        } catch (_) {}
      }

      const cityMap = new Map();
      (data.events || [])
        .filter(e => e.name?.text?.toLowerCase().includes('edtech together'))
        .forEach(e => {
          const city = detectCity(e.name?.text || e.venue?.city || '');
          const key  = city?.label || 'Other';
          if (!cityMap.has(key)) {
            const parts    = (e.name?.text || '').split(' - ');
            const subtitle = parts.length > 1 ? parts.slice(1).join(' - ') : '';
            cityMap.set(key, {
              id: e.id, subtitle, url: e.url,
              start_utc: e.start?.utc, end_utc: e.end?.utc,
              city: key, flag: city?.flag || 'Online',
            });
          }
        });
      cache.events = { events: [...cityMap.values()], orgUrl };
    }

    // /api/upcoming 데이터
    const upUrl = `https://www.eventbriteapi.com/v3/organizations/${ORG_ID}/events/` +
      `?status=live&order_by=start_asc&expand=venue,ticket_availability&page_size=50`;
    const upResp = await fetch(upUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (upResp.ok) {
      const data = await upResp.json();
      const now  = new Date();
      cache.upcoming = {
        events: (data.events || [])
          .filter(e => {
            const ta = e.ticket_availability;
            if (ta?.is_sold_out) return false;
            if (ta?.end_sales_date?.utc && new Date(ta.end_sales_date.utc) < now) return false;
            return true;
          })
          .map(e => {
            const city = detectCity(e.name?.text || e.venue?.city || '');
            return {
              id: e.id, title: e.name?.text, url: e.url,
              start_utc: e.start?.utc, end_utc: e.end?.utc,
              location: e.venue?.address?.localized_address_display || e.venue?.city || 'Online',
              city: city?.label || e.venue?.city || 'Online',
              flag: city?.flag || 'Online',
            };
          }),
      };
    }

    cache.updatedAt = new Date();
    console.log(`[Cache] Eventbrite 갱신 완료: ${cache.updatedAt.toISOString()}`);
  } catch (err) {
    console.error('[Cache] Eventbrite 갱신 실패:', err.message);
  }
}

// 서버 시작 시 즉시 1회 실행
fetchEventbriteCache();

// SGT 09:00 / 17:00 / 00:00 (UTC 01:00 / 09:00 / 16:00) 에 갱신
cron.schedule('0 1 * * *',  fetchEventbriteCache); // 09:00 SGT
cron.schedule('0 9 * * *',  fetchEventbriteCache); // 17:00 SGT
cron.schedule('0 16 * * *', fetchEventbriteCache); // 00:00 SGT

// City 키워드 매핑 (알려진 도시 → 뱃지/레이블)
const CITY_MAP = {
  london    : { flag: 'UK',     label: 'London' },
  online    : { flag: 'Online', label: 'Online' },
  singapore : { flag: 'SG',    label: 'Singapore' },
  seoul     : { flag: 'KR',    label: 'Seoul' },
};

// "EdTech Together [City] - [subtitle]" 패턴에서 도시를 자동 추출
// 모르는 도시도 이름 그대로 뱃지에 표시 (자동 확장)
function detectCity(name = '') {
  const m = name.match(/edtech together\s+([^-]+?)(?:\s*-|$)/i);
  if (m) {
    const cityRaw = m[1].trim();
    const key     = cityRaw.toLowerCase();
    if (CITY_MAP[key]) return CITY_MAP[key];
    // 미등록 도시: 첫 두 글자 대문자로 뱃지 자동 생성
    return { flag: cityRaw.slice(0, 2).toUpperCase(), label: cityRaw };
  }
  // 패턴 불일치 시 키워드 폴백
  const n = name.toLowerCase();
  for (const [key, val] of Object.entries(CITY_MAP)) {
    if (n.includes(key)) return val;
  }
  return null;
}

// ── 뉴스/이벤트 제출 폼 ─────────────────────────
app.post('/api/submit', async (req, res) => {
  const { type, title, url, organisation, role, _replyto, description, image_url } = req.body;

  if (!type || !title || !organisation || !_replyto || !description) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const html = `
    <h2>[EdTech HUB] New ${type} Submission</h2>
    <table cellpadding="8" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
      <tr><td style="font-weight:600;color:#6B7280;">Type</td><td>${type}</td></tr>
      <tr><td style="font-weight:600;color:#6B7280;">Title</td><td>${title}</td></tr>
      <tr><td style="font-weight:600;color:#6B7280;">URL</td><td><a href="${url}">${url}</a></td></tr>
      <tr><td style="font-weight:600;color:#6B7280;">Organisation</td><td>${organisation}</td></tr>
      <tr><td style="font-weight:600;color:#6B7280;">Role</td><td>${role || '-'}</td></tr>
      <tr><td style="font-weight:600;color:#6B7280;">Contact</td><td><a href="mailto:${_replyto}">${_replyto}</a></td></tr>
      <tr><td style="font-weight:600;color:#6B7280;">Description</td><td>${description}</td></tr>
      ${image_url ? `<tr><td style="font-weight:600;color:#6B7280;">Image</td><td><a href="${image_url}">${image_url}</a></td></tr>` : ''}
    </table>
  `;

  try {
    await mailer.sendMail({
      from   : '"EdTech HUB" <sungsoo@dohegroup.com>',
      to     : 'sungsoo@dohegroup.com',
      replyTo: _replyto,
      subject: `[EdTech HUB] New ${type} Submission — ${title}`,
      html,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Mail error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

app.get('/api/events', (req, res) => {
  if (cache.events) return res.json(cache.events);
  res.status(503).json({ error: 'Cache not ready, try again shortly' });
});

// ── DB: 뉴스 Top Picks ──────────────────────────────
app.get('/api/db/news/top', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT n.id, n.title, n.publisher, n.url,
             CASE
               WHEN n.thumbnail_img_path LIKE 'http%' THEN n.thumbnail_img_path
               WHEN n.thumbnail_img_path IS NOT NULL AND n.thumbnail_img_path != ''
                 THEN CONCAT('https://edtechhub.com', n.thumbnail_img_path)
               ELSE NULL
             END AS image,
             n.description, n.publish_dt
      FROM news_top_picks tp
      JOIN news n ON n.id = tp.news_id
      WHERE tp.del_flag = 'N' AND n.del_flag = 'N'
      ORDER BY tp.display_order ASC
      LIMIT 4
    `);
    res.json({ news: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── DB: 뉴스 목록 (View All, 페이지네이션, 카테고리 필터, 검색) ──────────
app.get('/api/db/news', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(20, parseInt(req.query.limit) || 12);
  const offset = (page - 1) * limit;
  const cat    = req.query.category || null;
  const q      = (req.query.q || '').trim();

  try {
    const conds  = ['n.del_flag = "N"'];
    const params = [];
    if (cat) { conds.push('n.category_id = ?'); params.push(cat); }
    if (q)   { conds.push('n.title LIKE ?');    params.push(`%${q}%`); }
    const where = conds.join(' AND ');

    const [rows] = await db.query(
      `SELECT n.id, n.title, n.publisher, n.url, n.category_id,
              CASE
                WHEN n.thumbnail_img_path LIKE 'http%' THEN n.thumbnail_img_path
                WHEN n.thumbnail_img_path IS NOT NULL AND n.thumbnail_img_path != ''
                  THEN CONCAT('https://edtechhub.com', n.thumbnail_img_path)
                ELSE NULL
              END AS image,
              n.publish_dt
       FROM news n
       WHERE ${where}
       ORDER BY n.publish_dt DESC
       LIMIT ? OFFSET ?`, [...params, limit, offset]);

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total FROM news n WHERE ${where}`, params);

    res.json({ news: rows, total: countRow.total, page, limit, pages: Math.ceil(countRow.total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── 이벤트 날짜 파싱 (제목/URL에서 날짜 추출) ──────────
function moNum(s) {
  const m = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  return m[(s||'').toLowerCase().slice(0,3)] ?? -1;
}
const MO = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function extractEventDate(title, url) {
  const t = ((title||'') + ' ' + (url||'')).toLowerCase();
  let m;
  // "24 june 2026" / "24th june 2026"
  m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MO}\\s+(\\d{4})\\b`));
  if (m) { const mn = moNum(m[2]); if (mn >= 0) return new Date(+m[3], mn, +m[1]); }
  // "june 24, 2026" / "jun 24 2026"
  m = t.match(new RegExp(`\\b${MO}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})\\b`));
  if (m) { const mn = moNum(m[1]); if (mn >= 0) return new Date(+m[3], mn, +m[2]); }
  // URL: /24-june-2026/
  m = (url||'').toLowerCase().match(new RegExp(`/(\\d{1,2})-${MO}-(\\d{4})/`));
  if (m) { const mn = moNum(m[2]); if (mn >= 0) return new Date(+m[3], mn, +m[1]); }
  return null;
}

function applyDateFilter(rows) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return rows.map(e => {
    if (e.event_start_dt) return e;
    const d = extractEventDate(e.title, e.url);
    if (!d || isNaN(d)) return e;
    db.query('UPDATE event SET event_start_dt = ? WHERE id = ?', [d, e.id]).catch(() => {});
    return { ...e, event_start_dt: d };
  }).filter(e => {
    if (!e.event_start_dt) return true;
    return new Date(e.event_start_dt) >= today;
  });
}

// ── DB: 이벤트 Top Picks ─────────────────────────────────
app.get('/api/db/events/top', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT e.id, e.title, e.url, NULL AS image,
             e.event_start_dt, e.event_end_dt, e.price,
             e.city_name AS city,
             ec.country_name AS country,
             e.latitude, e.longitude
      FROM event e
      LEFT JOIN event_country ec ON ec.id = e.country_id
      WHERE e.del_flag = 'N' AND (e.event_type = '1' OR e.latitude IS NOT NULL)
            AND (e.event_start_dt IS NULL OR e.event_start_dt >= CURDATE())
      ORDER BY e.publish_score DESC, e.id DESC
      LIMIT 50
    `);
    const active = applyDateFilter(rows);
    res.json({ events: active.slice(0, 6) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── DB: 이벤트 목록 (View All, 페이지네이션, 검색) ──────────
app.get('/api/db/events', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(500, parseInt(req.query.limit) || 12);
  const q     = (req.query.q || '').trim();

  try {
    const baseWhere = q
      ? `e.del_flag = 'N' AND (e.event_type = '1' OR e.latitude IS NOT NULL) AND (e.event_start_dt IS NULL OR e.event_start_dt >= CURDATE()) AND (e.title LIKE ? OR ec.country_name LIKE ? OR e.city_name LIKE ?)`
      : `e.del_flag = 'N' AND (e.event_type = '1' OR e.latitude IS NOT NULL) AND (e.event_start_dt IS NULL OR e.event_start_dt >= CURDATE())`;
    const qParam = `%${q}%`;
    const params = q ? [qParam, qParam, qParam] : [];

    // 이벤트 수가 적어서 전체 fetch 후 JS에서 페이지네이션
    const [rows] = await db.query(`
      SELECT e.id, e.title, e.url, NULL AS image,
             e.event_start_dt, e.event_end_dt, e.price,
             e.city_name AS city,
             ec.country_name AS country,
             e.latitude, e.longitude
      FROM event e
      LEFT JOIN event_country ec ON ec.id = e.country_id
      WHERE ${baseWhere}
      ORDER BY e.event_start_dt ASC, e.publish_score DESC, e.id DESC`, params);

    const active = applyDateFilter(rows);
    const total  = active.length;
    const pages  = Math.ceil(total / limit) || 1;
    const offset = (page - 1) * limit;

    res.json({ events: active.slice(offset, offset + limit), total, page, limit, pages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── OG 이미지 파싱 + DB 캐싱 ──────────────────────────
app.get('/api/og-img', async (req, res) => {
  const rawUrl = decodeURIComponent(req.query.url || '');
  if (!rawUrl.startsWith('http')) return res.json({ image: null });

  try {
    // DB 캐시 확인
    const [[cached]] = await db.query(
      'SELECT thumbnail_img_path FROM news WHERE url = ? AND thumbnail_img_path IS NOT NULL AND thumbnail_img_path != ""',
      [rawUrl]
    );
    if (cached?.thumbnail_img_path) return res.json({ image: cached.thumbnail_img_path });

    // 페이지 HTML 가져오기
    const r = await fetch(rawUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EdTechHUB/1.0; +https://edtechhub.com)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ image: null });
    const html = await r.text();

    // 1차: og:image / twitter:image 메타 태그
    const metaPatterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];
    let imgUrl = null;
    for (const p of metaPatterns) {
      const m = html.match(p);
      if (m?.[1]?.trim()) { imgUrl = m[1].trim(); break; }
    }

    // 2차: 본문 첫 번째 콘텐츠 이미지 (srcset 있는 img)
    if (!imgUrl) {
      const bodyStart = html.search(/<body/i);
      const bodyHtml  = bodyStart >= 0 ? html.slice(bodyStart) : html;
      const SKIP = /favicon|icon|logo|avatar|sprite|1x1|pixel|blank|clear\.gif|\.svg/i;
      const allSrcs = [...bodyHtml.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
      imgUrl = allSrcs.find(s => s.startsWith('http') && !SKIP.test(s)) || null;
    }

    // 상대 URL → 절대 URL 변환
    if (imgUrl && !imgUrl.startsWith('http')) {
      try { imgUrl = new URL(imgUrl, new URL(rawUrl).origin).href; } catch { imgUrl = null; }
    }

    // DB에 캐싱
    if (imgUrl) {
      db.query('UPDATE news SET thumbnail_img_path = ? WHERE url = ?', [imgUrl, rawUrl]).catch(() => {});
    }

    res.json({ image: imgUrl || null });
  } catch {
    res.json({ image: null });
  }
});

// 배경 이미지 URL 추출 헬퍼 (절대/상대경로 모두 처리)
function extractBgUrl(style = '') {
  const m = style.match(/url\(['"]?([^'")]+)['"]?\)/);
  if (!m) return '';
  const src = m[1].trim();
  if (src.startsWith('http')) return src;
  if (src.startsWith('/')) return NEWS_BASE + src;
  return '';
}

app.get('/api/upcoming', (req, res) => {
  if (cache.upcoming) return res.json(cache.upcoming);
  res.status(503).json({ error: 'Cache not ready, try again shortly' });
});

app.get('/api/news', async (req, res) => {
  try {
    const resp = await fetch(`${NEWS_BASE}/contents/news.php`);
    const html = await resp.text();
    const root = parse(html);

    const items = [];

    // Featured (max) item
    const featured = root.querySelector('.modle_min a.max');
    if (featured) {
      const imgStyle = featured.querySelector('.img')?.getAttribute('style') || '';
      items.push({
        title : featured.querySelector('h4')?.text?.trim(),
        desc  : featured.querySelector('p.b1')?.text?.trim(),
        source: featured.querySelector('p.b5')?.text?.trim(),
        image : extractBgUrl(imgStyle),
        url   : NEWS_BASE + featured.getAttribute('href'),
        featured: true,
      });
    }

    // List items
    root.querySelectorAll('.modle_min .list a').forEach(a => {
      const imgStyle = a.querySelector('.img')?.getAttribute('style') || '';
      items.push({
        title : a.querySelector('h4')?.text?.trim(),
        source: a.querySelector('p.b5')?.text?.trim(),
        image : extractBgUrl(imgStyle),
        url   : NEWS_BASE + a.getAttribute('href'),
        featured: false,
      });
    });

    res.json({ news: items.filter(n => n.title) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// ── 이미지 프록시 (hotlink 차단 우회) ──────────────
app.get('/api/img', async (req, res) => {
  const url = decodeURIComponent(req.query.url || '');
  if (!url.startsWith('http')) return res.status(400).end();
  try {
    const origin = new URL(url).origin;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': origin + '/',
      }
    });
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(500).end();
  }
});

app.listen(PORT, () => console.log(`EdTech HUB running on port ${PORT}`));
