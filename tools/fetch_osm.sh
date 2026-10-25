#!/bin/bash
# Télécharge les données OpenStreetMap (Overpass) d'une emprise dans raw/<nom>_<suffixe>.json.
# Usage : tools/fetch_osm.sh south "47.168,-1.600,47.198,-1.512"
SUF="$1"; BB="$2"; cd "$(dirname "$0")/../raw" || exit 1
q() { # nom, requête ; réessaie avec les miroirs tant que la réponse n'est pas du JSON
  for host in overpass-api.de overpass.kumi.systems maps.mail.ru/osm/tools/overpass; do
    for try in 1 2 3; do
      curl -s --max-time 240 -A "nantes-world/0.1" --data-urlencode "data=[out:json][timeout:200];($2);out geom;" "https://$host/api/interpreter" -o "$1_$SUF.json"
      head -c 1 "$1_$SUF.json" | grep -q '{' && { echo "ok $1"; return; }
      sleep $((try*15))
    done
  done
  echo "ECHEC $1"
}
q buildings "way[building]($BB);"
q roads "way[highway]($BB);"
q water "way[natural=water]($BB);relation[natural=water]($BB);way[waterway~'river|canal|stream']($BB);way[waterway=riverbank]($BB);relation[waterway=riverbank]($BB);"
q green "way[leisure~'park|garden|pitch|playground']($BB);way[landuse~'grass|forest|meadow|cemetery|recreation_ground|village_green']($BB);way[natural~'wood|scrub|grassland']($BB);relation[leisure=park]($BB);"
q rail "way[railway~'rail|tram|light_rail']($BB);"
q trees "node[natural=tree]($BB);"
echo FINI
