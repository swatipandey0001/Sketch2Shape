import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RotateCcw } from 'lucide-react';
import { disposeObject3D, validateAndParseGlbBuffer } from '../utils/glbValidator';

interface OptionPreview3DProps {
  glbBuffer: ArrayBuffer;
  optionLabel: string;
  isSelected?: boolean;
}

const detectSoftwareGl = (): boolean => {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
};

export const OptionPreview3D: React.FC<OptionPreview3DProps> = ({
  glbBuffer,
  optionLabel,
  isSelected = false,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const modelRootRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const requestRenderRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let cancelled = false;
    const isSoftware = detectSoftwareGl();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(isSelected ? 0x0b1629 : 0x0f172a);

    const w = Math.max(container.clientWidth, 220);
    const h = Math.max(container.clientHeight, 180);

    const camera = new THREE.PerspectiveCamera(38, w / h, 0.05, 50);
    camera.position.set(1.85, 1.42, 2.05);
    cameraRef.current = camera;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftware,
        powerPreference: 'default',
      });
    } catch {
      setLoadError('WebGL preview unavailable');
      return;
    }

    renderer.setPixelRatio(isSoftware ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmrem.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xf8fafc, 0x1e293b, 0.7);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.55);
    key.position.set(3, 4.5, 3.2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x93c5fd, 0.55);
    rim.position.set(-2.6, 2.2, -2.5);
    scene.add(rim);

    const grid = new THREE.GridHelper(2.6, 10, 0x334155, 0x1e293b);
    grid.position.y = -0.002;
    scene.add(grid);

    const holder = new THREE.Group();
    scene.add(holder);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.enablePan = false;
    controls.minDistance = 0.85;
    controls.maxDistance = 5.5;
    controls.target.set(0, 0.52, 0);
    controls.update();
    controlsRef.current = controls;

    let rafId = 0;
    let dirty = false;
    const renderNow = () => {
      rafId = 0;
      if (cancelled) return;
      renderer.render(scene, camera);
      if (isSoftware) {
        const gl = renderer.getContext();
        if (gl instanceof WebGL2RenderingContext) {
          const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
          gl.flush();
          if (sync) gl.deleteSync(sync);
        }
      }
      if (dirty) {
        dirty = false;
        rafId = requestAnimationFrame(renderNow);
      }
    };

    const requestRender = () => {
      if (cancelled) return;
      if (rafId === 0) {
        rafId = requestAnimationFrame(renderNow);
      } else {
        dirty = true;
      }
    };
    requestRenderRef.current = requestRender;

    controls.addEventListener('change', requestRender);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nw = Math.max(entry.contentRect.width, 180);
        const nh = Math.max(entry.contentRect.height, 150);
        camera.aspect = nw / nh;
        camera.updateProjectionMatrix();
        renderer.setSize(nw, nh);
        requestRender();
      }
    });
    ro.observe(container);

    validateAndParseGlbBuffer(glbBuffer)
      .then(({ scene: parsedScene }) => {
        if (cancelled) {
          disposeObject3D(parsedScene);
          return;
        }
        parsedScene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(parsedScene);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        const maxDim = Math.max(size.x, size.y, size.z, 0.001);
        const scale = 1.18 / maxDim;

        const wrapper = new THREE.Group();
        wrapper.scale.setScalar(scale);
        parsedScene.position.set(-center.x, -box.min.y, -center.z);
        wrapper.add(parsedScene);

        holder.add(wrapper);
        modelRootRef.current = parsedScene;

        const centerH = Math.max(0.28, (size.y * scale) * 0.48);
        controls.target.set(0, centerH, 0);
        camera.position.set(1.75, centerH + 0.72, 1.92);
        controls.update();
        setLoadError(null);
        requestRender();
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Preview parse failed');
        }
      });

    return () => {
      cancelled = true;
      if (rafId !== 0) cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      if (modelRootRef.current) {
        disposeObject3D(modelRootRef.current);
        modelRootRef.current = null;
      }
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      envTarget.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [glbBuffer, isSelected]);

  useEffect(() => {
    const model = modelRootRef.current;
    if (!model) return;
    model.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if ('wireframe' in m) {
            (m as THREE.MeshStandardMaterial).wireframe = wireframe;
          }
        }
      }
    });
    requestRenderRef.current?.();
  }, [wireframe]);

  const handleResetView = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;
    camera.position.set(1.75, controls.target.y + 0.72, 1.92);
    controls.update();
    requestRenderRef.current?.();
  };

  return (
    <div
      className="relative w-full h-52 rounded-lg overflow-hidden bg-slate-900 border border-slate-800 select-none"
      aria-label={`Interactive 3D preview for ${optionLabel}`}
    >
      <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

      {loadError && (
        <div className="absolute inset-0 bg-slate-950/90 flex items-center justify-center p-4 text-center">
          <p className="text-xs text-red-300">{loadError}</p>
        </div>
      )}

      {/* Minimal Corner Controls — Zero backdrop-filter over WebGL */}
      <div className="absolute top-2 left-2.5 pointer-events-none">
        <span className="text-[10px] font-mono text-slate-300 bg-slate-950/90 border border-slate-800 px-2 py-0.5 rounded">
          Drag to Orbit · Scroll Zoom
        </span>
      </div>

      <div className="absolute bottom-2 right-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setWireframe((w) => !w)}
          className={`px-2 py-0.5 text-[10px] font-medium rounded border transition-colors ${
            wireframe
              ? 'bg-blue-600 text-white border-blue-500'
              : 'bg-slate-950/90 text-slate-300 border-slate-700 hover:text-white'
          }`}
        >
          Wire
        </button>
        <button
          type="button"
          onClick={handleResetView}
          title="Reset preview camera"
          className="p-1 text-slate-300 bg-slate-950/90 border border-slate-700 rounded hover:text-white transition-colors"
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};
