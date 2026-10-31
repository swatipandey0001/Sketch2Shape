import * as THREE from 'three';
import type {
  CompiledReconstructionSpec,
  ReconstructionOptionId,
  StructuralBlueprint,
} from '../../types/studio';
import type { RawPreprocessResult } from '../sketchPreprocessor';
import {
  createAnchoredStrutMesh,
  createBeveledSlabGeometry,
  createCurvedBackrestGeometry,
  createOptionMaterialSet,
  createWaterfallSeatGeometry,
  extractSketchStructuralMetrics,
  groundAndCenterGroup,
} from './sharedGeometry';

export interface BuiltCategoryModel {
  group: THREE.Group;
  componentNames: string[];
  geometrySummary: string;
}

/**
 * Modular 3D Chair / Seating Reconstructor.
 * Decomposes chair sketches into distinct, physically connected 3D components:
 * - Seat pan / waterfall cushion
 * - Backrest (solid shell, curved ergonomic shell, vertical/horizontal slats, or open frame; omitted for stools)
 * - Armrests (strictly when drawn in sketch or requested in IntentLock)
 * - Front & rear legs (4 straight, 4 splayed, 3-leg tripod, central pedestal, sled runners, or cantilever)
 * - Structural supports (under-seat aprons, H-stretchers, backrest stiles, foot glides / ferrules)
 */
export function buildChairModel(
  prep: RawPreprocessResult,
  blueprint: StructuralBlueprint,
  spec: CompiledReconstructionSpec,
  optionId: ReconstructionOptionId
): BuiltCategoryModel {
  const sm = extractSketchStructuralMetrics(prep);
  const mats = createOptionMaterialSet(spec, optionId);

  const group = new THREE.Group();
  group.name = `Chair_${optionId}`;

  // Calibrate overall 3D chair proportions from sketch aspect ratio + Gemini blueprint + IntentLock
  const totalHeight = 1.0;
  const rawAspect = Math.max(0.42, Math.min(1.45, sm.aspectRatio));
  // Side-view chair sketches appear narrow laterally; 3/4 view appears slightly wider: blend blueprint W:H with measured aspect
  const baseWidth = THREE.MathUtils.clamp(
    blueprint.viewpoint === 'side'
      ? blueprint.width_to_height_ratio * 0.85
      : rawAspect * 0.58 + blueprint.width_to_height_ratio * 0.42,
    0.44,
    1.15
  );

  // Depth calibrated from IntentLock depthRatio + blueprint depth_to_width_ratio
  const depthScale = spec.depthRatio / 0.58; // 1.0 at standard chair depthRatio 0.58
  const seatDepth = THREE.MathUtils.clamp(
    baseWidth * blueprint.depth_to_width_ratio * 0.88 * depthScale,
    0.38,
    0.92
  );
  const seatWidth = baseWidth;

  // Seat elevation from floor: blend Gemini blueprint ratio with detected horizontal stroke peak in [0.35..0.72]
  const midHorizontalPeak = sm.horizontalPeaksNormV.find((v) => v >= 0.34 && v <= 0.72);
  const sketchSeatHeightFromFloor =
    typeof midHorizontalPeak === 'number' ? 1 - midHorizontalPeak : blueprint.seat_or_top_height_ratio;
  const hasBackrest = blueprint.has_backrest;
  const seatTopY = hasBackrest
    ? THREE.MathUtils.clamp(
        blueprint.seat_or_top_height_ratio * 0.65 + sketchSeatHeightFromFloor * 0.35,
        0.34,
        0.64
      )
    : THREE.MathUtils.clamp(blueprint.seat_or_top_height_ratio, 0.68, 0.92);

  const seatThickness =
    optionId === 'design_enhanced'
      ? Math.max(0.052, totalHeight * 0.068)
      : Math.max(0.042, totalHeight * 0.052);
  const seatCenterY = seatTopY - seatThickness * 0.5;
  const seatBottomY = seatTopY - seatThickness;

  // Resolve leg topology (IntentLock supportTopology takes precedence over auto blueprint)
  let legStyle = blueprint.leg_style;
  if (spec.supportTopology === 'three_leg_tripod') {
    legStyle = 'three_leg_tripod';
  } else if (spec.supportTopology === 'pedestal_base') {
    legStyle = 'central_pedestal';
  } else if (spec.supportTopology === 'four_leg_frame' && (legStyle === 'three_leg_tripod' || legStyle === 'central_pedestal')) {
    legStyle = 'four_legs_splayed';
  }

  // 1. SEAT COMPONENT
  if (optionId === 'design_enhanced' && blueprint.seat_or_top_shape !== 'circular') {
    // Structural wood/metal sub-pan + sculpted ergonomic waterfall cushion
    const panThick = seatThickness * 0.36;
    const panGeom = createBeveledSlabGeometry(
      seatWidth * 0.96,
      panThick,
      seatDepth * 0.95,
      'rounded_rect',
      0.008,
      3
    );
    const panMesh = new THREE.Mesh(panGeom, mats.secondary);
    panMesh.name = 'Seat_Structural_Pan';
    panMesh.position.set(0, seatBottomY + panThick * 0.5, 0);
    group.add(panMesh);

    const cushThick = seatThickness * 0.78;
    const cushGeom = createWaterfallSeatGeometry(seatWidth, cushThick, seatDepth, 4);
    const cushMesh = new THREE.Mesh(cushGeom, mats.primary);
    cushMesh.name = 'Seat_Waterfall_Cushion';
    cushMesh.position.set(0, seatBottomY + panThick + cushThick * 0.45, 0.01);
    group.add(cushMesh);
  } else {
    const bevelSegs = optionId === 'sketch_faithful' ? 1 : 3;
    const bevelSz = optionId === 'sketch_faithful' ? 0.004 : 0.01;
    const seatGeom = createBeveledSlabGeometry(
      seatWidth,
      seatThickness,
      seatDepth,
      blueprint.seat_or_top_shape,
      bevelSz,
      bevelSegs
    );
    const seatMesh = new THREE.Mesh(seatGeom, mats.primary);
    seatMesh.name = 'Seat_Slab';
    seatMesh.position.set(0, seatCenterY, 0);
    group.add(seatMesh);
  }

  // 2. UNDER-SEAT STRUCTURAL APRON FRAME (Option B & Option C, or if explicitly drawn)
  const apronHeight = 0.036;
  const apronThick = 0.022;
  const insetX = seatWidth * 0.39;
  const insetZ = seatDepth * 0.38;
  const includeApron =
    (optionId === 'structurally_refined' || optionId === 'design_enhanced' || blueprint.has_stretchers_or_apron) &&
    legStyle !== 'central_pedestal' &&
    blueprint.seat_or_top_shape !== 'circular';

  if (includeApron) {
    const apronY = seatBottomY - apronHeight * 0.42;
    const fbGeom = new THREE.BoxGeometry(seatWidth * 0.78, apronHeight, apronThick);
    const lrGeom = new THREE.BoxGeometry(apronThick, apronHeight, seatDepth * 0.76);

    const frontApron = new THREE.Mesh(fbGeom, mats.secondary);
    frontApron.name = 'Under_Seat_Apron_Front';
    frontApron.position.set(0, apronY, insetZ);

    const rearApron = new THREE.Mesh(fbGeom.clone(), mats.secondary);
    rearApron.name = 'Under_Seat_Apron_Rear';
    rearApron.position.set(0, apronY, -insetZ);

    const leftApron = new THREE.Mesh(lrGeom, mats.secondary);
    leftApron.name = 'Under_Seat_Apron_Left';
    leftApron.position.set(-insetX, apronY, 0);

    const rightApron = new THREE.Mesh(lrGeom.clone(), mats.secondary);
    rightApron.name = 'Under_Seat_Apron_Right';
    rightApron.position.set(insetX, apronY, 0);

    group.add(frontApron, rearApron, leftApron, rightApron);
  }

  // 3. BACKREST ASSEMBLY (Positioned at rear -Z edge, never extruded across seat depth!)
  if (hasBackrest) {
    const backrestTotalH = Math.max(0.24, totalHeight - seatTopY + 0.02);
    const tiltRad = THREE.MathUtils.degToRad(
      THREE.MathUtils.clamp(
        blueprint.backrest_tilt_deg || (optionId === 'design_enhanced' ? 12 : 9),
        3,
        24
      )
    );
    const backWidth = THREE.MathUtils.clamp(
      seatWidth * (sm.upperMeanSpan / Math.max(0.35, sm.midMeanSpan)),
      seatWidth * 0.76,
      seatWidth * 1.04
    );
    const backThickness = optionId === 'sketch_faithful' ? 0.034 : 0.04;
    const pivotZ = -seatDepth * 0.45;
    const pivotY = seatTopY - 0.01;

    const backPivot = new THREE.Group();
    backPivot.name = 'Backrest_Pivot';
    backPivot.position.set(0, pivotY, pivotZ);
    backPivot.rotation.x = -tiltRad; // Tilts backward toward -Z as Y increases

    const bStyle = blueprint.backrest_style;

    if (bStyle === 'slatted_vertical' || bStyle === 'slatted_horizontal' || bStyle === 'open_frame') {
      const stileRadius = optionId === 'sketch_faithful' ? 0.017 : 0.02;
      const halfSpan = backWidth * 0.45;
      const squareStile = optionId === 'sketch_faithful';
      const radialSegs = optionId === 'design_enhanced' ? 20 : 12;

      // Left & right upright stiles anchored into seat rear
      for (const [sideLabel, sx] of [
        ['Left', -halfSpan],
        ['Right', halfSpan],
      ] as const) {
        const stile = createAnchoredStrutMesh(
          new THREE.Vector3(sx, -0.03, 0),
          new THREE.Vector3(sx, backrestTotalH, 0),
          stileRadius,
          stileRadius * 0.85,
          radialSegs,
          squareStile,
          mats.secondary,
          `Backrest_Stile_${sideLabel}`
        );
        backPivot.add(stile);
      }

      // Top crest rail
      if (optionId === 'design_enhanced') {
        const crestGeom = createCurvedBackrestGeometry(
          backWidth * 0.98,
          backrestTotalH * 0.22,
          backThickness,
          0.045,
          3
        );
        const crest = new THREE.Mesh(crestGeom, mats.primary);
        crest.name = 'Backrest_Curved_Crest_Rail';
        crest.position.set(0, backrestTotalH * 0.89, 0.012);
        backPivot.add(crest);
      } else {
        const topRailGeom = createBeveledSlabGeometry(
          backWidth * 0.96,
          backThickness,
          backrestTotalH * 0.2,
          'rounded_rect',
          optionId === 'sketch_faithful' ? 0.003 : 0.008,
          optionId === 'sketch_faithful' ? 1 : 2
        );
        topRailGeom.rotateX(Math.PI * 0.5);
        const topRail = new THREE.Mesh(topRailGeom, mats.primary);
        topRail.name = 'Backrest_Top_Rail';
        topRail.position.set(0, backrestTotalH * 0.89, 0);
        backPivot.add(topRail);
      }

      if (bStyle === 'slatted_vertical') {
        // Bottom rail in Option B & C + vertical spindles
        if (optionId !== 'sketch_faithful') {
          const lowRail = createAnchoredStrutMesh(
            new THREE.Vector3(-halfSpan, backrestTotalH * 0.14, 0),
            new THREE.Vector3(halfSpan, backrestTotalH * 0.14, 0),
            0.013,
            0.013,
            12,
            false,
            mats.secondary,
            'Backrest_Lower_Rail'
          );
          backPivot.add(lowRail);
        }
        const slatCount = 4;
        for (let i = 0; i < slatCount; i++) {
          const t = (i + 1) / (slatCount + 1);
          const sx = THREE.MathUtils.lerp(-halfSpan, halfSpan, t);
          const spindle = createAnchoredStrutMesh(
            new THREE.Vector3(sx, optionId === 'sketch_faithful' ? 0 : backrestTotalH * 0.14, 0),
            new THREE.Vector3(sx, backrestTotalH * 0.82, 0),
            0.009,
            0.008,
            optionId === 'design_enhanced' ? 16 : 8,
            optionId === 'sketch_faithful',
            mats.primary,
            `Backrest_Spindle_${i + 1}`
          );
          backPivot.add(spindle);
        }
      } else if (bStyle === 'slatted_horizontal') {
        const rungCount = 3;
        for (let i = 0; i < rungCount; i++) {
          const ry = backrestTotalH * (0.24 + i * 0.24);
          const rung = createAnchoredStrutMesh(
            new THREE.Vector3(-halfSpan, ry, 0),
            new THREE.Vector3(halfSpan, ry, 0),
            0.012,
            0.012,
            12,
            optionId === 'sketch_faithful',
            mats.primary,
            `Backrest_Ladder_Slat_${i + 1}`
          );
          backPivot.add(rung);
        }
      }
    } else {
      // Solid / Contoured Shell Backrest
      if (optionId === 'sketch_faithful') {
        // Clean thin backrest slab + minimal twin connection posts into seat
        const shellH = backrestTotalH * 0.78;
        const shellGeom = createBeveledSlabGeometry(
          backWidth,
          backThickness,
          shellH,
          'rounded_rect',
          0.005,
          1
        );
        shellGeom.rotateX(Math.PI * 0.5);
        const shellMesh = new THREE.Mesh(shellGeom, mats.primary);
        shellMesh.name = 'Backrest_Panel';
        shellMesh.position.set(0, backrestTotalH - shellH * 0.5, 0);
        backPivot.add(shellMesh);

        for (const [sideLabel, sx] of [
          ['Left', -backWidth * 0.34],
          ['Right', backWidth * 0.34],
        ] as const) {
          const post = createAnchoredStrutMesh(
            new THREE.Vector3(sx, -0.02, 0),
            new THREE.Vector3(sx, backrestTotalH * 0.32, 0),
            0.016,
            0.015,
            8,
            true,
            mats.secondary,
            `Backrest_Support_${sideLabel}`
          );
          backPivot.add(post);
        }
      } else if (optionId === 'structurally_refined') {
        // Full structural upright stiles anchored into rear apron + slightly curved shell
        const shellH = backrestTotalH * 0.76;
        const shellGeom = createCurvedBackrestGeometry(
          backWidth,
          shellH,
          backThickness,
          0.032,
          2,
          16
        );
        const shellMesh = new THREE.Mesh(shellGeom, mats.primary);
        shellMesh.name = 'Backrest_Shell';
        shellMesh.position.set(0, backrestTotalH - shellH * 0.5, 0.008);
        backPivot.add(shellMesh);

        for (const [sideLabel, sx] of [
          ['Left', -backWidth * 0.38],
          ['Right', backWidth * 0.38],
        ] as const) {
          const stile = createAnchoredStrutMesh(
            new THREE.Vector3(sx, -seatThickness - 0.02, -0.01),
            new THREE.Vector3(sx, backrestTotalH * 0.72, -0.012),
            0.02,
            0.016,
            14,
            false,
            mats.secondary,
            `Backrest_Structural_Stile_${sideLabel}`
          );
          backPivot.add(stile);
        }
      } else {
        // Option C: Molded curved ergonomic backrest shell + contoured lumbar cushion pad + sculpted stiles
        const shellH = backrestTotalH * 0.8;
        const shellGeom = createCurvedBackrestGeometry(
          backWidth * 1.02,
          shellH,
          backThickness * 0.82,
          0.062,
          4,
          26
        );
        const shellMesh = new THREE.Mesh(shellGeom, mats.secondary);
        shellMesh.name = 'Backrest_Ergonomic_Shell';
        shellMesh.position.set(0, backrestTotalH - shellH * 0.5, 0.01);
        backPivot.add(shellMesh);

        const padGeom = createCurvedBackrestGeometry(
          backWidth * 0.88,
          shellH * 0.82,
          backThickness * 0.65,
          0.056,
          3,
          22
        );
        const padMesh = new THREE.Mesh(padGeom, mats.primary);
        padMesh.name = 'Backrest_Lumbar_Cushion';
        padMesh.position.set(0, backrestTotalH - shellH * 0.5, 0.034);
        backPivot.add(padMesh);

        for (const [sideLabel, sx] of [
          ['Left', -backWidth * 0.36],
          ['Right', backWidth * 0.36],
        ] as const) {
          const spine = createAnchoredStrutMesh(
            new THREE.Vector3(sx, -seatThickness - 0.02, -0.008),
            new THREE.Vector3(sx, backrestTotalH * 0.68, -0.014),
            0.021,
            0.014,
            20,
            false,
            mats.secondary,
            `Backrest_Sculpted_Spine_${sideLabel}`
          );
          backPivot.add(spine);
        }
      }
    }

    group.add(backPivot);
  }

  // 4. ARMRESTS (Strictly when drawn in sketch or enabled via IntentLock — never hallucinated!)
  if (blueprint.has_armrests) {
    const armY = seatTopY + Math.min(0.24, Math.max(0.16, (totalHeight - seatTopY) * 0.44));
    const armX = seatWidth * 0.49;
    const armRearZ = -seatDepth * 0.42;
    const armFrontZ = seatDepth * 0.34;

    for (const [sideLabel, sign] of [
      ['Left', -1],
      ['Right', 1],
    ] as const) {
      const xPos = sign * armX;
      if (optionId === 'design_enhanced') {
        // Swept ergonomic curved arm pad + tapered front post with hardware ferrule
        const armCurve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(xPos * 0.94, armY + 0.015, armRearZ),
          new THREE.Vector3(xPos * 1.03, armY, (armRearZ + armFrontZ) * 0.5),
          new THREE.Vector3(xPos, armY - 0.012, armFrontZ),
          new THREE.Vector3(xPos * 0.95, seatTopY - 0.01, armFrontZ - 0.02),
        ]);
        const armTubeGeom = new THREE.TubeGeometry(armCurve, 32, 0.021, 14, false);
        const armMesh = new THREE.Mesh(armTubeGeom, mats.secondary);
        armMesh.name = `Armrest_Swept_${sideLabel}`;
        group.add(armMesh);

        const collarGeom = new THREE.CylinderGeometry(0.024, 0.024, 0.022, 16);
        const collar = new THREE.Mesh(collarGeom, mats.accent);
        collar.name = `Armrest_Collar_${sideLabel}`;
        collar.position.set(xPos * 0.95, seatTopY + 0.012, armFrontZ - 0.02);
        group.add(collar);
      } else {
        // Straight or beveled arm rail + vertical front support post
        const railLen = armFrontZ - armRearZ + 0.04;
        const railGeom = createBeveledSlabGeometry(
          0.048,
          0.028,
          railLen,
          'rounded_rect',
          optionId === 'sketch_faithful' ? 0.003 : 0.007,
          optionId === 'sketch_faithful' ? 1 : 2
        );
        const rail = new THREE.Mesh(railGeom, mats.secondary);
        rail.name = `Armrest_Rail_${sideLabel}`;
        rail.position.set(xPos, armY, (armRearZ + armFrontZ) * 0.5);
        group.add(rail);

        const frontPost = createAnchoredStrutMesh(
          new THREE.Vector3(xPos * 0.96, seatTopY - seatThickness * 0.5, armFrontZ - 0.02),
          new THREE.Vector3(xPos, armY - 0.01, armFrontZ - 0.02),
          0.017,
          0.015,
          optionId === 'sketch_faithful' ? 8 : 14,
          optionId === 'sketch_faithful',
          mats.secondary,
          `Armrest_Front_Post_${sideLabel}`
        );
        group.add(frontPost);

        if (optionId === 'structurally_refined' && !hasBackrest) {
          const rearPost = createAnchoredStrutMesh(
            new THREE.Vector3(xPos * 0.96, seatTopY - seatThickness * 0.5, armRearZ + 0.02),
            new THREE.Vector3(xPos, armY - 0.01, armRearZ + 0.02),
            0.017,
            0.015,
            14,
            false,
            mats.secondary,
            `Armrest_Rear_Post_${sideLabel}`
          );
          group.add(rearPost);
        }
      }
    }
  }

  // 5. LEGS & STRUCTURAL STRETCHERS (Grounded cleanly at Y = 0)
  const legAnchorY = seatBottomY + seatThickness * 0.25;

  if (legStyle === 'central_pedestal') {
    const colR = Math.max(0.034, seatWidth * 0.068);
    const baseDiscR = Math.max(0.2, Math.min(seatWidth, seatDepth) * 0.44);
    const baseH = 0.028;

    const baseGeom = new THREE.CylinderGeometry(
      baseDiscR * 0.72,
      baseDiscR,
      baseH,
      optionId === 'design_enhanced' ? 48 : 28
    );
    const baseMesh = new THREE.Mesh(baseGeom, mats.secondary);
    baseMesh.name = 'Pedestal_Base_Foot';
    baseMesh.position.set(0, baseH * 0.5, 0);
    group.add(baseMesh);

    const col = createAnchoredStrutMesh(
      new THREE.Vector3(0, baseH, 0),
      new THREE.Vector3(0, legAnchorY, 0),
      colR * 1.15,
      colR * 0.88,
      optionId === 'design_enhanced' ? 32 : 20,
      false,
      mats.secondary,
      'Pedestal_Column'
    );
    group.add(col);

    if (optionId !== 'sketch_faithful') {
      const flange = new THREE.Mesh(
        new THREE.CylinderGeometry(seatWidth * 0.26, colR * 1.1, 0.035, 24),
        mats.accent
      );
      flange.name = 'Pedestal_Seat_Spider_Flange';
      flange.position.set(0, seatBottomY - 0.012, 0);
      group.add(flange);
    }
  } else if (legStyle === 'sled_runners' || legStyle === 'cantilever') {
    const runnerX = seatWidth * 0.41;
    const zFront = seatDepth * 0.42;
    const zBack = -seatDepth * 0.44;
    const tubeR = 0.017;

    for (const [sideLabel, sign] of [
      ['Left', -1],
      ['Right', 1],
    ] as const) {
      const rx = sign * runnerX;
      const pts =
        legStyle === 'cantilever'
          ? [
              new THREE.Vector3(rx, legAnchorY, zBack),
              new THREE.Vector3(rx, legAnchorY, zFront),
              new THREE.Vector3(rx, tubeR, zFront),
              new THREE.Vector3(rx, tubeR, zBack - 0.03),
            ]
          : [
              new THREE.Vector3(rx, legAnchorY, zFront * 0.85),
              new THREE.Vector3(rx, tubeR, zFront),
              new THREE.Vector3(rx, tubeR, zBack),
              new THREE.Vector3(rx, legAnchorY, zBack * 0.85),
            ];
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.18);
      const sledGeom = new THREE.TubeGeometry(
        curve,
        optionId === 'design_enhanced' ? 40 : 24,
        tubeR,
        optionId === 'design_enhanced' ? 16 : 10,
        false
      );
      const sledMesh = new THREE.Mesh(sledGeom, mats.secondary);
      sledMesh.name = `Sled_Runner_${sideLabel}`;
      group.add(sledMesh);
    }

    if (optionId !== 'sketch_faithful') {
      const cross = createAnchoredStrutMesh(
        new THREE.Vector3(-runnerX, legAnchorY - 0.02, 0),
        new THREE.Vector3(runnerX, legAnchorY - 0.02, 0),
        0.014,
        0.014,
        12,
        false,
        mats.accent,
        'Sled_Cross_Tie'
      );
      group.add(cross);
    }
  } else if (legStyle === 'three_leg_tripod') {
    const splay = optionId === 'sketch_faithful' ? 0.03 : 0.065;
    const topR = seatWidth * 0.34;
    const botR = topR + splay;
    const legTopRadius = 0.024;
    const legBotRadius = optionId === 'sketch_faithful' ? 0.02 : 0.015;
    const angles = [Math.PI * 0.18, Math.PI * 0.82, Math.PI * 1.5]; // 2 front-side, 1 rear-center

    const midPoints: THREE.Vector3[] = [];
    angles.forEach((ang, idx) => {
      const pTop = new THREE.Vector3(Math.cos(ang) * topR, legAnchorY, Math.sin(ang) * topR);
      const pBot = new THREE.Vector3(Math.cos(ang) * botR, 0, Math.sin(ang) * botR);
      midPoints.push(new THREE.Vector3().lerpVectors(pBot, pTop, 0.38));

      const leg = createAnchoredStrutMesh(
        pBot,
        pTop,
        legBotRadius,
        legTopRadius,
        optionId === 'design_enhanced' ? 20 : 12,
        optionId === 'sketch_faithful',
        mats.secondary,
        `Tripod_Leg_${idx + 1}`
      );
      group.add(leg);
    });

    if (optionId !== 'sketch_faithful' || blueprint.has_stretchers_or_apron) {
      for (let i = 0; i < 3; i++) {
        const strut = createAnchoredStrutMesh(
          midPoints[i],
          midPoints[(i + 1) % 3],
          0.011,
          0.011,
          12,
          false,
          mats.accent,
          `Tripod_Stretcher_${i + 1}`
        );
        group.add(strut);
      }
    }
  } else {
    // Standard 4-Leg Chair Frame (straight or splayed)
    const isSplayed =
      legStyle === 'four_legs_splayed' ||
      (optionId === 'design_enhanced' && legStyle !== 'four_legs_straight');
    const splayX = isSplayed ? seatWidth * 0.08 : 0.0;
    const splayZ = isSplayed ? seatDepth * 0.09 : 0.0;

    const topX = seatWidth * 0.39;
    const topZ = seatDepth * 0.38;
    const legTopR = 0.024;
    const legBotR =
      optionId === 'sketch_faithful'
        ? isSplayed
          ? 0.018
          : 0.022
        : 0.015;
    const squareLegs = legStyle === 'four_legs_straight' && optionId !== 'design_enhanced';
    const radialSegs = optionId === 'design_enhanced' ? 22 : 12;

    const corners: Array<{
      label: string;
      top: THREE.Vector3;
      bot: THREE.Vector3;
    }> = [
      {
        label: 'Front_Left',
        top: new THREE.Vector3(-topX, legAnchorY, topZ),
        bot: new THREE.Vector3(-topX - splayX, 0, topZ + splayZ * 0.75),
      },
      {
        label: 'Front_Right',
        top: new THREE.Vector3(topX, legAnchorY, topZ),
        bot: new THREE.Vector3(topX + splayX, 0, topZ + splayZ * 0.75),
      },
      {
        label: 'Rear_Left',
        top: new THREE.Vector3(-topX, legAnchorY, -topZ),
        bot: new THREE.Vector3(-topX - splayX, 0, -topZ - splayZ * 1.15),
      },
      {
        label: 'Rear_Right',
        top: new THREE.Vector3(topX, legAnchorY, -topZ),
        bot: new THREE.Vector3(topX + splayX, 0, -topZ - splayZ * 1.15),
      },
    ];

    for (const c of corners) {
      const leg = createAnchoredStrutMesh(
        c.bot,
        c.top,
        legBotR,
        legTopR,
        radialSegs,
        squareLegs,
        mats.secondary,
        `Chair_Leg_${c.label}`
      );
      group.add(leg);

      if (optionId === 'structurally_refined') {
        const glide = new THREE.Mesh(
          new THREE.CylinderGeometry(legBotR * 1.08, legBotR * 1.15, 0.012, 12),
          mats.accent
        );
        glide.name = `Foot_Glide_${c.label}`;
        glide.position.set(c.bot.x, 0.006, c.bot.z);
        group.add(glide);
      } else if (optionId === 'design_enhanced') {
        const ferruleEnd = new THREE.Vector3().lerpVectors(c.bot, c.top, 0.14);
        const ferrule = createAnchoredStrutMesh(
          c.bot,
          ferruleEnd,
          legBotR * 1.06,
          legBotR * 1.14,
          18,
          false,
          mats.accent,
          `Brass_Ferrule_${c.label}`
        );
        group.add(ferrule);
      }
    }

    // Structural Stretcher Rails:
    // - Option A: Only if sketch explicitly shows stretchers
    // - Option B & Option C: Complete H-stretcher assembly connecting front/rear legs + cross tie
    const includeStretchers =
      optionId === 'structurally_refined' ||
      optionId === 'design_enhanced' ||
      blueprint.has_stretchers_or_apron;

    if (includeStretchers) {
      const tRail = 0.36;
      const flMid = new THREE.Vector3().lerpVectors(corners[0].bot, corners[0].top, tRail);
      const frMid = new THREE.Vector3().lerpVectors(corners[1].bot, corners[1].top, tRail);
      const rlMid = new THREE.Vector3().lerpVectors(corners[2].bot, corners[2].top, tRail);
      const rrMid = new THREE.Vector3().lerpVectors(corners[3].bot, corners[3].top, tRail);
      const railR = optionId === 'design_enhanced' ? 0.011 : 0.013;

      const leftStretcher = createAnchoredStrutMesh(
        flMid,
        rlMid,
        railR,
        railR,
        14,
        optionId === 'sketch_faithful',
        mats.secondary,
        'Stretcher_Rail_Left'
      );
      const rightStretcher = createAnchoredStrutMesh(
        frMid,
        rrMid,
        railR,
        railR,
        14,
        optionId === 'sketch_faithful',
        mats.secondary,
        'Stretcher_Rail_Right'
      );
      group.add(leftStretcher, rightStretcher);

      if (optionId !== 'sketch_faithful') {
        const centerLeft = new THREE.Vector3().lerpVectors(flMid, rlMid, 0.5);
        const centerRight = new THREE.Vector3().lerpVectors(frMid, rrMid, 0.5);
        const crossStretcher = createAnchoredStrutMesh(
          centerLeft,
          centerRight,
          railR * 0.95,
          railR * 0.95,
          14,
          false,
          mats.accent,
          'Stretcher_Center_Cross'
        );
        group.add(crossStretcher);
      }
    }
  }

  const componentNames = groundAndCenterGroup(group);
  const geometrySummary = `Chair Component Synthesis (${componentNames.length} separate 3D parts: ${
    hasBackrest ? 'seat + backrest' : 'stool seat'
  }${blueprint.has_armrests ? ' + armrests' : ''} + ${legStyle.replace(/_/g, ' ')})`;

  return { group, componentNames, geometrySummary };
}
