import crypto from 'node:crypto';
import * as THREE from 'three';
import { preprocessRgbaPixels } from '../src/utils/sketchPreprocessor';
import { compileIntentReconstructionSpec } from '../src/utils/intentCompiler';
import {
  OFFLINE_FALLBACK_PROVENANCE_LABEL,
  OfflineReconstructionError,
  reconstructOffline3DFromPreprocessed,
} from '../src/utils/sketchTo3DFallback';
import { synthesizeThreeReconstructionOptions } from '../src/utils/modularReconstructor';
import {
  GlbValidationError,
  disposeObject3D,
  ensureFileReaderPolyfill,
  exportObjectToGlbBuffer,
  exportObjectToObjAndMtl,
  validateAndParseGlbBuffer,
} from '../src/utils/glbValidator';
import type { SketchAnalysisResult } from '../src/types/studio';

process.env.SKETCH2SHAPE_SKIP_LISTEN = '1';

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  detail: string;
}

const results: TestResult[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCase(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    const durationMs = Number((performance.now() - t0).toFixed(1));
    results.push({ name, passed: true, durationMs, detail });
    console.log(`  [PASS] ${name} (${durationMs}ms) — ${detail}`);
  } catch (err: unknown) {
    const durationMs = Number((performance.now() - t0).toFixed(1));
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, durationMs, detail });
    console.error(`  [FAIL] ${name} (${durationMs}ms) — ${detail}`);
  }
}

/**
 * Helper to create an opaque white RGBA buffer and draw shapes into it deterministically.
 */
function createRgbaCanvas(
  width: number,
  height: number,
  bg: [number, number, number, number] = [255, 255, 255, 255]
): {
  rgba: Uint8ClampedArray;
  fillRect: (x0: number, y0: number, w: number, h: number, color: [number, number, number, number]) => void;
  fillCircle: (cx: number, cy: number, r: number, color: [number, number, number, number]) => void;
} {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = bg[3];
  }

  const fillRect = (
    x0: number,
    y0: number,
    w: number,
    h: number,
    color: [number, number, number, number]
  ) => {
    const startX = Math.max(0, Math.floor(x0));
    const endX = Math.min(width, Math.ceil(x0 + w));
    const startY = Math.max(0, Math.floor(y0));
    const endY = Math.min(height, Math.ceil(y0 + h));
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (y * width + x) * 4;
        rgba[idx] = color[0];
        rgba[idx + 1] = color[1];
        rgba[idx + 2] = color[2];
        rgba[idx + 3] = color[3];
      }
    }
  };

  const fillCircle = (
    cx: number,
    cy: number,
    r: number,
    color: [number, number, number, number]
  ) => {
    const r2 = r * r;
    const minX = Math.max(0, Math.floor(cx - r));
    const maxX = Math.min(width - 1, Math.ceil(cx + r));
    const minY = Math.max(0, Math.floor(cy - r));
    const maxY = Math.min(height - 1, Math.ceil(cy + r));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          const idx = (y * width + x) * 4;
          rgba[idx] = color[0];
          rgba[idx + 1] = color[1];
          rgba[idx + 2] = color[2];
          rgba[idx + 3] = color[3];
        }
      }
    }
  };

  return { rgba, fillRect, fillCircle };
}

function makeBaseAnalysis(name: string): SketchAnalysisResult {
  return {
    object_name: name,
    visible_components: ['Primary body'],
    observed_features: ['Closed outer silhouette'],
    uncertain_features: [],
    inferred_features: ['Estimated rear face'],
    proportions_description: 'Measured from 2D sketch bounds',
    material_preferences: {
      primary_material: 'Stoneware ceramic',
      secondary_material: 'Brushed steel',
      colour_palette: 'Warm neutral',
      surface_finish: 'Satin',
      source_note: 'Automated test fixture',
    },
    reconstruction_notes: 'Automated test verification.',
  };
}

function parseObjBoundingBox(objText: string): { x: number; y: number; z: number; vertexCount: number } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let vertexCount = 0;

  for (const line of objText.split('\n')) {
    if (line.startsWith('v ')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const x = Number(parts[1]);
        const y = Number(parts[2]);
        const z = Number(parts[3]);
        assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'OBJ vertex has non-finite coord');
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
        vertexCount += 1;
      }
    }
  }
  return {
    x: maxX - minX,
    y: maxY - minY,
    z: maxZ - minZ,
    vertexCount,
  };
}

async function main() {
  ensureFileReaderPolyfill();

  const {
    verifyGlbHeader,
    mapTripoError,
    validateAndNormalizeAnalysisPayload,
    parseGeminiSdkError,
  } = await import('../server');

  console.log('\n=== Sketch2Shape — IntentLock 3D Automated Verification Suite ===\n');

  // 1. Fresh Asymmetric Sketches (Proves geometry derives from actual sketch pixels, never a static preset)
  await runCase('1. Fresh Asymmetric Sketches (L-Bracket with Hole vs Wide Stepped Wedge)', async () => {
    // Sketch A: Tall asymmetric L-bracket with interior mounting hole
    const sketchA = createRgbaCanvas(360, 360);
    sketchA.fillRect(60, 40, 80, 270, [18, 24, 38, 255]); // Vertical stem
    sketchA.fillRect(60, 230, 220, 80, [18, 24, 38, 255]); // Lower right cantilever arm
    sketchA.fillCircle(100, 95, 20, [255, 255, 255, 255]); // Interior circular hole

    const prepA = preprocessRgbaPixels(sketchA.rgba, 360, 360);
    assert(prepA.metrics.hasForeground, 'Sketch A should detect foreground');
    assert(prepA.metrics.holeContourCount >= 1, `Expected >=1 interior hole in Sketch A, got ${prepA.metrics.holeContourCount}`);
    assert(!prepA.metrics.rotationalProfileSuitable, 'Asymmetric L-bracket must not be classified as rotational lathe');

    const specA = compileIntentReconstructionSpec(
      { objectType: 'Asymmetric L-Bracket', material: 'Aluminum', colour: 'Silver', style: 'Industrial' },
      makeBaseAnalysis('Asymmetric L-Bracket'),
      null
    );
    const outA = await reconstructOffline3DFromPreprocessed(prepA, specA);
    assert(outA.modeUsed === 'contour_extrusion', `Expected contour_extrusion, got ${outA.modeUsed}`);
    assert(outA.provenanceLabel === OFFLINE_FALLBACK_PROVENANCE_LABEL, 'Provenance label mismatch');

    // Sketch B: Wide horizontal stepped wedge (markedly wider than tall)
    const sketchB = createRgbaCanvas(420, 260);
    sketchB.fillRect(30, 130, 350, 75, [15, 23, 42, 255]);
    sketchB.fillRect(30, 85, 160, 45, [15, 23, 42, 255]);

    const prepB = preprocessRgbaPixels(sketchB.rgba, 420, 260);
    const specB = compileIntentReconstructionSpec(
      { objectType: 'Wide Stepped Wedge', material: 'Walnut', colour: 'Walnut', style: 'Modern' },
      makeBaseAnalysis('Wide Stepped Wedge'),
      null
    );
    const outB = await reconstructOffline3DFromPreprocessed(prepB, specB);

    assert(
      outA.stats.dimensions.y > outA.stats.dimensions.x &&
        outB.stats.dimensions.x > outB.stats.dimensions.y * 1.6,
      `Mesh proportions must reflect sketch pixels: A=(${outA.stats.dimensions.x}x${outA.stats.dimensions.y}), B=(${outB.stats.dimensions.x}x${outB.stats.dimensions.y})`
    );
    assert(
      outA.stats.vertexCount !== outB.stats.vertexCount,
      'Distinct asymmetric sketches produced identical vertex counts'
    );

    return `L-Bracket (${outA.stats.vertexCount} verts, ${prepA.metrics.holeContourCount} hole, ${outA.stats.dimensions.x}×${outA.stats.dimensions.y}×${outA.stats.dimensions.z}u) != Wide Wedge (${outB.stats.vertexCount} verts, ${outB.stats.dimensions.x}×${outB.stats.dimensions.y}×${outB.stats.dimensions.z}u)`;
  });

  // 2. Mug Sketch (Lathe + Extruded Handle) & Table Sketch + IntentLock Measurable Geometry/Material Impact
  await runCase('2. Mug & Table Sketches + IntentLock Measurable Output Effect', async () => {
    // 2A: Ceramic Mug (symmetric cylinder body + right-side D-handle with hole)
    const mug = createRgbaCanvas(360, 360);
    mug.fillRect(95, 75, 130, 210, [20, 25, 35, 255]); // Symmetric mug cylinder body
    mug.fillRect(225, 115, 58, 120, [20, 25, 35, 255]); // Right handle outer
    mug.fillRect(225, 140, 34, 70, [255, 255, 255, 255]); // Right handle aperture hole

    const prepMug = preprocessRgbaPixels(mug.rgba, 360, 360);
    assert(
      prepMug.metrics.unilateralAppendageSide === 'right',
      `Expected right handle detection, got ${prepMug.metrics.unilateralAppendageSide}`
    );
    assert(prepMug.metrics.rotationalProfileSuitable, 'Mug core body should qualify for rotational profile');

    const solidMugSpec = compileIntentReconstructionSpec(
      { objectType: 'Ceramic Mug', material: 'Ceramic', colour: 'Cobalt blue', style: 'Artisanal' },
      makeBaseAnalysis('Ceramic Mug'),
      {
        locked: true,
        lockedAt: new Date().toISOString(),
        decisions: [
          {
            uncertaintyId: 'u1',
            featureName: 'Interior cavity',
            selectedOption: 'Solid closed block',
            customCorrection: '',
            finalValue: 'Solid closed block',
            wasCorrected: true,
          },
        ],
        additionalNotes: '',
        originalSketchSha256: 'test_mug',
      }
    );
    // Override objectName keyword so solid vs hollow comparison strictly tests IntentLock decision
    const solidSpecExplicit = { ...solidMugSpec, isHollowVessel: false };
    const hollowMugSpec = compileIntentReconstructionSpec(
      { objectType: 'Ceramic Mug', material: 'Ceramic', colour: 'Cobalt blue', style: 'Artisanal' },
      makeBaseAnalysis('Ceramic Mug'),
      {
        locked: true,
        lockedAt: new Date().toISOString(),
        decisions: [
          {
            uncertaintyId: 'u1',
            featureName: 'Interior cavity',
            selectedOption: 'Hollow open vessel interior',
            customCorrection: '',
            finalValue: 'Hollow open vessel interior',
            wasCorrected: true,
          },
        ],
        additionalNotes: '',
        originalSketchSha256: 'test_mug',
      }
    );

    const outSolidMug = await reconstructOffline3DFromPreprocessed(prepMug, solidSpecExplicit);
    const outHollowMug = await reconstructOffline3DFromPreprocessed(prepMug, hollowMugSpec);

    assert(outHollowMug.modeUsed === 'lathe_with_handle', `Expected lathe_with_handle, got ${outHollowMug.modeUsed}`);
    assert(outHollowMug.stats.nonEmptyMeshCount >= 2, 'Mug should contain vessel mesh + handle mesh');
    assert(
      outHollowMug.stats.vertexCount > outSolidMug.stats.vertexCount,
      `Hollow vessel IntentLock should add interior wall vertices (${outHollowMug.stats.vertexCount} vs ${outSolidMug.stats.vertexCount})`
    );

    // 2B: Side Table with lower legs + IntentLock depth override ("slim shallow" vs "deep wide")
    const table = createRgbaCanvas(380, 320);
    table.fillRect(50, 70, 280, 42, [20, 25, 35, 255]); // Tabletop slab
    table.fillRect(72, 112, 30, 155, [20, 25, 35, 255]); // Left leg
    table.fillRect(278, 112, 30, 155, [20, 25, 35, 255]); // Right leg

    const prepTable = preprocessRgbaPixels(table.rgba, 380, 320);
    assert(prepTable.metrics.hasBottomLegGap, 'Table sketch must detect bottom leg gap');
    assert(prepTable.metrics.detectedLowerColumnCount >= 2, 'Table sketch must detect >=2 lower leg columns');

    const slimSpec = compileIntentReconstructionSpec(
      { objectType: 'Console Table', material: 'Oak', colour: '#1e40af', style: 'Slim' },
      makeBaseAnalysis('Console Table'),
      {
        locked: true,
        lockedAt: new Date().toISOString(),
        decisions: [
          {
            uncertaintyId: 'd1',
            featureName: 'Table depth',
            selectedOption: 'Slim shallow narrow console profile',
            customCorrection: '',
            finalValue: 'Slim shallow narrow console profile',
            wasCorrected: true,
          },
        ],
        additionalNotes: '',
        originalSketchSha256: 'test_table',
      }
    );

    const deepSpec = compileIntentReconstructionSpec(
      { objectType: 'Dining Table', material: 'Walnut', colour: '#991b1b', style: 'Deep' },
      makeBaseAnalysis('Dining Table'),
      {
        locked: true,
        lockedAt: new Date().toISOString(),
        decisions: [
          {
            uncertaintyId: 'd1',
            featureName: 'Table depth',
            selectedOption: 'Deep wide four-leg dining frame',
            customCorrection: '',
            finalValue: 'Deep wide four-leg dining frame',
            wasCorrected: true,
          },
        ],
        additionalNotes: '',
        originalSketchSha256: 'test_table',
      }
    );

    const outSlim = await reconstructOffline3DFromPreprocessed(prepTable, slimSpec);
    const outDeep = await reconstructOffline3DFromPreprocessed(prepTable, deepSpec);
    assert(
      outDeep.stats.dimensions.z > outSlim.stats.dimensions.z * 1.5,
      `IntentLock depth change must alter 3D Z-extent: deep=${outDeep.stats.dimensions.z} vs slim=${outSlim.stats.dimensions.z}`
    );
    assert(slimSpec.primaryHex === '#1e40af' && deepSpec.primaryHex === '#991b1b', 'Hex colour compilation mismatch');

    return `Mug (${outHollowMug.modeUsed}, hollow=${outHollowMug.stats.vertexCount}v > solid=${outSolidMug.stats.vertexCount}v); Table Z-depth slim=${outSlim.stats.dimensions.z}u vs deep=${outDeep.stats.dimensions.z}u`;
  });

  // 3. Transparent PNG Alpha Compositing
  await runCase('3. Transparent PNG Alpha Compositing & 1:1 Centered White Padding', async () => {
    // Transparent pixels have RGB=(0,0,0) and Alpha=0 (classic transparent PNG export trap!)
    const trans = createRgbaCanvas(300, 220, [0, 0, 0, 0]);
    trans.fillRect(90, 50, 120, 120, [15, 23, 42, 255]);

    const prep = preprocessRgbaPixels(trans.rgba, 300, 220, { squareSize: 512 });
    assert(prep.metrics.hasTransparency, 'Should detect transparent pixels');
    assert(prep.metrics.hasForeground, 'Should detect opaque stroke foreground');
    assert(
      prep.metrics.bbox.width >= 118 && prep.metrics.bbox.width <= 124,
      `Alpha=0 black pixels must composite to white, not foreground; got bbox width ${prep.metrics.bbox.width}`
    );
    assert(
      prep.preparedWidth === 512 && prep.preparedHeight === 512,
      'Prepared image must be 512x512 square'
    );
    // Verify top-left corner of preparedRgba is pure white (255,255,255,255)
    assert(
      prep.preparedRgba[0] === 255 &&
        prep.preparedRgba[1] === 255 &&
        prep.preparedRgba[2] === 255 &&
        prep.preparedRgba[3] === 255,
      'Prepared corner pixel is not pure opaque white #FFFFFF'
    );

    return `Composited ${(prep.metrics.transparentPixelRatio * 100).toFixed(1)}% transparent pixels on #FFFFFF; extracted ${prep.metrics.bbox.width}×${prep.metrics.bbox.height}px bbox`;
  });

  // 4. Noisy Photographed Sketch with Uneven Illumination Shadow
  await runCase('4. Noisy Photographed Paper Sketch Illumination Flattening', async () => {
    const w = 320;
    const h = 280;
    const noisy = new Uint8ClampedArray(w * h * 4);
    // Simulate a heavy camera shadow gradient from 125 (dark corner) to 242 (bright corner) + deterministic grain
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const grad = 125 + (x / w) * 65 + (y / h) * 52;
        const grain = ((x * 73 + y * 37) % 11) - 5;
        const lum = Math.max(0, Math.min(255, Math.round(grad + grain)));
        const idx = (y * w + x) * 4;
        noisy[idx] = lum;
        noisy[idx + 1] = lum;
        noisy[idx + 2] = lum;
        noisy[idx + 3] = 255;
      }
    }
    // Draw a dark central ink box [110..210, 80..200]
    for (let y = 80; y < 200; y++) {
      for (let x = 110; x < 210; x++) {
        const idx = (y * w + x) * 4;
        noisy[idx] = 28;
        noisy[idx + 1] = 28;
        noisy[idx + 2] = 32;
      }
    }

    const prepUncorrected = preprocessRgbaPixels(noisy, w, h, { illuminationCorrection: false });
    const prepCorrected = preprocessRgbaPixels(noisy, w, h, { illuminationCorrection: true });

    assert(
      prepUncorrected.metrics.estimatedIlluminationUnevenness > 0.12,
      `Expected uneven lighting detection >0.12, got ${prepUncorrected.metrics.estimatedIlluminationUnevenness}`
    );
    assert(
      prepCorrected.metrics.bbox.width >= 96 &&
        prepCorrected.metrics.bbox.width <= 112 &&
        prepCorrected.metrics.bbox.height >= 116 &&
        prepCorrected.metrics.bbox.height <= 132,
      `Illumination correction failed to isolate central sketch bbox: got ${prepCorrected.metrics.bbox.width}x${prepCorrected.metrics.bbox.height}`
    );

    return `Shadow spread ${(prepUncorrected.metrics.estimatedIlluminationUnevenness * 100).toFixed(1)}% flattened; isolated ${prepCorrected.metrics.bbox.width}×${prepCorrected.metrics.bbox.height}px stroke bbox`;
  });

  // 5. Empty & Blank Uploads (Honest Offline Rejection + Live HTTP 400 Guards)
  await runCase('5. Empty Uploads & Blank Sketch Honesty Guards', async () => {
    const blank = createRgbaCanvas(256, 256, [255, 255, 255, 255]);
    const prepBlank = preprocessRgbaPixels(blank.rgba, 256, 256);
    assert(!prepBlank.metrics.hasForeground, 'Blank white canvas must report hasForeground=false');

    let caughtBlankCode = '';
    try {
      await reconstructOffline3DFromPreprocessed(
        prepBlank,
        compileIntentReconstructionSpec(
          { objectType: '', material: '', colour: '', style: '' },
          makeBaseAnalysis('Blank'),
          null
        )
      );
    } catch (err: unknown) {
      if (err instanceof OfflineReconstructionError) {
        caughtBlankCode = err.code;
      }
    }
    assert(
      caughtBlankCode === 'BLANK_OR_EMPTY_SKETCH',
      `Blank sketch must throw BLANK_OR_EMPTY_SKETCH, got "${caughtBlankCode}"`
    );

    // Live Express endpoint check if server is listening on port 3000
    const emptyFd = new FormData();
    emptyFd.append('sketch', new Blob([], { type: 'image/png' }), 'empty.png');
    const rEmpty = await fetch('http://127.0.0.1:3000/api/sketch/analyze', {
      method: 'POST',
      body: emptyFd,
    });
    const jEmpty = (await rEmpty.json()) as { error?: { code?: string } };
    assert(
      rEmpty.status === 400 && jEmpty.error?.code === 'EMPTY_SKETCH_FILE',
      `Expected HTTP 400 EMPTY_SKETCH_FILE, got ${rEmpty.status} ${jEmpty.error?.code}`
    );

    const missingFd = new FormData();
    const rMissing = await fetch('http://127.0.0.1:3000/api/sketch/analyze', {
      method: 'POST',
      body: missingFd,
    });
    const jMissing = (await rMissing.json()) as { error?: { code?: string } };
    assert(
      rMissing.status === 400 && jMissing.error?.code === 'MISSING_SKETCH_FILE',
      `Expected HTTP 400 MISSING_SKETCH_FILE, got ${rMissing.status} ${jMissing.error?.code}`
    );

    return 'Blank sketch rejected honestly (BLANK_OR_EMPTY_SKETCH); 0-byte & missing uploads rejected with HTTP 400';
  });

  // 6. Disguised Non-Image Files
  await runCase('6. Disguised SVG / HTML / JSON Files Named .png/.jpg Rejected via Magic Bytes', async () => {
    const payloads = [
      { name: 'vector.png', mime: 'image/png', text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
      { name: 'page.jpg', mime: 'image/jpeg', text: '<!doctype html><html><body>not a jpg</body></html>' },
      { name: 'data.webp', mime: 'image/webp', text: '{"fake":"webp_payload_123456"}' },
    ];

    for (const p of payloads) {
      const fd = new FormData();
      fd.append('sketch', new Blob([p.text], { type: p.mime }), p.name);
      const resp = await fetch('http://127.0.0.1:3000/api/sketch/analyze', {
        method: 'POST',
        body: fd,
      });
      const body = (await resp.json()) as { error?: { code?: string } };
      assert(
        resp.status === 415 && body.error?.code === 'UNSUPPORTED_FILE_FORMAT',
        `Disguised file ${p.name} was not rejected with 415 UNSUPPORTED_FILE_FORMAT (got ${resp.status})`
      );
    }

    return 'Rejected disguised SVG, HTML, and JSON payloads with HTTP 415 UNSUPPORTED_FILE_FORMAT';
  });

  // 7. Truncated GLB Rejection (Server Header Verifier + Client GLTFLoader Validator)
  await runCase('7. Truncated GLB Binary Rejection (declaredLength > byteLength)', async () => {
    const truncArrayBuf = new ArrayBuffer(64);
    const dv = new DataView(truncArrayBuf);
    dv.setUint32(0, 0x46546c67, true); // "glTF"
    dv.setUint32(4, 2, true); // version 2
    dv.setUint32(8, 4096, true); // declared 4096 bytes, actual 64 bytes!
    dv.setUint32(12, 256, true);
    dv.setUint32(16, 0x4e4f534a, true); // "JSON"

    const serverCheck = verifyGlbHeader(Buffer.from(truncArrayBuf));
    assert(!serverCheck.valid && /Truncated GLB/i.test(serverCheck.reason || ''), 'server verifyGlbHeader must reject truncated GLB');

    let clientErrCode = '';
    try {
      await validateAndParseGlbBuffer(truncArrayBuf);
    } catch (err: unknown) {
      if (err instanceof GlbValidationError) {
        clientErrCode = err.code;
      }
    }
    assert(
      clientErrCode === 'GLB_TRUNCATED_BUFFER',
      `Client validator expected GLB_TRUNCATED_BUFFER, got "${clientErrCode}"`
    );

    return 'Both server verifyGlbHeader() and client validateAndParseGlbBuffer() rejected truncated GLB';
  });

  // 8. Invalid Vertex Coordinates (NaN / Infinity) Rejection
  await runCase('8. Invalid Vertex Coordinates (NaN / Infinity) Rejected by Validator', async () => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x3b82f6 })
    );
    mesh.name = 'Corrupted_Box';
    const validGlb = await exportObjectToGlbBuffer(mesh);
    disposeObject3D(mesh);

    // Locate the BIN chunk (type 0x004E4942) inside the GLB and corrupt the first float32 vertex coordinate to NaN
    const corrupted = validGlb.slice(0);
    const dv = new DataView(corrupted);
    const jsonChunkLen = dv.getUint32(12, true);
    const binHeaderOffset = 20 + jsonChunkLen;
    const binChunkType = dv.getUint32(binHeaderOffset + 4, true);
    assert(binChunkType === 0x004e4942, 'Expected BIN chunk header in test GLB');

    // Overwrite first float32 in BIN payload with NaN
    dv.setFloat32(binHeaderOffset + 8, Number.NaN, true);

    let caughtCode = '';
    try {
      await validateAndParseGlbBuffer(corrupted);
    } catch (err: unknown) {
      if (err instanceof GlbValidationError) {
        caughtCode = err.code;
      }
    }
    assert(
      caughtCode === 'GLB_INVALID_VERTEX_COORDS',
      `Expected GLB_INVALID_VERTEX_COORDS when vertex buffer contains NaN, got "${caughtCode}"`
    );

    return 'Corrupted NaN vertex buffer strictly rejected with GLB_INVALID_VERTEX_COORDS';
  });

  // 9. Export Validation (.GLB vs .OBJ 1:1 Scale Parity + .MTL Companion + Schema/Tripo Unit Checks)
  await runCase('9. GLB vs OBJ 1:1 Scale Parity Under Viewer Scaling + MTL & Schema Normalization', async () => {
    const group = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.84, 0.42, 0.56),
      new THREE.MeshStandardMaterial({ name: 'walnut_base', color: 0x6b4423 })
    );
    base.position.set(0, 0.21, 0);
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, 0.65, 16),
      new THREE.MeshStandardMaterial({ name: 'brass_stem', color: 0xc59b49 })
    );
    column.position.set(0.1, 0.745, -0.05);
    group.add(base, column);

    const glbBuf = await exportObjectToGlbBuffer(group);
    disposeObject3D(group);

    const { scene: loadedScene, stats } = await validateAndParseGlbBuffer(glbBuf);

    // Mount loadedScene inside an aggressively scaled & translated parent wrapper (simulating ModelViewer3D)
    const viewerWrapper = new THREE.Group();
    viewerWrapper.scale.setScalar(3.45);
    viewerWrapper.position.set(4.2, -1.8, 2.5);
    viewerWrapper.add(loadedScene);
    viewerWrapper.updateMatrixWorld(true);

    const spec = compileIntentReconstructionSpec(
      { objectType: 'Pedestal Lamp', material: 'Brushed brass', colour: '#c59b49', style: 'Modern' },
      makeBaseAnalysis('Pedestal Lamp'),
      null
    );
    const { objText, mtlText } = exportObjectToObjAndMtl(loadedScene, 'pedestal_lamp', {
      inspectionMode: 'user_material',
      spec,
    });
    disposeObject3D(viewerWrapper);

    const objBounds = parseObjBoundingBox(objText);
    assert(
      Math.abs(objBounds.x - stats.dimensions.x) < 1e-3 &&
        Math.abs(objBounds.y - stats.dimensions.y) < 1e-3 &&
        Math.abs(objBounds.z - stats.dimensions.z) < 1e-3,
      `OBJ dimensions (${objBounds.x.toFixed(4)}×${objBounds.y.toFixed(4)}×${objBounds.z.toFixed(4)}) diverged from GLB (${stats.dimensions.x}×${stats.dimensions.y}×${stats.dimensions.z})`
    );
    assert(
      objText.includes('mtllib pedestal_lamp.mtl') && mtlText.includes('newmtl ') && mtlText.includes('Kd '),
      'OBJ/MTL companion material directives missing'
    );

    // Verify Gemini nested schema normalizer repairs missing uncertain_features[].options
    const repaired = validateAndNormalizeAnalysisPayload(
      {
        object_name: 'Test Stool',
        visible_components: ['Seat'],
        observed_features: ['Round top'],
        uncertain_features: [
          {
            id: 'leg_count',
            feature_name: 'Occluded rear leg count',
            uncertainty_reason: 'Only 2 front legs visible',
            // options intentionally omitted!
            default_assumption: '3-legged tripod',
            importance: 'critical',
          },
        ],
        inferred_features: ['Rear leg'],
        proportions_description: '1:1.2',
        material_preferences: {},
        reconstruction_notes: 'Keep round seat',
      },
      { objectType: '', material: 'Oak', colour: '', style: '' }
    );
    assert(repaired !== null, 'Normalizer should accept & repair missing nested options');
    const repairedUncertain = (repaired.uncertain_features as Array<{ options: string[] }>)[0];
    assert(
      Array.isArray(repairedUncertain.options) && repairedUncertain.options.length >= 2,
      'Normalizer must guarantee >=2 options on every uncertain feature'
    );

    // Verify Gemini SDK raw JSON error parser
    const parsedErr = parseGeminiSdkError(
      new Error('got status: 503. {"error":{"code":503,"message":"Model experiencing temporary demand spike.","status":"UNAVAILABLE"}}')
    );
    assert(
      parsedErr.cleanMessage === 'Model experiencing temporary demand spike.',
      `Expected clean SDK error message, got "${parsedErr.cleanMessage}"`
    );

    // Verify Tripo v3 error mapper & X-Tripo-Trace-ID extraction
    const mapped1004 = mapTripoError(400, { code: 1004, message: 'Invalid model parameter' }, 'trace_abc_99');
    assert(
      mapped1004.error.code === 'TRIPO_INVALID_PARAMETER' && mapped1004.error.requestId === 'trace_abc_99',
      'Tripo v3 #1004 or X-Tripo-Trace-ID mapping failed'
    );

    return `GLB (${stats.dimensions.x}×${stats.dimensions.y}×${stats.dimensions.z}u) === OBJ (${objBounds.x.toFixed(4)}×${objBounds.y.toFixed(4)}×${objBounds.z.toFixed(4)}u) + MTL + schema & v3 error checks verified`;
  });

  // 10. Fresh Chair Sketch — Three-Option Modular 3D Reconstruction, Structural Decomposition & SHA-256 Integrity
  await runCase('10. Fresh Chair Sketch -> Three Distinct 3D Options (A, B, C) & SHA-256 Integrity', async () => {
    const chairCanvas = createRgbaCanvas(420, 460);
    // Draw backrest, seat pan, and legs of a fresh armless dining/side chair sketch
    chairCanvas.fillRect(120, 55, 175, 145, [15, 23, 42, 255]); // Backrest
    chairCanvas.fillRect(115, 215, 195, 34, [15, 23, 42, 255]); // Seat slab
    chairCanvas.fillRect(122, 249, 24, 155, [15, 23, 42, 255]); // Left leg
    chairCanvas.fillRect(278, 249, 24, 155, [15, 23, 42, 255]); // Right leg

    const shaBefore = crypto.createHash('sha256').update(chairCanvas.rgba).digest('hex');
    const prepChair = preprocessRgbaPixels(chairCanvas.rgba, 420, 460);

    const chairAnalysis: SketchAnalysisResult = {
      ...makeBaseAnalysis('Mid-Century Side Chair'),
      visible_components: ['Backrest shell', 'Horizontal seat pan', 'Tapered front legs'],
      observed_features: ['Tilted backrest', 'Armless profile', 'Splayed lower legs'],
      object_category: 'chair',
      category_supported: true,
    };

    const threeOpts = await synthesizeThreeReconstructionOptions(
      prepChair,
      chairAnalysis,
      { objectType: 'Mid-Century Side Chair', material: 'Walnut & Oat Bouclé', colour: 'Walnut', style: 'Modern' },
      null
    );

    const shaAfter = crypto.createHash('sha256').update(chairCanvas.rgba).digest('hex');
    assert(shaBefore === shaAfter, 'Original sketch pixel buffer SHA-256 was mutated during 3D synthesis');
    assert(threeOpts.length === 3, `Expected 3 options, got ${threeOpts.length}`);

    const [optA, optB, optC] = threeOpts;
    assert(optA.option.id === 'sketch_faithful' && optA.glbBuffer && optA.stats, 'Option A GLB missing');
    assert(optB.option.id === 'structurally_refined' && optB.glbBuffer && optB.stats, 'Option B GLB missing');
    assert(optC.option.id === 'design_enhanced' && optC.glbBuffer && optC.stats, 'Option C GLB missing');

    // Verify chair is decomposed into real separate 3D parts (seat + backrest + 4 legs), NOT a 1-mesh silhouette block
    assert(
      optA.componentNames.some((n) => n.startsWith('Seat_')) &&
        optA.componentNames.some((n) => n.startsWith('Backrest_')) &&
        optA.componentNames.filter((n) => n.startsWith('Chair_Leg_')).length === 4,
      `Chair Option A missing separate seat/backrest/4-legs: ${optA.componentNames.join(', ')}`
    );
    // Verify armless chair strictly omits armrests
    assert(
      !optA.componentNames.some((n) => n.includes('Armrest')),
      'Armless chair sketch must not invent armrests'
    );
    // Verify Option B adds structural under-seat aprons and H-stretchers
    assert(
      optB.componentNames.some((n) => n.startsWith('Under_Seat_Apron_')) &&
        optB.componentNames.some((n) => n.startsWith('Stretcher_')),
      `Option B must include structural aprons & stretchers: ${optB.componentNames.join(', ')}`
    );
    // Verify Option C upgrades to waterfall seat cushion, curved ergonomic backrest shell, and brass ferrules
    assert(
      optC.componentNames.includes('Seat_Waterfall_Cushion') &&
        optC.componentNames.includes('Backrest_Ergonomic_Shell') &&
        optC.componentNames.some((n) => n.startsWith('Brass_Ferrule_')),
      `Option C must include sculpted waterfall cushion, curved backrest & ferrules: ${optC.componentNames.join(', ')}`
    );

    // Verify all three options produce measurably different 3D meshes
    const vA = optA.stats.vertexCount;
    const vB = optB.stats.vertexCount;
    const vC = optC.stats.vertexCount;
    assert(
      vA !== vB && vB !== vC && vA !== vC,
      `Options A, B, and C must have measurably distinct vertex counts; got A=${vA}, B=${vB}, C=${vC}`
    );

    // Verify IntentLock override ("Include armrests" + "3-legged tripod") measurably changes chair topology
    const overriddenOpts = await synthesizeThreeReconstructionOptions(
      prepChair,
      chairAnalysis,
      { objectType: 'Mid-Century Chair', material: 'Oak', colour: 'Oak', style: 'Modern' },
      {
        locked: true,
        lockedAt: new Date().toISOString(),
        decisions: [
          {
            uncertaintyId: 'u_arms',
            featureName: 'Armrest configuration',
            selectedOption: 'With armrests',
            customCorrection: '',
            finalValue: 'Include armrests and 3-legged tripod base',
            wasCorrected: true,
          },
        ],
        additionalNotes: '',
        originalSketchSha256: shaBefore,
      }
    );
    assert(
      overriddenOpts[0].componentNames.some((n) => n.includes('Armrest')) &&
        overriddenOpts[0].componentNames.filter((n) => n.startsWith('Tripod_Leg_')).length === 3,
      `IntentLock override failed to add armrests & 3-leg tripod: ${overriddenOpts[0].componentNames.join(', ')}`
    );

    // Verify 1:1 .GLB -> .OBJ/.MTL scale parity on Chair Option B
    const { scene: chairSceneB, stats: statsB } = await validateAndParseGlbBuffer(optB.glbBuffer);
    const { objText: chairObj } = exportObjectToObjAndMtl(chairSceneB, 'chair_opt_b');
    disposeObject3D(chairSceneB);
    const chairObjBounds = parseObjBoundingBox(chairObj);
    assert(
      Math.abs(chairObjBounds.x - statsB.dimensions.x) < 1e-3 &&
        Math.abs(chairObjBounds.y - statsB.dimensions.y) < 1e-3 &&
        Math.abs(chairObjBounds.z - statsB.dimensions.z) < 1e-3,
      'Chair Option B OBJ export scale diverged from GLB'
    );

    return `Chair A=${vA}v (${optA.componentNames.length} parts), B=${vB}v (${optB.componentNames.length} parts), C=${vC}v (${optC.componentNames.length} parts), SHA-256 preserved`;
  });

  // 11. Multi-Category Verification Across Table, Mug/Vessel, Lamp, Bookshelf & Mechanical Bracket
  await runCase('11. Multi-Category 3D Builders (Table, Mug, Lamp, Shelf, Bracket) -> Distinct A/B/C Meshes', async () => {
    // A. Table sketch
    const tbl = createRgbaCanvas(440, 320);
    tbl.fillRect(50, 70, 340, 36, [15, 23, 42, 255]);
    tbl.fillRect(72, 106, 26, 165, [15, 23, 42, 255]);
    tbl.fillRect(342, 106, 26, 165, [15, 23, 42, 255]);
    const tblOpts = await synthesizeThreeReconstructionOptions(
      preprocessRgbaPixels(tbl.rgba, 440, 320),
      { ...makeBaseAnalysis('Architectural Dining Table'), object_category: 'table' },
      { objectType: 'Dining Table', material: 'Oak', colour: 'Oak', style: 'Modern' },
      null
    );
    assert(
      tblOpts[0].componentNames.includes('Tabletop_Slab') &&
        tblOpts[1].componentNames.some((n) => n.startsWith('Table_Apron_')) &&
        tblOpts[0].stats!.vertexCount !== tblOpts[1].stats!.vertexCount &&
        tblOpts[1].stats!.vertexCount !== tblOpts[2].stats!.vertexCount,
      'Table A/B/C synthesis failed'
    );

    // B. Mug / Vessel sketch with right handle
    const mug = createRgbaCanvas(380, 380);
    mug.fillRect(95, 75, 165, 230, [15, 23, 42, 255]);
    mug.fillRect(260, 120, 62, 24, [15, 23, 42, 255]);
    mug.fillRect(298, 120, 24, 130, [15, 23, 42, 255]);
    mug.fillRect(260, 226, 62, 24, [15, 23, 42, 255]);
    const mugOpts = await synthesizeThreeReconstructionOptions(
      preprocessRgbaPixels(mug.rgba, 380, 380),
      { ...makeBaseAnalysis('Stoneware Coffee Mug'), object_category: 'mug_vessel' },
      { objectType: 'Coffee Mug', material: 'Stoneware', colour: 'Sand & Cobalt', style: 'Pottery' },
      null
    );
    assert(
      mugOpts[0].componentNames.includes('Lathed_Hollow_Vessel_Body') &&
        mugOpts[0].componentNames.includes('Vessel_Swept_Handle') &&
        mugOpts[1].componentNames.includes('Handle_Upper_Boss') &&
        mugOpts[2].componentNames.includes('Vessel_Glazed_Rim_Band') &&
        mugOpts[0].stats!.vertexCount < mugOpts[1].stats!.vertexCount &&
        mugOpts[1].stats!.vertexCount < mugOpts[2].stats!.vertexCount,
      `Mug/Vessel A/B/C synthesis failed: ${mugOpts[0].componentNames.join(', ')}`
    );

    // C. Lamp sketch (conical shade + narrow stem + wide base)
    const lmp = createRgbaCanvas(360, 440);
    lmp.fillRect(85, 55, 190, 120, [15, 23, 42, 255]); // Shade
    lmp.fillRect(168, 175, 24, 155, [15, 23, 42, 255]); // Stem
    lmp.fillRect(115, 330, 130, 55, [15, 23, 42, 255]); // Base
    const lampOpts = await synthesizeThreeReconstructionOptions(
      preprocessRgbaPixels(lmp.rgba, 360, 440),
      { ...makeBaseAnalysis('Table Lamp'), object_category: 'lamp' },
      { objectType: 'Table Lamp', material: 'Ceramic & Brass', colour: 'Terracotta', style: 'Minimalist' },
      null
    );
    assert(
      lampOpts[0].componentNames.includes('Lamp_Weighted_Base') &&
        lampOpts[0].componentNames.includes('Lamp_Central_Stem') &&
        lampOpts[0].componentNames.includes('Lamp_Diffuser_Shade') &&
        lampOpts[0].componentNames.includes('Lamp_Spider_Strut_1') &&
        lampOpts[2].componentNames.includes('Lamp_Finial_Cap') &&
        lampOpts[0].stats!.vertexCount !== lampOpts[1].stats!.vertexCount &&
        lampOpts[1].stats!.vertexCount !== lampOpts[2].stats!.vertexCount,
      'Lamp A/B/C synthesis failed'
    );

    // D. Multi-tier Bookshelf sketch
    const shf = createRgbaCanvas(380, 460);
    shf.fillRect(70, 45, 24, 370, [15, 23, 42, 255]); // Left upright
    shf.fillRect(286, 45, 24, 370, [15, 23, 42, 255]); // Right upright
    for (const y of [45, 135, 225, 315, 390]) {
      shf.fillRect(70, y, 240, 20, [15, 23, 42, 255]); // Horizontal shelves
    }
    const shelfOpts = await synthesizeThreeReconstructionOptions(
      preprocessRgbaPixels(shf.rgba, 380, 460),
      { ...makeBaseAnalysis('Open Architectural Bookshelf'), object_category: 'shelf_cabinet' },
      { objectType: 'Open Bookshelf', material: 'Walnut & Steel', colour: 'Walnut', style: 'Industrial' },
      null
    );
    assert(
      shelfOpts[0].componentNames.includes('Shelf_Side_Upright_Left') &&
        shelfOpts[0].componentNames.some((n) => n.startsWith('Shelf_Interior_Tier_')) &&
        shelfOpts[1].componentNames.includes('Shelf_Rear_CrossBrace_A') &&
        shelfOpts[0].stats!.vertexCount !== shelfOpts[1].stats!.vertexCount &&
        shelfOpts[1].stats!.vertexCount !== shelfOpts[2].stats!.vertexCount,
      'Bookshelf A/B/C synthesis failed'
    );

    // E. Mechanical Mounting Bracket with 2 bolt holes
    const brk = createRgbaCanvas(360, 320);
    brk.fillRect(60, 60, 240, 200, [15, 23, 42, 255]);
    brk.fillCircle(125, 160, 28, [255, 255, 255, 255]); // Bolt hole 1
    brk.fillCircle(235, 160, 28, [255, 255, 255, 255]); // Bolt hole 2
    const brkOpts = await synthesizeThreeReconstructionOptions(
      preprocessRgbaPixels(brk.rgba, 360, 320),
      { ...makeBaseAnalysis('CNC Mounting Bracket Plate'), object_category: 'bracket_mechanical' },
      { objectType: 'Mounting Bracket', material: 'Anodized Aluminum', colour: 'Silver', style: 'Precision CAD' },
      null
    );
    assert(
      brkOpts[0].componentNames.includes('Bracket_Machined_Plate_1') &&
        brkOpts[1].componentNames.some((n) => n.startsWith('Bracket_Mounting_Boss_')) &&
        brkOpts[1].componentNames.includes('Bracket_Base_Flange') &&
        brkOpts[0].stats!.vertexCount !== brkOpts[1].stats!.vertexCount &&
        brkOpts[1].stats!.vertexCount !== brkOpts[2].stats!.vertexCount,
      'Bracket A/B/C synthesis failed'
    );

    return `Verified Table (${tblOpts[1].stats!.vertexCount}v), Mug (${mugOpts[1].stats!.vertexCount}v), Lamp (${lampOpts[1].stats!.vertexCount}v), Shelf (${shelfOpts[1].stats!.vertexCount}v), Bracket (${brkOpts[1].stats!.vertexCount}v)`;
  });

  // 12. Honest Unsupported Category Handling (Organic / Freeform Subjects)
  await runCase('12. Honest Unsupported Category Rejection (No Misleading Fabricated Blocks)', async () => {
    const organicCanvas = createRgbaCanvas(320, 320);
    organicCanvas.fillCircle(160, 160, 85, [15, 23, 42, 255]);
    const prepOrganic = preprocessRgbaPixels(organicCanvas.rgba, 320, 320);

    const dogOpts = await synthesizeThreeReconstructionOptions(
      prepOrganic,
      makeBaseAnalysis('Golden Retriever Dog'),
      { objectType: 'Golden Retriever Dog', material: '', colour: '', style: '' },
      null
    );

    assert(dogOpts.length === 3, 'Should return 3 option metadata cards explaining unsupported status');
    for (const item of dogOpts) {
      assert(item.category === 'unsupported', `Expected unsupported category, got ${item.category}`);
      assert(item.option.supported === false, 'Option supported flag must be false for organic animal');
      assert(item.glbBuffer === null && item.stats === null, 'Must not fabricate blocky GLB mesh for unsupported organic subject');
      assert(Boolean(item.option.unsupported_reason && item.option.unsupported_reason.length > 20), 'Must provide clear unsupported_reason');
    }

    return `Organic subject honestly classified as unsupported (${dogOpts[0].option.unsupported_reason?.slice(0, 68)}…)`;
  });

  const passedCount = results.filter((r) => r.passed).length;
  console.log(`\n=== Summary: ${passedCount}/${results.length} test suites passed ===\n`);

  if (passedCount !== results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
