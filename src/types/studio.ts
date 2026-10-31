export type NavTab = 'dashboard' | 'studio' | 'history' | 'diagnostics' | 'docs';

export type SketchSourceMode = 'canvas' | 'upload';

export type PipelineImageChoice = 'original' | 'prepared';

export type ViewerInspectionMode = 'original' | 'user_material' | 'clay_topology';

export type ReconstructionSource =
  | 'tripo_v3'
  | 'modular_structural'
  | 'offline_contour'
  | 'restored_archive'
  | 'calibration_sample';

export type SupportedObjectCategory =
  | 'chair'
  | 'table'
  | 'mug_vessel'
  | 'lamp'
  | 'shelf_cabinet'
  | 'bracket_mechanical'
  | 'unsupported';

export type ReconstructionOptionId =
  | 'sketch_faithful'
  | 'structurally_refined'
  | 'design_enhanced';

export interface DesignHints {
  objectType: string;
  material: string;
  colour: string;
  style: string;
}

export interface UncertainFeatureItem {
  id: string;
  feature_name: string;
  uncertainty_reason: string;
  options: string[];
  default_assumption: string;
  importance: 'critical' | 'moderate';
}

export interface MaterialPreferencesAnalysis {
  primary_material: string;
  secondary_material: string;
  colour_palette: string;
  surface_finish: string;
  source_note: string;
}

export interface StructuralBlueprint {
  viewpoint: 'front' | 'side' | 'three_quarter' | 'top_angled' | 'orthographic';
  width_to_height_ratio: number;
  depth_to_width_ratio: number;
  has_backrest: boolean;
  backrest_style:
    | 'solid_shell'
    | 'slatted_vertical'
    | 'slatted_horizontal'
    | 'open_frame'
    | 'none';
  backrest_tilt_deg: number;
  seat_or_top_height_ratio: number;
  seat_or_top_shape: 'rectangular' | 'rounded_rect' | 'circular' | 'oval' | 'contoured';
  has_armrests: boolean;
  visible_leg_count: number;
  inferred_total_leg_count: number;
  leg_style:
    | 'four_legs_straight'
    | 'four_legs_splayed'
    | 'three_leg_tripod'
    | 'central_pedestal'
    | 'sled_runners'
    | 'cantilever'
    | 'plinth_base'
    | 'none';
  has_stretchers_or_apron: boolean;
  has_side_handle: boolean;
  handle_side: 'left' | 'right' | 'both' | 'none';
  is_hollow_open_top: boolean;
  shelf_tier_count: number;
  shade_profile: 'conical' | 'drum' | 'dome' | 'bell' | 'none';
}

export interface ReconstructionOptionConcept {
  id: ReconstructionOptionId;
  code: 'OPTION A' | 'OPTION B' | 'OPTION C';
  name: 'Sketch Faithful' | 'Structurally Refined' | 'Design Enhanced';
  tagline: string;
  explanation: string;
  inferred_changes: string[];
  confidence_score: number;
  confidence_level: 'high' | 'moderate' | 'limited';
  confidence_rationale: string;
  supported: boolean;
  unsupported_reason?: string;
}

/**
 * Structured output returned by Gemini multimodal vision sketch analysis.
 * Preserves the exact 8 mandatory fields while providing category & three-option spatial blueprints.
 */
export interface SketchAnalysisResult {
  object_name: string;
  visible_components: string[];
  observed_features: string[];
  uncertain_features: UncertainFeatureItem[];
  inferred_features: string[];
  proportions_description: string;
  material_preferences: MaterialPreferencesAnalysis;
  reconstruction_notes: string;
  object_category?: SupportedObjectCategory;
  category_supported?: boolean;
  unsupported_reason?: string;
  structural_blueprint?: StructuralBlueprint;
  reconstruction_options?: ReconstructionOptionConcept[];
}

export interface SynthesizedOptionPreview {
  option: ReconstructionOptionConcept;
  category: SupportedObjectCategory;
  categoryLabel: string;
  glbBuffer: ArrayBuffer | null;
  stats: ValidatedMeshStats | null;
  componentNames: string[];
  provenanceLabel: string;
  geometrySummary: string;
  durationMs: number;
  compiledSpec: CompiledReconstructionSpec;
}

export interface IntentLockDecision {
  uncertaintyId: string;
  featureName: string;
  selectedOption: string;
  customCorrection: string;
  finalValue: string;
  wasCorrected: boolean;
}

export interface IntentLockRecord {
  locked: boolean;
  lockedAt: string;
  decisions: IntentLockDecision[];
  additionalNotes: string;
  originalSketchSha256: string;
}

export interface SketchPreprocessOptions {
  illuminationCorrection: boolean;
  contrastNormalization: boolean;
  squareSize?: number;
}

export interface ContourPolygon2D {
  /** Normalized coordinates in [0..1] within the tight foreground bounding box */
  points: Array<[number, number]>;
  /** Signed pixel area magnitude */
  areaPx: number;
  /** Hole polygons enclosed inside this outer contour (normalized [0..1] in bbox) */
  holes: Array<Array<[number, number]>>;
  /** Bounding box of this component in normalized [0..1] bbox coordinates */
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}

export interface ScanlineSpan {
  /** Normalized vertical position 0 (top) .. 1 (bottom) within foreground bbox */
  v: number;
  /** Leftmost foreground X in [0..1] within bbox, or -1 if empty */
  left: number;
  /** Rightmost foreground X in [0..1] within bbox, or -1 if empty */
  right: number;
  /** Occupied pixel count on this scanline */
  occupiedRatio: number;
  /** Distinct horizontal segment count on this scanline (e.g. >1 when split into legs) */
  segmentCount: number;
}

export type OfflineReconstructionMode =
  | 'lathe_rotational'
  | 'lathe_with_handle'
  | 'contour_extrusion'
  | 'unsupported';

export interface SketchPreprocessMetrics {
  originalWidth: number;
  originalHeight: number;
  preparedWidth: number;
  preparedHeight: number;
  hasForeground: boolean;
  hasTransparency: boolean;
  transparentPixelRatio: number;
  estimatedIlluminationUnevenness: number;
  illuminationCorrected: boolean;
  contrastNormalized: boolean;
  bbox: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };
  inkPixelCount: number;
  enclosedPixelCount: number;
  foregroundInkRatio: number;
  measuredAspectRatio: number;
  measuredAspectLabel: string;
  verticalSymmetryScore: number;
  coreBodySymmetryScore: number;
  unilateralAppendageSide: 'none' | 'left' | 'right';
  hasBottomLegGap: boolean;
  detectedLowerColumnCount: number;
  connectedComponentCount: number;
  outerContourCount: number;
  holeContourCount: number;
  dominantContourPoints: number;
  rotationalProfileSuitable: boolean;
  recommendedOfflineMode: OfflineReconstructionMode;
  durationMs: number;
}

export interface CompiledReconstructionSpec {
  objectName: string;
  primaryMaterial: string;
  secondaryMaterial: string;
  colourPalette: string;
  surfaceFinish: string;
  primaryHex: string;
  secondaryHex: string;
  roughness: number;
  metalness: number;
  clearcoat: number;
  opacity: number;
  depthRatio: number;
  isHollowVessel: boolean;
  symmetryOverride: 'auto' | 'rotational' | 'extrusion';
  supportTopology:
    | 'auto'
    | 'four_leg_frame'
    | 'three_leg_tripod'
    | 'pedestal_base'
    | 'solid_extrusion';
  confirmedOverridesCount: number;
  decisionSummary: string[];
}

export interface SystemStatusResponse {
  geminiConfigured: boolean;
  tripoConfigured: boolean;
  demoMode: boolean;
  offlineFallbackAvailable?: boolean;
  geminiModel: string;
  geminiFallbackModel?: string;
  tripoApiBase: string;
  tripoModelVersion?: string;
  limits: {
    maxUploadBytes: number;
    supportedMimeTypes: string[];
    pollTimeoutSeconds: number;
  };
}

export interface ApiStructuredError {
  code: string;
  title: string;
  message: string;
  suggestion?: string;
  tripoCode?: number;
  requestId?: string;
  diagnosticSimulation?: boolean;
}

export type TripoTaskStatus =
  | 'uploading'
  | 'queued'
  | 'running'
  | 'downloading_glb'
  | 'validating_glb'
  | 'offline_reconstructing'
  | 'success'
  | 'failed'
  | 'banned'
  | 'cancelled'
  | 'expired'
  | 'demo_blocked';

export interface ValidatedMeshStats {
  meshCount: number;
  nonEmptyMeshCount: number;
  vertexCount: number;
  triangleCount: number;
  dimensions: {
    x: number;
    y: number;
    z: number;
  };
  fileSizeBytes: number;
  declaredLengthBytes?: number;
  glbVersion: number;
  validationDurationMs?: number;
  validatedAt: string;
}

export interface ActiveSketchAsset {
  blob: Blob;
  previewUrl: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sourceMode: SketchSourceMode;
  sha256?: string;
}

export interface PipelineStageTimings {
  cvPrepMs?: number;
  visionAnalysisMs?: number;
  reconstructionMs?: number;
  glbValidationMs?: number;
}

export interface GenerationHistoryEntry {
  id: string;
  createdAt: string;
  objectName: string;
  sourceMode: SketchSourceMode;
  sketchDataUrl: string;
  sketchMimeType: string;
  sketchFileName: string;
  sketchSha256: string;
  hints: DesignHints;
  analysis: SketchAnalysisResult;
  analysisModelUsed?: string;
  analysisDurationMs?: number;
  cvPrepDurationMs?: number;
  validationDurationMs?: number;
  intentLock: IntentLockRecord;
  reconstructionSpec?: CompiledReconstructionSpec;
  selectedOptionId?: ReconstructionOptionId;
  selectedOptionName?: string;
  objectCategory?: SupportedObjectCategory;
  outcome:
    | 'tripo_glb_verified'
    | 'modular_structural_glb'
    | 'offline_contour_glb'
    | 'demo_analysis_only'
    | 'generation_failed';
  tripoTaskId?: string;
  tripoModelVersion?: string;
  offlineModeUsed?: OfflineReconstructionMode;
  meshStats?: ValidatedMeshStats;
  hasStoredGlb: boolean;
  generationDurationMs?: number;
  errorSummary?: string;
}
