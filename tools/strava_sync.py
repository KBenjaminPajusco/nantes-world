"""Synchronise TES activités Strava (API officielle) vers la carte : défis (events.json) et souvenirs (tracks.json).

Règle Strava : l'API ne sert qu'à lire les données de la personne qui s'est connectée. Chaque ami lance donc
cet outil avec SA propre application Strava, ou exporte ses activités en GPX et utilise gpx_import.py.
Une application Strava non validée ne peut de toute façon connecter qu'un seul athlète (le propriétaire).

Mise en place (une fois) :
  1. https://www.strava.com/settings/api : créer une application, « Authorization Callback Domain » = localhost.
  2. export STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=...   (jamais dans le dépôt)
  3. python tools/strava_sync.py auth      -> ouvre l'autorisation (scope activity:read), garde les jetons dans ~/.nantes-strava.json
Ensuite : python tools/strava_sync.py sync [--since 2026-09-01] [--who Benjamin]
Puis relire data/events.json et data/tracks.json, `python tools/version.py`, commit, push.
"""
import argparse, http.server, json, os, subprocess, sys, threading, time, urllib.parse, webbrowser, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trails

TOKEN_FILE = os.path.expanduser('~/.nantes-strava.json')
REDIRECT = 'http://localhost:8787/callback'


def curl(method, url, data=None, headers=()):
    """Le Python MSYS ne valide pas les certificats : curl s'en charge."""
    cmd = ['curl', '-s', '-m', '60', '-X', method, url]
    for h in headers:
        cmd += ['-H', h]
    if data:
        for k, v in data.items():
            cmd += ['--data-urlencode', f'{k}={v}']
    out = subprocess.run(cmd, capture_output=True).stdout
    return json.loads(out)


def creds():
    cid, sec = os.environ.get('STRAVA_CLIENT_ID'), os.environ.get('STRAVA_CLIENT_SECRET')
    if not cid or not sec:
        sys.exit('Définis STRAVA_CLIENT_ID et STRAVA_CLIENT_SECRET (voir l\'en-tête de ce fichier).')
    return cid, sec


def save_tokens(t):
    with open(TOKEN_FILE, 'w') as f:
        json.dump(t, f)
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass


def cmd_auth(_):
    cid, sec = creds()
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got['code'] = q.get('code', [None])[0]
            self.send_response(200); self.send_header('Content-Type', 'text/plain; charset=utf-8'); self.end_headers()
            self.wfile.write('Autorisation reçue, tu peux fermer cet onglet.'.encode('utf-8'))

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(('127.0.0.1', 8787), H)
    url = 'https://www.strava.com/oauth/authorize?' + urllib.parse.urlencode(
        {'client_id': cid, 'response_type': 'code', 'redirect_uri': REDIRECT, 'approval_prompt': 'auto', 'scope': 'activity:read'})
    print('Ouvre cette adresse et autorise :\n', url)
    webbrowser.open(url)
    while 'code' not in got:
        srv.handle_request()
    tok = curl('POST', 'https://www.strava.com/oauth/token', {'client_id': cid, 'client_secret': sec, 'code': got['code'], 'grant_type': 'authorization_code'})
    if 'access_token' not in tok:
        sys.exit(f'Échec : {tok}')
    save_tokens({k: tok[k] for k in ('access_token', 'refresh_token', 'expires_at')} | {'firstname': tok.get('athlete', {}).get('firstname', '')})
    print('Connecté :', tok.get('athlete', {}).get('firstname'))


def access_token():
    if not os.path.exists(TOKEN_FILE):
        sys.exit('Pas de jeton : lance d\'abord `python tools/strava_sync.py auth`.')
    t = json.load(open(TOKEN_FILE))
    if t['expires_at'] < time.time() + 60:
        cid, sec = creds()
        n = curl('POST', 'https://www.strava.com/oauth/token', {'client_id': cid, 'client_secret': sec, 'grant_type': 'refresh_token', 'refresh_token': t['refresh_token']})
        if 'access_token' not in n:
            sys.exit(f'Jeton non renouvelé : {n}')
        t.update({k: n[k] for k in ('access_token', 'refresh_token', 'expires_at')})
        save_tokens(t)
    return t


def api(path, tok, **params):
    url = 'https://www.strava.com/api/v3' + path + ('?' + urllib.parse.urlencode(params) if params else '')
    r = curl('GET', url, headers=[f'Authorization: Bearer {tok["access_token"]}'])
    if isinstance(r, dict) and r.get('message') and r.get('errors'):
        sys.exit(f'Strava : {r}')
    return r


def cmd_sync(a):
    tok = access_token()
    who = a.who or tok.get('firstname') or 'Moi'
    since = int(datetime.datetime.fromisoformat(a.since).timestamp()) if a.since else int(time.time() - 90 * 86400)
    b = trails.bounds()
    chal = trails.load_json('challenges.json', {}).get('challenges', [])
    n_act = n_used = 0
    page = 1
    while True:
        acts = api('/athlete/activities', tok, after=since, per_page=100, page=page)
        if not acts:
            break
        for act in acts:
            n_act += 1
            poly = (act.get('map') or {}).get('summary_polyline')
            if not poly or act.get('private') or act.get('type') in ('VirtualRide', 'VirtualRun'):
                continue
            ll = trails.decode_polyline(poly)
            xz = [trails.to_xz(*p) for p in ll]
            if not any(b[0] <= x <= b[2] and b[1] <= z <= b[3] for x, z in xz):
                continue  # hors de la carte
            # Près d'une zone de défi : la trace détaillée (flux GPS) évite de rater un passage entre deux points.
            near = any(min(trails._seg_dist(*trails.to_xz(c['lat'], c['lon']), *xz[max(i - 1, 0)], *xz[i]) for i in range(len(xz))) < c['radius'] * 4 for c in chal)
            if near:
                st = api(f'/activities/{act["id"]}/streams', tok, keys='latlng', key_by_type='true')
                if isinstance(st, dict) and st.get('latlng'):
                    ll = [tuple(p) for p in st['latlng']['data']]
            date = (act.get('start_date_local') or '')[:10]
            res = trails.record(who, f'strava-{act["id"]}', date, '', ll, 'strava')
            n_used += 1
            print(date, act.get('type'), res)
        page += 1
    print(f'{n_act} activités lues, {n_used} sur la carte. Relis data/events.json et data/tracks.json avant de pousser.')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('auth').set_defaults(fn=cmd_auth)
    s = sub.add_parser('sync')
    s.add_argument('--since'); s.add_argument('--who')
    s.set_defaults(fn=cmd_sync)
    a = ap.parse_args()
    a.fn(a)
