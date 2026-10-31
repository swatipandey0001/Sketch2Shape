import React from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  KeyRound,
  Loader2,
  RefreshCw,
  Square,
} from 'lucide-react';
import type { ApiStructuredError, TripoTaskStatus } from '../types/studio';

interface GenerationProgressPanelProps {
  status: TripoTaskStatus | null;
  progress: number;
  elapsedSeconds: number;
  timeoutSeconds: number;
  taskId: string | null;
  tripoModelVersion?: string;
  reconstructionMode?: 'tripo' | 'offline';
  offlineSummary?: string | null;
  error: ApiStructuredError | null;
  tripoConfigured: boolean;
  onRetry: () => void;
  onRunOfflineFallback?: () => void;
  onCancel: () => void;
}

const PIPELINE_STEPS: Array<{ key: TripoTaskStatus; label: string }> = [
  { key: 'uploading', label: '01. Upload Sketch (/v3/files)' },
  { key: 'queued', label: '02. Queue v3 Image-to-Model Task' },
  { key: 'running', label: '03. Synthesize 3D Mesh & PBR' },
  { key: 'downloading_glb', label: '04. Retrieve & Validate GLB Binary' },
];

function getStepIndex(status: TripoTaskStatus | null): number {
  switch (status) {
    case 'uploading':
      return 0;
    case 'queued':
      return 1;
    case 'running':
      return 2;
    case 'downloading_glb':
    case 'validating_glb':
      return 3;
    case 'success':
      return 4;
    default:
      return -1;
  }
}

export const GenerationProgressPanel: React.FC<GenerationProgressPanelProps> = ({
  status,
  progress,
  elapsedSeconds,
  timeoutSeconds,
  taskId,
  tripoModelVersion,
  reconstructionMode = 'tripo',
  offlineSummary = null,
  error,
  tripoConfigured,
  onRetry,
  onRunOfflineFallback,
  onCancel,
}) => {
  if (!status && !error) return null;

  const isRunning =
    status === 'uploading' ||
    status === 'queued' ||
    status === 'running' ||
    status === 'downloading_glb' ||
    status === 'validating_glb' ||
    status === 'offline_reconstructing';

  const currentStepIdx = getStepIndex(status);
  const isMissingKeyError =
    error?.code === 'MISSING_TRIPO_API_KEY' || status === 'demo_blocked';
  const isOfflineMode =
    reconstructionMode === 'offline' || status === 'offline_reconstructing';

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>
              {isOfflineMode
                ? '04. Local Contour-Based 3D Reconstruction (Offline Fallback)'
                : `04. Tripo OpenAPI v3 Pipeline${tripoModelVersion ? ` (${tripoModelVersion})` : ''}`}
            </span>
            {taskId && !isOfflineMode && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">Task {taskId}</span>
              </>
            )}
          </div>
          <h2 className="text-lg font-display font-bold text-slate-900">
            {status === 'offline_reconstructing'
              ? 'Extracting Sketch Contours & Building Local 3D Mesh…'
              : isRunning
                ? 'Generating Exportable 3D GLB Asset…'
                : status === 'success'
                  ? isOfflineMode
                    ? 'Offline Contour 3D Mesh Reconstructed & Validated'
                    : 'Tripo 3D GLB Asset Reconstructed & Validated'
                  : isMissingKeyError
                    ? 'Tripo API Key Missing — Offline 3D Fallback Ready'
                    : '3D Reconstruction Halted'}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {isRunning && status !== 'offline_reconstructing' && (
            <>
              <span className="text-xs font-mono tabular-nums text-slate-600">
                Elapsed: {elapsedSeconds}s / {timeoutSeconds}s limit
              </span>
              <button
                type="button"
                onClick={onCancel}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
              >
                <Square className="w-3 h-3" aria-hidden="true" />
                <span>Cancel</span>
              </button>
            </>
          )}

          {!isRunning && status !== 'success' && (
            <>
              {onRunOfflineFallback && !isOfflineMode && (
                <button
                  type="button"
                  onClick={onRunOfflineFallback}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
                >
                  <Box className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Run Offline Contour 3D Reconstruction</span>
                </button>
              )}

              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {isOfflineMode
                    ? 'Retry Offline Reconstruction'
                    : tripoConfigured
                      ? 'Retry Tripo v3'
                      : 'Re-check Tripo Key'}
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Live Progress Bar & Step Breakdown */}
      {(isRunning || status === 'success') && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-700">
                {status === 'offline_reconstructing' &&
                  'Tracing 8-connected sketch contours, computing depth/lathe topology, and serializing binary .GLB…'}
                {status === 'uploading' && 'Uploading sketch image to Tripo /v3/files…'}
                {status === 'queued' && 'Queued in Tripo v3 GPU cluster…'}
                {status === 'running' && 'Synthesizing 3D mesh topology & PBR texture maps…'}
                {status === 'downloading_glb' && 'Downloading binary .glb model from Tripo…'}
                {status === 'validating_glb' &&
                  'Verifying GLTFLoader parse, finite vertex coordinates, and non-zero 3D bounding box…'}
                {status === 'success' &&
                  (isOfflineMode
                    ? offlineSummary ||
                      'Local contour-reconstructed GLB verified and mounted in Three.js viewport.'
                    : 'Tripo v3 GLB binary verified and mounted in Three.js studio viewport.')}
              </span>
              <span className="font-mono tabular-nums font-semibold text-slate-900">
                {status === 'success' ? '100%' : `${Math.round(progress)}%`}
              </span>
            </div>

            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-transform duration-300 origin-left ${
                  status === 'success'
                    ? isOfflineMode
                      ? 'bg-amber-600'
                      : 'bg-emerald-600'
                    : 'bg-blue-600'
                }`}
                style={{
                  transform: `scaleX(${Math.max(
                    0.04,
                    (status === 'success' ? 100 : progress) / 100
                  )})`,
                }}
              />
            </div>
          </div>

          {!isOfflineMode && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {PIPELINE_STEPS.map((step, idx) => {
                const completed = currentStepIdx > idx || status === 'success';
                const active = currentStepIdx === idx && status !== 'success';
                return (
                  <div
                    key={step.key}
                    className={`p-3 rounded-lg border text-xs flex items-center gap-2.5 ${
                      completed
                        ? 'bg-emerald-50/50 border-emerald-200 text-emerald-900'
                        : active
                          ? 'bg-blue-50/60 border-blue-200 text-blue-900 font-semibold'
                          : 'bg-slate-50 border-slate-200 text-slate-500'
                    }`}
                  >
                    {completed ? (
                      <CheckCircle2
                        className="w-4 h-4 text-emerald-600 shrink-0"
                        aria-hidden="true"
                      />
                    ) : active ? (
                      <Loader2
                        className="w-4 h-4 text-blue-600 animate-spin shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="w-4 h-4 rounded-full border border-slate-300 shrink-0" />
                    )}
                    <span className="leading-snug">{step.label}</span>
                  </div>
                );
              })}
            </div>
          )}

          {isOfflineMode && status === 'success' && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950">
              <strong>Provenance Label:</strong> Local Contour-Reconstructed 3D Mesh — Offline Fallback (Not Tripo Neural Reconstruction)
            </div>
          )}
        </div>
      )}

      {/* Missing Tripo Key Setup Banner + Honest Offline Fallback Guidance */}
      {isMissingKeyError && error && (
        <div
          role="status"
          className="p-4 rounded-lg bg-amber-50 border border-amber-200 space-y-2 text-xs text-amber-950"
        >
          <div className="flex items-center gap-2 font-semibold text-sm text-amber-900">
            <KeyRound className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
            <span>{error.title}</span>
          </div>
          <p className="leading-relaxed text-amber-900/90">{error.message}</p>
          {error.suggestion && (
            <p className="font-medium text-amber-950 pt-1">Next step: {error.suggestion}</p>
          )}
        </div>
      )}

      {/* Other API / Credit / Network / Validation / Offline Ambiguity Errors */}
      {error && !isMissingKeyError && (
        <div
          role="alert"
          className="p-4 rounded-lg bg-red-50 border border-red-200 space-y-2 text-xs text-red-950"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-sm text-red-900">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" aria-hidden="true" />
              <span>{error.title}</span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[11px] text-red-700">
              <span>Code: {error.code}</span>
              {typeof error.tripoCode === 'number' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Tripo #{error.tripoCode}</span>
                </>
              )}
              {error.requestId && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Trace {error.requestId}</span>
                </>
              )}
            </div>
          </div>
          <p className="leading-relaxed text-red-900">{error.message}</p>
          {error.suggestion && (
            <p className="font-medium text-red-950 pt-0.5">
              Recommended action: {error.suggestion}
            </p>
          )}
        </div>
      )}
    </section>
  );
};
