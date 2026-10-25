"""Overpass (raw/*.json) -> data/nantes.json : géométrie compacte en mètres locaux.

Repère : origine au centre (place du Commerce), x vers l'est, z vers le sud (comme Three.js : nord = -z).
Coordonnées arrondies au décimètre (entiers), prêtes à être lues par src/city.js.
Usage : python -I tools/build_data.py
"""
import json, math, random, os, collections

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '..', 'raw')
OUT = os.path.join(HERE, '..', 'data', 'nantes.json')

LAT0, LON0 = 47.2132, -1.5559  # place du Commerce
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110574
# Emprise conservée (m) : on coupe les objets entièrement hors cadre.
BOUNDS = (-3330, -2750, 3330, 5000)  # x0, z0, x1, z1


def proj(p):
    return ((p['lon'] - LON0) * KX, -(p['lat'] - LAT0) * KZ)


def load(name):
    """Fusionne raw/<name>.json et les emprises supplémentaires raw/<name>_*.json (dédoublonnées par type+id)."""
    import glob
    out, seen = [], set()
    for path in [os.path.join(RAW, name + '.json')] + sorted(glob.glob(os.path.join(RAW, name + '_*.json'))):
        with open(path, encoding='utf-8') as f:
            for e in json.load(f)['elements']:
                k = (e['type'], e['id'])
                if k not in seen:
                    seen.add(k)
                    out.append(e)
    return out


NAMED = {'white': '#ece8dc', 'beige': '#d6c8a6', 'cream': '#e6dcc0', 'yellow': '#d8c27a', 'grey': '#9a9a9a', 'gray': '#9a9a9a',
         'red': '#a0462f', 'brown': '#8a6040', 'black': '#3a3a3e', 'blue': '#4a6a8f', 'green': '#5f7f5a', 'orange': '#c8794a',
         'pink': '#d9a99a', 'tan': '#c8b08a', 'slate': '#4a5260', 'silver': '#b7bbc2'}


def colour(v):
    """Teinte OSM -> '#rrggbb' (nom courant ou hexadécimal), sinon None."""
    if not v:
        return None
    v = str(v).strip().lower()
    if v in NAMED:
        return NAMED[v]
    if len(v) == 7 and v[0] == '#' and all(c in '0123456789abcdef' for c in v[1:]):
        return v
    return None


def inside(pts):
    x0, z0, x1, z1 = BOUNDS
    return any(x0 <= x <= x1 and z0 <= z <= z1 for x, z in pts)


def dp(pts, eps):
    """Douglas-Peucker (polyligne ouverte)."""
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
        return dp(pts[:idx + 1], eps)[:-1] + dp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def simplify_ring(pts, eps):
    if len(pts) > 4:
        pts = dp(pts + [pts[0]], eps)[:-1] if False else dp(pts, eps)
    return pts


def area(pts):
    s = 0
    for i in range(len(pts)):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % len(pts)]
        s += x1 * z2 - x2 * z1
    return s / 2


def q(pts):
    out = []
    for x, z in pts:
        out += [round(x * 10), round(z * 10)]
    return out


def stitch(ways):
    """Assemble des chemins (listes de points) en anneaux fermés."""
    ways = [list(w) for w in ways if len(w) > 1]
    rings = []
    key = lambda p: (round(p[0], 2), round(p[1], 2))
    while ways:
        cur = ways.pop()
        guard = 0
        while key(cur[0]) != key(cur[-1]) and guard < 100000:
            guard += 1
            end = key(cur[-1])
            for i, w in enumerate(ways):
                if key(w[0]) == end:
                    cur += w[1:]; ways.pop(i); break
                if key(w[-1]) == end:
                    cur += w[::-1][1:]; ways.pop(i); break
            else:
                break
        if key(cur[0]) == key(cur[-1]) and len(cur) > 3:
            rings.append(cur[:-1])
    return rings


def polygons_from(el):
    """Renvoie [(outer, [holes])] pour un way fermé ou une relation multipolygone."""
    if el['type'] == 'way':
        g = [proj(p) for p in el.get('geometry', [])]
        if len(g) > 3 and g[0] == g[-1]:
            return [(g[:-1], [])]
        return []
    outers = [[proj(p) for p in m['geometry']] for m in el.get('members', []) if m['role'] == 'outer' and m.get('geometry')]
    inners = [[proj(p) for p in m['geometry']] for m in el.get('members', []) if m['role'] == 'inner' and m.get('geometry')]
    o, i = stitch(outers), stitch(inners)
    res = []
    for ring in o:
        holes = [h for h in i if point_in(h[0], ring)]
        res.append((ring, holes))
    return res


def point_in(p, ring):
    x, z = p
    c = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, zi = ring[i]; xj, zj = ring[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi:
            c = not c
        j = i
    return c


def clip_poly(ring):
    """Garde les anneaux qui touchent l'emprise ; recadre les points trop lointains pour ne pas étirer les maillages."""
    x0, z0, x1, z1 = BOUNDS
    pad = 400
    return [(min(max(x, x0 - pad), x1 + pad), min(max(z, z0 - pad), z1 + pad)) for x, z in ring]


def main():
    rnd = random.Random(7)
    data = {'origin': [LAT0, LON0], 'bounds': BOUNDS}

    # --- Bâtiments : hauteur en dm, ints. Couleur = indice de teinte (palette côté client).
    B = []
    for el in load('buildings'):
        g = [proj(p) for p in el.get('geometry', [])]
        if len(g) < 4 or g[0] != g[-1]:
            continue
        g = g[:-1]
        if not inside(g):
            continue
        a = area(g)
        if abs(a) < 14:
            continue
        if a < 0:
            g = g[::-1]
        g = simplify_ring(g, 0.35)
        if len(g) < 3:
            continue
        t = el.get('tags', {})
        h = None
        try:
            if 'height' in t:
                h = float(str(t['height']).split()[0].replace(',', '.'))
            elif 'building:levels' in t:
                h = float(str(t['building:levels']).split(';')[0]) * 3.1 + 1.5
        except ValueError:
            h = None
        if h is None:
            h = 8 + rnd.random() * 5 if abs(a) > 60 else 4.5 + rnd.random() * 2
        kind = 0
        if t.get('building') in ('church', 'cathedral', 'chapel'):
            kind = 1
        elif t.get('historic') == 'castle' or t.get('building') == 'castle':
            kind = 2
        elif t.get('building') in ('industrial', 'warehouse', 'garage', 'garages', 'shed', 'roof'):
            kind = 3
        b = {'p': q(g), 'h': round(max(h, 2.5) * 10), 'k': kind, 'c': rnd.randrange(5)}
        # Couleurs saisies par les contributeurs OSM (building:colour / roof:colour), quand elles existent.
        for key, tag in (('wc', 'building:colour'), ('rc', 'roof:colour')):
            col = colour(t.get(tag))
            if col:
                b[key] = col
        B.append(b)
    data['buildings'] = B

    # --- Routes : classe 0 grande, 1 moyenne, 2 résidentielle, 3 service, 4 piéton large, 5 sentier ; flag pont/tunnel.
    cls = {
        'motorway': 0, 'motorway_link': 1, 'trunk': 0, 'trunk_link': 1, 'primary': 0, 'primary_link': 1,
        'secondary': 1, 'secondary_link': 2, 'tertiary': 1, 'tertiary_link': 2,
        'residential': 2, 'unclassified': 2, 'living_street': 2, 'service': 3, 'pedestrian': 4,
        'footway': 5, 'path': 5, 'cycleway': 5, 'steps': 5, 'track': 5, 'bridleway': 5,
    }
    R, S = [], []
    for el in load('roads'):
        t = el.get('tags', {})
        c = cls.get(t.get('highway'))
        if c is None:
            continue
        if t.get('tunnel') in ('yes', 'building_passage', 'culvert') or t.get('covered') == 'yes':
            continue
        if t.get('highway') == 'service' and t.get('service') in ('parking_aisle', 'driveway'):
            continue
        g = [proj(p) for p in el.get('geometry', [])]
        if len(g) < 2 or not inside(g):
            continue
        g = dp(g, 0.4)
        # Un passage piéton qui est une surface (area:highway) n'est pas une ligne.
        bridge = 1 if t.get('bridge') not in (None, 'no') else 0
        if t.get('highway') == 'steps':
            # Les escaliers sont dessinés marche par marche (altitudes ajoutées par tools/fetch_dem.py).
            S.append({'p': q(dp(g, 0.15)), 'w': float(str(t.get('width', '2')).split()[0].replace(',', '.') or 2) if str(t.get('width', '2'))[0].isdigit() else 2.0})
            continue
        R.append({'c': c, 'b': bridge, 'p': q(g), 'n': t.get('name', '') if c <= 1 else ''})
    data['roads'] = R
    data['steps'] = S

    # --- Tram / rail.
    T = []
    for el in load('rail'):
        t = el.get('tags', {})
        if t.get('railway') not in ('rail', 'tram', 'light_rail') or el['type'] != 'way':
            continue
        if t.get('tunnel') in ('yes',):
            continue
        g = [proj(p) for p in el.get('geometry', [])]
        if len(g) < 2 or not inside(g):
            continue
        T.append({'k': 0 if t['railway'] == 'tram' else 1, 'p': q(dp(g, 0.5))})
    data['rails'] = T

    # --- Eau : polygones (+ trous) ; lignes d'eau en rubans.
    W, WL = [], []
    seen = set()
    for el in load('water'):
        t = el.get('tags', {})
        if el['type'] == 'way' and 'waterway' in t and t['waterway'] in ('river', 'canal', 'stream') and not (t.get('natural') == 'water'):
            g = [proj(p) for p in el.get('geometry', [])]
            if len(g) > 1 and inside(g):
                WL.append({'w': 12 if t['waterway'] == 'river' else 6 if t['waterway'] == 'canal' else 2.5, 'p': q(dp(g, 0.5))})
            continue
        for outer, holes in polygons_from(el):
            if not any(inside(r) for r in [outer]):
                continue
            o = dp(clip_poly(outer), 0.6)
            if len(o) < 3:
                continue
            kk = (round(o[0][0]), round(o[0][1]), len(o))
            if kk in seen:
                continue
            seen.add(kk)
            hs = [dp(clip_poly(h), 0.6) for h in holes]
            W.append({'p': q(o), 'h': [q(h) for h in hs if len(h) >= 3]})
    data['water'] = W
    data['waterlines'] = WL

    # --- Espaces verts.
    G = []
    for el in load('green'):
        t = el.get('tags', {})
        kind = 'park'
        if t.get('leisure') == 'pitch':
            kind = 'pitch'
        elif t.get('landuse') in ('forest',) or t.get('natural') in ('wood',):
            kind = 'wood'
        elif t.get('leisure') == 'playground':
            kind = 'pitch'
        for outer, holes in polygons_from(el):
            if not inside(outer):
                continue
            o = dp(clip_poly(outer), 0.8)
            if len(o) < 3 or abs(area(o)) < 40:
                continue
            G.append({'k': kind, 'p': q(o), 'h': [q(dp(clip_poly(h), 0.8)) for h in holes if len(h) >= 3]})
    data['green'] = G

    # --- Arbres.
    tr = []
    for el in load('trees'):
        x, z = proj(el)
        x0, z0, x1, z1 = BOUNDS
        if x0 <= x <= x1 and z0 <= z <= z1:
            tr += [round(x * 10), round(z * 10)]
    data['trees'] = tr

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print({k: (len(v) if isinstance(v, list) else v) for k, v in data.items()}, os.path.getsize(OUT) // 1024, 'KiB')


if __name__ == '__main__':
    main()
