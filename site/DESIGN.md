# undomap — design brief

**Reference object:** a USGS / FEMA flood-inundation survey map: a contour-line topographic sheet with flood-hazard zones laid over it, benchmark triangles, a north arrow, a scale bar, section lines, and the title block in the map collar below the neatline.

Why this object: undomap answers "if the water rises, what's gone for good?". Flood maps already have the exact vocabulary: **Zone VE** (high-hazard, the velocity zone), **Zone AE** (base flood, recoverable), **Zone X** (outside the floodplain). The directory is the terrain, the bytes an agent could erase with no way back are the flooded area, and every finding is a surveyed benchmark.

Mirrors the undomap entry in `/workspace/oss-factory/design/registry.md`.

| Axis | Choice |
|---|---|
| Base tone | light, cold survey-sheet blue-grey `#cfdce3` (not paper, not white, not lilac) |
| Palette | slate ink `#14232e` (contours, text) · burnt orange `#d4600a` Zone VE · mustard `#b8962e` Zone AE · deep teal `#1f6f6a` Zone X high ground · copper `#8b5e3c` benchmarks, scale. AA text shades of the zone colours, used only for text on the base: `#a2470a` (VE text) and `#7d6519` (AE text). No red ink, no gradients, no glow, no shadows |
| Type | Syne 700/800 (map title, sheet labels, uppercase), Literata 400/600 (body; italic for river and ridge names, as on real sheets), Roboto Mono 400/500 (readouts, paths, commands). Self-hosted subset woff2 |
| Texture | a 45° 1px hatch at ~5% over the whole page; Zone VE is 45° hatch fill, Zone AE a dot screen, Zone X left as open high ground; benchmark crosshair triangles |
| Rendering | flat survey SVG generated in the browser: seeded value-noise terrain (160×80 grid) → d3-contour isolines (index contour every 5th) → flood polygons at the height quantile of each zone's byte share → section A–A′ cut from the same terrain. The page grades canned inventories with the CLI's own `grade()` |
| Layout | the first view is the full-width map sheet with the sample sites as index tabs standing on the neatline; the h1 "UNDOMAP — FLOOD ZONES" sits in the **map collar** under the neatline at the lower right (as on a USGS quadrangle), next to the Zone VE readout and the install command. Below: Sheet 2 Zone VE register (VE first), Sheet 3 legend & method (section profile, survey stations), Sheet 4 title-block table (install, exit codes, MCP, CI), Sheet 5 load your own JSON. Docs are an "Index of sheets" |
| Map symbols (v0.2) | **Levee** for cloud-sync history, after the topographic levee symbol: a slate line with hachures on both sides, drawn along the Zone VE shore when Dropbox/OneDrive/Google Drive history is verified; dashed with sparse hachures ("provisionally accredited", FEMA's term) when undomap found the folder but couldn't confirm it; dotted for iCloud (deletes only). **Staked benchmark**: a burnt-orange survey pennant on the triangle for a path forced permanent by `.undomap.json`. Scale bar and levee key are opaque paper insets in the lower corners (water, levees and the section line pass *under* them) |
| Motion | contours draw in → Zone VE floods orange while the byte readout counts up → the levee fades in on the VE shore → AE and X fade in → each benchmark flashes as the water reaches it → switching sites re-pours. Hover/focus a benchmark for its survey tag. `prefers-reduced-motion`: final state only |
| Logo | slate benchmark triangle with a copper disc, burnt-orange water clipped inside the triangle (with hatch), one wave line running past it. Transparent background, not a rounded square. Favicon: the same, simplified |
| OG / social | rendered from the live page in `?og` mode: map column + title-block column (1200×630 and 1280×640), `scripts/make_assets.sh` |

Small sheets: on phones the map shows a centred 5:4 window of the sheet (benchmarks and labels are placed inside it), and map lettering is scaled so it stays ~13px on screen. Labels are placed after every triangle is sited, so no label is lettered across another benchmark; the levee key shrinks to one line stacked on a shorter scale inset; section A–A′ letters its stations "BM n" at ~11px.

Banned-trope check: no dark background, no cyan/purple gradient, no gradient text, no glow, no glass, no left-copy/right-card hero (the hero is the map; the title is in its collar), no three-column feature cards, no Inter, no paper/stamp/typewriter, no red-ink annotation, no rounded-square app-icon logo.

Closest existing projects and how undomap differs:
- postsleuth (metro map, h1 in a cartouche floating over the map): undomap's title sits in the collar *outside* the neatline, the map is a terrain with fills rather than octilinear lines, and the base is cold blue-grey, not lilac.
- drainready (harbour fog `#e6ecef`): lighter and greyer; drainready is an elevation drawing of ships, not a plan-view map.
