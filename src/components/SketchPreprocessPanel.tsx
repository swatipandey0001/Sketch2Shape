import React, { useState } from 'react';
import { Check, Eye, Layers, Loader2, SlidersHorizontal, SplitSquareHorizontal } from 'lucide-react';
import type { PipelineImageChoice } from '../types/studio';
import type { BrowserPreprocessResult } from '../utils/sketchPreprocessor';

interface SketchPreprocessPanelProps {
  originalPreviewUrl: string | null;
  originalSha256: string;
  prepResult: BrowserPreprocessResult | null;
  isPreprocessing: boolean;
  illuminationCorrection: boolean;
  onToggleIlluminationCorrection: (next: boolean) => void;
  pipelineImageChoice: PipelineImageChoice;
  onSelectPipelineImageChoice: (choice: PipelineImageChoice) => void;
}

type PreviewViewMode = 'compare' | 'original' | 'prepared' | 'contours';

export const SketchPreprocessPanel: React.FC<SketchPreprocessPanelProps> = ({
  originalPreviewUrl,
  originalSha256,
  prepResult,
  isPreprocessing,
  illuminationCorrection,
  onToggleIlluminationCorrection,
  pipelineImageChoice,
  onSelectPipelineImageChoice,
}) => {
  const [viewMode, setViewMode] = useState<PreviewViewMode>('compare');

  if (!originalPreviewUrl && !prepResult && !isPreprocessing) {
    return null;
  }

  const metrics = prepResult?.metrics;

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 pb-3.5 border-b border-slate-200">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>01B. Deterministic CV Sketch Preparation</span>
            {metrics && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{metrics.durationMs} ms</span>
              </>
            )}
          </div>
          <h2 className="text-sm font-display font-bold text-slate-900">
            Pixel Normalization, Bounding-Box Crop &amp; Contour Extraction
          </h2>
        </div>

        {isPreprocessing && (
          <span className="inline-flex items-center gap-1.5 text-xs text-blue-700 font-medium">
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            <span>Updating CV map…</span>
          </span>
        )}
      </div>

      {/* View Mode Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {(
            [
              { id: 'compare', label: 'Compare Both', icon: SplitSquareHorizontal },
              { id: 'original', label: 'Original', icon: Eye },
              { id: 'prepared', label: '1:1 White Pad', icon: SlidersHorizontal },
              { id: 'contours', label: 'Contours & BBox', icon: Layers },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setViewMode(tab.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={illuminationCorrection}
            onChange={(e) => onToggleIlluminationCorrection(e.target.checked)}
            className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
          />
          <span>Flatten uneven paper lighting</span>
        </label>
      </div>

      {/* Visual Comparison Stage */}
      {prepResult && (
        <div>
          {viewMode === 'compare' ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-slate-600">
                  Original Input ({metrics?.originalWidth}×{metrics?.originalHeight})
                </p>
                <div className="aspect-square bg-slate-50 border border-slate-200 rounded-lg p-2 flex items-center justify-center overflow-hidden">
                  {originalPreviewUrl ? (
                    <img
                      src={originalPreviewUrl}
                      alt="Original unmodified 2D sketch"
                      className="max-w-full max-h-full object-contain bg-white rounded"
                    />
                  ) : (
                    <span className="text-xs text-slate-400">Original preview</span>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-slate-600">
                  CV-Prepared 1:1 Pad ({metrics?.preparedWidth}×{metrics?.preparedHeight})
                </p>
                <div className="aspect-square bg-slate-50 border border-slate-200 rounded-lg p-2 flex items-center justify-center overflow-hidden">
                  <img
                    src={prepResult.preparedDataUrl}
                    alt="Deterministic CV prepared centered 1:1 sketch"
                    className="max-w-full max-h-full object-contain bg-white rounded"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="aspect-[16/10] bg-slate-50 border border-slate-200 rounded-lg p-3 flex items-center justify-center overflow-hidden">
              {viewMode === 'original' && originalPreviewUrl && (
                <img
                  src={originalPreviewUrl}
                  alt="Original unmodified 2D sketch"
                  className="max-w-full max-h-full object-contain bg-white rounded"
                />
              )}
              {viewMode === 'prepared' && (
                <img
                  src={prepResult.preparedDataUrl}
                  alt="Deterministic CV prepared centered 1:1 sketch"
                  className="max-w-full max-h-full object-contain bg-white rounded"
                />
              )}
              {viewMode === 'contours' && (
                <img
                  src={prepResult.contourOverlayDataUrl}
                  alt="Detected stroke bounding box and polygon contours"
                  className="max-w-full max-h-full object-contain bg-white rounded"
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* Deterministic Pixel Telemetry */}
      {metrics && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pt-1 text-xs">
          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/90">
            <dt className="text-[11px] text-slate-500">Measured BBox W:H</dt>
            <dd className="font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
              {metrics.hasForeground ? metrics.measuredAspectLabel : 'Blank'}
            </dd>
          </div>
          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/90">
            <dt className="text-[11px] text-slate-500">Foreground Ink Ratio</dt>
            <dd className="font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
              {(metrics.foregroundInkRatio * 100).toFixed(1)}%
            </dd>
          </div>
          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/90">
            <dt className="text-[11px] text-slate-500">2D Bilateral Symmetry</dt>
            <dd className="font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
              {Math.round(metrics.verticalSymmetryScore * 100)}%
            </dd>
          </div>
          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/90">
            <dt className="text-[11px] text-slate-500">Extracted Contours</dt>
            <dd className="font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
              {metrics.outerContourCount} outer · {metrics.holeContourCount} hole
              {metrics.holeContourCount === 1 ? '' : 's'}
            </dd>
          </div>
          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/90">
            <dt className="text-[11px] text-slate-500">Alpha Channel</dt>
            <dd className="font-medium text-slate-900 mt-0.5 truncate">
              {metrics.hasTransparency ? 'Composited on #FFF' : 'Opaque RGB'}
            </dd>
          </div>
          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/90">
            <dt className="text-[11px] text-slate-500">Offline 3D Solver</dt>
            <dd className="font-medium text-slate-900 mt-0.5 truncate">
              {metrics.recommendedOfflineMode === 'lathe_with_handle'
                ? 'Lathe + Handle'
                : metrics.recommendedOfflineMode === 'lathe_rotational'
                  ? 'Rotational Lathe'
                  : metrics.recommendedOfflineMode === 'contour_extrusion'
                    ? 'Contour Extrusion'
                    : 'Needs Clearer Strokes'}
            </dd>
          </div>
        </dl>
      )}

      {metrics && metrics.estimatedIlluminationUnevenness > 0.12 && !illuminationCorrection && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          Detected uneven background illumination ({(metrics.estimatedIlluminationUnevenness * 100).toFixed(0)}% greyscale spread). Enable <strong>Flatten uneven paper lighting</strong> above if this is a photographed paper sketch.
        </p>
      )}

      {/* Pipeline Image Source Choice (Always Preserves Original Sketch) */}
      <div className="pt-3 border-t border-slate-200 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-medium text-slate-700">Image Sent to Upstream APIs:</span>
          <div className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onSelectPipelineImageChoice('original')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                pipelineImageChoice === 'original'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {pipelineImageChoice === 'original' && <Check className="w-3 h-3" aria-hidden="true" />}
              <span>Original Sketch (Verbatim)</span>
            </button>
            <button
              type="button"
              disabled={!prepResult?.metrics.hasForeground}
              onClick={() => onSelectPipelineImageChoice('prepared')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap disabled:opacity-40 ${
                pipelineImageChoice === 'prepared'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {pipelineImageChoice === 'prepared' && <Check className="w-3 h-3" aria-hidden="true" />}
              <span>CV-Prepared (1:1 Pad)</span>
            </button>
          </div>
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Original sketch is preserved untouched{originalSha256 ? ` (SHA-256 ${originalSha256.slice(0, 10)}…)` : ''}. CV preparation uses strictly deterministic pixel operations — zero generative AI image replacement.
        </p>
      </div>
    </section>
  );
};
