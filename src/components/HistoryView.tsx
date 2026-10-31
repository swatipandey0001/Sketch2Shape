import React, { useMemo, useState } from 'react';
import {
  Box,
  Cpu,
  Download,
  ExternalLink,
  Search,
  Trash2,
} from 'lucide-react';
import type { GenerationHistoryEntry } from '../types/studio';
import { loadGlbFromIndexedDb } from '../utils/historyStore';
import { triggerBrowserDownload } from '../utils/glbValidator';

interface HistoryViewProps {
  history: GenerationHistoryEntry[];
  onInspectEntry: (entry: GenerationHistoryEntry) => void;
  onDeleteEntry: (entryId: string) => void;
  onClearAll: () => void;
  onStartNewSketch: () => void;
}

type HistoryFilter =
  | 'all'
  | 'modular_structural_glb'
  | 'tripo_glb_verified'
  | 'offline_contour_glb'
  | 'demo_analysis_only'
  | 'generation_failed';

export const HistoryView: React.FC<HistoryViewProps> = ({
  history,
  onInspectEntry,
  onDeleteEntry,
  onClearAll,
  onStartNewSketch,
}) => {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const filteredEntries = useMemo(() => {
    return history.filter((item) => {
      if (filter !== 'all' && item.outcome !== filter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = item.objectName.toLowerCase().includes(q);
        const matchMat = item.analysis.material_preferences.primary_material
          .toLowerCase()
          .includes(q);
        return matchName || matchMat;
      }
      return true;
    });
  }, [filter, history, searchQuery]);

  const handleDownloadArchivedGlb = async (entry: GenerationHistoryEntry) => {
    setDownloadingId(entry.id);
    try {
      const buf = await loadGlbFromIndexedDb(entry.id);
      if (buf) {
        const slug =
          entry.objectName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 36) || 'sketch2shape_model';
        triggerBrowserDownload(new Blob([buf], { type: 'model/gltf-binary' }), `${slug}.glb`);
      }
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 pb-5 border-b border-slate-200">
        <div className="space-y-1">
          <h1 className="text-2xl font-display font-bold text-slate-900">
            Generation &amp; Audit History
          </h1>
          <p className="text-sm text-slate-600">
            Local browser archive of original 2D sketches, Gemini vision audits, IntentLock decisions, and IndexedDB binary GLB models (Tripo v3 &amp; Offline Contour meshes).
          </p>
        </div>

        {history.length > 0 && (
          <button
            type="button"
            onClick={onClearAll}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-slate-200 rounded-md hover:bg-red-50 hover:border-red-200 transition-colors whitespace-nowrap shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Clear Archive</span>
          </button>
        )}
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {(
            [
              { id: 'all', label: 'All Sessions' },
              { id: 'modular_structural_glb', label: '3-Option Modular GLBs' },
              { id: 'tripo_glb_verified', label: 'Tripo v3 GLBs' },
              { id: 'offline_contour_glb', label: 'Limited Contour GLBs' },
              { id: 'demo_analysis_only', label: 'Audit Only' },
              { id: 'generation_failed', label: 'Halted' },
            ] as Array<{ id: HistoryFilter; label: string }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                filter === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search
            className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by object or material…"
            className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
          />
        </div>
      </div>

      {/* Entries List */}
      {filteredEntries.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
          <p className="text-sm font-semibold text-slate-900">
            {history.length === 0
              ? 'Your studio archive is empty'
              : 'No sessions match your current filter'}
          </p>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            {history.length === 0
              ? 'Completed sketch analyses, IntentLock specifications, and validated Tripo v3 or Offline Contour GLB assets are automatically stored here.'
              : 'Try clearing the search query or switching back to All Sessions.'}
          </p>
          {history.length === 0 && (
            <div>
              <button
                type="button"
                onClick={onStartNewSketch}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
              >
                Open Drafting Studio
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredEntries.map((entry) => (
            <article
              key={entry.id}
              className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col justify-between"
            >
              <div>
                <div className="aspect-[4/3] bg-slate-50 border-b border-slate-200 flex items-center justify-center p-4">
                  {entry.sketchDataUrl ? (
                    <img
                      src={entry.sketchDataUrl}
                      alt={`Original sketch for ${entry.objectName}`}
                      referrerPolicy="no-referrer"
                      className="max-w-full max-h-full object-contain bg-white rounded border border-slate-200"
                    />
                  ) : (
                    <div className="text-xs text-slate-400">Sketch thumbnail unavailable</div>
                  )}
                </div>

                <div className="p-5 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                    <span>
                      {new Date(entry.createdAt).toLocaleDateString()} ·{' '}
                      {new Date(entry.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="capitalize">{entry.sourceMode}</span>
                    {typeof entry.generationDurationMs === 'number' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {entry.generationDurationMs >= 1000
                            ? `${(entry.generationDurationMs / 1000).toFixed(2)}s`
                            : `${entry.generationDurationMs.toFixed(0)}ms`}
                        </span>
                      </>
                    )}
                  </div>

                  <h2 className="text-base font-display font-bold text-slate-900">
                    {entry.objectName}
                  </h2>

                  <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">
                    {entry.analysis.proportions_description}
                  </p>

                  <div className="pt-1 text-xs">
                    {entry.outcome === 'modular_structural_glb' && entry.meshStats && (
                      <div className="text-blue-900 font-medium flex items-center gap-1.5">
                        <Box className="w-3.5 h-3.5 text-blue-600 shrink-0" aria-hidden="true" />
                        <span className="font-mono tabular-nums truncate">
                          {entry.selectedOptionName || 'Modular 3D'} ·{' '}
                          {entry.meshStats.vertexCount.toLocaleString()} verts ·{' '}
                          {entry.meshStats.nonEmptyMeshCount} parts
                        </span>
                      </div>
                    )}
                    {entry.outcome === 'tripo_glb_verified' && entry.meshStats && (
                      <div className="text-emerald-800 font-medium flex items-center gap-1.5">
                        <Box className="w-3.5 h-3.5 text-emerald-600 shrink-0" aria-hidden="true" />
                        <span className="font-mono tabular-nums">
                          Tripo v3 GLB · {entry.meshStats.vertexCount.toLocaleString()} verts ·{' '}
                          {entry.meshStats.nonEmptyMeshCount} mesh
                          {entry.meshStats.nonEmptyMeshCount === 1 ? '' : 'es'}
                        </span>
                      </div>
                    )}
                    {entry.outcome === 'offline_contour_glb' && entry.meshStats && (
                      <div className="text-amber-900 font-medium flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5 text-amber-600 shrink-0" aria-hidden="true" />
                        <span className="font-mono tabular-nums">
                          Limited Contour GLB · {entry.meshStats.vertexCount.toLocaleString()} verts ·{' '}
                          {entry.meshStats.nonEmptyMeshCount} mesh
                          {entry.meshStats.nonEmptyMeshCount === 1 ? '' : 'es'}
                        </span>
                      </div>
                    )}
                    {entry.outcome === 'demo_analysis_only' && (
                      <p className="text-slate-700 font-medium">
                        Vision Audit &amp; IntentLock Record (No 3D GLB)
                      </p>
                    )}
                    {entry.outcome === 'generation_failed' && (
                      <p className="text-red-700 font-medium truncate">
                        Halted: {entry.errorSummary || 'Upstream API error'}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onInspectEntry(entry)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800 transition-colors whitespace-nowrap shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Load in Studio</span>
                </button>

                <div className="flex items-center gap-2">
                  {entry.hasStoredGlb && (
                    <button
                      type="button"
                      disabled={downloadingId === entry.id}
                      onClick={() => void handleDownloadArchivedGlb(entry)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-800 bg-white border border-slate-200 rounded hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>.GLB</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDeleteEntry(entry.id)}
                    title="Delete record"
                    className="p-1.5 text-slate-500 hover:text-red-600 rounded transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
};
