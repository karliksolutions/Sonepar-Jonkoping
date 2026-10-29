// Sonepar Hyllsök – Worker (API + statiska filer)
// D1-binding: jkpg_db   Hemlighet: ADMIN_PASSWORD

const COOKIE = 'hs_session';
const SESSION_TTL = 8 * 60 * 60; // sekunder (8 timmar)
const IMPORT_MAX = 1000;          // max antal rader per import
const LOG_KEEP = 500;             // antal ändringar som sparas i ändringsloggen
const MISSING_DAYS = 90;          // hur länge en sökning som inte gav träff finns kvar i listan
// OBS: D1 på gratisplanen tillåter 50 databasfrågor per anrop. Import och ångra är skrivna för att hålla sig under det.
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

  // Butiksskärmen rapporterar artikelnummer som söktes men inte fanns.
  // Räknas bara om artikeln fortfarande saknas i registret.
  if (path === '/api/saknas' && method === 'POST') {
    const nr = cleanNr((await readJson(request)).artikelnummer);
    if (!/^[A-Z0-9-]{1,30}$/.test(nr)) return json({ error: 'Ogiltigt artikelnummer' }, 400);
    await ensureMeta(db);
    const t = new Date().toISOString();
    await db.prepare(
      `INSERT INTO saknas (artikelnummer, antal, forst, senast)
       SELECT ?1, 1, ?2, ?2 WHERE NOT EXISTS (SELECT 1 FROM artiklar WHERE artikelnummer = ?1)
       ON CONFLICT(artikelnummer) DO UPDATE SET antal = antal + 1, senast = ?2`
    ).bind(nr, t).run();
    return json({ ok: true });
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
      if (await getArticle(db, v.artikelnummer)) return json({ error: `Artikelnummer ${v.artikelnummer} finns redan` }, 409);
      const efter = { h: v.hyllsida, b: v.beteckning };
      await db.batch([
        db.prepare('INSERT INTO artiklar (artikelnummer, hyllsida, beteckning) VALUES (?, ?, ?)')
          .bind(v.artikelnummer, v.hyllsida, v.beteckning),
        logStmt(db, `Ny artikel ${v.artikelnummer} (hylla ${v.hyllsida})`, [{ nr: v.artikelnummer, fore: null, efter }]),
        db.prepare('DELETE FROM saknas WHERE artikelnummer = ?').bind(v.artikelnummer),
        bumpVersion(db),
      ]);
      return json({ ok: true, artikel: v });
    }

    // Hela registret med beteckningar: används för export (backup) och för importens kontrollvy.
    if (path === '/api/admin/export' && method === 'GET') {
      const rows = await db.prepare('SELECT artikelnummer, hyllsida, beteckning FROM artiklar ORDER BY artikelnummer').all();
      return json({ artiklar: rows.results });
    }

    // Import: lägger till nya artiklar och uppdaterar befintliga. Tar aldrig bort något.
    if (path === '/api/admin/import' && method === 'POST') {
      const body = await readJson(request);
      const list = Array.isArray(body.artiklar) ? body.artiklar : [];
      if (!list.length) return json({ error: 'Inga rader att importera' }, 400);
      if (list.length > IMPORT_MAX) return json({ error: `Max ${IMPORT_MAX} rader per import. Dela upp listan.` }, 400);
      const rows = [], seen = new Set();
      for (let i = 0; i < list.length; i++) {
        const v = validate(list[i], true);
        if (v.error) return json({ error: `Rad ${i + 1}: ${v.error}` }, 400);
        if (seen.has(v.artikelnummer)) return json({ error: `Artikelnummer ${v.artikelnummer} finns flera gånger` }, 400);
        seen.add(v.artikelnummer);
        rows.push(v);
      }
      // Nuläget för alla artiklar (en fråga), för ändringsloggen.
      const now = await allArticles(db);
      const changes = [];
      let nya = 0;
      for (const r of rows) {
        const fore = now.get(r.artikelnummer) || null;
        const efter = { h: r.hyllsida, b: r.beteckning ?? (fore ? fore.b : null) };
        if (!fore) nya++;
        if (!fore || fore.h !== efter.h || fore.b !== efter.b) changes.push({ nr: r.artikelnummer, fore, efter });
      }
      if (!changes.length) return json({ ok: true, antal: 0, nya: 0, uppdaterade: 0 });
      // D1 tillåter max 100 parametrar per fråga, så raderna skickas i grupper om 33 (3 parametrar per rad).
      // Allt körs i en batch, så antingen sparas allt eller ingenting.
      const stmts = [];
      for (let i = 0; i < rows.length; i += 33) {
        const chunk = rows.slice(i, i + 33);
        stmts.push(db.prepare(
          `INSERT INTO artiklar (artikelnummer, hyllsida, beteckning) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}
           ON CONFLICT(artikelnummer) DO UPDATE SET
             hyllsida = excluded.hyllsida,
             beteckning = COALESCE(excluded.beteckning, artiklar.beteckning)`
        ).bind(...chunk.flatMap((r) => [r.artikelnummer, r.hyllsida, r.beteckning])));
      }
      const andrade = changes.length - nya;
      stmts.push(
        logStmt(db, `Import: ${nya} nya, ${andrade} ändrade`, changes),
        db.prepare('DELETE FROM saknas WHERE artikelnummer IN (SELECT artikelnummer FROM artiklar)'),
        bumpVersion(db),
      );
      await db.batch(stmts);
      return json({ ok: true, antal: rows.length, nya, uppdaterade: andrade });
    }

    // Sökningar som inte gav träff
    if (path === '/api/admin/saknas' && method === 'GET') {
      const grans = new Date(Date.now() - MISSING_DAYS * 864e5).toISOString();
      const [, rows] = await db.batch([
        db.prepare('DELETE FROM saknas WHERE senast < ? OR artikelnummer IN (SELECT artikelnummer FROM artiklar)').bind(grans),
        db.prepare('SELECT artikelnummer, antal, forst, senast FROM saknas ORDER BY antal DESC, senast DESC LIMIT 200'),
      ]);
      return json({ saknas: rows.results });
    }
    const ms = path.match(/^\/api\/admin\/saknas\/([^/]+)$/);
    if (ms && method === 'DELETE') {
      await db.prepare('DELETE FROM saknas WHERE artikelnummer = ?').bind(cleanNr(decodeURIComponent(ms[1]))).run();
      return json({ ok: true });
    }

    // Ändringslogg
    if (path === '/api/admin/andringar' && method === 'GET') {
      const [, rows] = await db.batch([
        db.prepare('DELETE FROM andringar WHERE id NOT IN (SELECT id FROM andringar ORDER BY id DESC LIMIT ?)').bind(LOG_KEEP),
        db.prepare('SELECT id, tid, beskrivning, antal, angrad FROM andringar ORDER BY id DESC LIMIT 100'),
      ]);
      return json({ andringar: rows.results });
    }

    // Ångra en ändring (även en hel import). Går bara om artiklarna inte har ändrats igen efteråt.
    const mu = path.match(/^\/api\/admin\/andringar\/(\d+)\/angra$/);
    if (mu && method === 'POST') {
      const entry = await db.prepare('SELECT * FROM andringar WHERE id = ?').bind(Number(mu[1])).first();
      if (!entry) return json({ error: 'Ändringen finns inte längre' }, 404);
      if (entry.angrad) return json({ error: 'Ändringen är redan ångrad' }, 409);
      const items = JSON.parse(entry.data);
      const now = await allArticles(db);
      const same = (a, b) => (!a && !b) || (a && b && a.h === b.h && a.b === b.b);
      const krock = items.filter((it) => !same(now.get(it.nr) || null, it.efter)).map((it) => it.nr);
      if (krock.length) {
        return json({ error: `Kan inte ångras: ${krock.slice(0, 5).join(', ')}${krock.length > 5 ? ` och ${krock.length - 5} till` : ''} har ändrats efter det` }, 409);
      }
      const restore = items.filter((it) => it.fore), remove = items.filter((it) => !it.fore).map((it) => it.nr);
      const stmts = [];
      for (let i = 0; i < restore.length; i += 33) {
        const chunk = restore.slice(i, i + 33);
        stmts.push(db.prepare(
          `INSERT INTO artiklar (artikelnummer, hyllsida, beteckning) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}
           ON CONFLICT(artikelnummer) DO UPDATE SET hyllsida = excluded.hyllsida, beteckning = excluded.beteckning`
        ).bind(...chunk.flatMap((it) => [it.nr, it.fore.h, it.fore.b])));
      }
      for (let i = 0; i < remove.length; i += 99) {
        const chunk = remove.slice(i, i + 99);
        stmts.push(db.prepare(`DELETE FROM artiklar WHERE artikelnummer IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk));
      }
      stmts.push(
        db.prepare('UPDATE andringar SET angrad = 1 WHERE id = ?').bind(entry.id),
        logStmt(db, entry.beskrivning.startsWith('Ångrade: ') ? `Gjorde om: ${entry.beskrivning.slice(9)}` : `Ångrade: ${entry.beskrivning}`, items.map((it) => ({ nr: it.nr, fore: it.efter, efter: it.fore }))),
        bumpVersion(db),
      );
      await db.batch(stmts);
      return json({ ok: true });
    }

    const m = path.match(/^\/api\/admin\/artiklar\/([^/]+)$/);
    if (m) {
      const nr = cleanNr(decodeURIComponent(m[1]));

      if (method === 'PUT') {
        const body = await readJson(request);
        const v = validate({ ...body, artikelnummer: nr }, false);
        if (v.error) return json({ error: v.error }, 400);
        const fore = await getArticle(db, nr);
        if (!fore) return json({ error: 'Artikeln finns inte' }, 404);
        const efter = { h: v.hyllsida, b: v.beteckning };
        const stmts = [db.prepare('UPDATE artiklar SET hyllsida = ?, beteckning = ? WHERE artikelnummer = ?').bind(v.hyllsida, v.beteckning, nr)];
        if (fore.h !== efter.h || fore.b !== efter.b) {
          const vad = fore.h !== efter.h ? `hylla ${fore.h} → ${efter.h}` : 'ny beteckning';
          stmts.push(logStmt(db, `Ändrade ${nr}: ${vad}`, [{ nr, fore, efter }]));
        }
        stmts.push(bumpVersion(db));
        await db.batch(stmts);
        return json({ ok: true, artikel: v });
      }

      if (method === 'DELETE') {
        const fore = await getArticle(db, nr);
        if (!fore) return json({ error: 'Artikeln finns inte' }, 404);
        await db.batch([
          db.prepare('DELETE FROM artiklar WHERE artikelnummer = ?').bind(nr),
          logStmt(db, `Tog bort ${nr} (hylla ${fore.h})`, [{ nr, fore, efter: null }]),
          bumpVersion(db),
        ]);
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
    db.prepare('CREATE TABLE IF NOT EXISTS saknas (artikelnummer TEXT PRIMARY KEY, antal INTEGER NOT NULL, forst TEXT NOT NULL, senast TEXT NOT NULL)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS andringar (id INTEGER PRIMARY KEY AUTOINCREMENT, tid TEXT NOT NULL,
      beskrivning TEXT NOT NULL, antal INTEGER NOT NULL, data TEXT NOT NULL, angrad INTEGER NOT NULL DEFAULT 0)`),
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

// ---------- Ändringslogg ----------
// Varje rad i loggen sparar läget före och efter för alla artiklar som ändrades, så att den kan ångras.
function logStmt(db, beskrivning, items) {
  return db.prepare('INSERT INTO andringar (tid, beskrivning, antal, data) VALUES (?, ?, ?, ?)')
    .bind(new Date().toISOString(), beskrivning, items.length, JSON.stringify(items));
}

async function getArticle(db, nr) {
  const r = await db.prepare('SELECT hyllsida, beteckning FROM artiklar WHERE artikelnummer = ?').bind(nr).first();
  return r ? { h: r.hyllsida, b: r.beteckning ?? null } : null;
}

async function allArticles(db) {
  const rows = await db.prepare('SELECT artikelnummer, hyllsida, beteckning FROM artiklar').all();
  return new Map(rows.results.map((r) => [r.artikelnummer, { h: r.hyllsida, b: r.beteckning ?? null }]));
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
