# RoadPulse road index (`ROADSENSE_ROADS_DIR`, default `data/roads`)

GeoJSON files of the **pilot district's roads**, read at server start by
`lib/master/roadpulse-roads.js`. They make hazard merging road-aware: a report matches
a hazard only on the same road and direction, by along-road distance. None ship
with the app. Without them, hazards merge by distance and direction.

## Format

One `Feature` per OpenStreetMap way, `LineString` (or `MultiLineString`) geometry in
WGS84, with these properties:

| property | required | meaning |
|---|---|---|
| `osm_way_id` | yes | the OSM way id (a cache key only: hazards keep their physical point) |
| `osm_version` | no | the way's version |
| `oneway` | no | `yes` / `-1`: one carriageway of a divided road, or a one-way street |
| `highway`, `name`, `ref` | no | for people reading the data |

## Making one (offline, from an OSM extract)

1. Download a regional extract (e.g. Geofabrik's India / eastern zone `.osm.pbf`).
2. Cut the pilot district and keep the drivable roads (osmium-tool):
   `osmium extract -b 82.0,18.0,83.5,19.5 region.osm.pbf -o pilot.osm.pbf`
   `osmium tags-filter pilot.osm.pbf w/highway=motorway,trunk,primary,secondary,tertiary,unclassified,residential,service -o roads.osm.pbf`
3. Export the ways as GeoJSON with `osm_way_id`, `oneway`, `highway`, `name`, `ref`
   (e.g. `ogr2ogr -f GeoJSON roads.geojson roads.osm.pbf lines`, then rename `osm_id` → `osm_way_id`).
4. Drop it here and restart: the server re-snaps every hazard at start and daily.

After an OSM update, replace the file and restart. Hazards are never deleted because a
way id changed. One that can't be re-snapped (its road moved or vanished in the data)
is marked `needs_resnap`: it stays on the map and isn't spoken until riders confirm it again.

## Licence

OpenStreetMap data is © OpenStreetMap contributors, under the ODbL. Record the extract
(date, source, licence) in `data/sources.json`. Before selling an API or publishing a
database built on it, get the share-alike question (derivative vs collective database)
reviewed.
