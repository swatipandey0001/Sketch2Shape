export type PresetSketchId =
  | 'lounge_chair'
  | 'dining_table'
  | 'stoneware_mug'
  | 'table_lamp'
  | 'open_bookshelf';

export interface SketchPresetMeta {
  id: PresetSketchId;
  label: string;
  subtitle: string;
  suggestedHints: {
    objectType: string;
    material: string;
    colour: string;
    style: string;
  };
}

export const SKETCH_PRESETS: SketchPresetMeta[] = [
  {
    id: 'lounge_chair',
    label: 'Chair Sketch',
    subtitle: '3/4 perspective mid-century lounge chair with backrest, armrests & angled legs',
    suggestedHints: {
      objectType: 'Mid-century modern lounge chair',
      material: 'Molded walnut plywood frame with woven bouclé seat cushion',
      colour: 'Warm walnut brown and natural oat cream',
      style: 'Scandinavian architectural industrial design',
    },
  },
  {
    id: 'dining_table',
    label: 'Table Sketch',
    subtitle: '3/4 perspective architectural timber dining table with apron & tapered legs',
    suggestedHints: {
      objectType: 'Rectangular architectural dining table',
      material: 'Solid white oak slab with brushed steel joinery',
      colour: 'Natural oak timber and charcoal slate',
      style: 'Modernist joinery furniture',
    },
  },
  {
    id: 'stoneware_mug',
    label: 'Mug Sketch',
    subtitle: 'Hand-thrown cylindrical ceramic mug with ergonomic C-loop handle',
    suggestedHints: {
      objectType: 'Handcrafted ceramic coffee mug',
      material: 'Speckled stoneware ceramic with satin glaze',
      colour: 'Warm sand speckled clay with cobalt rim',
      style: 'Japanese studio pottery',
    },
  },
  {
    id: 'table_lamp',
    label: 'Lamp Sketch',
    subtitle: 'Turned ceramic base with brass stem and conical linen diffuser shade',
    suggestedHints: {
      objectType: 'Architectural desk & table lamp',
      material: 'Matte glazed stoneware base with brushed brass neck and linen shade',
      colour: 'Terracotta clay, warm brass, off-white',
      style: 'Contemporary minimalist lighting',
    },
  },
  {
    id: 'open_bookshelf',
    label: 'Bookshelf Sketch',
    subtitle: 'Multi-tier open architectural bookcase with vertical uprights & 4 shelves',
    suggestedHints: {
      objectType: 'Multi-tier open architectural bookshelf',
      material: 'Walnut timber shelves with matte black steel frame',
      colour: 'Rich walnut brown and matte black',
      style: 'Industrial studio shelving',
    },
  },
];

function drawHandStroke(
  ctx: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  width: number,
  color: string,
  passes = 2
) {
  if (points.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;

  for (let pass = 0; pass < passes; pass++) {
    const offset = pass === 0 ? 0 : 0.9;
    ctx.lineWidth = pass === 0 ? width : Math.max(1, width * 0.65);
    ctx.globalAlpha = pass === 0 ? 0.95 : 0.45;
    ctx.beginPath();
    ctx.moveTo(points[0][0] + offset, points[0][1] - offset * 0.5);

    for (let i = 1; i < points.length - 1; i++) {
      const xc = (points[i][0] + points[i + 1][0]) / 2 + offset * 0.4;
      const yc = (points[i][1] + points[i + 1][1]) / 2 - offset * 0.4;
      ctx.quadraticCurveTo(points[i][0], points[i][1], xc, yc);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last[0] + offset * 0.5, last[1]);
    ctx.stroke();
  }
  ctx.restore();
}

export function renderPresetOnCanvas(canvas: HTMLCanvasElement, presetId: PresetSketchId) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  // Crisp drafting paper white background
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const sx = w / 768;
  const sy = h / 576;
  const p = (x: number, y: number): [number, number] => [x * sx, y * sy];

  if (presetId === 'lounge_chair') {
    // Faint construction perspective guidelines
    drawHandStroke(ctx, [p(190, 455), p(415, 520), p(610, 440)], 1.4, '#cbd5e1', 1);
    drawHandStroke(ctx, [p(250, 120), p(268, 330)], 1.2, '#cbd5e1', 1);

    // Curved ergonomic backrest shell (3/4 front-left view)
    drawHandStroke(
      ctx,
      [p(245, 130), p(345, 108), p(438, 128), p(458, 265), p(435, 308), p(272, 286), p(245, 130)],
      4.2,
      '#0f172a',
      2
    );
    // Backrest thickness edge & vertical lumbar contour lines
    drawHandStroke(ctx, [p(438, 128), p(452, 136), p(472, 270), p(452, 312), p(435, 308)], 2.8, '#1e293b', 2);
    drawHandStroke(ctx, [p(305, 132), p(318, 278)], 1.6, '#64748b', 1);
    drawHandStroke(ctx, [p(378, 130), p(392, 290)], 1.6, '#64748b', 1);

    // Contoured seat pan & upholstered cushion
    drawHandStroke(
      ctx,
      [p(268, 308), p(448, 326), p(556, 368), p(385, 412), p(256, 344), p(268, 308)],
      4.4,
      '#0f172a',
      2
    );
    // Seat cushion front waterfall lip / thickness
    drawHandStroke(
      ctx,
      [p(256, 344), p(262, 372), p(388, 442), p(560, 394), p(556, 368)],
      3.8,
      '#0f172a',
      2
    );
    // Cushion seam detail
    drawHandStroke(ctx, [p(322, 355), p(468, 374)], 1.8, '#475569', 1);

    // Left visible sculpted bentwood armrest
    drawHandStroke(
      ctx,
      [p(252, 226), p(215, 244), p(212, 262), p(336, 296), p(342, 374)],
      3.6,
      '#0f172a',
      2
    );
    // Right partial armrest (partially behind backrest/seat)
    drawHandStroke(
      ctx,
      [p(456, 240), p(535, 266), p(532, 360)],
      3.4,
      '#0f172a',
      2
    );

    // Front-center-left leg (tapered angled dowel)
    drawHandStroke(
      ctx,
      [p(374, 436), p(358, 534), p(374, 536), p(396, 440)],
      3.8,
      '#0f172a',
      2
    );
    // Front-right leg
    drawHandStroke(
      ctx,
      [p(524, 402), p(552, 498), p(566, 495), p(542, 398)],
      3.8,
      '#0f172a',
      2
    );
    // Back-left splayed leg
    drawHandStroke(
      ctx,
      [p(274, 368), p(236, 476), p(250, 480), p(292, 376)],
      3.8,
      '#0f172a',
      2
    );
    // Visible side stretcher rail (note: rear-right leg & under-seat cross-bracing intentionally occluded in 3/4 view!)
    drawHandStroke(ctx, [p(264, 432), p(368, 484)], 2.8, '#1e293b', 2);

    // Subtle ground shadow hatching strokes
    drawHandStroke(ctx, [p(235, 486), p(365, 540), p(568, 500)], 1.5, '#94a3b8', 1);
  } else if (presetId === 'table_lamp') {
    // Center axis construction line
    drawHandStroke(ctx, [p(384, 88), p(384, 505)], 1.2, '#cbd5e1', 1);

    // Conical architectural shade
    drawHandStroke(ctx, [p(305, 118), p(384, 104), p(463, 118), p(384, 132), p(305, 118)], 3.2, '#0f172a', 2);
    drawHandStroke(ctx, [p(305, 118), p(232, 268)], 4.0, '#0f172a', 2);
    drawHandStroke(ctx, [p(463, 118), p(536, 268)], 4.0, '#0f172a', 2);
    drawHandStroke(ctx, [p(232, 268), p(384, 298), p(536, 268)], 4.0, '#0f172a', 2);
    drawHandStroke(ctx, [p(232, 268), p(384, 246), p(536, 268)], 1.6, '#94a3b8', 1);

    // Pleat lines on shade
    drawHandStroke(ctx, [p(335, 128), p(295, 282)], 1.6, '#64748b', 1);
    drawHandStroke(ctx, [p(384, 132), p(384, 296)], 1.6, '#64748b', 1);
    drawHandStroke(ctx, [p(433, 128), p(473, 282)], 1.6, '#64748b', 1);

    // Brass neck stem
    drawHandStroke(ctx, [p(373, 296), p(373, 342)], 3.2, '#0f172a', 2);
    drawHandStroke(ctx, [p(395, 296), p(395, 342)], 3.2, '#0f172a', 2);

    // Ribbed bulbous ceramic base
    drawHandStroke(
      ctx,
      [p(373, 342), p(312, 376), p(298, 442), p(326, 488), p(384, 498), p(442, 488), p(470, 442), p(456, 376), p(395, 342)],
      4.2,
      '#0f172a',
      2
    );
    drawHandStroke(ctx, [p(352, 355), p(332, 425), p(348, 490)], 1.8, '#475569', 1);
    drawHandStroke(ctx, [p(416, 355), p(436, 425), p(420, 490)], 1.8, '#475569', 1);
  } else if (presetId === 'stoneware_mug') {
    // Stoneware mug top rim ellipse
    drawHandStroke(
      ctx,
      [p(245, 168), p(355, 138), p(465, 168), p(355, 198), p(245, 168)],
      3.8,
      '#0f172a',
      2
    );
    // Inner lip line
    drawHandStroke(ctx, [p(262, 170), p(355, 150), p(448, 170)], 1.8, '#475569', 1);

    // Mug body walls & rounded foot
    drawHandStroke(
      ctx,
      [p(245, 168), p(252, 426), p(275, 462), p(355, 476), p(435, 462), p(458, 426), p(465, 168)],
      4.2,
      '#0f172a',
      2
    );
    // Ceramic foot ring
    drawHandStroke(ctx, [p(282, 464), p(288, 482), p(355, 492), p(422, 482), p(428, 464)], 2.8, '#1e293b', 2);

    // Ergonomic D-loop handle on right
    drawHandStroke(
      ctx,
      [p(463, 218), p(552, 224), p(568, 305), p(538, 386), p(460, 392)],
      4.2,
      '#0f172a',
      2
    );
    drawHandStroke(
      ctx,
      [p(462, 248), p(524, 254), p(534, 305), p(514, 356), p(460, 362)],
      3.4,
      '#0f172a',
      2
    );
  } else if (presetId === 'dining_table') {
    // 3/4 perspective rectangular tabletop slab
    drawHandStroke(
      ctx,
      [p(148, 228), p(376, 174), p(628, 224), p(402, 286), p(148, 228)],
      4.2,
      '#0f172a',
      2
    );
    // Tabletop slab thickness & apron rail
    drawHandStroke(
      ctx,
      [p(148, 228), p(150, 252), p(402, 312), p(628, 248), p(628, 224)],
      3.6,
      '#0f172a',
      2
    );
    // Four tapered legs (3 foreground + 1 partially visible inner rear leg)
    drawHandStroke(ctx, [p(174, 258), p(164, 468), p(182, 470), p(194, 264)], 3.8, '#0f172a', 2);
    drawHandStroke(ctx, [p(392, 310), p(388, 512), p(408, 512), p(414, 308)], 4.0, '#0f172a', 2);
    drawHandStroke(ctx, [p(596, 254), p(608, 458), p(590, 460), p(578, 260)], 3.8, '#0f172a', 2);
    drawHandStroke(ctx, [p(368, 232), p(365, 412), p(380, 412), p(382, 236)], 2.8, '#334155', 2);
  } else if (presetId === 'open_bookshelf') {
    // Vertical left & right side uprights
    drawHandStroke(ctx, [p(225, 92), p(225, 502), p(246, 502), p(246, 92), p(225, 92)], 4.0, '#0f172a', 2);
    drawHandStroke(ctx, [p(522, 92), p(522, 502), p(543, 502), p(543, 92), p(522, 92)], 4.0, '#0f172a', 2);
    // Top crown + 3 interior shelves + bottom deck
    const shelfYs = [102, 198, 294, 390, 468];
    for (const syVal of shelfYs) {
      drawHandStroke(ctx, [p(225, syVal), p(543, syVal)], 4.0, '#0f172a', 2);
      drawHandStroke(ctx, [p(246, syVal + 12), p(522, syVal + 12)], 2.2, '#334155', 1);
    }
    // Subtle rear diagonal anti-racking X-brace hint
    drawHandStroke(ctx, [p(248, 118), p(520, 462)], 1.6, '#64748b', 1);
    drawHandStroke(ctx, [p(520, 118), p(248, 462)], 1.6, '#64748b', 1);
  }

  ctx.restore();
}
