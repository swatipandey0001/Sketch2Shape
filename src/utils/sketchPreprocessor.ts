import type {
  ContourPolygon2D,
  OfflineReconstructionMode,
  ScanlineSpan,
  SketchPreprocessMetrics,
  SketchPreprocessOptions,
} from '../types/studio';

export interface RawPreprocessResult {
  metrics: SketchPreprocessMetrics;
  preparedRgba: Uint8ClampedArray;
  preparedWidth: number;
  preparedHeight: number;
  contourOverlayRgba: Uint8ClampedArray;
  /** Cropped foreground binary silhouette mask (1 = filled silhouette, 0 = exterior/hole) */
  croppedSilhouetteMask: Uint8Array;
  /** Cropped foreground stroke-only mask (1 = drawn ink stroke, 0 = paper) */
  croppedStrokeMask: Uint8Array;
  croppedWidth: number;
  croppedHeight: number;
  contours: ContourPolygon2D[];
  scanlines: ScanlineSpan[];
}

export interface BrowserPreprocessResult extends RawPreprocessResult {
  preparedBlob: Blob;
  preparedDataUrl: string;
  contourOverlayDataUrl: string;
}

const DEFAULT_OPTIONS: Required<SketchPreprocessOptions> = {
  illuminationCorrection: false,
  contrastNormalization: true,
  squareSize: 512,
};

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Computes O(1) window means via a 2D integral image.
 */
function buildIntegralImage(gray: Float32Array, width: number, height: number): Float64Array {
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const srcRow = y * width;
    const dstRow = (y + 1) * stride;
    const prevRow = y * stride;
    for (let x = 0; x < width; x++) {
      rowSum += gray[srcRow + x];
      integral[dstRow + x + 1] = integral[prevRow + x + 1] + rowSum;
    }
  }
  return integral;
}

function queryWindowMean(
  integral: Float64Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number
): number {
  const stride = width + 1;
  const x0 = Math.max(0, cx - radius);
  const y0 = Math.max(0, cy - radius);
  const x1 = Math.min(width - 1, cx + radius);
  const y1 = Math.min(height - 1, cy + radius);
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (count <= 0) return 255;
  const sum =
    integral[(y1 + 1) * stride + (x1 + 1)] -
    integral[y0 * stride + (x1 + 1)] -
    integral[(y1 + 1) * stride + x0] +
    integral[y0 * stride + x0];
  return sum / count;
}

function dilateBinary(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const horiz = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let run = 0;
    for (let x = 0; x <= Math.min(width - 1, radius); x++) {
      run += mask[row + x];
    }
    for (let x = 0; x < width; x++) {
      if (run > 0) horiz[row + x] = 1;
      const addIdx = x + radius + 1;
      const remIdx = x - radius;
      if (addIdx < width) run += mask[row + addIdx];
      if (remIdx >= 0) run -= mask[row + remIdx];
    }
  }

  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y <= Math.min(height - 1, radius); y++) {
      run += horiz[y * width + x];
    }
    for (let y = 0; y < height; y++) {
      if (run > 0) out[y * width + x] = 1;
      const addY = y + radius + 1;
      const remY = y - radius;
      if (addY < height) run += horiz[addY * width + x];
      if (remY >= 0) run -= horiz[remY * width + x];
    }
  }
  return out;
}

function erodeBinary(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  const dil = dilateBinary(inv, width, height, radius);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = dil[i] ? 0 : 1;
  return out;
}

/**
 * Ramer-Douglas-Peucker polygon simplification to remove pixel staircase jitter.
 */
function simplifyPolygonRdp(
  pts: Array<[number, number]>,
  epsilon: number
): Array<[number, number]> {
  if (pts.length <= 4) return pts;

  const sqDistToSegment = (
    p: [number, number],
    a: [number, number],
    b: [number, number]
  ): number => {
    let x = a[0];
    let y = a[1];
    let dx = b[0] - x;
    let dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = b[0];
        y = b[1];
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }
    dx = p[0] - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
  };

  const rdpSlice = (start: number, end: number): Array<[number, number]> => {
    let maxSq = 0;
    let splitIdx = -1;
    const a = pts[start];
    const b = pts[end];
    for (let i = start + 1; i < end; i++) {
      const dSq = sqDistToSegment(pts[i], a, b);
      if (dSq > maxSq) {
        maxSq = dSq;
        splitIdx = i;
      }
    }
    if (maxSq > epsilon * epsilon && splitIdx !== -1) {
      const left = rdpSlice(start, splitIdx);
      const right = rdpSlice(splitIdx, end);
      return [...left.slice(0, -1), ...right];
    }
    return [a, b];
  };

  // Split closed loop at farthest vertex from index 0 so endpoints are preserved cleanly
  let farthestIdx = Math.floor(pts.length / 2);
  let bestDist = -1;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[0][0];
    const dy = pts[i][1] - pts[0][1];
    const d = dx * dx + dy * dy;
    if (d > bestDist) {
      bestDist = d;
      farthestIdx = i;
    }
  }

  const half1 = rdpSlice(0, farthestIdx);
  const closedTail = [...pts.slice(farthestIdx), pts[0]];
  const rdpTail = (arr: Array<[number, number]>): Array<[number, number]> => {
    const sub = simplifyOpenRdp(arr, epsilon);
    return sub;
  };
  const half2 = rdpTail(closedTail);
  const merged = [...half1.slice(0, -1), ...half2.slice(0, -1)];
  return merged.length >= 3 ? merged : pts.slice(0, Math.min(pts.length, 6));
}

function simplifyOpenRdp(
  pts: Array<[number, number]>,
  epsilon: number
): Array<[number, number]> {
  if (pts.length <= 2) return pts;
  let maxSq = 0;
  let idx = -1;
  const a = pts[0];
  const b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    let x = a[0];
    let y = a[1];
    let dx = b[0] - x;
    let dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((pts[i][0] - x) * dx + (pts[i][1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = b[0];
        y = b[1];
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }
    dx = pts[i][0] - x;
    dy = pts[i][1] - y;
    const sq = dx * dx + dy * dy;
    if (sq > maxSq) {
      maxSq = sq;
      idx = i;
    }
  }
  if (maxSq > epsilon * epsilon && idx !== -1) {
    const l = simplifyOpenRdp(pts.slice(0, idx + 1), epsilon);
    const r = simplifyOpenRdp(pts.slice(idx), epsilon);
    return [...l.slice(0, -1), ...r];
  }
  return [a, b];
}

function signedPolygonArea(pts: Array<[number, number]>): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

/**
 * Moore-Neighbor 8-connected boundary tracer on a binary component mask (padded with 1px 0-border).
 */
function traceSingleMaskBoundary(
  mask: Uint8Array,
  width: number,
  height: number
): Array<[number, number]> {
  const pw = width + 2;
  const ph = height + 2;
  const padded = new Uint8Array(pw * ph);
  let startX = -1;
  let startY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        padded[(y + 1) * pw + (x + 1)] = 1;
        if (startX === -1) {
          startX = x + 1;
          startY = y + 1;
        }
      }
    }
  }

  if (startX === -1) return [];

  // Clockwise 8-neighborhood offsets starting from West (-1, 0)
  const dirs: Array<[number, number]> = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];

  const boundary: Array<[number, number]> = [];
  let cx = startX;
  let cy = startY;
  let backtrackDir = 0; // Entered from (startX - 1, startY) which is guaranteed 0

  const maxSteps = pw * ph * 3;
  for (let step = 0; step < maxSteps; step++) {
    boundary.push([cx - 1, cy - 1]);

    let foundNext = false;
    for (let k = 1; k <= 8; k++) {
      const dirIdx = (backtrackDir + k) % 8;
      const nx = cx + dirs[dirIdx][0];
      const ny = cy + dirs[dirIdx][1];
      if (padded[ny * pw + nx] === 1) {
        const prevEmptyIdx = (dirIdx + 7) % 8;
        // Backtrack direction from (nx, ny) pointing toward the empty neighbor we just stepped past
        const ex = cx + dirs[prevEmptyIdx][0] - nx;
        const ey = cy + dirs[prevEmptyIdx][1] - ny;
        let nextBack = (dirIdx + 4) % 8;
        for (let d = 0; d < 8; d++) {
          if (dirs[d][0] === ex && dirs[d][1] === ey) {
            nextBack = d;
            break;
          }
        }
        cx = nx;
        cy = ny;
        backtrackDir = nextBack;
        foundNext = true;
        break;
      }
    }

    if (!foundNext) break;
    if (cx === startX && cy === startY && boundary.length > 2) {
      break;
    }
  }

  return boundary;
}

/**
 * Pure, deterministic Computer Vision preprocessing & contour analysis on raw RGBA bytes.
 * Never invokes generative AI or replaces user strokes.
 */
export function preprocessRgbaPixels(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  rawOptions?: Partial<SketchPreprocessOptions>
): RawPreprocessResult {
  const t0 = nowMs();
  const opts: Required<SketchPreprocessOptions> = {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
  };
  const totalPixels = width * height;

  // Step 1: Alpha compositing onto pure white (#FFFFFF) + transparency telemetry
  let transparentCount = 0;
  const compositedGray = new Float32Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    const a = rgba[idx + 3];
    if (a < 250) {
      transparentCount += 1;
    }
    const alpha = a / 255;
    const compR = r * alpha + 255 * (1 - alpha);
    const compG = g * alpha + 255 * (1 - alpha);
    const compB = b * alpha + 255 * (1 - alpha);
    compositedGray[i] = 0.299 * compR + 0.587 * compG + 0.114 * compB;
  }

  const transparentPixelRatio = totalPixels > 0 ? transparentCount / totalPixels : 0;
  const hasTransparency = transparentCount > 0;

  // Step 2: Estimate background paper illumination unevenness across 4 quadrants
  // Use the 85th-percentile greyscale in each quadrant so asymmetric dark ink silhouettes do not masquerade as paper shadow
  const integralRaw = buildIntegralImage(compositedGray, width, height);
  const bgRadius = Math.max(18, Math.round(Math.min(width, height) / 9));

  const quadrantBackgroundP85 = (x0: number, y0: number, x1: number, y1: number): number => {
    const qHist = new Uint32Array(256);
    let count = 0;
    const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 48));
    for (let y = y0; y < y1; y += step) {
      const row = y * width;
      for (let x = x0; x < x1; x += step) {
        qHist[Math.max(0, Math.min(255, Math.round(compositedGray[row + x])))] += 1;
        count += 1;
      }
    }
    if (count === 0) return 255;
    const target = Math.max(1, Math.floor(count * 0.85));
    let seen = 0;
    for (let b = 0; b < 256; b++) {
      seen += qHist[b];
      if (seen >= target) return b;
    }
    return 255;
  };

  const midX = Math.max(1, Math.floor(width / 2));
  const midY = Math.max(1, Math.floor(height / 2));
  const qBg = [
    quadrantBackgroundP85(0, 0, midX, midY),
    quadrantBackgroundP85(midX, 0, width, midY),
    quadrantBackgroundP85(0, midY, midX, height),
    quadrantBackgroundP85(midX, midY, width, height),
  ];
  const maxQ = Math.max(...qBg);
  const minQ = Math.min(...qBg);
  const estimatedIlluminationUnevenness = hasTransparency && transparentPixelRatio > 0.25
    ? 0
    : Number(Math.min(1, Math.max(0, (maxQ - minQ) / 140)).toFixed(3));

  // Step 3: Optional Illumination Flattening (for uneven camera shadows on photographed paper)
  const workingGray = new Float32Array(totalPixels);
  if (opts.illuminationCorrection) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const localBg = Math.max(45, queryWindowMean(integralRaw, width, height, x, y, bgRadius));
        const val = compositedGray[row + x];
        // Normalize local paper illumination toward crisp 250 white while preserving darker strokes
        workingGray[row + x] = Math.min(255, (val / localBg) * 250);
      }
    }
  } else {
    workingGray.set(compositedGray);
  }

  // Step 4: Contrast Normalization via robust luminance histogram percentiles
  const hist = new Uint32Array(256);
  for (let i = 0; i < totalPixels; i++) {
    const bin = Math.max(0, Math.min(255, Math.round(workingGray[i])));
    hist[bin] += 1;
  }

  let acc = 0;
  let lowLevel = 15;
  let highLevel = 245;
  const pLowTarget = Math.max(1, Math.floor(totalPixels * 0.008));
  const pHighTarget = Math.max(1, Math.floor(totalPixels * 0.88));

  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= pLowTarget) {
      lowLevel = b;
      break;
    }
  }
  acc = 0;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= pHighTarget) {
      highLevel = b;
      break;
    }
  }

  const normalizedGray = new Uint8Array(totalPixels);
  const dynamicSpan = highLevel - lowLevel;
  if (opts.contrastNormalization && dynamicSpan >= 18) {
    for (let i = 0; i < totalPixels; i++) {
      const v = workingGray[i];
      if (v >= highLevel - 6) {
        normalizedGray[i] = 255;
      } else {
        const stretched = ((v - lowLevel) / Math.max(1, highLevel - 6 - lowLevel)) * 255;
        normalizedGray[i] = Math.max(0, Math.min(255, Math.round(stretched)));
      }
    }
  } else {
    for (let i = 0; i < totalPixels; i++) {
      normalizedGray[i] = Math.max(0, Math.min(255, Math.round(workingGray[i])));
    }
  }

  // Step 5: Deterministic Foreground / Stroke Detection
  // Combine global contrast threshold with local adaptive contrast so faint paper grain is rejected
  const normFloat = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) normFloat[i] = normalizedGray[i];
  const integralNorm = buildIntegralImage(normFloat, width, height);
  const localRad = Math.max(10, Math.round(Math.min(width, height) / 18));

  const fgMask = new Uint8Array(totalPixels);
  let inkPixelCount = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      const g = normalizedGray[idx];
      const localMean = queryWindowMean(integralNorm, width, height, x, y, localRad);
      // Pixel is foreground stroke/fill if it is dark globally (< 208) AND either strongly dark (< 145)
      // or noticeably darker than its local paper neighborhood
      const isInk = g < 145 || (g < 212 && localMean - g > 16);
      if (isInk) {
        fgMask[idx] = 1;
        inkPixelCount += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const hasForeground = inkPixelCount >= 20 && maxX >= minX && maxY >= minY;
  const foregroundInkRatio = totalPixels > 0 ? Number((inkPixelCount / totalPixels).toFixed(5)) : 0;

  const targetSquare = Math.max(128, opts.squareSize);
  const preparedRgba = new Uint8ClampedArray(targetSquare * targetSquare * 4);
  preparedRgba.fill(255); // Crisp white background

  if (!hasForeground) {
    const emptyOverlay = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < totalPixels; i++) {
      const o = i * 4;
      const v = normalizedGray[i];
      emptyOverlay[o] = v;
      emptyOverlay[o + 1] = v;
      emptyOverlay[o + 2] = v;
      emptyOverlay[o + 3] = 255;
    }
    return {
      metrics: {
        originalWidth: width,
        originalHeight: height,
        preparedWidth: targetSquare,
        preparedHeight: targetSquare,
        hasForeground: false,
        hasTransparency,
        transparentPixelRatio: Number(transparentPixelRatio.toFixed(4)),
        estimatedIlluminationUnevenness,
        illuminationCorrected: opts.illuminationCorrection,
        contrastNormalized: opts.contrastNormalization,
        bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
        inkPixelCount,
        enclosedPixelCount: 0,
        foregroundInkRatio,
        measuredAspectRatio: 1,
        measuredAspectLabel: '—',
        verticalSymmetryScore: 0,
        coreBodySymmetryScore: 0,
        unilateralAppendageSide: 'none',
        hasBottomLegGap: false,
        detectedLowerColumnCount: 0,
        connectedComponentCount: 0,
        outerContourCount: 0,
        holeContourCount: 0,
        dominantContourPoints: 0,
        rotationalProfileSuitable: false,
        recommendedOfflineMode: 'unsupported',
        durationMs: Number((nowMs() - t0).toFixed(1)),
      },
      preparedRgba,
      preparedWidth: targetSquare,
      preparedHeight: targetSquare,
      contourOverlayRgba: emptyOverlay,
      croppedSilhouetteMask: new Uint8Array(0),
      croppedStrokeMask: new Uint8Array(0),
      croppedWidth: 0,
      croppedHeight: 0,
      contours: [],
      scanlines: [],
    };
  }

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const measuredAspectRatio = Number((bboxW / Math.max(1, bboxH)).toFixed(3));
  const measuredAspectLabel = `${measuredAspectRatio.toFixed(2)} : 1`;

  // Step 6: Automatic Crop & Centered Square Padding (preserving stroke grayscale fidelity)
  const padMargin = Math.round(targetSquare * 0.1);
  const innerMaxSpan = targetSquare - padMargin * 2;
  const fitScale = innerMaxSpan / Math.max(bboxW, bboxH, 1);
  const dstW = Math.max(1, Math.round(bboxW * fitScale));
  const dstH = Math.max(1, Math.round(bboxH * fitScale));
  const offsetX = Math.floor((targetSquare - dstW) / 2);
  const offsetY = Math.floor((targetSquare - dstH) / 2);

  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.min(maxY, minY + Math.floor(dy / fitScale));
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.min(maxX, minX + Math.floor(dx / fitScale));
      const g = normalizedGray[sy * width + sx];
      const outIdx = ((offsetY + dy) * targetSquare + (offsetX + dx)) * 4;
      preparedRgba[outIdx] = g;
      preparedRgba[outIdx + 1] = g;
      preparedRgba[outIdx + 2] = g;
      preparedRgba[outIdx + 3] = 255;
    }
  }

  // Step 7: Extract Cropped Silhouette & Interior Holes at Controlled Analysis Resolution (<= 280 px)
  const maxWorkDim = 256;
  const workScale = Math.min(1, maxWorkDim / Math.max(bboxW, bboxH));
  const cw = Math.max(16, Math.round(bboxW * workScale));
  const ch = Math.max(16, Math.round(bboxH * workScale));

  // Add a 4-pixel border around the cropped mask so flood-fill from borders always wraps around strokes
  const pad = 4;
  const mw = cw + pad * 2;
  const mh = ch + pad * 2;
  const croppedStrokePadded = new Uint8Array(mw * mh);

  for (let wy = 0; wy < ch; wy++) {
    const sy0 = minY + Math.floor(wy / workScale);
    const sy1 = Math.min(maxY, minY + Math.floor((wy + 1) / workScale));
    for (let wx = 0; wx < cw; wx++) {
      const sx0 = minX + Math.floor(wx / workScale);
      const sx1 = Math.min(maxX, minX + Math.floor((wx + 1) / workScale));
      let hit = 0;
      for (let sy = sy0; sy <= sy1 && !hit; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          if (fgMask[sy * width + sx]) {
            hit = 1;
            break;
          }
        }
      }
      if (hit) {
        croppedStrokePadded[(wy + pad) * mw + (wx + pad)] = 1;
      }
    }
  }

  // Morphological close (radius 2) bridges tiny 1-3 px hand-drawn pen gaps along closed silhouettes
  const closedStrokes = erodeBinary(
    dilateBinary(croppedStrokePadded, mw, mh, 2),
    mw,
    mh,
    2
  );

  // Flood-fill exterior background starting at (0, 0)
  const exteriorVisited = new Uint8Array(mw * mh);
  const bfsQueue = new Int32Array(mw * mh);
  let qHead = 0;
  let qTail = 0;
  exteriorVisited[0] = 1;
  bfsQueue[qTail++] = 0;

  while (qHead < qTail) {
    const curr = bfsQueue[qHead++];
    const cx = curr % mw;
    const cy = (curr - cx) / mw;

    if (cx > 0) {
      const n = curr - 1;
      if (!exteriorVisited[n] && !closedStrokes[n]) {
        exteriorVisited[n] = 1;
        bfsQueue[qTail++] = n;
      }
    }
    if (cx + 1 < mw) {
      const n = curr + 1;
      if (!exteriorVisited[n] && !closedStrokes[n]) {
        exteriorVisited[n] = 1;
        bfsQueue[qTail++] = n;
      }
    }
    if (cy > 0) {
      const n = curr - mw;
      if (!exteriorVisited[n] && !closedStrokes[n]) {
        exteriorVisited[n] = 1;
        bfsQueue[qTail++] = n;
      }
    }
    if (cy + 1 < mh) {
      const n = curr + mw;
      if (!exteriorVisited[n] && !closedStrokes[n]) {
        exteriorVisited[n] = 1;
        bfsQueue[qTail++] = n;
      }
    }
  }

  // Interior enclosed cavities (either true enclosed silhouette interior OR enclosed holes like a mug handle loop)
  // Wait: how do we distinguish an enclosed object interior from an enclosed hole inside a thick object (like a mug handle loop)?
  // Distance/hierarchy! Region 0 is exterior. Regions adjacent to `closedStrokes` that weren't reached from exterior
  // have parity depth: depth 1 = inside outer ring (object interior!), depth 2 = hole inside an interior ring, OR
  // if the user drew a mug with a closed cylinder body + a closed handle loop beside it, BOTH the cylinder interior AND
  // the handle loop interior are depth-1 cavities enclosed by strokes!
  // Let's inspect each enclosed non-stroke cavity component:
  // - Large central cavities (> 4% of bbox area) are the object's filled interior body!
  // - Small eccentric loop cavities adjacent to exterior on one side (or surrounded by thin loop strokes, e.g. 0.4%..6% of bbox area positioned on the far left/right flank while a much larger central cavity exists!) are genuine aperture HOLES (like a mug handle aperture)!
  const cavityLabels = new Int32Array(mw * mh);
  interface CavityInfo {
    id: number;
    area: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    pixels: number[];
  }
  const cavities: CavityInfo[] = [];

  for (let idx = 0; idx < mw * mh; idx++) {
    if (!exteriorVisited[idx] && !closedStrokes[idx] && cavityLabels[idx] === 0) {
      const id = cavities.length + 1;
      const pixels: number[] = [];
      let cMinX = mw;
      let cMaxX = 0;
      let cMinY = mh;
      let cMaxY = 0;

      qHead = 0;
      qTail = 0;
      cavityLabels[idx] = id;
      bfsQueue[qTail++] = idx;

      while (qHead < qTail) {
        const curr = bfsQueue[qHead++];
        pixels.push(curr);
        const x = curr % mw;
        const y = (curr - x) / mw;
        if (x < cMinX) cMinX = x;
        if (x > cMaxX) cMaxX = x;
        if (y < cMinY) cMinY = y;
        if (y > cMaxY) cMaxY = y;

        const neighbors = [
          x > 0 ? curr - 1 : -1,
          x + 1 < mw ? curr + 1 : -1,
          y > 0 ? curr - mw : -1,
          y + 1 < mh ? curr + mw : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && !exteriorVisited[n] && !closedStrokes[n] && cavityLabels[n] === 0) {
            cavityLabels[n] = id;
            bfsQueue[qTail++] = n;
          }
        }
      }

      cavities.push({
        id,
        area: pixels.length,
        minX: cMinX,
        maxX: cMaxX,
        minY: cMinY,
        maxY: cMaxY,
        pixels,
      });
    }
  }

  cavities.sort((a, b) => b.area - a.area);
  const largestCavityArea = cavities[0]?.area ?? 0;
  const totalCropArea = cw * ch;

  // Build silhouette mask: closedStrokes + interior body cavities, while keeping true small eccentric loop apertures as holes!
  const silhouettePadded = closedStrokes.slice();
  const preservedHoleCavities: CavityInfo[] = [];
  let enclosedPixelCount = 0;

  for (let i = 0; i < cavities.length; i++) {
    const cav = cavities[i];
    const centerRatioX = ((cav.minX + cav.maxX) * 0.5 - pad) / Math.max(1, cw);
    const isEccentricLoop =
      i > 0 &&
      largestCavityArea > totalCropArea * 0.12 &&
      cav.area >= totalCropArea * 0.004 &&
      cav.area <= largestCavityArea * 0.25 &&
      (centerRatioX < 0.28 || centerRatioX > 0.72);

    // Also if the user drew a solid filled shape with a white cutout hole inside it, `closedStrokes` already has the solid ink
    // and ANY enclosed white cavity inside that solid ink is a true hole!
    const strokeRatio = closedStrokes.reduce((s, v) => s + v, 0) / Math.max(1, totalCropArea);
    const isCutoutInSolidShape = strokeRatio > 0.28 && cav.area >= totalCropArea * 0.005 && cav.area < totalCropArea * 0.35;

    if (isEccentricLoop || isCutoutInSolidShape) {
      preservedHoleCavities.push(cav);
    } else {
      enclosedPixelCount += cav.area;
      for (const pIdx of cav.pixels) {
        silhouettePadded[pIdx] = 1;
      }
    }
  }

  // If the sketch had open contours (so enclosedPixelCount is tiny), slightly thicken strokes by 1px so open-line tables/frames still have clean continuous extrudable contour thickness
  const finalSilhouettePadded =
    enclosedPixelCount < totalCropArea * 0.03
      ? dilateBinary(silhouettePadded, mw, mh, 1)
      : silhouettePadded;

  // Extract unpadded cropped masks (cw × ch)
  const croppedSilhouetteMask = new Uint8Array(cw * ch);
  const croppedStrokeMask = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      croppedSilhouetteMask[y * cw + x] = finalSilhouettePadded[(y + pad) * mw + (x + pad)];
      croppedStrokeMask[y * cw + x] = croppedStrokePadded[(y + pad) * mw + (x + pad)];
    }
  }

  // Step 8: Connected Components & Outer/Hole Contour Extraction
  const compVisited = new Uint8Array(cw * ch);
  const contours: ContourPolygon2D[] = [];
  let connectedComponentCount = 0;

  for (let idx = 0; idx < cw * ch; idx++) {
    if (croppedSilhouetteMask[idx] && !compVisited[idx]) {
      connectedComponentCount += 1;
      const compMask = new Uint8Array(cw * ch);
      const compPixels: number[] = [];
      let cMinX = cw;
      let cMaxX = 0;
      let cMinY = ch;
      let cMaxY = 0;

      qHead = 0;
      qTail = 0;
      compVisited[idx] = 1;
      bfsQueue[qTail++] = idx;

      while (qHead < qTail) {
        const curr = bfsQueue[qHead++];
        compPixels.push(curr);
        compMask[curr] = 1;
        const x = curr % cw;
        const y = (curr - x) / cw;
        if (x < cMinX) cMinX = x;
        if (x > cMaxX) cMaxX = x;
        if (y < cMinY) cMinY = y;
        if (y > cMaxY) cMaxY = y;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < cw && ny >= 0 && ny < ch) {
              const n = ny * cw + nx;
              if (croppedSilhouetteMask[n] && !compVisited[n]) {
                compVisited[n] = 1;
                bfsQueue[qTail++] = n;
              }
            }
          }
        }
      }

      if (compPixels.length < Math.max(18, totalCropArea * 0.005)) {
        continue;
      }

      const rawLoop = traceSingleMaskBoundary(compMask, cw, ch);
      if (rawLoop.length < 6) continue;
      const simpLoop = simplifyPolygonRdp(rawLoop, 1.35);
      if (simpLoop.length < 3) continue;

      const normOuter: Array<[number, number]> = simpLoop.map(([px, py]) => [
        px / Math.max(1, cw - 1),
        py / Math.max(1, ch - 1),
      ]);

      // Attach any preserved hole cavities that lie inside this component's bounding box
      const compHoles: Array<Array<[number, number]>> = [];
      for (const holeCav of preservedHoleCavities) {
        const hx0 = holeCav.minX - pad;
        const hx1 = holeCav.maxX - pad;
        const hy0 = holeCav.minY - pad;
        const hy1 = holeCav.maxY - pad;
        if (hx0 >= cMinX - 2 && hx1 <= cMaxX + 2 && hy0 >= cMinY - 2 && hy1 <= cMaxY + 2) {
          const hMask = new Uint8Array(cw * ch);
          for (const pIdx of holeCav.pixels) {
            const x = (pIdx % mw) - pad;
            const y = Math.floor(pIdx / mw) - pad;
            if (x >= 0 && x < cw && y >= 0 && y < ch) {
              hMask[y * cw + x] = 1;
            }
          }
          const rawHole = traceSingleMaskBoundary(hMask, cw, ch);
          const simpHole = simplifyPolygonRdp(rawHole, 1.15);
          if (simpHole.length >= 3) {
            compHoles.push(
              simpHole.map(([px, py]) => [
                px / Math.max(1, cw - 1),
                py / Math.max(1, ch - 1),
              ])
            );
          }
        }
      }

      contours.push({
        points: normOuter,
        areaPx: Math.max(compPixels.length, Math.abs(signedPolygonArea(simpLoop))),
        holes: compHoles,
        bounds: {
          minX: cMinX / Math.max(1, cw - 1),
          minY: cMinY / Math.max(1, ch - 1),
          maxX: cMaxX / Math.max(1, cw - 1),
          maxY: cMaxY / Math.max(1, ch - 1),
        },
      });
    }
  }

  contours.sort((a, b) => b.areaPx - a.areaPx);
  const keptContours = contours.slice(0, 8);
  const holeContourCount = keptContours.reduce((accH, c) => accH + c.holes.length, 0);

  // Step 9: Horizontal Scanline Profile, Bilateral Symmetry & Multi-Leg Detection
  const NUM_BANDS = 56;
  const scanlines: ScanlineSpan[] = [];
  let symNumerator = 0;
  let symDenom = 0;
  const centerAxisValues: number[] = [];

  for (let b = 0; b < NUM_BANDS; b++) {
    const v = b / (NUM_BANDS - 1);
    const y = Math.min(ch - 1, Math.round(v * (ch - 1)));
    const rowOffset = y * cw;
    let left = -1;
    let right = -1;
    let occupied = 0;
    let segments = 0;
    let inSeg = false;
    let gapRun = 0;

    for (let x = 0; x < cw; x++) {
      if (croppedSilhouetteMask[rowOffset + x]) {
        if (left === -1) left = x;
        right = x;
        occupied += 1;
        if (!inSeg) {
          segments += 1;
          inSeg = true;
        }
        gapRun = 0;
      } else if (inSeg) {
        gapRun += 1;
        // Require >= 4% gap width to count as distinct separated columns/legs
        if (gapRun >= Math.max(3, Math.round(cw * 0.045))) {
          inSeg = false;
        }
      }
    }

    const leftNorm = left === -1 ? -1 : left / Math.max(1, cw - 1);
    const rightNorm = right === -1 ? -1 : right / Math.max(1, cw - 1);

    if (leftNorm >= 0 && rightNorm >= 0) {
      const distLeft = leftNorm;
      const distRight = 1 - rightNorm;
      const diff = Math.abs(distLeft - distRight);
      symNumerator += Math.max(0, 1 - diff * 2.2);
      symDenom += 1;
      // Track median center axis for core body + unilateral handle detection (e.g. mug)
      if (v < 0.2 || v > 0.82) {
        centerAxisValues.push((leftNorm + rightNorm) * 0.5);
      }
    }

    scanlines.push({
      v,
      left: leftNorm,
      right: rightNorm,
      occupiedRatio: occupied / cw,
      segmentCount: segments,
    });
  }

  // Pixel mirror IoU inside cropped silhouette around bbox center
  let mirrorIntersect = 0;
  let mirrorUnion = 0;
  for (let y = 0; y < ch; y++) {
    const row = y * cw;
    for (let x = 0; x < cw; x++) {
      const a = croppedSilhouetteMask[row + x];
      const b = croppedSilhouetteMask[row + (cw - 1 - x)];
      if (a || b) {
        mirrorUnion += 1;
        if (a && b) mirrorIntersect += 1;
      }
    }
  }
  const pixelMirrorScore = mirrorUnion > 0 ? mirrorIntersect / mirrorUnion : 0;
  const spanSymScore = symDenom > 0 ? symNumerator / symDenom : 0;
  const verticalSymmetryScore = Number(
    (spanSymScore * 0.55 + pixelMirrorScore * 0.45).toFixed(3)
  );

  // Check if top & bottom rims define a symmetric core vessel with a single unilateral side handle (e.g. mug!)
  let coreBodySymmetryScore = verticalSymmetryScore;
  let unilateralAppendageSide: 'none' | 'left' | 'right' = 'none';

  if (centerAxisValues.length >= 6) {
    const sortedCenters = [...centerAxisValues].sort((a, b) => a - b);
    const coreAxis = sortedCenters[Math.floor(sortedCenters.length / 2)];
    if (coreAxis > 0.25 && coreAxis < 0.75) {
      let coreSymSum = 0;
      let coreCount = 0;
      let rightProtrusionRows = 0;
      let leftProtrusionRows = 0;

      for (const sl of scanlines) {
        if (sl.left < 0 || sl.right < 0) continue;
        const rLeft = Math.max(0, coreAxis - sl.left);
        const rRight = Math.max(0, sl.right - coreAxis);
        const minR = Math.min(rLeft, rRight);
        const maxR = Math.max(rLeft, rRight);
        if (minR > 0.06) {
          coreCount += 1;
          if (rRight - rLeft > 0.11 && sl.v >= 0.14 && sl.v <= 0.88) {
            rightProtrusionRows += 1;
            coreSymSum += 0.92;
          } else if (rLeft - rRight > 0.11 && sl.v >= 0.14 && sl.v <= 0.88) {
            leftProtrusionRows += 1;
            coreSymSum += 0.92;
          } else {
            coreSymSum += 1 - Math.min(1, Math.abs(rRight - rLeft) / Math.max(0.08, maxR));
          }
        }
      }

      if (coreCount >= NUM_BANDS * 0.65) {
        const candidateCoreSym = coreSymSum / coreCount;
        if (rightProtrusionRows >= 6 && leftProtrusionRows <= 2 && candidateCoreSym >= 0.82) {
          coreBodySymmetryScore = Number(candidateCoreSym.toFixed(3));
          unilateralAppendageSide = 'right';
        } else if (leftProtrusionRows >= 6 && rightProtrusionRows <= 2 && candidateCoreSym >= 0.82) {
          coreBodySymmetryScore = Number(candidateCoreSym.toFixed(3));
          unilateralAppendageSide = 'left';
        }
      }
    }
  }

  // Detect multi-leg / open-arch gap in the bottom 30% of the silhouette (prevents tables & chairs from being lathed!)
  const lowerBands = scanlines.filter((s) => s.v >= 0.72 && s.v <= 0.96 && s.left >= 0);
  let multiSegBands = 0;
  let maxLowerSegments = 1;
  for (const lb of lowerBands) {
    if (lb.segmentCount >= 2) {
      multiSegBands += 1;
      if (lb.segmentCount > maxLowerSegments) {
        maxLowerSegments = lb.segmentCount;
      }
    }
  }
  const hasBottomLegGap = lowerBands.length >= 4 && multiSegBands >= Math.ceil(lowerBands.length * 0.45);
  const detectedLowerColumnCount = hasBottomLegGap ? maxLowerSegments : 1;

  // Determine rotational profile suitability & honest recommended offline reconstruction mode
  const validScanlineRatio = symDenom / NUM_BANDS;
  const isOverSaturatedNoise = foregroundInkRatio > 0.78;
  const isFragmentedNoise = connectedComponentCount > 30 && keptContours.length === 0;

  let recommendedOfflineMode: OfflineReconstructionMode = 'contour_extrusion';
  let rotationalProfileSuitable = false;

  if (isOverSaturatedNoise || isFragmentedNoise || keptContours.length === 0) {
    recommendedOfflineMode = 'unsupported';
  } else if (
    !hasBottomLegGap &&
    validScanlineRatio >= 0.75 &&
    keptContours.length <= 2 &&
    verticalSymmetryScore >= 0.82
  ) {
    rotationalProfileSuitable = true;
    recommendedOfflineMode = 'lathe_rotational';
  } else if (
    !hasBottomLegGap &&
    validScanlineRatio >= 0.75 &&
    unilateralAppendageSide !== 'none' &&
    coreBodySymmetryScore >= 0.82
  ) {
    rotationalProfileSuitable = true;
    recommendedOfflineMode = 'lathe_with_handle';
  }

  // Step 10: Build Contour Diagnostic Overlay RGBA (Original size: normalized gray + emerald outer contours + blue bbox + amber symmetry axis)
  const contourOverlayRgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < totalPixels; i++) {
    const o = i * 4;
    const v = normalizedGray[i];
    contourOverlayRgba[o] = v;
    contourOverlayRgba[o + 1] = v;
    contourOverlayRgba[o + 2] = v;
    contourOverlayRgba[o + 3] = 255;
  }

  // Draw bounding box in blueprint blue (#2563eb)
  const plotPixel = (px: number, py: number, r: number, g: number, b: number) => {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const o = (py * width + px) * 4;
    contourOverlayRgba[o] = r;
    contourOverlayRgba[o + 1] = g;
    contourOverlayRgba[o + 2] = b;
    contourOverlayRgba[o + 3] = 255;
  };

  for (let x = minX; x <= maxX; x++) {
    plotPixel(x, minY, 37, 99, 235);
    plotPixel(x, maxY, 37, 99, 235);
  }
  for (let y = minY; y <= maxY; y++) {
    plotPixel(minX, y, 37, 99, 235);
    plotPixel(maxX, y, 37, 99, 235);
  }

  // Draw vertical symmetry axis (dashed amber #d97706)
  const midBoxX = Math.round((minX + maxX) * 0.5);
  for (let y = minY; y <= maxY; y++) {
    if (Math.floor(y / 5) % 2 === 0) {
      plotPixel(midBoxX, y, 217, 119, 6);
    }
  }

  // Draw extracted contour edges in emerald (#059669)
  const drawPolyOnOverlay = (
    poly: Array<[number, number]>,
    r: number,
    g: number,
    b: number
  ) => {
    for (let i = 0; i < poly.length; i++) {
      const [u0, v0] = poly[i];
      const [u1, v1] = poly[(i + 1) % poly.length];
      const x0 = Math.round(minX + u0 * (bboxW - 1));
      const y0 = Math.round(minY + v0 * (bboxH - 1));
      const x1 = Math.round(minX + u1 * (bboxW - 1));
      const y1 = Math.round(minY + v1 * (bboxH - 1));
      const steps = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
      for (let s = 0; s <= steps; s++) {
        const px = Math.round(x0 + ((x1 - x0) * s) / steps);
        const py = Math.round(y0 + ((y1 - y0) * s) / steps);
        plotPixel(px, py, r, g, b);
        plotPixel(px + 1, py, r, g, b);
        plotPixel(px, py + 1, r, g, b);
      }
    }
  };

  for (const c of keptContours) {
    drawPolyOnOverlay(c.points, 5, 150, 105);
    for (const h of c.holes) {
      drawPolyOnOverlay(h, 220, 38, 38);
    }
  }

  const dominantContourPoints = keptContours[0]?.points.length ?? 0;

  return {
    metrics: {
      originalWidth: width,
      originalHeight: height,
      preparedWidth: targetSquare,
      preparedHeight: targetSquare,
      hasForeground: true,
      hasTransparency,
      transparentPixelRatio: Number(transparentPixelRatio.toFixed(4)),
      estimatedIlluminationUnevenness,
      illuminationCorrected: opts.illuminationCorrection,
      contrastNormalized: opts.contrastNormalization,
      bbox: {
        minX,
        minY,
        maxX,
        maxY,
        width: bboxW,
        height: bboxH,
      },
      inkPixelCount,
      enclosedPixelCount,
      foregroundInkRatio,
      measuredAspectRatio,
      measuredAspectLabel,
      verticalSymmetryScore,
      coreBodySymmetryScore,
      unilateralAppendageSide,
      hasBottomLegGap,
      detectedLowerColumnCount,
      connectedComponentCount,
      outerContourCount: keptContours.length,
      holeContourCount,
      dominantContourPoints,
      rotationalProfileSuitable,
      recommendedOfflineMode,
      durationMs: Number((nowMs() - t0).toFixed(1)),
    },
    preparedRgba,
    preparedWidth: targetSquare,
    preparedHeight: targetSquare,
    contourOverlayRgba,
    croppedSilhouetteMask,
    croppedStrokeMask,
    croppedWidth: cw,
    croppedHeight: ch,
    contours: keptContours,
    scanlines,
  };
}

function rgbaToCanvasDataUrlAndBlob(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Promise<{ blob: Blob; dataUrl: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable for CV image encoding.');
  }
  const copy = new Uint8ClampedArray(rgba.length);
  copy.set(rgba);
  const imgData = new ImageData(copy, width, height);
  ctx.putImageData(imgData, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to encode preprocessed PNG blob.'));
          return;
        }
        resolve({ blob, dataUrl });
      },
      'image/png',
      1.0
    );
  });
}

/**
 * Browser helper that decodes an uploaded or drawn image Blob, runs deterministic CV preprocessing,
 * and returns both Original vs Prepared previews and contour diagnostics without modifying the original Blob.
 */
export async function preprocessSketchBlob(
  blob: Blob,
  options?: Partial<SketchPreprocessOptions>
): Promise<BrowserPreprocessResult> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode sketch image pixels for CV preprocessing.'));
      el.src = objectUrl;
    });

    const w = Math.max(1, img.naturalWidth || img.width);
    const h = Math.max(1, img.naturalHeight || img.height);
    const decodeCanvas = document.createElement('canvas');
    decodeCanvas.width = w;
    decodeCanvas.height = h;
    const ctx = decodeCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Could not initialize 2D canvas for sketch pixel extraction.');
    }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const rawImageData = ctx.getImageData(0, 0, w, h);

    const rawResult = preprocessRgbaPixels(rawImageData.data, w, h, options);
    const [preparedEncoded, overlayEncoded] = await Promise.all([
      rgbaToCanvasDataUrlAndBlob(
        rawResult.preparedRgba,
        rawResult.preparedWidth,
        rawResult.preparedHeight
      ),
      rgbaToCanvasDataUrlAndBlob(rawResult.contourOverlayRgba, w, h),
    ]);

    return {
      ...rawResult,
      preparedBlob: preparedEncoded.blob,
      preparedDataUrl: preparedEncoded.dataUrl,
      contourOverlayDataUrl: overlayEncoded.dataUrl,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
