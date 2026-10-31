import React, { useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  Eye,
  HelpCircle,
  Layers,
} from 'lucide-react';
import type { SketchAnalysisResult } from '../types/studio';

interface AnalysisAndDesignMapProps {
  analysis: SketchAnalysisResult;
  sketchSha256?: string;
  modelUsed?: string;
  analysisDurationMs?: number;
}

export const AnalysisAndDesignMap: React.FC<AnalysisAndDesignMapProps> = ({
  analysis,
  sketchSha256,
  modelUsed,
  analysisDurationMs,
}) => {
  const [showRawJson, setShowRawJson] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(analysis, null, 2));
      setCopiedJson(true);
      window.setTimeout(() => setCopiedJson(false), 1800);
    } catch {
      // Ignore clipboard permission restrictions
    }
  };

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
      {/* Header Summary */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-slate-200">
        <div className="space-y-1 max-w-2xl">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>02. Multimodal Vision Audit</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{modelUsed || 'gemini-3.8-flash'}</span>
            {analysis.object_category && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-medium text-slate-700">
                  Category: {analysis.object_category.replace(/_/g, ' ')}
                </span>
              </>
            )}
            {typeof analysisDurationMs === 'number' && analysisDurationMs > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {(analysisDurationMs / 1000).toFixed(2)}s
                </span>
              </>
            )}
            {sketchSha256 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  Sketch SHA-256 {sketchSha256.slice(0, 10)}…
                </span>
              </>
            )}
          </div>
          <h2 className="text-xl font-display font-bold text-slate-900">
            {analysis.object_name}
          </h2>
          <p className="text-sm text-slate-600 leading-relaxed">
            {analysis.proportions_description}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowRawJson((prev) => !prev)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
        >
          <Code2 className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{showRawJson ? 'Hide Structured JSON' : 'Inspect Structured JSON'}</span>
        </button>
      </div>

      {/* Observed vs AI-Inferred Design Map */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-display font-semibold text-slate-900">
            Observed vs AI-Inferred Design Map
          </h3>
          <p className="text-xs text-slate-500">
            Separates 2D stroke evidence from occluded geometry estimates — never invents certainty about hidden faces
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
          {/* Column 1: Directly Observed from 2D Sketch */}
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 flex flex-col justify-between space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-200">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800">
                  <Eye className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                  <span>Sketch-Observed Evidence</span>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {analysis.visible_components.length + analysis.observed_features.length} items
                </span>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-700">Visible Components</p>
                {analysis.visible_components.length > 0 ? (
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    {analysis.visible_components.map((comp, i) => (
                      <li key={i} className="leading-relaxed">
                        • {comp}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-500">No distinct components detected.</p>
                )}
              </div>

              <div className="space-y-2 pt-2 border-t border-slate-200/80">
                <p className="text-xs font-semibold text-slate-700">Observed Stroke Features</p>
                {analysis.observed_features.length > 0 ? (
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    {analysis.observed_features.map((feat, i) => (
                      <li key={i} className="leading-relaxed">
                        • {feat}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-500">No specific stroke features listed.</p>
                )}
              </div>
            </div>

            <p className="text-[11px] text-slate-500 pt-2 border-t border-slate-200">
              Source: Direct 2D stroke contours in your sketch
            </p>
          </div>

          {/* Column 2: Ambiguous / Occluded Uncertainties (Routed to IntentLock) */}
          <div className="p-4 rounded-lg bg-amber-50/40 border border-amber-200/80 flex flex-col justify-between space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-amber-200/70">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-900">
                  <HelpCircle className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
                  <span>Occluded / Uncertain Regions</span>
                </div>
                <span className="text-xs font-mono tabular-nums text-amber-800">
                  {analysis.uncertain_features.length} flagged
                </span>
              </div>

              {analysis.uncertain_features.length > 0 ? (
                <ul className="space-y-2.5 text-xs text-slate-800">
                  {analysis.uncertain_features.map((u) => (
                    <li key={u.id} className="space-y-0.5">
                      <p className="font-semibold text-slate-900">
                        {u.feature_name}{' '}
                        <span className="font-normal text-amber-800">({u.importance})</span>
                      </p>
                      <p className="text-slate-600 leading-relaxed">{u.uncertainty_reason}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-600 leading-relaxed">
                  No major structural ambiguities requiring manual clarification were detected for this silhouette.
                </p>
              )}
            </div>

            <p className="text-[11px] text-amber-900/80 pt-2 border-t border-amber-200/70">
              Action: Review and confirm or override in IntentLock below
            </p>
          </div>

          {/* Column 3: AI-Inferred Hidden 3D Geometry */}
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 flex flex-col justify-between space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-200">
                <div className="flex items-center gap-2 text-xs font-semibold text-blue-900">
                  <Layers className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                  <span>AI-Inferred Hidden Geometry</span>
                </div>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {analysis.inferred_features.length} estimates
                </span>
              </div>

              {analysis.inferred_features.length > 0 ? (
                <ul className="space-y-2 text-xs text-slate-700">
                  {analysis.inferred_features.map((inf, i) => (
                    <li key={i} className="leading-relaxed">
                      • {inf}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-500">No hidden geometry inferences recorded.</p>
              )}
            </div>

            <p className="text-[11px] text-slate-500 pt-2 border-t border-slate-200">
              Status: Estimated hidden depth/backside — not visible in 2D sketch
            </p>
          </div>
        </div>
      </div>

      {/* Material Preferences & Reconstruction Notes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-200">
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-900">Material & Surface Specification</h4>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <dt className="text-slate-500">Primary Material</dt>
              <dd className="font-medium text-slate-900 mt-0.5">
                {analysis.material_preferences.primary_material}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Secondary Material</dt>
              <dd className="font-medium text-slate-900 mt-0.5">
                {analysis.material_preferences.secondary_material}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Colour Palette</dt>
              <dd className="font-medium text-slate-900 mt-0.5">
                {analysis.material_preferences.colour_palette}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Surface Finish</dt>
              <dd className="font-medium text-slate-900 mt-0.5">
                {analysis.material_preferences.surface_finish}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-slate-500 pt-1">
            {analysis.material_preferences.source_note}
          </p>
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-900">3D Reconstruction Engineering Notes</h4>
          <p className="text-xs text-slate-600 leading-relaxed">
            {analysis.reconstruction_notes}
          </p>
        </div>
      </div>

      {/* Optional Raw Structured JSON Drawer */}
      {showRawJson && (
        <div className="pt-4 border-t border-slate-200 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-600">
              8-field Gemini multimodal schema output
            </span>
            <button
              type="button"
              onClick={handleCopyJson}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              {copiedJson ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Copy JSON</span>
                </>
              )}
            </button>
          </div>
          <pre className="p-4 rounded-lg bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto max-h-80 leading-relaxed">
            {JSON.stringify(analysis, null, 2)}
          </pre>
        </div>
      )}
    </section>
  );
};
