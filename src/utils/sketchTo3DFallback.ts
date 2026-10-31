import * as THREE from 'three';
import type {
  CompiledReconstructionSpec,
  ContourPolygon2D,
  OfflineReconstructionMode,
  ValidatedMeshStats,
} from '../types/studio';
import {
  preprocessRgbaPixels,
  preprocessSketchBlob,
  type RawPreprocessResult,
} from './sketchPreprocessor';
import {
  disposeObject3D,
  exportObjectToGlbBuffer,
  validateAndParseGlbBuffer,
} from './glbValidator';

export const OFFLINE_FALLBACK_PROVENANCE_LABEL =
  'Local Contour-Reconstructed 3D Mesh — Offline Fallback (Not Tripo Neural Reconstruction)';

export class OfflineReconstructionError extends Error {
  public readonly code: string;
  public readonly suggestion: string;

  constructor(code: string, message: string, suggestion: string) {
    super(message);
    this.name = 'OfflineReconstructionError';
    this.code = code;
    this.suggestion = suggestion;
  }
}

export interface OfflineReconstructionOutput {
  glbBuffer: ArrayBuffer;
  stats: ValidatedMeshStats;
  modeUsed: OfflineReconstructionMode;
  provenanceLabel: string;
  durationMs: number;
  geometrySummary: string;
}

function signedArea2D(pts: Array<[number, number]>): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

/**
 * Converts normalized [0..1] image-space polygon points into centered metric 2D world coordinates
 * (X right, Y up) and enforces Three.js winding order (CCW for outer Shape, CW for hole Path).
 */
function toCenteredWorldPoints(
  normPts: Array<[number, number]>,
  worldWidth: number,
  worldHeight: number,
  wantCounterClockwise: boolean
): THREE.Vector2[] {
  const mapped: Array<[number, number]> = normPts.map(([u, v]) => [
    (u - 0.5) * worldWidth,
    (0.5 - v) * worldHeight,
  ]);
  const area = signedArea2D(mapped);
  if ((wantCounterClockwise && area < 0) || (!wantCounterClockwise && area > 0)) {
    mapped.reverse();
  }
  return mapped.map(([x, y]) => new THREE.Vector2(x, y));
}

function buildShapeFromContour(
  contour: ContourPolygon2D,
  worldWidth: number,
  worldHeight: number
): THREE.Shape | null {
  if (contour.points.length < 3) return null;
  const outerVecs = toCenteredWorldPoints(contour.points, worldWidth, worldHeight, true);
  if (outerVecs.length < 3) return null;

  const shape = new THREE.Shape(outerVecs);
  for (const holePts of contour.holes) {
    if (holePts.length >= 3) {
      const holeVecs = toCenteredWorldPoints(holePts, worldWidth, worldHeight, false);
      if (holeVecs.length >= 3) {
        const path = new THREE.Path(holeVecs);
        shape.holes.push(path);
      }
    }
  }
  return shape;
}

/**
 * Extracts a binary sub-mask of a unilateral side handle/appendage outside the symmetric core vessel
 * and builds an extruded 3D mesh (preserving any interior handle aperture hole!).
 */
function buildUnilateralHandleMesh(
  prep: RawPreprocessResult,
  coreAxisNorm: number,
  coreRadiiByRow: Float32Array,
  worldWidth: number,
  worldHeight: number,
  material: THREE.MeshStandardMaterial
): THREE.Mesh | null {
  const { croppedSilhouetteMask, croppedWidth: cw, croppedHeight: ch } = prep;
  const side = prep.metrics.unilateralAppendageSide;
  if (side === 'none' || cw < 16 || ch < 16) return null;

  // Collect appendage pixels outside the lathed vessel wall (with slight overlap into the wall so handle welds cleanly)
  const handleMask = new Uint8Array(cw * ch);
  let count = 0;

  for (let y = 0; y < ch; y++) {
    const v = y / Math.max(1, ch - 1);
    const bandIdx = Math.min(
      coreRadiiByRow.length - 1,
      Math.round(v * (coreRadiiByRow.length - 1))
    );
    const rNorm = Math.max(0.03, coreRadiiByRow[bandIdx] - 0.028);
    for (let x = 0; x < cw; x++) {
      if (!croppedSilhouetteMask[y * cw + x]) continue;
      const u = x / Math.max(1, cw - 1);
      const outsideRight = side === 'right' && u > coreAxisNorm + rNorm;
      const outsideLeft = side === 'left' && u < coreAxisNorm - rNorm;
      if (outsideRight || outsideLeft) {
        handleMask[y * cw + x] = 1;
        count += 1;
      }
    }
  }

  if (count < 16) return null;

  // Run preprocessRgbaPixels on synthetic RGBA of the isolated handle region to extract its exact outer loop + hole!
  const handleRgba = new Uint8ClampedArray(cw * ch * 4);
  handleRgba.fill(255);
  for (let i = 0; i < cw * ch; i++) {
    if (handleMask[i]) {
      const o = i * 4;
      handleRgba[o] = 15;
      handleRgba[o + 1] = 23;
      handleRgba[o + 2] = 42;
      handleRgba[o + 3] = 255;
    }
  }
  // Preserve any hole from original stroke mask inside the handle region
  const subPrep = preprocessRgbaPixels(handleRgba, cw, ch, {
    illuminationCorrection: false,
    contrastNormalization: false,
    squareSize: 128,
  });

  if (!subPrep.metrics.hasForeground || subPrep.contours.length === 0) return null;

  const subBbox = subPrep.metrics.bbox;
  const dom = subPrep.contours[0];

  // Map sub-bbox normalized coordinates back into main cropped [0..1] space
  const mappedContour: ContourPolygon2D = {
    points: dom.points.map(([su, sv]) => [
      (subBbox.minX + su * Math.max(1, subBbox.width - 1)) / Math.max(1, cw - 1),
      (subBbox.minY + sv * Math.max(1, subBbox.height - 1)) / Math.max(1, ch - 1),
    ]),
    areaPx: dom.areaPx,
    holes: dom.holes.map((h) =>
      h.map(([su, sv]) => [
        (subBbox.minX + su * Math.max(1, subBbox.width - 1)) / Math.max(1, cw - 1),
        (subBbox.minY + sv * Math.max(1, subBbox.height - 1)) / Math.max(1, ch - 1),
      ])
    ),
    bounds: dom.bounds,
  };

  // Also transfer any main-contour eccentric hole that falls inside the handle region
  if (mappedContour.holes.length === 0) {
    for (const mainC of prep.contours) {
      for (const h of mainC.holes) {
        const avgU = h.reduce((s, p) => s + p[0], 0) / h.length;
        if (
          (side === 'right' && avgU > coreAxisNorm + 0.08) ||
          (side === 'left' && avgU < coreAxisNorm - 0.08)
        ) {
          mappedContour.holes.push(h);
        }
      }
    }
  }

  const shape = buildShapeFromContour(mappedContour, worldWidth, worldHeight);
  if (!shape) return null;

  const handleThickness = Math.max(0.045, Math.min(0.11, worldWidth * 0.095));
  const extrudeGeom = new THREE.ExtrudeGeometry(shape, {
    steps: 1,
    depth: handleThickness,
    bevelEnabled: true,
    bevelThickness: handleThickness * 0.22,
    bevelSize: handleThickness * 0.18,
    bevelSegments: 2,
    curveSegments: 14,
  });
  extrudeGeom.translate(0, 0, -handleThickness * 0.5);
  extrudeGeom.computeVertexNormals();

  const handleMesh = new THREE.Mesh(extrudeGeom, material);
  handleMesh.name = 'Sketch_Traced_Handle';
  return handleMesh;
}

/**
 * Splits a multi-leg silhouette (such as a table or chair sketch) into upper body mask and lower support column masks
 * directly from the user's sketch pixels so legs can be positioned in 3D depth according to IntentLock!
 */
function buildDepthSeparatedSupportGroup(
  prep: RawPreprocessResult,
  worldWidth: number,
  worldHeight: number,
  totalDepth: number,
  spec: CompiledReconstructionSpec,
  primaryMat: THREE.MeshStandardMaterial,
  secondaryMat: THREE.MeshStandardMaterial
): THREE.Group | null {
  const { croppedSilhouetteMask, croppedWidth: cw, croppedHeight: ch, scanlines } = prep;

  // Locate split row where single wide upper body transitions into multiple separated leg columns
  let splitNormV = 0.68;
  for (const sl of scanlines) {
    if (sl.v >= 0.45 && sl.v <= 0.85 && sl.segmentCount >= 2) {
      splitNormV = Math.max(0.42, sl.v - 0.03);
      break;
    }
  }
  const splitRow = Math.round(splitNormV * (ch - 1));
  if (splitRow <= 4 || splitRow >= ch - 4) return null;

  // Extract upper body RGBA and lower legs RGBA directly from croppedSilhouetteMask
  const makeSubPrep = (yStart: number, yEnd: number) => {
    const rgba = new Uint8ClampedArray(cw * ch * 4);
    rgba.fill(255);
    for (let y = yStart; y <= yEnd; y++) {
      for (let x = 0; x < cw; x++) {
        if (croppedSilhouetteMask[y * cw + x]) {
          const o = (y * cw + x) * 4;
          rgba[o] = 15;
          rgba[o + 1] = 23;
          rgba[o + 2] = 42;
          rgba[o + 3] = 255;
        }
      }
    }
    return preprocessRgbaPixels(rgba, cw, ch, {
      illuminationCorrection: false,
      contrastNormalization: false,
      squareSize: 128,
    });
  };

  const upperPrep = makeSubPrep(0, Math.min(ch - 1, splitRow + 2));
  const lowerPrep = makeSubPrep(Math.max(0, splitRow - 2), ch - 1);

  if (upperPrep.contours.length === 0 || lowerPrep.contours.length === 0) {
    return null;
  }

  const mapSubContour = (sub: RawPreprocessResult, c: ContourPolygon2D): ContourPolygon2D => ({
    points: c.points.map(([u, v]) => [
      (sub.metrics.bbox.minX + u * Math.max(1, sub.metrics.bbox.width - 1)) / Math.max(1, cw - 1),
      (sub.metrics.bbox.minY + v * Math.max(1, sub.metrics.bbox.height - 1)) / Math.max(1, ch - 1),
    ]),
    areaPx: c.areaPx,
    holes: c.holes.map((h) =>
      h.map(([u, v]) => [
        (sub.metrics.bbox.minX + u * Math.max(1, sub.metrics.bbox.width - 1)) /
          Math.max(1, cw - 1),
        (sub.metrics.bbox.minY + v * Math.max(1, sub.metrics.bbox.height - 1)) /
          Math.max(1, ch - 1),
      ])
    ),
    bounds: c.bounds,
  });

  const group = new THREE.Group();
  group.name = 'Sketch_Structural_Assembly';

  // 1. Extrude upper tabletop/seat/backrest silhouette to full volumetric depth
  upperPrep.contours.forEach((uc, idx) => {
    const mapped = mapSubContour(upperPrep, uc);
    const shape = buildShapeFromContour(mapped, worldWidth, worldHeight);
    if (!shape) return;
    const bevel = Math.min(0.018, totalDepth * 0.05);
    const geom = new THREE.ExtrudeGeometry(shape, {
      steps: 1,
      depth: totalDepth,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: 14,
    });
    geom.translate(0, 0, -totalDepth * 0.5);
    geom.computeVertexNormals();
    const mesh = new THREE.Mesh(geom, primaryMat);
    mesh.name = `Upper_Silhouette_${idx + 1}`;
    group.add(mesh);
  });

  // 2. Extrude traced lower leg/support silhouettes at IntentLock-resolved 3D Z positions
  const legThickness = Math.max(0.045, Math.min(0.11, totalDepth * 0.18));
  const zOffset = Math.max(legThickness * 0.7, totalDepth * 0.36);

  if (spec.supportTopology === 'pedestal_base') {
    // User explicitly chose central pedestal support in IntentLock: extrude centered column from traced lower span
    const legMinY =
      (0.5 -
        (lowerPrep.metrics.bbox.maxY / Math.max(1, ch - 1))) *
      worldHeight;
    const legMaxY =
      (0.5 -
        (lowerPrep.metrics.bbox.minY / Math.max(1, ch - 1))) *
      worldHeight;
    const pedHeight = Math.max(0.08, legMaxY - legMinY);
    const pedRadius = Math.max(0.08, Math.min(worldWidth, totalDepth) * 0.2);
    const pedGeom = new THREE.CylinderGeometry(pedRadius * 0.72, pedRadius * 1.15, pedHeight, 28);
    pedGeom.translate(0, (legMinY + legMaxY) * 0.5, 0);
    const pedMesh = new THREE.Mesh(pedGeom, secondaryMat);
    pedMesh.name = 'IntentLock_Pedestal_Support';
    group.add(pedMesh);
  } else if (spec.supportTopology === 'three_leg_tripod') {
    // Front pair + single centered rear leg using traced leg contours
    lowerPrep.contours.slice(0, 2).forEach((lc, idx) => {
      const mapped = mapSubContour(lowerPrep, lc);
      const shape = buildShapeFromContour(mapped, worldWidth, worldHeight);
      if (!shape) return;
      const geomFront = new THREE.ExtrudeGeometry(shape, {
        steps: 1,
        depth: legThickness,
        bevelEnabled: true,
        bevelThickness: 0.006,
        bevelSize: 0.006,
        bevelSegments: 2,
      });
      geomFront.translate(0, 0, zOffset - legThickness * 0.5);
      geomFront.computeVertexNormals();
      const mFront = new THREE.Mesh(geomFront, secondaryMat);
      mFront.name = `Tripod_Front_Support_${idx + 1}`;
      group.add(mFront);
    });

    // Centered rear third leg cloned from first traced leg contour shifted to X=0, -zOffset
    const firstMapped = mapSubContour(lowerPrep, lowerPrep.contours[0]);
    const avgU = firstMapped.points.reduce((s, p) => s + p[0], 0) / firstMapped.points.length;
    const centeredContour: ContourPolygon2D = {
      ...firstMapped,
      points: firstMapped.points.map(([u, v]) => [u - avgU + 0.5, v]),
    };
    const rearShape = buildShapeFromContour(centeredContour, worldWidth, worldHeight);
    if (rearShape) {
      const rearGeom = new THREE.ExtrudeGeometry(rearShape, {
        steps: 1,
        depth: legThickness,
        bevelEnabled: true,
        bevelThickness: 0.006,
        bevelSize: 0.006,
        bevelSegments: 2,
      });
      rearGeom.translate(0, 0, -zOffset - legThickness * 0.5);
      rearGeom.computeVertexNormals();
      const mRear = new THREE.Mesh(rearGeom, secondaryMat);
      mRear.name = 'Tripod_Rear_Center_Support';
      group.add(mRear);
    }
  } else {
    // Symmetric front & rear depth planes using the exact traced leg contours from the user's sketch
    lowerPrep.contours.forEach((lc, idx) => {
      const mapped = mapSubContour(lowerPrep, lc);
      const shape = buildShapeFromContour(mapped, worldWidth, worldHeight);
      if (!shape) return;

      for (const [planeLabel, planeZ] of [
        ['Front', zOffset],
        ['Rear', -zOffset],
      ] as const) {
        const geom = new THREE.ExtrudeGeometry(shape, {
          steps: 1,
          depth: legThickness,
          bevelEnabled: true,
          bevelThickness: 0.006,
          bevelSize: 0.006,
          bevelSegments: 2,
        });
        geom.translate(0, 0, planeZ - legThickness * 0.5);
        geom.computeVertexNormals();
        const mesh = new THREE.Mesh(geom, secondaryMat);
        mesh.name = `Traced_${planeLabel}_Support_${idx + 1}`;
        group.add(mesh);
      }
    });
  }

  return group.children.length >= 2 ? group : null;
}

/**
 * Deterministically reconstructs a genuine, exportable 3D GLB mesh strictly from the user's
 * preprocessed 2D sketch pixels, extracted contours/scanlines, and confirmed IntentLock specification.
 *
 * Honesty Rules:
 * - Never loads or returns the calibration chair or any preset geometry.
 * - Rejects blank, solid-black, or incoherent sketches with an explicit OfflineReconstructionError.
 * - Uses LatheGeometry ONLY when rotational profile suitability holds (or user explicitly requested rotational symmetry).
 * - Uses contour-based ExtrudeGeometry for closed silhouettes, asymmetric drawings, and multi-leg structures.
 */
export async function reconstructOffline3DFromPreprocessed(
  prep: RawPreprocessResult,
  spec: CompiledReconstructionSpec,
  unrecognizedByVision = false
): Promise<OfflineReconstructionOutput> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  if (!prep.metrics.hasForeground || prep.metrics.inkPixelCount < 12) {
    throw new OfflineReconstructionError(
      'BLANK_OR_EMPTY_SKETCH',
      'No foreground ink strokes were detected in the sketch, so Sketch2Shape refuses to generate a preset 3D object.',
      'Draw a clear dark silhouette on the canvas or upload a visible 2D sketch image.'
    );
  }

  if (unrecognizedByVision || /unrecognized\s+or\s+blank\s+sketch/i.test(spec.objectName)) {
    throw new OfflineReconstructionError(
      'UNSUPPORTED_BLANK_OR_UNRECOGNIZED',
      'Vision audit marked this input as unrecognized, so Sketch2Shape refuses to fabricate an unrelated 3D object.',
      'Draw a clear closed object silhouette on the canvas or upload a high-contrast 2D sketch.'
    );
  }

  if (
    prep.metrics.recommendedOfflineMode === 'unsupported' ||
    prep.contours.length === 0 ||
    prep.metrics.bbox.width < 16 ||
    prep.metrics.bbox.height < 16
  ) {
    throw new OfflineReconstructionError(
      'UNSUPPORTED_SKETCH_FOR_CONTOUR_RECONSTRUCTION',
      'This sketch does not contain a sufficiently coherent foreground contour or silhouette for deterministic local 3D reconstruction.',
      'Close open outline gaps, increase stroke contrast against a light background, or configure TRIPO_API_KEY for neural single-view reconstruction.'
    );
  }

  // Decide final reconstruction mode combining CV geometry metrics + IntentLock overrides
  const nonRotationalKeywords =
    /\b(chair|armchair|sofa|table|desk|bench|shelf|bookcase|cabinet|car|truck|bracket|guitar|wrench|hammer|star|l[-\s]*shape|cantilever|asymmetric)\b/i;

  let modeUsed: OfflineReconstructionMode = prep.metrics.recommendedOfflineMode;

  if (spec.symmetryOverride === 'extrusion') {
    modeUsed = 'contour_extrusion';
  } else if (spec.symmetryOverride === 'rotational' && !prep.metrics.hasBottomLegGap) {
    modeUsed =
      prep.metrics.unilateralAppendageSide !== 'none' ? 'lathe_with_handle' : 'lathe_rotational';
  } else if (nonRotationalKeywords.test(spec.objectName)) {
    modeUsed = 'contour_extrusion';
  }

  // World scale normalized to 1.0 unit max 2D span while strictly preserving measured W:H aspect ratio
  const aspect = prep.metrics.measuredAspectRatio || 1;
  const worldWidth = aspect >= 1 ? 1.0 : aspect;
  const worldHeight = aspect >= 1 ? 1.0 / aspect : 1.0;

  const primaryMat = new THREE.MeshStandardMaterial({
    name: 'intentlock_primary',
    color: new THREE.Color(spec.primaryHex),
    roughness: spec.roughness,
    metalness: spec.metalness,
    transparent: spec.opacity < 0.99,
    opacity: spec.opacity,
  });

  const secondaryMat = new THREE.MeshStandardMaterial({
    name: 'intentlock_secondary',
    color: new THREE.Color(spec.secondaryHex),
    roughness: Math.min(0.95, Math.max(0.12, spec.roughness + 0.18)),
    metalness: Math.max(0.04, spec.metalness * 0.65),
  });

  const rootGroup = new THREE.Group();
  rootGroup.name =
    spec.objectName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'Offline_Sketch_Model';

  let geometrySummary = '';

  if (modeUsed === 'lathe_rotational' || modeUsed === 'lathe_with_handle') {
    // Determine symmetric core axis from top/bottom scanlines
    const validScans = prep.scanlines.filter((s) => s.left >= 0 && s.right >= 0);
    const rimCenters = validScans
      .filter((s) => s.v < 0.22 || s.v > 0.8)
      .map((s) => (s.left + s.right) * 0.5)
      .sort((a, b) => a - b);
    const coreAxisNorm =
      rimCenters.length > 0 ? rimCenters[Math.floor(rimCenters.length / 2)] : 0.5;

    const rawRadii = new Float32Array(prep.scanlines.length);
    for (let i = 0; i < prep.scanlines.length; i++) {
      const sl = prep.scanlines[i];
      if (sl.left < 0 || sl.right < 0) {
        rawRadii[i] = i > 0 ? rawRadii[i - 1] : 0.08;
        continue;
      }
      const rLeft = Math.max(0.01, coreAxisNorm - sl.left);
      const rRight = Math.max(0.01, sl.right - coreAxisNorm);
      // If unilateral handle exists on right/left, take the opposite symmetric side as true vessel radius!
      if (modeUsed === 'lathe_with_handle') {
        rawRadii[i] =
          prep.metrics.unilateralAppendageSide === 'right'
            ? rLeft
            : prep.metrics.unilateralAppendageSide === 'left'
              ? rRight
              : Math.min(rLeft, rRight);
      } else {
        rawRadii[i] = (rLeft + rRight) * 0.5;
      }
    }

    // 3-tap smoothing filter along vertical scanlines to remove 1-pixel rasterization steps
    const smoothRadii = new Float32Array(rawRadii.length);
    for (let i = 0; i < rawRadii.length; i++) {
      const prev = rawRadii[Math.max(0, i - 1)];
      const curr = rawRadii[i];
      const next = rawRadii[Math.min(rawRadii.length - 1, i + 1)];
      smoothRadii[i] = prev * 0.25 + curr * 0.5 + next * 0.25;
    }

    // Build Three.js Lathe profile points from bottom (v=1 -> y=-H/2) to top (v=0 -> y=+H/2)
    const lathePts: THREE.Vector2[] = [];
    // Close bottom center
    lathePts.push(new THREE.Vector2(0, -worldHeight * 0.5));

    for (let i = smoothRadii.length - 1; i >= 0; i--) {
      const v = prep.scanlines[i].v;
      const y = (0.5 - v) * worldHeight;
      const rWorld = Math.max(0.015, smoothRadii[i] * worldWidth);
      lathePts.push(new THREE.Vector2(rWorld, y));
    }

    if (spec.isHollowVessel) {
      // Trace over the top lip and down the inner cavity wall so mugs/cups/bowls have genuine hollow volume
      const topOuterR = lathePts[lathePts.length - 1].x;
      const wallThick = Math.max(0.018, Math.min(0.055, topOuterR * 0.14));
      const floorY = -worldHeight * 0.5 + Math.max(0.025, worldHeight * 0.08);

      for (let i = 0; i < smoothRadii.length; i++) {
        const v = prep.scanlines[i].v;
        const y = (0.5 - v) * worldHeight;
        if (y <= floorY) break;
        const innerR = Math.max(0.01, smoothRadii[i] * worldWidth - wallThick);
        lathePts.push(new THREE.Vector2(innerR, y));
      }
      lathePts.push(new THREE.Vector2(0, floorY));
    } else {
      // Close top center for solid rotational object
      lathePts.push(new THREE.Vector2(0, worldHeight * 0.5));
    }

    const latheGeom = new THREE.LatheGeometry(lathePts, 48);
    // Offset lathe along X if coreAxisNorm != 0.5 so handle coordinates align seamlessly
    const axisWorldX = (coreAxisNorm - 0.5) * worldWidth;
    latheGeom.translate(axisWorldX, 0, 0);
    latheGeom.computeVertexNormals();
    const nAttr = latheGeom.attributes.normal;
    if (nAttr) {
      for (let i = 0; i < nAttr.count; i++) {
        const nx = nAttr.getX(i);
        const ny = nAttr.getY(i);
        const nz = nAttr.getZ(i);
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-6) {
          nAttr.setXYZ(i, nx / len, ny / len, nz / len);
        } else {
          nAttr.setXYZ(i, 0, i > nAttr.count / 2 ? 1 : -1, 0);
        }
      }
      nAttr.needsUpdate = true;
    }

    const vesselMesh = new THREE.Mesh(latheGeom, primaryMat);
    vesselMesh.name = spec.isHollowVessel ? 'Lathed_Hollow_Vessel' : 'Lathed_Rotational_Body';
    rootGroup.add(vesselMesh);

    if (modeUsed === 'lathe_with_handle') {
      const handleMesh = buildUnilateralHandleMesh(
        prep,
        coreAxisNorm,
        smoothRadii,
        worldWidth,
        worldHeight,
        secondaryMat
      );
      if (handleMesh) {
        rootGroup.add(handleMesh);
        geometrySummary = `Lathed ${spec.isHollowVessel ? 'hollow ' : ''}core profile (48 radial segments) + contour-extruded ${prep.metrics.unilateralAppendageSide} handle`;
      } else {
        modeUsed = 'lathe_rotational';
        geometrySummary = `Lathed ${spec.isHollowVessel ? 'hollow ' : ''}rotational profile (48 radial segments)`;
      }
    } else {
      geometrySummary = `Lathed ${spec.isHollowVessel ? 'hollow ' : ''}rotational profile (48 radial segments)`;
    }
  } else {
    // Mode 2: Contour-Based Volumetric Extrusion (with optional multi-leg structural depth separation)
    const baseSpan = Math.min(worldWidth, worldHeight);
    const totalDepth = Math.max(0.08, Math.min(0.85, baseSpan * spec.depthRatio));

    let builtStructured = false;
    if (
      spec.supportTopology !== 'solid_extrusion' &&
      (prep.metrics.hasBottomLegGap ||
        spec.supportTopology === 'four_leg_frame' ||
        spec.supportTopology === 'three_leg_tripod' ||
        spec.supportTopology === 'pedestal_base')
    ) {
      const structGroup = buildDepthSeparatedSupportGroup(
        prep,
        worldWidth,
        worldHeight,
        totalDepth,
        spec,
        primaryMat,
        secondaryMat
      );
      if (structGroup) {
        rootGroup.add(structGroup);
        builtStructured = true;
        geometrySummary = `Depth-separated contour extrusion (${structGroup.children.length} structural parts, depth ${totalDepth.toFixed(2)} u)`;
      }
    }

    if (!builtStructured) {
      const bevel = Math.min(0.022, totalDepth * 0.08);
      prep.contours.forEach((contour, idx) => {
        const shape = buildShapeFromContour(contour, worldWidth, worldHeight);
        if (!shape) return;
        const compDepth = idx === 0 ? totalDepth : Math.max(0.06, totalDepth * 0.78);
        const extrudeGeom = new THREE.ExtrudeGeometry(shape, {
          steps: 2,
          depth: compDepth,
          bevelEnabled: true,
          bevelThickness: bevel,
          bevelSize: bevel,
          bevelSegments: 3,
          curveSegments: 16,
        });
        extrudeGeom.translate(0, 0, -compDepth * 0.5);
        extrudeGeom.computeVertexNormals();

        const mesh = new THREE.Mesh(extrudeGeom, idx === 0 ? primaryMat : secondaryMat);
        mesh.name = `Contour_Extrusion_${idx + 1}`;
        rootGroup.add(mesh);
      });
      geometrySummary = `Contour-extruded silhouette (${prep.contours.length} contour${prep.contours.length === 1 ? '' : 's'}, ${prep.metrics.holeContourCount} hole${prep.metrics.holeContourCount === 1 ? '' : 's'}, depth ${totalDepth.toFixed(2)} u)`;
    }
  }

  if (rootGroup.children.length === 0) {
    disposeObject3D(rootGroup);
    throw new OfflineReconstructionError(
      'EMPTY_CONTOUR_GEOMETRY',
      'Contour triangulation produced zero valid meshes for this sketch.',
      'Draw a bolder closed outline and try again.'
    );
  }

  // Center X/Z at origin and ground bottom cleanly at Y = 0
  rootGroup.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(rootGroup);
  const center = new THREE.Vector3();
  bbox.getCenter(center);
  rootGroup.position.set(-center.x, -bbox.min.y, -center.z);
  rootGroup.updateMatrixWorld(true);

  const glbBuffer = await exportObjectToGlbBuffer(rootGroup);
  disposeObject3D(rootGroup);

  const { scene: verifiedScene, stats } = await validateAndParseGlbBuffer(glbBuffer);
  disposeObject3D(verifiedScene);

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    glbBuffer,
    stats,
    modeUsed,
    provenanceLabel: OFFLINE_FALLBACK_PROVENANCE_LABEL,
    durationMs: Number((t1 - t0).toFixed(1)),
    geometrySummary,
  };
}

/**
 * Convenience browser helper to run deterministic CV preprocessing + offline 3D contour/lathe reconstruction from a Blob.
 */
export async function reconstructOffline3DFromBlob(
  blob: Blob,
  spec: CompiledReconstructionSpec,
  options?: { illuminationCorrection?: boolean; unrecognizedByVision?: boolean }
): Promise<OfflineReconstructionOutput> {
  const prep = await preprocessSketchBlob(blob, {
    illuminationCorrection: Boolean(options?.illuminationCorrection),
    contrastNormalization: true,
    squareSize: 512,
  });
  return reconstructOffline3DFromPreprocessed(
    prep,
    spec,
    Boolean(options?.unrecognizedByVision)
  );
}
