// Data-layer config + continuous-colormap shader factory for the trend / mean
// COGs. The grazing-mask layer stays defined in App.tsx (categorical uint8);
// these are the continuous float32 layers streamed as COGs.

// ---- where the COGs live -----------------------------------------------------
// DEV (`pnpm dev`): local files staged in public/cogs/ (Vite serves with ranges).
// PROD (`pnpm build`): the same files on Source Cooperative. Swapped automatically
// by Vite's import.meta.env.DEV — nothing to hand-edit.
export const COG_BASE = import.meta.env.DEV
  ? `${import.meta.env.BASE_URL}cogs/` // e.g. /rangelands-web-viewer/cogs/ (Vite serves public/ under base)
  : "https://data.source.coop/woodwell-climate/rangelands-raster-1/";

export const ALPHA = 0.05; // MK significance threshold (drives the hatch)

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const s = h.replace("#", "");
  return [
    parseInt(s.slice(0, 2), 16) / 255,
    parseInt(s.slice(2, 4), 16) / 255,
    parseInt(s.slice(4, 6), 16) / 255,
  ];
};
const v3 = (c: RGB) =>
  `vec3(${c[0].toFixed(6)}, ${c[1].toFixed(6)}, ${c[2].toFixed(6)})`;

// ---- palette anchors (match global_trend_maps.ipynb) -------------------------
const CREAM = "#f5f2e6";
const RAMPS = {
  // trends: negative -> cream -> positive
  gpp_trend: [hex("#e8c21a"), hex(CREAM), hex("#177d3c")], // yellow -> green
  soc_trend: [hex("#cc9a3f"), hex(CREAM), hex("#5f8a1f")], // tan -> olive
  nee_trend: [hex("#5f8a1f"), hex(CREAM), hex("#cc9a3f")], // green -> tan (flipped)
  rh_trend: [hex("#5f8a1f"), hex(CREAM), hex("#cc9a3f")], // green -> tan (flipped)
  // means
  gpp_mean: [hex("#f7fcf5"), hex("#74c476"), hex("#00441b")], // sequential greens
  nee_mean: [hex("#5f8a1f"), hex(CREAM), hex("#cc9a3f")], // diverging (sink green / source tan)
} satisfies Record<string, [RGB, RGB, RGB]>;

export type LayerDef = {
  id: string;
  label: string;
  sublabel: string; // period note, shown in legend
  group: "trend" | "mean";
  file: string;
  bands: 1 | 2; // 2 = slope + p-value (trend), 1 = value (mean)
  ramp: [RGB, RGB, RGB]; // [low, mid, high]
  domain: [number, number]; // vmin, vmax
  nodata: number;
  hatch: boolean; // hatch where band2 (p) >= ALPHA
  units: string;
};

// ordered as shown in the panel; all start hidden (grazing mask shows first)
export const DATA_LAYERS: LayerDef[] = [
  {
    id: "trend_GPP",
    label: "GPP trend",
    sublabel: "2001–2025",
    group: "trend",
    file: "trend_GPP_2001-2025_4326.tif",
    bands: 2,
    ramp: RAMPS.gpp_trend,
    domain: [-20.4, 20.4],
    nodata: -9999,
    hatch: true,
    units: "gC m⁻² yr⁻¹ / yr",
  },
  {
    id: "trend_NEE",
    label: "NEE trend",
    sublabel: "2001–2025",
    group: "trend",
    file: "trend_NEE_2001-2025_4326.tif",
    bands: 2,
    ramp: RAMPS.nee_trend,
    domain: [-8.5, 8.5],
    nodata: -9999,
    hatch: true,
    units: "gC m⁻² yr⁻¹ / yr",
  },
  {
    id: "trend_RH",
    label: "RH trend",
    sublabel: "2001–2025",
    group: "trend",
    file: "trend_RH_2001-2025_4326.tif",
    bands: 2,
    ramp: RAMPS.rh_trend,
    domain: [-3.3, 3.3],
    nodata: -9999,
    hatch: true,
    units: "gC m⁻² yr⁻¹ / yr",
  },
  {
    id: "trend_SOC",
    label: "SOC trend",
    sublabel: "2001–2025",
    group: "trend",
    file: "trend_SOC_2001-2025_4326.tif",
    bands: 2,
    ramp: RAMPS.soc_trend,
    domain: [-56.4, 56.4],
    nodata: -9999,
    hatch: true,
    units: "gC m⁻² yr⁻¹ / yr",
  },
  {
    id: "mean_GPP",
    label: "GPP mean",
    sublabel: "2016–2025",
    group: "mean",
    file: "mean_GPP_2016-2025_4326.tif",
    bands: 1,
    ramp: RAMPS.gpp_mean,
    domain: [0, 6500],
    nodata: 0,
    hatch: false,
    units: "gC m⁻² yr⁻¹",
  },
  {
    id: "mean_NEE",
    label: "NEE mean",
    sublabel: "2016–2025",
    group: "mean",
    file: "mean_NEE_2016-2025_4326.tif",
    bands: 1,
    ramp: RAMPS.nee_mean,
    domain: [-272, 272],
    nodata: 0,
    hatch: false,
    units: "gC m⁻² yr⁻¹",
  },
];

// ---- CSS gradient string for the legend swatch (matches the shader ramp) -----
export function rampCss(def: LayerDef): string {
  const [lo, mid, hi] = def.ramp.map(
    (c) =>
      `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`,
  );
  return `linear-gradient(to right, ${lo}, ${mid}, ${hi})`;
}

// ---- shader module factory ---------------------------------------------------
// One module per layer, colors + domain baked in (like CategoricalColormap bakes
// class colors) so we avoid std140 vec3-uniform alignment pitfalls. `color.r` is
// the sampled float value (band 1); `color.g` is band 2 (p-value) for trends.
export function makeContinuousModule(def: LayerDef) {
  const [c0, cm, c1] = def.ramp;
  const [vmin, vmax] = def.domain;
  // nodata discard: trends use -9999 sentinel, means use exact 0 (ocean)
  const discard =
    def.nodata <= -1000 ? "v < -9000.0" : `v == ${def.nodata.toFixed(1)}`;

  const hatchGlsl = def.hatch
    ? /* glsl */ `
      // band 2 = MK p-value. Non-significant (p >= ALPHA) gets light diagonal
      // hash lines in screen space; significant pixels stay clean.
      float pval = color.g;
      if (pval >= ${ALPHA.toFixed(3)}) {
        float d = mod(gl_FragCoord.x + gl_FragCoord.y, 7.0);
        if (d < 1.0) rgb = mix(rgb, vec3(0.20), 0.45);
      }`
    : "";

  return {
    name: `continuous_${def.id}`,
    fs: "",
    inject: {
      "fs:DECKGL_FILTER_COLOR": /* glsl */ `
        float v = color.r;
        if (${discard}) discard;
        float t = clamp((v - ${vmin.toFixed(4)}) / (${(vmax - vmin).toFixed(4)}), 0.0, 1.0);
        vec3 c0 = ${v3(c0)};
        vec3 cm = ${v3(cm)};
        vec3 c1 = ${v3(c1)};
        vec3 rgb = t < 0.5 ? mix(c0, cm, t * 2.0) : mix(cm, c1, (t - 0.5) * 2.0);
        ${hatchGlsl}
        color = vec4(rgb, 1.0);
      `,
    },
  } as const;
}

// Precompute one shader module per layer (pure/stable identity so deck.gl does
// not recompile shaders on every render).
export const MODULES: Record<
  string,
  ReturnType<typeof makeContinuousModule>
> = Object.fromEntries(DATA_LAYERS.map((d) => [d.id, makeContinuousModule(d)]));
