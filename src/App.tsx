/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookmarkCheck,
  Box,
  CheckCircle2,
  Cpu,
  Loader2,
  PenTool,
  Sparkles,
  Upload,
} from 'lucide-react';
import type {
  ActiveSketchAsset,
  ApiStructuredError,
  DesignHints,
  GenerationHistoryEntry,
  IntentLockRecord,
  NavTab,
  PipelineImageChoice,
  PipelineStageTimings,
  ReconstructionOptionId,
  ReconstructionSource,
  SketchAnalysisResult,
  SketchSourceMode,
  SynthesizedOptionPreview,
  SystemStatusResponse,
  TripoTaskStatus,
  ValidatedMeshStats,
} from './types/studio';
import { TopNav } from './components/TopNav';
import { DashboardView } from './components/DashboardView';
import { DrawingCanvas } from './components/DrawingCanvas';
import { SketchUploadPanel } from './components/SketchUploadPanel';
import { SketchPreprocessPanel } from './components/SketchPreprocessPanel';
import { AnalysisAndDesignMap } from './components/AnalysisAndDesignMap';
import { IntentLockPanel } from './components/IntentLockPanel';
import { ReconstructionOptionsPanel } from './components/ReconstructionOptionsPanel';
import { GenerationProgressPanel } from './components/GenerationProgressPanel';
import { ModelViewer3D } from './components/ModelViewer3D';
import { HistoryView } from './components/HistoryView';
import { DiagnosticsView } from './components/DiagnosticsView';
import { DocsView } from './components/DocsView';
import type { PresetSketchId } from './utils/sketchPresets';
import {
  blobToDataUrl,
  clearAllHistory,
  computeBlobSha256Hex,
  loadGlbFromIndexedDb,
  loadHistoryEntries,
  removeHistoryEntry,
  saveHistoryEntry,
} from './utils/historyStore';
import { validateAndParseGlbBuffer, disposeObject3D } from './utils/glbValidator';
import { fetchApiJsonWithRetry, readApiJson } from './utils/apiClient';
import { compileIntentReconstructionSpec } from './utils/intentCompiler';
import {
  preprocessSketchBlob,
  type BrowserPreprocessResult,
} from './utils/sketchPreprocessor';
import {
  OFFLINE_FALLBACK_PROVENANCE_LABEL,
  OfflineReconstructionError,
  reconstructOffline3DFromBlob,
  reconstructOffline3DFromPreprocessed,
} from './utils/sketchTo3DFallback';
import {
  MODULAR_PROVENANCE_PREFIX,
  resolveCategoryAndBlueprint,
  synthesizeThreeReconstructionOptions,
} from './utils/modularReconstructor';

const EMPTY_HINTS: DesignHints = {
  objectType: '',
  material: '',
  colour: '',
  style: '',
};

const FALLBACK_EMPTY_ANALYSIS: SketchAnalysisResult = {
  object_name: '2D Sketch Object',
  visible_components: [],
  observed_features: [],
  uncertain_features: [],
  inferred_features: [],
  proportions_description: 'Proportions measured directly from 2D sketch contours.',
  material_preferences: {
    primary_material: 'Matte architectural polymer',
    secondary_material: 'Brushed metallic accent',
    colour_palette: 'Neutral warm studio palette',
    surface_finish: 'Satin smooth industrial finish',
    source_note: 'Local CV fallback specification.',
  },
  reconstruction_notes: 'Direct contour-based volumetric reconstruction.',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [systemStatus, setSystemStatus] = useState<SystemStatusResponse | null>(null);

  // Sketch Workspace State
  const [sourceMode, setSourceMode] = useState<SketchSourceMode>('canvas');
  const [canvasSketch, setCanvasSketch] = useState<{
    blob: Blob;
    width: number;
    height: number;
    hasInk: boolean;
  } | null>(null);
  const [uploadedSketch, setUploadedSketch] = useState<ActiveSketchAsset | null>(null);
  const [presetTrigger, setPresetTrigger] = useState<{
    presetId: PresetSketchId;
    nonce: number;
  } | null>(null);
  const [hints, setHints] = useState<DesignHints>(EMPTY_HINTS);

  // Deterministic CV Preprocessing State
  const [illuminationCorrection, setIlluminationCorrection] = useState<boolean>(false);
  const [pipelineImageChoice, setPipelineImageChoice] = useState<PipelineImageChoice>('original');
  const [cvPrepResult, setCvPrepResult] = useState<BrowserPreprocessResult | null>(null);
  const [isPreprocessing, setIsPreprocessing] = useState<boolean>(false);
  const [activeOriginalPreviewUrl, setActiveOriginalPreviewUrl] = useState<string | null>(null);
  const [activeOriginalSha256, setActiveOriginalSha256] = useState<string>('');

  // Vision Analysis & IntentLock State
  const [isAnalysing, setIsAnalysing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<ApiStructuredError | null>(null);
  const [analysisResult, setAnalysisResult] = useState<SketchAnalysisResult | null>(null);
  const [analysisModelUsed, setAnalysisModelUsed] = useState<string>('');
  const [analysedOriginalSha256, setAnalysedOriginalSha256] = useState<string>('');
  const [analysedOriginalBlob, setAnalysedOriginalBlob] = useState<Blob | null>(null);
  const [analysedOriginalDataUrl, setAnalysedOriginalDataUrl] = useState<string | null>(null);
  const [analysedSketchMime, setAnalysedSketchMime] = useState<string>('image/png');
  const [analysedSketchFileName, setAnalysedSketchFileName] = useState<string>('canvas_sketch.png');
  const [intentLock, setIntentLock] = useState<IntentLockRecord | null>(null);

  // Three-Option Modular 3D Synthesis & Viewer State
  const [synthesizedOptions, setSynthesizedOptions] = useState<SynthesizedOptionPreview[]>([]);
  const [isSynthesizingOptions, setIsSynthesizingOptions] = useState<boolean>(false);
  const [selectedOptionId, setSelectedOptionId] = useState<ReconstructionOptionId | null>(null);
  const [selectedOptionProvenance, setSelectedOptionProvenance] = useState<string>('');

  const [reconstructionMode, setReconstructionMode] = useState<'tripo' | 'offline'>('tripo');
  const [reconstructionSource, setReconstructionSource] =
    useState<ReconstructionSource>('tripo_v3');
  const [tripoStatus, setTripoStatus] = useState<TripoTaskStatus | null>(null);
  const [tripoProgress, setTripoProgress] = useState<number>(0);
  const [tripoTaskId, setTripoTaskId] = useState<string | null>(null);
  const [tripoModelVersion, setTripoModelVersion] = useState<string>('');
  const [offlineSummary, setOfflineSummary] = useState<string | null>(null);
  const [tripoError, setTripoError] = useState<ApiStructuredError | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [verifiedGlbBuffer, setVerifiedGlbBuffer] = useState<ArrayBuffer | null>(null);
  const [verifiedMeshStats, setVerifiedMeshStats] = useState<ValidatedMeshStats | null>(null);
  const [stageTimings, setStageTimings] = useState<PipelineStageTimings>({});
  const [restoredBanner, setRestoredBanner] = useState<string | null>(null);

  // Local Archive History
  const [history, setHistory] = useState<GenerationHistoryEntry[]>(() => loadHistoryEntries());

  const pollAbortRef = useRef<AbortController | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const uploadedPreviewUrlRef = useRef<string | null>(null);
  const canvasPreviewUrlRef = useRef<string | null>(null);
  const viewerSectionRef = useRef<HTMLElement | null>(null);

  const fetchSystemStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/system/status');
      const parsed = await readApiJson<SystemStatusResponse>(resp, 'GET /api/system/status');
      if (parsed.ok) {
        setSystemStatus(parsed.data);
        return parsed.data;
      }
    } catch {
      // Keep existing status if offline
    }
    return null;
  }, []);

  useEffect(() => {
    void fetchSystemStatus();
  }, [fetchSystemStatus]);

  // Clean up object URLs & active polling on unmount
  useEffect(() => {
    return () => {
      if (uploadedPreviewUrlRef.current) {
        URL.revokeObjectURL(uploadedPreviewUrlRef.current);
      }
      if (canvasPreviewUrlRef.current) {
        URL.revokeObjectURL(canvasPreviewUrlRef.current);
      }
      pollAbortRef.current?.abort();
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
      }
    };
  }, []);

  // Automatically run deterministic CV preprocessing whenever the active sketch or illumination toggle changes
  useEffect(() => {
    const activeBlob =
      sourceMode === 'canvas'
        ? canvasSketch?.hasInk
          ? canvasSketch.blob
          : null
        : uploadedSketch?.blob ?? null;

    if (!activeBlob) {
      setCvPrepResult(null);
      setActiveOriginalSha256('');
      setActiveOriginalPreviewUrl(null);
      setIsPreprocessing(false);
      return;
    }

    let cancelled = false;
    setIsPreprocessing(true);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const [sha, prep] = await Promise.all([
            computeBlobSha256Hex(activeBlob),
            preprocessSketchBlob(activeBlob, {
              illuminationCorrection,
              contrastNormalization: true,
              squareSize: 512,
            }),
          ]);
          if (cancelled) return;

          if (sourceMode === 'canvas') {
            if (canvasPreviewUrlRef.current) {
              URL.revokeObjectURL(canvasPreviewUrlRef.current);
            }
            const nextUrl = URL.createObjectURL(activeBlob);
            canvasPreviewUrlRef.current = nextUrl;
            setActiveOriginalPreviewUrl(nextUrl);
          } else {
            setActiveOriginalPreviewUrl(uploadedSketch?.previewUrl ?? null);
          }

          setActiveOriginalSha256(sha);
          setCvPrepResult(prep);
          setStageTimings((prev) => ({ ...prev, cvPrepMs: prep.metrics.durationMs }));
        } catch {
          if (!cancelled) {
            setCvPrepResult(null);
          }
        } finally {
          if (!cancelled) {
            setIsPreprocessing(false);
          }
        }
      })();
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sourceMode, canvasSketch, uploadedSketch, illuminationCorrection]);

  const compiledSpec = useMemo(
    () =>
      compileIntentReconstructionSpec(
        hints,
        analysisResult ?? FALLBACK_EMPTY_ANALYSIS,
        intentLock
      ),
    [hints, analysisResult, intentLock]
  );

  const stopGenerationTimers = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    if (timerIntervalRef.current) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  // Synthesize Three Distinct 3D Reconstruction Options (Option A, Option B, Option C) whenever Vision Audit, IntentLock, or Hints update
  useEffect(() => {
    if (!analysisResult) {
      setSynthesizedOptions([]);
      setIsSynthesizingOptions(false);
      return;
    }

    let cancelled = false;
    setIsSynthesizingOptions(true);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          let prep = cvPrepResult;
          if (!prep && analysedOriginalBlob) {
            prep = await preprocessSketchBlob(analysedOriginalBlob, {
              illuminationCorrection,
              contrastNormalization: true,
              squareSize: 512,
            });
          }
          if (!prep || cancelled) return;

          const options = await synthesizeThreeReconstructionOptions(
            prep,
            analysisResult,
            hints,
            intentLock
          );
          if (cancelled) return;
          setSynthesizedOptions(options);

          // If user already selected Option A/B/C and updated IntentLock or Material Hints, refresh the main 3D viewport seamlessly
          if (selectedOptionId && reconstructionSource === 'modular_structural') {
            const updatedChosen = options.find((o) => o.option.id === selectedOptionId);
            if (updatedChosen?.glbBuffer && updatedChosen.stats) {
              setVerifiedGlbBuffer(updatedChosen.glbBuffer);
              setVerifiedMeshStats(updatedChosen.stats);
              setSelectedOptionProvenance(updatedChosen.provenanceLabel);
              setOfflineSummary(updatedChosen.geometrySummary);
            }
          }
        } catch {
          if (!cancelled) {
            setSynthesizedOptions([]);
          }
        } finally {
          if (!cancelled) {
            setIsSynthesizingOptions(false);
          }
        }
      })();
    }, 100);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    analysisResult,
    cvPrepResult,
    analysedOriginalBlob,
    illuminationCorrection,
    hints,
    intentLock,
    selectedOptionId,
    reconstructionSource,
  ]);

  const resetDownstreamPipeline = useCallback(() => {
    stopGenerationTimers();
    setAnalysisError(null);
    setAnalysisResult(null);
    setAnalysisModelUsed('');
    setAnalysedOriginalSha256('');
    setAnalysedOriginalBlob(null);
    setAnalysedOriginalDataUrl(null);
    setIntentLock(null);
    setSynthesizedOptions([]);
    setIsSynthesizingOptions(false);
    setSelectedOptionId(null);
    setSelectedOptionProvenance('');
    setTripoStatus(null);
    setTripoProgress(0);
    setTripoTaskId(null);
    setTripoModelVersion('');
    setOfflineSummary(null);
    setTripoError(null);
    setElapsedSeconds(0);
    setVerifiedGlbBuffer(null);
    setVerifiedMeshStats(null);
    setStageTimings((prev) => ({ cvPrepMs: prev.cvPrepMs }));
    setRestoredBanner(null);
  }, [stopGenerationTimers]);

  const handleCanvasSketchChange = useCallback(
    (blob: Blob, width: number, height: number, hasInk: boolean) => {
      setCanvasSketch({ blob, width, height, hasInk });
    },
    []
  );

  const handleSelectValidUpload = useCallback(
    (asset: ActiveSketchAsset) => {
      if (
        uploadedPreviewUrlRef.current &&
        uploadedPreviewUrlRef.current !== asset.previewUrl
      ) {
        URL.revokeObjectURL(uploadedPreviewUrlRef.current);
      }
      uploadedPreviewUrlRef.current = asset.previewUrl;
      setUploadedSketch(asset);
      resetDownstreamPipeline();
    },
    [resetDownstreamPipeline]
  );

  const handleClearUpload = useCallback(() => {
    if (uploadedPreviewUrlRef.current) {
      URL.revokeObjectURL(uploadedPreviewUrlRef.current);
      uploadedPreviewUrlRef.current = null;
    }
    setUploadedSketch(null);
    resetDownstreamPipeline();
  }, [resetDownstreamPipeline]);

  const handleStartSampleChair = useCallback(() => {
    resetDownstreamPipeline();
    setSourceMode('canvas');
    setActiveTab('studio');
    setPresetTrigger((prev) => ({
      presetId: 'lounge_chair',
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, [resetDownstreamPipeline]);

  const handleStartBlankCanvas = useCallback(() => {
    resetDownstreamPipeline();
    setHints(EMPTY_HINTS);
    setSourceMode('canvas');
    setActiveTab('studio');
  }, [resetDownstreamPipeline]);

  const handleStartUploadMode = useCallback(() => {
    resetDownstreamPipeline();
    setSourceMode('upload');
    setActiveTab('studio');
  }, [resetDownstreamPipeline]);

  // Resolve the currently active original sketch Blob & metadata
  const getCurrentOriginalSketch = useCallback((): {
    blob: Blob;
    fileName: string;
    mimeType: string;
  } | null => {
    if (sourceMode === 'canvas') {
      if (!canvasSketch || !canvasSketch.hasInk) return null;
      return {
        blob: canvasSketch.blob,
        fileName: 'canvas_sketch.png',
        mimeType: 'image/png',
      };
    }
    if (!uploadedSketch) return null;
    return {
      blob: uploadedSketch.blob,
      fileName: uploadedSketch.fileName,
      mimeType: uploadedSketch.mimeType,
    };
  }, [sourceMode, canvasSketch, uploadedSketch]);

  // Step 2: Run Gemini Multimodal Vision Analysis (Preserves user work & prior analysis on failure)
  const handleRunVisionAnalysis = async () => {
    setAnalysisError(null);

    const activeOrig = getCurrentOriginalSketch();
    if (!activeOrig) {
      setAnalysisError(
        sourceMode === 'canvas'
          ? {
              code: 'EMPTY_CANVAS',
              title: 'Drafting Canvas Is Blank',
              message:
                'Draw a 2D object sketch on the canvas or click "Lounge Chair" preset before running vision analysis.',
            }
          : {
              code: 'NO_UPLOAD_SELECTED',
              title: 'No Sketch File Uploaded',
              message: 'Select a valid PNG, JPG, or WebP sketch image to analyse.',
            }
      );
      return;
    }

    setIsAnalysing(true);
    try {
      const originalSha = await computeBlobSha256Hex(activeOrig.blob);

      // Clear stale downstream state ONLY if the user drew/uploaded a new sketch since the previous analysis
      if (analysedOriginalSha256 && analysedOriginalSha256 !== originalSha) {
        stopGenerationTimers();
        setAnalysisResult(null);
        setIntentLock(null);
        setTripoStatus(null);
        setTripoError(null);
        setVerifiedGlbBuffer(null);
        setVerifiedMeshStats(null);
      }

      const usePrepared =
        pipelineImageChoice === 'prepared' && Boolean(cvPrepResult?.preparedBlob);
      const payloadBlob =
        usePrepared && cvPrepResult ? cvPrepResult.preparedBlob : activeOrig.blob;
      const payloadFileName = usePrepared
        ? `prepared_${activeOrig.fileName.replace(/\.[^.]+$/, '')}.png`
        : activeOrig.fileName;

      const fd = new FormData();
      fd.append('sketch', payloadBlob, payloadFileName);
      fd.append('hints', JSON.stringify(hints));
      if (cvPrepResult?.metrics) {
        fd.append(
          'cvMetrics',
          JSON.stringify({
            measuredAspectLabel: cvPrepResult.metrics.measuredAspectLabel,
            foregroundInkRatio: cvPrepResult.metrics.foregroundInkRatio,
            verticalSymmetryScore: cvPrepResult.metrics.verticalSymmetryScore,
            outerContourCount: cvPrepResult.metrics.outerContourCount,
            holeContourCount: cvPrepResult.metrics.holeContourCount,
          })
        );
      }

      const parsed = await fetchApiJsonWithRetry<{
        analysis: SketchAnalysisResult;
        modelUsed?: string;
        analysisDurationMs?: number;
        sketchSha256?: string;
      }>('/api/sketch/analyze', { method: 'POST', body: fd }, 'POST /api/sketch/analyze');

      if (!parsed.ok) {
        setAnalysisError(parsed.error);
        return;
      }

      const origDataUrl = await blobToDataUrl(activeOrig.blob);

      stopGenerationTimers();
      setTripoStatus(null);
      setTripoError(null);
      setVerifiedGlbBuffer(null);
      setVerifiedMeshStats(null);
      setIntentLock(null);
      setSelectedOptionId(null);
      setSelectedOptionProvenance('');

      setAnalysisResult(parsed.data.analysis);
      setAnalysisModelUsed(parsed.data.modelUsed || 'gemini-3.8-flash');
      setAnalysedOriginalSha256(originalSha);
      setAnalysedOriginalBlob(activeOrig.blob);
      setAnalysedOriginalDataUrl(origDataUrl);
      setAnalysedSketchMime(activeOrig.mimeType);
      setAnalysedSketchFileName(activeOrig.fileName);
      if (typeof parsed.data.analysisDurationMs === 'number') {
        setStageTimings((prev) => ({
          ...prev,
          visionAnalysisMs: parsed.data.analysisDurationMs,
        }));
      }
    } catch (err: unknown) {
      setAnalysisError({
        code: 'NETWORK_ERROR',
        title: 'Network Error Contacting Vision Server',
        message: err instanceof Error ? err.message : String(err),
        suggestion:
          'Your sketch and hints are preserved. Verify your connection and click Analyse Sketch again, or compare the Three Modular 3D Options locally using CV + Design Parameters.',
      });
    } finally {
      setIsAnalysing(false);
    }
  };

  // Honest Local Deterministic CV + Hints Spatial Audit (Used if Gemini Vision returns 503 or user opts for local CV)
  const handleRunLocalCvThreeOptionAudit = async () => {
    const activeOrig = getCurrentOriginalSketch();
    if (!activeOrig) return;

    const originalSha = await computeBlobSha256Hex(activeOrig.blob);
    const origDataUrl = await blobToDataUrl(activeOrig.blob);
    const prep =
      cvPrepResult ??
      (await preprocessSketchBlob(activeOrig.blob, {
        illuminationCorrection,
        contrastNormalization: true,
        squareSize: 512,
      }));

    const seedName = hints.objectType.trim() || '2D Sketched Structural Object';
    const seedAnalysis: SketchAnalysisResult = {
      ...FALLBACK_EMPTY_ANALYSIS,
      object_name: seedName,
    };
    const resolved = resolveCategoryAndBlueprint(seedAnalysis, hints, prep, null);

    const localUncertainties: SketchAnalysisResult['uncertain_features'] =
      resolved.category === 'chair'
        ? [
            {
              id: 'chair_armrests',
              feature_name: 'Armrest configuration',
              uncertainty_reason: 'Single 2D sketch silhouette without cloud vision disambiguation.',
              options: ['Omit armrests (armless)', 'Include armrests'],
              default_assumption: resolved.blueprint.has_armrests
                ? 'Include armrests'
                : 'Omit armrests (armless)',
              importance: 'critical',
            },
            {
              id: 'chair_legs',
              feature_name: 'Support leg geometry',
              uncertainty_reason: 'Occluded rear legs inferred from lower foreground columns.',
              options: [
                '4 splayed legs',
                '4 straight legs',
                '3-legged tripod',
                'Central pedestal base',
              ],
              default_assumption:
                resolved.blueprint.leg_style === 'four_legs_splayed'
                  ? '4 splayed legs'
                  : '4 straight legs',
              importance: 'moderate',
            },
          ]
        : resolved.category === 'mug_vessel'
          ? [
              {
                id: 'vessel_cavity',
                feature_name: 'Top interior cavity',
                uncertainty_reason: 'Top rim interior depth inferred from vessel category.',
                options: ['Hollow open vessel interior', 'Solid closed top'],
                default_assumption: 'Hollow open vessel interior',
                importance: 'critical',
              },
            ]
          : [
              {
                id: 'structural_depth',
                feature_name: 'Front-to-back 3D depth proportion',
                uncertainty_reason: 'Depth axis (Z) is foreshortened in a single 2D view.',
                options: ['Balanced standard depth', 'Slim shallow profile', 'Deep wide profile'],
                default_assumption: 'Balanced standard depth',
                importance: 'moderate',
              },
            ];

    const honestLocalAnalysis: SketchAnalysisResult = {
      object_name: seedName,
      visible_components: [
        `Foreground silhouette (${prep.metrics.outerContourCount} outer contour${prep.metrics.outerContourCount === 1 ? '' : 's'}, ${prep.metrics.holeContourCount} interior hole${prep.metrics.holeContourCount === 1 ? '' : 's'})`,
        `Measured W:H aspect ratio ${prep.metrics.measuredAspectLabel}`,
      ],
      observed_features: [
        `2D bilateral vertical symmetry ${(prep.metrics.verticalSymmetryScore * 100).toFixed(0)}%`,
        prep.metrics.hasBottomLegGap
          ? `Detected ${prep.metrics.detectedLowerColumnCount} separated lower support columns`
          : 'Continuous grounded lower silhouette',
      ],
      uncertain_features: resolved.supported ? localUncertainties : [],
      inferred_features: [
        'Symmetric 3D depth and occluded structural joinery estimated via deterministic category builder',
      ],
      proportions_description: `Measured directly from 2D sketch stroke bounds (${prep.metrics.measuredAspectLabel}, ${(prep.metrics.foregroundInkRatio * 100).toFixed(1)}% ink coverage).`,
      material_preferences: {
        primary_material: hints.material.trim() || 'Natural walnut & matte architectural finish',
        secondary_material: 'Brushed metallic structural joinery',
        colour_palette: hints.colour.trim() || 'Warm neutral studio palette',
        surface_finish: hints.style.trim() || 'Satin architectural finish',
        source_note:
          'Deterministic local CV + user design parameters (Gemini Vision bypassed due to upstream load or user choice).',
      },
      reconstruction_notes:
        'Local deterministic CV spatial audit active. Specify Object Type (e.g., Chair, Table, Mug, Lamp, Bookshelf, Bracket) in Optional Design Parameters to guide category selection if untitled.',
      object_category: resolved.category,
      category_supported: resolved.supported,
      unsupported_reason: resolved.unsupportedReason,
      structural_blueprint: resolved.blueprint,
      reconstruction_options: resolved.options,
    };

    stopGenerationTimers();
    setAnalysisError(null);
    setTripoStatus(null);
    setTripoError(null);
    setVerifiedGlbBuffer(null);
    setVerifiedMeshStats(null);
    setIntentLock(null);
    setSelectedOptionId(null);
    setSelectedOptionProvenance('');

    setAnalysisResult(honestLocalAnalysis);
    setAnalysisModelUsed('local-cv-spatial-audit (No Cloud LLM)');
    setAnalysedOriginalSha256(originalSha);
    setAnalysedOriginalBlob(activeOrig.blob);
    setAnalysedOriginalDataUrl(origDataUrl);
    setAnalysedSketchMime(activeOrig.mimeType);
    setAnalysedSketchFileName(activeOrig.fileName);
  };

  // Save Demo / Analysis-Only Record Explicitly Without Claiming 3D Generation
  const saveDemoRecordToHistory = async (
    analysis: SketchAnalysisResult,
    lockedIntent: IntentLockRecord
  ) => {
    if (!analysedOriginalBlob) return;
    const sketchDataUrl =
      analysedOriginalDataUrl || (await blobToDataUrl(analysedOriginalBlob));
    const entry: GenerationHistoryEntry = {
      id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      objectName: analysis.object_name,
      sourceMode,
      sketchDataUrl,
      sketchMimeType: analysedSketchMime,
      sketchFileName: analysedSketchFileName,
      sketchSha256: analysedOriginalSha256,
      hints,
      analysis,
      analysisModelUsed,
      analysisDurationMs: stageTimings.visionAnalysisMs,
      cvPrepDurationMs: stageTimings.cvPrepMs,
      intentLock: lockedIntent,
      reconstructionSpec: compiledSpec,
      outcome: 'demo_analysis_only',
      hasStoredGlb: false,
    };
    const updated = await saveHistoryEntry(entry, null);
    setHistory(updated);
  };

  // Select Option A, B, or C from Three-Option Modular 3D Reconstruction
  const handleSelectReconstructionOption = async (optionId: ReconstructionOptionId) => {
    const chosen = synthesizedOptions.find((o) => o.option.id === optionId);
    if (!chosen || !chosen.glbBuffer || !chosen.stats || !analysisResult) return;

    stopGenerationTimers();
    const activeOrig = getCurrentOriginalSketch();
    const targetBlob = analysedOriginalBlob ?? activeOrig?.blob ?? null;

    const origSha =
      analysedOriginalSha256 ||
      activeOriginalSha256 ||
      (targetBlob ? await computeBlobSha256Hex(targetBlob) : '');
    const origDataUrl =
      analysedOriginalDataUrl ||
      (targetBlob ? await blobToDataUrl(targetBlob) : activeOriginalPreviewUrl || '');

    if (!analysedOriginalSha256 && origSha) {
      setAnalysedOriginalSha256(origSha);
    }
    if (!analysedOriginalDataUrl && origDataUrl) {
      setAnalysedOriginalDataUrl(origDataUrl);
    }

    // Auto-lock IntentLock with default assumptions if user selects an option directly without unnecessary friction
    let effectiveIntent = intentLock;
    if (!effectiveIntent?.locked) {
      effectiveIntent = {
        locked: true,
        lockedAt: new Date().toISOString(),
        decisions: (analysisResult.uncertain_features || []).map((u) => ({
          uncertaintyId: u.id,
          featureName: u.feature_name,
          selectedOption: u.default_assumption,
          customCorrection: '',
          finalValue: u.default_assumption,
          wasCorrected: false,
        })),
        additionalNotes: `Selected ${chosen.option.code} — ${chosen.option.name}`,
        originalSketchSha256: origSha,
      };
      setIntentLock(effectiveIntent);
    }

    setSelectedOptionId(optionId);
    setSelectedOptionProvenance(chosen.provenanceLabel);
    setReconstructionMode('offline');
    setReconstructionSource('modular_structural');
    setTripoError(null);
    setTripoTaskId(null);
    setOfflineSummary(chosen.geometrySummary);
    setVerifiedGlbBuffer(chosen.glbBuffer);
    setVerifiedMeshStats(chosen.stats);
    setTripoProgress(100);
    setTripoStatus(null);
    setStageTimings((prev) => ({
      ...prev,
      reconstructionMs: chosen.durationMs,
      glbValidationMs: chosen.stats?.validationDurationMs,
    }));

    const historyItem: GenerationHistoryEntry = {
      id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      objectName: `${chosen.compiledSpec.objectName} (${chosen.option.name})`,
      sourceMode,
      sketchDataUrl: origDataUrl,
      sketchMimeType: analysedSketchMime,
      sketchFileName: activeOrig?.fileName || analysedSketchFileName,
      sketchSha256: origSha,
      hints,
      analysis: analysisResult,
      analysisModelUsed: analysisModelUsed || undefined,
      analysisDurationMs: stageTimings.visionAnalysisMs,
      cvPrepDurationMs: stageTimings.cvPrepMs,
      validationDurationMs: chosen.stats.validationDurationMs,
      intentLock: effectiveIntent,
      reconstructionSpec: chosen.compiledSpec,
      selectedOptionId: optionId,
      selectedOptionName: `${chosen.option.code} — ${chosen.option.name}`,
      objectCategory: chosen.category,
      outcome: 'modular_structural_glb',
      meshStats: chosen.stats,
      hasStoredGlb: true,
      generationDurationMs: chosen.durationMs,
    };
    setHistory(await saveHistoryEntry(historyItem, chosen.glbBuffer));

    window.setTimeout(() => {
      viewerSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 80);
  };

  // Limited Raw Contour-Based 3D Extrusion Fallback (Explicitly opt-in)
  const handleRunOfflineReconstruction = async () => {
    const activeOrig = getCurrentOriginalSketch();
    const targetBlob = analysedOriginalBlob ?? activeOrig?.blob ?? null;
    if (!targetBlob) {
      setTripoError({
        code: 'MISSING_SKETCH_FOR_OFFLINE',
        title: 'No Sketch Available for Offline Reconstruction',
        message: 'Draw or upload a 2D sketch before running offline contour reconstruction.',
      });
      setTripoStatus('failed');
      return;
    }

    stopGenerationTimers();
    setReconstructionMode('offline');
    setReconstructionSource('offline_contour');
    setTripoError(null);
    setVerifiedGlbBuffer(null);
    setVerifiedMeshStats(null);
    setTripoTaskId(null);
    setOfflineSummary(null);
    setTripoProgress(35);
    setTripoStatus('offline_reconstructing');

    try {
      const effectiveAnalysis = analysisResult ?? {
        ...FALLBACK_EMPTY_ANALYSIS,
        object_name: hints.objectType.trim() || 'Contour Sketch Object',
      };
      const effectiveSpec = compileIntentReconstructionSpec(
        hints,
        effectiveAnalysis,
        intentLock
      );
      const isVisionUnrecognized = /unrecognized|blank\s*sketch/i.test(
        effectiveAnalysis.object_name
      );

      const output =
        cvPrepResult && targetBlob === (activeOrig?.blob ?? analysedOriginalBlob)
          ? await reconstructOffline3DFromPreprocessed(
              cvPrepResult,
              effectiveSpec,
              isVisionUnrecognized
            )
          : await reconstructOffline3DFromBlob(targetBlob, effectiveSpec, {
              illuminationCorrection,
              unrecognizedByVision: isVisionUnrecognized,
            });

      const origSha =
        analysedOriginalSha256 || (await computeBlobSha256Hex(targetBlob));
      const origDataUrl =
        analysedOriginalDataUrl || (await blobToDataUrl(targetBlob));

      if (!analysedOriginalDataUrl) {
        setAnalysedOriginalDataUrl(origDataUrl);
      }
      if (!analysedOriginalSha256) {
        setAnalysedOriginalSha256(origSha);
      }

      setVerifiedGlbBuffer(output.glbBuffer);
      setVerifiedMeshStats(output.stats);
      setOfflineSummary(output.geometrySummary);
      setTripoProgress(100);
      setTripoStatus('success');
      setStageTimings((prev) => ({
        ...prev,
        reconstructionMs: output.durationMs,
        glbValidationMs: output.stats.validationDurationMs,
      }));

      const effectiveIntent: IntentLockRecord = intentLock ?? {
        locked: true,
        lockedAt: new Date().toISOString(),
        decisions: [],
        additionalNotes: 'Direct offline contour reconstruction',
        originalSketchSha256: origSha,
      };

      const historyItem: GenerationHistoryEntry = {
        id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        createdAt: new Date().toISOString(),
        objectName: effectiveSpec.objectName,
        sourceMode,
        sketchDataUrl: origDataUrl,
        sketchMimeType: analysedSketchMime,
        sketchFileName: activeOrig?.fileName || analysedSketchFileName,
        sketchSha256: origSha,
        hints,
        analysis: effectiveAnalysis,
        analysisModelUsed: analysisModelUsed || undefined,
        analysisDurationMs: stageTimings.visionAnalysisMs,
        cvPrepDurationMs: stageTimings.cvPrepMs,
        validationDurationMs: output.stats.validationDurationMs,
        intentLock: effectiveIntent,
        reconstructionSpec: effectiveSpec,
        outcome: 'offline_contour_glb',
        offlineModeUsed: output.modeUsed,
        meshStats: output.stats,
        hasStoredGlb: true,
        generationDurationMs: output.durationMs,
      };
      setHistory(await saveHistoryEntry(historyItem, output.glbBuffer));
    } catch (err: unknown) {
      if (err instanceof OfflineReconstructionError) {
        setTripoStatus('failed');
        setTripoError({
          code: err.code,
          title: 'Sketch Ambiguous or Insufficient for Offline 3D Contour Reconstruction',
          message: err.message,
          suggestion: err.suggestion,
        });
        return;
      }
      setTripoStatus('failed');
      setTripoError({
        code: 'OFFLINE_RECONSTRUCTION_FAILED',
        title: 'Offline Contour 3D Reconstruction Error',
        message: err instanceof Error ? err.message : String(err),
        suggestion:
          'Ensure the sketch has closed dark strokes on a lighter background and try again.',
      });
    }
  };

  // Step 4: Execute Official Tripo OpenAPI v3 Reconstruction Using Preserved Sketch
  const handleStart3DGeneration = async () => {
    if (!analysisResult || !intentLock?.locked || !analysedOriginalBlob) return;

    stopGenerationTimers();
    setReconstructionMode('tripo');
    setReconstructionSource('tripo_v3');
    setTripoError(null);
    setOfflineSummary(null);
    setVerifiedGlbBuffer(null);
    setVerifiedMeshStats(null);
    setElapsedSeconds(0);
    setTripoProgress(5);
    setTripoStatus('uploading');

    await fetchSystemStatus();

    const abortCtrl = new AbortController();
    pollAbortRef.current = abortCtrl;
    const startedMs = Date.now();
    const timeoutLimitSec = systemStatus?.limits.pollTimeoutSeconds ?? 180;

    timerIntervalRef.current = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedMs) / 1000));
    }, 1000);

    try {
      const usePrepared =
        pipelineImageChoice === 'prepared' && Boolean(cvPrepResult?.preparedBlob);
      const uploadBlob =
        usePrepared && cvPrepResult ? cvPrepResult.preparedBlob : analysedOriginalBlob;
      const uploadSha = usePrepared
        ? await computeBlobSha256Hex(uploadBlob)
        : analysedOriginalSha256;
      const uploadFileName = usePrepared
        ? `prepared_${analysedSketchFileName.replace(/\.[^.]+$/, '')}.png`
        : analysedSketchFileName;

      const fd = new FormData();
      fd.append('sketch', uploadBlob, uploadFileName);
      fd.append('expectedSketchSha256', uploadSha);
      fd.append('originalSketchSha256', analysedOriginalSha256);
      fd.append('objectName', compiledSpec.objectName);
      fd.append('hints', JSON.stringify(hints));
      fd.append('intentLock', JSON.stringify(intentLock));

      const createResp = await fetch('/api/tripo/generate', {
        method: 'POST',
        body: fd,
        signal: abortCtrl.signal,
      });

      const createParsed = await readApiJson<{
        taskId: string;
        status: string;
        progress: number;
        tripoModelVersion?: string;
      }>(createResp, 'POST /api/tripo/generate');

      if (!createParsed.ok) {
        stopGenerationTimers();
        const errPayload = createParsed.error;
        setTripoError(errPayload);

        if (errPayload.code === 'MISSING_TRIPO_API_KEY') {
          setTripoStatus('demo_blocked');
          await saveDemoRecordToHistory(analysisResult, intentLock);
        } else {
          setTripoStatus('failed');
          const sketchDataUrl =
            analysedOriginalDataUrl || (await blobToDataUrl(analysedOriginalBlob));
          const failedEntry: GenerationHistoryEntry = {
            id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            createdAt: new Date().toISOString(),
            objectName: compiledSpec.objectName,
            sourceMode,
            sketchDataUrl,
            sketchMimeType: analysedSketchMime,
            sketchFileName: analysedSketchFileName,
            sketchSha256: analysedOriginalSha256,
            hints,
            analysis: analysisResult,
            analysisModelUsed,
            analysisDurationMs: stageTimings.visionAnalysisMs,
            cvPrepDurationMs: stageTimings.cvPrepMs,
            intentLock,
            reconstructionSpec: compiledSpec,
            outcome: 'generation_failed',
            hasStoredGlb: false,
            errorSummary: errPayload.title,
          };
          setHistory(await saveHistoryEntry(failedEntry, null));
        }
        return;
      }

      const taskId = String(createParsed.data.taskId);
      const modelVer =
        createParsed.data.tripoModelVersion ||
        systemStatus?.tripoModelVersion ||
        'v3.1-20260211';
      setTripoTaskId(taskId);
      setTripoModelVersion(modelVer);
      setTripoStatus('queued');
      setTripoProgress(12);

      // Asynchronous Polling Loop
      while (!abortCtrl.signal.aborted) {
        const elapsedSec = (Date.now() - startedMs) / 1000;
        if (elapsedSec > timeoutLimitSec) {
          throw new Error(
            `Generation exceeded the ${timeoutLimitSec}s timeout threshold while waiting for task ${taskId}.`
          );
        }

        await new Promise<void>((resolve, reject) => {
          const t = window.setTimeout(resolve, 3000);
          abortCtrl.signal.addEventListener(
            'abort',
            () => {
              window.clearTimeout(t);
              reject(new DOMException('Polling cancelled by user', 'AbortError'));
            },
            { once: true }
          );
        });

        const pollResp = await fetch(`/api/tripo/tasks/${encodeURIComponent(taskId)}`, {
          signal: abortCtrl.signal,
        });
        const pollParsed = await readApiJson<{
          taskId: string;
          status: string;
          progress?: number;
          modelDownloadUrl?: string;
          error?: ApiStructuredError;
        }>(pollResp, `GET /api/tripo/tasks/${taskId}`);

        if (!pollParsed.ok) {
          stopGenerationTimers();
          setTripoStatus('failed');
          setTripoError(pollParsed.error);
          return;
        }

        const pollJson = pollParsed.data;
        const st = pollJson.status;
        const reportedProg = typeof pollJson.progress === 'number' ? pollJson.progress : 25;

        if (st === 'queued') {
          setTripoStatus('queued');
          setTripoProgress(Math.max(14, reportedProg));
        } else if (st === 'running') {
          setTripoStatus('running');
          setTripoProgress(Math.max(22, Math.min(90, reportedProg)));
        } else if (st === 'failed' || st === 'banned' || st === 'cancelled' || st === 'expired') {
          stopGenerationTimers();
          setTripoStatus(st);
          setTripoError(
            pollJson.error || {
              code: `TRIPO_${st.toUpperCase()}`,
              title: `3D Task ${st}`,
              message: 'Upstream Tripo task ended without a valid model.',
            }
          );
          return;
        } else if (st === 'success') {
          setTripoStatus('downloading_glb');
          setTripoProgress(93);

          const modelUrl = String(
            pollJson.modelDownloadUrl || `/api/tripo/tasks/${encodeURIComponent(taskId)}/model`
          );
          const glbResp = await fetch(modelUrl, { signal: abortCtrl.signal });
          if (!glbResp.ok) {
            const dlParsed = await readApiJson(glbResp, modelUrl);
            stopGenerationTimers();
            setTripoStatus('failed');
            setTripoError(
              !dlParsed.ok
                ? dlParsed.error
                : {
                    code: 'GLB_DOWNLOAD_FAILED',
                    title: 'Failed to Download Generated GLB',
                    message: `Server returned HTTP ${glbResp.status} while fetching the binary GLB.`,
                  }
            );
            return;
          }

          const rawArrayBuffer = await glbResp.arrayBuffer();
          setTripoStatus('validating_glb');
          setTripoProgress(97);

          const { scene: testScene, stats } = await validateAndParseGlbBuffer(rawArrayBuffer);
          disposeObject3D(testScene);

          const totalDurationMs = Date.now() - startedMs;
          stopGenerationTimers();
          setVerifiedGlbBuffer(rawArrayBuffer);
          setVerifiedMeshStats(stats);
          setTripoProgress(100);
          setTripoStatus('success');
          setStageTimings((prev) => ({
            ...prev,
            reconstructionMs: totalDurationMs,
            glbValidationMs: stats.validationDurationMs,
          }));

          const sketchDataUrl =
            analysedOriginalDataUrl || (await blobToDataUrl(analysedOriginalBlob));
          const historyItem: GenerationHistoryEntry = {
            id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            createdAt: new Date().toISOString(),
            objectName: compiledSpec.objectName,
            sourceMode,
            sketchDataUrl,
            sketchMimeType: analysedSketchMime,
            sketchFileName: analysedSketchFileName,
            sketchSha256: analysedOriginalSha256,
            hints,
            analysis: analysisResult,
            analysisModelUsed,
            analysisDurationMs: stageTimings.visionAnalysisMs,
            cvPrepDurationMs: stageTimings.cvPrepMs,
            validationDurationMs: stats.validationDurationMs,
            intentLock,
            reconstructionSpec: compiledSpec,
            outcome: 'tripo_glb_verified',
            tripoTaskId: taskId,
            tripoModelVersion: modelVer,
            meshStats: stats,
            hasStoredGlb: true,
            generationDurationMs: totalDurationMs,
          };
          setHistory(await saveHistoryEntry(historyItem, rawArrayBuffer));
          return;
        }
      }
    } catch (err: unknown) {
      stopGenerationTimers();
      if (err instanceof DOMException && err.name === 'AbortError') {
        setTripoStatus('cancelled');
        setTripoError({
          code: 'USER_CANCELLED',
          title: 'Polling Cancelled',
          message: 'You stopped polling the running 3D generation task.',
          suggestion: 'Click Retry Tripo v3 or Run Offline Contour 3D Reconstruction.',
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout/i.test(msg);
      setTripoStatus('failed');
      setTripoError({
        code: isTimeout ? 'CLIENT_POLL_TIMEOUT' : 'PIPELINE_EXCEPTION',
        title: isTimeout ? '3D Reconstruction Timed Out' : '3D Reconstruction Error',
        message: msg,
        suggestion:
          'Click Retry Tripo v3 or Run Offline Contour 3D Reconstruction to build a local mesh.',
      });
    }
  };

  const handleRestoreHistoryEntry = async (entry: GenerationHistoryEntry) => {
    resetDownstreamPipeline();
    setHints(entry.hints);
    setSourceMode(entry.sourceMode);
    setAnalysisResult(entry.analysis);
    setAnalysisModelUsed(entry.analysisModelUsed || 'gemini-3.1-flash-lite');
    setAnalysedOriginalSha256(entry.sketchSha256);
    setAnalysedOriginalDataUrl(entry.sketchDataUrl || null);
    setAnalysedSketchMime(entry.sketchMimeType);
    setAnalysedSketchFileName(entry.sketchFileName);
    setIntentLock(entry.intentLock);
    setStageTimings({
      cvPrepMs: entry.cvPrepDurationMs,
      visionAnalysisMs: entry.analysisDurationMs,
      reconstructionMs: entry.generationDurationMs,
      glbValidationMs: entry.validationDurationMs,
    });
    setRestoredBanner(
      `Restored archived session "${entry.objectName}" (${new Date(entry.createdAt).toLocaleString()})`
    );

    if (entry.sketchDataUrl) {
      try {
        const res = await fetch(entry.sketchDataUrl);
        const restoredBlob = await res.blob();
        setAnalysedOriginalBlob(restoredBlob);
        if (entry.sourceMode === 'upload') {
          const previewUrl = URL.createObjectURL(restoredBlob);
          if (uploadedPreviewUrlRef.current) {
            URL.revokeObjectURL(uploadedPreviewUrlRef.current);
          }
          uploadedPreviewUrlRef.current = previewUrl;
          setUploadedSketch({
            blob: restoredBlob,
            previewUrl,
            fileName: entry.sketchFileName,
            mimeType: entry.sketchMimeType,
            sizeBytes: restoredBlob.size,
            width: 768,
            height: 576,
            sourceMode: 'upload',
            sha256: entry.sketchSha256,
          });
        }
      } catch {
        // Ignore data URL decode errors
      }
    }

    if (entry.hasStoredGlb) {
      const archivedGlb = await loadGlbFromIndexedDb(entry.id);
      if (archivedGlb) {
        const isOffline = entry.outcome === 'offline_contour_glb';
        const isModular = entry.outcome === 'modular_structural_glb';
        setReconstructionMode(isOffline || isModular ? 'offline' : 'tripo');
        setReconstructionSource(
          isModular
            ? 'modular_structural'
            : isOffline
              ? 'offline_contour'
              : 'restored_archive'
        );
        setSelectedOptionId(entry.selectedOptionId ?? null);
        setSelectedOptionProvenance(
          isModular && entry.selectedOptionName
            ? `${entry.selectedOptionName} · ${MODULAR_PROVENANCE_PREFIX}`
            : ''
        );
        setVerifiedGlbBuffer(archivedGlb);
        setVerifiedMeshStats(entry.meshStats || null);
        setTripoStatus(isModular ? null : 'success');
        setTripoProgress(100);
        setTripoTaskId(entry.tripoTaskId || null);
        setTripoModelVersion(entry.tripoModelVersion || '');
      }
    }

    setActiveTab('studio');
  };

  const isGenerating =
    tripoStatus === 'uploading' ||
    tripoStatus === 'queued' ||
    tripoStatus === 'running' ||
    tripoStatus === 'downloading_glb' ||
    tripoStatus === 'validating_glb' ||
    tripoStatus === 'offline_reconstructing';

  const activeProvenanceLabel =
    reconstructionSource === 'modular_structural'
      ? selectedOptionProvenance || MODULAR_PROVENANCE_PREFIX
      : reconstructionSource === 'offline_contour'
        ? OFFLINE_FALLBACK_PROVENANCE_LABEL
        : tripoTaskId
          ? `Tripo OpenAPI v3 (${tripoModelVersion || 'v3.1-20260211'}) · Task ${tripoTaskId}`
          : 'Restored Verified GLB Archive';

  const viewerOriginalSketchUrl = analysedOriginalDataUrl ?? activeOriginalPreviewUrl;
  const viewerOriginalSha = analysedOriginalSha256 || activeOriginalSha256;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onNewSketch={handleStartBlankCanvas}
      />

      <main className="flex-1">
        {activeTab === 'dashboard' && (
          <DashboardView
            systemStatus={systemStatus}
            history={history}
            onStartSampleChair={handleStartSampleChair}
            onStartBlankCanvas={handleStartBlankCanvas}
            onStartUploadMode={handleStartUploadMode}
            onOpenHistoryEntry={(entry) => void handleRestoreHistoryEntry(entry)}
            onNavigateTab={setActiveTab}
          />
        )}

        {activeTab === 'studio' && (
          <div className="max-w-[1440px] mx-auto px-6 py-8 space-y-6">
            {/* Restored Session Info Banner */}
            {restoredBanner && (
              <div className="p-3.5 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-between gap-3 text-xs text-blue-950">
                <span>{restoredBanner}</span>
                <button
                  type="button"
                  onClick={() => setRestoredBanner(null)}
                  className="font-semibold text-blue-700 hover:underline whitespace-nowrap"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Stage-by-Stage Pipeline Status & Measured Latency Bar */}
            <div className="bg-white border border-slate-200 rounded-xl px-5 py-3.5 grid grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {cvPrepResult?.metrics.hasForeground ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border border-slate-300 shrink-0" />
                  )}
                  <span className="font-semibold text-slate-900">01. Sketch &amp; CV Prep</span>
                </div>
                <span className="font-mono tabular-nums text-slate-500">
                  {typeof stageTimings.cvPrepMs === 'number' ? `${stageTimings.cvPrepMs}ms` : '—'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {analysisResult ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                  ) : isAnalysing ? (
                    <Loader2 className="w-4 h-4 text-blue-600 animate-spin shrink-0" aria-hidden="true" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border border-slate-300 shrink-0" />
                  )}
                  <span className="font-semibold text-slate-900">02. Vision Audit</span>
                </div>
                <span className="font-mono tabular-nums text-slate-500">
                  {typeof stageTimings.visionAnalysisMs === 'number'
                    ? `${(stageTimings.visionAnalysisMs / 1000).toFixed(2)}s`
                    : '—'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {intentLock?.locked ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border border-slate-300 shrink-0" />
                  )}
                  <span className="font-semibold text-slate-900">03. IntentLock Gate</span>
                </div>
                <span className="font-mono tabular-nums text-slate-500">
                  {intentLock?.locked ? 'Locked' : 'Pending'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {verifiedGlbBuffer ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                  ) : isGenerating ? (
                    <Loader2 className="w-4 h-4 text-blue-600 animate-spin shrink-0" aria-hidden="true" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border border-slate-300 shrink-0" />
                  )}
                  <span className="font-semibold text-slate-900">04. 3D Mesh &amp; GLB</span>
                </div>
                <span className="font-mono tabular-nums text-slate-500">
                  {typeof stageTimings.reconstructionMs === 'number'
                    ? stageTimings.reconstructionMs >= 1000
                      ? `${(stageTimings.reconstructionMs / 1000).toFixed(2)}s`
                      : `${stageTimings.reconstructionMs.toFixed(0)}ms`
                    : '—'}
                </span>
              </div>
            </div>

            {/* Honest Provider Disclosure Banner */}
            {systemStatus && !systemStatus.tripoConfigured && (
              <div className="p-3.5 rounded-lg bg-slate-900 text-slate-100 border border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                <span>
                  <strong className="text-white">Three-Option Modular 3D Synthesis Active:</strong>{' '}
                  Gemini Vision Audit + IntentLock + <strong>Three Selectable 3D Reconstruction Concepts (Options A, B &amp; C)</strong> generate multi-part exportable <code className="font-mono text-blue-300">.GLB</code> &amp; <code className="font-mono text-blue-300">.OBJ</code> models locally for chairs, tables, vessels, lamps, shelves, and brackets (<code className="font-mono text-slate-300">TRIPO_API_KEY</code> optional for cloud neural freeform generation).
                </span>
                <button
                  type="button"
                  onClick={() => setActiveTab('docs')}
                  className="font-semibold text-blue-300 underline hover:text-white whitespace-nowrap shrink-0"
                >
                  Architecture &amp; Attribution
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* LEFT COLUMN: 01. Sketch Input, CV Preparation & Design Hints */}
              <div className="lg:col-span-5 space-y-6">
                <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
                    <div>
                      <p className="text-xs text-slate-500">01. Original 2D Input</p>
                      <h1 className="text-lg font-display font-bold text-slate-900">
                        Sketch Workspace
                      </h1>
                    </div>

                    <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                      <button
                        type="button"
                        onClick={() => {
                          setSourceMode('canvas');
                          resetDownstreamPipeline();
                        }}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                          sourceMode === 'canvas'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <PenTool className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Drafting Canvas</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSourceMode('upload');
                          resetDownstreamPipeline();
                        }}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                          sourceMode === 'upload'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Upload Sketch</span>
                      </button>
                    </div>
                  </div>

                  {sourceMode === 'canvas' ? (
                    <DrawingCanvas
                      onSketchChange={handleCanvasSketchChange}
                      onApplyPresetHints={(presetHints) => {
                        setHints(presetHints);
                        resetDownstreamPipeline();
                      }}
                      externalPresetTrigger={presetTrigger}
                    />
                  ) : (
                    <SketchUploadPanel
                      uploadedSketch={uploadedSketch}
                      onSelectValidUpload={handleSelectValidUpload}
                      onClearUpload={handleClearUpload}
                    />
                  )}
                </section>

                {/* 01B. Deterministic Computer Vision Preprocessing & Comparison */}
                <SketchPreprocessPanel
                  originalPreviewUrl={activeOriginalPreviewUrl}
                  originalSha256={activeOriginalSha256}
                  prepResult={cvPrepResult}
                  isPreprocessing={isPreprocessing}
                  illuminationCorrection={illuminationCorrection}
                  onToggleIlluminationCorrection={setIlluminationCorrection}
                  pipelineImageChoice={pipelineImageChoice}
                  onSelectPipelineImageChoice={setPipelineImageChoice}
                />

                {/* Optional Design Context Inputs */}
                <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-display font-bold text-slate-900">
                      Optional Design Parameters
                    </h2>
                    <span className="text-xs text-slate-500">
                      Guides Vision Audit &amp; Material Preview
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 text-xs">
                    <div className="space-y-1">
                      <label htmlFor="hint-object-type" className="block font-medium text-slate-700">
                        Object Type
                      </label>
                      <input
                        id="hint-object-type"
                        type="text"
                        value={hints.objectType}
                        onChange={(e) => setHints((h) => ({ ...h, objectType: e.target.value }))}
                        placeholder="e.g., Mid-century lounge chair"
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:border-blue-600"
                      />
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="hint-material" className="block font-medium text-slate-700">
                        Material
                      </label>
                      <input
                        id="hint-material"
                        type="text"
                        value={hints.material}
                        onChange={(e) => setHints((h) => ({ ...h, material: e.target.value }))}
                        placeholder="e.g., Molded walnut & bouclé"
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:border-blue-600"
                      />
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="hint-colour" className="block font-medium text-slate-700">
                        Colour
                      </label>
                      <input
                        id="hint-colour"
                        type="text"
                        value={hints.colour}
                        onChange={(e) => setHints((h) => ({ ...h, colour: e.target.value }))}
                        placeholder="e.g., Warm walnut & oat cream"
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:border-blue-600"
                      />
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="hint-style" className="block font-medium text-slate-700">
                        Style
                      </label>
                      <input
                        id="hint-style"
                        type="text"
                        value={hints.style}
                        onChange={(e) => setHints((h) => ({ ...h, style: e.target.value }))}
                        placeholder="e.g., Scandinavian industrial"
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:border-blue-600"
                      />
                    </div>
                  </div>

                  {analysisError && (
                    <div
                      role="alert"
                      className="p-3.5 rounded-lg bg-red-50 border border-red-200 space-y-2 text-xs text-red-900"
                    >
                      <div className="flex items-start gap-2.5">
                        <AlertCircle
                          className="w-4 h-4 text-red-600 shrink-0 mt-0.5"
                          aria-hidden="true"
                        />
                        <div>
                          <p className="font-semibold">{analysisError.title}</p>
                          <p className="mt-0.5 text-red-800">{analysisError.message}</p>
                          {analysisError.suggestion && (
                            <p className="mt-1 font-medium">{analysisError.suggestion}</p>
                          )}
                        </div>
                      </div>
                      {cvPrepResult?.metrics.hasForeground && (
                        <div className="pt-1 pl-6 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleRunLocalCvThreeOptionAudit()}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors whitespace-nowrap"
                          >
                            <Box className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Compare 3 Modular 3D Options (Local CV + Hints)</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRunOfflineReconstruction()}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-red-300 rounded-md hover:bg-red-100/50 transition-colors whitespace-nowrap"
                          >
                            <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Limited Raw Contour Extrusion</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={isAnalysing || isGenerating}
                    onClick={() => void handleRunVisionAnalysis()}
                    className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    {isAnalysing ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                        <span>Analysing 2D Sketch with Gemini Vision…</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" aria-hidden="true" />
                        <span>
                          {analysisResult
                            ? 'Re-Analyse Current Sketch'
                            : 'Analyse Sketch & Build Design Map'}
                        </span>
                      </>
                    )}
                  </button>
                </section>
              </div>

              {/* RIGHT COLUMN: 02. Vision Audit -> 03. IntentLock -> 04. Tripo v3 / Offline 3D & Three.js GLB Viewer */}
              <div className="lg:col-span-7 space-y-6">
                {!analysisResult && !isAnalysing && !verifiedGlbBuffer && !tripoStatus && (
                  <section className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-4">
                    <div className="w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center mx-auto text-slate-600">
                      <Box className="w-6 h-6" aria-hidden="true" />
                    </div>
                    <div className="space-y-1.5 max-w-md mx-auto">
                      <h2 className="text-lg font-display font-bold text-slate-900">
                        Ready for Sketch Audit &amp; 3D Reconstruction
                      </h2>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        Draw or upload a sketch on the left, then click{' '}
                        <strong>Analyse Sketch &amp; Build Design Map</strong>. Gemini Vision maps visible strokes versus occluded geometry estimates before unlocking Tripo v3 or Offline Contour 3D reconstruction.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                      <button
                        type="button"
                        onClick={handleStartSampleChair}
                        className="px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors whitespace-nowrap"
                      >
                        Load Sample Chair Sketch Preset
                      </button>
                      {cvPrepResult?.metrics.hasForeground && (
                        <button
                          type="button"
                          onClick={() => void handleRunLocalCvThreeOptionAudit()}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap"
                        >
                          <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Local CV 3-Option 3D Preview</span>
                        </button>
                      )}
                    </div>
                  </section>
                )}

                {isAnalysing && (
                  <section className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
                    <Loader2
                      className="w-7 h-7 text-blue-600 animate-spin mx-auto"
                      aria-hidden="true"
                    />
                    <p className="text-sm font-semibold text-slate-900">
                      Inspecting 2D Strokes &amp; Occluded Depth Ambiguities…
                    </p>
                    <p className="text-xs text-slate-500">
                      Separating observed components from inferred hidden geometry via{' '}
                      {systemStatus?.geminiModel || 'gemini-3.1-flash-lite'}
                    </p>
                  </section>
                )}

                {analysisResult && (
                  <>
                    <AnalysisAndDesignMap
                      analysis={analysisResult}
                      sketchSha256={analysedOriginalSha256}
                      modelUsed={analysisModelUsed}
                      analysisDurationMs={stageTimings.visionAnalysisMs}
                    />

                    <IntentLockPanel
                      analysis={analysisResult}
                      sketchSha256={analysedOriginalSha256}
                      intentLock={intentLock}
                      compiledSpec={compiledSpec}
                      disabled={isGenerating}
                      onLockIntent={(record) => setIntentLock(record)}
                      onUnlockIntent={() => {
                        setIntentLock(null);
                        setTripoStatus(null);
                        setTripoError(null);
                      }}
                    />

                    {/* Step 3: Three Selectable 3D Reconstruction Concepts (Option A, Option B, Option C) */}
                    <ReconstructionOptionsPanel
                      options={synthesizedOptions}
                      isSynthesizing={isSynthesizingOptions}
                      selectedOptionId={selectedOptionId}
                      tripoConfigured={Boolean(systemStatus?.tripoConfigured)}
                      isGeneratingCloud={isGenerating}
                      onSelectOption={(optId) => void handleSelectReconstructionOption(optId)}
                      onGenerateCloudForOption={
                        systemStatus?.tripoConfigured
                          ? (optId) => {
                              setSelectedOptionId(optId);
                              void handleStart3DGeneration();
                            }
                          : undefined
                      }
                      onRunLimitedContourFallback={() => {
                        setSelectedOptionId(null);
                        void handleRunOfflineReconstruction();
                      }}
                    />

                    {/* Optional Cloud Tripo v3 / Audit Save Controls */}
                    {intentLock?.locked && !isGenerating && systemStatus?.tripoConfigured && (
                      <section className="bg-slate-900 text-white border border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
                        <div className="space-y-0.5 max-w-xl">
                          <p className="text-xs text-blue-300 font-medium">
                            Cloud Neural Image-to-3D Available
                          </p>
                          <p className="text-xs text-slate-300 leading-relaxed">
                            Execute Tripo OpenAPI v3 ({systemStatus.tripoModelVersion || 'v3.1-20260211'}) using your preserved original sketch alongside the modular options above.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleStart3DGeneration()}
                            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-500 transition-colors whitespace-nowrap shrink-0"
                          >
                            <Box className="w-4 h-4" aria-hidden="true" />
                            <span>Run Cloud Tripo v3</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void saveDemoRecordToHistory(analysisResult, intentLock)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 bg-slate-800 border border-slate-700 rounded-lg hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
                          >
                            <BookmarkCheck className="w-4 h-4" aria-hidden="true" />
                            <span>Save Audit Only</span>
                          </button>
                        </div>
                      </section>
                    )}
                  </>
                )}

                <GenerationProgressPanel
                  status={tripoStatus}
                  progress={tripoProgress}
                  elapsedSeconds={elapsedSeconds}
                  timeoutSeconds={systemStatus?.limits.pollTimeoutSeconds ?? 180}
                  taskId={tripoTaskId}
                  tripoModelVersion={tripoModelVersion || systemStatus?.tripoModelVersion}
                  reconstructionMode={reconstructionMode}
                  offlineSummary={offlineSummary}
                  error={tripoError}
                  tripoConfigured={Boolean(systemStatus?.tripoConfigured)}
                  onRetry={() =>
                    void (reconstructionMode === 'offline'
                      ? handleRunOfflineReconstruction()
                      : handleStart3DGeneration())
                  }
                  onRunOfflineFallback={() => void handleRunOfflineReconstruction()}
                  onCancel={stopGenerationTimers}
                />

                {/* Selected 3D Model + Side-by-Side Original 2D Sketch & SHA-256 Integrity Verification */}
                {verifiedGlbBuffer && (
                  <section ref={viewerSectionRef} className="space-y-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">
                          04. Selected 3D Reconstruction &amp; Export Studio
                        </p>
                        <h2 className="text-lg font-display font-bold text-slate-900">
                          Interactive 3D Studio Viewport &amp; Original Sketch Verification
                        </h2>
                      </div>
                      {verifiedMeshStats && (
                        <span className="text-xs font-mono tabular-nums text-emerald-700">
                          Validated GLB v{verifiedMeshStats.glbVersion} ·{' '}
                          {verifiedMeshStats.nonEmptyMeshCount} 3D part
                          {verifiedMeshStats.nonEmptyMeshCount === 1 ? '' : 's'} ·{' '}
                          {verifiedMeshStats.vertexCount.toLocaleString()} verts ·{' '}
                          {verifiedMeshStats.triangleCount.toLocaleString()} tris
                        </span>
                      )}
                    </div>

                    {/* Side-by-Side Original Sketch + SHA-256 Integrity & Active Reconstruction Summary */}
                    {viewerOriginalSketchUrl && (
                      <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
                        <div className="sm:col-span-4 aspect-[4/3] bg-slate-50 border border-slate-200 rounded-lg p-2 flex items-center justify-center overflow-hidden">
                          <img
                            src={viewerOriginalSketchUrl}
                            alt="Preserved original 2D sketch"
                            className="max-w-full max-h-full object-contain bg-white rounded"
                          />
                        </div>
                        <div className="sm:col-span-8 space-y-2 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-slate-900">
                              Preserved Original 2D Sketch Alongside Selected 3D Model
                            </span>
                            {synthesizedOptions.length === 3 &&
                              synthesizedOptions[0]?.option.supported && (
                                <div className="inline-flex items-center gap-1 bg-slate-100 p-0.5 rounded-md">
                                  {synthesizedOptions.map((optItem) => (
                                    <button
                                      key={optItem.option.id}
                                      type="button"
                                      onClick={() =>
                                        void handleSelectReconstructionOption(optItem.option.id)
                                      }
                                      className={`px-2 py-1 text-[11px] font-semibold rounded transition-colors ${
                                        selectedOptionId === optItem.option.id &&
                                        reconstructionSource === 'modular_structural'
                                          ? 'bg-blue-600 text-white'
                                          : 'text-slate-600 hover:text-slate-900'
                                      }`}
                                    >
                                      {optItem.option.code.replace('OPTION ', 'Opt ')}
                                    </button>
                                  ))}
                                </div>
                              )}
                          </div>

                          <p className="text-slate-600 leading-relaxed">
                            {offlineSummary || activeProvenanceLabel}
                          </p>

                          {viewerOriginalSha && (
                            <div className="p-2 rounded bg-slate-50 border border-slate-200 font-mono text-[11px] tabular-nums text-slate-700 break-all">
                              <span className="text-slate-500">Original Sketch SHA-256: </span>
                              <span>{viewerOriginalSha}</span>
                            </div>
                          )}

                          {reconstructionSource === 'modular_structural' &&
                            selectedOptionId &&
                            (() => {
                              const activeOpt = synthesizedOptions.find(
                                (o) => o.option.id === selectedOptionId
                              );
                              if (!activeOpt || activeOpt.componentNames.length === 0) return null;
                              return (
                                <p className="text-[11px] text-slate-500 leading-snug">
                                  <strong className="text-slate-700">
                                    Synthesized 3D Components ({activeOpt.componentNames.length}):
                                  </strong>{' '}
                                  {activeOpt.componentNames.join(', ')}
                                </p>
                              );
                            })()}
                        </div>
                      </div>
                    )}

                    <ModelViewer3D
                      glbBuffer={verifiedGlbBuffer}
                      modelName={compiledSpec.objectName}
                      provenanceLabel={activeProvenanceLabel}
                      reconstructionSource={reconstructionSource}
                      reconstructionSpec={compiledSpec}
                      originalSketchUrl={viewerOriginalSketchUrl}
                      originalSketchSha256={viewerOriginalSha}
                      onStatsValidated={(stats) => setVerifiedMeshStats(stats)}
                    />
                  </section>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <HistoryView
            history={history}
            onInspectEntry={(entry) => void handleRestoreHistoryEntry(entry)}
            onDeleteEntry={(id) => {
              void removeHistoryEntry(id).then(setHistory);
            }}
            onClearAll={() => {
              void clearAllHistory().then(() => setHistory([]));
            }}
            onStartNewSketch={handleStartBlankCanvas}
          />
        )}

        {activeTab === 'diagnostics' && (
          <DiagnosticsView
            systemStatus={systemStatus}
            onLaunchSampleChairInStudio={handleStartSampleChair}
            onLaunchUploadInStudio={handleStartUploadMode}
          />
        )}

        {activeTab === 'docs' && <DocsView />}
      </main>

      <footer className="bg-white border-t border-slate-200 mt-12">
        <div className="max-w-[1440px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <span>
            Sketch2Shape — IntentLock 3D · Original 2D sketches preserved verbatim with SHA-256 verification
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setActiveTab('diagnostics')}
              className="hover:text-slate-900 transition-colors whitespace-nowrap"
            >
              Diagnostics
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setActiveTab('docs')}
              className="hover:text-slate-900 transition-colors whitespace-nowrap"
            >
              Setup &amp; Attribution
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
