import React from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Layers,
  RefreshCw,
  Sliders,
} from 'lucide-react';
import type {
  ReconstructionOptionId,
  SynthesizedOptionPreview,
} from '../types/studio';
import { OptionPreview3D } from './OptionPreview3D';

interface ReconstructionOptionsPanelProps {
  options: SynthesizedOptionPreview[];
  isSynthesizing: boolean;
  selectedOptionId: ReconstructionOptionId | null;
  tripoConfigured: boolean;
  isGeneratingCloud: boolean;
  onSelectOption: (optionId: ReconstructionOptionId) => void;
  onGenerateCloudForOption?: (optionId: ReconstructionOptionId) => void;
  onRunLimitedContourFallback: () => void;
}

export const ReconstructionOptionsPanel: React.FC<ReconstructionOptionsPanelProps> = ({
  options,
  isSynthesizing,
  selectedOptionId,
  tripoConfigured,
  isGeneratingCloud,
  onSelectOption,
  onGenerateCloudForOption,
  onRunLimitedContourFallback,
}) => {
  const firstItem = options[0];
  const isUnsupportedCategory = Boolean(firstItem && !firstItem.option.supported);

  return (
    <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {/* Header Bar */}
      <div className="px-5 py-4 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-600" aria-hidden="true" />
            <span>Step 3 — Compare Three 3D Reconstruction Concepts</span>
          </h3>
          <p className="text-xs text-slate-600 mt-0.5">
            Orbit and inspect all three 3D structural interpretations side by side, review their inferred changes and evidence confidence, then select your preferred design.
          </p>
        </div>

        {firstItem && (
          <div className="text-right">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 block">
              Detected Structural Architecture
            </span>
            <span className="text-xs font-semibold text-slate-800">
              {firstItem.categoryLabel}
            </span>
          </div>
        )}
      </div>

      {/* Honest Provenance Disclosure */}
      <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
        <span>
          <span className="font-semibold text-slate-800">3D Preview &amp; Synthesis Engine:</span>{' '}
          Deterministic Modular Component Reconstruction built from your sketch&apos;s measured proportions, Gemini structural audit, and IntentLock overrides (not claimed as neural image-to-3D).
        </span>
        {!isUnsupportedCategory && (
          <button
            type="button"
            onClick={onRunLimitedContourFallback}
            className="text-[11px] font-medium text-slate-500 hover:text-slate-800 underline underline-offset-2 shrink-0"
          >
            Use Limited Raw Contour Extrusion Fallback Instead
          </button>
        )}
      </div>

      {/* Synthesizing Loading State */}
      {isSynthesizing && (
        <div className="p-8 flex flex-col items-center justify-center text-center gap-2">
          <RefreshCw className="w-6 h-6 text-blue-600 animate-spin" aria-hidden="true" />
          <p className="text-sm font-semibold text-slate-900">
            Synthesizing &amp; Validating Three Distinct 3D Meshes…
          </p>
          <p className="text-xs text-slate-500 max-w-md">
            Building Option A (Sketch Faithful), Option B (Structurally Refined), and Option C (Design Enhanced) as independent glTF 2.0 binary models.
          </p>
        </div>
      )}

      {/* Honest Unsupported Object Category Banner */}
      {!isSynthesizing && isUnsupportedCategory && firstItem && (
        <div className="p-5 space-y-4">
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-1.5 text-xs text-amber-950">
              <p className="text-sm font-semibold text-amber-950">
                Unsupported Category for Local Modular Structural Reconstruction
              </p>
              <p className="leading-relaxed">
                {firstItem.option.unsupported_reason || firstItem.geometrySummary}
              </p>
              <p className="text-amber-800">
                Supported high-precision local categories: <strong>Chairs &amp; Stools</strong>,{' '}
                <strong>Tables &amp; Desks</strong>, <strong>Mugs, Cups, Bowls &amp; Vases</strong>,{' '}
                <strong>Table &amp; Floor Lamps</strong>, <strong>Bookshelves &amp; Open Cabinets</strong>, and{' '}
                <strong>Mechanical Brackets &amp; Plates</strong>. Rather than fabricating a misleading blocky mesh, local modular previews are withheld for freeform/organic subjects.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <p className="text-xs text-slate-600">
              {tripoConfigured
                ? 'TRIPO_API_KEY is configured — you can run Cloud Neural Image-to-3D below for organic/freeform geometry.'
                : 'If you still require a basic 2D silhouette slab for inspection, you may explicitly invoke the limited contour extrusion fallback:'}
            </p>
            <button
              type="button"
              onClick={onRunLimitedContourFallback}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-amber-950 bg-amber-100 border border-amber-300 rounded-lg hover:bg-amber-200 transition-colors"
            >
              <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Run Limited Raw Silhouette Extrusion Fallback</span>
            </button>
          </div>
        </div>
      )}

      {/* Three-Option Comparison Grid */}
      {!isSynthesizing && !isUnsupportedCategory && options.length > 0 && (
        <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {options.map((item) => {
            const { option, glbBuffer, stats, componentNames } = item;
            const isSelected = selectedOptionId === option.id;

            const confidenceBarClass =
              option.confidence_level === 'high'
                ? 'bg-emerald-600'
                : option.confidence_level === 'moderate'
                  ? 'bg-blue-600'
                  : 'bg-amber-500';

            const confidenceTextClass =
              option.confidence_level === 'high'
                ? 'text-emerald-700'
                : option.confidence_level === 'moderate'
                  ? 'text-blue-700'
                  : 'text-amber-700';

            return (
              <article
                key={option.id}
                className={`rounded-xl border flex flex-col justify-between transition-colors ${
                  isSelected
                    ? 'border-blue-600 bg-blue-50/25 ring-2 ring-blue-600/20'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="p-4 space-y-3.5">
                  {/* Option Header */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-blue-700 font-mono">
                        {option.code}
                      </span>
                      {isSelected && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700">
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Active Design</span>
                        </span>
                      )}
                    </div>
                    <h4 className="text-base font-bold text-slate-900">{option.name}</h4>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      {option.explanation}
                    </p>
                  </div>

                  {/* Genuine Interactive 3D WebGL Preview */}
                  {glbBuffer && (
                    <div className="space-y-1.5">
                      <OptionPreview3D
                        glbBuffer={glbBuffer}
                        optionLabel={`${option.code} — ${option.name}`}
                        isSelected={isSelected}
                      />
                      {stats && (
                        <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] font-mono tabular-nums text-slate-500 px-0.5">
                          <span>{componentNames.length} 3D parts</span>
                          <span>
                            {stats.vertexCount.toLocaleString()} verts ·{' '}
                            {stats.triangleCount.toLocaleString()} tris
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Evidence-Grounded Confidence Indicator */}
                  <div className="rounded-lg bg-slate-50 border border-slate-200/90 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-700">
                        Evidence Confidence
                      </span>
                      <span className={`font-mono font-bold tabular-nums ${confidenceTextClass}`}>
                        {option.confidence_score}% ({option.confidence_level})
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${confidenceBarClass}`}
                        style={{ width: `${Math.min(100, Math.max(8, option.confidence_score))}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-slate-600 leading-snug">
                      {option.confidence_rationale}
                    </p>
                  </div>

                  {/* Clear List of Inferred Changes */}
                  <div className="space-y-1.5">
                    <h5 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      Inferred 3D Structural Changes
                    </h5>
                    <ul className="space-y-1.5 text-xs text-slate-700">
                      {option.inferred_changes.map((change, idx) => (
                        <li key={idx} className="flex items-start gap-2 leading-snug">
                          <span className="text-blue-600 font-bold mt-0.5" aria-hidden="true">
                            •
                          </span>
                          <span>{change}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Select This Design Action Footer */}
                <div className="p-4 pt-3 border-t border-slate-200/80 space-y-2">
                  <button
                    type="button"
                    onClick={() => onSelectOption(option.id)}
                    className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg transition-colors ${
                      isSelected
                        ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                        : 'bg-blue-600 text-white hover:bg-blue-500'
                    }`}
                  >
                    {isSelected ? (
                      <>
                        <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                        <span>Selected — Loaded in 3D Studio</span>
                      </>
                    ) : (
                      <>
                        <Box className="w-4 h-4" aria-hidden="true" />
                        <span>Select This Design</span>
                      </>
                    )}
                  </button>

                  {tripoConfigured && onGenerateCloudForOption && (
                    <button
                      type="button"
                      disabled={isGeneratingCloud}
                      onClick={() => onGenerateCloudForOption(option.id)}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 disabled:opacity-50 transition-colors"
                    >
                      <span>Also Run Cloud Tripo v3 Neural Mesh</span>
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
