import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Brush,
  Download,
  Eraser,
  RotateCcw,
  RotateCw,
  Trash2,
} from 'lucide-react';
import {
  renderPresetOnCanvas,
  SKETCH_PRESETS,
  type PresetSketchId,
} from '../utils/sketchPresets';
import { triggerBrowserDownload } from '../utils/glbValidator';

interface DrawingCanvasProps {
  onSketchChange: (blob: Blob, width: number, height: number, hasInk: boolean) => void;
  onApplyPresetHints?: (hints: {
    objectType: string;
    material: string;
    colour: string;
    style: string;
  }) => void;
  externalPresetTrigger?: { presetId: PresetSketchId; nonce: number } | null;
}

const CANVAS_WIDTH = 768;
const CANVAS_HEIGHT = 576;
const MAX_UNDO_STEPS = 25;

const STROKE_SIZES = [
  { label: 'Fine', value: 2.5 },
  { label: 'Medium', value: 4.5 },
  { label: 'Bold', value: 8 },
  { label: 'Broad', value: 14 },
];

const INK_SWATCHES = [
  { label: 'Ink Black', hex: '#0f172a' },
  { label: 'Graphite', hex: '#334155' },
  { label: 'Blueprint Blue', hex: '#1d4ed8' },
  { label: 'Construction Gray', hex: '#94a3b8' },
];

export const DrawingCanvas: React.FC<DrawingCanvasProps> = ({
  onSketchChange,
  onApplyPresetHints,
  externalPresetTrigger,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush');
  const [brushSize, setBrushSize] = useState<number>(4.5);
  const [eraserSize, setEraserSize] = useState<number>(22);
  const [inkColor, setInkColor] = useState<string>('#0f172a');
  const [undoCount, setUndoCount] = useState<number>(0);
  const [redoCount, setRedoCount] = useState<number>(0);
  const [hasVisibleStrokes, setHasVisibleStrokes] = useState<boolean>(false);

  const undoStackRef = useRef<ImageData[]>([]);
  const redoStackRef = useRef<ImageData[]>([]);
  const isDrawingRef = useRef<boolean>(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const midPointRef = useRef<{ x: number; y: number } | null>(null);

  const detectCanvasHasInk = useCallback((ctx: CanvasRenderingContext2D): boolean => {
    const sample = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT).data;
    // Check if any pixel differs noticeably from pure white (#ffffff)
    for (let i = 0; i < sample.length; i += 16) {
      if (sample[i] < 245 || sample[i + 1] < 245 || sample[i + 2] < 245) {
        return true;
      }
    }
    return false;
  }, []);

  const emitCanvasBlob = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const inkPresent = detectCanvasHasInk(ctx);
    setHasVisibleStrokes(inkPresent);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          onSketchChange(blob, CANVAS_WIDTH, CANVAS_HEIGHT, inkPresent);
        }
      },
      'image/png',
      1.0
    );
  }, [detectCanvasHasInk, onSketchChange]);

  const pushSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const snap = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    undoStackRef.current.push(snap);
    if (undoStackRef.current.length > MAX_UNDO_STEPS) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(0);
  }, []);

  // Initialize white canvas on mount and load Sample Chair Sketch by default if empty
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    emitCanvasBlob();
  }, [emitCanvasBlob]);

  const applyPreset = useCallback(
    (presetId: PresetSketchId) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      pushSnapshot();
      renderPresetOnCanvas(canvas, presetId);
      const preset = SKETCH_PRESETS.find((p) => p.id === presetId);
      if (preset && onApplyPresetHints) {
        onApplyPresetHints(preset.suggestedHints);
      }
      emitCanvasBlob();
    },
    [emitCanvasBlob, onApplyPresetHints, pushSnapshot]
  );

  // Respond to external preset trigger (e.g., Dashboard or Diagnostics "Load Sample Chair")
  const lastProcessedNonceRef = useRef<number>(-1);
  useEffect(() => {
    if (
      externalPresetTrigger &&
      externalPresetTrigger.nonce !== lastProcessedNonceRef.current
    ) {
      lastProcessedNonceRef.current = externalPresetTrigger.nonce;
      applyPreset(externalPresetTrigger.presetId);
    }
  }, [applyPreset, externalPresetTrigger]);

  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_WIDTH / rect.width;
    const scaleY = CANVAS_HEIGHT / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    pushSnapshot();

    const pt = getCanvasCoords(e);
    isDrawingRef.current = true;
    lastPointRef.current = pt;
    midPointRef.current = pt;

    const activeWidth = tool === 'eraser' ? eraserSize : brushSize;
    const activeColor = tool === 'eraser' ? '#ffffff' : inkColor;

    ctx.save();
    ctx.fillStyle = activeColor;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, activeWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx || !lastPointRef.current || !midPointRef.current) return;

    const currentPt = getCanvasCoords(e);
    const nextMid = {
      x: (lastPointRef.current.x + currentPt.x) / 2,
      y: (lastPointRef.current.y + currentPt.y) / 2,
    };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = tool === 'eraser' ? eraserSize : brushSize;
    ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : inkColor;
    ctx.beginPath();
    ctx.moveTo(midPointRef.current.x, midPointRef.current.y);
    ctx.quadraticCurveTo(
      lastPointRef.current.x,
      lastPointRef.current.y,
      nextMid.x,
      nextMid.y
    );
    ctx.stroke();
    ctx.restore();

    lastPointRef.current = currentPt;
    midPointRef.current = nextMid;
  };

  const finishStroke = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPointRef.current = null;
    midPointRef.current = null;
    emitCanvasBlob();
  };

  const handleUndo = () => {
    const canvas = canvasRef.current;
    if (!canvas || undoStackRef.current.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const current = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    redoStackRef.current.push(current);

    const prev = undoStackRef.current.pop()!;
    ctx.putImageData(prev, 0, 0);

    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    emitCanvasBlob();
  };

  const handleRedo = () => {
    const canvas = canvasRef.current;
    if (!canvas || redoStackRef.current.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const current = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    undoStackRef.current.push(current);

    const next = redoStackRef.current.pop()!;
    ctx.putImageData(next, 0, 0);

    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    emitCanvasBlob();
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    pushSnapshot();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    emitCanvasBlob();
  };

  const handleDownloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (blob) {
        triggerBrowserDownload(blob, `sketch2shape_draft_${Date.now()}.png`);
      }
    }, 'image/png');
  };

  return (
    <div className="space-y-4">
      {/* Sample Sketch Quick-Loader Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200">
        <div className="text-xs text-slate-600">
          <span className="font-semibold text-slate-800">Drafting Presets:</span>{' '}
          <span>Load an editable 3/4 industrial design sketch or draw from scratch</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {SKETCH_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                preset.id === 'lounge_chair'
                  ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Primary Drafting Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Brush / Eraser Segmented Control */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setTool('brush')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                tool === 'brush'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Brush className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Brush</span>
            </button>
            <button
              type="button"
              onClick={() => setTool('eraser')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                tool === 'eraser'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Eraser className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Eraser</span>
            </button>
          </div>

          {/* Stroke Width Selector */}
          {tool === 'brush' ? (
            <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {STROKE_SIZES.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => setBrushSize(s.value)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    brushSize === s.value
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 text-xs text-slate-600">
              <label htmlFor="eraser-width-range" className="whitespace-nowrap">
                Width: <span className="font-mono tabular-nums">{eraserSize}px</span>
              </label>
              <input
                id="eraser-width-range"
                type="range"
                min={8}
                max={48}
                step={2}
                value={eraserSize}
                onChange={(e) => setEraserSize(Number(e.target.value))}
                className="w-24 accent-blue-600"
              />
            </div>
          )}

          {/* Ink Swatches */}
          {tool === 'brush' && (
            <div className="flex items-center gap-1.5" role="group" aria-label="Ink shade">
              {INK_SWATCHES.map((swatch) => (
                <button
                  key={swatch.hex}
                  type="button"
                  title={swatch.label}
                  aria-label={swatch.label}
                  onClick={() => setInkColor(swatch.hex)}
                  className={`w-6 h-6 rounded-md border transition-transform ${
                    inkColor === swatch.hex
                      ? 'ring-2 ring-blue-600 ring-offset-1 border-slate-900 scale-105'
                      : 'border-slate-300 hover:scale-105'
                  }`}
                  style={{ backgroundColor: swatch.hex }}
                />
              ))}
            </div>
          )}
        </div>

        {/* History & Export Actions */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleUndo}
            disabled={undoCount === 0}
            title="Undo stroke"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Undo</span>
          </button>
          <button
            type="button"
            onClick={handleRedo}
            disabled={redoCount === 0}
            title="Redo stroke"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Redo</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-red-50 hover:text-red-700 hover:border-red-200 transition-colors whitespace-nowrap shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Clear</span>
          </button>
          <button
            type="button"
            onClick={handleDownloadPng}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Download PNG</span>
          </button>
        </div>
      </div>

      {/* Drafting Sheet Surface */}
      <div className="relative w-full aspect-[4/3] bg-white border border-slate-300 rounded-lg overflow-hidden select-none touch-none">
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onPointerLeave={finishStroke}
          className="w-full h-full block cursor-crosshair touch-none"
          aria-label="2D sketch drafting canvas"
        />

        {!hasVisibleStrokes && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-6">
            <p className="text-sm font-medium text-slate-400">
              Draw your 2D object silhouette here or click &ldquo;Sample Chair Sketch&rdquo; above
            </p>
            <p className="text-xs text-slate-400 mt-1">
              768 × 576 px studio sheet · Preserved verbatim for 3D reconstruction
            </p>
          </div>
        )}
      </div>

      {/* Quiet Inline Canvas Metadata (Zero Pills) */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <div className="flex items-center gap-2 font-mono tabular-nums">
          <span>768 × 576 px</span>
          <span aria-hidden="true">·</span>
          <span>PNG Lossless</span>
          <span aria-hidden="true">·</span>
          <span>Undo steps: {undoCount}</span>
        </div>
        <span>Original 2D strokes are sent directly to Tripo without image replacement</span>
      </div>
    </div>
  );
};
