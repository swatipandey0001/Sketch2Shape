import * as THREE from 'three';
import type {
  CompiledReconstructionSpec,
  ReconstructionOptionId,
  StructuralBlueprint,
} from '../../types/studio';
import type { RawPreprocessResult } from '../sketchPreprocessor';
import type { BuiltCategoryModel } from './chairBuilder';
import {
  createAnchoredStrutMesh,
  createOptionMaterialSet,
  extractSketchStructuralMetrics,
  groundAndCenterGroup,
} from './sharedGeometry';

/**
 * Modular 3D Lamp / Lighting Reconstructor.
 * Decomposes lamp sketches into physically connected 3D components:
 * - Weighted turned base grounded at Y = 0
 * - Central vertical column / stem + neck collar
 * - Bulb socket housing + frosted diffuser bulb
 * - 3-strut spider harp assembly rigidly connecting the central stem to the inner shade wall (no floating shades)
 * - Hollow double-walled diffuser lampshade (conical, drum, dome, or bell)
 */
export function buildLampModel(
  prep: RawPreprocessResult,
  blueprint: StructuralBlueprint,
  spec: CompiledReconstructionSpec,
  optionId: ReconstructionOptionId
): BuiltCategoryModel {
  const sm = extractSketchStructuralMetrics(prep);
  const mats = createOptionMaterialSet(spec, optionId);

  const group = new THREE.Group();
  group.name = `Lamp_${optionId}`;

  const totalHeight = 1.0;
  const maxSpanWorld = THREE.MathUtils.clamp(sm.worldWidth, 0.36, 0.96);
  const latheSegments =
    optionId === 'sketch_faithful' ? 32 : optionId === 'structurally_refined' ? 48 : 64;

  // Calibrate vertical zones from measured scanline waist and upper/lower spans
  const shadeBottomNormV = THREE.MathUtils.clamp(sm.waistNormV, 0.28, 0.54);
  const shadeHeight = THREE.MathUtils.clamp(shadeBottomNormV * totalHeight, 0.24, 0.46);
  const shadeTopY = totalHeight - (optionId === 'design_enhanced' ? 0.035 : 0.01);
  const shadeBottomY = Math.max(0.42, shadeTopY - shadeHeight);

  const shadeOuterBottomR = THREE.MathUtils.clamp(
    maxSpanWorld * Math.max(0.38, sm.upperMeanSpan * 0.56),
    0.16,
    0.46
  );

  const shadeProfile = blueprint.shade_profile !== 'none' ? blueprint.shade_profile : 'conical';
  let shadeOuterTopR = shadeOuterBottomR * 0.62;
  if (shadeProfile === 'drum') {
    shadeOuterTopR = shadeOuterBottomR * 0.94;
  } else if (shadeProfile === 'dome') {
    shadeOuterTopR = shadeOuterBottomR * 0.22;
  } else if (shadeProfile === 'bell') {
    shadeOuterTopR = shadeOuterBottomR * 0.48;
  }

  const baseRadius = THREE.MathUtils.clamp(
    maxSpanWorld * Math.max(0.24, sm.lowerOuterSpan * 0.42),
    0.11,
    shadeOuterBottomR * 0.86
  );
  const baseHeight = THREE.MathUtils.clamp(totalHeight * 0.11, 0.065, 0.15);
  const stemRadius = THREE.MathUtils.clamp(
    Math.min(baseRadius * 0.22, maxSpanWorld * Math.max(0.04, sm.waistSpan * 0.14)),
    0.018,
    0.045
  );

  // 1. Weighted Turned Base (LatheGeometry)
  const basePts: THREE.Vector2[] = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(baseRadius * 0.98, 0),
    new THREE.Vector2(baseRadius, baseHeight * 0.22),
  ];
  if (optionId === 'design_enhanced') {
    basePts.push(
      new THREE.Vector2(baseRadius * 0.94, baseHeight * 0.58),
      new THREE.Vector2(baseRadius * 0.62, baseHeight * 0.86),
      new THREE.Vector2(stemRadius * 1.45, baseHeight)
    );
  } else {
    basePts.push(
      new THREE.Vector2(baseRadius * 0.88, baseHeight * 0.78),
      new THREE.Vector2(stemRadius * 1.35, baseHeight)
    );
  }
  basePts.push(new THREE.Vector2(0, baseHeight));

  const sanitizeNormals = (geom: THREE.BufferGeometry) => {
    const nAttr = geom.attributes.normal;
    if (!nAttr) return;
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
  };

  const baseGeom = new THREE.LatheGeometry(basePts, latheSegments);
  baseGeom.computeVertexNormals();
  sanitizeNormals(baseGeom);
  const baseMesh = new THREE.Mesh(baseGeom, mats.secondary);
  baseMesh.name = 'Lamp_Weighted_Base';
  group.add(baseMesh);

  // 2. Central Stem / Column connecting Base to Socket
  const socketBottomY = shadeBottomY + shadeHeight * 0.18;
  const stemStart = new THREE.Vector3(0, baseHeight * 0.92, 0);
  const stemEnd = new THREE.Vector3(0, socketBottomY, 0);
  const stemMesh = createAnchoredStrutMesh(
    stemStart,
    stemEnd,
    stemRadius * (optionId === 'design_enhanced' ? 1.18 : 1.05),
    stemRadius * 0.88,
    optionId === 'sketch_faithful' ? 16 : 28,
    false,
    mats.secondary,
    'Lamp_Central_Stem'
  );
  group.add(stemMesh);

  // Neck Collar at stem top
  const collarH = 0.026;
  const collarGeom = new THREE.CylinderGeometry(
    stemRadius * 1.35,
    stemRadius * 1.15,
    collarH,
    24
  );
  const collarMesh = new THREE.Mesh(collarGeom, mats.accent);
  collarMesh.name = 'Lamp_Neck_Collar';
  collarMesh.position.set(0, socketBottomY, 0);
  group.add(collarMesh);

  // 3. Socket Housing + Diffuser Bulb
  const socketH = 0.068;
  const socketR = Math.max(stemRadius * 1.45, 0.028);
  const socketCenterY = socketBottomY + socketH * 0.5;
  const socketGeom = new THREE.CylinderGeometry(socketR, socketR * 0.92, socketH, 24);
  const socketMesh = new THREE.Mesh(socketGeom, mats.accent);
  socketMesh.name = 'Lamp_Bulb_Socket';
  socketMesh.position.set(0, socketCenterY, 0);
  group.add(socketMesh);

  if (optionId !== 'sketch_faithful') {
    const bulbR = Math.min(shadeOuterTopR * 0.42, socketR * 1.65);
    const bulbMat = new THREE.MeshStandardMaterial({
      name: 'lamp_frosted_bulb',
      color: new THREE.Color('#fffbeb'),
      emissive: new THREE.Color('#fde68a'),
      emissiveIntensity: optionId === 'design_enhanced' ? 0.35 : 0.2,
      roughness: 0.28,
      metalness: 0.02,
    });
    const bulbGeom = new THREE.SphereGeometry(bulbR, 24, 18);
    const bulbMesh = new THREE.Mesh(bulbGeom, bulbMat);
    bulbMesh.name = 'Lamp_Diffuser_Bulb';
    bulbMesh.position.set(0, socketBottomY + socketH + bulbR * 0.68, 0);
    group.add(bulbMesh);
  }

  // 4. Hollow Double-Walled Lampshade (LatheGeometry closed wall loop)
  const wallThick = optionId === 'sketch_faithful' ? 0.009 : 0.012;
  const curveSteps = 14;
  const outerWall: Array<[number, number]> = [];
  for (let i = 0; i <= curveSteps; i++) {
    const t = i / curveSteps; // 0 = bottom, 1 = top
    const y = THREE.MathUtils.lerp(shadeBottomY, shadeTopY, t);
    let r = THREE.MathUtils.lerp(shadeOuterBottomR, shadeOuterTopR, t);
    if (shadeProfile === 'dome') {
      r = shadeOuterBottomR * Math.cos(t * Math.PI * 0.44);
    } else if (shadeProfile === 'bell') {
      const flare = Math.pow(1 - t, 1.65);
      r = shadeOuterTopR + (shadeOuterBottomR - shadeOuterTopR) * flare;
    }
    outerWall.push([Math.max(0.035, r), y]);
  }

  const shadeLathePts: THREE.Vector2[] = [];
  // Outer curve from bottom to top
  for (const [r, y] of outerWall) {
    shadeLathePts.push(new THREE.Vector2(r, y));
  }
  // Inner curve from top back to bottom for genuine wall thickness
  for (let i = outerWall.length - 1; i >= 0; i--) {
    const [r, y] = outerWall[i];
    shadeLathePts.push(new THREE.Vector2(Math.max(0.025, r - wallThick), y));
  }
  // Close bottom lip
  shadeLathePts.push(new THREE.Vector2(outerWall[0][0], outerWall[0][1]));

  const shadeGeom = new THREE.LatheGeometry(shadeLathePts, latheSegments);
  shadeGeom.computeVertexNormals();
  sanitizeNormals(shadeGeom);
  const shadeMesh = new THREE.Mesh(shadeGeom, mats.primary);
  shadeMesh.name = 'Lamp_Diffuser_Shade';
  group.add(shadeMesh);

  // 5. Physical Spider / Harp Struts anchoring central hub to inner shade wall
  // (Ensures lampshade is structurally supported rather than floating in space!)
  const spiderAttachT = 0.68;
  const spiderIdx = Math.min(
    outerWall.length - 1,
    Math.max(1, Math.round(spiderAttachT * curveSteps))
  );
  const spiderInnerR = Math.max(0.03, outerWall[spiderIdx][0] - wallThick * 0.85);
  const spiderAttachY = outerWall[spiderIdx][1];
  const hubY =
    optionId === 'sketch_faithful'
      ? spiderAttachY
      : socketBottomY + socketH * 0.55;

  const spiderHubGeom = new THREE.CylinderGeometry(
    socketR * 1.15,
    socketR * 1.15,
    0.016,
    20
  );
  const spiderHubMesh = new THREE.Mesh(spiderHubGeom, mats.accent);
  spiderHubMesh.name = 'Lamp_Spider_Hub';
  spiderHubMesh.position.set(0, hubY, 0);
  group.add(spiderHubMesh);

  const strutCount = 3;
  const strutR = optionId === 'sketch_faithful' ? 0.0045 : 0.0055;
  for (let i = 0; i < strutCount; i++) {
    const angle = (i / strutCount) * Math.PI * 2;
    const pHub = new THREE.Vector3(
      Math.cos(angle) * socketR * 0.95,
      hubY,
      Math.sin(angle) * socketR * 0.95
    );
    const pRim = new THREE.Vector3(
      Math.cos(angle) * spiderInnerR,
      spiderAttachY,
      Math.sin(angle) * spiderInnerR
    );
    const strut = createAnchoredStrutMesh(
      pHub,
      pRim,
      strutR,
      strutR,
      10,
      false,
      mats.accent,
      `Lamp_Spider_Strut_${i + 1}`
    );
    group.add(strut);
  }

  // 6. Option C Design-Enhanced Finial & Rolled Shade Trim Rings
  if (optionId === 'design_enhanced') {
    const finialRacerStart = new THREE.Vector3(0, hubY, 0);
    const finialTopY = shadeTopY + 0.032;
    const riser = createAnchoredStrutMesh(
      finialRacerStart,
      new THREE.Vector3(0, finialTopY - 0.012, 0),
      0.005,
      0.004,
      12,
      false,
      mats.accent,
      'Lamp_Harp_Riser'
    );
    group.add(riser);

    const finialGeom = new THREE.SphereGeometry(0.016, 20, 16);
    const finialMesh = new THREE.Mesh(finialGeom, mats.accent);
    finialMesh.name = 'Lamp_Finial_Cap';
    finialMesh.position.set(0, finialTopY, 0);
    group.add(finialMesh);

    const bottomRingGeom = new THREE.TorusGeometry(
      outerWall[0][0] - wallThick * 0.5,
      wallThick * 0.58,
      12,
      latheSegments
    );
    bottomRingGeom.rotateX(Math.PI * 0.5);
    bottomRingGeom.normalizeNormals();
    const bottomRing = new THREE.Mesh(bottomRingGeom, mats.accent);
    bottomRing.name = 'Lamp_Shade_Trim_Ring';
    bottomRing.position.set(0, shadeBottomY, 0);
    group.add(bottomRing);
  }

  const componentNames = groundAndCenterGroup(group);
  const geometrySummary = `Modular 3D lamp (${shadeProfile} hollow shade, turned base Ø${(baseRadius * 2).toFixed(2)}u, central stem, 3-strut spider support)`;

  return {
    group,
    componentNames,
    geometrySummary,
  };
}
