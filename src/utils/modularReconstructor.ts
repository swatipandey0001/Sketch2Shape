import type {
  DesignHints,
  IntentLockRecord,
  ReconstructionOptionConcept,
  ReconstructionOptionId,
  SketchAnalysisResult,
  StructuralBlueprint,
  SupportedObjectCategory,
  SynthesizedOptionPreview,
} from '../types/studio';
import type { RawPreprocessResult } from './sketchPreprocessor';
import { compileIntentReconstructionSpec } from './intentCompiler';
import {
  disposeObject3D,
  exportObjectToGlbBuffer,
  validateAndParseGlbBuffer,
} from './glbValidator';
import { buildChairModel, type BuiltCategoryModel } from './builders/chairBuilder';
import { buildTableModel } from './builders/tableBuilder';
import { buildVesselModel } from './builders/vesselBuilder';
import { buildLampModel } from './builders/lampBuilder';
import { buildShelfModel } from './builders/shelfBuilder';
import { buildBracketModel } from './builders/bracketBuilder';

export const MODULAR_PROVENANCE_PREFIX =
  'Local Modular Component 3D Synthesis (Deterministic Structural Builder — Not Neural Image-to-3D)';

export const CATEGORY_LABELS: Record<SupportedObjectCategory, string> = {
  chair: 'Chair & Seating Architecture',
  table: 'Table & Desk Frame Architecture',
  mug_vessel: 'Rotational Vessel & Handle Architecture',
  lamp: 'Lighting Stem, Harp & Hollow Shade',
  shelf_cabinet: 'Multi-Tier Uprights & Shelf Joinery',
  bracket_mechanical: 'Machined Multi-Contour CAD Plate & Bosses',
  unsupported: 'Unsupported Freeform / Organic Subject',
};

const UNSUPPORTED_ORGANIC_REGEX =
  /\b(dog|cat|puppy|kitten|horse|animal|bird|eagle|owl|fish|shark|whale|dolphin|dragon|dinosaur|monster|creature|human|person|man|woman|boy|girl|portrait|face|head|skull|hand|foot|character|avatar|tree|flower|rose|plant|leaf|foliage|forest|mountain|landscape|cloud|car|sedan|suv|automobile|truck|bus|motorcycle|motorbike|bicycle|bike|airplane|aircraft|helicopter|boat|ship|sneaker|shoe|boot|clothing|shirt|jacket|dress|plush|teddy|statue|figurine|bust)\b/i;

export interface ResolvedCategoryBlueprint {
  category: SupportedObjectCategory;
  supported: boolean;
  unsupportedReason?: string;
  blueprint: StructuralBlueprint;
  options: ReconstructionOptionConcept[];
}

function buildCategoryDefaultOptions(
  category: SupportedObjectCategory,
  supported: boolean,
  unsupportedReason: string | undefined,
  objectName: string,
  blueprint: StructuralBlueprint,
  uncertainCount: number
): ReconstructionOptionConcept[] {
  const penalty = Math.min(20, uncertainCount * 4);
  const scoreA = supported ? Math.max(76, 93 - penalty) : 0;
  const scoreB = supported ? Math.max(70, 87 - penalty) : 0;
  const scoreC = supported ? Math.max(64, 80 - penalty) : 0;

  const toLevel = (s: number): 'high' | 'moderate' | 'limited' =>
    s >= 82 ? 'high' : s >= 68 ? 'moderate' : 'limited';

  if (!supported || category === 'unsupported') {
    const reason =
      unsupportedReason ||
      `"${objectName}" requires high-genus organic or freeform neural surface reconstruction outside the supported deterministic structural categories (chairs, tables, vessels/mugs, lamps, shelves/cabinets, mechanical brackets).`;
    return [
      {
        id: 'sketch_faithful',
        code: 'OPTION A',
        name: 'Sketch Faithful',
        tagline: 'Local structural preview unavailable for organic/freeform subjects',
        explanation: reason,
        inferred_changes: ['No fabricated blocky mesh substituted — category honestly flagged'],
        confidence_score: 0,
        confidence_level: 'limited',
        confidence_rationale: 'Subject falls outside parametric structural furniture/vessel/CAD classes.',
        supported: false,
        unsupported_reason: reason,
      },
      {
        id: 'structurally_refined',
        code: 'OPTION B',
        name: 'Structurally Refined',
        tagline: 'Local structural preview unavailable for organic/freeform subjects',
        explanation: reason,
        inferred_changes: ['Requires cloud neural image-to-3D (Tripo v3) for freeform topology'],
        confidence_score: 0,
        confidence_level: 'limited',
        confidence_rationale: 'Subject falls outside parametric structural furniture/vessel/CAD classes.',
        supported: false,
        unsupported_reason: reason,
      },
      {
        id: 'design_enhanced',
        code: 'OPTION C',
        name: 'Design Enhanced',
        tagline: 'Local structural preview unavailable for organic/freeform subjects',
        explanation: reason,
        inferred_changes: ['Requires cloud neural image-to-3D (Tripo v3) for freeform topology'],
        confidence_score: 0,
        confidence_level: 'limited',
        confidence_rationale: 'Subject falls outside parametric structural furniture/vessel/CAD classes.',
        supported: false,
        unsupported_reason: reason,
      },
    ];
  }

  const categoryChanges: Record<
    Exclude<SupportedObjectCategory, 'unsupported'>,
    { a: string[]; b: string[]; c: string[] }
  > = {
    chair: {
      a: [
        `Decomposes sketch into separate 3D seat pan, ${blueprint.has_backrest ? `${blueprint.backrest_style.replace(/_/g, ' ')} backrest at rear (-Z)` : 'backless stool top'}, and grounded ${blueprint.leg_style.replace(/_/g, ' ')}`,
        blueprint.has_armrests
          ? 'Includes side armrests strictly because armrest strokes were observed or confirmed'
          : 'Omits armrests so unrequested geometry is never invented',
        'Keeps crisp low-bevel surfaces faithful to drawn silhouette proportions',
      ],
      b: [
        `Completes symmetric ${blueprint.inferred_total_leg_count}-point support geometry in 3D depth with recessed under-seat structural apron rails`,
        'Adds H-stretcher cross-bracing between front and rear legs for realistic load stability',
        blueprint.has_backrest
          ? 'Anchors tilted backrest stiles directly into rear seat frame with zero floating gaps'
          : 'Reinforces under-seat collar joinery across all support legs',
      ],
      c: [
        'Upgrades seat pan to a contoured ergonomic waterfall front cushion with multi-step edge bevels',
        blueprint.has_backrest
          ? 'Sculpts backrest into a gently curved 3D lumbar-wrapping shell'
          : 'Profiles stool seat with sculpted perimeter bevel and recessed shadow reveal',
        'Tapers leg silhouettes and adds turned metallic foot ferrules & floor glides',
      ],
    },
    table: {
      a: [
        `Builds separate horizontal ${blueprint.seat_or_top_shape.replace(/_/g, ' ')} tabletop slab and ${blueprint.leg_style.replace(/_/g, ' ')}`,
        'Matches measured sketch width-to-height aspect ratio with minimal edge beveling',
        'Avoids unrequested lower shelves or decorative turnings',
      ],
      b: [
        'Adds recessed perimeter under-tabletop structural apron frame rigidly anchoring every leg',
        'Infers lower lateral & central trestle cross-stretchers for structural rigidity',
        'Applies balanced leg splay and protective floor glides at Y = 0',
      ],
      c: [
        'Chamfers tabletop perimeter with a multi-segment studio bevel and recessed shadow reveal',
        'Tapers structural legs with calibrated frame-to-top PBR material contrast',
        'Adds precision metallic foot ferrules at ground contact points',
      ],
    },
    mug_vessel: {
      a: [
        'Revolves 360° vessel body directly from measured 2D scanline radii (32 radial segments)',
        blueprint.is_hollow_open_top
          ? 'Carves open interior vessel cavity rather than sealing the top flat'
          : 'Preserves closed top profile per sketch / IntentLock specification',
        blueprint.has_side_handle
          ? `Sweeps 3D C-loop handle on the ${blueprint.handle_side === 'left' ? 'left' : 'right'} side matching drawn appendage bounds`
          : 'Maintains pure rotational symmetry without adding an unrequested handle',
      ],
      b: [
        'Refines rotational lathe density (48 segments) with uniform wall thickness and recessed ceramic foot ring',
        blueprint.has_side_handle
          ? 'Anchors swept 3D handle into outer vessel wall with upper & lower weld bosses'
          : 'Reinforces base foot ring and upper lip wall thickness',
        'Eliminates raw pixel-staircase jitter along vertical vessel contour',
      ],
      c: [
        'Upgrades vessel to 64-segment studio curvature with rolled glazed lip torus',
        blueprint.has_side_handle
          ? 'Contours ergonomic thumb-rest handle curve with flared transition collars'
          : 'Adds subtle shoulder-to-foot ceramic glaze transition & articulated foot ring',
        'Applies calibrated dual-finish interior/exterior PBR roughness contrast',
      ],
    },
    lamp: {
      a: [
        `Builds weighted turned base, central vertical stem, and hollow ${blueprint.shade_profile !== 'none' ? blueprint.shade_profile : 'conical'} diffuser shade`,
        'Connects shade to central stem via minimal 3-strut spider hub (no floating shade)',
        'Matches measured shade-to-base height & width ratios from sketch scanlines',
      ],
      b: [
        'Adds explicit bulb socket housing, frosted diffuser bulb, neck collar, and 3-strut structural harp',
        'Constructs double-walled hollow shade geometry with realistic inner/outer wall thickness',
        'Grounds weighted base cleanly with balanced center-of-gravity diameter',
      ],
      c: [
        'Upgrades base and shade to 64-segment smooth lathe curvature with rolled metallic rim trim',
        'Adds top harp riser and turned brass finial cap above the diffuser shade',
        'Applies warm emissive frosted bulb glow and brushed hardware accents',
      ],
    },
    shelf_cabinet: {
      a: [
        'Constructs separate left/right vertical side uprights, top/bottom decks, and horizontal shelf tiers aligned to drawn strokes',
        'Maintains open front/back compartments rather than filling the silhouette into a solid block',
        'Grounds unit cleanly on measured base plinth or corner feet',
      ],
      b: [
        'Adds under-shelf side support cleats at every horizontal shelf joint',
        'Installs rear diagonal anti-racking X-cross brace rods anchored to rear uprights',
        'Normalizes panel thicknesses and flush structural joinery',
      ],
      c: [
        'Adds sculpted bullnose front edge profiles along vertical stiles and overhanging crown top',
        'Bevels horizontal shelf tiers with multi-step architectural chamfers',
        'Includes rear header valence rail and metallic cross-brace hardware',
      ],
    },
    bracket_mechanical: {
      a: [
        'Extrudes exact traced outer contours and all enclosed interior bolt/cutout holes',
        'Applies crisp 1-step deburred mechanical edge bevel faithful to 2D CAD profile',
        'Preserves exact hole positions and relative plate aspect ratio',
      ],
      b: [
        'Adds raised cylindrical machined mounting bosses around interior bolt holes',
        'Integrates perpendicular base mounting flange and central triangular stiffener gusset rib',
        'Reinforces plate thickness for structural load-bearing plausibility',
      ],
      c: [
        'Upgrades plate and hole collars with 4-segment CNC precision chamfers',
        'Adds dual symmetric outer gusset ribs and stepped counterbore hole bosses',
        'Applies brushed metallic frame vs anodized plate PBR surface differentiation',
      ],
    },
  };

  const c = categoryChanges[category];

  return [
    {
      id: 'sketch_faithful',
      code: 'OPTION A',
      name: 'Sketch Faithful',
      tagline: 'Preserves drawn silhouette, proportions & strictly observed components',
      explanation: `Prioritizes direct geometric fidelity to your "${objectName}" sketch using minimal hidden-surface assumptions while decomposing parts in 3D.`,
      inferred_changes: c.a,
      confidence_score: scoreA,
      confidence_level: toLevel(scoreA),
      confidence_rationale:
        'Highest direct visual evidence: relies directly on measured 2D bounding proportions and observed strokes.',
      supported: true,
    },
    {
      id: 'structurally_refined',
      code: 'OPTION B',
      name: 'Structurally Refined',
      tagline: 'Complete 3D structural components, joinery rails & occluded supports',
      explanation: `Reconstructs "${objectName}" as a physically self-supporting 3D assembly with inferred occluded supports, aprons, and rigid component joinery.`,
      inferred_changes: c.b,
      confidence_score: scoreB,
      confidence_level: toLevel(scoreB),
      confidence_rationale:
        'High structural plausibility: occluded supports and joinery inferred from symmetry and category mechanics.',
      supported: true,
    },
    {
      id: 'design_enhanced',
      code: 'OPTION C',
      name: 'Design Enhanced',
      tagline: 'Ergonomic curvature, multi-step chamfers & calibrated studio finish',
      explanation: `Preserves the core identity of "${objectName}" while refining surface transitions, ergonomic contours, and hardware detailing.`,
      inferred_changes: c.c,
      confidence_score: scoreC,
      confidence_level: toLevel(scoreC),
      confidence_rationale:
        'Moderate-high confidence: surface bevels, ergonomic contours, and ferrule accents refine finish beyond raw 2D linework.',
      supported: true,
    },
  ];
}

/**
 * Resolves the canonical 3D object category, structural blueprint, and 3 option descriptions
 * from Gemini's vision analysis, CV preprocessing metrics, user hints, and IntentLock overrides.
 */
export function resolveCategoryAndBlueprint(
  analysis: SketchAnalysisResult,
  hints: DesignHints,
  prep: RawPreprocessResult,
  intentLock: IntentLockRecord | null
): ResolvedCategoryBlueprint {
  const objectLabel = `${hints.objectType || ''} ${analysis.object_name || ''}`.trim();
  const intentNotes = [
    ...(intentLock?.decisions.map((d) => `${d.featureName} ${d.finalValue}`) ?? []),
    intentLock?.additionalNotes || '',
  ]
    .filter(Boolean)
    .join(' | ');

  const fullCorpus = [
    objectLabel,
    ...(analysis.visible_components || []),
    ...(analysis.observed_features || []),
    hints.style || '',
    intentNotes,
  ]
    .filter(Boolean)
    .join(' | ');

  // 1. Determine category (honestly flagging unsupported organic/freeform subjects)
  let category: SupportedObjectCategory = analysis.object_category || 'unsupported';
  let unsupportedReason = analysis.unsupported_reason;

  if (UNSUPPORTED_ORGANIC_REGEX.test(objectLabel)) {
    category = 'unsupported';
    unsupportedReason =
      unsupportedReason ||
      `"${analysis.object_name || hints.objectType || 'This subject'}" is an organic, freeform, or vehicle form that cannot be accurately represented by deterministic structural component synthesis without misleading blocky artifacts. Configure TRIPO_API_KEY for neural image-to-3D generation, or sketch a supported structural object (chair, table, mug/vessel, lamp, bookshelf/cabinet, or mechanical bracket).`;
  } else if (!analysis.object_category) {
    // Deterministic classification when processing legacy 8-field SketchAnalysisResult payloads
    if (/\b(chair|armchair|stool|seat|bench|throne|recliner|rocker)\b/i.test(fullCorpus)) {
      category = 'chair';
    } else if (/\b(table|desk|workbench|nightstand|console\s*table|coffee\s*table)\b/i.test(fullCorpus)) {
      category = 'table';
    } else if (/\b(lamp|lantern|sconce|chandelier|light\s*fixture|lampshade)\b/i.test(fullCorpus)) {
      category = 'lamp';
    } else if (
      /\b(mug|cup|tumbler|goblet|chalice|vase|pitcher|jug|carafe|bottle|bowl|jar|pot|vessel|planter|urn)\b/i.test(
        fullCorpus
      )
    ) {
      category = 'mug_vessel';
    } else if (/\b(shelf|bookshelf|bookcase|rack|cabinet|wardrobe|dresser|cupboard|cubby)\b/i.test(fullCorpus)) {
      category = 'shelf_cabinet';
    } else if (
      /\b(bracket|plate|flange|gear|washer|wrench|spanner|hinge|clamp|gusset|mount|adapter|block|widget)\b/i.test(
        fullCorpus
      )
    ) {
      category = 'bracket_mechanical';
    } else if (prep.metrics.rotationalProfileSuitable) {
      category = 'mug_vessel';
    } else {
      category = 'unsupported';
      unsupportedReason = `"${analysis.object_name || hints.objectType || 'Unclassified sketch'}" does not match a verified local structural builder category (chair, table, mug/vessel, lamp, shelf/cabinet, or mechanical bracket).`;
    }
  }

  const supported =
    category !== 'unsupported' &&
    analysis.category_supported !== false &&
    prep.metrics.hasForeground;

  if (!prep.metrics.hasForeground) {
    category = 'unsupported';
    unsupportedReason =
      'Blank or near-empty canvas detected: draw or upload visible foreground sketch strokes before 3D reconstruction.';
  }

  // 2. Construct & merge StructuralBlueprint with CV metrics + IntentLock user overrides
  const baseBp = analysis.structural_blueprint;
  const aspect = prep.metrics.measuredAspectRatio || 0.78;

  const blueprint: StructuralBlueprint = {
    viewpoint: baseBp?.viewpoint || 'three_quarter',
    width_to_height_ratio: baseBp?.width_to_height_ratio ?? Math.max(0.32, Math.min(2.2, aspect)),
    depth_to_width_ratio:
      baseBp?.depth_to_width_ratio ??
      (category === 'chair'
        ? 0.92
        : category === 'table'
          ? 0.68
          : category === 'shelf_cabinet'
            ? 0.42
            : category === 'bracket_mechanical'
              ? 0.28
              : 1.0),
    has_backrest:
      baseBp?.has_backrest ??
      (category === 'chair' && !/\b(stool|ottoman|backless)\b/i.test(fullCorpus)),
    backrest_style:
      baseBp?.backrest_style ??
      (category === 'chair'
        ? /\b(slat|spindle|bars)\b/i.test(fullCorpus)
          ? 'slatted_vertical'
          : /\b(ladder|horizontal\s*rail)\b/i.test(fullCorpus)
            ? 'slatted_horizontal'
            : /\b(open\s*frame|floating\s*back)\b/i.test(fullCorpus)
              ? 'open_frame'
              : 'solid_shell'
        : 'none'),
    backrest_tilt_deg: baseBp?.backrest_tilt_deg ?? (category === 'chair' ? 8 : 0),
    seat_or_top_height_ratio:
      baseBp?.seat_or_top_height_ratio ??
      (category === 'chair'
        ? /\b(stool|barstool)\b/i.test(fullCorpus)
          ? 0.68
          : 0.47
        : category === 'table'
          ? 0.92
          : 0.5),
    seat_or_top_shape:
      baseBp?.seat_or_top_shape ??
      (/\b(round|circular|disc)\b/i.test(fullCorpus)
        ? 'circular'
        : /\b(oval|elliptical)\b/i.test(fullCorpus)
          ? 'oval'
          : 'rounded_rect'),
    has_armrests:
      baseBp?.has_armrests ??
      /\b(armchair|armrest|arms|lounge\s*chair\s*with\s*arms)\b/i.test(fullCorpus),
    visible_leg_count:
      baseBp?.visible_leg_count ??
      (category === 'chair' || category === 'table'
        ? Math.max(2, prep.metrics.detectedLowerColumnCount || 2)
        : 0),
    inferred_total_leg_count:
      baseBp?.inferred_total_leg_count ??
      (category === 'chair' || category === 'table' ? 4 : 0),
    leg_style:
      baseBp?.leg_style ??
      (category === 'chair' || category === 'table'
        ? /\b(splay|angled|tapered\s*mid[-\s]*century)\b/i.test(fullCorpus)
          ? 'four_legs_splayed'
          : /\b(tripod|three[-\s]*leg|3[-\s]*leg)\b/i.test(fullCorpus)
            ? 'three_leg_tripod'
            : /\b(pedestal|tulip|central\s*column)\b/i.test(fullCorpus)
              ? 'central_pedestal'
              : /\b(sled|runner)\b/i.test(fullCorpus)
                ? 'sled_runners'
                : /\b(cantilever)\b/i.test(fullCorpus)
                  ? 'cantilever'
                  : 'four_legs_straight'
        : category === 'shelf_cabinet'
          ? prep.metrics.hasBottomLegGap
            ? 'four_legs_straight'
            : 'plinth_base'
          : 'none'),
    has_stretchers_or_apron:
      baseBp?.has_stretchers_or_apron ??
      /\b(stretcher|crossbar|rung|apron|rail|brace)\b/i.test(fullCorpus),
    has_side_handle:
      baseBp?.has_side_handle ??
      (category === 'mug_vessel' &&
        (prep.metrics.unilateralAppendageSide !== 'none' ||
          /\b(mug|teacup|cup\s*with\s*handle|pitcher|jug|handle)\b/i.test(fullCorpus))),
    handle_side:
      baseBp?.handle_side && baseBp.handle_side !== 'none'
        ? baseBp.handle_side
        : prep.metrics.unilateralAppendageSide !== 'none'
          ? prep.metrics.unilateralAppendageSide
          : /\b(mug|pitcher|jug|handle)\b/i.test(fullCorpus)
            ? 'right'
            : 'none',
    is_hollow_open_top:
      baseBp?.is_hollow_open_top ??
      (category === 'mug_vessel' && !/\b(bottle\s*capped|sealed|solid|closed\s*lid)\b/i.test(fullCorpus)),
    shelf_tier_count:
      baseBp?.shelf_tier_count ?? (category === 'shelf_cabinet' ? 4 : 0),
    shade_profile:
      baseBp?.shade_profile && baseBp.shade_profile !== 'none'
        ? baseBp.shade_profile
        : category === 'lamp'
          ? /\b(drum|cylinder\s*shade)\b/i.test(fullCorpus)
            ? 'drum'
            : /\b(dome|hemisphere|mushroom)\b/i.test(fullCorpus)
              ? 'dome'
              : /\b(bell|flared)\b/i.test(fullCorpus)
                ? 'bell'
                : 'conical'
          : 'none',
  };

  // Apply explicit IntentLock user overrides so user confirmations/corrections directly alter 3D geometry
  if (intentNotes) {
    if (/\b(armless|no\s*armrests?|without\s*armrests?|omit\s*arms?)\b/i.test(intentNotes)) {
      blueprint.has_armrests = false;
    } else if (/\b(with\s*armrests?|include\s*armrests?|add\s*armrests?|loop\s*arms?)\b/i.test(intentNotes)) {
      blueprint.has_armrests = true;
    }

    if (/\b(backless|no\s*backrest|stool\s*only|omit\s*backrest)\b/i.test(intentNotes)) {
      blueprint.has_backrest = false;
      blueprint.backrest_style = 'none';
    } else if (/\b(vertical\s*slats?|spindle\s*back)\b/i.test(intentNotes)) {
      blueprint.has_backrest = true;
      blueprint.backrest_style = 'slatted_vertical';
    } else if (/\b(horizontal\s*slats?|ladder\s*back)\b/i.test(intentNotes)) {
      blueprint.has_backrest = true;
      blueprint.backrest_style = 'slatted_horizontal';
    } else if (/\b(open\s*frame\s*back)\b/i.test(intentNotes)) {
      blueprint.has_backrest = true;
      blueprint.backrest_style = 'open_frame';
    }

    if (/\b(3[-\s]*leg|three[-\s]*leg|tripod)\b/i.test(intentNotes)) {
      blueprint.leg_style = 'three_leg_tripod';
      blueprint.inferred_total_leg_count = 3;
    } else if (/\b(pedestal|central\s*(column|stem|base)|tulip)\b/i.test(intentNotes)) {
      blueprint.leg_style = 'central_pedestal';
      blueprint.inferred_total_leg_count = 1;
    } else if (/\b(sled|runners?)\b/i.test(intentNotes)) {
      blueprint.leg_style = 'sled_runners';
      blueprint.inferred_total_leg_count = 2;
    } else if (/\b(cantilever)\b/i.test(intentNotes)) {
      blueprint.leg_style = 'cantilever';
      blueprint.inferred_total_leg_count = 2;
    } else if (/\b(splayed|angled\s*legs?)\b/i.test(intentNotes)) {
      blueprint.leg_style = 'four_legs_splayed';
      blueprint.inferred_total_leg_count = 4;
    } else if (/\b(4[-\s]*leg|four[-\s]*leg|symmetric\s*rear\s*legs?)\b/i.test(intentNotes)) {
      blueprint.leg_style = 'four_legs_straight';
      blueprint.inferred_total_leg_count = 4;
    }

    if (/\b(no\s*handle|handleless|without\s*handle)\b/i.test(intentNotes)) {
      blueprint.has_side_handle = false;
      blueprint.handle_side = 'none';
    } else if (/\b(left\s*handle)\b/i.test(intentNotes)) {
      blueprint.has_side_handle = true;
      blueprint.handle_side = 'left';
    } else if (/\b(right\s*handle|with\s*handle|side\s*handle)\b/i.test(intentNotes)) {
      blueprint.has_side_handle = true;
      blueprint.handle_side = 'right';
    }

    if (/\b(round\s*(seat|top)|circular\s*(seat|top))\b/i.test(intentNotes)) {
      blueprint.seat_or_top_shape = 'circular';
    }
    if (/\b(drum\s*shade)\b/i.test(intentNotes)) {
      blueprint.shade_profile = 'drum';
    } else if (/\b(dome\s*shade)\b/i.test(intentNotes)) {
      blueprint.shade_profile = 'dome';
    } else if (/\b(bell\s*shade)\b/i.test(intentNotes)) {
      blueprint.shade_profile = 'bell';
    }
  }

  // 3. Build or enrich the 3 ReconstructionOptionConcept items
  const defaultOptions = buildCategoryDefaultOptions(
    supported ? category : 'unsupported',
    supported,
    unsupportedReason,
    analysis.object_name || hints.objectType || 'Sketched Object',
    blueprint,
    analysis.uncertain_features?.length ?? 0
  );

  let options = defaultOptions;
  if (
    supported &&
    Array.isArray(analysis.reconstruction_options) &&
    analysis.reconstruction_options.length === 3
  ) {
    options = defaultOptions.map((defOpt) => {
      const fromGemini = analysis.reconstruction_options?.find((o) => o.id === defOpt.id);
      if (!fromGemini) return defOpt;
      // Combine Gemini's sketch-specific observations with verified builder structural changes
      const mergedChanges = Array.from(
        new Set([...(fromGemini.inferred_changes || []).slice(0, 2), ...defOpt.inferred_changes.slice(0, 2)])
      ).slice(0, 4);
      return {
        ...defOpt,
        tagline: fromGemini.tagline || defOpt.tagline,
        explanation: fromGemini.explanation || defOpt.explanation,
        inferred_changes: mergedChanges.length > 0 ? mergedChanges : defOpt.inferred_changes,
        confidence_score: fromGemini.confidence_score || defOpt.confidence_score,
        confidence_level: fromGemini.confidence_level || defOpt.confidence_level,
        confidence_rationale: fromGemini.confidence_rationale || defOpt.confidence_rationale,
        supported: true,
      };
    });
  }

  return {
    category: supported ? category : 'unsupported',
    supported,
    unsupportedReason,
    blueprint,
    options,
  };
}

function invokeCategoryBuilder(
  category: Exclude<SupportedObjectCategory, 'unsupported'>,
  prep: RawPreprocessResult,
  blueprint: StructuralBlueprint,
  spec: ReturnType<typeof compileIntentReconstructionSpec>,
  optionId: ReconstructionOptionId
): BuiltCategoryModel {
  switch (category) {
    case 'chair':
      return buildChairModel(prep, blueprint, spec, optionId);
    case 'table':
      return buildTableModel(prep, blueprint, spec, optionId);
    case 'mug_vessel':
      return buildVesselModel(prep, blueprint, spec, optionId);
    case 'lamp':
      return buildLampModel(prep, blueprint, spec, optionId);
    case 'shelf_cabinet':
      return buildShelfModel(prep, blueprint, spec, optionId);
    case 'bracket_mechanical':
      return buildBracketModel(prep, blueprint, spec, optionId);
  }
}

/**
 * Synthesizes all three distinct 3D reconstruction options (Option A, Option B, Option C)
 * from the preprocessed 2D sketch, Gemini spatial analysis, optional hints, and IntentLock state.
 * Every supported option produces a real, binary-validated .GLB ArrayBuffer with distinct 3D geometry.
 */
export async function synthesizeThreeReconstructionOptions(
  prep: RawPreprocessResult,
  analysis: SketchAnalysisResult,
  hints: DesignHints,
  intentLock: IntentLockRecord | null
): Promise<SynthesizedOptionPreview[]> {
  const resolved = resolveCategoryAndBlueprint(analysis, hints, prep, intentLock);
  const compiledSpec = compileIntentReconstructionSpec(hints, analysis, intentLock);
  const categoryLabel = CATEGORY_LABELS[resolved.category];

  if (!resolved.supported || resolved.category === 'unsupported') {
    return resolved.options.map((opt) => ({
      option: opt,
      category: 'unsupported',
      categoryLabel,
      glbBuffer: null,
      stats: null,
      componentNames: [],
      provenanceLabel: `${MODULAR_PROVENANCE_PREFIX} — Unsupported Category`,
      geometrySummary:
        opt.unsupported_reason ||
        resolved.unsupportedReason ||
        'Local deterministic structural reconstruction unavailable for this object category.',
      durationMs: 0,
      compiledSpec,
    }));
  }

  const results: SynthesizedOptionPreview[] = [];
  for (const opt of resolved.options) {
    const t0 = performance.now();
    const built = invokeCategoryBuilder(
      resolved.category,
      prep,
      resolved.blueprint,
      compiledSpec,
      opt.id
    );

    let glbBuffer: ArrayBuffer;
    try {
      glbBuffer = await exportObjectToGlbBuffer(built.group);
    } finally {
      disposeObject3D(built.group);
    }

    const validated = await validateAndParseGlbBuffer(glbBuffer);
    disposeObject3D(validated.scene);

    const durationMs = Math.max(1, Math.round(performance.now() - t0));
    results.push({
      option: opt,
      category: resolved.category,
      categoryLabel,
      glbBuffer,
      stats: validated.stats,
      componentNames: built.componentNames,
      provenanceLabel: `${opt.code} (${opt.name}) — ${categoryLabel} · ${MODULAR_PROVENANCE_PREFIX}`,
      geometrySummary: built.geometrySummary,
      durationMs,
      compiledSpec,
    });
  }

  return results;
}
