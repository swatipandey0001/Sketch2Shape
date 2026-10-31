import type {
  CompiledReconstructionSpec,
  DesignHints,
  IntentLockRecord,
  SketchAnalysisResult,
} from '../types/studio';

const COLOUR_SWATCH_LEXICON: Array<{ pattern: RegExp; hex: string }> = [
  { pattern: /\b(walnut|mahogany|espresso|rosewood|dark\s*wood|chestnut)\b/i, hex: '#6b4423' },
  { pattern: /\b(oak|teak|birch|ash|maple|bamboo|plywood|beech|pine|natural\s*wood)\b/i, hex: '#b58858' },
  { pattern: /\b(terracotta|rust|clay|burnt\s*orange|sienna|brick)\b/i, hex: '#c26343' },
  { pattern: /\b(cobalt|royal\s*blue|sapphire|ultramarine|indigo)\b/i, hex: '#1e40af' },
  { pattern: /\b(navy|midnight\s*blue|deep\s*blue)\b/i, hex: '#1e293b' },
  { pattern: /\b(sky\s*blue|cerulean|azure|cyan|teal|turquoise)\b/i, hex: '#0284c7' },
  { pattern: /\b(emerald|forest\s*green|jade|moss|olive|sage)\b/i, hex: '#2f6f55' },
  { pattern: /\b(crimson|burgundy|ruby|scarlet|cherry|red|maroon)\b/i, hex: '#991b1b' },
  { pattern: /\b(brass|gold|gilded|champagne|amber|ochre|mustard)\b/i, hex: '#c59b49' },
  { pattern: /\b(copper|bronze)\b/i, hex: '#a8643e' },
  { pattern: /\b(chrome|silver|stainless|aluminum|aluminium|titanium|platinum|steel)\b/i, hex: '#94a3b8' },
  { pattern: /\b(charcoal|graphite|anthracite|obsidian|matte\s*black|ebony|black)\b/i, hex: '#27303f' },
  { pattern: /\b(sand|oat|cream|ivory|linen|beige|ecru|off[-\s]*white|parchment|boucl[eé])\b/i, hex: '#e5dfd3' },
  { pattern: /\b(white|porcelain|alabaster|chalk|snow|milk)\b/i, hex: '#f1f5f9' },
  { pattern: /\b(slate|concrete|stone|cement|pewter|grey|gray)\b/i, hex: '#64748b' },
];

function resolveHexColors(textSources: string[]): { primaryHex: string; secondaryHex: string } {
  const combined = textSources.filter(Boolean).join(' | ');

  // 1. Check explicit hex color codes if user typed #RRGGBB
  const hexMatches = combined.match(/#[0-9a-fA-F]{6}\b/g);
  if (hexMatches && hexMatches.length >= 2) {
    return { primaryHex: hexMatches[0].toLowerCase(), secondaryHex: hexMatches[1].toLowerCase() };
  }

  const hits: string[] = hexMatches ? [hexMatches[0].toLowerCase()] : [];
  for (const entry of COLOUR_SWATCH_LEXICON) {
    if (entry.pattern.test(combined) && !hits.includes(entry.hex)) {
      hits.push(entry.hex);
      if (hits.length >= 2) break;
    }
  }

  if (hits.length === 0) {
    return { primaryHex: '#8b7355', secondaryHex: '#cbd5e1' };
  }
  if (hits.length === 1) {
    return {
      primaryHex: hits[0],
      secondaryHex: hits[0] === '#e5dfd3' ? '#64748b' : '#e5dfd3',
    };
  }
  return { primaryHex: hits[0], secondaryHex: hits[1] };
}

function resolvePbrSurface(materialCorpus: string): {
  roughness: number;
  metalness: number;
  clearcoat: number;
  opacity: number;
} {
  if (/\b(glass|crystal|acrylic|translucent|transparent|borosilicate)\b/i.test(materialCorpus)) {
    return { roughness: 0.09, metalness: 0.04, clearcoat: 0.9, opacity: 0.62 };
  }
  if (/\b(chrome|mirror|polished\s*(steel|metal|brass|gold|silver))\b/i.test(materialCorpus)) {
    return { roughness: 0.14, metalness: 0.92, clearcoat: 0.4, opacity: 1.0 };
  }
  if (/\b(brass|steel|aluminum|aluminium|titanium|copper|bronze|iron|metal|anodized)\b/i.test(materialCorpus)) {
    return { roughness: 0.28, metalness: 0.82, clearcoat: 0.2, opacity: 1.0 };
  }
  if (/\b(glossy|glazed|porcelain|enamel|lacquer|resin|polished)\b/i.test(materialCorpus)) {
    return { roughness: 0.2, metalness: 0.06, clearcoat: 0.82, opacity: 1.0 };
  }
  if (/\b(satin|semi[-\s]*matte|stoneware|ceramic|terracotta)\b/i.test(materialCorpus)) {
    return { roughness: 0.48, metalness: 0.05, clearcoat: 0.28, opacity: 1.0 };
  }
  if (/\b(walnut|oak|teak|wood|plywood|timber|bamboo|birch|ash|maple)\b/i.test(materialCorpus)) {
    return { roughness: 0.52, metalness: 0.06, clearcoat: 0.18, opacity: 1.0 };
  }
  if (/\b(fabric|boucl[eé]|linen|cotton|wool|felt|velvet|suede|matte|concrete|plaster|clay)\b/i.test(materialCorpus)) {
    return { roughness: 0.84, metalness: 0.02, clearcoat: 0.0, opacity: 1.0 };
  }
  return { roughness: 0.46, metalness: 0.12, clearcoat: 0.15, opacity: 1.0 };
}

/**
 * Deterministically compiles user hints, Gemini multimodal analysis, and locked IntentLock
 * decisions into a concrete 3D reconstruction & PBR preview specification.
 */
export function compileIntentReconstructionSpec(
  hints: DesignHints,
  analysis: SketchAnalysisResult,
  intentLock: IntentLockRecord | null
): CompiledReconstructionSpec {
  const objectName = (hints.objectType || analysis.object_name || 'Sketch Object').trim();
  const primaryMaterial = (
    hints.material ||
    analysis.material_preferences?.primary_material ||
    'Matte industrial polymer'
  ).trim();
  const secondaryMaterial = (
    analysis.material_preferences?.secondary_material || 'Brushed metallic accent'
  ).trim();
  const colourPalette = (
    hints.colour ||
    analysis.material_preferences?.colour_palette ||
    'Warm neutral studio palette'
  ).trim();
  const surfaceFinish = (
    hints.style ||
    analysis.material_preferences?.surface_finish ||
    'Satin architectural finish'
  ).trim();

  const decisions = intentLock?.decisions ?? [];
  const decisionSummary = decisions.map((d) => `${d.featureName}: ${d.finalValue}`);
  const confirmedOverridesCount = decisions.filter((d) => d.wasCorrected).length;

  const intentText = [
    ...decisions.map((d) => `${d.featureName} ${d.finalValue}`),
    intentLock?.additionalNotes || '',
  ]
    .filter(Boolean)
    .join(' | ');

  const fullMaterialCorpus = [
    hints.colour,
    hints.material,
    hints.style,
    intentText,
    analysis.material_preferences?.colour_palette,
    analysis.material_preferences?.primary_material,
    analysis.material_preferences?.secondary_material,
    analysis.material_preferences?.surface_finish,
  ]
    .filter(Boolean)
    .join(' | ');

  // Prioritize explicit user hints & IntentLock notes first when picking colors
  const { primaryHex, secondaryHex } = resolveHexColors([
    hints.colour,
    intentText,
    hints.material,
    analysis.material_preferences?.colour_palette || '',
    analysis.material_preferences?.primary_material || '',
    analysis.material_preferences?.secondary_material || '',
  ]);

  const pbr = resolvePbrSurface(fullMaterialCorpus);

  // Structural Depth Ratio resolved from proportions + IntentLock overrides
  let depthRatio = 0.42;
  const depthCorpus = `${objectName} | ${analysis.proportions_description || ''} | ${intentText}`;
  if (/\b(wafer|flat\s*panel|sheet|thin\s*plate|blade|coin|placard|shallow|slim\s*profile)\b/i.test(intentText)) {
    depthRatio = 0.16;
  } else if (/\b(deep|thick|cubic|blocky|chunky|plush\s*lounge|wide\s*seat|equal\s*depth|1\s*:\s*1)\b/i.test(intentText)) {
    depthRatio = 0.72;
  } else if (/\b(chair|armchair|lounge|table|desk|stool|cabinet|box|chest|cube)\b/i.test(depthCorpus)) {
    depthRatio = 0.58;
  } else if (/\b(thin|flat|panel|frame|sign|bracket|knife|wrench)\b/i.test(depthCorpus)) {
    depthRatio = 0.22;
  }

  // Hollow vessel vs solid top (critical for mugs, cups, bowls, vases, planters)
  let isHollowVessel = /\b(mug|cup|tumbler|goblet|bowl|vase|pitcher|carafe|planter|jar|beaker)\b/i.test(
    objectName
  );
  if (/\b(solid\s*(core|block|top|sealed|closed\s*lid|capped))\b/i.test(intentText)) {
    isHollowVessel = false;
  } else if (/\b(hollow|open\s*(top|cavity|interior|vessel|rim)|concave\s*interior)\b/i.test(intentText)) {
    isHollowVessel = true;
  }

  // Rotational vs extrusion override from IntentLock
  let symmetryOverride: CompiledReconstructionSpec['symmetryOverride'] = 'auto';
  if (/\b(rotational|lathe|cylindrical\s*revolution|turned\s*vessel|axially\s*symmetric|round\s*profile)\b/i.test(intentText)) {
    symmetryOverride = 'rotational';
  } else if (/\b(extrud(e|ed)|prismatic|rectangular\s*cross|square\s*profile|faceted\s*slab|flat\s*extrusion)\b/i.test(intentText)) {
    symmetryOverride = 'extrusion';
  }

  // Support / leg topology resolved from IntentLock (e.g., 4 legs vs 3-leg tripod vs pedestal vs solid)
  let supportTopology: CompiledReconstructionSpec['supportTopology'] = 'auto';
  if (/\b(3[-\s]*leg|three[-\s]*leg|tripod)\b/i.test(intentText)) {
    supportTopology = 'three_leg_tripod';
  } else if (/\b(pedestal|central\s*(column|base|stem|plinth)|monolith\s*base|single\s*pedestal)\b/i.test(intentText)) {
    supportTopology = 'pedestal_base';
  } else if (/\b(4[-\s]*leg|four[-\s]*leg|symmetric\s*rear\s*leg|quad\s*leg|splayed\s*legs)\b/i.test(intentText)) {
    supportTopology = 'four_leg_frame';
  } else if (/\b(solid\s*extrusion|continuous\s*slab|no\s*separate\s*legs)\b/i.test(intentText)) {
    supportTopology = 'solid_extrusion';
  }

  return {
    objectName,
    primaryMaterial,
    secondaryMaterial,
    colourPalette,
    surfaceFinish,
    primaryHex,
    secondaryHex,
    roughness: pbr.roughness,
    metalness: pbr.metalness,
    clearcoat: pbr.clearcoat,
    opacity: pbr.opacity,
    depthRatio,
    isHollowVessel,
    symmetryOverride,
    supportTopology,
    confirmedOverridesCount,
    decisionSummary,
  };
}
