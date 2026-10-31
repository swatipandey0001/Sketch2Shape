import * as THREE from 'three';
import type {
  CompiledReconstructionSpec,
  ReconstructionOptionId,
  StructuralBlueprint,
} from '../../types/studio';
import type { RawPreprocessResult } from '../sketchPreprocessor';
import type { BuiltCategoryModel } from './chairBuilder';
import {
  buildCenteredContourShape,
  createBeveledSlabGeometry,
  createOptionMaterialSet,
  extractSketchStructuralMetrics,
  groundAndCenterGroup,
} from './sharedGeometry';

/**
 * Modular 3D Mechanical / CAD Bracket & Plate Reconstructor.
 * Preserves multi-contour plate geometry and interior bolt/cutout holes directly from the user's sketch,
 * and adds raised machined mounting hole bosses, structural stiffener ribs, and CNC chamfers in Options B & C.
 */
export function buildBracketModel(
  prep: RawPreprocessResult,
  blueprint: StructuralBlueprint,
  spec: CompiledReconstructionSpec,
  optionId: ReconstructionOptionId
): BuiltCategoryModel {
  const sm = extractSketchStructuralMetrics(prep);
  const mats = createOptionMaterialSet(spec, optionId);

  const group = new THREE.Group();
  group.name = `Bracket_${optionId}`;

  const worldW = sm.worldWidth;
  const worldH = sm.worldHeight;
  const plateDepth = THREE.MathUtils.clamp(
    Math.min(worldW, worldH) * Math.max(0.14, Math.min(0.36, spec.depthRatio * 0.52)),
    0.08,
    0.26
  );

  const bevelSegs =
    optionId === 'sketch_faithful' ? 1 : optionId === 'structurally_refined' ? 2 : 4;
  const bevelSize =
    optionId === 'sketch_faithful'
      ? Math.min(0.004, plateDepth * 0.08)
      : optionId === 'structurally_refined'
        ? Math.min(0.008, plateDepth * 0.14)
        : Math.min(0.014, plateDepth * 0.22);

  const usableContours = prep.contours.filter((c) => c.points.length >= 3);
  let totalHolesBuilt = 0;

  if (usableContours.length > 0) {
    usableContours.forEach((contour, idx) => {
      const shape = buildCenteredContourShape(contour, worldW, worldH);
      if (!shape) return;

      const coreDepth = Math.max(0.02, plateDepth - bevelSize * 2);
      const geom = new THREE.ExtrudeGeometry(shape, {
        steps: 1,
        depth: coreDepth,
        bevelEnabled: true,
        bevelThickness: bevelSize,
        bevelSize,
        bevelSegments: bevelSegs,
        curveSegments: 16,
      });
      geom.translate(0, 0, -coreDepth * 0.5);
      geom.computeVertexNormals();

      const plateMesh = new THREE.Mesh(geom, mats.primary);
      plateMesh.name = `Bracket_Machined_Plate_${idx + 1}`;
      group.add(plateMesh);

      // Extract interior holes to build machined mounting bosses / counterbore collars in Options B & C
      contour.holes.forEach((holePts, hIdx) => {
        if (holePts.length < 3) return;
        totalHolesBuilt += 1;

        if (optionId === 'sketch_faithful') return;

        // Compute hole center and average radius in world space
        let sumX = 0;
        let sumY = 0;
        for (const [u, v] of holePts) {
          sumX += (u - 0.5) * worldW;
          sumY += (0.5 - v) * worldH;
        }
        const cx = sumX / holePts.length;
        const cy = sumY / holePts.length;

        let sumR = 0;
        for (const [u, v] of holePts) {
          const px = (u - 0.5) * worldW - cx;
          const py = (0.5 - v) * worldH - cy;
          sumR += Math.hypot(px, py);
        }
        const innerR = Math.max(0.014, sumR / holePts.length);
        const outerR = innerR * (optionId === 'design_enhanced' ? 1.52 : 1.38);
        const bossDepth = plateDepth + (optionId === 'design_enhanced' ? 0.036 : 0.024);

        // Hollow cylindrical boss ring via Shape + Hole Extrude
        const bossShape = new THREE.Shape();
        bossShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
        const boreHole = new THREE.Path();
        boreHole.absarc(0, 0, innerR * 1.02, 0, Math.PI * 2, true);
        bossShape.holes.push(boreHole);

        const bossBevel = optionId === 'design_enhanced' ? 0.004 : 0.002;
        const bossGeom = new THREE.ExtrudeGeometry(bossShape, {
          steps: 1,
          depth: bossDepth - bossBevel * 2,
          bevelEnabled: true,
          bevelThickness: bossBevel,
          bevelSize: bossBevel,
          bevelSegments: optionId === 'design_enhanced' ? 3 : 1,
          curveSegments: 24,
        });
        bossGeom.translate(0, 0, -(bossDepth - bossBevel * 2) * 0.5);
        bossGeom.computeVertexNormals();

        const bossMesh = new THREE.Mesh(bossGeom, mats.accent);
        bossMesh.name = `Bracket_Mounting_Boss_${idx + 1}_${hIdx + 1}`;
        bossMesh.position.set(cx, cy, 0);
        group.add(bossMesh);
      });
    });
  } else {
    // Fallback precision plate if contour simplification yielded zero polygons
    const slab = createBeveledSlabGeometry(
      worldW,
      plateDepth,
      worldH,
      'rounded_rect',
      bevelSize,
      bevelSegs
    );
    slab.rotateX(Math.PI * 0.5);
    const mesh = new THREE.Mesh(slab, mats.primary);
    mesh.name = 'Bracket_Machined_Plate_1';
    group.add(mesh);
  }

  // Option B & C: Add perpendicular base mounting flange + triangular gusset web so bracket stands self-supporting
  if (optionId !== 'sketch_faithful') {
    const flangeDepth = Math.max(0.18, Math.min(0.42, worldH * 0.44 * (blueprint.depth_to_width_ratio || 0.7)));
    const flangeThick = Math.max(0.024, plateDepth * 0.78);
    const flangeWidth = worldW * 0.88;
    const plateBottomY = -worldH * 0.5 + flangeThick * 0.5;

    const flangeGeom = createBeveledSlabGeometry(
      flangeWidth,
      flangeThick,
      flangeDepth,
      optionId === 'design_enhanced' ? 'rounded_rect' : 'rectangular',
      bevelSize * 0.7,
      bevelSegs
    );
    const flangeMesh = new THREE.Mesh(flangeGeom, mats.secondary);
    flangeMesh.name = 'Bracket_Base_Flange';
    flangeMesh.position.set(0, plateBottomY, -flangeDepth * 0.5 + plateDepth * 0.35);
    group.add(flangeMesh);

    // Triangular gusset ribs stiffening the 90-degree joint
    const gussetLen = flangeDepth * 0.68;
    const gussetH = Math.min(worldH * 0.42, gussetLen * 1.15);
    const gussetThick = Math.max(0.016, plateDepth * 0.42);

    const gussetShape = new THREE.Shape();
    gussetShape.moveTo(0, 0);
    gussetShape.lineTo(-gussetLen, 0);
    gussetShape.lineTo(0, gussetH);
    gussetShape.closePath();

    const gussetGeom = new THREE.ExtrudeGeometry(gussetShape, {
      steps: 1,
      depth: gussetThick,
      bevelEnabled: optionId === 'design_enhanced',
      bevelThickness: 0.0025,
      bevelSize: 0.0025,
      bevelSegments: 2,
    });
    gussetGeom.translate(0, 0, -gussetThick * 0.5);
    gussetGeom.rotateY(Math.PI * 0.5);
    gussetGeom.computeVertexNormals();

    const gussetPositions =
      optionId === 'design_enhanced'
        ? [-flangeWidth * 0.34, flangeWidth * 0.34]
        : [0];

    gussetPositions.forEach((gx, gIdx) => {
      const gussetMesh = new THREE.Mesh(gussetGeom, mats.secondary);
      gussetMesh.name = `Bracket_Gusset_Rib_${gIdx + 1}`;
      gussetMesh.position.set(
        gx,
        plateBottomY + flangeThick * 0.45,
        -plateDepth * 0.38
      );
      group.add(gussetMesh);
    });
  }

  const componentNames = groundAndCenterGroup(group);
  const geometrySummary = `Machined 3D bracket (${usableContours.length || 1} contour plate, ${totalHolesBuilt} precision bore hole${totalHolesBuilt === 1 ? '' : 's'}${optionId !== 'sketch_faithful' ? ', mounting bosses & gusset flange' : ''})`;

  return {
    group,
    componentNames,
    geometrySummary,
  };
}
