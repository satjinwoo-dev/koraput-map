# Accident blackspot datasets

This folder is empty on purpose. The Master AI warns about accident blackspots only from **official lists you import**. It never invents them: a wrong warning teaches riders to ignore the real ones.

1. Get a list **with coordinates**: MoRTH's identified blackspots, your state PWD or traffic police list, or an iRAD export. Lists that only give a chainage ("NH-16 km 123/400") have to be geocoded first.
2. Check the licence allows you to use it in an app.
3. Import it:

```bash
node scripts/master/import-blackspots.mjs blackspots.csv --id morth-2024 \
  --name "MoRTH identified blackspots" --url "<download page>" --licence "<licence>" --radius 500
```

4. Restart the server. `GET /api/master/status` shows how many spots were loaded and from which sources.

Each file holds one source (see `lib/master/blackspots.js` for the format). Every warning the app speaks keeps its source's id, so it can always be traced back.

OpenStreetMap `hazard=*` tags along the road are used as well (`lib/master/road.js`). They're shown as road hazards, not as blackspots.

## Koraput–Araku roads: what's public (checked October 2026)

No official blackspot list with coordinates is published for these roads, so nothing has been imported for them.
- **Andhra Pradesh, Alluri Sitharama Raju district:** the district police identified 96 blackspots: 15 under G Madugula police station, 7 under Araku Valley, 5 each under Ananthagiri, Dumbriguda, Munchingput, Peda Bayulu and Annavaram. Only these counts were published (Deccan Chronicle), not the locations. The police call the 26 km Minimuluru–Garikabanda ghat (Paderu – V Madugula) the most dangerous stretch.
- **Odisha (Koraput, NH-26, NH-326):** the published MoRTH and Indiastat tables give blackspot counts per highway, not locations. MoRTH's GIS mapping circular said Odisha's and Andhra Pradesh's details were still awaited.
- **News reports of single crashes** (Sunabeda, Jeypore, Damuku–Tyda on the Araku ghat) are not blackspots, which need repeated crashes on the same 500 m: 5 serious crashes or 10 deaths in 3 years. They aren't imported.

Where the real lists are, and how to ask:
- **ASR district police (Paderu):** the 96-spot list with locations. Ask for it with coordinates or landmarks.
- **Koraput SP office, Odisha Commerce & Transport Department, or NHAI's Bhubaneswar regional office:** the blackspots on NH-26 and NH-326.
- **An RTI application** to any of them works if they don't answer. Ask for each spot's location (latitude and longitude, or chainage), the period, and the number of crashes and deaths.

A list given only as chainage or landmarks needs geocoding first. Each geocoded point has to be checked on the map: a guessed point is worse than none.

The valley-edge warning (`agents/topology-agent.js`) covers part of the same danger on these ghats from terrain data. It is not an accident record.
