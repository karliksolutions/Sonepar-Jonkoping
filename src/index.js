// Sonepar Hyllsök – Worker (API + statiska filer)
// D1-binding: jkpg_db   Hemlighet: ADMIN_PASSWORD

const COOKIE = 'hs_session';
const SESSION_TTL = 8 * 60 * 60; // sekunder (8 timmar)
const enc = new TextEncoder();
let metaReady = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: 'Något gick fel på servern' }, 500);
    }
  },
};

async function api(request, env, url) {
  const db = env.jkpg_db;
  const path = url.pathname;
  const method = request.method;

  // ---------- Publikt ----------
  if (path === '/api/version' && method === 'GET') {
    return json({ version: await getVersion(db) });
  }

  if (path === '/api/artiklar' && method === 'GET') {
    const [version, rows] = await Promise.all([
      getVersion(db),
      db.prepare('SELECT artikelnummer, hyllsida FROM artiklar').all(),
    ]);
    const artiklar = {};
    for (const r of rows.results) artiklar[r.artikelnummer] = r.hyllsida;
    return json({ version, artiklar });
  }

  // ---------- Inloggning ----------
  if (path === '/api/login' && method === 'POST') {
    if (!env.ADMIN_PASSWORD) return json({ error: 'Adminlösenordet är inte inställt i Cloudflare' }, 503);
    const body = await readJson(request);
    const ok = await passwordMatches(String(body.password ?? ''), env.ADMIN_PASSWORD);
    if (!ok) {
      await new Promise((r) => setTimeout(r, 800)); // bromsar gissningsförsök
      return json({ error: 'Fel lösenord' }, 401);
    }
    const token = await createToken(env.ADMIN_PASSWORD);
    return json({ ok: true }, 200, {
      'Set-Cookie': `${COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`,
    });
  }

  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, {
      'Set-Cookie': `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    });
  }

  // ---------- Admin (kräver inloggning) ----------
  if (path.startsWith('/api/admin/')) {
    if (!(await isLoggedIn(request, env))) return json({ error: 'Inte inloggad' }, 401);
    await ensureMeta(db);

    if (path === '/api/admin/session' && method === 'GET') return json({ ok: true });

    if (path === '/api/admin/artiklar' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const limit = 200;
      let stmt;
      if (!q) {
        stmt = db.prepare('SELECT artikelnummer, hyllsida, beteckning FROM artiklar ORDER BY artikelnummer LIMIT ?').bind(limit + 1);
      } else {
        const like = q.replace(/[\\%_]/g, (c) => '\\' + c);
        stmt = db.prepare(
          `SELECT artikelnummer, hyllsida, beteckning FROM artiklar
           WHERE artikelnummer LIKE ?1 ESCAPE '\\'
              OR hyllsida = ?2
              OR beteckning LIKE ?3 ESCAPE '\\'
           ORDER BY artikelnummer LIMIT ?4`
        ).bind(like.toUpperCase().replace(/\s+/g, '') + '%', q, '%' + like + '%', limit + 1);
      }
      const [rows, count] = await Promise.all([
        stmt.all(),
        db.prepare('SELECT COUNT(*) AS n FROM artiklar').first(),
      ]);
      const list = rows.results;
      return json({ artiklar: list.slice(0, limit), fler: list.length > limit, totalt: count.n });
    }

    if (path === '/api/admin/artiklar' && method === 'POST') {
      const body = await readJson(request);
      const v = validate(body, true);
      if (v.error) return json({ error: v.error }, 400);
      const res = await db.batch([
        db.prepare('INSERT INTO artiklar (artikelnummer, hyllsida, beteckning) VALUES (?, ?, ?) ON CONFLICT(artikelnummer) DO NOTHING')
          .bind(v.artikelnummer, v.hyllsida, v.beteckning),
        bumpVersion(db),
      ]);
      if (!res[0].meta.changes) return json({ error: `Artikelnummer ${v.artikelnummer} finns redan` }, 409);
      return json({ ok: true, artikel: v });
    }

    const m = path.match(/^\/api\/admin\/artiklar\/([^/]+)$/);
    if (m) {
      const nr = cleanNr(decodeURIComponent(m[1]));

      if (method === 'PUT') {
        const body = await readJson(request);
        const v = validate({ ...body, artikelnummer: nr }, false);
        if (v.error) return json({ error: v.error }, 400);
        const res = await db.batch([
          db.prepare('UPDATE artiklar SET hyllsida = ?, beteckning = ? WHERE artikelnummer = ?')
            .bind(v.hyllsida, v.beteckning, nr),
          bumpVersion(db),
        ]);
        if (!res[0].meta.changes) return json({ error: 'Artikeln finns inte' }, 404);
        return json({ ok: true, artikel: v });
      }

      if (method === 'DELETE') {
        const res = await db.batch([
          db.prepare('DELETE FROM artiklar WHERE artikelnummer = ?').bind(nr),
          bumpVersion(db),
        ]);
        if (!res[0].meta.changes) return json({ error: 'Artikeln finns inte' }, 404);
        return json({ ok: true });
      }
    }
  }

  return json({ error: 'Hittades inte' }, 404);
}

// ---------- Hjälpfunktioner ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function cleanNr(v) {
  return String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function validate(body, checkNr) {
  const artikelnummer = cleanNr(body.artikelnummer);
  const hyllsida = String(body.hyllsida ?? '').trim();
  const beteckning = String(body.beteckning ?? '').trim();
  if (checkNr && !/^[A-Z0-9-]{1,30}$/.test(artikelnummer))
    return { error: 'Artikelnumret får bara innehålla bokstäver, siffror och bindestreck' };
  if (!hyllsida) return { error: 'Hyllsida måste fyllas i' };
  if (hyllsida.length > 20) return { error: 'Hyllsidan är för lång (max 20 tecken)' };
  if (beteckning.length > 200) return { error: 'Beteckningen är för lång (max 200 tecken)' };
  return { artikelnummer, hyllsida, beteckning: beteckning || null };
}

// Versionsnummer som ändras vid varje adminändring, så att skärmarna vet när de ska hämta om listan.
async function ensureMeta(db) {
  if (metaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS meta (nyckel TEXT PRIMARY KEY, varde TEXT NOT NULL)'),
    db.prepare("INSERT OR IGNORE INTO meta (nyckel, varde) VALUES ('version', ?)").bind(String(Date.now())),
  ]);
  metaReady = true;
}

async function getVersion(db) {
  await ensureMeta(db);
  const row = await db.prepare("SELECT varde FROM meta WHERE nyckel = 'version'").first();
  return row ? row.varde : '0';
}

function bumpVersion(db) {
  // Körs i samma batch som ändringen, så båda sparas eller ingen av dem.
  return db.prepare(
    "INSERT INTO meta (nyckel, varde) VALUES ('version', ?1) ON CONFLICT(nyckel) DO UPDATE SET varde = ?1"
  ).bind(String(Date.now()));
}

// ---------- Session (signerad cookie) ----------

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode('hyllsok-session:' + secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function createToken(secret) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(exp));
  return exp + '.' + b64url(sig);
}

async function isLoggedIn(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!match) return false;
  const [exp, sig] = match[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(env.ADMIN_PASSWORD), fromB64url(sig), enc.encode(exp));
  } catch {
    return false;
  }
}

async function passwordMatches(given, expected) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
