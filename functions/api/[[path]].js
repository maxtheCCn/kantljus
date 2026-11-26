// Kantljus admin-API (Cloudflare Pages Functions)
//
// Kräver två inställningar i Cloudflare (Pages-projektet → Settings):
//   • Binding:  D1-databas med variabelnamnet  DB
//   • Secret:   ADMIN_KOD  = koden man loggar in med (minst 8 tecken)
//
// Ingen kunddata ligger i GitHub – allt sparas i D1-databasen.

const COOKIE = 'kl_admin';
const TTL = 60 * 60 * 12;            // inloggad i 12 timmar
const MAX_FEL = 8;                   // felaktiga försök per IP …
const FEL_FONSTER = 15 * 60 * 1000;  // … under 15 minuter
const enc = new TextEncoder();
let tabellerKlara = false;

const svar = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      ...extra,
    },
  });

async function hmac(nyckel, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode(nyckel), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
  let s = '';
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function lika(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const hemlighet = (env) => 'kantljus-session:' + (env.SESSION_SECRET || env.ADMIN_KOD);

async function nyttToken(env) {
  const exp = Math.floor(Date.now() / 1000) + TTL;
  return exp + '.' + (await hmac(hemlighet(env), 'admin.' + exp));
}

async function inloggad(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return lika(sig, await hmac(hemlighet(env), 'admin.' + exp));
}

// ---------- personkod (t.ex. Max) ----------
// Max kräver alltid en egen kod (secret KOD_MAX). Andra kan få det genom att
// lägga in KOD_<NAMN>, t.ex. KOD_WILLIAM.
const PCOOKIE = 'kl_person';
const KRAVER_KOD = ['Max'];
const kodNyckel = (namn) => 'KOD_' + String(namn).toUpperCase().replace(/[ÅÄ]/g, 'A').replace(/Ö/g, 'O').replace(/[^A-Z]/g, '');
const personKrav = (env, namn) => KRAVER_KOD.includes(namn) || !!env[kodNyckel(namn)];
const giltigtNamn = (n) => typeof n === 'string' && /^[A-Za-zÅÄÖåäö-]{2,30}$/.test(n);

async function verifieradPerson(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + PCOOKIE + '=([^;]+)'));
  if (!m) return null;
  const [namn, exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!namn || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  return lika(sig, await hmac(hemlighet(env), 'person.' + namn + '.' + exp)) ? namn : null;
}
async function personCookie(env, namn) {
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const v = encodeURIComponent(namn + '.' + exp + '.' + (await hmac(hemlighet(env), 'person.' + namn + '.' + exp)));
  return `${PCOOKIE}=${v}; Path=/api; Max-Age=${TTL}; HttpOnly; Secure; SameSite=Strict`;
}

async function skapaTabeller(env) {
  if (tabellerKlara) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS foretag (id TEXT PRIMARY KEY, data TEXT NOT NULL, uppdaterad INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS inloggning_fel (ip TEXT NOT NULL, tid INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS poster (id TEXT PRIMARY KEY, data TEXT NOT NULL, datum TEXT NOT NULL)'),
  ]);
  tabellerKlara = true;
}

const giltigtId = (id) => typeof id === 'string' && /^[a-z0-9-]{6,48}$/.test(id);

function rensa(rec, id) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('Ogiltig post');
  if (typeof rec.namn !== 'string' || !rec.namn.trim()) throw new Error('Företaget saknar namn');
  const json = JSON.stringify({ ...rec, id });
  if (json.length > 200_000) throw new Error('Posten är för stor');
  return JSON.parse(json);
}

// Ekonomi: en post är pengar in (intäkt) eller pengar ut (uttag)
const BETALSATT = ['Swish', 'Faktura', 'Annat'];
function rensaPost(p, id) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Ogiltig post');
  const typ = p.typ;
  if (typ !== 'in' && typ !== 'ut') throw new Error('Typ måste vara in eller ut');
  const belopp = Number(p.belopp);
  if (!Number.isInteger(belopp) || belopp < 1 || belopp > 10_000_000) throw new Error('Beloppet måste vara ett heltal i kronor');
  if (typeof p.datum !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.datum)) throw new Error('Ogiltigt datum');
  const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const ut = {
    id, typ, belopp, datum: p.datum,
    kund_id: typ === 'in' && giltigtId(p.kund_id) ? p.kund_id : '',
    kund_namn: typ === 'in' ? txt(p.kund_namn, 200) : '',
    person: typ === 'ut' ? txt(p.person, 40) : '',
    betalsatt: typ === 'in' ? (BETALSATT.includes(p.betalsatt) ? p.betalsatt : 'Swish') : '',
    kommentar: txt(p.kommentar, 500),
    skapad_av: txt(p.skapad_av, 40),
    skapad_tid: typeof p.skapad_tid === 'string' && p.skapad_tid ? p.skapad_tid.slice(0, 40) : new Date().toISOString(),
  };
  if (typ === 'ut' && !ut.person) throw new Error('Välj vem som tar ut');
  return ut;
}

async function hamta(env, id) {
  const rad = await env.DB.prepare('SELECT data FROM foretag WHERE id = ?').bind(id).first();
  return rad ? JSON.parse(rad.data) : null;
}

async function spara(env, rec) {
  rec.uppdaterad = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO foretag (id, data, uppdaterad) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, uppdaterad = excluded.uppdaterad'
  ).bind(rec.id, JSON.stringify(rec), Date.now()).run();
  return rec;
}

export async function onRequest({ request, env, params }) {
  const saknas = [];
  if (!env.DB) saknas.push('DB');
  if (!env.ADMIN_KOD) saknas.push('ADMIN_KOD');
  if (saknas.length) return svar({ fel: 'ej_konfigurerad', saknas }, 503);

  const url = new URL(request.url);
  const delar = [].concat(params.path || []).filter(Boolean);
  const metod = request.method;

  // Skydd mot att andra sajter skickar anrop i ditt namn
  if (metod !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return svar({ fel: 'Fel ursprung' }, 403);
  }

  try {
    await skapaTabeller(env);

    // ---------- inloggning ----------
    if (delar[0] === 'login' && metod === 'POST') {
      const ip = request.headers.get('cf-connecting-ip') || 'okand';
      const sedan = Date.now() - FEL_FONSTER;
      await env.DB.prepare('DELETE FROM inloggning_fel WHERE tid < ?').bind(sedan).run();
      const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM inloggning_fel WHERE ip = ? AND tid >= ?').bind(ip, sedan).first();
      if (n >= MAX_FEL) return svar({ fel: 'For manga forsok' }, 429);

      const { kod } = await request.json().catch(() => ({}));
      const ratt = typeof kod === 'string' &&
        lika(await hmac(hemlighet(env), 'kod:' + kod), await hmac(hemlighet(env), 'kod:' + env.ADMIN_KOD));
      if (!ratt) {
        await env.DB.prepare('INSERT INTO inloggning_fel (ip, tid) VALUES (?, ?)').bind(ip, Date.now()).run();
        await new Promise((r) => setTimeout(r, 600));
        return svar({ fel: 'Fel kod', kvar: Math.max(0, MAX_FEL - n - 1) }, 401);
      }
      await env.DB.prepare('DELETE FROM inloggning_fel WHERE ip = ?').bind(ip).run();
      const token = await nyttToken(env);
      return svar({ ok: true }, 200, {
        'set-cookie': `${COOKIE}=${token}; Path=/api; Max-Age=${TTL}; HttpOnly; Secure; SameSite=Strict`,
      });
    }

    if (delar[0] === 'logout' && metod === 'POST') {
      const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      h.append('set-cookie', `${COOKIE}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      h.append('set-cookie', `${PCOOKIE}=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
    }

    // ---------- allt nedanför kräver inloggning ----------
    if (!(await inloggad(request, env))) return svar({ fel: 'Inte inloggad' }, 401);

    const person = await verifieradPerson(request, env);
    // Den som loggar något i ett kodskyddat namn måste ha låst upp det namnet
    const far = (namn) => !namn || !personKrav(env, namn) || person === namn;
    const nekad = (namn) => svar({ fel: `Välj ${namn} igen och skriv koden för ${namn}` }, 403);

    if (delar[0] === 'session' && metod === 'GET') return svar({ ok: true, person });

    // POST /api/person – välj vem man är (med kod om det krävs)
    if (delar[0] === 'person' && metod === 'POST') {
      const { namn, kod } = await request.json().catch(() => ({}));
      if (!giltigtNamn(namn)) return svar({ fel: 'Ogiltigt namn' }, 400);
      if (!personKrav(env, namn)) return svar({ ok: true, person: namn }, 200, { 'set-cookie': await personCookie(env, namn) });
      const nyckel = kodNyckel(namn);
      if (!env[nyckel]) return svar({ fel: 'saknar_kod', saknas: [nyckel] }, 503);
      if (typeof kod !== 'string' || !kod) return svar({ krav: true }, 401);
      const ip = 'p:' + (request.headers.get('cf-connecting-ip') || 'okand');
      const sedan = Date.now() - FEL_FONSTER;
      const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM inloggning_fel WHERE ip = ? AND tid >= ?').bind(ip, sedan).first();
      if (n >= MAX_FEL) return svar({ fel: 'For manga forsok' }, 429);
      const ratt = lika(await hmac(hemlighet(env), 'pkod:' + kod), await hmac(hemlighet(env), 'pkod:' + env[nyckel]));
      if (!ratt) {
        await env.DB.prepare('INSERT INTO inloggning_fel (ip, tid) VALUES (?, ?)').bind(ip, Date.now()).run();
        await new Promise((r) => setTimeout(r, 600));
        return svar({ krav: true, fel: 'Fel kod', kvar: Math.max(0, MAX_FEL - n - 1) }, 401);
      }
      await env.DB.prepare('DELETE FROM inloggning_fel WHERE ip = ?').bind(ip).run();
      return svar({ ok: true, person: namn }, 200, { 'set-cookie': await personCookie(env, namn) });
    }

    // ---------- ekonomi ----------
    if (delar[0] === 'poster') {
      if (delar.length === 1 && metod === 'GET') {
        const { results } = await env.DB.prepare('SELECT data FROM poster ORDER BY datum DESC').all();
        return svar(results.map((r) => JSON.parse(r.data)));
      }
      const pid = delar[1];
      if (delar.length !== 2 || !giltigtId(pid)) return svar({ fel: 'Ogiltigt id' }, 400);
      if (metod === 'PUT') {
        const post = rensaPost(await request.json(), pid);
        if (!far(post.skapad_av)) return nekad(post.skapad_av);
        await env.DB.prepare(
          'INSERT INTO poster (id, data, datum) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, datum = excluded.datum'
        ).bind(pid, JSON.stringify(post), post.datum).run();
        return svar(post);
      }
      if (metod === 'DELETE') {
        await env.DB.prepare('DELETE FROM poster WHERE id = ?').bind(pid).run();
        return svar({ ok: true });
      }
      return svar({ fel: 'Finns inte' }, 404);
    }

    if (delar[0] !== 'foretag') return svar({ fel: 'Finns inte' }, 404);

    // GET /api/foretag – alla företag
    if (delar.length === 1 && metod === 'GET') {
      const { results } = await env.DB.prepare('SELECT data FROM foretag ORDER BY uppdaterad DESC').all();
      return svar(results.map((r) => JSON.parse(r.data)));
    }

    // POST /api/foretag/import – många på en gång
    if (delar[1] === 'import' && metod === 'POST') {
      const lista = await request.json();
      if (!Array.isArray(lista) || lista.length > 500) return svar({ fel: 'Max 500 rader per import' }, 400);
      const nu = new Date().toISOString();
      const poster = lista.map((r) => {
        if (!giltigtId(r.id)) throw new Error('Ogiltigt id');
        return { ...rensa(r, r.id), uppdaterad: nu };
      });
      if (poster.length) {
        await env.DB.batch(poster.map((p) =>
          env.DB.prepare('INSERT OR IGNORE INTO foretag (id, data, uppdaterad) VALUES (?, ?, ?)').bind(p.id, JSON.stringify(p), Date.now())
        ));
      }
      return svar({ ok: true, antal: poster.length });
    }

    const id = delar[1];
    if (!giltigtId(id)) return svar({ fel: 'Ogiltigt id' }, 400);

    // PUT /api/foretag/:id – skapa eller uppdatera
    if (delar.length === 2 && metod === 'PUT') {
      const rec = rensa(await request.json(), id);
      const gammal = await hamta(env, id);
      const nyRingare = rec.ringer && rec.ringer.av;
      if (nyRingare && (rec.ringer.av !== gammal?.ringer?.av || rec.ringer.tid !== gammal?.ringer?.tid) && !far(nyRingare)) return nekad(nyRingare);
      // Samtal sparas bara via /samtal, så två som ringer samtidigt inte skriver över varandra
      rec.samtal = gammal ? gammal.samtal || [] : Array.isArray(rec.samtal) ? rec.samtal : [];
      return svar(await spara(env, rec));
    }

    // POST /api/foretag/:id/samtal – logga ett samtal
    if (delar[2] === 'samtal' && metod === 'POST') {
      const rec = await hamta(env, id);
      if (!rec) return svar({ fel: 'Företaget finns inte' }, 404);
      const { samtal, status, nasta, nastaNotis } = await request.json();
      if (!samtal || typeof samtal.sa !== 'string') return svar({ fel: 'Samtalet saknar text' }, 400);
      if (!far(samtal.av)) return nekad(samtal.av);
      rec.samtal = [...(rec.samtal || []), {
        id: String(samtal.id || Date.now().toString(36)).slice(0, 40),
        tid: samtal.tid || new Date().toISOString(),
        av: String(samtal.av || '').slice(0, 40),
        utfall: String(samtal.utfall || '').slice(0, 40),
        sa: samtal.sa.slice(0, 5000),
      }];
      if (status) rec.status = status;
      if (nasta !== undefined) rec.nasta = nasta;
      if (nastaNotis !== undefined) rec.nastaNotis = nastaNotis;
      return svar(await spara(env, rec));
    }

    // DELETE /api/foretag/:id
    if (delar.length === 2 && metod === 'DELETE') {
      await env.DB.prepare('DELETE FROM foretag WHERE id = ?').bind(id).run();
      return svar({ ok: true });
    }

    return svar({ fel: 'Finns inte' }, 404);
  } catch (e) {
    return svar({ fel: e.message || 'Serverfel' }, 400);
  }
}
