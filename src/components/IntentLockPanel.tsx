import React, { useEffect, useState } from 'react';
import { CheckCircle2, Lock, ShieldCheck, Unlock } from 'lucide-react';
import type {
  CompiledReconstructionSpec,
  IntentLockDecision,
  IntentLockRecord,
  SketchAnalysisResult,
} from '../types/studio';

interface IntentLockPanelProps {
  analysis: SketchAnalysisResult;
  sketchSha256: string;
  intentLock: IntentLockRecord | null;
  compiledSpec?: CompiledReconstructionSpec | null;
  onLockIntent: (record: IntentLockRecord) => void;
  onUnlockIntent: () => void;
  disabled?: boolean;
}

export const IntentLockPanel: React.FC<IntentLockPanelProps> = ({
  analysis,
  sketchSha256,
  intentLock,
  compiledSpec = null,
  onLockIntent,
  onUnlockIntent,
  disabled = false,
}) => {
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [customOverrides, setCustomOverrides] = useState<Record<string, string>>({});
  const [additionalNotes, setAdditionalNotes] = useState<string>('');

  const uncertainties = Array.isArray(analysis.uncertain_features)
    ? analysis.uncertain_features
    : [];

  useEffect(() => {
    const initialSelected: Record<string, string> = {};
    for (const item of uncertainties) {
      const opts = Array.isArray(item.options) ? item.options : [];
      initialSelected[item.id] = item.default_assumption || opts[0] || '';
    }
    setSelectedOptions(initialSelected);
    setCustomOverrides({});
    setAdditionalNotes('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);

  const isLocked = Boolean(intentLock?.locked);

  const handleConfirmLock = () => {
    const decisions: IntentLockDecision[] = uncertainties.map((item) => {
      const opts = Array.isArray(item.options) ? item.options : [];
      const chosenOption = selectedOptions[item.id] || item.default_assumption || opts[0] || '';
      const customText = (customOverrides[item.id] || '').trim();
      const finalValue = customText || chosenOption;
      const wasCorrected =
        Boolean(customText) ||
        (chosenOption !== '' && chosenOption !== item.default_assumption);

      return {
        uncertaintyId: item.id,
        featureName: item.feature_name,
        selectedOption: chosenOption,
        customCorrection: customText,
        finalValue,
        wasCorrected,
      };
    });

    onLockIntent({
      locked: true,
      lockedAt: new Date().toISOString(),
      decisions,
      additionalNotes: additionalNotes.trim(),
      originalSketchSha256: sketchSha256,
    });
  };

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-200">
        <div className="space-y-1 max-w-2xl">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>03. IntentLock Specification Gate</span>
            <span aria-hidden="true">·</span>
            <span>
              {uncertainties.length === 0
                ? 'Zero critical ambiguities'
                : `${uncertainties.length} structural ${
                    uncertainties.length === 1 ? 'uncertainty' : 'uncertainties'
                  } surfaced`}
            </span>
          </div>
          <h2 className="text-lg font-display font-bold text-slate-900">
            Confirm or Correct Occluded Geometry Intent
          </h2>
          <p className="text-xs text-slate-600 leading-relaxed">
            Review important 3D ambiguities before reconstruction. Confirmed IntentLock decisions directly drive downstream depth ratios, hollow/solid topology, PBR material preview, and Tripo v3 alignment while preserving your original 2D sketch.
          </p>
        </div>

        {isLocked && (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
              <span>Intent Locked</span>
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={onUnlockIntent}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Unlock className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Edit Intent</span>
            </button>
          </div>
        )}
      </div>

      {/* Uncertainties List (never forces filler questions if empty) */}
      {uncertainties.length === 0 ? (
        <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700">
          Gemini found no critical hidden-geometry ambiguities requiring extra questions for this sketch. You can lock intent directly below to proceed to 3D reconstruction.
        </div>
      ) : (
        <div className="space-y-4">
          {uncertainties.map((item, idx) => {
            const safeOptions = Array.isArray(item.options) ? item.options : [];
            const lockedDecision = intentLock?.decisions.find((d) => d.uncertaintyId === item.id);
            const currentOption = selectedOptions[item.id] ?? item.default_assumption ?? '';
            const currentCustom = customOverrides[item.id] ?? '';

            return (
              <div
                key={item.id || `uncertainty_${idx}`}
                className="p-4 rounded-lg bg-slate-50/80 border border-slate-200 space-y-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {idx + 1}. {item.feature_name}
                  </h3>
                  <span className="text-xs text-slate-500">
                    Impact: {item.importance === 'critical' ? 'Critical structural' : 'Moderate detail'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">{item.uncertainty_reason}</p>

                {isLocked && lockedDecision ? (
                  <div className="pt-1 text-xs text-slate-900">
                    <span className="text-slate-500">Confirmed decision: </span>
                    <span className="font-semibold">{lockedDecision.finalValue}</span>
                    {lockedDecision.wasCorrected && (
                      <span className="text-blue-700 ml-2">(User-adjusted)</span>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2.5 pt-1">
                    <div className="flex flex-wrap gap-2">
                      {safeOptions.map((opt) => {
                        const active = currentOption === opt && !currentCustom.trim();
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              setSelectedOptions((prev) => ({ ...prev, [item.id]: opt }));
                              setCustomOverrides((prev) => ({ ...prev, [item.id]: '' }));
                            }}
                            className={`px-3 py-1.5 text-xs font-medium rounded-md border text-left transition-colors ${
                              active
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                            }`}
                          >
                            {opt}
                            {opt === item.default_assumption ? ' (Default)' : ''}
                          </button>
                        );
                      })}
                    </div>

                    <div>
                      <input
                        type="text"
                        value={currentCustom}
                        onChange={(e) =>
                          setCustomOverrides((prev) => ({ ...prev, [item.id]: e.target.value }))
                        }
                        placeholder="Or enter a custom correction (e.g., 3-legged tripod base, slim shallow depth, hollow interior)..."
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Optional Additional Engineering Notes */}
      {!isLocked ? (
        <div className="space-y-1.5">
          <label
            htmlFor="intentlock-extra-notes"
            className="block text-xs font-medium text-slate-700"
          >
            Optional Reconstruction Audit Note
          </label>
          <input
            id="intentlock-extra-notes"
            type="text"
            value={additionalNotes}
            onChange={(e) => setAdditionalNotes(e.target.value)}
            placeholder="Record any symmetry, hollowness, depth ratio, or support constraints..."
            className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
          />
        </div>
      ) : (
        intentLock?.additionalNotes && (
          <div className="text-xs text-slate-700">
            <span className="text-slate-500">Audit note: </span>
            <span>{intentLock.additionalNotes}</span>
          </div>
        )
      )}

      {/* Compiled Reconstruction Specification Preview */}
      {isLocked && compiledSpec && (
        <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-slate-900">
              Compiled Downstream Reconstruction Parameters
            </span>
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-600">
              <span
                className="w-3 h-3 rounded-xs border border-slate-300 shrink-0"
                style={{ backgroundColor: compiledSpec.primaryHex }}
              />
              <span>{compiledSpec.primaryHex}</span>
              <span
                className="w-3 h-3 rounded-xs border border-slate-300 shrink-0 ml-1"
                style={{ backgroundColor: compiledSpec.secondaryHex }}
              />
              <span>{compiledSpec.secondaryHex}</span>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-slate-700">
            <div>
              <span className="text-slate-500 block">Primary Material</span>
              <span className="font-medium text-slate-900">{compiledSpec.primaryMaterial}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Depth Ratio</span>
              <span className="font-mono tabular-nums font-medium text-slate-900">
                {compiledSpec.depthRatio.toFixed(2)}× span
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Support Topology</span>
              <span className="font-medium text-slate-900">
                {compiledSpec.supportTopology.replace(/_/g, ' ')}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Cavity Mode</span>
              <span className="font-medium text-slate-900">
                {compiledSpec.isHollowVessel ? 'Hollow vessel' : 'Closed volume'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Original Sketch Preservation Guarantee & Lock Action */}
      <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200">
        <div className="flex items-start gap-2 text-xs text-slate-600 max-w-xl">
          <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Original sketch integrity locked via SHA-256 ({sketchSha256.slice(0, 12)}…). Sketch2Shape never silently substitutes your hand-drawn sketch with a synthetic AI image prior to 3D reconstruction.
          </span>
        </div>

        {!isLocked && (
          <button
            type="button"
            disabled={disabled}
            onClick={handleConfirmLock}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Lock className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Confirm &amp; Lock Intent</span>
          </button>
        )}
      </div>
    </section>
  );
};
