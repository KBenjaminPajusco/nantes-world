"""Tamponne une version sur les fichiers du site avant publication.

GitHub Pages laisse les navigateurs garder chaque fichier 10 minutes : sans numéro de version,
un téléphone peut afficher un mélange d'ancienne et de nouvelle version. On ajoute donc ?v=<version>
à la feuille de style, au script principal et à chaque import de module (./x.js).

Usage : python tools/version.py   (à lancer avant chaque commit publié)
"""
import pathlib
import re
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
version = time.strftime('%Y%m%d%H%M%S')

index = ROOT / 'index.html'
html = index.read_bytes().decode('utf8')
html = re.sub(r'href="style\.css(\?v=\w+)?"', f'href="style.css?v={version}"', html)
html = re.sub(r'src="src/main\.js(\?v=\w+)?"', f'src="src/main.js?v={version}"', html)
index.write_text(html, encoding='utf8', newline='')

for path in (ROOT / 'src').glob('*.js'):
    code = path.read_bytes().decode('utf8')
    stamped = re.sub(r"(from\s+'\./[\w-]+\.js)(\?v=\w+)?'", rf"\1?v={version}'", code)
    if stamped != code:
        path.write_text(stamped, encoding='utf8', newline='')

print(f'version {version}')
