"""Relief réel : IGN RGE ALTI (Géoplateforme, service altimétrie) -> data/dem.bin + data/dem.json.

Grille régulière dans le repère local de build_data.py (x est, z sud), pas de STEP mètres, Int16 en décimètres
(little endian, ligne par ligne, z croissant). Ajoute aussi l'altitude des sommets des escaliers (data/nantes.json -> steps[].z).
Le Python MSYS ne valide pas le certificat IGN : on passe par curl.
Usage : python -I tools/fetch_dem.py
"""
import json, math, os, struct, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
URL = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json'
STEP = 10
BATCH = 4000

LAT0, LON0 = 47.2132, -1.5559
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110574


def to_ll(x, z):
    return LON0 + x / KX, LAT0 - z / KZ


def query(pts):
    body = json.dumps({'lon': '|'.join(f'{p[0]:.6f}' for p in pts), 'lat': '|'.join(f'{p[1]:.6f}' for p in pts),
                       'resource': 'ign_rge_alti_wld', 'zonly': 'true'})
    for attempt in range(6):
        out = subprocess.run(['curl', '-s', '-m', '120', '-H', 'Content-Type: application/json', '--data-binary', '@-', URL],
                             input=body.encode(), capture_output=True).stdout
        try:
            z = json.loads(out)['elevations']
            if len(z) == len(pts):
                return z
        except Exception:
            pass
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError('altimétrie : échec après 6 essais ' + out[:200].decode('utf8', 'replace'))


def batched(pts):
    chunks = [pts[i:i + BATCH] for i in range(0, len(pts), BATCH)]
    with ThreadPoolExecutor(3) as ex:
        res = list(ex.map(query, chunks))
    return [v for r in res for v in r]


def main():
    with open(os.path.join(DATA, 'nantes.json'), encoding='utf-8') as f:
        city = json.load(f)
    x0, z0, x1, z1 = city['bounds']
    cols = int((x1 - x0) // STEP) + 1
    rows = int((z1 - z0) // STEP) + 1
    pts = [to_ll(x0 + i * STEP, z0 + j * STEP) for j in range(rows) for i in range(cols)]
    print(cols, rows, len(pts), 'points', file=sys.stderr)
    zs = batched(pts)
    bad = sum(1 for z in zs if z is None or z < -5)
    print('invalides :', bad, file=sys.stderr)
    # Trous (-99999) : on prend le voisin précédent.
    prev = 0.0
    vals = []
    for z in zs:
        if z is None or z < -5:
            z = prev
        prev = z
        vals.append(max(-3000, min(3000, round(z * 10))))
    with open(os.path.join(DATA, 'dem.bin'), 'wb') as f:
        f.write(struct.pack(f'<{len(vals)}h', *vals))
    with open(os.path.join(DATA, 'dem.json'), 'w') as f:
        json.dump({'x0': x0, 'z0': z0, 'step': STEP, 'cols': cols, 'rows': rows, 'min': min(vals) / 10, 'max': max(vals) / 10}, f)
    print('dem', min(vals) / 10, max(vals) / 10, file=sys.stderr)

    # Escaliers : altitude de chaque sommet.
    steps = city.get('steps', [])
    sp = [to_ll(p[i] / 10, p[i + 1] / 10) for p in (s['p'] for s in steps) for i in range(0, len(p), 2)]
    if sp:
        sz = batched(sp)
        k = 0
        for s in steps:
            n = len(s['p']) // 2
            s['z'] = [round((v if v is not None and v > -500 else 0) * 10) for v in sz[k:k + n]]
            k += n
        with open(os.path.join(DATA, 'nantes.json'), 'w') as f:
            json.dump(city, f, separators=(',', ':'))
        print('escaliers', len(steps), file=sys.stderr)


if __name__ == '__main__':
    main()
