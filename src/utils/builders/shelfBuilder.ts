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
 * Modular 3D Bookshelf / Storage Rack / Open Cabinet Reconstructor.
 * Builds vertical side uprights, top/bottom horizontal decks, interior shelf tiers aligned
 * to measured horizontal stroke peaks, base plinth or feet, and rear anti-racking bracing.
 */
export function buildShelfModel(
  prep: RawPreprocessResult,
  blueprint: StructuralBlueprint,
  spec: CompiledReconstructionSpec,
  optionId: ReconstructionOptionId
): BuiltCategoryModel {
  const sm = extractSketchStructuralMetrics(prep);
  const mats = createOptionMaterialSet(spec, optionId);

  const group = new THREE.Group();
  group.name = `Shelf_${optionId}`;

  const totalWidth = THREE.MathUtils.clamp(sm.worldWidth, 0.42, 1.05);
  const totalHeight = THREE.MathUtils.clamp(sm.worldHeight, 0.55, 1.05);
  const depthScale = spec.depthRatio / 0.58;
  const shelfDepth = THREE.MathUtils.clamp(
    totalWidth * Math.max(0.32, Math.min(0.62, blueprint.depth_to_width_ratio)) * depthScale,
    0.22,
    0.52
  );

  const panelThick = THREE.MathUtils.clamp(totalWidth * 0.048, 0.022, 0.038);
  const bevelSegs =
    optionId === 'sketch_faithful' ? 1 : optionId === 'structurally_refined' ? 2 : 4;
  const bevelSize =
    optionId === 'sketch_faithful'
      ? 0.002
      : optionId === 'structurally_refined'
        ? 0.004
        : 0.007;

  const hasShortFeet =
    blueprint.leg_style !== 'plinth_base' &&
    blueprint.leg_style !== 'none' &&
    (prep.metrics.hasBottomLegGap || blueprint.visible_leg_count >= 2);
  const baseClearance = hasShortFeet
    ? Math.max(0.08, totalHeight * 0.11)
    : Math.max(0.045, totalHeight * 0.06);

  const carcassBottomY = baseClearance;
  const carcassTopY = totalHeight;
  const carcassHeight = Math.max(0.32, carcassTopY - carcassBottomY);

  // 1. Left & Right Vertical Side Uprights
  const uprightCenterX = totalWidth * 0.5 - panelThick * 0.5;
  const uprightCenterY = carcassBottomY + carcassHeight * 0.5;

  const buildUpright = (sideSign: -1 | 1, label: string) => {
    const geom = new THREE.BoxGeometry(panelThick, carcassHeight, shelfDepth);
    const mesh = new THREE.Mesh(geom, mats.secondary);
    mesh.name = label;
    mesh.position.set(sideSign * uprightCenterX, uprightCenterY, 0);
    group.add(mesh);

    if (optionId === 'design_enhanced') {
      // Sculpted front stile bullnose trim
      const trimGeom = new THREE.CylinderGeometry(
        panelThick * 0.48,
        panelThick * 0.48,
        carcassHeight,
        16
      );
      const trim = new THREE.Mesh(trimGeom, mats.primary);
      trim.name = `${label}_Front_Bullnose`;
      trim.position.set(sideSign * uprightCenterX, uprightCenterY, shelfDepth * 0.5);
      group.add(trim);
    }
  };

  buildUpright(-1, 'Shelf_Side_Upright_Left');
  buildUpright(1, 'Shelf_Side_Upright_Right');

  // 2. Top Crown & Bottom Deck Slabs spanning between uprights
  const innerSpanX = Math.max(0.16, totalWidth - panelThick * 2 + 0.004);
  const topSlabWidth = optionId === 'design_enhanced' ? totalWidth + 0.024 : totalWidth;
  const topSlabDepth = optionId === 'design_enhanced' ? shelfDepth + 0.018 : shelfDepth;

  const topDeckGeom = createBeveledSlabGeometry(
    topSlabWidth,
    panelThick,
    topSlabDepth,
    optionId === 'design_enhanced' ? 'rounded_rect' : 'rectangular',
    bevelSize,
    bevelSegs
  );
  const topDeck = new THREE.Mesh(topDeckGeom, mats.primary);
  topDeck.name = 'Shelf_Top_Crown_Deck';
  topDeck.position.set(0, carcassTopY - panelThick * 0.5, 0);
  group.add(topDeck);

  const bottomDeckGeom = createBeveledSlabGeometry(
    innerSpanX,
    panelThick,
    shelfDepth * 0.98,
    'rectangular',
    bevelSize,
    bevelSegs
  );
  const bottomDeck = new THREE.Mesh(bottomDeckGeom, mats.primary);
  bottomDeck.name = 'Shelf_Bottom_Deck';
  bottomDeck.position.set(0, carcassBottomY + panelThick * 0.5, 0);
  group.add(bottomDeck);

  // 3. Determine Interior Horizontal Shelf Tiers from measured sketch horizontal peaks + blueprint count
  const interiorPeaks = sm.horizontalPeaksNormV.filter((v) => v > 0.16 && v < 0.82);
  const requestedTotalTiers = THREE.MathUtils.clamp(
    blueprint.shelf_tier_count >= 2 ? blueprint.shelf_tier_count : interiorPeaks.length + 2,
    3,
    6
  );
  const interiorCount = Math.max(1, requestedTotalTiers - 2);

  let tierHeightsY: number[] = [];
  if (interiorPeaks.length >= interiorCount) {
    tierHeightsY = interiorPeaks
      .slice(0, interiorCount)
      .map((v) => totalHeight * (1 - v))
      .filter((y) => y > carcassBottomY + panelThick * 2.2 && y < carcassTopY - panelThick * 2.2);
  }
  if (tierHeightsY.length === 0) {
    for (let i = 1; i <= interiorCount; i++) {
      const frac = i / (interiorCount + 1);
      tierHeightsY.push(carcassBottomY + carcassHeight * frac);
    }
  }

  tierHeightsY.sort((a, b) => a - b);

  tierHeightsY.forEach((tierY, idx) => {
    const tierGeom = createBeveledSlabGeometry(
      innerSpanX,
      panelThick * 0.92,
      shelfDepth * 0.96,
      optionId === 'design_enhanced' ? 'rounded_rect' : 'rectangular',
      bevelSize,
      bevelSegs
    );
    const tierMesh = new THREE.Mesh(tierGeom, mats.primary);
    tierMesh.name = `Shelf_Interior_Tier_${idx + 1}`;
    tierMesh.position.set(0, tierY, 0);
    group.add(tierMesh);

    // Option B & C: Physical side ledger cleats / shelf pins under each shelf tier
    if (optionId !== 'sketch_faithful') {
      const cleatH = panelThick * 0.55;
      const cleatW = panelThick * 0.45;
      for (const side of [-1, 1] as const) {
        const cleatGeom = new THREE.BoxGeometry(cleatW, cleatH, shelfDepth * 0.82);
        const cleat = new THREE.Mesh(cleatGeom, mats.accent);
        cleat.name = `Shelf_Support_Cleat_${idx + 1}_${side < 0 ? 'L' : 'R'}`;
        cleat.position.set(
          side * (innerSpanX * 0.5 - cleatW * 0.5),
          tierY - panelThick * 0.46 - cleatH * 0.5,
          0
        );
        group.add(cleat);
      }
    }
  });

  // 4. Ground Support: 4 Tapered Feet or Recessed Toe-Kick Plinth
  if (hasShortFeet) {
    const footInsetX = totalWidth * 0.5 - panelThick * 0.85;
    const footInsetZ = shelfDepth * 0.5 - panelThick * 1.1;
    const splayX = optionId === 'sketch_faithful' ? 0 : 0.018;
    const footR = panelThick * 0.55;
    const corners: Array<[number, number, string]> = [
      [-1, 1, 'FL'],
      [1, 1, 'FR'],
      [-1, -1, 'RL'],
      [1, -1, 'RR'],
    ];
    for (const [sx, sz, code] of corners) {
      const topPt = new THREE.Vector3(sx * footInsetX, carcassBottomY + 0.008, sz * footInsetZ);
      const botPt = new THREE.Vector3(sx * (footInsetX + splayX), 0, sz * footInsetZ);
      const foot = createAnchoredStrutMesh(
        topPt,
        botPt,
        footR,
        footR * 0.72,
        optionId === 'sketch_faithful' ? 12 : 20,
        optionId === 'sketch_faithful',
        mats.secondary,
        `Shelf_Foot_${code}`
      );
      group.add(foot);
    }
  } else {
    const plinthW = totalWidth - panelThick * 0.6;
    const plinthD = shelfDepth * 0.88;
    const plinthGeom = new THREE.BoxGeometry(plinthW, baseClearance + 0.006, plinthD);
    const plinthMesh = new THREE.Mesh(plinthGeom, mats.secondary);
    plinthMesh.name = 'Shelf_Base_Plinth';
    plinthMesh.position.set(0, baseClearance * 0.5, -shelfDepth * 0.03);
    group.add(plinthMesh);
  }

  // 5. Rear Anti-Racking Structural Bracing (Option B: X-cross rods, Option C: framed rear rail + X-rods)
  if (optionId !== 'sketch_faithful') {
    const rearZ = -shelfDepth * 0.5 + panelThick * 0.38;
    const braceLeftX = -innerSpanX * 0.49;
    const braceRightX = innerSpanX * 0.49;
    const braceBotY = carcassBottomY + panelThick * 0.8;
    const braceTopY = carcassTopY - panelThick * 0.8;
    const rodR = 0.0055;

    const diagA = createAnchoredStrutMesh(
      new THREE.Vector3(braceLeftX, braceBotY, rearZ),
      new THREE.Vector3(braceRightX, braceTopY, rearZ),
      rodR,
      rodR,
      12,
      false,
      mats.accent,
      'Shelf_Rear_CrossBrace_A'
    );
    const diagB = createAnchoredStrutMesh(
      new THREE.Vector3(braceRightX, braceBotY, rearZ),
      new THREE.Vector3(braceLeftX, braceTopY, rearZ),
      rodR,
      rodR,
      12,
      false,
      mats.accent,
      'Shelf_Rear_CrossBrace_B'
    );
    group.add(diagA, diagB);

    if (optionId === 'design_enhanced') {
      const topValanceGeom = new THREE.BoxGeometry(innerSpanX, panelThick * 1.15, panelThick * 0.5);
      const topValance = new THREE.Mesh(topValanceGeom, mats.secondary);
      topValance.name = 'Shelf_Rear_Header_Rail';
      topValance.position.set(0, carcassTopY - panelThick * 1.1, rearZ);
      group.add(topValance);
    }
  }

  const componentNames = groundAndCenterGroup(group);
  const geometrySummary = `Modular 3D shelf unit (2 side uprights, ${tierHeightsY.length + 2} horizontal decks, ${hasShortFeet ? '4 grounded feet' : 'recessed plinth'}${optionId !== 'sketch_faithful' ? ', rear anti-racking X-brace' : ''})`;

  return {
    group,
    componentNames,
    geometrySummary,
  };
}
