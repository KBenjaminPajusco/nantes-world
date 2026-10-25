"""Traces GPS -> data/tracks.json (souvenirs) et data/events.json (défis), partagé par strava_sync.py et gpx_import.py.

Respect de la vie privée : le dépôt est public, donc chaque trace est rognée de PRIVACY_TRIM mètres au départ et à
l'arrivée (domicile), simplifiée à ~5 m et découpée à l'emprise de la carte. Rien d'autre n'est conservé (ni
fréquence cardiaque, ni horaires, ni nom d'activité Strava).
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
LAT0, LON0 = 47.2132, -1.5559
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110574
PRIVACY_TRIM = 300  # m
SIMPLIFY = 5  # m


def to_xz(lat, lon):
    return ((lon - LON0) * KX, -(lat - LAT0) * KZ)


def bounds():
    with open(os.path.join(DATA, 'dem.json')) as f:
        m = json.load(f)
    return (m['x0'], m['z0'], m['x0'] + (m['cols'] - 1) * m['step'], m['z0'] + (m['rows'] - 1) * m['step'])


def decode_polyline(s):
    """Polyline encodée Google (précision 5) -> [(lat, lon)]."""
    pts, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        out = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            out.append(~(result >> 1) if result & 1 else result >> 1)
        lat += out[0]
        lon += out[1]
        pts.append((lat / 1e5, lon / 1e5))
    return pts


def _dp(pts, eps):
    if len(pts) < 3:
        return pts
    (ax, az), (bx, bz) = pts[0], pts[-1]
    dx, dz = bx - ax, bz - az
    L = math.hypot(dx, dz) or 1e-9
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        d = abs(dz * (pts[i][0] - ax) - dx * (pts[i][1] - az)) / L
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return _dp(pts[:idx + 1], eps)[:-1] + _dp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def simplify(ll, eps=SIMPLIFY):
    """Simplifie une trace [(lat, lon)] (Douglas-Peucker en mètres)."""
    xz = [to_xz(*p) for p in ll]
    keep = {id(q): p for q, p in zip(xz, ll)}
    return [keep[id(q)] for q in _dp(xz, eps)]


def trim_ends(ll, meters=PRIVACY_TRIM):
    """Retire les `meters` premiers et derniers mètres de la trace (domicile, lieux de départ)."""
    if len(ll) < 2:
        return []
    xz = [to_xz(*p) for p in ll]
    cum = [0.0]
    for i in range(1, len(xz)):
        cum.append(cum[-1] + math.hypot(xz[i][0] - xz[i - 1][0], xz[i][1] - xz[i - 1][1]))
    total = cum[-1]
    if total < 2 * meters + 50:
        return []
    return [p for p, c in zip(ll, cum) if meters <= c <= total - meters]


def clip(ll, b):
    """Découpe en tronçons à l'intérieur de l'emprise de la carte."""
    runs, cur = [], []
    for p in ll:
        x, z = to_xz(*p)
        if b[0] <= x <= b[2] and b[1] <= z <= b[3]:
            cur.append(p)
        elif cur:
            runs.append(cur); cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def _seg_dist(px, pz, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    t = 0 if L2 == 0 else max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / L2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def zone_passages(ll, challenges):
    """Nombre d'entrées dans chaque zone de défi : {id: n}. Test point-segment, donc robuste aux traces peu denses."""
    xz = [to_xz(*p) for p in ll]
    res = {}
    for c in challenges:
        cx, cz = to_xz(c['lat'], c['lon'])
        r = c['radius']
        inside, n = False, 0
        for i in range(len(xz)):
            d = _seg_dist(cx, cz, *xz[max(i - 1, 0)], *xz[i])
            now = d < r
            if now and not inside:
                n += 1
            # on ne ressort qu'au-delà de 1,5 r : évite de compter deux fois un passage qui frôle le bord
            if inside and d > r * 1.5:
                inside = False
            elif now:
                inside = True
        if n:
            res[c['id']] = n
    return res


def load_json(name, default):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def save_json(name, obj, indent=None):
    with open(os.path.join(DATA, name), 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent, separators=None if indent else (',', ':'))
        f.write('\n')


def record(who, ref, date, title, ll, source):
    """Enregistre une activité : événements de défi (dédoublonnés par ref) + trace de souvenir. Renvoie un résumé."""
    ch = load_json('challenges.json', {}).get('challenges', [])
    passages = zone_passages(ll, ch)  # sur la trace complète, avant rognage
    ev = load_json('events.json', {'events': []})
    ev['events'] = [e for e in ev['events'] if not (e.get('ref') == ref and e.get('source') == source)]
    for cid, n in passages.items():
        ev['events'].append({'challenge': cid, 'who': who, 'date': date, 'n': n, 'source': source, 'ref': ref})
    save_json('events.json', ev, indent=2)

    tr = load_json('tracks.json', {'tracks': []})
    tr['tracks'] = [t for t in tr['tracks'] if t.get('ref') != ref]
    b = bounds()
    kept = 0
    for k, run in enumerate(clip(simplify(trim_ends(ll)), b)):
        tr['tracks'].append({'ref': ref, 'part': k, 'who': who, 'date': date, 'title': title, 'p': [[round(a, 5), round(o, 5)] for a, o in run]})
        kept += len(run)
    save_json('tracks.json', tr)
    return {'passages': passages, 'points': kept}
