import type { DeckProps } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { COGLayer } from "@developmentseed/deck.gl-geotiff";
import type { RasterModule } from "@developmentseed/deck.gl-raster";
import {
  Colormap,
  CreateTexture,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { GeoTIFF, Overview } from "@developmentseed/geotiff";
import type { Device, Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import { Map as MaplibreMap, useControl } from "react-map-gl/maplibre";
import colormap from "./colormap";

function DeckGLOverlay(props: DeckProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

// ---- Basemap styles ----
const BASEMAPS = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
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
      },
    ],
  },
} as const;

type BasemapKey = keyof typeof BASEMAPS;

// ---- Data source (Int16 COG on source.coop) ----
const COG_URL =
  "https://data.source.coop/luddaludwig/potential-agc-combustion-ssp585-v0/AGC_final.tif";

// ---- Data range (from gdalinfo: Min=0, Max=4102 for the unsigned version) ----
// The Int16 source has the same value range; negative values are nodata/unused.
const DATA_MIN = 0;
const DATA_MAX = 4102;

// ---- Custom shader: rescale r16unorm value to [0,1] using min/max ----
// r16unorm maps 0..65535 → 0.0..1.0, so rawValue = color.r * 65535.0
type RescaleProps = { rangeMin: number; rangeMax: number };

const Rescale = {
  name: "rescale",
  fs: `\
uniform rescaleUniforms {
  float rangeMin;
  float rangeMax;
} rescale;
`,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float rawValue = color.r * 65535.0;
      // Treat 0 as nodata
      if (rawValue == 0.0) discard;
      float t = clamp(
        (rawValue - rescale.rangeMin) / (rescale.rangeMax - rescale.rangeMin),
        0.0,
        1.0
      );
      color.r = t;
    `,
  },
  uniformTypes: {
    rangeMin: "f32",
    rangeMax: "f32",
  },
  getUniforms: (props: Partial<RescaleProps>) => ({
    rangeMin: props.rangeMin ?? DATA_MIN,
    rangeMax: props.rangeMax ?? DATA_MAX,
  }),
} as const satisfies ShaderModule<RescaleProps>;

/** Set alpha to 1.0 (data has no alpha channel) */
const SetAlpha1 = {
  name: "set-alpha-1",
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      color = vec4(color.rgb, 1.0);
    `,
  },
} as const satisfies ShaderModule;

// ---- Custom tile data type ----
type TileData = {
  height: number;
  width: number;
  texture: Texture;
};

/**
 * Pad 16-bit data rows to 4-byte alignment for WebGL's UNPACK_ALIGNMENT.
 * For single-channel r16unorm, each row is width*2 bytes. If not divisible
 * by 4 (i.e., odd width), we must pad each row.
 */
function padRows(
  data: Uint16Array,
  width: number,
  height: number,
): Uint16Array {
  const rowBytes = width * 2;
  const alignedRowBytes = Math.ceil(rowBytes / 4) * 4;
  if (alignedRowBytes === rowBytes) return data;

  const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const dst = new Uint8Array(alignedRowBytes * height);
  for (let r = 0; r < height; r++) {
    dst.set(
      src.subarray(r * rowBytes, (r + 1) * rowBytes),
      r * alignedRowBytes,
    );
  }
  return new Uint16Array(dst.buffer);
}

/** Custom tile loader for single-band Int16 data.
 *  Uploads as r16unorm (reinterprets bits as unsigned). Since actual values
 *  are positive (0–4102), this avoids an Int16→Float32 copy. */
async function getTileData(
  image: GeoTIFF | Overview,
  options: { device: Device; x: number; y: number; signal?: AbortSignal },
): Promise<TileData> {
  const { device, x, y, signal } = options;
  const tile = await image.fetchTile(x, y, { signal, boundless: false });
  const { width, height, data } = tile.array;

  // Reinterpret Int16 bits as Uint16 for r16unorm upload, with row alignment
  const uint16 = new Uint16Array(data.buffer, data.byteOffset, data.length);
  const aligned = padRows(uint16, width, height);

  const texture = device.createTexture({
    data: aligned,
    format: "r16unorm",
    width,
    height,
    sampler: {
      minFilter: "nearest",
      magFilter: "nearest",
    },
  });

  return { texture, height, width };
}

export default function App() {
  const mapRef = useRef<MapRef>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [colormapTexture, setColormapTexture] = useState<Texture | null>(null);
  const [rangeMin, setRangeMin] = useState(DATA_MIN);
  const [rangeMax, setRangeMax] = useState(DATA_MAX);
  const [basemap, setBasemap] = useState<BasemapKey>("dark");
  const [dataOpacity, setDataOpacity] = useState(1);

  // Create colormap texture once when device is available
  useEffect(() => {
    if (!device) return;

    const texture = device.createTexture({
      data: colormap.data,
      width: colormap.width,
      height: colormap.height,
      format: "rgba8unorm",
      sampler: {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });

    setColormapTexture(texture);
  }, [device]);

  const layers = [];

  if (colormapTexture) {
    const cogLayer = new COGLayer<TileData>({
      id: "agc-layer",
      opacity: dataOpacity,
      geotiff: COG_URL,
      getTileData,
      renderTile: (tileData: TileData): RasterModule[] => [
        {
          module: CreateTexture,
          props: { textureName: tileData.texture },
        },
        {
          module: Rescale,
          props: { rangeMin, rangeMax },
        },
        {
          module: Colormap,
          props: { colormapTexture },
        },
        {
          module: SetAlpha1,
        },
      ],
      onGeoTIFFLoad: (_tiff, options) => {
        const { west, south, east, north } = options.geographicBounds;
        mapRef.current?.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding: 40, duration: 1000 },
        );
      },
      ...(basemap === "dark" && { beforeId: "boundary_country_outline" }),
    });
    layers.push(cogLayer);
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={{
          longitude: -112.5,
          latitude: 60,
          zoom: 3,
          pitch: 0,
          bearing: 0,
        }}
        mapStyle={BASEMAPS[basemap]}
      >
        <DeckGLOverlay
          layers={layers}
          interleaved
          onDeviceInitialized={setDevice}
        />
      </MaplibreMap>

      {/* Info Panel */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 1000,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "20px",
            left: "20px",
            background: "white",
            padding: "16px",
            borderRadius: "8px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            maxWidth: "320px",
            pointerEvents: "auto",
          }}
        >
          <h3 style={{ margin: "0 0 4px 0", fontSize: "16px" }}>
            Potential Above-Ground Combustion
          </h3>
          <p
            style={{
              margin: "0 0 12px 0",
              fontSize: "12px",
              color: "#666",
            }}
          >
            Boreal and Arctic North America — SSP585
          </p>

          {/* Min slider */}
          <div style={{ marginBottom: "8px" }}>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                color: "#666",
                marginBottom: "2px",
              }}
            >
              Min: {rangeMin}
              <input
                type="range"
                min={DATA_MIN}
                max={DATA_MAX}
                step={1}
                value={rangeMin}
                onChange={(e) =>
                  setRangeMin(
                    Math.min(parseFloat(e.target.value), rangeMax - 1),
                  )
                }
                style={{ width: "100%", cursor: "pointer" }}
              />
            </label>
          </div>

          {/* Max slider */}
          <div style={{ marginBottom: "12px" }}>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                color: "#666",
                marginBottom: "2px",
              }}
            >
              Max: {rangeMax}
              <input
                type="range"
                min={DATA_MIN}
                max={DATA_MAX}
                step={1}
                value={rangeMax}
                onChange={(e) =>
                  setRangeMax(
                    Math.max(parseFloat(e.target.value), rangeMin + 1),
                  )
                }
                style={{ width: "100%", cursor: "pointer" }}
              />
            </label>
          </div>

          {/* Basemap toggle */}
          <div style={{ marginBottom: "12px" }}>
            <button
              type="button"
              onClick={() =>
                setBasemap((b) => (b === "dark" ? "satellite" : "dark"))
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
              {basemap === "dark"
                ? "Switch to satellite basemap"
                : "Switch to dark basemap"}
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

          {/* Colormap gradient preview */}
          <div
            style={{
              height: "12px",
              borderRadius: "2px",
              background:
                "linear-gradient(to right, #440154, #3b528b, #21918c, #5ec962, #b5de2b, #fde725)",
              marginBottom: "12px",
            }}
          />

          <p style={{ margin: 0, fontSize: "11px", color: "#999" }}>
            Data:{" "}
            <a
              href="https://source.coop/luddaludwig/potential-agc-combustion-ssp585-v0"
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
        </div>
      </div>
    </div>
  );
}
