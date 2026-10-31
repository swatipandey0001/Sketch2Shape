import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type {
  CompiledReconstructionSpec,
  ValidatedMeshStats,
  ViewerInspectionMode,
} from '../types/studio';

export class GlbValidationError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GlbValidationError';
    this.code = code;
  }
}

/**
 * Polyfills minimal FileReader in Node.js (e.g. automated tsx test runner) so Three.js GLTFExporter
 * binary serialization runs identically in headless Node and browser runtimes.
 */
export function ensureFileReaderPolyfill(): void {
  if (typeof globalThis.FileReader !== 'undefined') return;

  class MinimalNodeFileReader {
    public result: ArrayBuffer | string | null = null;
    public onloadend: (() => void) | null = null;
    public onload: (() => void) | null = null;
    public onerror: ((err: unknown) => void) | null = null;

    readAsArrayBuffer(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = buf;
          this.onload?.();
          this.onloadend?.();
        })
        .catch((err) => {
          this.onerror?.(err);
        });
    }

    readAsDataURL(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buf) => {
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const b64 =
            typeof Buffer !== 'undefined'
              ? Buffer.from(buf).toString('base64')
              : btoa(binary);
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
          this.onload?.();
          this.onloadend?.();
        })
        .catch((err) => {
          this.onerror?.(err);
        });
    }
  }

  (globalThis as unknown as { FileReader: unknown }).FileReader = MinimalNodeFileReader;
}

/**
 * Validates binary GLB header, chunk integrity, finite vertex coordinates, and 3D volume:
 * 1. Magic bytes === 0x46546C67 ("glTF") and version === 2
 * 2. Declared header byte length >= 20 and actual buffer.byteLength >= declaredLength (rejects truncated GLBs)
 * 3. First chunk is JSON (0x4E4F534A) and fits inside declaredLength
 * 4. Parses cleanly via Three.js GLTFLoader
 * 5. Rejects any NaN or Infinity vertex coordinates
 * 6. Contains >= 1 non-empty THREE.Mesh and non-zero 3D bounding-box extents on X, Y, and Z
 */
export async function validateAndParseGlbBuffer(
  buffer: ArrayBuffer
): Promise<{ scene: THREE.Group; stats: ValidatedMeshStats }> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  if (!buffer || buffer.byteLength < 20) {
    throw new GlbValidationError(
      'GLB_EMPTY_BUFFER',
      'Downloaded GLB file is empty or smaller than the 20-byte glTF 2.0 header + chunk prefix.'
    );
  }

  const headerView = new DataView(buffer, 0, 20);
  const magic = headerView.getUint32(0, true);
  const glbVersion = headerView.getUint32(4, true);
  const declaredLength = headerView.getUint32(8, true);
  const chunk0Length = headerView.getUint32(12, true);
  const chunk0Type = headerView.getUint32(16, true);

  // 0x46546C67 === "glTF"
  if (magic !== 0x46546c67) {
    throw new GlbValidationError(
      'GLB_INVALID_MAGIC',
      'File binary signature is not a valid glTF/GLB 3D model. Static images and non-GLB payloads are rejected.'
    );
  }

  if (glbVersion !== 2) {
    throw new GlbValidationError(
      'GLB_UNSUPPORTED_VERSION',
      `Unsupported glTF binary container version ${glbVersion} (expected glTF 2.0).`
    );
  }

  if (declaredLength < 20 || buffer.byteLength < declaredLength) {
    throw new GlbValidationError(
      'GLB_TRUNCATED_BUFFER',
      `Truncated GLB binary detected: header declares ${declaredLength} bytes, but buffer contains only ${buffer.byteLength} bytes.`
    );
  }

  // 0x4E4F534A === "JSON"
  if (chunk0Type !== 0x4e4f534a || chunk0Length === 0 || 20 + chunk0Length > declaredLength) {
    throw new GlbValidationError(
      'GLB_CORRUPT_JSON_CHUNK',
      'GLB binary JSON chunk header is malformed or exceeds declared container length.'
    );
  }

  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  loader.setDRACOLoader(dracoLoader);

  let gltfScene: THREE.Group;
  try {
    const parsed = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      loader.parse(
        buffer,
        '',
        (gltf) => resolve({ scene: gltf.scene }),
        (err) => reject(err)
      );
    });
    gltfScene = parsed.scene;
  } catch (err: unknown) {
    dracoLoader.dispose();
    throw new GlbValidationError(
      'GLTF_PARSE_FAILED',
      `Three.js GLTFLoader failed to parse model: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    dracoLoader.dispose();
  }

  gltfScene.updateMatrixWorld(true);

  let meshCount = 0;
  let nonEmptyMeshCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let invalidCoordMeshName = '';

  gltfScene.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      meshCount += 1;
      const posAttr = mesh.geometry?.attributes?.position;
      if (posAttr && posAttr.count > 0) {
        for (let i = 0; i < posAttr.count; i++) {
          const vx = posAttr.getX(i);
          const vy = posAttr.getY(i);
          const vz = posAttr.getZ(i);
          if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
            invalidCoordMeshName = mesh.name || `Mesh_${meshCount}`;
            break;
          }
        }
        nonEmptyMeshCount += 1;
        vertexCount += posAttr.count;
        if (mesh.geometry.index) {
          triangleCount += Math.floor(mesh.geometry.index.count / 3);
        } else {
          triangleCount += Math.floor(posAttr.count / 3);
        }
      }
    }
  });

  if (invalidCoordMeshName) {
    disposeObject3D(gltfScene);
    throw new GlbValidationError(
      'GLB_INVALID_VERTEX_COORDS',
      `Model validation failed: mesh "${invalidCoordMeshName}" contains NaN or Infinity vertex coordinates.`
    );
  }

  if (nonEmptyMeshCount < 1 || vertexCount < 3 || triangleCount < 1) {
    disposeObject3D(gltfScene);
    throw new GlbValidationError(
      'GLB_NO_VALID_MESH',
      `Model validation failed: found ${nonEmptyMeshCount} non-empty meshes, ${vertexCount} vertices, and ${triangleCount} triangles. At least 1 valid 3D mesh is required.`
    );
  }

  gltfScene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltfScene, true);
  const size = new THREE.Vector3();
  box.getSize(size);

  const EPSILON = 1e-4;
  if (
    !Number.isFinite(size.x) ||
    !Number.isFinite(size.y) ||
    !Number.isFinite(size.z) ||
    size.x <= EPSILON ||
    size.y <= EPSILON ||
    size.z <= EPSILON
  ) {
    disposeObject3D(gltfScene);
    throw new GlbValidationError(
      'GLB_ZERO_DIMENSIONS',
      `Model validation failed: bounding box dimensions (${size.x.toFixed(4)} × ${size.y.toFixed(4)} × ${size.z.toFixed(4)}) are zero or planar.`
    );
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    scene: gltfScene,
    stats: {
      meshCount,
      nonEmptyMeshCount,
      vertexCount,
      triangleCount,
      dimensions: {
        x: Number(size.x.toFixed(4)),
        y: Number(size.y.toFixed(4)),
        z: Number(size.z.toFixed(4)),
      },
      fileSizeBytes: buffer.byteLength,
      declaredLengthBytes: declaredLength,
      glbVersion,
      validationDurationMs: Number((t1 - t0).toFixed(1)),
      validatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Serializes any Three.js Object3D hierarchy into a genuine glTF 2.0 binary (.glb) ArrayBuffer.
 */
export async function exportObjectToGlbBuffer(root: THREE.Object3D): Promise<ArrayBuffer> {
  ensureFileReaderPolyfill();
  root.updateMatrixWorld(true);
  const exporter = new GLTFExporter();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          reject(new Error('Expected binary ArrayBuffer from GLTFExporter.'));
        }
      },
      (error) => reject(error),
      { binary: true }
    );
  });
}

function sanitizeMtlName(raw: string): string {
  return (
    raw
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'material_0'
  );
}

/**
 * Exports Wavefront .OBJ + companion .MTL materials strictly in the source model's coordinate space
 * (excluding any parent viewer normalization wrapper transforms, so .OBJ scale matches .GLB 1:1).
 */
export function exportObjectToObjAndMtl(
  sourceRoot: THREE.Object3D,
  baseSlug = 'sketch2shape_model',
  options?: {
    inspectionMode?: ViewerInspectionMode;
    spec?: CompiledReconstructionSpec | null;
  }
): {
  objText: string;
  mtlText: string;
  objBlob: Blob;
  mtlBlob: Blob;
} {
  sourceRoot.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(sourceRoot.matrixWorld).invert();

  const mtlFileName = `${baseSlug}.mtl`;
  const objLines: string[] = [
    '# Sketch2Shape — IntentLock 3D Wavefront OBJ Export',
    '# Coordinates match source GLB model space (1:1 unmutated scale)',
    `mtllib ${mtlFileName}`,
    '',
  ];
  const mtlLines: string[] = ['# Sketch2Shape — IntentLock 3D Wavefront MTL Companion', ''];
  const definedMtls = new Set<string>();

  let vertexOffset = 1;
  let normalOffset = 1;
  let uvOffset = 1;
  let meshSeq = 0;

  const tmpPos = new THREE.Vector3();
  const tmpNorm = new THREE.Vector3();
  const relMatrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();

  sourceRoot.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geom = mesh.geometry;
    const posAttr = geom.attributes.position;
    if (!posAttr || posAttr.count === 0) return;

    meshSeq += 1;
    const objName = sanitizeMtlName(mesh.name || `mesh_${meshSeq}`);
    objLines.push(`o ${objName}`);

    // Compute transform strictly relative to sourceRoot so parent viewer scaling is excluded
    relMatrix.multiplyMatrices(rootInverse, mesh.matrixWorld);
    normalMatrix.getNormalMatrix(relMatrix);

    // Resolve material properties
    const rawMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const stdMat = rawMat as THREE.MeshStandardMaterial | undefined;

    let color = stdMat?.color ? stdMat.color.clone() : new THREE.Color(0x94a3b8);
    let roughness = typeof stdMat?.roughness === 'number' ? stdMat.roughness : 0.5;
    let metalness = typeof stdMat?.metalness === 'number' ? stdMat.metalness : 0.1;
    let opacity = typeof stdMat?.opacity === 'number' ? stdMat.opacity : 1.0;

    if (options?.inspectionMode === 'clay_topology') {
      color = new THREE.Color(0xd6d3d1);
      roughness = 0.78;
      metalness = 0.04;
      opacity = 1.0;
    } else if (options?.inspectionMode === 'user_material' && options.spec) {
      const hex = meshSeq % 2 === 0 ? options.spec.secondaryHex : options.spec.primaryHex;
      color = new THREE.Color(hex);
      roughness = options.spec.roughness;
      metalness = options.spec.metalness;
      opacity = options.spec.opacity;
    }

    const mtlName = sanitizeMtlName(
      options?.inspectionMode === 'user_material'
        ? `intentlock_${meshSeq % 2 === 0 ? 'secondary' : 'primary'}`
        : options?.inspectionMode === 'clay_topology'
          ? 'studio_clay'
          : stdMat?.name || `mat_${meshSeq}`
    );

    if (!definedMtls.has(mtlName)) {
      definedMtls.add(mtlName);
      const specStrength = Number((0.08 + (1 - roughness) * 0.75).toFixed(4));
      const shininess = Number(Math.max(4, (1 - roughness) * 240).toFixed(2));
      mtlLines.push(`newmtl ${mtlName}`);
      mtlLines.push('Ka 0.0800 0.0800 0.0800');
      mtlLines.push(`Kd ${color.r.toFixed(4)} ${color.g.toFixed(4)} ${color.b.toFixed(4)}`);
      mtlLines.push(`Ks ${specStrength} ${specStrength} ${specStrength}`);
      mtlLines.push(`Ns ${shininess}`);
      mtlLines.push(`d ${opacity.toFixed(4)}`);
      mtlLines.push(`Pr ${roughness.toFixed(4)}`);
      mtlLines.push(`Pm ${metalness.toFixed(4)}`);
      mtlLines.push('illum 2');
      mtlLines.push('');
    }

    // Emit vertices
    for (let i = 0; i < posAttr.count; i++) {
      tmpPos.fromBufferAttribute(posAttr, i).applyMatrix4(relMatrix);
      objLines.push(`v ${tmpPos.x.toFixed(6)} ${tmpPos.y.toFixed(6)} ${tmpPos.z.toFixed(6)}`);
    }

    const normAttr = geom.attributes.normal;
    if (normAttr && normAttr.count === posAttr.count) {
      for (let i = 0; i < normAttr.count; i++) {
        tmpNorm.fromBufferAttribute(normAttr, i).applyMatrix3(normalMatrix).normalize();
        objLines.push(`vn ${tmpNorm.x.toFixed(6)} ${tmpNorm.y.toFixed(6)} ${tmpNorm.z.toFixed(6)}`);
      }
    }

    const uvAttr = geom.attributes.uv;
    if (uvAttr && uvAttr.count === posAttr.count) {
      for (let i = 0; i < uvAttr.count; i++) {
        objLines.push(`vt ${uvAttr.getX(i).toFixed(6)} ${uvAttr.getY(i).toFixed(6)}`);
      }
    }

    objLines.push(`usemtl ${mtlName}`);

    const hasUv = Boolean(uvAttr && uvAttr.count === posAttr.count);
    const hasNorm = Boolean(normAttr && normAttr.count === posAttr.count);

    const fmtRef = (localIdx: number): string => {
      const vi = vertexOffset + localIdx;
      const ti = uvOffset + localIdx;
      const ni = normalOffset + localIdx;
      if (hasUv && hasNorm) return `${vi}/${ti}/${ni}`;
      if (hasUv) return `${vi}/${ti}`;
      if (hasNorm) return `${vi}//${ni}`;
      return `${vi}`;
    };

    const indexAttr = geom.index;
    if (indexAttr) {
      for (let i = 0; i + 2 < indexAttr.count; i += 3) {
        const a = indexAttr.getX(i);
        const b = indexAttr.getX(i + 1);
        const c = indexAttr.getX(i + 2);
        objLines.push(`f ${fmtRef(a)} ${fmtRef(b)} ${fmtRef(c)}`);
      }
    } else {
      for (let i = 0; i + 2 < posAttr.count; i += 3) {
        objLines.push(`f ${fmtRef(i)} ${fmtRef(i + 1)} ${fmtRef(i + 2)}`);
      }
    }

    objLines.push('');
    vertexOffset += posAttr.count;
    if (hasNorm) normalOffset += normAttr.count;
    if (hasUv) uvOffset += uvAttr.count;
  });

  const objText = objLines.join('\n');
  const mtlText = mtlLines.join('\n');

  return {
    objText,
    mtlText,
    objBlob: new Blob([objText], { type: 'text/plain;charset=utf-8' }),
    mtlBlob: new Blob([mtlText], { type: 'text/plain;charset=utf-8' }),
  };
}

/**
 * Backwards-compatible Wavefront .obj Blob helper (unmutated source scale).
 */
export function exportObjectToObjBlob(root: THREE.Object3D): Blob {
  return exportObjectToObjAndMtl(root).objBlob;
}

/**
 * Thoroughly disposes all geometries, materials, and textures on a Three.js hierarchy to prevent GPU leaks.
 */
export function disposeObject3D(root: THREE.Object3D | null | undefined) {
  if (!root) return;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : mesh.material
          ? [mesh.material]
          : [];
      for (const mat of materials) {
        const stdMat = mat as THREE.MeshStandardMaterial;
        stdMat.map?.dispose();
        stdMat.normalMap?.dispose();
        stdMat.roughnessMap?.dispose();
        stdMat.metalnessMap?.dispose();
        stdMat.aoMap?.dispose();
        stdMat.emissiveMap?.dispose();
        mat.dispose();
      }
    }
  });
}

/**
 * Builds a genuine binary .glb buffer of a 9-part mid-century chair strictly for the
 * Diagnostics Viewer & Validator Self-Test (explicitly badged as local calibration mesh, never presented as user generation).
 */
export async function buildCalibrationChairGlbBuffer(): Promise<ArrayBuffer> {
  const chairGroup = new THREE.Group();
  chairGroup.name = 'Calibration_Lounge_Chair';

  const woodMat = new THREE.MeshStandardMaterial({
    name: 'calibration_walnut',
    color: 0x6b4423,
    roughness: 0.45,
    metalness: 0.08,
  });
  const cushionMat = new THREE.MeshStandardMaterial({
    name: 'calibration_boucle',
    color: 0xe7e2d8,
    roughness: 0.82,
    metalness: 0.02,
  });
  const brassMat = new THREE.MeshStandardMaterial({
    name: 'calibration_brass',
    color: 0xc59b49,
    roughness: 0.25,
    metalness: 0.85,
  });

  const seatFrame = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.045, 0.56), woodMat);
  seatFrame.name = 'Seat_Frame';
  seatFrame.position.set(0, 0.41, 0);
  chairGroup.add(seatFrame);

  const seatCushion = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.075, 0.52), cushionMat);
  seatCushion.name = 'Seat_Cushion';
  seatCushion.position.set(0, 0.47, 0.01);
  chairGroup.add(seatCushion);

  const backrest = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.42, 0.045), woodMat);
  backrest.name = 'Backrest_Shell';
  backrest.position.set(0, 0.72, -0.25);
  backrest.rotation.x = -0.18;
  chairGroup.add(backrest);

  const backPad = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.04), cushionMat);
  backPad.name = 'Lumbar_Pad';
  backPad.position.set(0, 0.72, -0.22);
  backPad.rotation.x = -0.18;
  chairGroup.add(backPad);

  const legPositions: Array<[number, number, number, number]> = [
    [-0.24, 0.205, 0.22, 0.06],
    [0.24, 0.205, 0.22, -0.06],
    [-0.24, 0.205, -0.22, 0.08],
    [0.24, 0.205, -0.22, -0.08],
  ];

  legPositions.forEach(([lx, ly, lz, tilt], idx) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.015, 0.41, 16), woodMat);
    leg.position.set(lx, ly, lz);
    leg.rotation.z = tilt;
    leg.name = `Chair_Leg_${idx + 1}`;
    chairGroup.add(leg);
  });

  [-0.29, 0.29].forEach((ax, idx) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.03, 0.46), woodMat);
    arm.position.set(ax, 0.62, -0.02);
    arm.name = `Armrest_${idx + 1}`;
    chairGroup.add(arm);

    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.19, 12), brassMat);
    post.name = `Armrest_Post_${idx + 1}`;
    post.position.set(ax, 0.52, 0.16);
    chairGroup.add(post);
  });

  const binaryResult = await exportObjectToGlbBuffer(chairGroup);
  disposeObject3D(chairGroup);
  return binaryResult;
}

export function triggerBrowserDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1500);
}
