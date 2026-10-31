import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  AlertTriangle,
  Box,
  ChevronDown,
  ChevronUp,
  Download,
  FileDown,
  Grid3x3,
  Image as ImageIcon,
  Palette,
  RotateCcw,
} from 'lucide-react';
import type {
  CompiledReconstructionSpec,
  ReconstructionSource,
  ValidatedMeshStats,
  ViewerInspectionMode,
} from '../types/studio';
import {
  disposeObject3D,
  exportObjectToObjAndMtl,
  triggerBrowserDownload,
  validateAndParseGlbBuffer,
} from '../utils/glbValidator';

interface ModelViewer3DProps {
  glbBuffer: ArrayBuffer;
  modelName: string;
  provenanceLabel: string;
  reconstructionSource?: ReconstructionSource;
  reconstructionSpec?: CompiledReconstructionSpec | null;
  originalSketchUrl?: string | null;
  originalSketchSha256?: string;
  isCalibrationSample?: boolean;
  onStatsValidated?: (stats: ValidatedMeshStats) => void;
}

type CameraPreset = 'isometric' | 'front' | 'side' | 'top';

// Reusable module-scope math temporaries (zero per-frame GC allocations)
const _targetCamPos = new THREE.Vector3();
const _targetLookAt = new THREE.Vector3(0, 0.5, 0);

const detectSoftwareWebGL = (): boolean => {
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function disposeTransientMaterials(mats: THREE.Material[]) {
  for (const m of mats) {
    m.dispose();
  }
}

export const ModelViewer3D: React.FC<ModelViewer3DProps> = ({
  glbBuffer,
  modelName,
  provenanceLabel,
  reconstructionSource = 'tripo_v3',
  reconstructionSpec = null,
  originalSketchUrl = null,
  originalSketchSha256 = '',
  isCalibrationSample = false,
  onStatsValidated,
}) => {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);

  const [meshStats, setMeshStats] = useState<ValidatedMeshStats | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState<boolean>(false);
  const [inspectionMode, setInspectionMode] = useState<ViewerInspectionMode>('original');
  const [wireframe, setWireframe] = useState<boolean>(false);
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [autoRotate, setAutoRotate] = useState<boolean>(false);
  const [showSketchOverlay, setShowSketchOverlay] = useState<boolean>(Boolean(originalSketchUrl));
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const [isLoadingMesh, setIsLoadingMesh] = useState<boolean>(true);

  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelHolderRef = useRef<THREE.Group | null>(null);
  const normWrapperRef = useRef<THREE.Group | null>(null);
  const rawLoadedModelRef = useRef<THREE.Group | null>(null);
  const originalMaterialsMapRef = useRef<Map<string, THREE.Material | THREE.Material[]>>(new Map());
  const transientMaterialsRef = useRef<THREE.Material[]>([]);
  const gridHelperRef = useRef<THREE.GridHelper | null>(null);
  const contactShadowRef = useRef<THREE.Mesh | null>(null);
  const requestRenderRef = useRef<(() => void) | null>(null);
  const cameraTransitionActiveRef = useRef<boolean>(false);
  const isSoftwareGlRef = useRef<boolean>(false);
  const onStatsValidatedRef = useRef(onStatsValidated);
  onStatsValidatedRef.current = onStatsValidated;

  useEffect(() => {
    if (originalSketchUrl) {
      setShowSketchOverlay(true);
    }
  }, [originalSketchUrl]);

  // Initialize WebGLRenderer, studio RoomEnvironment, 3-point lighting, and OrbitControls once
  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareWebGL();
    isSoftwareGlRef.current = isSoftwareGl;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    scene.fog = new THREE.FogExp2(0x0f172a, 0.065);
    sceneRef.current = scene;

    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 320);

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.05, 100);
    camera.position.set(2.3, 1.75, 2.5);
    cameraRef.current = camera;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
      });
    } catch {
      setViewerError('WebGL is unavailable in this browser environment.');
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    rendererRef.current = renderer;

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    // Studio IBL Environment Reflection (RoomEnvironment)
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    pmremGenerator.dispose();

    // Balanced 3-Point Warm/Cool Studio Lighting Rig
    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.75);
    hemiLight.position.set(0, 8, 0);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff7ed, 1.65);
    keyLight.position.set(3.5, 5.2, 3.8);
    keyLight.castShadow = !isSoftwareGl;
    if (!isSoftwareGl) {
      keyLight.shadow.mapSize.set(1024, 1024);
      const d = 2.5;
      keyLight.shadow.camera.left = -d;
      keyLight.shadow.camera.right = d;
      keyLight.shadow.camera.top = d;
      keyLight.shadow.camera.bottom = -d;
      keyLight.shadow.camera.near = 0.5;
      keyLight.shadow.camera.far = 15;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
    }
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.65);
    fillLight.position.set(-3.8, 2.6, 2.2);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xe2e8f0, 0.85);
    rimLight.position.set(-1.2, 3.8, -4.2);
    scene.add(rimLight);

    // Subtle radial contact shadow grounding disc at y = 0
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 128;
    shadowCanvas.height = 128;
    const sCtx = shadowCanvas.getContext('2d');
    if (sCtx) {
      const grad = sCtx.createRadialGradient(64, 64, 8, 64, 64, 62);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.52)');
      grad.addColorStop(0.65, 'rgba(0, 0, 0, 0.18)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      sCtx.fillStyle = grad;
      sCtx.fillRect(0, 0, 128, 128);
    }
    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    shadowTex.colorSpace = THREE.SRGBColorSpace;
    const contactMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const contactPlane = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), contactMat);
    contactPlane.rotation.x = -Math.PI / 2;
    contactPlane.position.y = 0.002;
    scene.add(contactPlane);
    contactShadowRef.current = contactPlane;

    // Architectural studio floor grid
    const grid = new THREE.GridHelper(6, 24, 0x334155, 0x1e293b);
    grid.position.y = 0;
    scene.add(grid);
    gridHelperRef.current = grid;

    // Dedicated holder group for normalized GLB model
    const modelHolder = new THREE.Group();
    scene.add(modelHolder);
    modelHolderRef.current = modelHolder;

    // OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.enableRotate = true;
    controls.enableZoom = true;
    controls.enablePan = true;
    controls.minDistance = 0.7;
    controls.maxDistance = 12;
    controls.target.set(0, 0.65, 0);
    controls.update();
    controlsRef.current = controls;

    // Software-WebGL safe on-demand render scheduler
    let frameId = 0;
    let timeoutId = 0;
    let renderBusy = false;
    let renderDirty = false;
    let lastTickMs = performance.now();

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (gl && typeof gl.fenceSync === 'function') {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            timeoutId = window.setTimeout(poll, 6);
          } else {
            if (sync) gl.deleteSync(sync);
            timeoutId = window.setTimeout(cb, 80);
          }
        };
        timeoutId = window.setTimeout(poll, 6);
      } else {
        timeoutId = window.setTimeout(cb, 80);
      }
    }

    function requestRender() {
      if (renderBusy) {
        renderDirty = true;
        return;
      }
      renderBusy = true;
      frameId = requestAnimationFrame((now) => {
        renderDirty = false;
        const dt = Math.min(0.05, Math.max(0.001, (now - lastTickMs) / 1000));
        lastTickMs = now;

        if (cameraTransitionActiveRef.current) {
          camera.position.x = THREE.MathUtils.damp(camera.position.x, _targetCamPos.x, 7, dt);
          camera.position.y = THREE.MathUtils.damp(camera.position.y, _targetCamPos.y, 7, dt);
          camera.position.z = THREE.MathUtils.damp(camera.position.z, _targetCamPos.z, 7, dt);
          controls.target.x = THREE.MathUtils.damp(controls.target.x, _targetLookAt.x, 7, dt);
          controls.target.y = THREE.MathUtils.damp(controls.target.y, _targetLookAt.y, 7, dt);
          controls.target.z = THREE.MathUtils.damp(controls.target.z, _targetLookAt.z, 7, dt);

          if (camera.position.distanceToSquared(_targetCamPos) < 0.0004) {
            camera.position.copy(_targetCamPos);
            controls.target.copy(_targetLookAt);
            cameraTransitionActiveRef.current = false;
          } else {
            renderDirty = true;
          }
        }

        const didControlChange = controls.update();
        if (didControlChange || controls.autoRotate) {
          renderDirty = true;
        }

        renderer.render(scene, camera);

        const done = () => {
          renderBusy = false;
          if (renderDirty) requestRender();
        };
        if (isSoftwareGl) afterDraw(done);
        else done();
      });
    }

    requestRenderRef.current = requestRender;

    const onControlStart = () => {
      cameraTransitionActiveRef.current = false;
    };
    const onControlChange = () => {
      requestRender();
    };
    controls.addEventListener('start', onControlStart);
    controls.addEventListener('change', onControlChange);

    const canvasEl = renderer.domElement;
    const handleContextLost = (e: Event) => {
      e.preventDefault();
      setContextLost(true);
    };
    const handleContextRestored = () => {
      setContextLost(false);
      requestRender();
    };
    canvasEl.addEventListener('webglcontextlost', handleContextLost);
    canvasEl.addEventListener('webglcontextrestored', handleContextRestored);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const newW = Math.max(100, Math.floor(entry.contentRect.width));
      const newH = Math.max(100, Math.floor(entry.contentRect.height));
      camera.aspect = newW / newH;
      camera.updateProjectionMatrix();
      renderer.setSize(newW, newH);
      requestRender();
    });
    resizeObserver.observe(container);

    requestRender();

    return () => {
      cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
      resizeObserver.disconnect();
      controls.removeEventListener('start', onControlStart);
      controls.removeEventListener('change', onControlChange);
      controls.dispose();
      canvasEl.removeEventListener('webglcontextlost', handleContextLost);
      canvasEl.removeEventListener('webglcontextrestored', handleContextRestored);

      // Restore original materials before full disposal so both original and transient materials are cleaned cleanly
      const loadedModel = rawLoadedModelRef.current;
      if (loadedModel) {
        loadedModel.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh && originalMaterialsMapRef.current.has(mesh.uuid)) {
            mesh.material = originalMaterialsMapRef.current.get(mesh.uuid)!;
          }
        });
      }
      disposeTransientMaterials(transientMaterialsRef.current);
      transientMaterialsRef.current = [];
      originalMaterialsMapRef.current.clear();

      disposeObject3D(modelHolder);
      contactPlane.geometry.dispose();
      shadowTex.dispose();
      contactMat.dispose();
      grid.geometry.dispose();
      if (Array.isArray(grid.material)) {
        grid.material.forEach((m) => m.dispose());
      } else {
        grid.material.dispose();
      }
      envTarget.dispose();
      renderer.dispose();
    };
  }, []);

  // Apply non-destructive inspection mode (Original vs User Material Preview vs Clay/Topology) + Wireframe
  const syncInspectionMaterials = useCallback(
    (
      targetModel: THREE.Group | null,
      mode: ViewerInspectionMode,
      spec: CompiledReconstructionSpec | null,
      isWireframe: boolean
    ) => {
      if (!targetModel) return;

      // Dispose previously synthesized preview/clay materials before creating fresh ones
      disposeTransientMaterials(transientMaterialsRef.current);
      transientMaterialsRef.current = [];

      let meshIdx = 0;
      targetModel.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        meshIdx += 1;

        const origMat = originalMaterialsMapRef.current.get(mesh.uuid);
        if (mode === 'original' || (!spec && mode === 'user_material')) {
          if (origMat) {
            mesh.material = origMat;
          }
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => {
            if ('wireframe' in m) {
              (m as THREE.MeshStandardMaterial).wireframe = isWireframe;
            }
          });
        } else if (mode === 'user_material' && spec) {
          const useSecondary = meshIdx > 1 && meshIdx % 2 === 0;
          const pbrMat = new THREE.MeshPhysicalMaterial({
            name: useSecondary ? 'intentlock_secondary_preview' : 'intentlock_primary_preview',
            color: new THREE.Color(useSecondary ? spec.secondaryHex : spec.primaryHex),
            roughness: spec.roughness,
            metalness: spec.metalness,
            clearcoat: spec.clearcoat,
            clearcoatRoughness: 0.16,
            opacity: spec.opacity,
            transparent: spec.opacity < 0.99,
            side: THREE.DoubleSide,
            wireframe: isWireframe,
          });
          transientMaterialsRef.current.push(pbrMat);
          mesh.material = pbrMat;
        } else if (mode === 'clay_topology') {
          const clayMat = new THREE.MeshStandardMaterial({
            name: 'studio_clay_inspection',
            color: 0xd6d3d1,
            roughness: 0.78,
            metalness: 0.04,
            side: THREE.DoubleSide,
            wireframe: isWireframe,
          });
          transientMaterialsRef.current.push(clayMat);
          mesh.material = clayMat;
        }
      });

      requestRenderRef.current?.();
    },
    []
  );

  // Parse, validate, wrap in dedicated normalization group (keeping gltfScene unmutated!), and mount GLB
  useEffect(() => {
    let cancelled = false;
    const holder = modelHolderRef.current;
    if (!holder) return;

    setIsLoadingMesh(true);
    setViewerError(null);

    validateAndParseGlbBuffer(glbBuffer)
      .then(({ scene: gltfScene, stats }) => {
        if (cancelled) {
          disposeObject3D(gltfScene);
          return;
        }

        // Clean up any previously mounted model & cached materials
        if (rawLoadedModelRef.current) {
          rawLoadedModelRef.current.traverse((obj) => {
            const mesh = obj as THREE.Mesh;
            if (mesh.isMesh && originalMaterialsMapRef.current.has(mesh.uuid)) {
              mesh.material = originalMaterialsMapRef.current.get(mesh.uuid)!;
            }
          });
        }
        disposeTransientMaterials(transientMaterialsRef.current);
        transientMaterialsRef.current = [];
        originalMaterialsMapRef.current.clear();

        if (normWrapperRef.current) {
          holder.remove(normWrapperRef.current);
          disposeObject3D(normWrapperRef.current);
          normWrapperRef.current = null;
          rawLoadedModelRef.current = null;
        }

        // Cache original materials & configure shadows/anisotropy WITHOUT mutating gltfScene scale/position
        const maxAniso = rendererRef.current?.capabilities.getMaxAnisotropy() ?? 1;
        gltfScene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) {
            originalMaterialsMapRef.current.set(mesh.uuid, mesh.material);
            mesh.castShadow = !isSoftwareGlRef.current;
            mesh.receiveShadow = !isSoftwareGlRef.current;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const m of mats) {
              const std = m as THREE.MeshStandardMaterial;
              if (std && std.map) {
                std.map.anisotropy = maxAniso;
              }
            }
          }
        });

        // Compute unmutated bounding box of gltfScene, then apply viewport normalization ONLY on normWrapper
        gltfScene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(gltfScene);
        const size = new THREE.Vector3();
        box.getSize(size);

        const maxDim = Math.max(size.x, size.y, size.z, 0.001);
        const normScale = 1.55 / maxDim;

        const normWrapper = new THREE.Group();
        normWrapper.name = 'Viewer_Normalization_Wrapper';
        normWrapper.add(gltfScene);
        normWrapper.scale.setScalar(normScale);
        normWrapper.updateMatrixWorld(true);

        const scaledBox = new THREE.Box3().setFromObject(normWrapper);
        const scaledCenter = new THREE.Vector3();
        scaledBox.getCenter(scaledCenter);

        normWrapper.position.set(-scaledCenter.x, -scaledBox.min.y, -scaledCenter.z);
        normWrapper.updateMatrixWorld(true);

        holder.add(normWrapper);
        normWrapperRef.current = normWrapper;
        rawLoadedModelRef.current = gltfScene;

        syncInspectionMaterials(gltfScene, inspectionMode, reconstructionSpec, wireframe);

        const targetHeight = Math.max(0.35, (scaledBox.max.y - scaledBox.min.y) * 0.48);
        _targetLookAt.set(0, targetHeight, 0);
        _targetCamPos.set(2.15, targetHeight + 1.05, 2.35);
        cameraTransitionActiveRef.current = true;

        setMeshStats(stats);
        setIsLoadingMesh(false);
        onStatsValidatedRef.current?.(stats);
        requestRenderRef.current?.();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setIsLoadingMesh(false);
        setMeshStats(null);
        setViewerError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glbBuffer]);

  // Re-sync materials when inspection mode, compiled IntentLock spec, or wireframe changes
  useEffect(() => {
    syncInspectionMaterials(
      rawLoadedModelRef.current,
      inspectionMode,
      reconstructionSpec,
      wireframe
    );
  }, [inspectionMode, reconstructionSpec, wireframe, syncInspectionMaterials]);

  // Grid toggle
  useEffect(() => {
    if (gridHelperRef.current) {
      gridHelperRef.current.visible = showGrid;
    }
    requestRenderRef.current?.();
  }, [showGrid]);

  // Auto-rotate toggle (disabled on software WebGL per performance standard)
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.autoRotate = !isSoftwareGlRef.current && autoRotate;
    controls.autoRotateSpeed = 1.6;
    requestRenderRef.current?.();
  }, [autoRotate]);

  const applyCameraPreset = useCallback((preset: CameraPreset) => {
    const midY = _targetLookAt.y || 0.65;
    if (preset === 'isometric') {
      _targetCamPos.set(2.15, midY + 1.05, 2.35);
    } else if (preset === 'front') {
      _targetCamPos.set(0, midY + 0.25, 2.95);
    } else if (preset === 'side') {
      _targetCamPos.set(2.95, midY + 0.25, 0);
    } else if (preset === 'top') {
      _targetCamPos.set(0.01, midY + 3.1, 0.01);
    }
    cameraTransitionActiveRef.current = true;
    requestRenderRef.current?.();
  }, []);

  const safeSlug =
    modelName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 36) || 'sketch2shape_model';

  const handleDownloadGlb = () => {
    const blob = new Blob([glbBuffer], { type: 'model/gltf-binary' });
    triggerBrowserDownload(blob, `${safeSlug}.glb`);
  };

  const handleExportObj = () => {
    const model = rawLoadedModelRef.current;
    if (!model) return;
    const { objBlob } = exportObjectToObjAndMtl(model, safeSlug, {
      inspectionMode,
      spec: reconstructionSpec,
    });
    triggerBrowserDownload(objBlob, `${safeSlug}.obj`);
  };

  const handleExportMtl = () => {
    const model = rawLoadedModelRef.current;
    if (!model) return;
    const { mtlBlob } = exportObjectToObjAndMtl(model, safeSlug, {
      inspectionMode,
      spec: reconstructionSpec,
    });
    triggerBrowserDownload(mtlBlob, `${safeSlug}.mtl`);
  };

  const isOfflineMesh = reconstructionSource === 'offline_contour';

  return (
    <div className="relative w-full h-[560px] sm:h-[620px] rounded-xl overflow-hidden bg-slate-900 border border-slate-800 select-none">
      {/* Isolated WebGL Canvas Container */}
      <div ref={canvasMountRef} className="w-full h-full" />

      {/* Top HUD: Left Provenance & Mesh Spec + Right Original 2D Sketch Reference (100% Clear Center) */}
      <div className="pointer-events-none absolute top-4 left-4 right-4 flex flex-wrap items-start justify-between gap-3 z-10">
        <div
          className={`pointer-events-auto border rounded-lg px-3.5 py-2.5 text-slate-100 max-w-lg space-y-1 ${
            isOfflineMesh
              ? 'bg-slate-950/95 border-amber-600/80'
              : 'bg-slate-950/95 border-slate-800'
          }`}
        >
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Box
              className={`w-3.5 h-3.5 shrink-0 ${
                isOfflineMesh ? 'text-amber-400' : 'text-blue-400'
              }`}
              aria-hidden="true"
            />
            <span className="truncate">{modelName}</span>
          </div>
          <div
            className={`text-[11px] leading-snug ${
              isOfflineMesh ? 'text-amber-300 font-medium' : 'text-slate-300'
            }`}
          >
            {provenanceLabel}
          </div>
          {meshStats && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono tabular-nums text-slate-400 pt-0.5">
              <span>
                {meshStats.nonEmptyMeshCount} mesh{meshStats.nonEmptyMeshCount === 1 ? '' : 'es'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{meshStats.vertexCount.toLocaleString()} verts</span>
              <span aria-hidden="true">·</span>
              <span>{meshStats.triangleCount.toLocaleString()} tris</span>
              <span aria-hidden="true">·</span>
              <span>
                {meshStats.dimensions.x} × {meshStats.dimensions.y} × {meshStats.dimensions.z} u
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatFileSize(meshStats.fileSizeBytes)}</span>
            </div>
          )}
        </div>

        {/* Right Overlay: Calibration Notice OR Original 2D Sketch Side-by-Side Reference */}
        {isCalibrationSample ? (
          <div className="pointer-events-auto bg-amber-950/95 border border-amber-700/80 rounded-lg px-3 py-2 text-xs text-amber-200 max-w-xs">
            Calibration GLB Self-Test — Local procedural test mesh (not a user sketch generation)
          </div>
        ) : (
          showSketchOverlay &&
          originalSketchUrl && (
            <div className="pointer-events-auto bg-slate-950/95 border border-slate-800 rounded-lg p-2.5 w-40 space-y-1.5">
              <div className="flex items-center justify-between gap-1 text-[10px] text-slate-300 font-medium">
                <span>Original 2D Sketch</span>
                <button
                  type="button"
                  onClick={() => setShowSketchOverlay(false)}
                  className="text-slate-400 hover:text-white"
                  title="Hide 2D sketch overlay"
                >
                  Hide
                </button>
              </div>
              <div className="w-full h-24 bg-white rounded overflow-hidden flex items-center justify-center p-1">
                <img
                  src={originalSketchUrl}
                  alt="Original 2D sketch reference"
                  className="max-w-full max-h-full object-contain"
                />
              </div>
              {originalSketchSha256 && (
                <p className="text-[10px] font-mono tabular-nums text-slate-400 truncate">
                  SHA {originalSketchSha256.slice(0, 10)}…
                </p>
              )}
            </div>
          )
        )}
      </div>

      {/* Loading / Validation Overlay */}
      {isLoadingMesh && !viewerError && (
        <div className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center text-center p-6 z-20">
          <p className="text-sm font-semibold text-white">
            Parsing &amp; Validating Binary GLB Mesh…
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Checking glTF 2.0 header length, finite vertex coordinates, and 3D bounding-box volume
          </p>
        </div>
      )}

      {/* Validation Error or Context Loss State */}
      {(viewerError || contextLost) && (
        <div className="absolute inset-0 bg-slate-950/95 flex flex-col items-center justify-center text-center p-8 z-20">
          <AlertTriangle className="w-8 h-8 text-red-400 mb-3" aria-hidden="true" />
          <p className="text-sm font-semibold text-white">
            {contextLost ? 'WebGL Context Temporarily Interrupted' : '3D Model Validation Failed'}
          </p>
          <p className="text-xs text-slate-300 mt-1.5 max-w-md leading-relaxed">
            {contextLost
              ? 'Waiting for the browser graphics driver to restore the 3D viewport.'
              : viewerError}
          </p>
        </div>
      )}

      {/* Unified Collapsible Bottom Control Dock (Zero backdrop-blur over WebGL) */}
      {!viewerError && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-[min(980px,95%)] flex flex-col items-center">
          <button
            type="button"
            onClick={() => setDockCollapsed((prev) => !prev)}
            className="inline-flex items-center gap-1 px-3 py-1 text-[11px] font-medium text-slate-300 bg-slate-950/95 border border-slate-800 rounded-t-md hover:text-white transition-colors whitespace-nowrap"
          >
            {dockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Show Studio Controls</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Hide Controls</span>
              </>
            )}
          </button>

          {!dockCollapsed && (
            <div className="w-full bg-slate-950/95 border border-slate-800 rounded-lg p-3 space-y-2.5">
              {/* Row 1: Non-Destructive Inspection Modes + Viewport Toggles */}
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800/90">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 pr-1">
                    <Palette className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Shading:</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setInspectionMode('original')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                      inspectionMode === 'original'
                        ? 'bg-blue-600 text-white border-blue-500'
                        : 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800'
                    }`}
                  >
                    Original Reconstruction
                  </button>
                  <button
                    type="button"
                    disabled={!reconstructionSpec}
                    onClick={() => setInspectionMode('user_material')}
                    title={
                      reconstructionSpec
                        ? `Preview ${reconstructionSpec.primaryMaterial} (${reconstructionSpec.colourPalette})`
                        : 'Available when IntentLock material specification is present'
                    }
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                      inspectionMode === 'user_material'
                        ? 'bg-blue-600 text-white border-blue-500'
                        : 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800'
                    }`}
                  >
                    User Material Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => setInspectionMode('clay_topology')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                      inspectionMode === 'clay_topology'
                        ? 'bg-blue-600 text-white border-blue-500'
                        : 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800'
                    }`}
                  >
                    Clay / Topology Inspection
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setWireframe((w) => !w)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                      wireframe
                        ? 'bg-blue-600 text-white border-blue-500'
                        : 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800'
                    }`}
                  >
                    Wireframe
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowGrid((g) => !g)}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                      showGrid
                        ? 'bg-slate-800 text-white border-slate-700'
                        : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
                    }`}
                  >
                    <Grid3x3 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Grid</span>
                  </button>
                  {originalSketchUrl && !isCalibrationSample && (
                    <button
                      type="button"
                      onClick={() => setShowSketchOverlay((s) => !s)}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                        showSketchOverlay
                          ? 'bg-slate-800 text-white border-slate-700'
                          : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
                      }`}
                    >
                      <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>2D Sketch</span>
                    </button>
                  )}
                  {!isSoftwareGlRef.current && (
                    <button
                      type="button"
                      onClick={() => setAutoRotate((r) => !r)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                        autoRotate
                          ? 'bg-blue-600 text-white border-blue-500'
                          : 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800'
                      }`}
                    >
                      Auto-Orbit
                    </button>
                  )}
                </div>
              </div>

              {/* Row 2: Camera Viewpoint Presets + Unmutated 1:1 3D Asset Exports */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(['isometric', 'front', 'side', 'top'] as CameraPreset[]).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => applyCameraPreset(preset)}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 border border-slate-800 rounded-md hover:bg-slate-800 transition-colors capitalize whitespace-nowrap shrink-0"
                    >
                      {preset}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => applyCameraPreset('isometric')}
                    title="Reset orbit camera"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 border border-slate-800 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Reset</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportMtl}
                    disabled={!meshStats}
                    title="Export companion Wavefront .mtl material library"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 border border-slate-700 rounded-md hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    <FileDown className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>.MTL</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleExportObj}
                    disabled={!meshStats}
                    title="Export Wavefront .obj mesh at exact 1:1 unmutated GLB source scale"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 border border-slate-700 rounded-md hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    <FileDown className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Export .OBJ</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadGlb}
                    disabled={!meshStats}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-500 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Download .GLB</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
