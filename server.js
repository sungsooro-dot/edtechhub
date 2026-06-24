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

// ── DB: 뉴스 목록 (View All, 페이지네이션) ──────────
app.get('/api/db/news', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(20, parseInt(req.query.limit) || 12);
  const offset = (page - 1) * limit;
  const cat    = req.query.category || null;

  try {
    const baseWhere = cat ? 'n.del_flag = "N" AND n.category_id = ?' : 'n.del_flag = "N"';
    const listParams  = cat ? [cat, limit, offset] : [limit, offset];
    const countParams = cat ? [cat] : [];

    const [rows] = await db.query(
      `SELECT n.id, n.title, n.publisher, n.url,
              CASE
                WHEN n.thumbnail_img_path LIKE 'http%' THEN n.thumbnail_img_path
                WHEN n.thumbnail_img_path IS NOT NULL AND n.thumbnail_img_path != ''
                  THEN CONCAT('https://edtechhub.com', n.thumbnail_img_path)
                ELSE NULL
              END AS image,
              n.description, n.publish_dt
       FROM news n
       WHERE ${baseWhere}
       ORDER BY n.publish_dt DESC
       LIMIT ? OFFSET ?`, listParams);

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total FROM news n WHERE ${baseWhere}`, countParams);

    const total = countRow.total;
    res.json({ news: rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── DB: 이벤트 Top Picks (지난 이벤트 제외, 부족 시 upcoming으로 보충) ───
app.get('/api/db/events/top', async (req, res) => {
  const LIMIT = 6;
  try {
    const [rows] = await db.query(`
      SELECT e.id, e.title, e.url, NULL AS image,
             e.event_start_dt, e.event_end_dt, e.price,
             e.city_name AS city,
             ec.country_name AS country
      FROM event e
      LEFT JOIN event_country ec ON ec.id = e.country_id
      WHERE e.del_flag = 'N'
      ORDER BY e.publish_score DESC, e.id DESC
      LIMIT ${LIMIT}
    `);
    res.json({ events: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── DB: 이벤트 목록 (View All, 페이지네이션, 검색) ──────────
app.get('/api/db/events', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(500, parseInt(req.query.limit) || 12);
  const offset = (page - 1) * limit;
  const q      = (req.query.q || '').trim();

  try {
    const baseWhere = q
      ? `e.del_flag = 'N' AND (e.title LIKE ? OR ec.country_name LIKE ? OR e.city_name LIKE ?)`
      : `e.del_flag = 'N'`;
    const qParam      = `%${q}%`;
    const listParams  = q ? [qParam, qParam, qParam, limit, offset] : [limit, offset];
    const countParams = q ? [qParam, qParam, qParam] : [];

    const [rows] = await db.query(`
      SELECT e.id, e.title, e.url, NULL AS image,
             e.event_start_dt, e.event_end_dt, e.price,
             e.city_name AS city,
             ec.country_name AS country
      FROM event e
      LEFT JOIN event_country ec ON ec.id = e.country_id
      WHERE ${baseWhere}
      ORDER BY e.publish_score DESC, e.id DESC
      LIMIT ? OFFSET ?`, listParams);

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM event e
       LEFT JOIN event_country ec ON ec.id = e.country_id
       WHERE ${baseWhere}`, countParams);

    res.json({ events: rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
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
