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
// Alla kräver en egen kod: secret KOD_<NAMN>, t.ex. KOD_MAX, KOD_WILLIAM, KOD_JOHNJOHN.
// Saknas koden kan ingen välja det namnet. (kl_person2: gamla kakor utan kod gäller inte längre.)
const PCOOKIE = 'kl_person2';
const kodNyckel = (namn) => 'KOD_' + String(namn).toUpperCase().replace(/[ÅÄ]/g, 'A').replace(/Ö/g, 'O').replace(/[^A-Z]/g, '');
const giltigtNamn = (n) => typeof n === 'string' && /^[A-Za-zÅÄÖåäö-]{2,30}$/.test(n);

async function verifieradPerson(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + PCOOKIE + '=([^;]+)'));
  if (!m) return null;
  const [namn, exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!namn || !exp || !sig || Number(exp) < Date.now() / 1000) return null;
  if (!env[kodNyckel(namn)]) return null;
  return lika(sig, await hmac(hemlighet(env), 'person2.' + namn + '.' + exp)) ? namn : null;
}
async function personCookie(env, namn) {
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const v = encodeURIComponent(namn + '.' + exp + '.' + (await hmac(hemlighet(env), 'person2.' + namn + '.' + exp)));
  return `${PCOOKIE}=${v}; Path=/api; Max-Age=${TTL}; HttpOnly; Secure; SameSite=Strict`;
}

async function skapaTabeller(env) {
  if (tabellerKlara) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS foretag (id TEXT PRIMARY KEY, data TEXT NOT NULL, uppdaterad INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS inloggning_fel (ip TEXT NOT NULL, tid INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS poster (id TEXT PRIMARY KEY, data TEXT NOT NULL, datum TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS nycklar (hash TEXT PRIMARY KEY, person TEXT NOT NULL, skapad TEXT NOT NULL, senast TEXT, aktiv INTEGER NOT NULL DEFAULT 1)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS jobbar (person TEXT PRIMARY KEY, data TEXT NOT NULL, tid INTEGER NOT NULL)'),
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

// ---------- personliga nycklar (skillen Connect till kantljus.se) ----------
// Nyckeln visas bara en gång, när den skapas. I databasen sparas bara en hash.
async function sha256(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function nyNyckel() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return 'kl_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function nyckelPerson(request, env) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(kl_[0-9a-f]{64})$/);
  if (!m) return null;
  const hash = await sha256(m[1]);
  const rad = await env.DB.prepare('SELECT person FROM nycklar WHERE hash = ? AND aktiv = 1').bind(hash).first();
  if (!rad) return null;
  await env.DB.prepare('UPDATE nycklar SET senast = ? WHERE hash = ?').bind(new Date().toISOString(), hash).run();
  return rad.person;
}
const JOBBAR_TTL = 4 * 60 * 60 * 1000; // "jobbar just nu" försvinner efter 4 timmar utan nytt

// Vad vi söker på för att hitta företaget på kartan: adressen, plus Stockholm om ingen ort står med
function platsFraga(rec) {
  const a = typeof rec.ort === 'string' ? rec.ort.trim().slice(0, 160) : '';
  if (!a) return '';
  return /\d{3}\s?\d{2}|stockholm|solna|sundbyberg|nacka|lidingö|danderyd|täby|sollentuna|huddinge|bromma|sverige/i.test(a) ? a : a + ', Stockholm';
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
    const harBearer = /^Bearer\s/i.test(request.headers.get('authorization') || '');
    const viaNyckel = harBearer ? await nyckelPerson(request, env) : null;
    if (harBearer && !viaNyckel) return svar({ fel: 'Nyckeln fungerar inte längre. Ladda ner en ny under Skills i admin.' }, 401);
    if (!viaNyckel && !(await inloggad(request, env))) return svar({ fel: 'Inte inloggad' }, 401);

    const person = viaNyckel || (await verifieradPerson(request, env));
    // Den som loggar något i ett kodskyddat namn måste ha låst upp det namnet
    const far = (namn) => !namn || !personKrav(env, namn) || person === namn;
    const nekad = (namn) => svar({ fel: `Välj ${namn} igen och skriv koden för ${namn}` }, 403);

    if (delar[0] === 'session' && metod === 'GET') return svar({ ok: true, person });

    // POST /api/person – välj vem man är (med kod om det krävs)
    if (delar[0] === 'person' && metod === 'POST') {
      const { namn, kod } = await request.json().catch(() => ({}));
      if (!giltigtNamn(namn)) return svar({ fel: 'Ogiltigt namn' }, 400);
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

    // ---------- nycklar ----------
    if (delar[0] === 'nycklar') {
      if (viaNyckel) return svar({ fel: 'Nycklar hanteras bara inne i admin' }, 403);
      if (!person) return svar({ fel: 'Välj vem du är först' }, 403);
      if (delar.length === 1 && metod === 'POST') {
        const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM nycklar WHERE person = ? AND aktiv = 1').bind(person).first();
        if (n >= 10) return svar({ fel: 'Du har redan 10 aktiva nycklar. Stäng av några först.' }, 400);
        const nyckel = nyNyckel();
        const hash = await sha256(nyckel);
        await env.DB.prepare('INSERT INTO nycklar (hash, person, skapad, aktiv) VALUES (?, ?, ?, 1)').bind(hash, person, new Date().toISOString()).run();
        return svar({ nyckel, id: hash.slice(0, 10), person });
      }
      if (delar.length === 1 && metod === 'GET') {
        const q = person === 'Max'
          ? env.DB.prepare('SELECT hash, person, skapad, senast FROM nycklar WHERE aktiv = 1 ORDER BY skapad DESC')
          : env.DB.prepare('SELECT hash, person, skapad, senast FROM nycklar WHERE aktiv = 1 AND person = ? ORDER BY skapad DESC').bind(person);
        const { results } = await q.all();
        return svar(results.map((r) => ({ id: r.hash.slice(0, 10), person: r.person, skapad: r.skapad, senast: r.senast || '' })));
      }
      if (delar.length === 2 && metod === 'DELETE' && /^[0-9a-f]{10}$/.test(delar[1])) {
        const rad = await env.DB.prepare('SELECT hash, person FROM nycklar WHERE substr(hash, 1, 10) = ? AND aktiv = 1').bind(delar[1]).first();
        if (!rad) return svar({ fel: 'Nyckeln finns inte' }, 404);
        if (rad.person !== person && person !== 'Max') return svar({ fel: 'Bara Max kan stänga av andras nycklar' }, 403);
        await env.DB.prepare('UPDATE nycklar SET aktiv = 0 WHERE hash = ?').bind(rad.hash).run();
        return svar({ ok: true });
      }
      return svar({ fel: 'Finns inte' }, 404);
    }

    // ---------- jobbar just nu ----------
    if (delar[0] === 'jobbar') {
      if (delar.length === 1 && metod === 'GET') {
        await env.DB.prepare('DELETE FROM jobbar WHERE tid < ?').bind(Date.now() - JOBBAR_TTL).run();
        const { results } = await env.DB.prepare('SELECT data FROM jobbar ORDER BY tid DESC').all();
        return svar(results.map((r) => JSON.parse(r.data)));
      }
      if (!person) return svar({ fel: 'Välj vem du är först' }, 403);
      const kropp = await request.json().catch(() => ({}));
      const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
      const nu = new Date().toISOString();
      const gammal = await env.DB.prepare('SELECT data FROM jobbar WHERE person = ?').bind(person).first();
      const forra = gammal ? JSON.parse(gammal.data) : null;
      const logga = async (fid, rad) => {
        if (!giltigtId(fid)) return null;
        const rec = await hamta(env, fid);
        if (!rec) return null;
        rec.arbete = [...(rec.arbete || []), rad].slice(-40);
        await spara(env, rec);
        return rec;
      };
      if (delar.length === 1 && metod === 'POST') {
        const vad = txt(kropp.vad, 200);
        if (!vad) return svar({ fel: 'Skriv vad du jobbar med' }, 400);
        const fid = giltigtId(kropp.foretag_id) ? kropp.foretag_id : '';
        const samma = forra && forra.foretag_id === fid && forra.vad === vad;
        const rec = fid ? (samma ? await hamta(env, fid) : await logga(fid, { tid: nu, av: person, typ: 'start', vad })) : null;
        if (fid && !rec) return svar({ fel: 'Företaget finns inte' }, 404);
        const data = { person, vad, foretag_id: fid, foretag_namn: rec?.namn || txt(kropp.foretag_namn, 120), start: samma ? forra.start : nu, uppdaterad: nu, kalla: viaNyckel ? 'claude' : 'admin' };
        await env.DB.prepare('INSERT INTO jobbar (person, data, tid) VALUES (?, ?, ?) ON CONFLICT(person) DO UPDATE SET data = excluded.data, tid = excluded.tid').bind(person, JSON.stringify(data), Date.now()).run();
        return svar(data);
      }
      if (delar[1] === 'klar' && metod === 'POST') {
        if (forra?.foretag_id) await logga(forra.foretag_id, { tid: nu, av: person, typ: 'klar', vad: txt(kropp.notis, 500) || forra.vad });
        await env.DB.prepare('DELETE FROM jobbar WHERE person = ?').bind(person).run();
        return svar({ ok: true, var: forra });
      }
      return svar({ fel: 'Finns inte' }, 404);
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

    // POST /api/foretag/:id/plats – hitta företaget på kartan (OpenStreetMap / Nominatim)
    // Med { lat, lng } i kroppen flyttas pricken för hand. Annars slås adressen upp en gång och sparas.
    if (delar[2] === 'plats' && metod === 'POST') {
      const rec = await hamta(env, id);
      if (!rec) return svar({ fel: 'Företaget finns inte' }, 404);
      const kropp = await request.json().catch(() => ({}));
      const q = platsFraga(rec);
      if (Number.isFinite(kropp.lat) && Number.isFinite(kropp.lng)) {
        if (Math.abs(kropp.lat - 59.33) > 3 || Math.abs(kropp.lng - 18.07) > 6) return svar({ fel: 'Pricken hamnade för långt bort' }, 400);
        rec.plats = { lat: +kropp.lat.toFixed(6), lng: +kropp.lng.toFixed(6), q, manuell: true, av: person || '', tid: new Date().toISOString() };
        return svar(await spara(env, rec));
      }
      if (!q) return svar({ fel: 'Företaget saknar adress' }, 400);
      if (rec.plats && rec.plats.q === q && !kropp.igen) return svar(rec);
      const u = new URL('https://nominatim.openstreetmap.org/search');
      u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'se', viewbox: '17.75,59.45,18.35,59.2', bounded: '0', 'accept-language': 'sv' });
      const r = await fetch(u, { headers: { 'User-Agent': 'kantljus-admin/1 (https://kantljus.se)', Referer: 'https://kantljus.se/' } }).catch(() => null);
      if (!r || !r.ok) return svar({ fel: 'Kartsöket svarar inte just nu. Försök igen om en stund.' }, 502);
      const [hit] = await r.json();
      rec.plats = hit
        ? { lat: +(+hit.lat).toFixed(6), lng: +(+hit.lon).toFixed(6), q, namn: String(hit.display_name || '').slice(0, 160), tid: new Date().toISOString() }
        : { fel: true, q, tid: new Date().toISOString() };
      return svar(await spara(env, rec));
    }

    // POST /api/foretag/:id/avsluta – bara Max får avsluta ett pågående samtal
    if (delar[2] === 'avsluta' && metod === 'POST') {
      if (person !== 'Max') return svar({ fel: 'Bara Max kan avsluta samtal' }, 403);
      const rec = await hamta(env, id);
      if (!rec) return svar({ fel: 'Företaget finns inte' }, 404);
      const vem = rec.ringer?.av || '';
      rec.ringer = null;
      rec.avslutade = [...(rec.avslutade || []), { tid: new Date().toISOString(), av: 'Max', ringare: vem }].slice(-20);
      return svar(await spara(env, rec));
    }

    // POST /api/foretag/:id/status – bara Max får ändra status från Live-listorna
    if (delar[2] === 'status' && metod === 'POST') {
      if (person !== 'Max') return svar({ fel: 'Bara Max kan ändra status här' }, 403);
      const { status, nasta } = await request.json().catch(() => ({}));
      const TILLATNA = ['att_ringa', 'inget_svar', 'aterkom', 'intresserad', 'mote', 'offert', 'kund', 'nej'];
      if (!TILLATNA.includes(status)) return svar({ fel: 'Ogiltig status' }, 400);
      const rec = await hamta(env, id);
      if (!rec) return svar({ fel: 'Företaget finns inte' }, 404);
      const fran = rec.status;
      rec.status = status;
      rec.ringer = null;
      if (status === 'aterkom') { rec.nasta = /^\d{4}-\d{2}-\d{2}$/.test(nasta || '') ? nasta : ''; rec.nastaNotis = 'Max flyttade till Ring tillbaka'; }
      else if (['att_ringa', 'inget_svar', 'nej'].includes(status)) { rec.nasta = ''; rec.nastaNotis = ''; }
      if (status === 'kund' && !rec.kund?.sedan) rec.kund = { ...(rec.kund || {}), sedan: new Date().toISOString().slice(0, 10) };
      rec.andringar = [...(rec.andringar || []), { tid: new Date().toISOString(), av: 'Max', fran, till: status }].slice(-30);
      return svar(await spara(env, rec));
    }

    // PUT /api/foretag/:id – skapa eller uppdatera
    if (delar.length === 2 && metod === 'PUT') {
      const rec = rensa(await request.json(), id);
      const gammal = await hamta(env, id);
      const nyRingare = rec.ringer && rec.ringer.av;
      if (nyRingare && (rec.ringer.av !== gammal?.ringer?.av || rec.ringer.tid !== gammal?.ringer?.tid) && !far(nyRingare)) return nekad(nyRingare);
      // Samtal sparas bara via /samtal, så två som ringer samtidigt inte skriver över varandra
      rec.samtal = gammal ? gammal.samtal || [] : Array.isArray(rec.samtal) ? rec.samtal : [];
      rec.arbete = gammal ? gammal.arbete || [] : [];
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
