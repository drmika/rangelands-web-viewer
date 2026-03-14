# Boreal Web Viewer

Web visualization of geospatial data layers for boreal and arctic regions, rendered client-side from Cloud-Optimized GeoTIFFs using [deck.gl-raster](https://github.com/developmentseed/deck.gl-raster).

## Data Layers

- **Potential Above-Ground Combustion** — [Potential AGC in Boreal and Arctic North America for SSP585](https://source.coop/luddaludwig/potential-agc-combustion-ssp585-v0) (note: this is not the final data product)

Additional data layers will be added over time.

## Setup

```bash
git clone --recurse-submodules https://github.com/<your-username>/boreal-web-viewer.git
cd boreal-web-viewer
pnpm install
pnpm build:deps
pnpm dev
```

Open http://localhost:3000.

## How it works

The app streams tiles directly from COGs hosted on [source.coop](https://source.coop), using a custom render pipeline:

1. Tiles are fetched via HTTP range requests and uploaded as `r16unorm` textures
2. A GPU shader rescales values to a user-adjustable min/max range
3. A viridis colormap is applied via texture lookup
4. Zero values are treated as nodata and discarded

## Submodule

This project uses [deck.gl-raster](https://github.com/developmentseed/deck.gl-raster) as a git submodule (via a [fork](https://github.com/maxrjones/deck.gl-raster)) to include an unreleased fix for custom render pipelines with signed integer data.

Update the submodules with:

```bash
git submodule sync && git submodule update --remote deck.gl-raster && pnpm build:deps
```

After pulling updates to the submodule, rebuild with:

```bash
pnpm build:deps
```
