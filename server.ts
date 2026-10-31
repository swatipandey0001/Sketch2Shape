import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';

dotenv.config({ override: true, quiet: true });

let genAiModulePromise: Promise<typeof import('@google/genai')> | null = null;
function loadGenAiSdk(): Promise<typeof import('@google/genai')> {
  if (!genAiModulePromise) {
    genAiModulePromise = import('@google/genai');
  }
  return genAiModulePromise;
}

function resolveCliArg(flag: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag && args[i + 1] && !args[i + 1].startsWith('-')) {
      return args[i + 1];
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(resolveCliArg('--port') || process.env.PORT) || 3000;
const HOST = resolveCliArg('--host') || process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB official Tripo API limit
const POLL_TIMEOUT_SECONDS = 180;
const TRIPO_API_BASE = 'https://openapi.tripo3d.ai/v3';
const TRIPO_MODEL_VERSION = (process.env.TRIPO_MODEL_VERSION || 'v3.1-20260211').trim();
const GEMINI_VISION_MODEL = 'gemini-3.8-flash';
const GEMINI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';

const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

interface StructuredErrorBody {
  code: string;
  title: string;
  message: string;
  suggestion?: string;
  tripoCode?: number;
  requestId?: string;
  diagnosticSimulation?: boolean;
}

/**
 * In the AI Studio container, Nginx has:
 *   proxy_intercept_errors on;
 *   error_page 403 = /forbidden.html;
 *   error_page 502 503 504 = /warmup.html;
 * Returning HTTP 403, 502, 503, or 504 causes Nginx to discard Express's JSON body
 * and serve HTML ("<!doctype html>..."). Mapping those statuses to semantically
 * accurate non-intercepted statuses (401, 408, 424) ensures structured JSON always
 * reaches the browser intact.
 */
function normalizeProxySafeErrorStatus(status: number): number {
  if (status === 403) return 401;
  if (status === 504) return 408;
  if (status === 502 || status === 503) return 424;
  if (status < 400 || status >= 600) return 500;
  return status;
}

function sendJsonSuccess(res: Response, payload: Record<string, unknown>, status = 200): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(payload));
}

function sendJsonError(res: Response, status: number, error: StructuredErrorBody): void {
  const safeStatus = normalizeProxySafeErrorStatus(status);
  res.status(safeStatus);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify({ error }));
}

interface StoredTripoTask {
  taskId: string;
  createdAt: number;
  sketchSha256: string;
  originalSketchSha256: string;
  objectName: string;
  tripoModelVersion: string;
  intentSummary?: string;
  remoteModelUrl?: string;
  cachedGlbBuffer?: Buffer;
}

const taskStore = new Map<string, StoredTripoTask>();
const MAX_CACHED_GLBS = 6;

function pruneTaskStore() {
  const now = Date.now();
  const maxAgeMs = 60 * 60 * 1000; // 1 hour
  for (const [id, entry] of taskStore.entries()) {
    if (now - entry.createdAt > maxAgeMs) {
      taskStore.delete(id);
    }
  }
  const withBuffers = Array.from(taskStore.values())
    .filter((t) => Boolean(t.cachedGlbBuffer))
    .sort((a, b) => b.createdAt - a.createdAt);

  if (withBuffers.length > MAX_CACHED_GLBS) {
    for (const stale of withBuffers.slice(MAX_CACHED_GLBS)) {
      stale.cachedGlbBuffer = undefined;
    }
  }
}

function getGeminiKey(): string {
  return (process.env.GEMINI_API_KEY || '').trim();
}

function getTripoKey(): string {
  const raw = (process.env.TRIPO_API_KEY || '').trim();
  if (!raw || raw === 'MY_TRIPO_API_KEY' || raw === 'YOUR_TRIPO_API_KEY') {
    return '';
  }
  return raw;
}

function detectImageMimeFromMagicBytes(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export function verifyGlbHeader(buf: Buffer): {
  valid: boolean;
  version: number;
  declaredLength: number;
  reason?: string;
} {
  if (buf.length < 20) {
    return {
      valid: false,
      version: 0,
      declaredLength: 0,
      reason: 'Downloaded file is smaller than the 20-byte GLB header + JSON chunk prefix.',
    };
  }
  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const declaredLength = buf.readUInt32LE(8);
  const chunk0Length = buf.readUInt32LE(12);
  const chunk0Type = buf.readUInt32LE(16);

  // 0x46546C67 === ASCII "glTF"
  if (magic !== 0x46546c67) {
    return {
      valid: false,
      version,
      declaredLength,
      reason: 'Binary header magic does not match glTF/GLB specification (expected "glTF").',
    };
  }
  if (version !== 2) {
    return {
      valid: false,
      version,
      declaredLength,
      reason: `Unsupported GLB binary version ${version} (expected glTF 2.0).`,
    };
  }
  if (declaredLength < 20 || buf.length < declaredLength) {
    return {
      valid: false,
      version,
      declaredLength,
      reason: `Truncated GLB binary detected: header declares ${declaredLength} bytes, but buffer contains only ${buf.length} bytes.`,
    };
  }
  // 0x4E4F534A === ASCII "JSON"
  if (chunk0Type !== 0x4e4f534a || chunk0Length === 0 || 20 + chunk0Length > declaredLength) {
    return {
      valid: false,
      version,
      declaredLength,
      reason: 'GLB JSON chunk header is malformed or exceeds declared binary length.',
    };
  }
  return { valid: true, version, declaredLength };
}

export function mapTripoError(
  httpStatus: number,
  payload: Record<string, unknown> | null,
  traceHeader?: string | null
) {
  const tripoCode = typeof payload?.code === 'number' ? payload.code : undefined;
  const rawMessage =
    typeof payload?.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : 'Tripo API returned an unexpected error.';
  const suggestion = typeof payload?.suggestion === 'string' ? payload.suggestion : undefined;
  const requestId =
    (typeof payload?.request_id === 'string' && payload.request_id) ||
    (typeof payload?.trace_id === 'string' && payload.trace_id) ||
    (traceHeader && traceHeader.trim() ? traceHeader.trim() : undefined);

  if (tripoCode === 2010 || httpStatus === 402 || (httpStatus === 403 && /credit|balance/i.test(rawMessage))) {
    return {
      status: 402,
      error: {
        code: 'TRIPO_INSUFFICIENT_CREDITS',
        title: 'Insufficient Tripo API Credits',
        message:
          rawMessage ||
          'Your Tripo developer account does not have enough credits to run an image-to-3D task.',
        suggestion:
          suggestion ||
          'Top up API credits at platform.tripo3d.ai, or click "Offline Contour 3D Reconstruction" to build a local mesh from your sketch contours.',
        tripoCode,
        requestId,
      },
    };
  }

  if (tripoCode === 2 || tripoCode === 1002 || httpStatus === 401) {
    return {
      status: 401,
      error: {
        code: 'TRIPO_AUTH_FAILED',
        title: 'Tripo API Authentication Failed',
        message: rawMessage || 'Tripo rejected the configured TRIPO_API_KEY.',
        suggestion:
          suggestion ||
          'Verify that TRIPO_API_KEY in Settings > Secrets starts with tsk_ and is active, or use Offline Contour 3D Reconstruction.',
        tripoCode,
        requestId,
      },
    };
  }

  if (tripoCode === 1005 || httpStatus === 403) {
    return {
      status: 403,
      error: {
        code: 'TRIPO_FORBIDDEN',
        title: 'Tripo API Access Forbidden',
        message: rawMessage || 'Your Tripo API key does not have permission for this v3 resource.',
        suggestion:
          suggestion ||
          'Check account permissions on platform.tripo3d.ai or use Offline Contour 3D Reconstruction.',
        tripoCode,
        requestId,
      },
    };
  }

  if (tripoCode === 1003) {
    return {
      status: 400,
      error: {
        code: 'TRIPO_MALFORMED_REQUEST',
        title: 'Malformed Tripo v3 Request Payload',
        message: rawMessage,
        suggestion: suggestion || 'Check the image-to-model v3 JSON request body format.',
        tripoCode,
        requestId,
      },
    };
  }

  if (tripoCode === 1004 || httpStatus === 422) {
    return {
      status: 400,
      error: {
        code: 'TRIPO_INVALID_PARAMETER',
        title: 'Invalid Tripo v3 Generation Parameter',
        message: rawMessage,
        suggestion:
          suggestion ||
          `Verify TRIPO_MODEL_VERSION (currently "${TRIPO_MODEL_VERSION}") and v3 parameter compatibility.`,
        tripoCode,
        requestId,
      },
    };
  }

  if (tripoCode === 1007 || tripoCode === 2000 || httpStatus === 429) {
    return {
      status: 429,
      error: {
        code: 'TRIPO_RATE_LIMITED',
        title: 'Tripo Rate or Concurrency Limit Reached',
        message: rawMessage || 'Too many concurrent or recent 3D generation tasks are active.',
        suggestion: suggestion || 'Wait 15–30 seconds for active tasks to finish, then click Retry.',
        tripoCode,
        requestId,
      },
    };
  }

  if (tripoCode === 2003 || tripoCode === 2004) {
    return {
      status: 400,
      error: {
        code: 'TRIPO_UNSUPPORTED_IMAGE',
        title: 'Sketch Image Rejected by Tripo',
        message: rawMessage,
        suggestion:
          suggestion ||
          'Switch to the CV-Prepared 1:1 white-padded sketch or upload a clear PNG, JPG, or WebP sketch.',
        tripoCode,
        requestId,
      },
    };
  }

  if (tripoCode === 2008) {
    return {
      status: 400,
      error: {
        code: 'TRIPO_CONTENT_POLICY',
        title: 'Input Rejected by Content Safety Policy',
        message: rawMessage,
        suggestion: suggestion || 'Revise the uploaded sketch and try again.',
        tripoCode,
        requestId,
      },
    };
  }

  if (tripoCode === 1000 || tripoCode === 1001 || httpStatus >= 500) {
    return {
      status: 502,
      error: {
        code: 'TRIPO_UPSTREAM_SERVER_ERROR',
        title: 'Tripo Upstream Inference Error',
        message: rawMessage,
        suggestion:
          suggestion ||
          'Tripo GPU cluster encountered an internal error. Retry shortly or run Offline Contour 3D Reconstruction.',
        tripoCode,
        requestId,
      },
    };
  }

  return {
    status: httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502,
    error: {
      code: 'TRIPO_API_ERROR',
      title: 'Tripo 3D Service Error',
      message: rawMessage,
      suggestion: suggestion || 'Inspect the error details or retry generation shortly.',
      tripoCode,
      requestId,
    },
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

function parseSingleSketchUpload(req: Request, res: Response): Promise<boolean> {
  return new Promise((resolve) => {
    upload.single('sketch')(req, res, (err: unknown) => {
      if (!err) {
        resolve(true);
        return;
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        sendJsonError(res, 413, {
          code: 'FILE_TOO_LARGE',
          title: 'Sketch File Exceeds 20 MB Limit',
          message: 'Uploaded sketch exceeds the maximum 20 MB file size supported by Tripo 3D API.',
          suggestion: 'Resize or compress the PNG, JPG, or WebP sketch below 20 MB.',
        });
        resolve(false);
        return;
      }
      sendJsonError(res, 400, {
        code: 'UPLOAD_ERROR',
        title: 'Sketch Upload Parsing Error',
        message: err instanceof Error ? err.message : 'Failed to parse multipart sketch upload.',
        suggestion: 'Ensure you submit a valid PNG, JPG, or WebP file under field "sketch".',
      });
      resolve(false);
    });
  });
}

function validateUploadedSketch(file: Express.Multer.File | undefined) {
  if (!file) {
    return {
      ok: false as const,
      status: 400,
      error: {
        code: 'MISSING_SKETCH_FILE',
        title: 'No Sketch Image Provided',
        message: 'Attach a drawn canvas PNG or upload a PNG, JPG, or WebP sketch before continuing.',
        suggestion: 'Draw on the canvas or select an image file under 20 MB.',
      },
    };
  }

  if (!file.buffer || file.buffer.length === 0) {
    return {
      ok: false as const,
      status: 400,
      error: {
        code: 'EMPTY_SKETCH_FILE',
        title: 'Sketch File Is Empty',
        message: 'The uploaded sketch contains 0 bytes.',
        suggestion: 'Choose a valid non-empty PNG, JPG, or WebP image.',
      },
    };
  }

  const detectedMime = detectImageMimeFromMagicBytes(file.buffer);
  if (!detectedMime || !SUPPORTED_MIME_TYPES.has(detectedMime)) {
    return {
      ok: false as const,
      status: 415,
      error: {
        code: 'UNSUPPORTED_FILE_FORMAT',
        title: 'Unsupported Sketch File Format',
        message: `Uploaded file "${file.originalname}" is not a valid PNG, JPG, or WebP binary image (declared MIME: ${file.mimetype || 'unknown'}).`,
        suggestion: 'Export or upload your sketch strictly as PNG (.png), JPEG (.jpg/.jpeg), or WebP (.webp).',
      },
    };
  }

  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  return {
    ok: true as const,
    detectedMime,
    sha256,
  };
}

function buildSketchAnalysisSchema(Type: typeof import('@google/genai').Type) {
  return {
    type: Type.OBJECT,
    properties: {
      object_name: {
        type: Type.STRING,
        description: 'Concise name of the 3D object depicted in the 2D sketch.',
      },
      object_category: {
        type: Type.STRING,
        description:
          'Canonical local 3D reconstruction family: one of "chair", "table", "mug_vessel", "lamp", "shelf_cabinet", "bracket_mechanical", or "unsupported" (use "unsupported" for organic/freeform subjects such as animals, humans, faces, soft cloth, trees, or articulated vehicles).',
      },
      category_supported: {
        type: Type.BOOLEAN,
        description: 'True if object_category is one of the 6 supported structural families; false if "unsupported" or blank.',
      },
      unsupported_reason: {
        type: Type.STRING,
        description: 'Empty string when category_supported is true; otherwise an honest engineering explanation of why local parametric/component 3D synthesis cannot faithfully reconstruct this freeform/organic category without neural priors.',
      },
      visible_components: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Distinct structural parts directly drawn and visible in the 2D strokes.',
      },
      observed_features: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Geometric or stylistic details strictly supported by visible lines in the sketch. Never include occluded geometry here.',
      },
      uncertain_features: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            feature_name: { type: Type.STRING },
            uncertainty_reason: {
              type: Type.STRING,
              description: 'Why this 3D detail is ambiguous or occluded from the single 2D sketch viewpoint.',
            },
            options: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '2 to 4 concrete structural choices the designer can confirm.',
            },
            default_assumption: { type: Type.STRING },
            importance: {
              type: Type.STRING,
              description: 'Either "critical" or "moderate". Omit trivial questions.',
            },
          },
          required: [
            'id',
            'feature_name',
            'uncertainty_reason',
            'options',
            'default_assumption',
            'importance',
          ],
        },
        description: 'Important 3D ambiguities (0 to 4 items max) that cannot be proven from the 2D sketch alone. Do not invent trivial filler questions.',
      },
      inferred_features: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Hidden geometry (back face, underside support, occluded legs, depth thickness, bilateral symmetry) that must be estimated during 3D reconstruction.',
      },
      proportions_description: {
        type: Type.STRING,
        description: 'Estimated height-to-width-to-depth ratios and silhouette balance based on visible perspective cues.',
      },
      material_preferences: {
        type: Type.OBJECT,
        properties: {
          primary_material: { type: Type.STRING },
          secondary_material: { type: Type.STRING },
          colour_palette: { type: Type.STRING },
          surface_finish: { type: Type.STRING },
          source_note: {
            type: Type.STRING,
            description: 'State clearly whether materials came from user-supplied text hints or are plausible industrial design suggestions.',
          },
        },
        required: [
          'primary_material',
          'secondary_material',
          'colour_palette',
          'surface_finish',
          'source_note',
        ],
      },
      structural_blueprint: {
        type: Type.OBJECT,
        properties: {
          viewpoint: {
            type: Type.STRING,
            description: 'One of "front", "side", "three_quarter", "top_angled", "orthographic".',
          },
          width_to_height_ratio: {
            type: Type.NUMBER,
            description: 'Estimated 3D object width divided by total height (e.g. 0.65 for dining chair, 1.45 for coffee table).',
          },
          depth_to_width_ratio: {
            type: Type.NUMBER,
            description: 'Estimated 3D front-to-back depth divided by width (e.g. 0.95 for chair, 0.55 for console table, 1.0 for cylindrical mug).',
          },
          has_backrest: {
            type: Type.BOOLEAN,
            description: 'True only if a chair/bench backrest is visibly drawn.',
          },
          backrest_style: {
            type: Type.STRING,
            description: 'One of "solid_shell", "slatted_vertical", "slatted_horizontal", "open_frame", "none".',
          },
          backrest_tilt_deg: {
            type: Type.NUMBER,
            description: 'Estimated backward recline angle of backrest in degrees (0 to 25).',
          },
          seat_or_top_height_ratio: {
            type: Type.NUMBER,
            description: 'Height of seat surface or tabletop from floor as a fraction of total object height (0.20 to 0.92).',
          },
          seat_or_top_shape: {
            type: Type.STRING,
            description: 'One of "rectangular", "rounded_rect", "circular", "oval", "contoured".',
          },
          has_armrests: {
            type: Type.BOOLEAN,
            description: 'True ONLY if armrests are visibly drawn on the chair.',
          },
          visible_leg_count: {
            type: Type.NUMBER,
            description: 'Number of distinct legs/columns directly visible in the 2D drawing.',
          },
          inferred_total_leg_count: {
            type: Type.NUMBER,
            description: 'Plausible complete 3D leg count (e.g. 4 for standard chair/table, 3 for tripod, 1 for pedestal, 0 for vessel/bracket).',
          },
          leg_style: {
            type: Type.STRING,
            description: 'One of "four_legs_straight", "four_legs_splayed", "three_leg_tripod", "central_pedestal", "sled_runners", "cantilever", "plinth_base", "none".',
          },
          has_stretchers_or_apron: {
            type: Type.BOOLEAN,
            description: 'True if cross-stretchers, footrest ring, or under-frame apron rails are drawn.',
          },
          has_side_handle: {
            type: Type.BOOLEAN,
            description: 'True if a mug/pitcher side handle is visibly drawn.',
          },
          handle_side: {
            type: Type.STRING,
            description: 'One of "left", "right", "both", "none".',
          },
          is_hollow_open_top: {
            type: Type.BOOLEAN,
            description: 'True if open-top hollow vessel/cup/mug/bowl/vase; false if sealed or solid.',
          },
          shelf_tier_count: {
            type: Type.NUMBER,
            description: 'Number of horizontal shelf levels when object_category is "shelf_cabinet" (0 otherwise).',
          },
          shade_profile: {
            type: Type.STRING,
            description: 'For lamps: one of "conical", "drum", "dome", "bell", "none".',
          },
        },
        required: [
          'viewpoint',
          'width_to_height_ratio',
          'depth_to_width_ratio',
          'has_backrest',
          'backrest_style',
          'backrest_tilt_deg',
          'seat_or_top_height_ratio',
          'seat_or_top_shape',
          'has_armrests',
          'visible_leg_count',
          'inferred_total_leg_count',
          'leg_style',
          'has_stretchers_or_apron',
          'has_side_handle',
          'handle_side',
          'is_hollow_open_top',
          'shelf_tier_count',
          'shade_profile',
        ],
      },
      reconstruction_options: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: {
              type: Type.STRING,
              description: 'Must be "sketch_faithful", "structurally_refined", or "design_enhanced".',
            },
            explanation: {
              type: Type.STRING,
              description: 'Concise 1-2 sentence explanation of how this option reconstructs this specific sketch.',
            },
            inferred_changes: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '2 to 4 specific geometric/structural assumptions or refinements applied in this option.',
            },
            confidence_score: {
              type: Type.NUMBER,
              description: 'Evidence-grounded confidence percentage (0 to 100) based on visible stroke clarity vs occluded inference.',
            },
            confidence_rationale: {
              type: Type.STRING,
              description: 'Why confidence has this score based on direct 2D evidence vs inferred hidden structure.',
            },
          },
          required: [
            'id',
            'explanation',
            'inferred_changes',
            'confidence_score',
            'confidence_rationale',
          ],
        },
        description: 'Exactly 3 reconstruction option concepts in order: sketch_faithful (Option A), structurally_refined (Option B), and design_enhanced (Option C).',
      },
      reconstruction_notes: {
        type: Type.STRING,
        description: 'Engineering guidance on preserving the 2D silhouette, perspective pitfalls, and topological considerations for 3D mesh generation.',
      },
    },
    required: [
      'object_name',
      'object_category',
      'category_supported',
      'unsupported_reason',
      'visible_components',
      'observed_features',
      'uncertain_features',
      'inferred_features',
      'proportions_description',
      'material_preferences',
      'structural_blueprint',
      'reconstruction_options',
      'reconstruction_notes',
    ],
  };
}

function sanitizeStringArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item): item is string => typeof item === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type ServerCategory =
  | 'chair'
  | 'table'
  | 'mug_vessel'
  | 'lamp'
  | 'shelf_cabinet'
  | 'bracket_mechanical'
  | 'unsupported';

function inferCategoryFromCorpus(
  objectName: string,
  hintType: string,
  visibleComponents: string[],
  rawCategory: unknown
): { category: ServerCategory; supported: boolean; unsupportedReason: string } {
  const combined = `${objectName} | ${hintType} | ${visibleComponents.join(' ')}`.toLowerCase();

  if (/unrecognized|blank\s*sketch/i.test(objectName)) {
    return {
      category: 'unsupported',
      supported: false,
      unsupportedReason:
        'The uploaded or drawn canvas appears blank or lacks recognizable object strokes for 3D synthesis.',
    };
  }

  // Explicit check for freeform organic / complex categories that local parametric synthesis must honestly decline
  if (
    /\b(cat|dog|horse|bird|animal|lion|tiger|elephant|dragon|monster|dinosaur|human|person|portrait|face|head|hand|foot|shoe|sneaker|boot|car|sedan|suv|truck|bus|motorcycle|bicycle|airplane|helicopter|boat|ship|tree|flower|plant\s*foliage|cloud|mountain|cloth|shirt|dress|jacket)\b/i.test(
      combined
    )
  ) {
    return {
      category: 'unsupported',
      supported: false,
      unsupportedReason:
        `Local component-based 3D reconstruction does not fabricate organic, anatomical, or complex vehicle meshes ("${objectName}"). Configure TRIPO_API_KEY for cloud neural single-view reconstruction, or sketch a supported structural category (chairs/seating, tables/desks, mugs/vessels/vases, lamps, shelving/cabinets, or mechanical brackets).`,
    };
  }

  const validCats = new Set<ServerCategory>([
    'chair',
    'table',
    'mug_vessel',
    'lamp',
    'shelf_cabinet',
    'bracket_mechanical',
    'unsupported',
  ]);
  const candidate =
    typeof rawCategory === 'string' ? (rawCategory.trim().toLowerCase() as ServerCategory) : null;

  if (/\b(chair|armchair|lounge\s*chair|stool|barstool|bench|seat|throne|rocker)\b/i.test(combined)) {
    return { category: 'chair', supported: true, unsupportedReason: '' };
  }
  if (/\b(lamp|lantern|sconce|chandelier|light\s*fixture)\b/i.test(combined)) {
    return { category: 'lamp', supported: true, unsupportedReason: '' };
  }
  if (/\b(mug|cup|teacup|goblet|tumbler|vase|bottle|pitcher|carafe|jug|bowl|jar|planter|urn|pot)\b/i.test(combined)) {
    return { category: 'mug_vessel', supported: true, unsupportedReason: '' };
  }
  if (/\b(shelf|bookshelf|bookcase|cabinet|rack|sideboard|dresser|wardrobe|cubby|nightstand|storage\s*unit)\b/i.test(combined)) {
    return { category: 'shelf_cabinet', supported: true, unsupportedReason: '' };
  }
  if (/\b(table|desk|workbench|console|counter)\b/i.test(combined)) {
    return { category: 'table', supported: true, unsupportedReason: '' };
  }
  if (/\b(bracket|wedge|flange|gusset|plate|block|prism|extrusion|gear|clamp|part|hinge|beam)\b/i.test(combined)) {
    return { category: 'bracket_mechanical', supported: true, unsupportedReason: '' };
  }

  if (candidate && validCats.has(candidate)) {
    if (candidate === 'unsupported') {
      return {
        category: 'unsupported',
        supported: false,
        unsupportedReason:
          `Local structural synthesis does not support "${objectName}" without fabricating geometry. Supported local families: chairs/seating, tables/desks, mugs/vessels, lamps, shelving/cabinets, and mechanical CAD brackets.`,
      };
    }
    return { category: candidate, supported: true, unsupportedReason: '' };
  }

  // Default simple geometric drawings to mechanical/extruded CAD part unless explicitly organic
  return { category: 'bracket_mechanical', supported: true, unsupportedReason: '' };
}

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Number(Math.min(max, Math.max(min, val)).toFixed(3));
}

function normalizeStructuralBlueprint(
  rawBp: unknown,
  category: ServerCategory,
  objectName: string,
  visibleComponents: string[],
  observedFeatures: string[]
) {
  const bp = rawBp && typeof rawBp === 'object' ? (rawBp as Record<string, unknown>) : {};
  const corpus = `${objectName} | ${visibleComponents.join(' ')} | ${observedFeatures.join(' ')}`.toLowerCase();

  const validViewpoints = new Set([
    'front',
    'side',
    'three_quarter',
    'top_angled',
    'orthographic',
  ]);
  const viewpoint =
    typeof bp.viewpoint === 'string' && validViewpoints.has(bp.viewpoint)
      ? bp.viewpoint
      : 'three_quarter';

  const isStool = /\b(stool|barstool|ottoman)\b/i.test(corpus) && !/\bbackrest\b/i.test(corpus);
  const defaultHasBackrest = category === 'chair' && !isStool;
  const has_backrest =
    typeof bp.has_backrest === 'boolean' ? bp.has_backrest : defaultHasBackrest;

  const validBackStyles = new Set([
    'solid_shell',
    'slatted_vertical',
    'slatted_horizontal',
    'open_frame',
    'none',
  ]);
  let backrest_style =
    typeof bp.backrest_style === 'string' && validBackStyles.has(bp.backrest_style)
      ? bp.backrest_style
      : !has_backrest
        ? 'none'
        : /\b(slat|spindle|rung|ladder)\b/i.test(corpus)
          ? /\b(horizontal|ladder)\b/i.test(corpus)
            ? 'slatted_horizontal'
            : 'slatted_vertical'
          : /\b(open\s*frame|hoop)\b/i.test(corpus)
            ? 'open_frame'
            : 'solid_shell';
  if (!has_backrest) backrest_style = 'none';

  const has_armrests =
    typeof bp.has_armrests === 'boolean'
      ? bp.has_armrests
      : category === 'chair' && /\b(armrest|arm\s*pad|armchair|lounge\s*chair|sculpted\s*arm|bentwood\s*arm)\b/i.test(corpus);

  const validShapes = new Set([
    'rectangular',
    'rounded_rect',
    'circular',
    'oval',
    'contoured',
  ]);
  const seat_or_top_shape =
    typeof bp.seat_or_top_shape === 'string' && validShapes.has(bp.seat_or_top_shape)
      ? bp.seat_or_top_shape
      : /\b(round|circular|disc|stool)\b/i.test(corpus)
        ? 'circular'
        : /\b(oval|ellip)\b/i.test(corpus)
          ? 'oval'
          : category === 'chair'
            ? 'contoured'
            : 'rounded_rect';

  const validLegStyles = new Set([
    'four_legs_straight',
    'four_legs_splayed',
    'three_leg_tripod',
    'central_pedestal',
    'sled_runners',
    'cantilever',
    'plinth_base',
    'none',
  ]);
  const leg_style =
    typeof bp.leg_style === 'string' && validLegStyles.has(bp.leg_style)
      ? bp.leg_style
      : category === 'mug_vessel' || category === 'bracket_mechanical' || category === 'lamp'
        ? 'none'
        : category === 'shelf_cabinet'
          ? 'plinth_base'
          : /\b(tripod|3[-\s]*leg|three[-\s]*leg)\b/i.test(corpus)
            ? 'three_leg_tripod'
            : /\b(pedestal|tulip|central\s*column)\b/i.test(corpus)
              ? 'central_pedestal'
              : /\b(sled)\b/i.test(corpus)
                ? 'sled_runners'
                : /\b(cantilever)\b/i.test(corpus)
                  ? 'cantilever'
                  : /\b(splay|angled|tapered|mid[-\s]*century|lounge)\b/i.test(corpus)
                    ? 'four_legs_splayed'
                    : 'four_legs_straight';

  const defaultSeatRatio =
    category === 'chair'
      ? isStool
        ? 0.86
        : 0.48
      : category === 'table'
        ? 0.88
        : 0.5;

  const has_side_handle =
    typeof bp.has_side_handle === 'boolean'
      ? bp.has_side_handle
      : category === 'mug_vessel' && /\b(mug|cup|pitcher|jug|handle)\b/i.test(corpus);

  const validHandleSides = new Set(['left', 'right', 'both', 'none']);
  const handle_side =
    typeof bp.handle_side === 'string' && validHandleSides.has(bp.handle_side)
      ? bp.handle_side
      : has_side_handle
        ? /\bleft\b/i.test(corpus)
          ? 'left'
          : 'right'
        : 'none';

  const validShadeProfiles = new Set(['conical', 'drum', 'dome', 'bell', 'none']);
  const shade_profile =
    typeof bp.shade_profile === 'string' && validShadeProfiles.has(bp.shade_profile)
      ? bp.shade_profile
      : category === 'lamp'
        ? /\b(dome|mushroom|hemisphere)\b/i.test(corpus)
          ? 'dome'
          : /\b(drum|cylinder)\b/i.test(corpus)
            ? 'drum'
            : 'conical'
        : 'none';

  return {
    viewpoint,
    width_to_height_ratio: clampNum(
      bp.width_to_height_ratio,
      0.25,
      3.5,
      category === 'table' ? 1.35 : category === 'chair' ? 0.72 : 0.85
    ),
    depth_to_width_ratio: clampNum(
      bp.depth_to_width_ratio,
      0.2,
      2.2,
      category === 'mug_vessel' || category === 'lamp'
        ? 1.0
        : category === 'shelf_cabinet'
          ? 0.42
          : category === 'table'
            ? 0.65
            : 0.92
    ),
    has_backrest,
    backrest_style,
    backrest_tilt_deg: clampNum(bp.backrest_tilt_deg, 0, 28, category === 'chair' ? 11 : 0),
    seat_or_top_height_ratio: clampNum(bp.seat_or_top_height_ratio, 0.18, 0.94, defaultSeatRatio),
    seat_or_top_shape,
    has_armrests,
    visible_leg_count: Math.round(
      clampNum(bp.visible_leg_count, 0, 6, category === 'chair' || category === 'table' ? 3 : 0)
    ),
    inferred_total_leg_count: Math.round(
      clampNum(
        bp.inferred_total_leg_count,
        0,
        6,
        leg_style === 'three_leg_tripod'
          ? 3
          : leg_style === 'central_pedestal'
            ? 1
            : category === 'chair' || category === 'table'
              ? 4
              : 0
      )
    ),
    leg_style,
    has_stretchers_or_apron:
      typeof bp.has_stretchers_or_apron === 'boolean'
        ? bp.has_stretchers_or_apron
        : /\b(stretcher|cross[-\s]*rail|footrest|apron)\b/i.test(corpus),
    has_side_handle,
    handle_side,
    is_hollow_open_top:
      typeof bp.is_hollow_open_top === 'boolean'
        ? bp.is_hollow_open_top
        : category === 'mug_vessel' && !/\b(sealed|closed\s*lid|capped)\b/i.test(corpus),
    shelf_tier_count: Math.round(
      clampNum(bp.shelf_tier_count, 0, 8, category === 'shelf_cabinet' ? 4 : 0)
    ),
    shade_profile,
  };
}

function buildDefaultOptionConcepts(
  category: ServerCategory,
  supported: boolean,
  unsupportedReason: string,
  objectName: string,
  uncertainCount: number,
  rawOptions: unknown
) {
  const rawArr = Array.isArray(rawOptions)
    ? rawOptions.filter((o): o is Record<string, unknown> => Boolean(o && typeof o === 'object'))
    : [];

  const findRaw = (id: string, idx: number) =>
    rawArr.find((o) => o.id === id) || rawArr[idx] || {};

  const confidenceTier = (score: number): 'high' | 'moderate' | 'limited' =>
    score >= 78 ? 'high' : score >= 55 ? 'moderate' : 'limited';

  const basePenalty = Math.min(18, uncertainCount * 5);

  const rA = findRaw('sketch_faithful', 0);
  const scoreA = supported
    ? Math.round(clampNum(rA.confidence_score, 35, 96, 88 - basePenalty))
    : 22;

  const rB = findRaw('structurally_refined', 1);
  const scoreB = supported
    ? Math.round(clampNum(rB.confidence_score, 35, 95, 82 - basePenalty))
    : 20;

  const rC = findRaw('design_enhanced', 2);
  const scoreC = supported
    ? Math.round(clampNum(rC.confidence_score, 30, 92, 74 - basePenalty))
    : 18;

  const defaultChangesByCategory: Record<
    ServerCategory,
    { a: string[]; b: string[]; c: string[] }
  > = {
    chair: {
      a: [
        'Preserves visible seat-to-backrest height ratio and outer silhouette width directly from the 2D drawing',
        'Constructs planar seat slab, thin rear backrest, and unembellished leg profiles with minimal hidden joinery',
        'Includes armrests or stretchers strictly when drawn in the original sketch',
      ],
      b: [
        'Infers complete symmetric 4-corner load-bearing leg geometry and floor-level foot alignment',
        'Adds recessed 4-rail under-seat structural apron frame and H-stretcher cross-bracing for rigidity',
        'Anchors backrest into rear seat frame via structural upright stiles so no parts float',
      ],
      c: [
        'Sculpts ergonomic waterfall front seat edge and gently curved lumbar backrest shell',
        'Refines legs with smooth multi-segment tapers, beveled rail transitions, and subtle ferrule accents',
        'Applies balanced dual-material upholstery/frame PBR finish contrast without adding unrequested parts',
      ],
    },
    table: {
      a: [
        'Preserves sketch tabletop aspect ratio, thickness, and visible leg placement',
        'Uses crisp planar tabletop and direct unembellished support legs with minimal underside hardware',
      ],
      b: [
        'Adds recessed perimeter under-tabletop apron rails and corner mounting blocks for load stability',
        'Completes symmetric rear leg placement and lower stabilizing cross-stretcher with floor glides',
      ],
      c: [
        'Refines tabletop with smooth bullnose/chamfered edge profile and faired corner radii',
        'Sculpts tapered legs with mortise joinery collars and calibrated primary/secondary material contrast',
      ],
    },
    mug_vessel: {
      a: [
        'Revolves outer wall directly from measured 2D sketch scanline radii (32-segment lathe)',
        'Traces visible side handle loop matching sketch height and protrusion bounds',
      ],
      b: [
        'Carves uniform wall thickness for a true hollow interior cavity and adds a recessed base foot-ring',
        'Reinforces top lip rim and welds 3D tubular handle into vessel wall with upper/lower structural bosses',
      ],
      c: [
        'Fairs scanline profile via smooth Catmull-Rom curve interpolation (64 segments) with rolled drinking lip',
        'Shapes ergonomic swept handle cross-section and glazed body vs unglazed ceramic foot-ring contrast',
      ],
    },
    lamp: {
      a: [
        'Reconstructs base, central stem, and open diffuser shade directly from sketch elevation bands',
        'Makes minimal assumptions about hidden internal socket or spider hardware',
      ],
      b: [
        'Adds weighted plinth base ring, stem collar, internal bulb socket core, and 3-strut shade harp/spider',
        'Connects diffuser shade physically to the central column so no components float',
      ],
      c: [
        'Sculpts faired ceramic/metal base profile with smooth bevels and rolled shade rim trim',
        'Applies warm inner shade diffuser material and brushed metallic neck hardware accents',
      ],
    },
    shelf_cabinet: {
      a: [
        'Places vertical side uprights and horizontal shelf tiers at heights matching visible sketch lines',
        'Keeps back plane open unless closed backing strokes are directly drawn',
      ],
      b: [
        'Adds grounded base plinth/feet, under-shelf structural support cleats, and rear anti-racking cross-brace',
        'Ensures uniform shelf thickness and rigid orthogonal frame joinery',
      ],
      c: [
        'Refines uprights and shelves with chamfered face-frame edges, inset tier reveals, and tapered base feet',
        'Balances primary cabinet/wood tone with contrasting structural frame accents',
      ],
    },
    bracket_mechanical: {
      a: [
        'Extrudes exact 2D outer contour polygons and interior mounting holes with crisp minimal bevels',
        'Preserves 1:1 measured sketch silhouette and aperture geometry',
      ],
      b: [
        'Adds raised machined mounting bosses/collars around interior holes and structural backing web stiffness',
        'Ensures uniform load-bearing flange wall thickness',
      ],
      c: [
        'Applies multi-segment precision industrial chamfers/fillets along outer edges and hole rims',
        'Separates primary machined body and collar hardware finishes',
      ],
    },
    unsupported: {
      a: ['Local structural component synthesis declined honestly for unsupported freeform/organic category'],
      b: ['Requires cloud neural single-view reconstruction (TRIPO_API_KEY) for plausible organic surfaces'],
      c: ['Limited silhouette extrusion fallback remains opt-in only and is never presented as full 3D'],
    },
  };

  const defaults = defaultChangesByCategory[category];

  return [
    {
      id: 'sketch_faithful' as const,
      code: 'OPTION A' as const,
      name: 'Sketch Faithful' as const,
      tagline: 'Strict silhouette & visible component fidelity',
      explanation:
        typeof rA.explanation === 'string' && rA.explanation.trim()
          ? rA.explanation.trim()
          : supported
            ? `Reconstructs "${objectName}" strictly from visible 2D proportions and drawn parts with minimal assumptions about hidden joinery.`
            : unsupportedReason,
      inferred_changes:
        sanitizeStringArray(rA.inferred_changes).length > 0
          ? sanitizeStringArray(rA.inferred_changes).slice(0, 4)
          : defaults.a,
      confidence_score: scoreA,
      confidence_level: confidenceTier(scoreA),
      confidence_rationale:
        typeof rA.confidence_rationale === 'string' && rA.confidence_rationale.trim()
          ? rA.confidence_rationale.trim()
          : supported
            ? 'Highest direct correspondence to visible 2D strokes because hidden structural additions are minimized.'
            : 'Category requires neural 3D surface priors not available in local parametric builders.',
      supported,
      ...(unsupportedReason ? { unsupported_reason: unsupportedReason } : {}),
    },
    {
      id: 'structurally_refined' as const,
      code: 'OPTION B' as const,
      name: 'Structurally Refined' as const,
      tagline: 'Complete load-bearing 3D components & joinery',
      explanation:
        typeof rB.explanation === 'string' && rB.explanation.trim()
          ? rB.explanation.trim()
          : supported
            ? `Completes "${objectName}" with physically coherent 3D sub-components, inferring occluded supports, aprons, and wall thickness.`
            : unsupportedReason,
      inferred_changes:
        sanitizeStringArray(rB.inferred_changes).length > 0
          ? sanitizeStringArray(rB.inferred_changes).slice(0, 4)
          : defaults.b,
      confidence_score: scoreB,
      confidence_level: confidenceTier(scoreB),
      confidence_rationale:
        typeof rB.confidence_rationale === 'string' && rB.confidence_rationale.trim()
          ? rB.confidence_rationale.trim()
          : supported
            ? 'Grounded in visible sketch proportions plus standard industrial engineering rules for occluded supports.'
            : 'Category requires neural 3D surface priors not available in local parametric builders.',
      supported,
      ...(unsupportedReason ? { unsupported_reason: unsupportedReason } : {}),
    },
    {
      id: 'design_enhanced' as const,
      code: 'OPTION C' as const,
      name: 'Design Enhanced' as const,
      tagline: 'Ergonomic curvature, faired transitions & finish',
      explanation:
        typeof rC.explanation === 'string' && rC.explanation.trim()
          ? rC.explanation.trim()
          : supported
            ? `Preserves the identity of "${objectName}" while refining surface curvature, edge fillets, tapers, and multi-material finish.`
            : unsupportedReason,
      inferred_changes:
        sanitizeStringArray(rC.inferred_changes).length > 0
          ? sanitizeStringArray(rC.inferred_changes).slice(0, 4)
          : defaults.c,
      confidence_score: scoreC,
      confidence_level: confidenceTier(scoreC),
      confidence_rationale:
        typeof rC.confidence_rationale === 'string' && rC.confidence_rationale.trim()
          ? rC.confidence_rationale.trim()
          : supported
            ? 'Preserves primary sketch silhouette while applying industrial design curvature and bevel refinements.'
            : 'Category requires neural 3D surface priors not available in local parametric builders.',
      supported,
      ...(unsupportedReason ? { unsupported_reason: unsupportedReason } : {}),
    },
  ];
}

/**
 * Deeply validates and normalizes the Gemini multimodal sketch analysis JSON so missing nested
 * arrays/strings never crash downstream UI components, while guaranteeing category + 3-option blueprints.
 */
export function validateAndNormalizeAnalysisPayload(
  obj: unknown,
  hints: { objectType: string; material: string; colour: string; style: string }
): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;

  if (
    typeof rec.object_name !== 'string' ||
    rec.object_name.trim().length === 0 ||
    !Array.isArray(rec.visible_components) ||
    !Array.isArray(rec.observed_features) ||
    !Array.isArray(rec.uncertain_features) ||
    !Array.isArray(rec.inferred_features) ||
    typeof rec.proportions_description !== 'string' ||
    typeof rec.material_preferences !== 'object' ||
    rec.material_preferences === null ||
    typeof rec.reconstruction_notes !== 'string'
  ) {
    return null;
  }

  const cleanObjectName = rec.object_name.trim();
  const visibleComponents = sanitizeStringArray(rec.visible_components);
  const observedFeatures = sanitizeStringArray(rec.observed_features);

  const normalizedUncertain = rec.uncertain_features
    .filter((u): u is Record<string, unknown> => Boolean(u && typeof u === 'object'))
    .slice(0, 4)
    .map((u, idx) => {
      const featureName =
        typeof u.feature_name === 'string' && u.feature_name.trim()
          ? u.feature_name.trim()
          : '';
      if (!featureName) return null;

      const id =
        typeof u.id === 'string' && u.id.trim()
          ? u.id.trim().replace(/\s+/g, '_')
          : `uncertainty_${idx + 1}`;
      const uncertaintyReason =
        typeof u.uncertainty_reason === 'string' && u.uncertainty_reason.trim()
          ? u.uncertainty_reason.trim()
          : 'Occluded or ambiguous from the single 2D sketch viewpoint.';

      const rawOptions = Array.from(new Set(sanitizeStringArray(u.options))).slice(0, 5);
      const rawDefault =
        typeof u.default_assumption === 'string' && u.default_assumption.trim()
          ? u.default_assumption.trim()
          : rawOptions[0] || 'Standard balanced 3D geometry';

      let options = rawOptions;
      if (options.length === 0) {
        options = [rawDefault, 'Alternative open / hollow structural profile'];
      } else if (options.length === 1) {
        const alt =
          options[0].toLowerCase().includes('hollow')
            ? 'Solid closed volumetric form'
            : 'Slim / recessed alternative profile';
        options = [options[0], alt];
      }
      if (!options.includes(rawDefault)) {
        options = [rawDefault, ...options.slice(0, 3)];
      }

      const rawImp = typeof u.importance === 'string' ? u.importance.toLowerCase().trim() : '';
      const importance: 'critical' | 'moderate' =
        rawImp === 'critical' || rawImp === 'high' ? 'critical' : 'moderate';

      return {
        id,
        feature_name: featureName,
        uncertainty_reason: uncertaintyReason,
        options,
        default_assumption: rawDefault,
        importance,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const rawMat = rec.material_preferences as Record<string, unknown>;
  const userSuppliedAny = Boolean(hints.material || hints.colour || hints.style);
  const materialPreferences = {
    primary_material:
      typeof rawMat.primary_material === 'string' && rawMat.primary_material.trim()
        ? rawMat.primary_material.trim()
        : hints.material || 'Matte architectural polymer',
    secondary_material:
      typeof rawMat.secondary_material === 'string' && rawMat.secondary_material.trim()
        ? rawMat.secondary_material.trim()
        : 'Brushed metallic structural accent',
    colour_palette:
      typeof rawMat.colour_palette === 'string' && rawMat.colour_palette.trim()
        ? rawMat.colour_palette.trim()
        : hints.colour || 'Neutral warm studio grey & slate',
    surface_finish:
      typeof rawMat.surface_finish === 'string' && rawMat.surface_finish.trim()
        ? rawMat.surface_finish.trim()
        : hints.style || 'Satin smooth industrial finish',
    source_note:
      typeof rawMat.source_note === 'string' && rawMat.source_note.trim()
        ? rawMat.source_note.trim()
        : userSuppliedAny
          ? 'Grounded in user-supplied design hints.'
          : 'Plausible industrial design suggestions inferred from silhouette.',
  };

  const catInfo = inferCategoryFromCorpus(
    cleanObjectName,
    hints.objectType,
    visibleComponents,
    rec.object_category
  );
  const finalUnsupportedReason = !catInfo.supported
    ? typeof rec.unsupported_reason === 'string' && rec.unsupported_reason.trim()
      ? rec.unsupported_reason.trim()
      : catInfo.unsupportedReason
    : '';

  const structuralBlueprint = normalizeStructuralBlueprint(
    rec.structural_blueprint,
    catInfo.category,
    cleanObjectName,
    visibleComponents,
    observedFeatures
  );

  const reconstructionOptions = buildDefaultOptionConcepts(
    catInfo.category,
    catInfo.supported,
    finalUnsupportedReason,
    cleanObjectName,
    normalizedUncertain.length,
    rec.reconstruction_options
  );

  return {
    object_name: cleanObjectName,
    object_category: catInfo.category,
    category_supported: catInfo.supported,
    unsupported_reason: finalUnsupportedReason,
    visible_components: visibleComponents,
    observed_features: observedFeatures,
    uncertain_features: normalizedUncertain,
    inferred_features: sanitizeStringArray(rec.inferred_features),
    proportions_description:
      rec.proportions_description.trim() ||
      'Proportions estimated from visible 2D silhouette bounds.',
    material_preferences: materialPreferences,
    structural_blueprint: structuralBlueprint,
    reconstruction_options: reconstructionOptions,
    reconstruction_notes:
      rec.reconstruction_notes.trim() ||
      'Preserve outer 2D silhouette contours while estimating symmetric hidden depth.',
  };
}

/**
 * Extracts a clean, human-readable diagnostic message from @google/genai SDK errors without dumping raw JSON blobs.
 */
export function parseGeminiSdkError(err: unknown): { raw: string; cleanMessage: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const candidate = JSON.parse(raw.slice(jsonStart)) as {
        error?: { message?: string; status?: string; code?: number };
        message?: string;
      };
      const innerMsg = candidate?.error?.message || candidate?.message;
      if (typeof innerMsg === 'string' && innerMsg.trim()) {
        return { raw, cleanMessage: innerMsg.trim() };
      }
    } catch {
      // Fall through to regex cleanup
    }
  }
  const cleanMessage = raw.replace(/\s+/g, ' ').trim().slice(0, 320);
  return { raw, cleanMessage: cleanMessage || 'Upstream Gemini vision request failed.' };
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // 0. Lightweight JSON Health Check
  app.get('/api/health', (_req: Request, res: Response) => {
    sendJsonSuccess(res, {
      ok: true,
      service: 'sketch2shape-intentlock-3d',
      timestamp: new Date().toISOString(),
    });
  });

  // 1. System & API Configuration Status (never leaks secret values)
  app.get('/api/system/status', (_req: Request, res: Response) => {
    const geminiConfigured = Boolean(getGeminiKey() && getGeminiKey() !== 'MY_GEMINI_API_KEY');
    const tripoConfigured = Boolean(getTripoKey());
    sendJsonSuccess(res, {
      geminiConfigured,
      tripoConfigured,
      demoMode: !tripoConfigured,
      offlineFallbackAvailable: true,
      geminiModel: GEMINI_VISION_MODEL,
      geminiFallbackModel: GEMINI_FALLBACK_MODEL,
      tripoApiBase: TRIPO_API_BASE,
      tripoModelVersion: TRIPO_MODEL_VERSION,
      limits: {
        maxUploadBytes: MAX_UPLOAD_BYTES,
        supportedMimeTypes: Array.from(SUPPORTED_MIME_TYPES),
        pollTimeoutSeconds: POLL_TIMEOUT_SECONDS,
      },
    });
  });

  // 2. Gemini Multimodal Vision Sketch Analysis
  app.post('/api/sketch/analyze', async (req: Request, res: Response) => {
    const uploadedOk = await parseSingleSketchUpload(req, res);
    if (!uploadedOk) return;

    const check = validateUploadedSketch(req.file);
    if (!check.ok) {
      sendJsonError(res, check.status, check.error);
      return;
    }

    const geminiKey = getGeminiKey();
    if (!geminiKey || geminiKey === 'MY_GEMINI_API_KEY') {
      sendJsonError(res, 424, {
        code: 'MISSING_GEMINI_API_KEY',
        title: 'Gemini API Key Not Configured',
        message: 'GEMINI_API_KEY is missing on the server, so multimodal sketch analysis cannot run.',
        suggestion: 'Configure GEMINI_API_KEY in the AI Studio Settings > Secrets panel or local .env file.',
      });
      return;
    }

    let hints = { objectType: '', material: '', colour: '', style: '' };
    if (typeof req.body?.hints === 'string' && req.body.hints.trim()) {
      try {
        const parsedHints = JSON.parse(req.body.hints);
        hints = {
          objectType: String(parsedHints?.objectType || '').trim(),
          material: String(parsedHints?.material || '').trim(),
          colour: String(parsedHints?.colour || '').trim(),
          style: String(parsedHints?.style || '').trim(),
        };
      } catch {
        // Ignore malformed optional hints JSON
      }
    }

    let cvSummaryBlock = '';
    if (typeof req.body?.cvMetrics === 'string' && req.body.cvMetrics.trim()) {
      try {
        const cv = JSON.parse(req.body.cvMetrics) as Record<string, unknown>;
        const lines: string[] = [];
        if (typeof cv.measuredAspectLabel === 'string' && cv.measuredAspectLabel) {
          lines.push(`Measured tight stroke bounding-box W:H ratio: ${cv.measuredAspectLabel}`);
        }
        if (typeof cv.foregroundInkRatio === 'number') {
          lines.push(`Foreground stroke ink coverage: ${(cv.foregroundInkRatio * 100).toFixed(1)}%`);
        }
        if (typeof cv.verticalSymmetryScore === 'number') {
          lines.push(`Measured 2D bilateral vertical symmetry: ${(cv.verticalSymmetryScore * 100).toFixed(0)}%`);
        }
        if (typeof cv.outerContourCount === 'number' && typeof cv.holeContourCount === 'number') {
          lines.push(`Detected silhouettes: ${cv.outerContourCount} outer contour(s), ${cv.holeContourCount} enclosed hole(s)`);
        }
        if (lines.length > 0) {
          cvSummaryBlock = `Deterministic CV pixel measurements on this sketch:\n${lines.join('\n')}`;
        }
      } catch {
        // Ignore malformed optional cvMetrics JSON
      }
    }

    const userHintSummary = [
      hints.objectType ? `User-stated object type: "${hints.objectType}"` : 'Object type: not specified by user',
      hints.material ? `User-stated material preference: "${hints.material}"` : 'Material preference: not specified by user',
      hints.colour ? `User-stated colour preference: "${hints.colour}"` : 'Colour preference: not specified by user',
      hints.style ? `User-stated style preference: "${hints.style}"` : 'Style preference: not specified by user',
    ].join('\n');

    const systemInstruction = [
      'You are a senior industrial design CAD reconstructor analysing a 2D hand-drawn or uploaded sketch prior to modular 3D mesh generation.',
      'EPISTEMIC HONESTY RULES (CRITICAL):',
      '1. Never invent certainty about hidden, occluded, or rear-facing 3D geometry.',
      '2. Place ONLY strokes and parts directly visible in the 2D image into visible_components and observed_features.',
      '3. Place hidden backside details, occluded legs/supports, underside cavities, wall thickness, and bilateral symmetry assumptions into inferred_features, explicitly phrasing them as estimates rather than observed facts.',
      '4. Populate uncertain_features ONLY with genuinely ambiguous structural decisions that matter for 3D reconstruction (0 to 4 items maximum). Each uncertain feature MUST include 2 to 4 concrete options. Do NOT ask unnecessary or trivial questions when the sketch or user hints already settle a detail.',
      '5. Classify object_category honestly into "chair", "table", "mug_vessel", "lamp", "shelf_cabinet", "bracket_mechanical", or "unsupported" (use "unsupported" for animals, humans, faces, foliage, soft cloth, or complex vehicles where parametric synthesis would mislead).',
      '6. Extract structural_blueprint strictly from visible stroke proportions (e.g., set has_armrests=true ONLY if armrests are drawn; measure seat_or_top_height_ratio and backrest_tilt_deg from the sketch).',
      '7. Provide three distinct reconstruction_options ("sketch_faithful", "structurally_refined", "design_enhanced") with concrete inferred_changes and honest evidence-grounded confidence_score values.',
      '8. If the image appears blank or contains no discernible object sketch, set object_name to "Unrecognized / Blank Sketch", object_category to "unsupported", and category_supported to false.',
    ].join('\n');

    const promptText = [
      'Analyse this original 2D sketch for three-option 3D reconstruction and IntentLock verification.',
      'Optional user-provided design parameters:',
      userHintSummary,
      ...(cvSummaryBlock ? [cvSummaryBlock] : []),
      'Return structured JSON matching the exact schema.',
    ].join('\n\n');

    const startedAt = Date.now();
    try {
      const { GoogleGenAI, ThinkingLevel, Type } = await loadGenAiSdk();
      const sketchAnalysisSchema = buildSketchAnalysisSchema(Type);
      const ai = new GoogleGenAI({
        apiKey: geminiKey,
        httpOptions: {
          timeout: 22_000,
          retryOptions: {
            attempts: 1,
          },
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const attemptsPlan = [
        { model: GEMINI_VISION_MODEL, useStrictSchema: true },
        { model: GEMINI_FALLBACK_MODEL, useStrictSchema: true },
        { model: GEMINI_FALLBACK_MODEL, useStrictSchema: false },
      ] as const;

      const jsonContractInstruction = [
        'Return a single JSON object with these keys:',
        '- "object_name": string',
        '- "object_category": "chair" | "table" | "mug_vessel" | "lamp" | "shelf_cabinet" | "bracket_mechanical" | "unsupported"',
        '- "category_supported": boolean',
        '- "unsupported_reason": string',
        '- "visible_components": string[]',
        '- "observed_features": string[]',
        '- "uncertain_features": array of 0..4 objects each containing { "id": string, "feature_name": string, "uncertainty_reason": string, "options": string[] (2..4 choices), "default_assumption": string, "importance": "critical" | "moderate" }',
        '- "inferred_features": string[]',
        '- "proportions_description": string',
        '- "material_preferences": { "primary_material": string, "secondary_material": string, "colour_palette": string, "surface_finish": string, "source_note": string }',
        '- "structural_blueprint": { "viewpoint": string, "width_to_height_ratio": number, "depth_to_width_ratio": number, "has_backrest": boolean, "backrest_style": string, "backrest_tilt_deg": number, "seat_or_top_height_ratio": number, "seat_or_top_shape": string, "has_armrests": boolean, "visible_leg_count": number, "inferred_total_leg_count": number, "leg_style": string, "has_stretchers_or_apron": boolean, "has_side_handle": boolean, "handle_side": string, "is_hollow_open_top": boolean, "shelf_tier_count": number, "shade_profile": string }',
        '- "reconstruction_options": array of 3 objects for ids ["sketch_faithful", "structurally_refined", "design_enhanced"] each containing { "id": string, "explanation": string, "inferred_changes": string[], "confidence_score": number, "confidence_rationale": string }',
        '- "reconstruction_notes": string',
      ].join('\n');

      let rawText = '';
      let usedModel: string = GEMINI_VISION_MODEL;
      let lastUpstreamErr: unknown = null;

      for (let attempt = 0; attempt < attemptsPlan.length; attempt++) {
        const step = attemptsPlan[attempt];
        const modelName = step.model;
        usedModel = modelName;
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: check.detectedMime,
                    data: req.file!.buffer.toString('base64'),
                  },
                },
                {
                  text: step.useStrictSchema
                    ? promptText
                    : `${promptText}\n\n${jsonContractInstruction}`,
                },
              ],
            },
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              seed: 42,
              ...(step.useStrictSchema ? { responseSchema: sketchAnalysisSchema } : {}),
              ...(modelName === 'gemini-3.8-flash'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
            },
          });

          rawText = (response.text ?? '').trim();
          if (rawText) {
            lastUpstreamErr = null;
            break;
          }
        } catch (err: unknown) {
          lastUpstreamErr = err;
          const errStr = err instanceof Error ? err.message : String(err);
          console.warn(
            `[Sketch2Shape Vision] Model ${modelName} (strictSchema=${step.useStrictSchema}) attempt ${attempt + 1} failed (${Date.now() - startedAt}ms): ${errStr.slice(0, 180)}`
          );
          const isTransient =
            /429|503|504|UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|timeout|fetch failed|AbortError/i.test(
              errStr
            );
          if (!isTransient || attempt === attemptsPlan.length - 1) {
            throw err;
          }
          // Bounded exponential backoff + random jitter before fallback attempt
          const backoffMs = Math.min(
            2400,
            600 * Math.pow(2, attempt) + Math.floor(Math.random() * 350)
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }

      if (lastUpstreamErr) {
        throw lastUpstreamErr;
      }

      if (!rawText) {
        sendJsonError(res, 422, {
          code: 'EMPTY_AI_RESPONSE',
          title: 'Empty Analysis Response from Gemini',
          message: 'Gemini returned an empty response while analysing the sketch.',
          suggestion: 'Ensure the sketch has clear visible strokes and try analysing again.',
        });
        return;
      }

      // Strip accidental markdown code fences if fallback mode included them
      const cleanedJsonText = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      let parsedRaw: unknown;
      try {
        parsedRaw = JSON.parse(cleanedJsonText);
      } catch {
        sendJsonError(res, 422, {
          code: 'MALFORMED_AI_RESPONSE',
          title: 'Malformed JSON from Vision Analysis',
          message: 'The vision model returned output that could not be parsed as valid JSON.',
          suggestion: 'Click Re-Analyse Current Sketch to request a fresh structured analysis.',
        });
        return;
      }

      const normalizedAnalysis = validateAndNormalizeAnalysisPayload(parsedRaw, hints);
      if (!normalizedAnalysis) {
        sendJsonError(res, 422, {
          code: 'INCOMPLETE_AI_SCHEMA',
          title: 'Incomplete Sketch Analysis Schema',
          message: 'The returned JSON omitted one or more required sketch analysis fields.',
          suggestion: 'Retry analysis to regenerate the complete 8-field specification.',
        });
        return;
      }

      const analysisDurationMs = Date.now() - startedAt;
      console.log(
        `[Sketch2Shape Vision] Analyzed "${normalizedAnalysis.object_name as string}" via ${usedModel} in ${analysisDurationMs}ms (${req.file!.size} bytes)`
      );

      sendJsonSuccess(res, {
        analysis: normalizedAnalysis,
        modelUsed: usedModel,
        analysisDurationMs,
        sketchSha256: check.sha256,
        detectedMime: check.detectedMime,
        sizeBytes: req.file!.size,
        analysedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const { raw, cleanMessage } = parseGeminiSdkError(err);
      console.error(`[Sketch2Shape Vision] Request failed after ${Date.now() - startedAt}ms:`, raw);

      const isAuth = /API_KEY_INVALID|PERMISSION_DENIED|401|403/i.test(raw);
      const isQuota = /RESOURCE_EXHAUSTED|429/i.test(raw);
      const isTimeout = /504|DEADLINE_EXCEEDED|timeout|AbortError/i.test(raw);
      const isTransientDemand = /503|UNAVAILABLE/i.test(raw);

      sendJsonError(
        res,
        isAuth ? 401 : isQuota ? 429 : isTimeout ? 408 : isTransientDemand ? 429 : 424,
        {
          code: isAuth
            ? 'GEMINI_AUTH_ERROR'
            : isQuota
              ? 'GEMINI_QUOTA_EXCEEDED'
              : isTimeout
                ? 'GEMINI_UPSTREAM_TIMEOUT'
                : isTransientDemand
                  ? 'GEMINI_UPSTREAM_BUSY'
                  : 'GEMINI_VISION_FAILURE',
          title: isAuth
            ? 'Gemini API Key Invalid or Unauthorized'
            : isQuota
              ? 'Gemini API Quota Reached'
              : isTimeout
                ? 'Gemini Vision Request Timed Out'
                : isTransientDemand
                  ? 'Gemini Vision Temporarily Experiencing High Demand'
                  : 'Sketch Vision Analysis Failed',
          message: cleanMessage,
          suggestion: isAuth
            ? 'Check GEMINI_API_KEY in the Settings > Secrets panel.'
            : isQuota
              ? 'Wait a moment or select a billing-enabled Gemini API key in Settings > Secrets, or click "Compare 3 Modular 3D Options (Local CV + Hints)" below to generate Options A, B & C locally.'
              : 'Your sketch and prior work are preserved. Wait a few seconds and click Analyse Sketch again, or click "Compare 3 Modular 3D Options (Local CV + Hints)" below.',
        }
      );
    }
  });

  // 3. Official Tripo 3D OpenAPI v3 Image-to-Model Pipeline (Preserves Original Sketch Integrity)
  app.post('/api/tripo/generate', async (req: Request, res: Response) => {
    const uploadedOk = await parseSingleSketchUpload(req, res);
    if (!uploadedOk) return;

    pruneTaskStore();

    const check = validateUploadedSketch(req.file);
    if (!check.ok) {
      sendJsonError(res, check.status, check.error);
      return;
    }

    // Verify submitted sketch SHA-256 matches client's expected payload hash (prevents silent replacement)
    const expectedSha256 =
      typeof req.body?.expectedSketchSha256 === 'string'
        ? req.body.expectedSketchSha256.trim()
        : '';
    if (expectedSha256 && expectedSha256 !== check.sha256) {
      sendJsonError(res, 409, {
        code: 'SKETCH_INTEGRITY_MISMATCH',
        title: 'Original Sketch Integrity Check Failed',
        message:
          'The submitted image bytes do not match the expected sketch SHA-256 verified during IntentLock.',
        suggestion:
          'Re-run sketch analysis so IntentLock matches the current sketch without silent replacement.',
      });
      return;
    }

    const originalSketchSha256 =
      typeof req.body?.originalSketchSha256 === 'string' && req.body.originalSketchSha256.trim()
        ? req.body.originalSketchSha256.trim()
        : check.sha256;

    const tripoKey = getTripoKey();
    if (!tripoKey) {
      sendJsonError(res, 424, {
        code: 'MISSING_TRIPO_API_KEY',
        title: 'Tripo 3D Credentials Not Configured — Offline Contour Fallback Available',
        message:
          'TRIPO_API_KEY is not set on the server, so cloud Tripo v3 neural generation cannot run. You can click "Offline Contour 3D Reconstruction" to build a genuine Three.js 3D mesh (.GLB & .OBJ) directly from your sketch pixels and contours without an API key.',
        suggestion:
          'Click "Offline Contour 3D Reconstruction" right below, or add TRIPO_API_KEY (starting with tsk_ from platform.tripo3d.ai) in Settings > Secrets for cloud neural reconstruction.',
      });
      return;
    }

    let parsedHints = { objectType: '', material: '', colour: '', style: '' };
    if (typeof req.body?.hints === 'string' && req.body.hints.trim()) {
      try {
        const h = JSON.parse(req.body.hints);
        parsedHints = {
          objectType: String(h?.objectType || '').trim(),
          material: String(h?.material || '').trim(),
          colour: String(h?.colour || '').trim(),
          style: String(h?.style || '').trim(),
        };
      } catch {
        // Ignore malformed hints JSON
      }
    }

    let intentSummary = '';
    let hasIntentCorrections = false;
    if (typeof req.body?.intentLock === 'string' && req.body.intentLock.trim()) {
      try {
        const il = JSON.parse(req.body.intentLock) as {
          decisions?: Array<{ featureName?: string; finalValue?: string; wasCorrected?: boolean }>;
          additionalNotes?: string;
        };
        const decisions = Array.isArray(il?.decisions) ? il.decisions : [];
        hasIntentCorrections =
          decisions.some((d) => Boolean(d?.wasCorrected)) || Boolean(il?.additionalNotes?.trim());
        intentSummary = decisions
          .map((d) => `${d.featureName || 'Feature'}: ${d.finalValue || ''}`)
          .join(' | ');
      } catch {
        // Ignore malformed intentLock JSON
      }
    }

    const hasCustomAppearanceOverride = Boolean(
      parsedHints.material || parsedHints.colour || hasIntentCorrections
    );
    const enableImageAutofix =
      req.body?.enableImageAutofix === 'true' || req.body?.enableImageAutofix === true;

    const ext =
      check.detectedMime === 'image/png'
        ? 'png'
        : check.detectedMime === 'image/webp'
          ? 'webp'
          : 'jpg';
    const safeFileName = `sketch_${check.sha256.slice(0, 10)}.${ext}`;

    try {
      // Step 1: Upload sketch bytes to POST https://openapi.tripo3d.ai/v3/files
      const formData = new FormData();
      const fileBlob = new Blob([new Uint8Array(req.file!.buffer)], { type: check.detectedMime });
      formData.append('file', fileBlob, safeFileName);

      const uploadResp = await fetch(`${TRIPO_API_BASE}/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tripoKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(35_000),
      });

      const uploadTraceId = uploadResp.headers.get('x-tripo-trace-id');
      let uploadJson: Record<string, unknown> | null = null;
      try {
        uploadJson = (await uploadResp.json()) as Record<string, unknown>;
      } catch {
        sendJsonError(res, 424, {
          code: 'TRIPO_MALFORMED_UPLOAD_RESPONSE',
          title: 'Malformed Upload Response from Tripo API',
          message: `Tripo /v3/files returned non-JSON payload (HTTP ${uploadResp.status}).`,
          suggestion: 'Retry generation or run Offline Contour 3D Reconstruction.',
          requestId: uploadTraceId || undefined,
        });
        return;
      }

      if (!uploadResp.ok || uploadJson.code !== 0) {
        const mapped = mapTripoError(uploadResp.status, uploadJson, uploadTraceId);
        sendJsonError(res, mapped.status, mapped.error);
        return;
      }

      const uploadData = (uploadJson.data || {}) as Record<string, unknown>;
      const fileToken =
        typeof uploadData.file_token === 'string'
          ? uploadData.file_token
          : typeof uploadData.image_token === 'string'
            ? uploadData.image_token
            : '';

      if (!fileToken) {
        sendJsonError(res, 424, {
          code: 'TRIPO_MISSING_FILE_TOKEN',
          title: 'Missing File Token from Tripo Upload',
          message: 'Tripo /v3/files succeeded with code 0 but did not return data.file_token.',
          suggestion: 'Retry uploading the sketch.',
          requestId: uploadTraceId || undefined,
        });
        return;
      }

      // Step 2: Create image-to-model task at POST https://openapi.tripo3d.ai/v3/generation/image-to-model
      // Follows verified Tripo OpenAPI v3 specification (requires "model" + "input.file_token").
      const taskBody = {
        model: TRIPO_MODEL_VERSION,
        input: {
          file_token: fileToken,
        },
        enable_image_autofix: enableImageAutofix,
        texture_alignment: hasCustomAppearanceOverride ? 'geometry' : 'original_image',
        orientation: 'default',
      };

      const taskResp = await fetch(`${TRIPO_API_BASE}/generation/image-to-model`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tripoKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(taskBody),
        signal: AbortSignal.timeout(25_000),
      });

      const taskTraceId = taskResp.headers.get('x-tripo-trace-id');
      let taskJson: Record<string, unknown> | null = null;
      try {
        taskJson = (await taskResp.json()) as Record<string, unknown>;
      } catch {
        sendJsonError(res, 424, {
          code: 'TRIPO_MALFORMED_TASK_RESPONSE',
          title: 'Malformed Task Creation Response from Tripo API',
          message: `Tripo /v3/generation/image-to-model returned non-JSON output (HTTP ${taskResp.status}).`,
          suggestion: 'Retry task creation or run Offline Contour 3D Reconstruction.',
          requestId: taskTraceId || undefined,
        });
        return;
      }

      if (!taskResp.ok || taskJson.code !== 0) {
        const mapped = mapTripoError(taskResp.status, taskJson, taskTraceId);
        sendJsonError(res, mapped.status, mapped.error);
        return;
      }

      const taskData = (taskJson.data || {}) as Record<string, unknown>;
      const taskId = typeof taskData.task_id === 'string' ? taskData.task_id : '';
      if (!taskId) {
        sendJsonError(res, 424, {
          code: 'TRIPO_MISSING_TASK_ID',
          title: 'Missing Task ID from Tripo API',
          message: 'Tripo accepted the request but did not include data.task_id.',
          suggestion: 'Retry generation.',
          requestId: taskTraceId || undefined,
        });
        return;
      }

      const objectName =
        typeof req.body?.objectName === 'string' && req.body.objectName.trim()
          ? req.body.objectName.trim()
          : parsedHints.objectType || 'sketch_model';

      taskStore.set(taskId, {
        taskId,
        createdAt: Date.now(),
        sketchSha256: check.sha256,
        originalSketchSha256,
        objectName,
        tripoModelVersion: TRIPO_MODEL_VERSION,
        intentSummary,
      });

      sendJsonSuccess(res, {
        taskId,
        status: 'queued',
        progress: 0,
        tripoModelVersion: TRIPO_MODEL_VERSION,
        preservedSketchSha256: check.sha256,
        originalSketchSha256,
        createdAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const isTimeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const msg = err instanceof Error ? err.message : String(err);
      sendJsonError(res, isTimeout ? 408 : 424, {
        code: isTimeout ? 'TRIPO_NETWORK_TIMEOUT' : 'TRIPO_NETWORK_ERROR',
        title: isTimeout ? 'Tripo Request Timed Out' : 'Network Error Contacting Tripo 3D API',
        message: msg,
        suggestion:
          'Check network connectivity and click Retry Generation, or use Offline Contour 3D Reconstruction.',
      });
    }
  });

  // 4. Asynchronous Task Status Polling: GET https://openapi.tripo3d.ai/v3/tasks/:taskId
  app.get('/api/tripo/tasks/:taskId', async (req: Request, res: Response) => {
    const taskId = String(req.params.taskId || '').trim();
    if (!taskId || !/^[a-zA-Z0-9_-]{4,128}$/.test(taskId)) {
      sendJsonError(res, 400, {
        code: 'INVALID_TASK_ID',
        title: 'Invalid Task Identifier',
        message: 'The supplied Tripo task_id format is invalid.',
      });
      return;
    }

    const tripoKey = getTripoKey();
    if (!tripoKey) {
      sendJsonError(res, 424, {
        code: 'MISSING_TRIPO_API_KEY',
        title: 'Tripo API Key Missing',
        message: 'TRIPO_API_KEY is required on the server to poll Tripo tasks.',
      });
      return;
    }

    try {
      const pollResp = await fetch(`${TRIPO_API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tripoKey}`,
        },
        signal: AbortSignal.timeout(20_000),
      });

      let pollJson: Record<string, unknown> | null = null;
      try {
        pollJson = (await pollResp.json()) as Record<string, unknown>;
      } catch {
        sendJsonError(res, 424, {
          code: 'TRIPO_MALFORMED_POLL_RESPONSE',
          title: 'Malformed Task Status Response',
          message: `Tripo /v3/tasks/${taskId} returned invalid JSON (HTTP ${pollResp.status}).`,
          suggestion: 'Polling can be retried safely.',
        });
        return;
      }

      if (!pollResp.ok || pollJson.code !== 0) {
        const mapped = mapTripoError(
          pollResp.status,
          pollJson,
          pollResp.headers.get('x-tripo-trace-id')
        );
        sendJsonError(res, mapped.status, mapped.error);
        return;
      }

      const data = (pollJson.data || {}) as Record<string, unknown>;
      const status = typeof data.status === 'string' ? data.status : 'running';
      const progress = typeof data.progress === 'number' ? Math.max(0, Math.min(100, data.progress)) : 0;
      const output = (data.output && typeof data.output === 'object' ? data.output : {}) as Record<string, unknown>;

      if (status === 'success') {
        const modelUrl =
          (typeof output.pbr_model === 'string' && output.pbr_model) ||
          (typeof output.model === 'string' && output.model) ||
          (typeof output.model_url === 'string' && output.model_url) ||
          (typeof output.base_model === 'string' && output.base_model) ||
          '';

        if (!modelUrl) {
          sendJsonError(res, 424, {
            code: 'TRIPO_MISSING_GLB_URL',
            title: 'Task Succeeded Without GLB Download URL',
            message: 'Tripo reported status "success" but output contained no model URL.',
            suggestion: 'Retry generation to obtain a fresh GLB asset.',
          });
          return;
        }

        const existing: StoredTripoTask = taskStore.get(taskId) || {
          taskId,
          createdAt: Date.now(),
          sketchSha256: '',
          originalSketchSha256: '',
          objectName: 'sketch_model',
          tripoModelVersion: TRIPO_MODEL_VERSION,
        };
        existing.remoteModelUrl = modelUrl;

        // Pre-fetch and cache the GLB binary immediately while Tripo's 5-min signed URL is fresh
        if (!existing.cachedGlbBuffer) {
          try {
            const glbResp = await fetch(modelUrl, { signal: AbortSignal.timeout(45_000) });
            if (glbResp.ok) {
              const arrayBuf = await glbResp.arrayBuffer();
              const buf = Buffer.from(arrayBuf);
              const headerCheck = verifyGlbHeader(buf);
              if (headerCheck.valid) {
                existing.cachedGlbBuffer = buf;
                pruneTaskStore();
              }
            }
          } catch {
            // Will retry streaming in /model endpoint if pre-fetch had transient hiccup
          }
        }
        taskStore.set(taskId, existing);

        sendJsonSuccess(res, {
          taskId,
          status: 'success',
          progress: 100,
          modelDownloadUrl: `/api/tripo/tasks/${encodeURIComponent(taskId)}/model`,
        });
        return;
      }

      if (status === 'failed' || status === 'banned' || status === 'cancelled' || status === 'expired') {
        sendJsonSuccess(res, {
          taskId,
          status,
          progress,
          error: {
            code: `TRIPO_TASK_${status.toUpperCase()}`,
            title: `3D Reconstruction ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            message:
              status === 'banned'
                ? 'Tripo terminated the task due to input safety policy.'
                : status === 'expired'
                  ? 'The asynchronous 3D generation task expired in queue.'
                  : 'Tripo could not reconstruct a valid 3D model from this input.',
            suggestion: 'Adjust sketch contrast or stroke clarity and click Retry Generation.',
          },
        });
        return;
      }

      sendJsonSuccess(res, {
        taskId,
        status: status === 'queued' ? 'queued' : 'running',
        progress,
      });
    } catch (err: unknown) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      sendJsonError(res, isTimeout ? 408 : 424, {
        code: isTimeout ? 'TRIPO_POLL_TIMEOUT' : 'TRIPO_POLL_NETWORK_ERROR',
        title: 'Polling Request Interrupted',
        message: err instanceof Error ? err.message : String(err),
        suggestion: 'Click Retry Polling or wait for automatic retry.',
      });
    }
  });

  // 5. Binary GLB Retrieval & Header Verification Proxy
  app.get('/api/tripo/tasks/:taskId/model', async (req: Request, res: Response) => {
    const taskId = String(req.params.taskId || '').trim();
    const record = taskStore.get(taskId);

    if (!record || (!record.cachedGlbBuffer && !record.remoteModelUrl)) {
      sendJsonError(res, 404, {
        code: 'GLB_ASSET_NOT_FOUND',
        title: 'GLB Model Not Found in Server Session',
        message: 'No completed GLB binary was found for this task ID (or the signed URL expired).',
        suggestion: 'Poll the task status again or re-run 3D generation.',
      });
      return;
    }

    try {
      let glbBuffer = record.cachedGlbBuffer;
      if (!glbBuffer && record.remoteModelUrl) {
        const upstream = await fetch(record.remoteModelUrl, { signal: AbortSignal.timeout(45_000) });
        if (!upstream.ok) {
          sendJsonError(res, 424, {
            code: 'GLB_UPSTREAM_DOWNLOAD_FAILED',
            title: 'Failed to Download GLB from Tripo CDN',
            message: `Upstream storage returned HTTP ${upstream.status}. Note that Tripo signed URLs expire after ~5 minutes.`,
            suggestion: 'Re-run 3D generation to generate a fresh GLB asset.',
          });
          return;
        }
        glbBuffer = Buffer.from(await upstream.arrayBuffer());
        record.cachedGlbBuffer = glbBuffer;
        pruneTaskStore();
      }

      if (!glbBuffer) {
        sendJsonError(res, 424, {
          code: 'EMPTY_GLB_BUFFER',
          title: 'Empty GLB Payload',
          message: 'Downloaded model buffer was empty.',
        });
        return;
      }

      const headerCheck = verifyGlbHeader(glbBuffer);
      if (!headerCheck.valid) {
        sendJsonError(res, 422, {
          code: 'INVALID_GLB_BINARY',
          title: 'Invalid GLB Binary Header',
          message: headerCheck.reason || 'Returned asset failed binary glTF 2.0 header validation.',
          suggestion: 'Sketch2Shape refuses to display non-3D or corrupted files. Retry generation.',
        });
        return;
      }

      const cleanSlug = record.objectName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'sketch2shape_model';

      res.setHeader('Content-Type', 'model/gltf-binary');
      res.setHeader('Content-Length', String(glbBuffer.length));
      res.setHeader('Content-Disposition', `attachment; filename="${cleanSlug}.glb"`);
      res.send(glbBuffer);
    } catch (err: unknown) {
      sendJsonError(res, 424, {
        code: 'GLB_STREAM_ERROR',
        title: 'Error Streaming GLB Model',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 6. Explicit Failure-Mode Verification Endpoint (Strictly for Diagnostics Tab Testing)
  app.post('/api/diagnostics/simulate-failure', (req: Request, res: Response) => {
    const scenario = String(req.body?.scenario || 'insufficient_credits');

    if (scenario === 'missing_key') {
      sendJsonError(res, 424, {
        code: 'MISSING_TRIPO_API_KEY',
        title: '[Diagnostic] Tripo 3D Credentials Missing',
        message: 'Verified missing-key handler: Demo Mode keeps analysis & IntentLock active without claiming 3D generation.',
        suggestion: 'Configure TRIPO_API_KEY in Settings > Secrets for live reconstruction.',
        diagnosticSimulation: true,
      });
      return;
    }

    if (scenario === 'insufficient_credits') {
      const mapped = mapTripoError(402, {
        code: 2010,
        message: 'Insufficient credits on Tripo developer account.',
        suggestion: 'Top up credits on platform.tripo3d.ai dashboard.',
        request_id: 'diag_req_2010',
      });
      sendJsonError(res, mapped.status, { ...mapped.error, diagnosticSimulation: true });
      return;
    }

    if (scenario === 'auth_failed') {
      const mapped = mapTripoError(401, {
        code: 1002,
        message: 'Authentication failed: invalid Bearer token.',
        suggestion: 'Verify TRIPO_API_KEY starts with tsk_ and has not been revoked.',
        request_id: 'diag_req_1002',
      });
      sendJsonError(res, mapped.status, { ...mapped.error, diagnosticSimulation: true });
      return;
    }

    if (scenario === 'timeout') {
      sendJsonError(res, 408, {
        code: 'TRIPO_NETWORK_TIMEOUT',
        title: '[Diagnostic] Task Polling Timeout Exceeded',
        message: `Task exceeded the ${POLL_TIMEOUT_SECONDS}s studio timeout threshold without reaching terminal status.`,
        suggestion: 'Use Retry Generation or check upstream Tripo queue latency.',
        diagnosticSimulation: true,
      });
      return;
    }

    sendJsonError(res, 422, {
      code: 'MALFORMED_UPSTREAM_RESPONSE',
      title: '[Diagnostic] Malformed Upstream API Payload',
      message: 'Upstream endpoint returned truncated or non-JSON body; parser rejected response safely.',
      suggestion: 'Retry request safely; application state remains intact.',
      diagnosticSimulation: true,
    });
  });

  // 7. Catch-all for any unmatched /api/* route so it NEVER falls through to SPA index.html
  app.use('/api', (req: Request, res: Response) => {
    sendJsonError(res, 404, {
      code: 'API_ROUTE_NOT_FOUND',
      title: 'API Endpoint Not Found',
      message: `No backend API route matches ${req.method} ${req.originalUrl}.`,
      suggestion: 'Verify the endpoint path and HTTP method.',
    });
  });

  // 8. Global Express JSON error handler for /api/* and body-parser exceptions
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (req.originalUrl.startsWith('/api')) {
      const status =
        typeof (err as { status?: number })?.status === 'number'
          ? (err as { status: number }).status
          : 500;
      sendJsonError(res, status, {
        code: 'INTERNAL_API_ERROR',
        title: 'Server Request Processing Error',
        message: err instanceof Error ? err.message : 'Unexpected server error while processing API request.',
        suggestion: 'Check request payload format and retry.',
      });
      return;
    }
    next(err);
  });

  const distPath = path.join(__dirname, 'dist');
  const isDevCommand =
    process.env.npm_lifecycle_event === 'dev' || process.env.NODE_ENV === 'development';
  const isProd = !isDevCommand && fs.existsSync(distPath);

  const httpServer = http.createServer(app);
  let closeVite: (() => Promise<void>) | null = null;

  if (isProd) {
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const viteReadyPromise = (async () => {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: hmrDisabled ? false : { server: httpServer },
          ws: hmrDisabled ? false : undefined,
          watch: hmrDisabled ? null : {},
        },
        appType: 'spa',
      });
      closeVite = () => vite.close();
      setImmediate(() => {
        void loadGenAiSdk().catch(() => {});
      });
      return vite;
    })();

    // Prevent unhandled rejection noise if Vite fails before a request arrives
    viteReadyPromise.catch((err) => {
      console.error('[Sketch2Shape] Vite middleware initialization error:', err);
    });

    app.use(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const vite = await viteReadyPromise;
        vite.middlewares(req, res, next);
      } catch (err) {
        next(err);
      }
    });
  }

  await new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 8;

    const tryListen = () => {
      attempts += 1;
      const onError = (err: NodeJS.ErrnoException) => {
        httpServer.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
          setTimeout(tryListen, 250);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        httpServer.removeListener('error', onError);
        console.log(
          `[Sketch2Shape — IntentLock 3D] Studio server listening on http://${HOST}:${PORT}`
        );
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(PORT, HOST);
    };

    tryListen();
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    httpServer.closeAllConnections?.();
    httpServer.close(() => {
      if (closeVite) {
        void closeVite().finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
    // Force exit if any background handle lingers past 1.5s
    setTimeout(() => {
      console.log(`[Sketch2Shape] Exiting after ${signal}`);
      process.exit(0);
    }, 1500).unref();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (process.env.SKETCH2SHAPE_SKIP_LISTEN !== '1') {
  createServer().catch((err) => {
    console.error('Failed to start Sketch2Shape server:', err);
    process.exit(1);
  });
}
