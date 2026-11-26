#!/usr/bin/env python3
"""Connect till kantljus.se: pratar med Kantljus admin.

Kör:  python3 scripts/kantljus.py <kommando> [...]
Se SKILL.md för alla kommandon. Läser namn och nyckel från config.json bredvid SKILL.md.
Skriv aldrig ut nyckeln.
"""
import argparse
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from datetime import date

ROT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATUS = {
    'att_ringa': 'Att ringa', 'inget_svar': 'Svarade inte', 'aterkom': 'Ring tillbaka',
    'intresserad': 'Intresserad', 'mote': 'Möte bokat', 'offert': 'Offert skickad',
    'kund': 'Kund', 'nej': 'Nej tack',
}
JA = {'intresserad', 'mote', 'offert', 'kund'}
FALT = ['namn', 'telefon', 'ort', 'bransch', 'webb', 'kontakt', 'epost', 'ansvarig', 'hemsidaNotis']


def konfig():
    try:
        with open(os.path.join(ROT, 'config.json'), encoding='utf-8') as f:
            k = json.load(f)
    except FileNotFoundError:
        sys.exit('config.json saknas. Ladda ner din egen version av skillen under Skills i Kantljus admin.')
    if not k.get('nyckel', '').startswith('kl_'):
        sys.exit('config.json saknar nyckel. Ladda ner skillen igen under Skills i Kantljus admin.')
    return k


K = None


def api(sokvag, metod='GET', data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(
        K.get('bas', 'https://kantljus.se').rstrip('/') + '/api' + sokvag, data=body, method=metod,
        headers={'Authorization': 'Bearer ' + K['nyckel'], 'Content-Type': 'application/json',
                 'User-Agent': 'kantljus-skill/1'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        try:
            fel = json.loads(e.read()).get('fel', '')
        except Exception:
            fel = ''
        sys.exit(f'FEL {e.code}: {fel or e.reason}')
    except urllib.error.URLError as e:
        sys.exit('NÄTVERK: kommer inte åt kantljus.se (' + str(e.reason) + '). '
                 'Lägg till kantljus.se som tillåten domän i Claudes inställningar och försök igen.')


def siffror(t):
    return re.sub(r'\D', '', t or '')


def rad(f):
    s = STATUS.get(f.get('status'), f.get('status', ''))
    extra = f" · nästa {f['nasta']}" if f.get('nasta') else ''
    return f"{f['id']} | {f.get('namn', '')} | {f.get('telefon', '') or '-'} | {f.get('ort', '') or '-'} | {s}{extra}"


def alla():
    return api('/foretag')


def hitta(fid):
    for f in alla():
        if f['id'] == fid:
            return f
    sys.exit('Hittar inget företag med id ' + fid + '. Använd sok först.')


def k_vem(a):
    s = api('/session')
    print(f"Ansluten till kantljus.se som {s.get('person') or K.get('namn')}.")


def k_sok(a):
    q = a.text.lower().strip()
    qs = siffror(q)
    tr = [f for f in alla() if q in (f.get('namn', '') + ' ' + f.get('ort', '') + ' ' + f.get('bransch', '')).lower()
          or (len(qs) >= 4 and qs in siffror(f.get('telefon', '')))]
    print('\n'.join(rad(f) for f in tr[:25]) if tr else 'Inga träffar.')


def k_lista(a):
    idag = date.today().isoformat()
    l = alla()
    v = a.vilka
    if v == 'att_ringa':
        l = [f for f in l if f.get('status', 'att_ringa') == 'att_ringa']
    elif v == 'tillbaka':
        l = [f for f in l if f.get('status') in ('inget_svar', 'aterkom') and (f.get('nasta') or '') <= idag]
    elif v == 'ja':
        l = [f for f in l if f.get('status') in JA]
    elif v == 'kunder':
        l = [f for f in l if f.get('status') == 'kund']
    elif v == 'mina':
        l = [f for f in l if f.get('ansvarig') == K.get('namn')]
    print(f'{len(l)} st')
    print('\n'.join(rad(f) for f in l[:a.max]))


def k_visa(a):
    f = hitta(a.id)
    print(rad(f))
    for x in FALT[1:]:
        if f.get(x):
            print(f'  {x}: {f[x]}')
    for s in (f.get('samtal') or [])[-5:]:
        print(f"  samtal {s.get('tid', '')[:16]} {s.get('av', '')}: {STATUS.get(s.get('utfall'), s.get('utfall'))} – {s.get('sa', '')}")
    for x in (f.get('arbete') or [])[-5:]:
        print(f"  arbete {x.get('tid', '')[:16]} {x.get('av', '')}: {x.get('typ')} – {x.get('vad', '')}")


def k_nytt(a):
    tel = (a.telefon or '').strip()
    if tel:
        for f in alla():
            if siffror(f.get('telefon')) and siffror(f.get('telefon')) == siffror(tel):
                print('Finns redan: ' + rad(f))
                return
    fid = (format(int(time.time() * 1000), 'x') + secrets.token_hex(4))[:24]
    rec = {'id': fid, 'skapad': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'status': 'att_ringa',
           'samtal': [], 'ansvarig': '', 'namn': a.namn.strip(), 'telefon': tel, 'ort': a.adress or '',
           'bransch': a.bransch or '', 'kontakt': a.kontakt or '', 'epost': a.epost or '', 'webb': a.webb or '',
           'hemsidaNotis': a.notis or ''}
    print('Skapad: ' + rad(api('/foretag/' + fid, 'PUT', rec)))


def k_andra(a):
    f = hitta(a.id)
    for par in a.falt:
        if '=' not in par:
            sys.exit('Skriv falt=värde, t.ex. telefon="08-123 45 67"')
        k, v = par.split('=', 1)
        if k not in FALT:
            sys.exit('Kan bara ändra: ' + ', '.join(FALT))
        f[k] = v.strip()
    print('Sparat: ' + rad(api('/foretag/' + f['id'], 'PUT', f)))


def k_samtal(a):
    u = a.utfall
    data = {'samtal': {'id': secrets.token_hex(5), 'tid': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                       'av': K.get('namn', ''), 'utfall': u, 'sa': a.notis or ''}, 'status': u}
    if u == 'aterkom':
        data['nasta'] = a.nar or ''
        data['nastaNotis'] = a.notis or 'Bad oss återkomma'
    elif u in ('nej', 'inget_svar', 'kund'):
        data['nasta'] = ''
    print('Loggat: ' + rad(api('/foretag/' + a.id + '/samtal', 'POST', data)))


def k_status(a):
    print('Ändrat: ' + rad(api('/foretag/' + a.id + '/status', 'POST', {'status': a.status, 'nasta': a.nar or ''})))


def k_jobbar(a):
    r = api('/jobbar', 'POST', {'vad': a.vad, 'foretag_id': a.id or '', 'foretag_namn': a.namn or ''})
    print(f"Rapporterat: {r['person']} jobbar med {r['vad']}" + (f" ({r['foretag_namn']})" if r.get('foretag_namn') else ''))


def k_klar(a):
    r = api('/jobbar/klar', 'POST', {'notis': a.notis or ''})
    print('Klart rapporterat.' if r.get('var') else 'Klart (inget pågående arbete var rapporterat).')


def k_vilka(a):
    l = api('/jobbar')
    print('\n'.join(f"{x['person']}: {x['vad']} (sedan {x['start'][11:16]} UTC)" for x in l) if l else 'Ingen jobbar just nu.')


def main():
    global K
    p = argparse.ArgumentParser(prog='kantljus.py')
    sp = p.add_subparsers(dest='k', required=True)
    sp.add_parser('vem').set_defaults(fn=k_vem)
    x = sp.add_parser('sok'); x.add_argument('text'); x.set_defaults(fn=k_sok)
    x = sp.add_parser('lista'); x.add_argument('vilka', nargs='?', default='att_ringa',
                                              choices=['att_ringa', 'tillbaka', 'ja', 'kunder', 'mina', 'alla'])
    x.add_argument('--max', type=int, default=50); x.set_defaults(fn=k_lista)
    x = sp.add_parser('visa'); x.add_argument('id'); x.set_defaults(fn=k_visa)
    x = sp.add_parser('nytt'); x.add_argument('--namn', required=True)
    for f in ['telefon', 'adress', 'bransch', 'webb', 'kontakt', 'epost', 'notis']:
        x.add_argument('--' + f)
    x.set_defaults(fn=k_nytt)
    x = sp.add_parser('andra'); x.add_argument('id'); x.add_argument('falt', nargs='+'); x.set_defaults(fn=k_andra)
    x = sp.add_parser('samtal'); x.add_argument('id')
    x.add_argument('--utfall', required=True, choices=['inget_svar', 'aterkom', 'intresserad', 'mote', 'offert', 'kund', 'nej'])
    x.add_argument('--notis'); x.add_argument('--nar', help='ÅÅÅÅ-MM-DD för aterkom'); x.set_defaults(fn=k_samtal)
    x = sp.add_parser('status'); x.add_argument('id'); x.add_argument('status', choices=list(STATUS))
    x.add_argument('--nar'); x.set_defaults(fn=k_status)
    x = sp.add_parser('jobbar'); x.add_argument('--vad', required=True); x.add_argument('--id'); x.add_argument('--namn')
    x.set_defaults(fn=k_jobbar)
    x = sp.add_parser('klar'); x.add_argument('--notis'); x.set_defaults(fn=k_klar)
    sp.add_parser('vilka').set_defaults(fn=k_vilka)
    a = p.parse_args()
    K = konfig()
    a.fn(a)


if __name__ == '__main__':
    main()
