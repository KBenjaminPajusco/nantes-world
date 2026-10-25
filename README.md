# Nantes — la carte à nous

Nantes centre en 3D (Three.js, cel shading) à explorer à pied, avec des points posés par nous.

- `data/nantes.json` : bâtiments, routes, escaliers, eau, parcs et arbres d'OpenStreetMap, générés par `tools/build_data.py` à partir de `raw/` (non versionné ; `tools/fetch_osm.sh <suffixe> "S,O,N,E"` télécharge une emprise via Overpass).
- `data/dem.bin` + `dem.json` : relief IGN RGE ALTI (grille de 10 m), par `tools/fetch_dem.py` (à relancer après `build_data.py`, qui efface l'altitude des escaliers).
- Sur le site on vole : ZQSD / flèches, Maj turbo, Espace / C pour l'altitude, clic pour y aller. Les bâtiments sont construits par tuiles autour de la caméra (téléphone d'abord).
- `data/pois.json` : les points d'intérêt. Sur le site : bouton **Placer** (ou touche P), clic sur la carte, remplir la fiche, puis **Exporter** et coller le JSON dans ce fichier avant de pousser.
- `src/city.js` construit la ville, `src/main.js` le marcheur, la caméra et les points.

Lancer en local : `python serve.py 8766`, puis http://127.0.0.1:8766. Avant de publier : `python tools/version.py`.

Données © contributeurs OpenStreetMap (ODbL).
