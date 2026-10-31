import * as THREE from 'three';
import type {
  CompiledReconstructionSpec,
  ReconstructionOptionId,
  StructuralBlueprint,
} from '../../types/studio';
import type { RawPreprocessResult } from '../sketchPreprocessor';
import type { BuiltCategoryModel } from './chairBuilder';
import {
  createOptionMaterialSet,
  extractSketchStructuralMetrics,
  groundAndCenterGroup,
} from './sharedGeometry';

/**
 * Modular 3D Vessel / Mug / Cup / Vase / Bottle Reconstructor.
 * Uses measured 2D scanline radii for rotational lathing + hollow interior wall thickness +
 * ceramic foot ring + genuine 3D swept TubeGeometry handle when a side handle is present.
 */
export function buildVesselModel(
  prep: RawPreprocessResult,
  blueprint: StructuralBlueprint,
  spec: CompiledReconstructionSpec,
  optionId: ReconstructionOptionId
): BuiltCategoryModel {
  const sm = extractSketchStructuralMetrics(prep);
  const mats = createOptionMaterialSet(spec, optionId);

  const group = new THREE.Group();
  group.name = `Vessel_${optionId}`;

  const worldWidth = sm.worldWidth;
  const worldHeight = sm.worldHeight;

  const hasHandle =
    blueprint.has_side_handle || prep.metrics.unilateralAppendageSide !== 'none';
  const handleSide: 'left' | 'right' =
    prep.metrics.unilateralAppendageSide === 'left' || blueprint.handle_side === 'left'
      ? 'left'
      : 'right';

  // Determine symmetric vessel core axis excluding unilateral handle
  const validScans = prep.scanlines.filter((s) => s.left >= 0 && s.right >= 0);
  const rimCenters = validScans
    .filter((s) => s.v < 0.2 || s.v > 0.82)
    .map((s) => (s.left + s.right) * 0.5)
    .sort((a, b) => a - b);
  const coreAxisNorm =
    rimCenters.length > 0 ? rimCenters[Math.floor(rimCenters.length / 2)] : 0.5;

  const nScans = prep.scanlines.length;
  const rawRadii = new Float32Array(nScans);
  for (let i = 0; i < nScans; i++) {
    const sl = prep.scanlines[i];
    if (sl.left < 0 || sl.right < 0) {
      rawRadii[i] = i > 0 ? rawRadii[i - 1] : 0.25;
      continue;
    }
    const rLeft = Math.max(0.03, coreAxisNorm - sl.left);
    const rRight = Math.max(0.03, sl.right - coreAxisNorm);
    if (hasHandle) {
      rawRadii[i] = handleSide === 'right' ? rLeft : rRight;
    } else {
      rawRadii[i] = (rLeft + rRight) * 0.5;
    }
  }

  // Smooth scanlines according to option fidelity vs design fairing
  const smoothPasses = optionId === 'sketch_faithful' ? 1 : optionId === 'structurally_refined' ? 2 : 5;
  let radii = rawRadii;
  for (let p = 0; p < smoothPasses; p++) {
    const next = new Float32Array(nScans);
    for (let i = 0; i < nScans; i++) {
      const a = radii[Math.max(0, i - 1)];
      const b = radii[i];
      const c = radii[Math.min(nScans - 1, i + 1)];
      next[i] = a * 0.25 + b * 0.5 + c * 0.25;
    }
    radii = next;
  }

  const footHeight = optionId === 'sketch_faithful' ? 0 : Math.max(0.018, worldHeight * 0.035);
  const isHollow = spec.isHollowVessel || blueprint.is_hollow_open_top;
  const radialSegs = optionId === 'sketch_faithful' ? 32 : optionId === 'structurally_refined' ? 48 : 64;

  // Build Lathe profile from bottom (y = -worldHeight/2 + footHeight) to top (y = +worldHeight/2)
  const lathePts: THREE.Vector2[] = [];
  lathePts.push(new THREE.Vector2(0, -worldHeight * 0.5 + footHeight));

  for (let i = nScans - 1; i >= 0; i--) {
    const v = prep.scanlines[i]?.v ?? i / Math.max(1, nScans - 1);
    const y = THREE.MathUtils.lerp(worldHeight * 0.5, -worldHeight * 0.5 + footHeight, v);
    const rWorld = Math.max(0.025, radii[i] * worldWidth);
    lathePts.push(new THREE.Vector2(rWorld, y));
  }

  const topOuterR = lathePts[lathePts.length - 1].x;
  const wallThick = Math.max(
    0.018,
    Math.min(0.055, topOuterR * (optionId === 'structurally_refined' ? 0.15 : 0.13))
  );

  if (isHollow) {
    // Rolled lip bead on Option C / beveled lip on Option B
    if (optionId === 'design_enhanced') {
      const topY = worldHeight * 0.5;
      lathePts.push(new THREE.Vector2(topOuterR + wallThick * 0.18, topY + wallThick * 0.28));
      lathePts.push(new THREE.Vector2(topOuterR - wallThick * 0.45, topY + wallThick * 0.42));
      lathePts.push(new THREE.Vector2(Math.max(0.012, topOuterR - wallThick), topY));
    } else if (optionId === 'structurally_refined') {
      const topY = worldHeight * 0.5;
      lathePts.push(new THREE.Vector2(topOuterR - wallThick * 0.5, topY + wallThick * 0.2));
      lathePts.push(new THREE.Vector2(Math.max(0.012, topOuterR - wallThick), topY));
    }

    const cavityFloorY = -worldHeight * 0.5 + footHeight + Math.max(0.03, worldHeight * 0.085);
    for (let i = 0; i < nScans; i++) {
      const v = prep.scanlines[i]?.v ?? i / Math.max(1, nScans - 1);
      const y = THREE.MathUtils.lerp(worldHeight * 0.5, -worldHeight * 0.5 + footHeight, v);
      if (y <= cavityFloorY) break;
      const innerR = Math.max(0.012, radii[i] * worldWidth - wallThick);
      lathePts.push(new THREE.Vector2(innerR, y));
    }
    lathePts.push(new THREE.Vector2(0, cavityFloorY));
  } else {
    lathePts.push(new THREE.Vector2(0, worldHeight * 0.5));
  }

  const vesselGeom = new THREE.LatheGeometry(lathePts, radialSegs);
  vesselGeom.computeVertexNormals();
  // Sanitize pole normals
  const nAttr = vesselGeom.attributes.normal;
  if (nAttr) {
    for (let i = 0; i < nAttr.count; i++) {
      const nx = nAttr.getX(i);
      const ny = nAttr.getY(i);
      const nz = nAttr.getZ(i);
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-6) {
        nAttr.setXYZ(i, nx / len, ny / len, nz / len);
      } else {
        nAttr.setXYZ(i, 0, 1, 0);
      }
    }
    nAttr.needsUpdate = true;
  }

  const vesselMesh = new THREE.Mesh(vesselGeom, mats.primary);
  vesselMesh.name = isHollow ? 'Lathed_Hollow_Vessel_Body' : 'Lathed_Solid_Vessel_Body';
  group.add(vesselMesh);

  // Separate ceramic foot ring on Option B & Option C
  if (footHeight > 0) {
    const baseOuterR = Math.max(0.04, radii[nScans - 1] * worldWidth * 0.88);
    const footPts = [
      new THREE.Vector2(Math.max(0.02, baseOuterR * 0.72), -worldHeight * 0.5 + footHeight + 0.005),
      new THREE.Vector2(Math.max(0.02, baseOuterR * 0.76), -worldHeight * 0.5),
      new THREE.Vector2(baseOuterR, -worldHeight * 0.5),
      new THREE.Vector2(baseOuterR * 1.03, -worldHeight * 0.5 + footHeight + 0.005),
    ];
    const footGeom = new THREE.LatheGeometry(footPts, radialSegs);
    footGeom.computeVertexNormals();
    footGeom.normalizeNormals();
    const footMesh = new THREE.Mesh(
      footGeom,
      optionId === 'design_enhanced' ? mats.secondary : mats.primary
    );
    footMesh.name = 'Vessel_Foot_Ring';
    group.add(footMesh);
  }

  // Rim accent band on Option C
  if (optionId === 'design_enhanced' && isHollow) {
    const rimGeom = new THREE.TorusGeometry(
      topOuterR - wallThick * 0.35,
      wallThick * 0.24,
      14,
      radialSegs
    );
    rimGeom.normalizeNormals();
    const rimTorus = new THREE.Mesh(rimGeom, mats.accent);
    rimTorus.rotation.x = Math.PI * 0.5;
    rimTorus.position.set(0, worldHeight * 0.5 + wallThick * 0.16, 0);
    rimTorus.name = 'Vessel_Glazed_Rim_Band';
    group.add(rimTorus);
  }

  // Genuine 3D Swept Ergonomic Handle when side handle exists
  if (hasHandle) {
    const sign = handleSide === 'left' ? -1 : 1;
    const vTop = sm.handleTopV;
    const vBot = sm.handleBottomV;
    const yTop = THREE.MathUtils.lerp(worldHeight * 0.45, -worldHeight * 0.45, vTop);
    const yBot = THREE.MathUtils.lerp(worldHeight * 0.45, -worldHeight * 0.45, vBot);
    const yMid = (yTop + yBot) * 0.5;

    const topIdx = Math.min(nScans - 1, Math.max(0, Math.round(vTop * (nScans - 1))));
    const botIdx = Math.min(nScans - 1, Math.max(0, Math.round(vBot * (nScans - 1))));
    const rWallTop = Math.max(0.03, radii[topIdx] * worldWidth - wallThick * 0.35);
    const rWallBot = Math.max(0.03, radii[botIdx] * worldWidth - wallThick * 0.35);
    const rWallMax = Math.max(rWallTop, rWallBot);
    const outSpan = Math.max(0.11, sm.handleProtrusionNorm * worldWidth * 1.05);

    const handleCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sign * rWallTop, yTop, 0),
      new THREE.Vector3(sign * (rWallMax + outSpan * 0.78), yTop + (yTop - yBot) * 0.06, 0),
      new THREE.Vector3(sign * (rWallMax + outSpan), yMid + (yTop - yBot) * 0.08, 0),
      new THREE.Vector3(sign * (rWallMax + outSpan * 0.86), yBot + (yTop - yBot) * 0.14, 0),
      new THREE.Vector3(sign * rWallBot, yBot, 0),
    ]);

    const tubeR = Math.max(0.018, Math.min(0.038, worldWidth * 0.042));
    const handleGeom = new THREE.TubeGeometry(
      handleCurve,
      optionId === 'design_enhanced' ? 44 : 28,
      tubeR,
      optionId === 'sketch_faithful' ? 10 : 18,
      false
    );
    if (optionId === 'design_enhanced') {
      // Slightly flatten Z vs XY for an ergonomic strap-like pottery handle feel
      handleGeom.scale(1, 1, 1.28);
      handleGeom.computeVertexNormals();
    }
    handleGeom.normalizeNormals();
    const handleMesh = new THREE.Mesh(
      handleGeom,
      optionId === 'sketch_faithful' ? mats.primary : mats.secondary
    );
    handleMesh.name = 'Vessel_Swept_Handle';
    group.add(handleMesh);

    if (optionId === 'structurally_refined' || optionId === 'design_enhanced') {
      for (const [bossName, bx, by] of [
        ['Handle_Upper_Boss', sign * (rWallTop + 0.008), yTop],
        ['Handle_Lower_Boss', sign * (rWallBot + 0.008), yBot],
      ] as const) {
        const boss = new THREE.Mesh(
          new THREE.CylinderGeometry(tubeR * 1.15, tubeR * 1.45, 0.026, 16),
          mats.secondary
        );
        boss.rotation.z = -sign * Math.PI * 0.5;
        boss.position.set(bx, by, 0);
        boss.name = bossName;
        group.add(boss);
      }
    }
  }

  const componentNames = groundAndCenterGroup(group);
  const geometrySummary = `Vessel Lathe Synthesis (${radialSegs} radial segments${
    isHollow ? ', hollow interior wall' : ''
  }${hasHandle ? `, swept 3D ${handleSide} handle` : ''})`;

  return { group, componentNames, geometrySummary };
}
