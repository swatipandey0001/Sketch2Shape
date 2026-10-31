import React, { useCallback, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileImage, Trash2, Upload } from 'lucide-react';
import type { ActiveSketchAsset } from '../types/studio';
import { computeBlobSha256Hex } from '../utils/historyStore';

interface SketchUploadPanelProps {
  uploadedSketch: ActiveSketchAsset | null;
  onSelectValidUpload: (asset: ActiveSketchAsset) => void;
  onClearUpload: () => void;
}

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

async function sniffMagicMime(file: File): Promise<string | null> {
  const slice = await file.slice(0, 12).arrayBuffer();
  const b = new Uint8Array(slice);
  if (b.length < 12) return null;
  if (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function readImageDimensions(objectUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Browser could not decode image pixels.'));
    img.src = objectUrl;
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const SketchUploadPanel: React.FC<SketchUploadPanelProps> = ({
  uploadedSketch,
  onSelectValidUpload,
  onClearUpload,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [resolutionWarning, setResolutionWarning] = useState<string | null>(null);

  const processCandidateFile = useCallback(
    async (file: File) => {
      setValidationError(null);
      setResolutionWarning(null);

      if (file.size === 0) {
        setValidationError(`"${file.name}" is empty (0 bytes). Please choose a valid PNG, JPG, or WebP sketch.`);
        return;
      }

      if (file.size > MAX_BYTES) {
        setValidationError(
          `"${file.name}" is ${formatBytes(file.size)}, which exceeds the 20 MB maximum supported by Tripo 3D API.`
        );
        return;
      }

      const magicMime = await sniffMagicMime(file);
      if (!magicMime || !ALLOWED_MIMES.has(magicMime)) {
        setValidationError(
          `Unsupported file format for "${file.name}" (${file.type || 'unrecognized MIME'}). Only genuine PNG, JPG/JPEG, and WebP images are accepted.`
        );
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      try {
        const dims = await readImageDimensions(previewUrl);
        if (dims.width < 32 || dims.height < 32) {
          URL.revokeObjectURL(previewUrl);
          setValidationError(
            `Image resolution (${dims.width} × ${dims.height} px) is too small to analyse or reconstruct.`
          );
          return;
        }

        if (dims.width < 256 || dims.height < 256) {
          setResolutionWarning(
            `Uploaded sketch is ${dims.width} × ${dims.height} px. Tripo recommends at least 256 × 256 px for sharper 3D geometry.`
          );
        }

        const sha256 = await computeBlobSha256Hex(file);
        onSelectValidUpload({
          blob: file,
          previewUrl,
          fileName: file.name,
          mimeType: magicMime,
          sizeBytes: file.size,
          width: dims.width,
          height: dims.height,
          sourceMode: 'upload',
          sha256,
        });
      } catch (err: unknown) {
        URL.revokeObjectURL(previewUrl);
        setValidationError(
          err instanceof Error
            ? err.message
            : 'The selected image appears corrupted and could not be decoded.'
        );
      }
    },
    [onSelectValidUpload]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void processCandidateFile(file);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void processCandidateFile(file);
    }
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        onChange={handleFileChange}
        className="hidden"
      />

      {!uploadedSketch ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={`w-full aspect-[4/3] rounded-lg border-2 border-dashed flex flex-col items-center justify-center p-8 text-center cursor-pointer transition-colors ${
            isDragging
              ? 'border-blue-600 bg-blue-50/60'
              : 'border-slate-300 bg-slate-50/70 hover:border-slate-400 hover:bg-slate-100/60'
          }`}
        >
          <div className="w-11 h-11 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-700 mb-3">
            <Upload className="w-5 h-5" aria-hidden="true" />
          </div>
          <p className="text-sm font-semibold text-slate-900">
            Drop your 2D sketch image here, or click to browse
          </p>
          <p className="text-xs text-slate-500 mt-1.5 max-w-md">
            Supports PNG, JPG, and WebP up to 20 MB (minimum 256 × 256 px recommended). Your exact original file bytes are preserved for 3D reconstruction.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative w-full aspect-[4/3] bg-white border border-slate-200 rounded-lg overflow-hidden flex items-center justify-center p-3">
            <img
              src={uploadedSketch.previewUrl}
              alt={`Uploaded sketch preview: ${uploadedSketch.fileName}`}
              referrerPolicy="no-referrer"
              className="max-w-full max-h-full object-contain"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-900">
                <FileImage className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                <span className="truncate max-w-[260px]">{uploadedSketch.fileName}</span>
                <span className="text-emerald-700 inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Validated</span>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                <span>{uploadedSketch.mimeType}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {uploadedSketch.width} × {uploadedSketch.height} px
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(uploadedSketch.sizeBytes)}</span>
                {uploadedSketch.sha256 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>SHA-256 {uploadedSketch.sha256.slice(0, 12)}…</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                Replace File
              </button>
              <button
                type="button"
                onClick={onClearUpload}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 bg-white border border-slate-200 rounded-md hover:bg-red-50 hover:border-red-200 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Remove</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {validationError && (
        <div
          role="alert"
          className="p-3.5 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-900"
        >
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-semibold">Sketch Upload Validation Failed</p>
            <p className="mt-0.5 text-red-800">{validationError}</p>
          </div>
        </div>
      )}

      {resolutionWarning && !validationError && (
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-900">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
          <p>{resolutionWarning}</p>
        </div>
      )}
    </div>
  );
};
