import { SourceHttp } from "@chunkd/source-http";
import type { DeckProps } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { COGLayer } from "@developmentseed/deck.gl-geotiff";
import type { RasterModule } from "@developmentseed/deck.gl-raster";
import { CreateTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Overview } from "@developmentseed/geotiff";
import { GeoTIFF } from "@developmentseed/geotiff";
import type { Device, Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapLayerMouseEvent, MapRef } from "react-map-gl/maplibre";
import { Map as MaplibreMap, Popup, useControl } from "react-map-gl/maplibre";
import type { LayerDef } from "./dataLayers";
import {
  COG_BASE,
  DATA_LAYERS,
  ALPHA as MK_ALPHA,
  MODULES,
  rampCss,
} from "./dataLayers";

// ---- Custom EPSG resolver ----
// ---- Custom EPSG resolver ----
// The default resolver uses epsg.io PROJJSON, whose shape doesn't match what
// generateTileMatrixSet reads (it looks for top-level `units`, `a`, and
// `datum.a`). We return hand-built stubs for the EPSG codes we care about,
// and fall through to epsg.io for anything else.
const customEpsgResolver = async (epsg: number) => {
  if (epsg === 3857) {
    // Web Mercator — metres
    return {
      projName: "merc",
      units: "metre",
      a: 6378137,
      datum: { a: 6378137 },
    } as never;
  }
  if (epsg === 4326) {
    return {
      projName: "longlat",
      units: "degree",
      a: 6378137,
      datum: { a: 6378137 },
    } as never;
  }
  const resp = await fetch(`https://epsg.io/${epsg}.json`);
  if (!resp.ok) throw new Error(`Failed to fetch PROJJSON for EPSG:${epsg}`);
  return (await resp.json()) as never;
};

function DeckGLOverlay(props: DeckProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

// ---- Basemap styles ----
// "light" is CARTO's positron (light gray with dark country borders).
// "satellite" is Esri World Imagery. We lighten it with raster-brightness-min
// so the rangelands data layer stays readable on top.
const BASEMAPS = {
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  satellite: {
    version: 8 as const,
    sources: {
      "esri-satellite": {
        type: "raster" as const,
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        attribution:
          "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      },
    },
    layers: [
      {
        id: "esri-satellite-layer",
        type: "raster" as const,
        source: "esri-satellite",
        paint: {
          // Raise the minimum brightness floor so dark pixels (forests,
          // shadows) are washed out toward white. 0 = unchanged, 1 = fully
          // white. 0.5 is a strong lightening effect that keeps enough
          // structure to recognize continents and terrain.
          "raster-brightness-min": 0.5,
          // Optionally desaturate to reduce visual competition with the
          // rangelands palette. 0 = unchanged, 1 = fully grayscale.
          "raster-saturation": -0.3,
        },
      },
    ],
  },
} as const;

type BasemapKey = keyof typeof BASEMAPS;

// ---- Data source: uint8 global grazing lands COG on Source Cooperative ----
// NATIVE web-mercator (EPSG:3857) COG regridded from the current v6 data, so
// deck.gl never reprojects tiles from 4326 -> 3857 on the main thread (that
// on-the-fly reprojection was locking up the page). Dev serves the local copy;
// prod streams it from source.coop (upload global_grazing_lands_3857_v6.tif).
const COG_URL = import.meta.env.DEV
  ? `${import.meta.env.BASE_URL}cogs/global_grazing_lands_3857_v6.tif`
  : "https://data.source.coop/woodwell-climate/rangelands-raster-1/global_grazing_lands_3857_v6.tif";

// Tile-fetch policy for the COG range requests (SourceHttp only — does not
// affect MapLibre / basemap). Two concerns:
//
//  1) TIMEOUT. Browsers never time out a stalled fetch, so a single hung range
//     request (a source.coop/CDN hiccup or dropped connection) would leave the
//     in-flight counter stuck > 0 and the loading spinner spinning forever —
//     intermittently, since network stalls are random. We abort after
//     TILE_TIMEOUT_MS so the request rejects, the counter recovers, and the tile
//     can be re-requested. deck.gl's own per-tile abort (init.signal, used to
//     cancel out-of-view tiles) is forwarded into our controller so it still works.
//
//  2) no-store on DESKTOP CHROME only, to dodge Chromium's disk-cache single-
//     writer lock that serializes range requests. On mobile no-store hurts (kills
//     caching over slow links), so those browsers cache normally.
const _ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const _isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(_ua);
const _isDesktopChrome =
  /Chrome\//.test(_ua) && !/Edg\/|OPR\/|CriOS|FxiOS/.test(_ua) && !_isMobile;

const TILE_TIMEOUT_MS = 20000;
SourceHttp.fetch = (input, init) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TILE_TIMEOUT_MS);
  // forward deck.gl's abort signal (out-of-view tile cancellation) into ours
  if (init?.signal) {
    if (init.signal.aborted) ctrl.abort();
    else
      init.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return fetch(input, {
    ...init,
    signal: ctrl.signal,
    ...(_isDesktopChrome ? { cache: "no-store" } : {}),
  }).finally(() => clearTimeout(timer));
};

const cogPromise = GeoTIFF.fromUrl(COG_URL);

// ---- Class definitions ----
// The raster is uint8 with these class values:
//   0   = not grazing land (discarded as nodata)
//   1   = livestock-driven grazing (<10% grassland but high livestock)
//   2   = 10–33% grassland
//   3   = 33–50% grassland
//   4   = 50–80% grassland
//   5   = 80%+ grassland
//   6   = shrub/savanna rangeland (from MODIS)
//   255 = nodata (discarded)
type ClassInfo = { value: number; label: string; color: string };

const CLASSES: ClassInfo[] = [
  { value: 1, label: "Livestock-driven (<10% grass)", color: "#ff6666" },
  { value: 2, label: "10–33% grassland", color: "#e8f5e3" },
  { value: 3, label: "33–50% grassland", color: "#c2e7bc" },
  { value: 4, label: "50–80% grassland", color: "#7ccd6f" },
  { value: 5, label: "80%+ grassland", color: "#5d9a54" },
  { value: 6, label: "Shrub/savanna rangeland", color: "#ffff00" },
];

/** Convert "#rrggbb" to normalized [r, g, b] in 0..1 range for GLSL */
function hexToRgbNorm(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

const [C1_R, C1_G, C1_B] = hexToRgbNorm(CLASSES[0].color);
const [C2_R, C2_G, C2_B] = hexToRgbNorm(CLASSES[1].color);
const [C3_R, C3_G, C3_B] = hexToRgbNorm(CLASSES[2].color);
const [C4_R, C4_G, C4_B] = hexToRgbNorm(CLASSES[3].color);
const [C5_R, C5_G, C5_B] = hexToRgbNorm(CLASSES[4].color);
const [C6_R, C6_G, C6_B] = hexToRgbNorm(CLASSES[5].color);

// ---- Custom shader: map discrete uint8 class values to colors ----
// r8unorm maps 0..255 → 0.0..1.0, so rawValue = color.r * 255.0
// We compare the raw class value and assign the corresponding RGB.
// Visibility flags (0.0 or 1.0) per class are passed as uniforms so
// individual classes can be toggled on and off without re-rendering.
type CategoricalColormapProps = {
  visible1: number;
  visible2: number;
  visible3: number;
  visible4: number;
  visible5: number;
  visible6: number;
};

const COLORMAP_MODULE_NAME = "categoricalColormap";

const colormapUniformBlock = `\
uniform ${COLORMAP_MODULE_NAME}Uniforms {
  float visible1;
  float visible2;
  float visible3;
  float visible4;
  float visible5;
  float visible6;
} ${COLORMAP_MODULE_NAME};
`;

const CategoricalColormap = {
  name: COLORMAP_MODULE_NAME,
  fs: colormapUniformBlock,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float rawValue = color.r * 255.0;
      int classValue = int(rawValue + 0.5);

      // Discard nodata (0 = not grazing land, 255 = raster nodata)
      if (classValue == 0 || classValue == 255) discard;

      vec3 rgb;
      if (classValue == 1) {
        if (${COLORMAP_MODULE_NAME}.visible1 < 0.5) discard;
        rgb = vec3(${C1_R.toFixed(6)}, ${C1_G.toFixed(6)}, ${C1_B.toFixed(6)});
      } else if (classValue == 2) {
        if (${COLORMAP_MODULE_NAME}.visible2 < 0.5) discard;
        rgb = vec3(${C2_R.toFixed(6)}, ${C2_G.toFixed(6)}, ${C2_B.toFixed(6)});
      } else if (classValue == 3) {
        if (${COLORMAP_MODULE_NAME}.visible3 < 0.5) discard;
        rgb = vec3(${C3_R.toFixed(6)}, ${C3_G.toFixed(6)}, ${C3_B.toFixed(6)});
      } else if (classValue == 4) {
        if (${COLORMAP_MODULE_NAME}.visible4 < 0.5) discard;
        rgb = vec3(${C4_R.toFixed(6)}, ${C4_G.toFixed(6)}, ${C4_B.toFixed(6)});
      } else if (classValue == 5) {
        if (${COLORMAP_MODULE_NAME}.visible5 < 0.5) discard;
        rgb = vec3(${C5_R.toFixed(6)}, ${C5_G.toFixed(6)}, ${C5_B.toFixed(6)});
      } else if (classValue == 6) {
        if (${COLORMAP_MODULE_NAME}.visible6 < 0.5) discard;
        rgb = vec3(${C6_R.toFixed(6)}, ${C6_G.toFixed(6)}, ${C6_B.toFixed(6)});
      } else {
        discard;
      }

      color = vec4(rgb, 1.0);
    `,
  },
  uniformTypes: {
    visible1: "f32",
    visible2: "f32",
    visible3: "f32",
    visible4: "f32",
    visible5: "f32",
    visible6: "f32",
  },
  getUniforms: (props: Partial<CategoricalColormapProps>) => {
    return {
      visible1: props.visible1 ?? 1,
      visible2: props.visible2 ?? 1,
      visible3: props.visible3 ?? 1,
      visible4: props.visible4 ?? 1,
      visible5: props.visible5 ?? 1,
      visible6: props.visible6 ?? 1,
    };
  },
} as const satisfies ShaderModule<CategoricalColormapProps>;

// ---- Custom tile data type ----
type TileData = {
  height: number;
  width: number;
  texture: Texture;
};

/**
 * Pad 8-bit data rows to 4-byte alignment for WebGL's UNPACK_ALIGNMENT.
 * For single-channel r8unorm, each row is width bytes. If not divisible
 * by 4, we must pad each row.
 */
function padRows(data: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width;
  const alignedRowBytes = Math.ceil(rowBytes / 4) * 4;
  if (alignedRowBytes === rowBytes) return data;

  const dst = new Uint8Array(alignedRowBytes * height);
  for (let r = 0; r < height; r++) {
    dst.set(
      data.subarray(r * rowBytes, (r + 1) * rowBytes),
      r * alignedRowBytes,
    );
  }
  return dst;
}

/** Custom tile loader for single-band uint8 categorical data.
 *  Uploads as r8unorm; the shader reinterprets values 0..255 as class IDs. */
async function getTileData(
  image: GeoTIFF | Overview,
  options: { device: Device; x: number; y: number; signal?: AbortSignal },
): Promise<TileData> {
  const { device, x, y, signal } = options;
  const tile = await image.fetchTile(x, y, { signal, boundless: false });
  const { width, height } = tile.array;
  const data = "data" in tile.array ? tile.array.data : tile.array.bands[0]!;

  // Ensure uint8 view, then row-align for WebGL upload
  const uint8 = new Uint8Array(data.buffer, data.byteOffset, data.length);
  const aligned = padRows(uint8, width, height);

  const texture = device.createTexture({
    data: aligned,
    format: "r8unorm",
    width,
    height,
    sampler: {
      minFilter: "nearest",
      magFilter: "nearest",
    },
  });

  return { texture, height, width };
}

/** Tile loader for continuous float32 COGs. 1-band -> r32float (value in .r);
 *  2-band -> rg32float (slope in .r, p-value in .g). Handles both decoded
 *  layouts: pixel-interleaved (`.data`, which is already [b0,b1,b0,b1,...]) and
 *  band-separate (`.bands[]`, interleaved manually). Sampled with nearest. */
function makeFloatTileData(bands: 1 | 2): typeof getTileData {
  return async (image, options) => {
    const { device, x, y, signal } = options;
    const tile = await image.fetchTile(x, y, { signal, boundless: false });
    const arr = tile.array;
    const { width, height } = arr;

    let data: Float32Array;
    if ("data" in arr) {
      // pixel-interleaved: already [b0,b1,...] (2-band) or [b0,...] (1-band)
      data =
        arr.data instanceof Float32Array
          ? arr.data
          : new Float32Array(arr.data as ArrayLike<number>);
    } else {
      // band-separate: interleave the bands
      const n = width * height;
      data = new Float32Array(n * bands);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < bands; k++) data[i * bands + k] = arr.bands[k]![i];
      }
    }

    const texture = device.createTexture({
      data,
      format: bands === 2 ? "rg32float" : "r32float",
      width,
      height,
      sampler: { minFilter: "nearest", magFilter: "nearest" },
    });
    return { texture, width, height };
  };
}

// Stable loader identities (avoid re-creating per render)
const floatTileData1 = makeFloatTileData(1);
const floatTileData2 = makeFloatTileData(2);

// ---- Click read-out: sample a pixel from any loaded COG at a lng/lat ---------
const MERC_R = 6378137;
/** lng/lat (deg) -> the raster's source-CRS coords. Identity for EPSG:4326;
 *  forward Web-Mercator for EPSG:3857 (the grazing mask). */
function lngLatToSource(
  lng: number,
  lat: number,
  is3857: boolean,
): [number, number] {
  if (!is3857) return [lng, lat];
  const x = (MERC_R * lng * Math.PI) / 180;
  const y = MERC_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}
/** Read the band value(s) at a lng/lat from a GeoTIFF; null if out of range. */
async function readPixelAt(
  geotiff: GeoTIFF,
  lng: number,
  lat: number,
  is3857: boolean,
  bands: 1 | 2,
): Promise<number[] | null> {
  const [x, y] = lngLatToSource(lng, lat, is3857);
  const [row, col] = geotiff.index(x, y);
  if (row < 0 || row >= geotiff.height || col < 0 || col >= geotiff.width)
    return null;
  const tile = await geotiff.fetchTile(
    Math.floor(col / geotiff.tileWidth),
    Math.floor(row / geotiff.tileHeight),
  );
  const arr = tile.array;
  const idx =
    (row % geotiff.tileHeight) * arr.width + (col % geotiff.tileWidth);
  if (bands === 2) {
    if ("data" in arr) return [arr.data[idx * 2]!, arr.data[idx * 2 + 1]!];
    return [arr.bands[0]![idx]!, arr.bands[1]![idx]!];
  }
  const src = "data" in arr ? arr.data : arr.bands[0]!;
  return [src[idx]!];
}
/** Compact number formatting for the click popup. */
function fmtVal(v: number): string {
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString();
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

export default function App() {
  const mapRef = useRef<MapRef>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [dataOpacity, setDataOpacity] = useState(1);
  const [basemap, setBasemap] = useState<BasemapKey>("light");
  const [cog, setCog] = useState<GeoTIFF | null>(null);
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [tilesLoading, setTilesLoading] = useState(false);
  const loadingCountRef = useRef(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 768);
  const [clickInfo, setClickInfo] = useState<{
    lng: number;
    lat: number;
    rows: { label: string; value: string }[];
  } | null>(null);

  // Per-class visibility (start with all classes visible)
  const [classVisibility, setClassVisibility] = useState<
    Record<number, boolean>
  >(() => Object.fromEntries(CLASSES.map((c) => [c.value, true])));

  const toggleClass = useCallback((value: number) => {
    setClassVisibility((prev) => ({ ...prev, [value]: !prev[value] }));
  }, []);

  // ---- Layer visibility -----------------------------------------------------
  // On first load: grazing mask ON, all continuous data layers OFF.
  const [grazingVisible, setGrazingVisible] = useState(true);
  const [dataVisible, setDataVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(DATA_LAYERS.map((d) => [d.id, false])),
  );
  const toggleData = useCallback((id: string) => {
    setDataVisible((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Lazily fetch each continuous COG the first time its layer is switched on.
  const [dataGeotiffs, setDataGeotiffs] = useState<Record<string, GeoTIFF>>({});
  const loadingIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const def of DATA_LAYERS) {
      if (
        dataVisible[def.id] &&
        !dataGeotiffs[def.id] &&
        !loadingIdsRef.current.has(def.id)
      ) {
        loadingIdsRef.current.add(def.id);
        GeoTIFF.fromUrl(COG_BASE + def.file)
          .then((t) => setDataGeotiffs((prev) => ({ ...prev, [def.id]: t })))
          .catch((e) => {
            console.error(`Failed to load ${def.file}:`, e);
            loadingIdsRef.current.delete(def.id);
          });
      }
    }
  }, [dataVisible, dataGeotiffs]);

  // Wrap any tile loader to track in-flight requests (drives the spinner)
  const withTracking = useCallback(
    (loader: typeof getTileData): typeof getTileData =>
      async (image, options) => {
        loadingCountRef.current++;
        if (loadingCountRef.current === 1) {
          clearTimeout(hideTimerRef.current);
          setTilesLoading(true);
        }
        try {
          return await loader(image, options);
        } finally {
          loadingCountRef.current--;
          if (loadingCountRef.current === 0) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = setTimeout(
              () => setTilesLoading(false),
              150,
            );
          }
        }
      },
    [],
  );
  const trackingGetTileData = useMemo(
    () => withTracking(getTileData),
    [withTracking],
  );
  const trackedFloat1 = useMemo(
    () => withTracking(floatTileData1),
    [withTracking],
  );
  const trackedFloat2 = useMemo(
    () => withTracking(floatTileData2),
    [withTracking],
  );

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => clearTimeout(hideTimerRef.current);
  }, []);

  useEffect(() => {
    cogPromise.then(setCog);
  }, []);

  // Inject @keyframes spin CSS (project uses no CSS files)
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Sample every VISIBLE layer at the clicked point and show them all.
  const handleMapClick = useCallback(
    async (e: MapLayerMouseEvent) => {
      const { lng, lat } = e.lngLat;
      const rows: { label: string; value: string }[] = [];

      // grazing mask — EPSG:3857 uint8 class codes
      if (grazingVisible && cog) {
        try {
          const v = await readPixelAt(cog, lng, lat, true, 1);
          const cls = v?.[0];
          if (cls != null && cls !== 0 && cls !== 255 && Number.isFinite(cls)) {
            const info = CLASSES.find((c) => c.value === cls);
            rows.push({
              label: "Grazing class",
              value: info ? info.label : `${cls}`,
            });
          }
        } catch {
          /* out of range or fetch error — skip this layer */
        }
      }

      // continuous data layers — EPSG:4326 (trend = slope + p-value, mean = value)
      for (const def of DATA_LAYERS) {
        if (!dataVisible[def.id]) continue;
        const gt = dataGeotiffs[def.id];
        if (!gt) continue;
        try {
          // data layers are now native EPSG:3857 (like the grazing mask)
          const v = await readPixelAt(gt, lng, lat, true, def.bands);
          const val = v?.[0];
          if (val == null || !Number.isFinite(val) || val === def.nodata)
            continue;
          if (def.bands === 2) {
            const p = v[1]!;
            const sig = Number.isFinite(p) && p < MK_ALPHA;
            rows.push({
              label: `${def.label} (${def.sublabel})`,
              value: `${fmtVal(val)} ${def.units} · p=${p.toFixed(3)} ${sig ? "✓ significant" : "n.s."}`,
            });
          } else {
            rows.push({
              label: `${def.label} (${def.sublabel})`,
              value: `${fmtVal(val)} ${def.units}`,
            });
          }
        } catch {
          /* skip this layer */
        }
      }

      setClickInfo(rows.length ? { lng, lat, rows } : null);
    },
    [cog, grazingVisible, dataVisible, dataGeotiffs],
  );

  const layers = [];

  if (cog && grazingVisible) {
    const cogLayer = new COGLayer<TileData>({
      id: "grazing-lands-layer",
      opacity: dataOpacity,
      geotiff: cog,
      epsgResolver: customEpsgResolver, // ← add this
      getTileData: trackingGetTileData,
      renderTile: (tileData: TileData): RasterModule[] => [
        {
          module: CreateTexture,
          props: { textureName: tileData.texture },
        },
        {
          module: CategoricalColormap,
          props: {
            visible1: classVisibility[1] ? 1 : 0,
            visible2: classVisibility[2] ? 1 : 0,
            visible3: classVisibility[3] ? 1 : 0,
            visible4: classVisibility[4] ? 1 : 0,
            visible5: classVisibility[5] ? 1 : 0,
            visible6: classVisibility[6] ? 1 : 0,
          },
        },
      ],
      onGeoTIFFLoad: (tiff, options) => {
        console.log("GeoTIFF loaded:", {
          projection: options.projection,
          geographicBounds: options.geographicBounds,
          width: tiff.width,
          height: tiff.height,
          tileWidth: tiff.tileWidth,
          tileHeight: tiff.tileHeight,
        });
        setMetadataLoaded(true);

        // Use bounds from options if valid, otherwise fall back to global
        // extent. We know from gdalinfo this raster is -180,-90,180,90.
        // (Use ±85 instead of ±90 because Web Mercator breaks at the poles.)
        const b = options.geographicBounds;
        const boundsValid =
          Number.isFinite(b.west) &&
          Number.isFinite(b.south) &&
          Number.isFinite(b.east) &&
          Number.isFinite(b.north);

        const fit: [[number, number], [number, number]] = boundsValid
          ? [
              [b.west, b.south],
              [b.east, b.north],
            ]
          : [
              [-180, -85],
              [180, 85],
            ];

        mapRef.current?.fitBounds(fit, { padding: 40, duration: 1000 });
      },
      updateTriggers: {
        renderTile: [
          classVisibility[1],
          classVisibility[2],
          classVisibility[3],
          classVisibility[4],
          classVisibility[5],
          classVisibility[6],
        ],
      },
    });
    layers.push(cogLayer);
  }

  // Continuous data layers (trend slopes + means), rendered above the mask.
  for (const def of DATA_LAYERS) {
    if (!dataVisible[def.id]) continue;
    const tiff = dataGeotiffs[def.id];
    if (!tiff) continue; // still fetching header
    layers.push(
      new COGLayer<TileData>({
        id: def.id,
        opacity: dataOpacity,
        geotiff: tiff,
        epsgResolver: customEpsgResolver,
        getTileData: def.bands === 2 ? trackedFloat2 : trackedFloat1,
        renderTile: (tileData: TileData): RasterModule[] => [
          { module: CreateTexture, props: { textureName: tileData.texture } },
          { module: MODULES[def.id] as unknown as ShaderModule, props: {} },
        ],
      }),
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={{
          longitude: 20,
          latitude: 15,
          zoom: 1.5,
          pitch: 0,
          bearing: 0,
        }}
        mapStyle={BASEMAPS[basemap] as string}
        onClick={handleMapClick}
      >
        <DeckGLOverlay
          layers={layers}
          // @ts-expect-error interleaved is valid for MapboxOverlay but missing from DeckProps
          interleaved
          onDeviceInitialized={setDevice}
        />
        {clickInfo && (
          <Popup
            longitude={clickInfo.lng}
            latitude={clickInfo.lat}
            closeOnClick={false}
            onClose={() => setClickInfo(null)}
            anchor="bottom"
            maxWidth="300px"
          >
            <div style={{ lineHeight: 1.45, fontSize: "12px" }}>
              {clickInfo.rows.map((r) => (
                <div key={r.label} style={{ marginBottom: "3px" }}>
                  <div style={{ opacity: 0.6, fontSize: "11px" }}>
                    {r.label}
                  </div>
                  <strong>{r.value}</strong>
                </div>
              ))}
              <div style={{ opacity: 0.5, fontSize: "10px", marginTop: "4px" }}>
                {clickInfo.lat.toFixed(4)}°, {clickInfo.lng.toFixed(4)}°
              </div>
            </div>
          </Popup>
        )}
      </MaplibreMap>

      {/* Per-layer legends (one card per active data layer, top-center) */}
      <div
        style={{
          position: "absolute",
          top: "12px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 900,
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          alignItems: "center",
          pointerEvents: "none",
        }}
      >
        {DATA_LAYERS.filter((d) => dataVisible[d.id]).map((def) => {
          const [lo, hi] = def.domain;
          const diverging = lo < 0 && hi > 0;
          const fmt = (v: number) =>
            Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1);
          return (
            <div
              key={def.id}
              style={{
                background: "white",
                padding: "6px 12px",
                borderRadius: "6px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                fontSize: "11px",
                minWidth: "210px",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: "3px" }}>
                {def.label}{" "}
                <span style={{ fontWeight: 400, color: "#999" }}>
                  {def.sublabel}
                </span>
              </div>
              <div
                style={{
                  height: "10px",
                  borderRadius: "2px",
                  background: rampCss(def),
                  border: "1px solid #ccc",
                }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginTop: "2px",
                  color: "#555",
                }}
              >
                <span>{fmt(lo)}</span>
                {diverging && <span>0</span>}
                <span>{fmt(hi)}</span>
              </div>
              <div
                style={{ color: "#888", fontSize: "10px", marginTop: "1px" }}
              >
                {def.units}
                {def.hatch ? " · hatched = not significant (p ≥ 0.05)" : ""}
              </div>
            </div>
          );
        })}
      </div>

      {/* Loading spinner */}
      {(tilesLoading || (device && !metadataLoaded)) && (
        <div
          style={{
            position: "absolute",
            top: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "rgba(0, 0, 0, 0.7)",
            color: "#fff",
            padding: "8px 14px",
            borderRadius: "20px",
            fontSize: "13px",
          }}
        >
          <div
            style={{
              width: "14px",
              height: "14px",
              border: "2px solid rgba(255,255,255,0.3)",
              borderTopColor: "#fff",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }}
          />
          {!metadataLoaded ? "Loading metadata…" : "Loading tiles…"}
        </div>
      )}

      {/* Panel toggle button (visible when collapsed) */}
      {!panelOpen && (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          style={{
            position: "absolute",
            top: "20px",
            left: "20px",
            zIndex: 1000,
            width: "36px",
            height: "36px",
            borderRadius: "8px",
            border: "none",
            background: "white",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            cursor: "pointer",
            fontSize: "18px",
            lineHeight: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          aria-label="Open settings"
        >
          &#9776;
        </button>
      )}

      {/* Info Panel */}
      {panelOpen && (
        <div
          style={{
            position: "absolute",
            top: "20px",
            left: "20px",
            zIndex: 1000,
            background: "white",
            padding: "16px",
            borderRadius: "8px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            maxWidth: "320px",
            width: "calc(100vw - 40px)",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
            }}
          >
            <div>
              <h3 style={{ margin: "0 0 4px 0", fontSize: "16px" }}>
                Global Rangelands
              </h3>
              <p
                style={{
                  margin: "0 0 12px 0",
                  fontSize: "12px",
                  color: "#666",
                }}
              >
                ~1&nbsp;km resolution · 2024
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: "18px",
                lineHeight: 1,
                padding: "0 0 0 8px",
                color: "#999",
              }}
              aria-label="Close settings"
            >
              &#10005;
            </button>
          </div>

          {/* Map layers (toggle whole layers on/off) */}
          <div style={{ marginBottom: "14px" }}>
            <div
              style={{
                fontSize: "12px",
                color: "#666",
                marginBottom: "6px",
                fontWeight: 600,
              }}
            >
              Map layers
            </div>

            {/* grazing mask master toggle */}
            <button
              type="button"
              onClick={() => setGrazingVisible((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                marginBottom: "4px",
                fontSize: "12px",
                width: "100%",
                padding: "2px 4px",
                background: "transparent",
                border: "none",
                borderRadius: "3px",
                cursor: "pointer",
                textAlign: "left",
                opacity: grazingVisible ? 1 : 0.4,
                color: "inherit",
              }}
              aria-pressed={grazingVisible}
            >
              <input
                type="checkbox"
                checked={grazingVisible}
                readOnly
                tabIndex={-1}
                style={{ margin: 0, flexShrink: 0 }}
              />
              <div
                style={{
                  width: "18px",
                  height: "14px",
                  background: "#5d9a54",
                  border: "1px solid #ccc",
                  borderRadius: "2px",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontWeight: 600 }}>Grazing lands mask</span>
            </button>

            {/* continuous data layers */}
            {DATA_LAYERS.map((def: LayerDef) => {
              const on = dataVisible[def.id] ?? false;
              const loading = on && !dataGeotiffs[def.id];
              return (
                <button
                  key={def.id}
                  type="button"
                  onClick={() => toggleData(def.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginBottom: "4px",
                    fontSize: "12px",
                    width: "100%",
                    padding: "2px 4px",
                    background: "transparent",
                    border: "none",
                    borderRadius: "3px",
                    cursor: "pointer",
                    textAlign: "left",
                    opacity: on ? 1 : 0.45,
                    color: "inherit",
                  }}
                  aria-pressed={on}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    readOnly
                    tabIndex={-1}
                    style={{ margin: 0, flexShrink: 0 }}
                  />
                  <div
                    style={{
                      width: "18px",
                      height: "14px",
                      background: rampCss(def),
                      border: "1px solid #ccc",
                      borderRadius: "2px",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1 }}>
                    {def.label}{" "}
                    <span style={{ color: "#999", fontSize: "10px" }}>
                      {def.sublabel}
                    </span>
                  </span>
                  {loading && (
                    <span style={{ fontSize: "10px", color: "#999" }}>…</span>
                  )}
                </button>
              );
            })}
            <div style={{ fontSize: "10px", color: "#999", marginTop: "2px" }}>
              Trends: hatched = not significant (MK p ≥ {MK_ALPHA})
            </div>
          </div>

          {/* Legend (click rows to toggle classes) */}
          <div style={{ marginBottom: "12px" }}>
            <div
              style={{
                fontSize: "12px",
                color: "#666",
                marginBottom: "6px",
                fontWeight: 600,
              }}
            >
              Legend &nbsp;
              <span style={{ fontWeight: 400, fontSize: "10px" }}>
                (click to toggle)
              </span>
            </div>
            {CLASSES.map((c) => {
              const isVisible = classVisibility[c.value] ?? true;
              return (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => toggleClass(c.value)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginBottom: "4px",
                    fontSize: "12px",
                    width: "100%",
                    padding: "2px 4px",
                    background: "transparent",
                    border: "none",
                    borderRadius: "3px",
                    cursor: "pointer",
                    textAlign: "left",
                    opacity: isVisible ? 1 : 0.4,
                    color: "inherit",
                  }}
                  aria-pressed={isVisible}
                  title={isVisible ? "Click to hide" : "Click to show"}
                >
                  <input
                    type="checkbox"
                    checked={isVisible}
                    readOnly
                    tabIndex={-1}
                    style={{
                      margin: 0,
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  />
                  <div
                    style={{
                      width: "18px",
                      height: "14px",
                      background: c.color,
                      border: "1px solid #ccc",
                      borderRadius: "2px",
                      flexShrink: 0,
                    }}
                  />
                  <span>{c.label}</span>
                </button>
              );
            })}
          </div>

          {/* Basemap toggle */}
          <div style={{ marginBottom: "12px" }}>
            <button
              type="button"
              onClick={() =>
                setBasemap((b) => (b === "light" ? "satellite" : "light"))
              }
              style={{
                width: "100%",
                padding: "6px 12px",
                fontSize: "12px",
                cursor: "pointer",
                background: "#f0f0f0",
                border: "1px solid #ccc",
                borderRadius: "4px",
              }}
            >
              {basemap === "light"
                ? "Switch to satellite basemap"
                : "Switch to light basemap"}
            </button>
          </div>

          {/* Data opacity slider */}
          <div style={{ marginBottom: "12px" }}>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                color: "#666",
                marginBottom: "2px",
              }}
            >
              Data Opacity: {Math.round(dataOpacity * 100)}%
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={dataOpacity}
                onChange={(e) => setDataOpacity(parseFloat(e.target.value))}
                style={{ width: "100%", cursor: "pointer" }}
              />
            </label>
          </div>

          <p style={{ margin: 0, fontSize: "11px", color: "#999" }}>
            Data:{" "}
            <a
              href="https://source.coop/woodwell-climate/rangelands-raster-1"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#666" }}
            >
              source.coop
            </a>
            {" | "}
            Rendered with{" "}
            <a
              href="https://github.com/developmentseed/deck.gl-raster"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "#666",
                fontFamily: "monospace",
                fontSize: "10px",
              }}
            >
              deck.gl-raster
            </a>
          </p>
          <p
            style={{
              margin: "4px 0 0 0",
              fontSize: "11px",
              color: "#999",
            }}
          >
            Map created by Mika Tosca for Woodwell Climate Research Center
          </p>
        </div>
      )}
    </div>
  );
}
