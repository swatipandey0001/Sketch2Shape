import React from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Cpu,
  FlaskConical,
  KeyRound,
  PenTool,
  Upload,
} from 'lucide-react';
import type {
  GenerationHistoryEntry,
  NavTab,
  SystemStatusResponse,
} from '../types/studio';

interface DashboardViewProps {
  systemStatus: SystemStatusResponse | null;
  history: GenerationHistoryEntry[];
  onStartSampleChair: () => void;
  onStartBlankCanvas: () => void;
  onStartUploadMode: () => void;
  onOpenHistoryEntry: (entry: GenerationHistoryEntry) => void;
  onNavigateTab: (tab: NavTab) => void;
}

const WORKFLOW_STAGES = [
  {
    step: '01. Sketch & Deterministic CV Prep',
    detail:
      'Draw on the 768 × 576 drafting sheet or upload PNG/JPG/WebP. Deterministic CV composites alpha on white, extracts stroke bounding boxes, normalizes contrast, and traces contours.',
  },
  {
    step: '02. Gemini Multimodal Vision Audit',
    detail:
      'Gemini (gemini-3.1-flash-lite primary, gemini-3.8-flash fallback) separates visible 2D stroke evidence from occluded 3D estimates without inventing hidden-geometry certainty.',
  },
  {
    step: '03. IntentLock Specification Gate',
    detail:
      'Review genuine structural ambiguities, confirm or override depth/cavity/support decisions, and compile material & geometry directives while preserving original sketch SHA-256.',
  },
  {
    step: '04. Tripo v3 & Offline Contour 3D GLB',
    detail:
      'Reconstructs via Tripo OpenAPI v3 (when TRIPO_API_KEY is set) or our honest Local Contour/Lathe 3D Reconstructor, validates binary GLB volume, and exports 1:1 .GLB & .OBJ/.MTL.',
  },
];

export const DashboardView: React.FC<DashboardViewProps> = ({
  systemStatus,
  history,
  onStartSampleChair,
  onStartBlankCanvas,
  onStartUploadMode,
  onOpenHistoryEntry,
  onNavigateTab,
}) => {
  const verifiedModelsCount = history.filter(
    (h) => h.outcome === 'tripo_glb_verified' || h.outcome === 'offline_contour_glb'
  ).length;

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-8 space-y-10">
      {/* Studio Hero Split */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
        <div className="lg:col-span-7 flex flex-col justify-between space-y-6">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>IntentLock 3D Reconstruction Studio</span>
              <span aria-hidden="true">·</span>
              <span>
                Gemini ({systemStatus?.geminiModel || 'gemini-3.1-flash-lite'}) + Tripo OpenAPI v3 + Local Contour 3D
              </span>
            </div>
            <h1
              className="text-3xl sm:text-4xl font-display font-bold tracking-tight text-slate-900 leading-tight"
              style={{ textWrap: 'balance' }}
            >
              Convert 2D Hand-Drawn Sketches into Validated, Exportable 3D Models
            </h1>
            <p className="text-base text-slate-600 leading-relaxed max-w-[65ch]">
              Sketch2Shape prepares your sketch with deterministic computer vision, audits observed strokes versus occluded depth estimates, locks structural intent, and outputs validated Three.js <code className="font-mono text-sm">.GLB</code> and <code className="font-mono text-sm">.OBJ</code> meshes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={onStartSampleChair}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              <span>Launch Sample Chair Workflow</span>
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onStartBlankCanvas}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              <PenTool className="w-4 h-4" aria-hidden="true" />
              <span>Blank Drafting Canvas</span>
            </button>
            <button
              type="button"
              onClick={onStartUploadMode}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-800 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              <span>Upload PNG / JPG / WebP</span>
            </button>
          </div>
        </div>

        {/* Right Column: Honest Environment & Pipeline Readiness Panel */}
        <div className="lg:col-span-5 bg-slate-50 border border-slate-200 rounded-lg p-5 flex flex-col justify-between space-y-5">
          <div className="space-y-3">
            <h2 className="text-sm font-display font-semibold text-slate-900">
              Runtime &amp; Reconstruction Engine Status
            </h2>

            <div className="space-y-2.5 text-xs">
              <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-200">
                <div>
                  <p className="font-semibold text-slate-900">Gemini Multimodal Vision</p>
                  <p className="text-slate-500">
                    Primary: {systemStatus?.geminiModel || 'gemini-3.1-flash-lite'} · Fallback:{' '}
                    {systemStatus?.geminiFallbackModel || 'gemini-3.8-flash'}
                  </p>
                </div>
                {systemStatus?.geminiConfigured ? (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700 whitespace-nowrap shrink-0">
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Configured</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-medium text-amber-700 whitespace-nowrap shrink-0">
                    <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Needs GEMINI_API_KEY</span>
                  </span>
                )}
              </div>

              <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-200">
                <div>
                  <p className="font-semibold text-slate-900">Tripo OpenAPI v3 (Cloud Neural)</p>
                  <p className="text-slate-500">
                    Model: {systemStatus?.tripoModelVersion || 'v3.1-20260211'}
                  </p>
                </div>
                {systemStatus?.tripoConfigured ? (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-700 whitespace-nowrap shrink-0">
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Live Cloud Ready</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-medium text-amber-700 whitespace-nowrap shrink-0">
                    <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Key Unset</span>
                  </span>
                )}
              </div>

              <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-200">
                <div>
                  <p className="font-semibold text-slate-900">Local Contour 3D Fallback</p>
                  <p className="text-slate-500">
                    Sketch-contour extrusion &amp; lathe GLB/OBJ solver
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 font-medium text-emerald-700 whitespace-nowrap shrink-0">
                  <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Always Ready (No Key)</span>
                </span>
              </div>
            </div>

            {systemStatus && !systemStatus.tripoConfigured && (
              <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3 leading-relaxed">
                <strong>Offline 3D Fallback Ready:</strong> <code className="font-mono">TRIPO_API_KEY</code> is not set, so Studio uses our honest <strong>Local Contour-Reconstructed 3D Mesh</strong> engine (derived directly from your sketch pixels and contours) or cloud Tripo v3 once a key is added.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-200 text-xs text-slate-600">
            <span className="font-mono tabular-nums">
              Saved sessions: {history.length} · Validated 3D GLBs: {verifiedModelsCount}
            </span>
            <button
              type="button"
              onClick={() => onNavigateTab('diagnostics')}
              className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:text-blue-800 transition-colors whitespace-nowrap shrink-0"
            >
              <FlaskConical className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Open Workflow Verifier</span>
            </button>
          </div>
        </div>
      </section>

      {/* 4-Stage Pipeline Architecture Strip */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-display font-bold text-slate-900">
            End-to-End Reconstruction Architecture
          </h2>
          <button
            type="button"
            onClick={() => onNavigateTab('docs')}
            className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap"
          >
            Read API &amp; Hardware Documentation →
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {WORKFLOW_STAGES.map((stage) => (
            <div
              key={stage.step}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-2"
            >
              <h3 className="text-sm font-display font-semibold text-slate-900">
                {stage.step}
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">{stage.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Recent Studio Sessions */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-display font-bold text-slate-900">
            Recent Studio Sessions
          </h2>
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => onNavigateTab('history')}
              className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
            >
              View All ({history.length}) →
            </button>
          )}
        </div>

        {history.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-3">
            <p className="text-sm font-medium text-slate-900">
              No reconstruction sessions recorded yet
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Start with the Sample Chair Sketch or draw any fresh 2D silhouette to run CV preprocessing, Gemini vision audit, IntentLock, and 3D GLB reconstruction.
            </p>
            <div>
              <button
                type="button"
                onClick={onStartSampleChair}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
              >
                <span>Try Sample Chair Sketch</span>
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-3 px-4 font-semibold">Object</th>
                    <th className="py-3 px-4 font-semibold">Input</th>
                    <th className="py-3 px-4 font-semibold">Outcome</th>
                    <th className="py-3 px-4 font-semibold text-right">Mesh Vertices</th>
                    <th className="py-3 px-4 font-semibold text-right">Created</th>
                    <th className="py-3 px-4 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {history.slice(0, 5).map((item) => (
                    <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                      <td className="py-3 px-4 font-semibold text-slate-900">
                        {item.objectName}
                      </td>
                      <td className="py-3 px-4 text-slate-600 capitalize">
                        {item.sourceMode} · {item.sketchMimeType.replace('image/', '').toUpperCase()}
                      </td>
                      <td className="py-3 px-4">
                        {item.outcome === 'tripo_glb_verified' && (
                          <span className="text-emerald-700 font-medium">
                            Tripo v3 GLB Verified
                          </span>
                        )}
                        {item.outcome === 'offline_contour_glb' && (
                          <span className="text-amber-800 font-medium">
                            Offline Contour 3D GLB
                          </span>
                        )}
                        {item.outcome === 'demo_analysis_only' && (
                          <span className="text-slate-700 font-medium">
                            Vision Audit &amp; IntentLock Only
                          </span>
                        )}
                        {item.outcome === 'generation_failed' && (
                          <span className="text-red-700 font-medium">
                            Generation Halted
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                        {item.meshStats ? item.meshStats.vertexCount.toLocaleString() : '—'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-500">
                        {new Date(item.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => onOpenHistoryEntry(item)}
                          className="font-semibold text-blue-600 hover:text-blue-800 whitespace-nowrap"
                        >
                          Inspect →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
