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
/** A colour stop: position along the ramp (0..1) plus its colour. */
type Stop = [number, RGB];

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

/** [low, mid, high] -> evenly spaced stops. Keeps the original three-colour
 *  ramps below rendering exactly as they did before stops were introduced. */
const tri = (lo: RGB, mid: RGB, hi: RGB): Stop[] => [
  [0, lo],
  [0.5, mid],
  [1, hi],
];
const stops = (...pairs: [number, string][]): Stop[] =>
  pairs.map(([p, h]) => [p, hex(h)]);

// ---- palette anchors (match global_trend_maps.ipynb) -------------------------
const CREAM = "#f5f2e6";
const RAMPS = {
  // trends: negative -> cream -> positive
  gpp_trend: tri(hex("#e8c21a"), hex(CREAM), hex("#177d3c")), // yellow -> green
  soc_trend: tri(hex("#cc9a3f"), hex(CREAM), hex("#5f8a1f")), // tan -> olive
  nee_trend: tri(hex("#5f8a1f"), hex(CREAM), hex("#cc9a3f")), // green -> tan (flipped)
  rh_trend: tri(hex("#5f8a1f"), hex(CREAM), hex("#cc9a3f")), // green -> tan (flipped)
  // means
  gpp_mean: tri(hex("#f7fcf5"), hex("#74c476"), hex("#00441b")), // sequential greens
  nee_mean: tri(hex("#5f8a1f"), hex(CREAM), hex("#cc9a3f")), // diverging (sink green / source tan)

  // ---- climate ramps, copied stop-for-stop from climate_trend_maps.ipynb -----
  // Both are diverging with a NEUTRAL gray midpoint (never a hue in the middle),
  // and each arm is lightness-monotonic in OKLab. Nine stops, so they cannot be
  // approximated by a three-colour ramp without shifting the mid-tones.
  // brown/tan/orange = drier -> teal/deep blue = wetter
  dry_wet: stops(
    [0.0, "#7a3f10"],
    [0.125, "#a8621f"],
    [0.25, "#cd8b3e"],
    [0.375, "#e8c48d"],
    [0.5, "#f2f2f0"],
    [0.625, "#a8d5d0"],
    [0.75, "#5aa8a8"],
    [0.875, "#2b7391"],
    [1.0, "#123f5e"],
  ),
  // blue-purple = cooler -> red-orange = warmer
  cool_warm: stops(
    [0.0, "#3b1f6b"],
    [0.125, "#5a3a96"],
    [0.25, "#7b62b8"],
    [0.375, "#b3a3d9"],
    [0.5, "#f2f2f0"],
    [0.625, "#f7c9a3"],
    [0.75, "#ee9a5c"],
    [0.875, "#d96b2c"],
    [1.0, "#a33d0a"],
  ),
} satisfies Record<string, Stop[]>;

/**
 * Move a diverging ramp's neutral stop onto data value 0 for an ASYMMETRIC
 * domain, keeping the scale linear in data units (the notebook's recentre_cmap).
 *
 * Without this the shader puts the neutral colour at the domain's midpoint, so
 * for tas (-0.05..+0.10) zero would render as a warm tint and the map would
 * claim warming where there is none. The alternative — giving each arm half the
 * ramp regardless of its data span — makes one colour step mean different
 * amounts on either side, which is why the figures do not use TwoSlopeNorm.
 */
function recentre(ramp: Stop[], lo: number, hi: number): Stop[] {
  const frac = (0 - lo) / (hi - lo);
  return ramp.map(([p, c]) => [
    p <= 0.5 ? (p / 0.5) * frac : frac + ((p - 0.5) / 0.5) * (1 - frac),
    c,
  ]);
}

export type LayerDef = {
  id: string;
  label: string;
  sublabel: string; // period note, shown in legend
  group: "trend" | "mean" | "climate";
  file: string;
  bands: 1 | 2; // 2 = slope + p-value (trend), 1 = value (mean)
  ramp: Stop[]; // ascending stop positions, first at 0 and last at 1
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
    file: "trend_GPP_2001-2025_3857.tif",
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
    file: "trend_NEE_2001-2025_3857.tif",
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
    file: "trend_RH_2001-2025_3857.tif",
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
    file: "trend_SOC_2001-2025_3857.tif",
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
    file: "mean_GPP_2016-2025_3857.tif",
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
    file: "mean_NEE_2016-2025_3857.tif",
    bands: 1,
    ramp: RAMPS.nee_mean,
    domain: [-272, 272],
    nodata: 0,
    hatch: false,
    units: "gC m⁻² yr⁻¹",
  },

  // ---- climate change-detection trends (2000–2024) ---------------------------
  // Built by web-cogs/build_climate_web_cogs.py from the SMAP_CLIMATE 4-band
  // Mann-Kendall / Theil-Sen rasters, masked to the v6 rangelands mask so they
  // cover the same footprint as the carbon-flux layers above. Colour limits and
  // slope scaling match climate_trend_maps.ipynb, so the legends here read the
  // same numbers as the published figures.
  {
    id: "trend_surface_wetness",
    label: "Surface wetness trend",
    sublabel: "2000–2024",
    group: "climate",
    file: "trend_surface_wetness_2000-2024_3857.tif",
    bands: 2,
    ramp: RAMPS.dry_wet,
    domain: [-0.75, 0.75],
    nodata: -9999,
    hatch: true,
    units: "% saturation yr⁻¹",
  },
  {
    id: "trend_rootzone_wetness",
    label: "Root-zone wetness trend",
    sublabel: "2000–2024",
    group: "climate",
    file: "trend_rootzone_wetness_2000-2024_3857.tif",
    bands: 2,
    ramp: RAMPS.dry_wet,
    domain: [-0.75, 0.75],
    nodata: -9999,
    hatch: true,
    units: "% saturation yr⁻¹",
  },
  {
    // AI = P/PET, so HIGHER means WETTER: a positive trend is *less* arid.
    // The dry_wet ramp therefore applies unflipped (brown = drier = negative).
    id: "trend_aridity",
    label: "Aridity index trend",
    sublabel: "2000–2024",
    group: "climate",
    file: "trend_aridity_2000-2024_3857.tif",
    bands: 2,
    ramp: RAMPS.dry_wet,
    domain: [-7.5, 7.5],
    nodata: -9999,
    hatch: true,
    units: "×10⁻³ AI yr⁻¹",
  },
  {
    // Asymmetric domain: over rangelands this field only warms (+0.009 to
    // +0.103 K yr⁻¹), so the ramp is recentred to keep neutral on zero.
    // It is also ~100% significant, so almost nothing gets hatched.
    id: "trend_tas",
    label: "Air temperature trend",
    sublabel: "2000–2024",
    group: "climate",
    file: "trend_tas_2000-2024_3857.tif",
    bands: 2,
    ramp: recentre(RAMPS.cool_warm, -0.05, 0.1),
    domain: [-0.05, 0.1],
    nodata: -9999,
    hatch: true,
    units: "K yr⁻¹",
  },
];

/** Tick formatting for the legend: pick decimals from the domain's span so
 *  small climate domains (±0.75, −0.05..0.10) don't collapse to "0.8" / "0.1". */
export function fmtTick(v: number, span: number): string {
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString();
  const decimals = span >= 20 ? 1 : span >= 2 ? 2 : span >= 0.2 ? 2 : 3;
  return v.toFixed(decimals);
}

// ---- CSS gradient string for the legend swatch (matches the shader ramp) -----
// Emits every stop at its own position, so a recentred ramp's neutral sits at
// the same place in the swatch as it does on the map.
export function rampCss(def: LayerDef): string {
  const parts = def.ramp.map(
    ([p, c]) =>
      `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}) ${(p * 100).toFixed(2)}%`,
  );
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

// ---- shader module factory ---------------------------------------------------
// One module per layer, colors + domain baked in (like CategoricalColormap bakes
// class colors) so we avoid std140 vec3-uniform alignment pitfalls. `color.r` is
// the sampled float value (band 1); `color.g` is band 2 (p-value) for trends.
export function makeContinuousModule(def: LayerDef) {
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

  // Walk the stops in order, each mix() clamped to its own segment: below the
  // segment the factor is 0 (keeps what came before), above it 1 (fully this
  // stop's colour). For three evenly spaced stops this reduces exactly to the
  // old two-segment mix, so the six original layers are unchanged.
  const [, first] = def.ramp[0];
  const rampGlsl = def.ramp
    .slice(1)
    .map(([p, c], i) => {
      const p0 = def.ramp[i][0];
      const span = Math.max(p - p0, 1e-6);
      return `        rgb = mix(rgb, ${v3(c)}, clamp((t - ${p0.toFixed(6)}) / ${span.toFixed(6)}, 0.0, 1.0));`;
    })
    .join("\n");

  return {
    name: `continuous_${def.id}`,
    fs: "",
    inject: {
      "fs:DECKGL_FILTER_COLOR": /* glsl */ `
        float v = color.r;
        if (${discard}) discard;
        float t = clamp((v - ${vmin.toFixed(6)}) / (${(vmax - vmin).toFixed(6)}), 0.0, 1.0);
        vec3 rgb = ${v3(first)};
${rampGlsl}
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
