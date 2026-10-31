import * as THREE from 'three';
import type {
  CompiledReconstructionSpec,
  ContourPolygon2D,
  ReconstructionOptionId,
} from '../../types/studio';
import type { RawPreprocessResult } from '../sketchPreprocessor';

export interface OptionMaterialSet {
  primary: THREE.MeshStandardMaterial;
  secondary: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
}

export interface SketchStructuralMetrics {
  aspectRatio: number;
  worldWidth: number;
  worldHeight: number;
  /** Normalized Y (0=top .. 1=bottom) peaks of strong horizontal stroke bands */
  horizontalPeaksNormV: number[];
  /** Upper third average width [0..1] */
  upperMeanSpan: number;
  /** Middle third average width [0..1] */
  midMeanSpan: number;
  /** Lower third outer span [0..1] */
  lowerOuterSpan: number;
  /** Normalized V where scanline width pinches between upper and lower zones (useful for lamps/goblets) */
  waistNormV: number;
  waistSpan: number;
  /** Handle vertical bounds [0..1] and max lateral protrusion when unilateral appendage is present */
  handleTopV: number;
  handleBottomV: number;
  handleProtrusionNorm: number;
}

/**
 * Extracts deterministic spatial measurements directly from the user's preprocessed 2D sketch pixels.
 */
export function extractSketchStructuralMetrics(prep: RawPreprocessResult): SketchStructuralMetrics {
  const aspectRatio = prep.metrics.measuredAspectRatio || 1;
  const worldWidth = aspectRatio >= 1 ? 1.0 : Math.max(0.32, aspectRatio);
  const worldHeight = aspectRatio >= 1 ? Math.max(0.32, 1.0 / aspectRatio) : 1.0;

  const { croppedStrokeMask, croppedWidth: cw, croppedHeight: ch, scanlines } = prep;

  // 1. Horizontal stroke projection to locate horizontal structural planes (seat, tabletop, shelf tiers)
  const horizontalPeaksNormV: number[] = [];
  if (cw >= 16 && ch >= 16 && croppedStrokeMask.length === cw * ch) {
    const rowScores = new Float32Array(ch);
    for (let y = 0; y < ch; y++) {
      let sum = 0;
      const rowOff = y * cw;
      for (let x = 0; x < cw; x++) {
        sum += croppedStrokeMask[rowOff + x];
      }
      rowScores[y] = sum / cw;
    }

    // Smooth with 5-row window
    const smoothRows = new Float32Array(ch);
    for (let y = 0; y < ch; y++) {
      let acc = 0;
      let cnt = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < ch) {
          acc += rowScores[ny];
          cnt += 1;
        }
      }
      smoothRows[y] = acc / Math.max(1, cnt);
    }

    const minSepRows = Math.max(6, Math.round(ch * 0.11));
    const candidates: Array<{ v: number; score: number }> = [];
    for (let y = 3; y < ch - 3; y++) {
      const s = smoothRows[y];
      if (
        s >= 0.22 &&
        s >= smoothRows[y - 1] &&
        s >= smoothRows[y + 1] &&
        s >= smoothRows[y - 2] &&
        s >= smoothRows[y + 2]
      ) {
        candidates.push({ v: y / (ch - 1), score: s });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const cand of candidates) {
      if (
        horizontalPeaksNormV.every(
          (existing) => Math.abs(existing - cand.v) * ch >= minSepRows
        )
      ) {
        horizontalPeaksNormV.push(Number(cand.v.toFixed(3)));
        if (horizontalPeaksNormV.length >= 6) break;
      }
    }
    horizontalPeaksNormV.sort((a, b) => a - b);
  }

  // 2. Band spans & waist detection from scanlines
  const spanOf = (sl: { left: number; right: number }) =>
    sl.left >= 0 && sl.right >= sl.left ? sl.right - sl.left : 0;

  const upperScans = scanlines.filter((s) => s.v >= 0.08 && s.v <= 0.35 && s.left >= 0);
  const midScans = scanlines.filter((s) => s.v > 0.35 && s.v <= 0.68 && s.left >= 0);
  const lowerScans = scanlines.filter((s) => s.v > 0.68 && s.v <= 0.96 && s.left >= 0);

  const avgSpan = (arr: typeof scanlines, fallback: number) =>
    arr.length > 0 ? arr.reduce((acc, s) => acc + spanOf(s), 0) / arr.length : fallback;

  const upperMeanSpan = Number(avgSpan(upperScans, 0.68).toFixed(3));
  const midMeanSpan = Number(avgSpan(midScans, 0.78).toFixed(3));
  const lowerOuterSpan = Number(avgSpan(lowerScans, 0.74).toFixed(3));

  let waistNormV = 0.52;
  let waistSpan = 1.0;
  for (const sl of scanlines) {
    if (sl.v >= 0.24 && sl.v <= 0.74 && sl.left >= 0) {
      const sp = spanOf(sl);
      if (sp > 0.02 && sp < waistSpan) {
        waistSpan = sp;
        waistNormV = sl.v;
      }
    }
  }
  if (waistSpan > 0.95) waistSpan = midMeanSpan;

  // 3. Handle vertical range when unilateral appendage exists
  let handleTopV = 0.24;
  let handleBottomV = 0.76;
  let handleProtrusionNorm = 0.24;
  const side = prep.metrics.unilateralAppendageSide;
  if (side !== 'none') {
    const rimCenters = scanlines
      .filter((s) => (s.v < 0.2 || s.v > 0.82) && s.left >= 0)
      .map((s) => (s.left + s.right) * 0.5)
      .sort((a, b) => a - b);
    const axis = rimCenters.length > 0 ? rimCenters[Math.floor(rimCenters.length / 2)] : 0.5;
    const handleRows: number[] = [];
    let maxProt = 0.14;
    for (const sl of scanlines) {
      if (sl.left < 0 || sl.v < 0.1 || sl.v > 0.9) continue;
      const rL = Math.max(0, axis - sl.left);
      const rR = Math.max(0, sl.right - axis);
      const diff = side === 'right' ? rR - rL : rL - rR;
      if (diff > 0.09) {
        handleRows.push(sl.v);
        if (diff > maxProt) maxProt = diff;
      }
    }
    if (handleRows.length >= 2) {
      handleTopV = Math.max(0.12, handleRows[0]);
      handleBottomV = Math.min(0.88, handleRows[handleRows.length - 1]);
      handleProtrusionNorm = Math.min(0.45, maxProt);
    }
  }

  return {
    aspectRatio,
    worldWidth,
    worldHeight,
    horizontalPeaksNormV,
    upperMeanSpan,
    midMeanSpan,
    lowerOuterSpan,
    waistNormV: Number(waistNormV.toFixed(3)),
    waistSpan: Number(waistSpan.toFixed(3)),
    handleTopV,
    handleBottomV,
    handleProtrusionNorm,
  };
}

/**
 * Builds calibrated PBR MeshStandardMaterials per option so primary, structural frame,
 * and hardware detail parts exhibit realistic roughness/metalness differentiation in GLB exports.
 */
export function createOptionMaterialSet(
  spec: CompiledReconstructionSpec,
  optionId: ReconstructionOptionId
): OptionMaterialSet {
  const basePrimary = new THREE.Color(spec.primaryHex);
  const baseSecondary = new THREE.Color(spec.secondaryHex);
  const hardwareColor = baseSecondary.clone().lerp(new THREE.Color('#c59b49'), 0.35);

  if (optionId === 'sketch_faithful') {
    const primary = new THREE.MeshStandardMaterial({
      name: 'optA_primary_surface',
      color: basePrimary,
      roughness: Math.min(0.92, Math.max(0.25, spec.roughness + 0.06)),
      metalness: Math.max(0.02, spec.metalness * 0.75),
      transparent: spec.opacity < 0.99,
      opacity: spec.opacity,
    });
    const secondary = new THREE.MeshStandardMaterial({
      name: 'optA_secondary_frame',
      color: basePrimary.clone().lerp(baseSecondary, 0.45),
      roughness: Math.min(0.94, Math.max(0.3, spec.roughness + 0.1)),
      metalness: Math.max(0.04, spec.metalness * 0.7),
    });
    const accent = new THREE.MeshStandardMaterial({
      name: 'optA_detail',
      color: baseSecondary,
      roughness: 0.55,
      metalness: 0.25,
    });
    return { primary, secondary, accent };
  }

  if (optionId === 'structurally_refined') {
    const primary = new THREE.MeshStandardMaterial({
      name: 'optB_primary_body',
      color: basePrimary,
      roughness: spec.roughness,
      metalness: spec.metalness,
      transparent: spec.opacity < 0.99,
      opacity: spec.opacity,
    });
    const secondary = new THREE.MeshStandardMaterial({
      name: 'optB_structural_frame',
      color: baseSecondary,
      roughness: Math.min(0.88, Math.max(0.18, spec.roughness - 0.08)),
      metalness: Math.min(0.85, Math.max(0.12, spec.metalness + 0.14)),
    });
    const accent = new THREE.MeshStandardMaterial({
      name: 'optB_joinery_hardware',
      color: hardwareColor,
      roughness: 0.32,
      metalness: 0.68,
    });
    return { primary, secondary, accent };
  }

  // Option C: Design Enhanced — calibrated multi-surface studio finish
  const primary = new THREE.MeshStandardMaterial({
    name: 'optC_sculpted_primary',
    color: basePrimary,
    roughness: Math.max(0.12, spec.roughness - 0.1),
    metalness: spec.metalness,
    transparent: spec.opacity < 0.99,
    opacity: spec.opacity,
  });
  const secondary = new THREE.MeshStandardMaterial({
    name: 'optC_refined_frame',
    color: baseSecondary.clone().lerp(basePrimary, 0.22),
    roughness: Math.max(0.16, Math.min(0.62, spec.roughness - 0.14)),
    metalness: Math.min(0.88, Math.max(0.14, spec.metalness + 0.16)),
  });
  const accent = new THREE.MeshStandardMaterial({
    name: 'optC_accent_ferrule',
    color: hardwareColor,
    roughness: 0.22,
    metalness: 0.84,
  });
  return { primary, secondary, accent };
}

export function createRoundedRectShape(width: number, depth: number, radius: number): THREE.Shape {
  const hw = Math.max(0.01, width * 0.5);
  const hd = Math.max(0.01, depth * 0.5);
  const r = Math.min(Math.max(0.002, radius), hw * 0.92, hd * 0.92);

  const shape = new THREE.Shape();
  shape.moveTo(-hw + r, -hd);
  shape.lineTo(hw - r, -hd);
  shape.quadraticCurveTo(hw, -hd, hw, -hd + r);
  shape.lineTo(hw, hd - r);
  shape.quadraticCurveTo(hw, hd, hw - r, hd);
  shape.lineTo(-hw + r, hd);
  shape.quadraticCurveTo(-hw, hd, -hw, hd - r);
  shape.lineTo(-hw, -hd + r);
  shape.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  return shape;
}

export function createEllipseShape(
  width: number,
  depth: number,
  segments = 40
): THREE.Shape {
  const rx = Math.max(0.01, width * 0.5);
  const rz = Math.max(0.01, depth * 0.5);
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const x = Math.cos(theta) * rx;
    const y = Math.sin(theta) * rz;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  return shape;
}

/**
 * Builds a horizontal slab centered at (0, 0, 0) spanning X=width, Y=thickness, Z=depth.
 */
export function createBeveledSlabGeometry(
  width: number,
  thickness: number,
  depth: number,
  shapeKind: 'rectangular' | 'rounded_rect' | 'circular' | 'oval' | 'contoured',
  bevelSize: number,
  bevelSegments: number,
  curveSegments = 20
): THREE.BufferGeometry {
  const safeBevel = bevelSegments > 0 ? Math.min(bevelSize, thickness * 0.38) : 0;
  const coreDepth = Math.max(0.008, thickness - safeBevel * 2);
  const insetW = Math.max(0.02, width - safeBevel * 2);
  const insetD = Math.max(0.02, depth - safeBevel * 2);

  let shape: THREE.Shape;
  if (shapeKind === 'circular') {
    const d = (insetW + insetD) * 0.5;
    shape = createEllipseShape(d, d, curveSegments * 2);
  } else if (shapeKind === 'oval') {
    shape = createEllipseShape(insetW, insetD, curveSegments * 2);
  } else {
    const cornerR =
      shapeKind === 'rectangular'
        ? Math.min(insetW, insetD) * 0.04
        : shapeKind === 'contoured'
          ? Math.min(insetW, insetD) * 0.22
          : Math.min(insetW, insetD) * 0.14;
    shape = createRoundedRectShape(insetW, insetD, cornerR);
  }

  const geom = new THREE.ExtrudeGeometry(shape, {
    steps: 1,
    depth: coreDepth,
    bevelEnabled: bevelSegments > 0 && safeBevel > 0.0005,
    bevelThickness: safeBevel,
    bevelSize: safeBevel,
    bevelSegments: Math.max(1, bevelSegments),
    curveSegments,
  });

  // ExtrudeGeometry extrudes along +Z from 0..coreDepth; rotate so thickness is along Y and centered at origin
  geom.translate(0, 0, -coreDepth * 0.5);
  geom.rotateX(Math.PI * 0.5);
  geom.computeVertexNormals();
  return geom;
}

/**
 * Builds an ergonomic contoured waterfall seat cushion extruded along X with rounded front waterfall drop.
 */
export function createWaterfallSeatGeometry(
  width: number,
  thickness: number,
  depth: number,
  bevelSegments = 4
): THREE.BufferGeometry {
  const bevel = Math.min(0.018, thickness * 0.28, width * 0.05);
  const spanX = Math.max(0.04, width - bevel * 2);
  const hz = depth * 0.5;
  const ht = thickness * 0.5;
  const dip = thickness * 0.16;
  const frontDrop = thickness * 0.42;

  // Profile in 2D (u = Z from rear -hz to front +hz, v = Y)
  const profile = new THREE.Shape();
  profile.moveTo(-hz, -ht);
  profile.lineTo(hz - thickness * 0.55, -ht);
  // Front waterfall underside curve
  profile.quadraticCurveTo(hz, -ht - frontDrop * 0.65, hz, -frontDrop * 0.15);
  // Rounded waterfall front nose
  profile.quadraticCurveTo(hz + thickness * 0.18, ht * 0.85, hz - thickness * 0.45, ht);
  // Subtle ergonomic saddle dip across top seat surface back toward rear
  profile.quadraticCurveTo(0, ht - dip, -hz + thickness * 0.25, ht + dip * 0.25);
  profile.quadraticCurveTo(-hz, ht + dip * 0.15, -hz, 0);
  profile.lineTo(-hz, -ht);

  const geom = new THREE.ExtrudeGeometry(profile, {
    steps: 2,
    depth: spanX,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    curveSegments: 20,
  });

  // Profile X->Z, Profile Y->Y, Extrude Z->X: rotate +PI/2 around Y?
  // Wait: if we rotateY(PI/2), old Z becomes +X, old X becomes -Z!
  // Let's center along extrude Z first, then rotateY(-PI/2) so old X (+hz front) becomes +X?
  // Let's verify exact right-hand rule:
  // rotateY(-PI/2): (x, y, z) -> (-z, y, x). So old x (+hz) -> +z (front!), old y -> +y (up!), old z -> -x!
  geom.translate(0, 0, -spanX * 0.5);
  geom.rotateY(-Math.PI * 0.5);
  geom.computeVertexNormals();
  return geom;
}

/**
 * Builds a horizontally curved 3D backrest shell (wrapping gently forward at +/-X edges) centered at origin.
 */
export function createCurvedBackrestGeometry(
  width: number,
  height: number,
  thickness: number,
  curveDepth: number,
  bevelSegments = 3,
  arcSamples = 22
): THREE.BufferGeometry {
  const bevel = Math.min(0.012, thickness * 0.28, height * 0.04);
  const coreH = Math.max(0.04, height - bevel * 2);
  const hw = width * 0.5;
  const ht = thickness * 0.5;

  // Build crescent cross-section in (x, zCurve) and extrude along height
  const shape = new THREE.Shape();
  for (let i = 0; i <= arcSamples; i++) {
    const t = i / arcSamples;
    const u = -1 + 2 * t; // -1 .. +1
    const x = u * hw;
    const zCurve = u * u * curveDepth;
    if (i === 0) shape.moveTo(x, zCurve - ht);
    else shape.lineTo(x, zCurve - ht);
  }
  for (let i = arcSamples; i >= 0; i--) {
    const t = i / arcSamples;
    const u = -1 + 2 * t;
    const x = u * hw;
    const zCurve = u * u * curveDepth;
    shape.lineTo(x, zCurve + ht);
  }
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    steps: 1,
    depth: coreH,
    bevelEnabled: bevelSegments > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: Math.max(1, bevelSegments),
    curveSegments: 16,
  });

  // Extrude is along +Z (0..coreH); rotateX(-PI/2) maps (x, y, z) -> (x, z, -y)
  // Wait: rotateX(-PI/2): y' = z (0..coreH -> up!), z' = -y. If we want +zCurve to point forward (+Z),
  // let's negate zCurve or use rotateX(+PI/2) and center!
  // Let's check rotateX(-PI/2): (x, zCurve, h) -> (x, h, -zCurve). If zCurve > 0 at edges, -zCurve < 0 (curves backward).
  // We want edges (u = ±1) to wrap FORWARD (+Z)! So we want z' > 0 at edges -> rotateX(+PI/2) maps (x, zCurve, h) -> (x, -h, +zCurve)!
  geom.translate(0, 0, -coreH * 0.5);
  geom.rotateX(Math.PI * 0.5);
  geom.computeVertexNormals();
  return geom;
}

const _upAxis = new THREE.Vector3(0, 1, 0);

/**
 * Creates a cylinder or square timber strut rigidly connecting exact 3D points pStart -> pEnd (zero floating gaps).
 */
export function createAnchoredStrutMesh(
  pStart: THREE.Vector3,
  pEnd: THREE.Vector3,
  radiusStart: number,
  radiusEnd: number,
  radialSegments: number,
  squareCrossSection: boolean,
  material: THREE.Material,
  name: string
): THREE.Mesh {
  const delta = new THREE.Vector3().subVectors(pEnd, pStart);
  const length = Math.max(0.005, delta.length());
  const mid = new THREE.Vector3().addVectors(pStart, pEnd).multiplyScalar(0.5);

  let geom: THREE.BufferGeometry;
  if (squareCrossSection) {
    // 4-sided tapered cylinder rotated 45 deg gives a clean tapered square timber leg!
    geom = new THREE.CylinderGeometry(
      radiusEnd * Math.SQRT2,
      radiusStart * Math.SQRT2,
      length,
      4,
      1,
      false
    );
    geom.rotateY(Math.PI * 0.25);
    geom.computeVertexNormals();
  } else {
    geom = new THREE.CylinderGeometry(radiusEnd, radiusStart, length, radialSegments, 1, false);
  }

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = name;
  mesh.position.copy(mid);

  const dir = delta.normalize();
  if (Math.abs(dir.dot(_upAxis)) > 0.9999) {
    if (dir.y < 0) mesh.rotation.z = Math.PI;
  } else {
    mesh.quaternion.setFromUnitVectors(_upAxis, dir);
  }
  return mesh;
}

/**
 * Converts a normalized [0..1] 2D contour polygon (with optional interior holes) into a Three.js Shape.
 */
export function buildCenteredContourShape(
  contour: ContourPolygon2D,
  worldWidth: number,
  worldHeight: number
): THREE.Shape | null {
  if (contour.points.length < 3) return null;

  const signedArea = (pts: Array<[number, number]>) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    return a * 0.5;
  };

  const mapPts = (normPts: Array<[number, number]>, ccw: boolean): THREE.Vector2[] => {
    const mapped: Array<[number, number]> = normPts.map(([u, v]) => [
      (u - 0.5) * worldWidth,
      (0.5 - v) * worldHeight,
    ]);
    const area = signedArea(mapped);
    if ((ccw && area < 0) || (!ccw && area > 0)) {
      mapped.reverse();
    }
    return mapped.map(([x, y]) => new THREE.Vector2(x, y));
  };

  const outer = mapPts(contour.points, true);
  if (outer.length < 3) return null;
  const shape = new THREE.Shape(outer);

  for (const h of contour.holes) {
    if (h.length >= 3) {
      const holePts = mapPts(h, false);
      if (holePts.length >= 3) {
        shape.holes.push(new THREE.Path(holePts));
      }
    }
  }
  return shape;
}

/**
 * Centers X/Z at origin and grounds the minimum Y of the assembly cleanly at Y = 0.
 */
export function groundAndCenterGroup(group: THREE.Group): string[] {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  if (!box.isEmpty()) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    group.position.set(-center.x, -box.min.y, -center.z);
    group.updateMatrixWorld(true);
  }
  const names: string[] = [];
  group.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && obj.name) {
      names.push(obj.name);
    }
  });
  return names;
}
