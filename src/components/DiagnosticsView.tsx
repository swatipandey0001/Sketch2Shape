import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Loader2,
  Play,
} from 'lucide-react';
import type {
  ApiStructuredError,
  SketchAnalysisResult,
  SystemStatusResponse,
  ValidatedMeshStats,
} from '../types/studio';
import { renderPresetOnCanvas } from '../utils/sketchPresets';
import {
  buildCalibrationChairGlbBuffer,
  validateAndParseGlbBuffer,
} from '../utils/glbValidator';
import { compileIntentReconstructionSpec } from '../utils/intentCompiler';
import {
  OFFLINE_FALLBACK_PROVENANCE_LABEL,
  reconstructOffline3DFromBlob,
} from '../utils/sketchTo3DFallback';
import { ModelViewer3D } from './ModelViewer3D';
import { readApiJson } from '../utils/apiClient';

interface DiagnosticsViewProps {
  systemStatus: SystemStatusResponse | null;
  onLaunchSampleChairInStudio: () => void;
  onLaunchUploadInStudio: () => void;
}

interface TestLogItem {
  id: string;
  workflow: string;
  passed: boolean;
  summary: string;
  details: string;
  timestamp: string;
}

export const DiagnosticsView: React.FC<DiagnosticsViewProps> = ({
  systemStatus,
  onLaunchSampleChairInStudio,
  onLaunchUploadInStudio,
}) => {
  const [runningId, setRunningId] = useState<string | null>(null);
  const [logs, setLogs] = useState<TestLogItem[]>([]);
  const [simulatedErrorPreview, setSimulatedErrorPreview] = useState<ApiStructuredError | null>(
    null
  );
  const [previewGlb, setPreviewGlb] = useState<{
    buffer: ArrayBuffer;
    name: string;
    label: string;
    isCalibration: boolean;
    stats: ValidatedMeshStats;
  } | null>(null);

  const appendLog = (entry: Omit<TestLogItem, 'id' | 'timestamp'>) => {
    setLogs((prev) => [
      {
        ...entry,
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toLocaleTimeString(),
      },
      ...prev,
    ]);
  };

  // Workflow 1: Sample Chair Sketch -> Live Gemini Multimodal Vision Audit
  const runSampleChairAnalysisTest = async () => {
    setRunningId('sample_chair');
    try {
      const offscreen = document.createElement('canvas');
      offscreen.width = 768;
      offscreen.height = 576;
      renderPresetOnCanvas(offscreen, 'lounge_chair');

      const blob = await new Promise<Blob | null>((resolve) =>
        offscreen.toBlob((b) => resolve(b), 'image/png', 1)
      );
      if (!blob) throw new Error('Could not encode sample chair PNG.');

      const fd = new FormData();
      fd.append('sketch', blob, 'sample_lounge_chair.png');
      fd.append(
        'hints',
        JSON.stringify({
          objectType: 'Mid-century modern lounge chair',
          material: 'Walnut plywood & bouclé cushion',
          colour: 'Warm walnut & oat cream',
          style: 'Scandinavian industrial design',
        })
      );

      const resp = await fetch('/api/sketch/analyze', {
        method: 'POST',
        body: fd,
      });
      const parsed = await readApiJson<{
        analysis: SketchAnalysisResult;
        modelUsed?: string;
        analysisDurationMs?: number;
        sketchSha256: string;
      }>(resp, 'POST /api/sketch/analyze');

      if (!parsed.ok) {
        appendLog({
          workflow: '1. Sample Chair Sketch Vision Workflow',
          passed: false,
          summary: `Server returned HTTP ${parsed.status} (${parsed.error.code})`,
          details: parsed.error.message,
        });
        return;
      }

      const a = parsed.data.analysis;
      const hasAllFields =
        Boolean(a?.object_name) &&
        Array.isArray(a?.visible_components) &&
        Array.isArray(a?.observed_features) &&
        Array.isArray(a?.uncertain_features) &&
        Array.isArray(a?.inferred_features) &&
        typeof a?.proportions_description === 'string' &&
        Boolean(a?.material_preferences) &&
        typeof a?.reconstruction_notes === 'string';

      appendLog({
        workflow: '1. Sample Chair Sketch Vision Workflow',
        passed: hasAllFields,
        summary: `Model ${parsed.data.modelUsed || 'gemini'} identified "${a.object_name}" in ${parsed.data.analysisDurationMs ?? 0}ms (${a.observed_features.length} observed, ${a.uncertain_features.length} uncertain).`,
        details: `SHA-256: ${String(parsed.data.sketchSha256).slice(0, 16)}… · All 8 structured JSON keys verified.`,
      });
    } catch (err: unknown) {
      appendLog({
        workflow: '1. Sample Chair Sketch Vision Workflow',
        passed: false,
        summary: 'Network or runtime exception during analysis test',
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningId(null);
    }
  };

  // Workflow 2: Upload Validation (Disguised SVG Rejection + Empty File Rejection)
  const runUploadValidationTest = async () => {
    setRunningId('upload_validation');
    try {
      const fakePng = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], {
        type: 'image/png',
      });
      const fdFake = new FormData();
      fdFake.append('sketch', fakePng, 'disguised_vector.png');
      const rFake = await fetch('/api/sketch/analyze', { method: 'POST', body: fdFake });
      const pFake = await readApiJson(rFake, 'POST /api/sketch/analyze');

      const emptyFile = new Blob([], { type: 'image/webp' });
      const fdEmpty = new FormData();
      fdEmpty.append('sketch', emptyFile, 'empty.webp');
      const rEmpty = await fetch('/api/sketch/analyze', { method: 'POST', body: fdEmpty });
      const pEmpty = await readApiJson(rEmpty, 'POST /api/sketch/analyze');

      const fakeCode = !pFake.ok ? pFake.error.code : 'OK';
      const emptyCode = !pEmpty.ok ? pEmpty.error.code : 'OK';

      const passed =
        rFake.status === 415 &&
        fakeCode === 'UNSUPPORTED_FILE_FORMAT' &&
        rEmpty.status === 400 &&
        emptyCode === 'EMPTY_SKETCH_FILE';

      appendLog({
        workflow: '2. Sketch Upload & Magic-Byte Validation',
        passed,
        summary: passed
          ? 'Correctly rejected disguised SVG-as-PNG (HTTP 415) and 0-byte WebP upload (HTTP 400).'
          : 'Unexpected validation status codes.',
        details: `Disguised SVG -> ${rFake.status} (${fakeCode}); Empty WebP -> ${rEmpty.status} (${emptyCode}).`,
      });
    } catch (err: unknown) {
      appendLog({
        workflow: '2. Sketch Upload & Magic-Byte Validation',
        passed: false,
        summary: 'Upload validation check threw an exception',
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningId(null);
    }
  };

  // Workflow 3: Missing-Key Guard Honesty Check
  const runMissingKeyWorkflowTest = async () => {
    setRunningId('missing_key');
    try {
      let resp: Response;
      if (!systemStatus?.tripoConfigured) {
        const off = document.createElement('canvas');
        off.width = 256;
        off.height = 256;
        const ctx = off.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 256, 256);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(64, 64, 128, 128);
        const validPng = await new Promise<Blob>((res) =>
          off.toBlob((b) => res(b!), 'image/png')
        );
        const fd = new FormData();
        fd.append('sketch', validPng, 'probe.png');
        resp = await fetch('/api/tripo/generate', { method: 'POST', body: fd });
      } else {
        resp = await fetch('/api/diagnostics/simulate-failure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: 'missing_key' }),
        });
      }

      const parsed = await readApiJson(resp, 'Missing-Key Probe');
      const passed = !parsed.ok && parsed.error.code === 'MISSING_TRIPO_API_KEY';
      if (!parsed.ok) {
        setSimulatedErrorPreview(parsed.error);
      }

      appendLog({
        workflow: '3. Missing-Key Guard & Fallback Guidance',
        passed,
        summary: passed
          ? `Verified HTTP ${resp.status} MISSING_TRIPO_API_KEY response directing user to Offline Contour 3D Reconstruction.`
          : `Unexpected HTTP ${resp.status}`,
        details: !parsed.ok ? parsed.error.message : '',
      });
    } catch (err: unknown) {
      appendLog({
        workflow: '3. Missing-Key Guard & Fallback Guidance',
        passed: false,
        summary: 'Missing-key probe failed',
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningId(null);
    }
  };

  // Workflow 4: API Failure, Insufficient Credits (2010), Auth (1002), Timeout & Malformed Response
  const runApiFailureWorkflowTest = async (
    scenario: 'insufficient_credits' | 'auth_failed' | 'timeout' | 'malformed_response'
  ) => {
    setRunningId(`failure_${scenario}`);
    try {
      const resp = await fetch('/api/diagnostics/simulate-failure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      const parsed = await readApiJson(resp, 'POST /api/diagnostics/simulate-failure');
      const errObj = !parsed.ok ? parsed.error : undefined;
      if (errObj) {
        setSimulatedErrorPreview(errObj);
      }

      appendLog({
        workflow: `4. API Failure Workflow (${scenario})`,
        passed: !parsed.ok && resp.status >= 400 && Boolean(errObj?.code),
        summary: `Handled HTTP ${resp.status} -> ${errObj?.code} (${errObj?.title})`,
        details: `${errObj?.message || ''} — Action: ${errObj?.suggestion || ''}`,
      });
    } catch (err: unknown) {
      appendLog({
        workflow: `4. API Failure Workflow (${scenario})`,
        passed: false,
        summary: 'Error probe request failed',
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningId(null);
    }
  };

  // Workflow 5: Binary GLB Validator (Static PNG + Truncated GLB Rejection + Calibration Mesh)
  const runGlbValidatorSelfTest = async () => {
    setRunningId('glb_validator');
    try {
      let rejectedFakeImage = false;
      const fakePngHeader = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]).buffer;
      try {
        await validateAndParseGlbBuffer(fakePngHeader);
      } catch {
        rejectedFakeImage = true;
      }

      // Negative test B: Truncated GLB (valid magic & version 2, declaredLength 4096, actual 48 bytes)
      let rejectedTruncatedGlb = false;
      const truncBuf = new ArrayBuffer(48);
      const dv = new DataView(truncBuf);
      dv.setUint32(0, 0x46546c67, true);
      dv.setUint32(4, 2, true);
      dv.setUint32(8, 4096, true);
      dv.setUint32(12, 128, true);
      dv.setUint32(16, 0x4e4f534a, true);
      try {
        await validateAndParseGlbBuffer(truncBuf);
      } catch {
        rejectedTruncatedGlb = true;
      }

      const glbBuf = await buildCalibrationChairGlbBuffer();
      const { scene, stats } = await validateAndParseGlbBuffer(glbBuf);
      scene.traverse((child) => {
        const m = child as { isMesh?: boolean; geometry?: { dispose: () => void } };
        if (m.isMesh) m.geometry?.dispose();
      });

      setPreviewGlb({
        buffer: glbBuf,
        name: 'Calibration_Lounge_Chair',
        label:
          'Local GLTFExporter Binary Self-Test (Strictly Calibration Sample — Never Used as User Output)',
        isCalibration: true,
        stats,
      });

      const passed =
        rejectedFakeImage &&
        rejectedTruncatedGlb &&
        stats.nonEmptyMeshCount >= 1 &&
        stats.vertexCount > 0 &&
        stats.dimensions.x > 0 &&
        stats.dimensions.y > 0 &&
        stats.dimensions.z > 0;

      appendLog({
        workflow: '5. Binary GLB Integrity & Truncation Guard',
        passed,
        summary: `Rejected static PNG & truncated GLB; validated binary GLB (${stats.nonEmptyMeshCount} meshes, ${stats.vertexCount.toLocaleString()} verts, ${stats.dimensions.x} × ${stats.dimensions.y} × ${stats.dimensions.z} u).`,
        details: `Declared length ${stats.declaredLengthBytes} bytes === actual ${stats.fileSizeBytes} bytes.`,
      });
    } catch (err: unknown) {
      appendLog({
        workflow: '5. Binary GLB Integrity & Truncation Guard',
        passed: false,
        summary: 'GLB validation self-test failed',
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningId(null);
    }
  };

  // Workflow 6: Fresh Asymmetric Sketch -> Local Contour-Reconstructed 3D Mesh Verification
  const runOfflineContourFreshSketchTest = async () => {
    setRunningId('offline_contour');
    try {
      const off = document.createElement('canvas');
      off.width = 512;
      off.height = 512;
      const ctx = off.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 512, 512);

      // Draw a fresh asymmetric cantilevered L-bracket with a circular mounting aperture
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.moveTo(110, 90);
      ctx.lineTo(220, 90);
      ctx.lineTo(220, 310);
      ctx.lineTo(410, 310);
      ctx.lineTo(410, 415);
      ctx.lineTo(110, 415);
      ctx.closePath();
      ctx.fill();

      // Cut interior circular mounting hole
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(165, 155, 26, 0, Math.PI * 2);
      ctx.fill();

      const sketchBlob = await new Promise<Blob>((resolve, reject) =>
        off.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png')
      );

      const spec = compileIntentReconstructionSpec(
        {
          objectType: 'Asymmetric Cantilever Bracket',
          material: 'Brushed aluminum',
          colour: 'Silver slate',
          style: 'Industrial',
        },
        {
          object_name: 'Asymmetric Cantilever Bracket',
          visible_components: ['Vertical stem', 'Horizontal cantilever arm', 'Circular aperture'],
          observed_features: ['Asymmetric L-profile', 'Circular through-hole'],
          uncertain_features: [],
          inferred_features: ['Uniform extrusion depth'],
          proportions_description: '1:1.08 aspect ratio',
          material_preferences: {
            primary_material: 'Brushed aluminum',
            secondary_material: 'Steel',
            colour_palette: 'Silver',
            surface_finish: 'Brushed',
            source_note: 'Diagnostic spec',
          },
          reconstruction_notes: 'Preserve L-silhouette and interior hole.',
        },
        null
      );

      const output = await reconstructOffline3DFromBlob(sketchBlob, spec);
      setPreviewGlb({
        buffer: output.glbBuffer,
        name: 'Asymmetric_Cantilever_Bracket',
        label: OFFLINE_FALLBACK_PROVENANCE_LABEL,
        isCalibration: false,
        stats: output.stats,
      });

      const passed =
        output.modeUsed === 'contour_extrusion' &&
        output.stats.nonEmptyMeshCount >= 1 &&
        output.stats.vertexCount >= 24 &&
        output.stats.dimensions.z > 0.05;

      appendLog({
        workflow: '6. Fresh Asymmetric Sketch -> Offline Contour 3D Mesh',
        passed,
        summary: `Reconstructed ${output.modeUsed} mesh in ${output.durationMs}ms (${output.stats.vertexCount.toLocaleString()} verts, ${output.stats.dimensions.x} × ${output.stats.dimensions.y} × ${output.stats.dimensions.z} u).`,
        details: output.geometrySummary,
      });
    } catch (err: unknown) {
      appendLog({
        workflow: '6. Fresh Asymmetric Sketch -> Offline Contour 3D Mesh',
        passed: false,
        summary: 'Offline contour reconstruction test failed',
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-8 space-y-8">
      <div className="space-y-1 pb-5 border-b border-slate-200">
        <h1 className="text-2xl font-display font-bold text-slate-900">
          Pipeline Diagnostics &amp; Workflow Verifier
        </h1>
        <p className="text-sm text-slate-600 max-w-3xl">
          Interactive verification suite exercising live Gemini multimodal vision, magic-byte file upload guards, Tripo v3 error handling, binary GLB truncation/coordinate checks, and fresh-sketch Offline Contour 3D reconstruction.
        </p>
      </div>

      {/* 6 Workflow Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {/* 1. Sample Chair Workflow */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-display font-bold text-slate-900">
              01. Live Gemini Vision Audit Workflow
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Renders the 3/4 lounge chair sketch, submits it to <code className="font-mono">/api/sketch/analyze</code>, and verifies all 8 normalized JSON fields + actual model latency.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              disabled={runningId !== null}
              onClick={() => void runSampleChairAnalysisTest()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {runningId === 'sample_chair' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Run Live Vision Test</span>
            </button>
            <button
              type="button"
              onClick={onLaunchSampleChairInStudio}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              <span>Open in Studio</span>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* 2. Upload Validation Workflow */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-display font-bold text-slate-900">
              02. Upload &amp; Magic-Byte Guard Workflow
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Verifies server magic-byte rejection of disguised SVG/non-image files (HTTP 415) and empty 0-byte uploads (HTTP 400).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              disabled={runningId !== null}
              onClick={() => void runUploadValidationTest()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {runningId === 'upload_validation' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Verify Upload Guards</span>
            </button>
            <button
              type="button"
              onClick={onLaunchUploadInStudio}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              <span>Upload File</span>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* 3. Missing-Key Guard Workflow */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-display font-bold text-slate-900">
              03. Missing-Key &amp; Fallback Guard
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Verifies that missing <code className="font-mono">TRIPO_API_KEY</code> returns structured JSON setup guidance and directs users to Offline Contour 3D Reconstruction.
            </p>
          </div>
          <div className="pt-2">
            <button
              type="button"
              disabled={runningId !== null}
              onClick={() => void runMissingKeyWorkflowTest()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {runningId === 'missing_key' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Verify Missing-Key Guard</span>
            </button>
          </div>
        </div>

        {/* 4. API Failure / Credit / Timeout Workflow */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-display font-bold text-slate-900">
              04. Tripo v3 Error &amp; Credit Handlers
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Exercises error handlers for Tripo #2010 Insufficient Credits, #1002 Auth Failure, Polling Timeout, and Malformed JSON responses.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 pt-2">
            {(
              [
                { id: 'insufficient_credits', label: 'Credits (#2010)' },
                { id: 'auth_failed', label: 'Auth (#1002)' },
                { id: 'timeout', label: 'Timeout (408)' },
                { id: 'malformed_response', label: 'Malformed (422)' },
              ] as const
            ).map((btn) => (
              <button
                key={btn.id}
                type="button"
                disabled={runningId !== null}
                onClick={() => void runApiFailureWorkflowTest(btn.id)}
                className="px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>

        {/* 5. Binary GLB Integrity & Truncation Guard */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-display font-bold text-slate-900">
              05. Binary GLB Truncation &amp; Mesh Validator
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Verifies rejection of static PNGs and truncated GLB headers (<code className="font-mono">declaredLength &gt; byteLength</code>), then validates a calibration GLB in Three.js.
            </p>
          </div>
          <div className="pt-2">
            <button
              type="button"
              disabled={runningId !== null}
              onClick={() => void runGlbValidatorSelfTest()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {runningId === 'glb_validator' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Run GLB Integrity Self-Test</span>
            </button>
          </div>
        </div>

        {/* 6. Fresh Asymmetric Sketch -> Offline Contour 3D Mesh */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-display font-bold text-slate-900">
              06. Fresh Asymmetric Sketch → Offline 3D
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Draws an unseen asymmetric cantilevered L-bracket with an interior hole, runs CV contour extraction + extrusion, and mounts the validated <code className="font-mono">.GLB</code>.
            </p>
          </div>
          <div className="pt-2">
            <button
              type="button"
              disabled={runningId !== null}
              onClick={() => void runOfflineContourFreshSketchTest()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {runningId === 'offline_contour' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Test Fresh Contour 3D Mesh</span>
            </button>
          </div>
        </div>
      </div>

      {/* Simulated Error Card Inspection */}
      {simulatedErrorPreview && (
        <section className="bg-amber-50/70 border border-amber-200 rounded-xl p-5 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
              <span>Diagnostic Error Handler Preview: {simulatedErrorPreview.title}</span>
            </div>
            <button
              type="button"
              onClick={() => setSimulatedErrorPreview(null)}
              className="text-slate-600 hover:text-slate-900 font-medium whitespace-nowrap"
            >
              Dismiss
            </button>
          </div>
          <p className="text-slate-700">{simulatedErrorPreview.message}</p>
          {simulatedErrorPreview.suggestion && (
            <p className="font-medium text-slate-900">
              Recovery guidance: {simulatedErrorPreview.suggestion}
            </p>
          )}
        </section>
      )}

      {/* Diagnostic 3D Viewport Output */}
      {previewGlb && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-display font-bold text-slate-900">
              Three.js Diagnostic 3D Viewport
            </h2>
            <span className="text-xs font-mono tabular-nums text-emerald-700">
              Passed validation: {previewGlb.stats.nonEmptyMeshCount} non-empty mesh
              {previewGlb.stats.nonEmptyMeshCount === 1 ? '' : 'es'} ·{' '}
              {previewGlb.stats.vertexCount.toLocaleString()} vertices
            </span>
          </div>
          <ModelViewer3D
            glbBuffer={previewGlb.buffer}
            modelName={previewGlb.name}
            provenanceLabel={previewGlb.label}
            reconstructionSource={previewGlb.isCalibration ? 'calibration_sample' : 'offline_contour'}
            isCalibrationSample={previewGlb.isCalibration}
          />
        </section>
      )}

      {/* Execution Results Log */}
      {logs.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-display font-bold text-slate-900">
              Verification Execution Results
            </h2>
            <button
              type="button"
              onClick={() => setLogs([])}
              className="text-xs text-slate-500 hover:text-slate-900 whitespace-nowrap"
            >
              Clear Log
            </button>
          </div>
          <div className="divide-y divide-slate-200">
            {logs.map((log) => (
              <div key={log.id} className="p-4 flex items-start justify-between gap-4 text-xs">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-semibold text-slate-900">
                    {log.passed ? (
                      <CheckCircle2
                        className="w-4 h-4 text-emerald-600 shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <AlertTriangle
                        className="w-4 h-4 text-red-600 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span>{log.workflow}</span>
                  </div>
                  <p className="text-slate-800">{log.summary}</p>
                  <p className="text-slate-500 font-mono">{log.details}</p>
                </div>
                <span className="text-slate-400 font-mono tabular-nums whitespace-nowrap shrink-0">
                  {log.timestamp}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
