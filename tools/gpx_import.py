"""Importe des traces GPX (export Strava, Garmin, montre, appli de course…) vers la carte, sans passer par l'API.

C'est le chemin pour les amis : chacun exporte son activité en GPX (Strava : activité > ⋯ > Exporter le GPX) et te l'envoie.
Usage : python tools/gpx_import.py --who Léa trace1.gpx trace2.gpx
Les 300 premiers et derniers mètres sont retirés (domicile) avant publication ; seules les coordonnées sont gardées.
"""
import argparse, hashlib, os, sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import trails


def read_gpx(path):
    root = ET.parse(path).getroot()
    pts, date = [], ''
    for el in root.iter():
        if el.tag.endswith('trkpt'):
            pts.append((float(el.get('lat')), float(el.get('lon'))))
        elif el.tag.endswith('time') and not date and el.text:
            date = el.text[:10]
    return pts, date


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--who', required=True)
    ap.add_argument('files', nargs='+')
    a = ap.parse_args()
    for f in a.files:
        pts, date = read_gpx(f)
        if len(pts) < 2:
            print(f, ': aucune trace'); continue
        ref = 'gpx-' + hashlib.sha1(open(f, 'rb').read()).hexdigest()[:10]  # même fichier réimporté = pas de doublon
        print(os.path.basename(f), date, trails.record(a.who, ref, date, '', pts, 'gpx'))
