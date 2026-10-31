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
  createBeveledSlabGeometry,
  createOptionMaterialSet,
  extractSketchStructuralMetrics,
  groundAndCenterGroup,
} from './sharedGeometry';

/**
 * Modular 3D Table / Desk Reconstructor.
 * Builds separate tabletop slab, perimeter apron/trestle frame, legs/pedestal, and cross-stretchers.
 */
export function buildTableModel(
  prep: RawPreprocessResult,
  blueprint: StructuralBlueprint,
  spec: CompiledReconstructionSpec,
  optionId: ReconstructionOptionId
): BuiltCategoryModel {
  const sm = extractSketchStructuralMetrics(prep);
  const mats = createOptionMaterialSet(spec, optionId);

  const group = new THREE.Group();
  group.name = `Table_${optionId}`;

  const topWidth = sm.worldWidth;
  const totalHeight = sm.worldHeight;
  const depthScale = spec.depthRatio / 0.58;
  const topDepth =
    blueprint.seat_or_top_shape === 'circular'
      ? topWidth
      : THREE.MathUtils.clamp(
          topWidth * blueprint.depth_to_width_ratio * depthScale,
          Math.min(0.26, topWidth * 0.35),
          Math.max(1.05, topWidth * 1.1)
        );

  const topThick = Math.max(0.036, Math.min(0.075, totalHeight * 0.085));
  const topCenterY = totalHeight - topThick * 0.5;
  const topBottomY = totalHeight - topThick;

  // 1. Tabletop Slab
  const bevelSegs = optionId === 'sketch_faithful' ? 1 : optionId === 'structurally_refined' ? 2 : 4;
  const bevelSz = optionId === 'sketch_faithful' ? 0.004 : optionId === 'structurally_refined' ? 0.009 : 0.015;
  const topGeom = createBeveledSlabGeometry(
    topWidth,
    topThick,
    topDepth,
    blueprint.seat_or_top_shape === 'contoured' ? 'rounded_rect' : blueprint.seat_or_top_shape,
    bevelSz,
    bevelSegs,
    24
  );
  const topMesh = new THREE.Mesh(topGeom, mats.primary);
  topMesh.name = 'Tabletop_Slab';
  topMesh.position.set(0, topCenterY, 0);
  group.add(topMesh);

  if (optionId === 'design_enhanced') {
    const subTopGeom = createBeveledSlabGeometry(
      topWidth * 0.92,
      topThick * 0.38,
      topDepth * 0.92,
      blueprint.seat_or_top_shape === 'circular' ? 'circular' : 'rounded_rect',
      0.006,
      2,
      20
    );
    const subTop = new THREE.Mesh(subTopGeom, mats.secondary);
    subTop.name = 'Tabletop_Shadow_Reveal';
    subTop.position.set(0, topBottomY - topThick * 0.16, 0);
    group.add(subTop);
  }

  let legStyle = blueprint.leg_style;
  if (spec.supportTopology === 'three_leg_tripod') legStyle = 'three_leg_tripod';
  else if (spec.supportTopology === 'pedestal_base') legStyle = 'central_pedestal';
  else if (spec.supportTopology === 'four_leg_frame') legStyle = 'four_legs_straight';

  // 2. Supports / Legs
  if (legStyle === 'central_pedestal') {
    const baseR = Math.max(0.18, Math.min(topWidth, topDepth) * 0.42);
    const colR = Math.max(0.04, baseR * 0.24);
    const baseH = 0.032;

    const foot = new THREE.Mesh(
      new THREE.CylinderGeometry(baseR * 0.78, baseR, baseH, optionId === 'design_enhanced' ? 48 : 28),
      mats.secondary
    );
    foot.name = 'Table_Pedestal_Base';
    foot.position.set(0, baseH * 0.5, 0);
    group.add(foot);

    const col = createAnchoredStrutMesh(
      new THREE.Vector3(0, baseH, 0),
      new THREE.Vector3(0, topBottomY + 0.01, 0),
      colR * 1.15,
      colR * 0.9,
      optionId === 'design_enhanced' ? 32 : 20,
      false,
      mats.secondary,
      'Table_Pedestal_Column'
    );
    group.add(col);

    if (optionId !== 'sketch_faithful') {
      const mountPlate = new THREE.Mesh(
        new THREE.CylinderGeometry(baseR * 0.65, colR * 1.15, 0.03, 24),
        mats.accent
      );
      mountPlate.name = 'Table_Mounting_Plate';
      mountPlate.position.set(0, topBottomY - 0.015, 0);
      group.add(mountPlate);
    }
  } else if (legStyle === 'three_leg_tripod') {
    const topR = Math.min(topWidth, topDepth) * 0.34;
    const botR = topR + (optionId === 'sketch_faithful' ? 0.03 : 0.06);
    const legR = Math.max(0.02, Math.min(topWidth, totalHeight) * 0.035);
    const ptsMid: THREE.Vector3[] = [];

    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + Math.PI * 0.16;
      const pTop = new THREE.Vector3(Math.cos(ang) * topR, topBottomY + 0.01, Math.sin(ang) * topR);
      const pBot = new THREE.Vector3(Math.cos(ang) * botR, 0, Math.sin(ang) * botR);
      ptsMid.push(new THREE.Vector3().lerpVectors(pBot, pTop, 0.35));

      const leg = createAnchoredStrutMesh(
        pBot,
        pTop,
        optionId === 'sketch_faithful' ? legR * 0.9 : legR * 0.65,
        legR,
        optionId === 'design_enhanced' ? 20 : 12,
        optionId === 'sketch_faithful',
        mats.secondary,
        `Table_Tripod_Leg_${i + 1}`
      );
      group.add(leg);
    }

    if (optionId !== 'sketch_faithful') {
      for (let i = 0; i < 3; i++) {
        group.add(
          createAnchoredStrutMesh(
            ptsMid[i],
            ptsMid[(i + 1) % 3],
            0.012,
            0.012,
            12,
            false,
            mats.accent,
            `Table_Tripod_Brace_${i + 1}`
          )
        );
      }
    }
  } else {
    // 4-Leg Table Frame + Perimeter Apron (in Option B & C)
    const insetX = topWidth * 0.41;
    const insetZ = topDepth * 0.39;
    const isSplayed = legStyle === 'four_legs_splayed' || optionId === 'design_enhanced';
    const splayX = isSplayed ? topWidth * 0.045 : 0;
    const splayZ = isSplayed ? topDepth * 0.045 : 0;
    const legR = Math.max(0.022, Math.min(topWidth, totalHeight) * 0.038);
    const squareLeg = optionId !== 'design_enhanced' && legStyle !== 'four_legs_splayed';

    if (optionId !== 'sketch_faithful' || blueprint.has_stretchers_or_apron) {
      const apronH = Math.max(0.036, totalHeight * 0.075);
      const apronT = 0.022;
      const apronY = topBottomY - apronH * 0.48;

      const fb = new THREE.BoxGeometry(insetX * 2, apronH, apronT);
      const lr = new THREE.BoxGeometry(apronT, apronH, insetZ * 2);

      const af = new THREE.Mesh(fb, mats.secondary);
      af.name = 'Table_Apron_Front';
      af.position.set(0, apronY, insetZ);

      const ar = new THREE.Mesh(fb.clone(), mats.secondary);
      ar.name = 'Table_Apron_Rear';
      ar.position.set(0, apronY, -insetZ);

      const al = new THREE.Mesh(lr, mats.secondary);
      al.name = 'Table_Apron_Left';
      al.position.set(-insetX, apronY, 0);

      const aRight = new THREE.Mesh(lr.clone(), mats.secondary);
      aRight.name = 'Table_Apron_Right';
      aRight.position.set(insetX, apronY, 0);

      group.add(af, ar, al, aRight);
    }

    const corners = [
      {
        label: 'Front_Left',
        top: new THREE.Vector3(-insetX, topBottomY + 0.01, insetZ),
        bot: new THREE.Vector3(-insetX - splayX, 0, insetZ + splayZ),
      },
      {
        label: 'Front_Right',
        top: new THREE.Vector3(insetX, topBottomY + 0.01, insetZ),
        bot: new THREE.Vector3(insetX + splayX, 0, insetZ + splayZ),
      },
      {
        label: 'Rear_Left',
        top: new THREE.Vector3(-insetX, topBottomY + 0.01, -insetZ),
        bot: new THREE.Vector3(-insetX - splayX, 0, -insetZ - splayZ),
      },
      {
        label: 'Rear_Right',
        top: new THREE.Vector3(insetX, topBottomY + 0.01, -insetZ),
        bot: new THREE.Vector3(insetX + splayX, 0, -insetZ - splayZ),
      },
    ];

    for (const c of corners) {
      const leg = createAnchoredStrutMesh(
        c.bot,
        c.top,
        optionId === 'sketch_faithful' ? legR * 0.92 : legR * 0.68,
        legR,
        optionId === 'design_enhanced' ? 22 : 12,
        squareLeg,
        mats.secondary,
        `Table_Leg_${c.label}`
      );
      group.add(leg);

      if (optionId === 'design_enhanced') {
        const cuffTop = new THREE.Vector3().lerpVectors(c.bot, c.top, 0.12);
        group.add(
          createAnchoredStrutMesh(
            c.bot,
            cuffTop,
            legR * 0.72,
            legR * 0.78,
            18,
            false,
            mats.accent,
            `Table_Ferrule_${c.label}`
          )
        );
      }
    }

    // Stabilizing trestle / H-stretcher in Option B (or if drawn in sketch)
    if (optionId === 'structurally_refined' || blueprint.has_stretchers_or_apron) {
      const tLow = 0.28;
      const fl = new THREE.Vector3().lerpVectors(corners[0].bot, corners[0].top, tLow);
      const fr = new THREE.Vector3().lerpVectors(corners[1].bot, corners[1].top, tLow);
      const rl = new THREE.Vector3().lerpVectors(corners[2].bot, corners[2].top, tLow);
      const rr = new THREE.Vector3().lerpVectors(corners[3].bot, corners[3].top, tLow);

      group.add(
        createAnchoredStrutMesh(fl, rl, 0.014, 0.014, 12, true, mats.secondary, 'Table_Side_Stretcher_Left'),
        createAnchoredStrutMesh(fr, rr, 0.014, 0.014, 12, true, mats.secondary, 'Table_Side_Stretcher_Right'),
        createAnchoredStrutMesh(
          new THREE.Vector3().lerpVectors(fl, rl, 0.5),
          new THREE.Vector3().lerpVectors(fr, rr, 0.5),
          0.014,
          0.014,
          12,
          true,
          mats.accent,
          'Table_Trestle_Crossbar'
        )
      );
    }
  }

  const componentNames = groundAndCenterGroup(group);
  const geometrySummary = `Table Component Synthesis (${componentNames.length} parts: beveled tabletop + ${legStyle.replace(/_/g, ' ')})`;

  return { group, componentNames, geometrySummary };
}
