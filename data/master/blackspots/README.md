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
