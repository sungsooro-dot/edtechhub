const express      = require('express');

function toEmbedSrc(input) {
  if (!input) return '';
  input = input.trim();
  // Full iframe HTML -> extract src
  const m = input.match(/src=["']([^"']+)["']/);
  if (m && m[1].includes('linkedin')) return m[1];
  // Already embed URL
  if (input.includes('linkedin.com/embed/')) return input;
  // Regular post URL
  const act = input.match(/[-_]activity[-_](\d{15,})/);
  if (act) return 'https://www.linkedin.com/embed/feed/update/urn:li:activity:' + act[1] + '?collapsed=1';
  const ugc = input.match(/ugcPost[:\-](\d{15,})/);
  if (ugc) return 'https://www.linkedin.com/embed/feed/update/urn:li:ugcPost:' + ugc[1] + '?collapsed=1';
  return input;
}
// Fetch Open Graph data from a LinkedIn post URL (Slack-style unfurl, follows redirects)
const https = require('https');
function parseOG(data, fallbackUrl) {
  const get = (prop) => {
    const m = data.match(new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']+)["']`))
           || data.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${prop}["']`));
    return m ? m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'") : '';
  };
  const ogTitle    = get('og:title');
  const ogImage    = get('og:image');
  const ogUrl      = get('og:url') || fallbackUrl;
  const parts      = ogTitle.split(' | ');
  const authorName = parts.length > 1 ? parts[1] : parts[0];
  return { post_url: ogUrl, og_title: ogTitle, og_image: ogImage, author_name: authorName };
}

function fetchWithRedirect(url, maxRedirects = 5) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Slackbot 1.0; +https://api.slack.com/robots)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    }, (res) => {
      // Follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : 'https://www.linkedin.com' + res.headers.location;
        resolve(fetchWithRedirect(next, maxRedirects - 1));
        return;
      }
      if (res.statusCode === 429) { res.resume(); resolve({ post_url: url, _status: 429 }); return; }
      if (res.statusCode >= 400)  { res.resume(); resolve({ post_url: url, _status: res.statusCode }); return; }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(parseOG(data, url)));
    });
    req.on('error', () => resolve({ post_url: url }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ post_url: url }); });
  });
}

function fetchLinkedInOG(input) {
  input = input.trim();
  // iframe HTML → extract src
  const iframeSrc = input.match(/src=["']([^"']*linkedin[^"']*)["']/);
  if (iframeSrc) input = iframeSrc[1];
  // Post URL (contains /posts/ or /feed/) → use directly (strip UTM)
  if (input.includes('linkedin.com/posts/') || input.includes('linkedin.com/feed/update/')) {
    const clean = input.replace(/[?#].*$/, '/');
    return fetchWithRedirect(clean);
  }
  // Embed URL → convert to feed URL for OG fetch
  const postUrl = input
    .replace('/embed/feed/update/', '/feed/update/')
    .replace(/[?#].*$/, '/');
  return fetchWithRedirect(postUrl);
}

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

// ── 뉴스레터 구독 ─────────────────────────
app.post('/api/subscribe', async (req, res) => {
  const email = (req.body.email || '').trim();
  const name  = (req.body.name || '').trim();
  const source_page = (req.body.source_page || '').trim().slice(0, 100);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }

  try {
    await db.query(
      'INSERT INTO subscribers (email, name, source_page) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [email, name || null, source_page || null]
    );
    mailer.sendMail({
      from   : '"EdTech HUB" <sungsoo@dohegroup.com>',
      to     : 'sungsoo@dohegroup.com',
      subject: `[EdTech HUB] New newsletter subscriber — ${email}`,
      html   : `<p>New subscriber: <strong>${email}</strong>${name ? ` (${name})` : ''}</p><p>Source page: ${source_page || '-'}</p>`,
    }).catch(err => console.error('Subscribe notification mail error:', err));
    res.json({ ok: true });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
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

const NEWS_IMG_CASE = `CASE
  WHEN n.thumbnail_img_path LIKE 'http%'
    AND n.thumbnail_img_path NOT LIKE '%px.ads.linkedin.com%'
    AND n.thumbnail_img_path NOT LIKE '%linkedin.com/collect%'
    AND n.thumbnail_img_path NOT LIKE '%fmt=gif%'
    THEN n.thumbnail_img_path
  WHEN n.thumbnail_img_path IS NOT NULL AND n.thumbnail_img_path != ''
    AND n.thumbnail_img_path NOT LIKE 'http%'
    THEN CONCAT('https://edtechhub.com', n.thumbnail_img_path)
  ELSE NULL END AS image`;

// ── DB: 뉴스 목록 — 최근 14일 (View All, 페이지네이션, 카테고리, 검색) ──
app.get('/api/db/news', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(20, parseInt(req.query.limit) || 12);
  const offset = (page - 1) * limit;
  const cat    = req.query.category || null;
  const q      = (req.query.q || '').trim();

  try {
    // 최근 14일 기준. 없으면 가장 최근 스크랩 배치 그대로 표시
    const [[batchRow]] = await db.query(
      `SELECT MAX(publish_dt) AS latest FROM news WHERE del_flag='N'`);
    const latest    = batchRow?.latest ? new Date(batchRow.latest) : new Date();
    const cutoff    = new Date(latest); cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString().slice(0, 19).replace('T', ' ');

    const conds  = ['n.del_flag = "N"', `n.publish_dt >= '${cutoffStr}'`];
    const params = [];
    if (cat) { conds.push('n.category_id = ?'); params.push(cat); }
    if (q)   { conds.push('n.title LIKE ?');    params.push(`%${q}%`); }
    const where = conds.join(' AND ');

    const [rows] = await db.query(
      `SELECT n.id, n.title, n.publisher, n.url, n.category_id, ${NEWS_IMG_CASE}, n.publish_dt
       FROM news n WHERE ${where}
       ORDER BY n.publish_dt DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total FROM news n WHERE ${where}`, params);

    res.json({ news: rows, total: countRow.total, page, limit, pages: Math.ceil(countRow.total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── DB: 뉴스 Archive (14일 이상 지난 기사) ──────────────────
app.get('/api/db/news/archive', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const cat   = req.query.category || null;
  const q     = (req.query.q || '').trim();
  const year  = parseInt(req.query.year)  || null;
  const month = parseInt(req.query.month) || null;

  try {
    const [[batchRow]] = await db.query(
      `SELECT MAX(publish_dt) AS latest FROM news WHERE del_flag='N'`);
    const latest    = batchRow?.latest ? new Date(batchRow.latest) : new Date();
    const cutoff    = new Date(latest); cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString().slice(0, 19).replace('T', ' ');

    const conds  = ['n.del_flag = "N"', `n.publish_dt < '${cutoffStr}'`];
    const params = [];
    if (cat)   { conds.push('n.category_id = ?');      params.push(cat); }
    if (q)     { conds.push('n.title LIKE ?');          params.push(`%${q}%`); }
    if (year)  { conds.push('YEAR(n.publish_dt) = ?');  params.push(year); }
    if (month) { conds.push('MONTH(n.publish_dt) = ?'); params.push(month); }
    const where = conds.join(' AND ');

    const [rows] = await db.query(
      `SELECT n.id, n.title, n.publisher, n.url, n.category_id, ${NEWS_IMG_CASE}, n.publish_dt
       FROM news n WHERE ${where}
       ORDER BY n.publish_dt DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total FROM news n WHERE ${where}`, params);

    const [yearRows] = await db.query(
      `SELECT DISTINCT YEAR(publish_dt) AS yr FROM news
       WHERE del_flag='N' AND publish_dt < '${cutoffStr}' ORDER BY yr DESC`);

    res.json({
      news: rows, total: countRow.total, page, limit,
      pages: Math.ceil(countRow.total / limit) || 1,
      years: yearRows.map(r => r.yr),
    });
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

// ── DB: LinkedIn Voices (랜덤 N개) ───────────────────────
app.get('/api/db/voices/pinned', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM linkedin_voices WHERE is_active=1 AND is_pinned=1 ORDER BY id ASC LIMIT 3`);
    if (rows.length < 3) {
      const ids = rows.map(r => r.id);
      const need = 3 - rows.length;
      const [extra] = ids.length
        ? await db.query(`SELECT * FROM linkedin_voices WHERE is_active=1 AND id NOT IN (?) ORDER BY id ASC LIMIT ?`, [ids, need])
        : await db.query(`SELECT * FROM linkedin_voices WHERE is_active=1 ORDER BY id ASC LIMIT ?`, [need]);
      rows.push(...extra);
    }
    res.json({ voices: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.get('/api/db/voices', async (req, res) => {
  const limit = Math.min(12, parseInt(req.query.limit) || 3);
  try {
    const [rows] = await db.query(
      `SELECT id, person_name, person_initials, avatar_color,
              person_title, person_company, linkedin_profile_url,
              topic_tag, topic_tag_style,
              post_text, post_url, likes_count, comments_count, post_date
       FROM linkedin_voices WHERE is_active=1 ORDER BY RAND() LIMIT ?`, [limit]);
    res.json({ voices: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

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
      ORDER BY ISNULL(e.event_start_dt), e.event_start_dt ASC, e.publish_score DESC, e.id DESC`, params);

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

// ── DB: 이벤트 Archive (지난 이벤트, 연도 필터, 검색) ──────────
app.get('/api/db/events/archive', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const q     = (req.query.q || '').trim();
  const year  = parseInt(req.query.year) || null;

  try {
    const conds  = ["e.del_flag = 'N'"];
    const params = [];
    if (q) { conds.push('(e.title LIKE ? OR ec.country_name LIKE ? OR e.city_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

    const [rows] = await db.query(`
      SELECT e.id, e.title, e.url,
             e.event_start_dt, e.city_name AS city,
             ec.country_name AS country
      FROM event e
      LEFT JOIN event_country ec ON ec.id = e.country_id
      WHERE ${conds.join(' AND ')}
      ORDER BY ISNULL(e.event_start_dt), e.event_start_dt DESC, e.id DESC
    `, params);

    const now = new Date(); now.setHours(0, 0, 0, 0);
    const past = rows
      .map(e => {
        if (e.event_start_dt) return e;
        const d = extractEventDate(e.title, e.url);
        if (!d || isNaN(d)) return null;
        db.query('UPDATE event SET event_start_dt = ? WHERE id = ?', [d, e.id]).catch(() => {});
        return { ...e, event_start_dt: d };
      })
      .filter(e => e && e.event_start_dt && new Date(e.event_start_dt) < now)
      .filter(e => !year || new Date(e.event_start_dt).getFullYear() === year);

    const years  = [...new Set(past.map(e => new Date(e.event_start_dt).getFullYear()))].sort((a, b) => b - a);
    const total  = past.length;
    const offset = (page - 1) * limit;

    res.json({ events: past.slice(offset, offset + limit), total, page, limit, pages: Math.ceil(total / limit) || 1, years });
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

// ── Admin 인증 미들웨어 ──────────────────────────────────
const ADMIN_USERS = [
  { email: 'sungsoo@dohegroup.com', password: '1234' },
];
const ADMIN_KEY = 'edtech2024admin';

function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'] || '';
  if (key === ADMIN_KEY) return next();
  // email:password base64 token
  try {
    const decoded = Buffer.from(key, 'base64').toString('utf8');
    const [email, ...rest] = decoded.split(':');
    const password = rest.join(':');
    if (ADMIN_USERS.some(u => u.email === email && u.password === password)) return next();
  } catch (_) {}
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Admin: Profiles CRUD ─────────────────────────────────
app.get('/api/admin/profiles', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.*, COUNT(v.id) AS post_count
       FROM linkedin_profiles p
       LEFT JOIN linkedin_voices v ON v.profile_id = p.id AND v.is_active = 1
       GROUP BY p.id ORDER BY p.is_active DESC, p.person_name ASC`);
    res.json({ profiles: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/admin/profiles', requireAdmin, express.json(), async (req, res) => {
  const { person_name, person_initials, avatar_color, person_title, person_company, linkedin_url, notes } = req.body;
  if (!person_name || !person_initials) return res.status(400).json({ error: 'name + initials required' });
  try {
    const [r] = await db.query(
      `INSERT INTO linkedin_profiles (person_name,person_initials,avatar_color,person_title,person_company,linkedin_url,notes)
       VALUES (?,?,?,?,?,?,?)`,
      [person_name, person_initials.toUpperCase().substring(0,4), avatar_color||'li-av-green',
       person_title||null, person_company||null, linkedin_url||null, notes||null]);
    res.json({ id: r.insertId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.put('/api/admin/profiles/:id', requireAdmin, express.json(), async (req, res) => {
  const { person_name, person_initials, avatar_color, person_title, person_company, linkedin_url, notes, is_active } = req.body;
  try {
    await db.query(
      `UPDATE linkedin_profiles SET person_name=?,person_initials=?,avatar_color=?,person_title=?,
       person_company=?,linkedin_url=?,notes=?,is_active=? WHERE id=?`,
      [person_name, person_initials?.toUpperCase().substring(0,4), avatar_color,
       person_title||null, person_company||null, linkedin_url||null, notes||null,
       is_active??1, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

// ── Admin: Voices (Posts) CRUD ───────────────────────────
app.get('/api/admin/voices', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT v.*, p.person_name AS p_name, p.linkedin_url AS p_url
       FROM linkedin_voices v
       LEFT JOIN linkedin_profiles p ON p.id = v.profile_id
       ORDER BY v.is_active DESC, v.id DESC`);
    res.json({ voices: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/admin/voices', requireAdmin, express.json(), async (req, res) => {
  const { profile_id, person_name, person_initials, avatar_color, person_title, person_company,
          linkedin_profile_url, topic_tag, topic_tag_style, post_text, post_url,
          likes_count, comments_count, post_date } = req.body;
  if (!person_name || !post_text) return res.status(400).json({ error: 'person_name + post_text required' });

  // profile_id 없으면 자동 생성 (이름 기준)
  let pid = profile_id || null;
  if (!pid && person_name) {
    const [ex] = await db.query(`SELECT id FROM linkedin_profiles WHERE person_name=? LIMIT 1`, [person_name]);
    if (ex.length) { pid = ex[0].id; }
    else {
      const [nr] = await db.query(
        `INSERT INTO linkedin_profiles (person_name,person_initials,avatar_color,person_title,person_company,linkedin_url)
         VALUES (?,?,?,?,?,?)`,
        [person_name, (person_initials||'').toUpperCase().substring(0,4)||'??',
         avatar_color||'li-av-green', person_title||null, person_company||null, linkedin_profile_url||null]);
      pid = nr.insertId;
    }
  }
  try {
    const [r] = await db.query(
      `INSERT INTO linkedin_voices
       (profile_id,person_name,person_initials,avatar_color,person_title,person_company,
        linkedin_profile_url,topic_tag,topic_tag_style,post_text,post_url,likes_count,comments_count,post_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [pid, person_name, (person_initials||'').toUpperCase().substring(0,4),
       avatar_color||'li-av-green', person_title||null, person_company||null,
       linkedin_profile_url||null, topic_tag||null, topic_tag_style||null,
       post_text, post_url||null, likes_count||0, comments_count||0, post_date||null]);
    res.json({ id: r.insertId, profile_id: pid });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.put('/api/admin/voices/:id', requireAdmin, express.json(), async (req, res) => {
  const { topic_tag, topic_tag_style, post_text, post_url, likes_count, comments_count, post_date, is_active, is_pinned } = req.body;
  try {
    if (is_pinned === true || is_pinned === 1) {
      const [[cnt]] = await db.query(`SELECT COUNT(*) AS n FROM linkedin_voices WHERE is_pinned=1 AND id != ?`, [req.params.id]);
      if (cnt.n >= 3) return res.status(400).json({ error: '최대 3개까지만 고정할 수 있습니다.' });
    }
    await db.query(
      `UPDATE linkedin_voices SET topic_tag=?,topic_tag_style=?,post_text=?,post_url=?,
       likes_count=?,comments_count=?,post_date=?,is_active=?,is_pinned=? WHERE id=?`,
      [topic_tag||null, topic_tag_style||null, post_text, post_url||null,
       likes_count||0, comments_count||0, post_date||null, is_active??1, is_pinned??0, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.delete('/api/admin/voices/:id', requireAdmin, async (req, res) => {
  try {
    await db.query(`DELETE FROM linkedin_voices WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});


// ── LinkedIn Embeds (public) ──────────────────────────────
app.get('/api/db/embeds', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, embed_src, post_url, og_title, og_image, excerpt, author_name, display_order FROM linkedin_embeds WHERE is_active=1 ORDER BY display_order ASC`
    );
    res.json({ embeds: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

// ── Admin: LinkedIn Embeds CRUD ──────────────────────────
app.get('/api/admin/embeds', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, embed_src, post_url, og_title, og_image, excerpt, author_name, display_order, is_active FROM linkedin_embeds ORDER BY display_order ASC`
    );
    res.json({ embeds: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/admin/fetch-og', requireAdmin, express.json(), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const og = await fetchLinkedInOG(url);
    if (og._status === 429) return res.status(429).json({ error: 'rate_limited' });
    if (!og.og_title)       return res.status(422).json({ error: 'Could not fetch OG data' });
    res.json(og);
  } catch(e) { res.status(500).json({ error: 'fetch failed' }); }
});

app.post('/api/admin/embeds', requireAdmin, express.json(), async (req, res) => {
  try {
    const { embed_src, display_order = 0, og_title, og_image, author_name, excerpt, post_url } = req.body;
    if (!embed_src) return res.status(400).json({ error: 'embed_src required' });
    const src = toEmbedSrc(embed_src);
    const [r] = await db.query(
      `INSERT INTO linkedin_embeds (embed_src, post_url, og_title, og_image, author_name, excerpt, display_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [src, post_url||null, og_title||null, og_image||null, author_name||null, excerpt||null, display_order]
    );
    // If OG wasn't provided, auto-fetch in background
    if (!og_title) {
      fetchLinkedInOG(src).then(og => {
        if (og.og_title) {
          db.query(
            `UPDATE linkedin_embeds SET post_url=?, og_title=?, og_image=?, author_name=? WHERE id=?`,
            [og.post_url, og.og_title, og.og_image, og.author_name, r.insertId]
          ).catch(console.error);
        }
      }).catch(console.error);
    }
    res.json({ id: r.insertId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.put('/api/admin/embeds/:id', requireAdmin, express.json(), async (req, res) => {
  try {
    const { embed_src, display_order, is_active, og_title, og_image, author_name, post_url, excerpt } = req.body;
    const fields = [];
    const vals = [];
    if (embed_src    !== undefined) { fields.push('embed_src=?');    vals.push(embed_src.trim()); }
    if (display_order!== undefined) { fields.push('display_order=?');vals.push(display_order); }
    if (is_active    !== undefined) { fields.push('is_active=?');    vals.push(is_active); }
    if (og_title     !== undefined) { fields.push('og_title=?');     vals.push(og_title||null); }
    if (og_image     !== undefined) { fields.push('og_image=?');     vals.push(og_image||null); }
    if (author_name  !== undefined) { fields.push('author_name=?');  vals.push(author_name||null); }
    if (post_url     !== undefined) { fields.push('post_url=?');     vals.push(post_url||null); }
    if (excerpt      !== undefined) { fields.push('excerpt=?');      vals.push(excerpt||null); }
    if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE linkedin_embeds SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.delete('/api/admin/embeds/:id', requireAdmin, async (req, res) => {
  try {
    await db.query(`DELETE FROM linkedin_embeds WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

// ── Admin: Events CRUD ──────────────────────────────────
app.get('/api/admin/events', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT e.id, e.title, e.url, e.event_start_dt, e.event_end_dt,
             e.city_name AS city, ec.country_name AS country, e.country_id,
             e.latitude, e.longitude, e.price
      FROM event e
      LEFT JOIN event_country ec ON ec.id = e.country_id
      WHERE e.del_flag = 'N'
      ORDER BY e.event_start_dt IS NULL ASC, e.event_start_dt ASC, e.id DESC
    `);
    const [countries] = await db.query(`SELECT id, country_name FROM event_country ORDER BY country_name`);
    res.json({ events: rows, countries });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/admin/events', requireAdmin, express.json(), async (req, res) => {
  const { title, url, event_start_dt, event_end_dt, city, country_id, price, is_online } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const cityVal = is_online ? 'Online' : (city || null);
    const cid     = is_online ? null : (country_id || null);
    const lat     = (!is_online && !city) ? null : null;
    const [r] = await db.query(
      `INSERT INTO event (title, url, event_start_dt, event_end_dt, city_name, country_id, price, event_type, del_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, '1', 'N')`,
      [title, url || null, event_start_dt || null, event_end_dt || null, cityVal, cid, price || null]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.put('/api/admin/events/:id', requireAdmin, express.json(), async (req, res) => {
  const { title, url, event_start_dt, event_end_dt, city, country_id, price, is_online } = req.body;
  try {
    const cityVal = is_online ? 'Online' : (city || null);
    const cid     = is_online ? null : (country_id || null);
    await db.query(
      `UPDATE event SET title=?, url=?, event_start_dt=?, event_end_dt=?,
       city_name=?, country_id=?, price=? WHERE id=?`,
      [title || null, url || null, event_start_dt || null, event_end_dt || null,
       cityVal, cid, price || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.delete('/api/admin/events/:id', requireAdmin, async (req, res) => {
  try {
    await db.query(`UPDATE event SET del_flag='Y' WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

// ── Admin: News CRUD ─────────────────────────────────────
app.get('/api/admin/news', requireAdmin, async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const q     = (req.query.q || '').trim();
  const offset = (page - 1) * limit;
  try {
    const conds  = ['del_flag = "N"'];
    const params = [];
    if (q) { conds.push('(title LIKE ? OR publisher LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const where = conds.join(' AND ');
    const [rows] = await db.query(
      `SELECT id, title, publisher, url, category_id, thumbnail_img_path AS image, publish_dt
       FROM news WHERE ${where} ORDER BY publish_dt DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]);
    const [[cnt]] = await db.query(`SELECT COUNT(*) AS total FROM news WHERE ${where}`, params);
    res.json({ news: rows, total: cnt.total, page, limit, pages: Math.ceil(cnt.total / limit) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/admin/news', requireAdmin, express.json(), async (req, res) => {
  const { title, publisher, url, category_id, image, publish_dt } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title + url required' });
  try {
    const [r] = await db.query(
      `INSERT INTO news (title, publisher, url, category_id, thumbnail_img_path, publish_dt, del_flag)
       VALUES (?, ?, ?, ?, ?, ?, 'N')`,
      [title, publisher || null, url, category_id || null, image || null,
       publish_dt || new Date().toISOString().slice(0,19).replace('T',' ')]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.put('/api/admin/news/:id', requireAdmin, express.json(), async (req, res) => {
  const { title, publisher, url, category_id, image, publish_dt } = req.body;
  try {
    await db.query(
      `UPDATE news SET title=?, publisher=?, url=?, category_id=?, thumbnail_img_path=?, publish_dt=? WHERE id=?`,
      [title, publisher || null, url, category_id || null, image || null, publish_dt || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.delete('/api/admin/news/:id', requireAdmin, async (req, res) => {
  try {
    await db.query(`UPDATE news SET del_flag='Y' WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-login.html'));
});

app.get('/admin/logout', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><script>sessionStorage.removeItem('adminKey');location.href='/admin/login';<\/script></head></html>`);
});

app.get('/admin/content', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-content.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.listen(PORT, () => console.log(`EdTech HUB running on port ${PORT}`));
