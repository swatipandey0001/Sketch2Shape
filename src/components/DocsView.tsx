import React from 'react';

export const DocsView: React.FC = () => {
  return (
    <div className="max-w-[1040px] mx-auto px-6 py-8 space-y-8">
      <div className="space-y-2 pb-6 border-b border-slate-200">
        <h1 className="text-2xl sm:text-3xl font-display font-bold text-slate-900">
          Technical Architecture, Attribution &amp; Engineering Boundaries
        </h1>
        <p className="text-sm text-slate-600 leading-relaxed max-w-2xl">
          Reference documentation for Sketch2Shape — IntentLock 3D covering server-side API credentials, deterministic CV preprocessing, verified Tripo OpenAPI v3 specifications, offline contour 3D reconstruction, hardware assumptions, and known single-view limitations.
        </p>
      </div>

      {/* 01. Setup & API Requirements */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <h2 className="text-lg font-display font-bold text-slate-900">
          01. Server Environment Setup &amp; API Secrets
        </h2>
        <p className="text-xs text-slate-600 leading-relaxed">
          All API keys are read strictly on the Node.js / Express backend (<code className="font-mono">server.ts</code>) and are never bundled into frontend code or requested via browser input forms. Configure secrets in AI Studio via <strong>Settings &gt; Secrets</strong> or in a local <code className="font-mono">.env</code> file:
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
            <p className="font-mono font-semibold text-slate-900">GEMINI_API_KEY</p>
            <p className="text-slate-600 leading-relaxed">
              Required for server-side multimodal sketch spatial analysis via <code className="font-mono">@google/genai</code> (<code className="font-mono">gemini-3.8-flash</code> primary with <code className="font-mono">ThinkingLevel.LOW</code>, <code className="font-mono">gemini-3.1-flash-lite</code> fallback).
            </p>
          </div>
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
            <p className="font-mono font-semibold text-slate-900">TRIPO_API_KEY (Optional)</p>
            <p className="text-slate-600 leading-relaxed">
              Developer token (<code className="font-mono">tsk_...</code> from <code className="font-mono">platform.tripo3d.ai</code>) for cloud neural image-to-3D reconstruction. When omitted, Studio uses the <strong>Three-Option Modular Component 3D Reconstructor</strong> for supported structural categories without requiring a paid key.
            </p>
          </div>
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
            <p className="font-mono font-semibold text-slate-900">TRIPO_MODEL_VERSION</p>
            <p className="text-slate-600 leading-relaxed">
              Optional Tripo OpenAPI v3 model version identifier. Defaults to <code className="font-mono">v3.1-20260211</code> (also compatible with <code className="font-mono">v3.0-20250812</code> and <code className="font-mono">P1-20260311</code>).
            </p>
          </div>
        </div>
      </section>

      {/* 02. Model Attribution & Verified API Pipeline */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <h2 className="text-lg font-display font-bold text-slate-900">
          02. Model Attribution, Three-Option Modular 3D Synthesis &amp; Cloud Tripo v3
        </h2>
        <div className="space-y-3 text-xs text-slate-700 leading-relaxed">
          <p>
            <strong>Deterministic Computer Vision Preprocessing (<code className="font-mono">src/utils/sketchPreprocessor.ts</code>):</strong> Composites transparent PNG alpha channels onto pure white (<code className="font-mono">#FFFFFF</code>), flattens uneven paper illumination when requested, normalizes contrast, extracts foreground bounding boxes &amp; horizontal stroke projections, and traces 8-connected outer &amp; interior hole polygons. Zero generative AI image replacement is ever performed.
          </p>
          <p>
            <strong>Multimodal Vision Spatial Audit:</strong> Powered by Google Gemini (<code className="font-mono">gemini-3.8-flash</code> primary, automatic fallback to <code className="font-mono">gemini-3.1-flash-lite</code>) via <code className="font-mono">@google/genai</code>. Returns the 8-field audit schema plus structured category classification, parametric proportion blueprints, and three distinct reconstruction concepts.
          </p>
          <p>
            <strong>Three-Option Modular Component 3D Synthesis (<code className="font-mono">src/utils/modularReconstructor.ts</code>):</strong> Synthesizes three selectable, binary-validated <code className="font-mono">.GLB</code> models — <strong>Option A (Sketch Faithful)</strong>, <strong>Option B (Structurally Refined)</strong>, and <strong>Option C (Design Enhanced)</strong> — using dedicated multi-part 3D builders for <strong>Chairs &amp; Seating</strong> (separate seat, backrest, conditional armrests, legs &amp; stretchers), <strong>Tables &amp; Desks</strong>, <strong>Mugs &amp; Rotational Vessels</strong> (hollow lathe + swept 3D handle), <strong>Lamps</strong> (base, stem, socket, 3-strut spider harp &amp; hollow shade), <strong>Bookshelves &amp; Cabinets</strong>, and <strong>Mechanical Brackets &amp; Plates</strong>. Organic/freeform subjects are honestly flagged as unsupported locally rather than fabricating misleading blocks.
          </p>
          <p>
            <strong>Cloud Neural Image-to-3D (Tripo OpenAPI v3 — <code className="font-mono">https://openapi.tripo3d.ai/v3</code>):</strong>
          </p>
          <ul className="space-y-1.5 pl-4 font-mono text-[11px] text-slate-800">
            <li>• Step 1 (Upload): POST /v3/files (multipart/form-data, key &quot;file&quot;) → data.file_token</li>
            <li>• Step 2 (Create Task): POST /v3/generation/image-to-model ({`{ model: "v3.1-20260211", input: { file_token }, enable_image_autofix, texture_alignment, orientation: "default" }`}) → data.task_id</li>
            <li>• Step 3 (Async Poll): GET /v3/tasks/:task_id → status (queued | running | success | failed | banned | cancelled | expired)</li>
            <li>• Step 4 (GLB Validation): Verifies glTF 2.0 header magic (0x46546C67), version 2, declaredLength &lt;= byteLength, JSON chunk header (0x4E4F534A), finite non-NaN vertex coordinates, and non-zero 3D volume.</li>
          </ul>
          <p>
            <strong>Limited Raw Contour Extrusion Fallback (<code className="font-mono">src/utils/sketchTo3DFallback.ts</code>):</strong> Retained strictly as an explicitly labelled limited fallback when raw 2D silhouette extrusion is requested without Gemini analysis or outside modular categories.
          </p>
        </div>
      </section>

      {/* 03. Expected Generation Time & Hardware Assumptions */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <h2 className="text-base font-display font-bold text-slate-900">
            03. Measured Runtime &amp; Timeout Policy
          </h2>
          <ul className="space-y-2 text-xs text-slate-600 leading-relaxed">
            <li>• <strong>Deterministic CV Preparation:</strong> ~8–45 ms locally in browser.</li>
            <li>• <strong>Gemini Vision Audit:</strong> Typically 1.5–5 seconds (<code className="font-mono">gemini-3.1-flash-lite</code>) with bounded exponential backoff + jitter on transient upstream load.</li>
            <li>• <strong>Offline Contour 3D Reconstruction:</strong> ~15–90 ms locally to generate &amp; validate binary <code className="font-mono">.GLB</code>.</li>
            <li>• <strong>Tripo v3 Cloud Reconstruction:</strong> Typically 25–90 seconds depending on GPU queue depth (180s timeout with Cancel/Retry controls).</li>
          </ul>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <h2 className="text-base font-display font-bold text-slate-900">
            04. Client Hardware &amp; Export Scale Parity
          </h2>
          <ul className="space-y-2 text-xs text-slate-600 leading-relaxed">
            <li>• <strong>Hardware &amp; WebGL:</strong> Runs on standard CPU laptops/desktops (no local CUDA GPU required). Adapts pixel ratio and shadow maps automatically on software WebGL renderers (SwiftShader / llvmpipe).</li>
            <li>• <strong>1:1 Export Scale Parity:</strong> <code className="font-mono">ModelViewer3D</code> applies viewport framing on an outer <code className="font-mono">Viewer_Normalization_Wrapper</code> group so the loaded <code className="font-mono">gltfScene</code> retains untouched 1:1 source coordinates for both <code className="font-mono">.GLB</code> and Wavefront <code className="font-mono">.OBJ</code> + <code className="font-mono">.MTL</code> exports.</li>
          </ul>
        </div>
      </section>

      {/* 05. Honest Prototype Limitations */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
        <h2 className="text-lg font-display font-bold text-slate-900">
          05. Known Prototype Limitations &amp; Design Trade-offs
        </h2>
        <ul className="space-y-2 text-xs text-slate-600 leading-relaxed">
          <li>
            • <strong>Offline Contour Fallback vs Neural Reconstruction:</strong> Offline contour extrusion and rotational lathing accurately capture 2D silhouettes, interior holes, vessel profiles, and multi-leg depth separation, but cannot hallucinate organic sculpted surface detail (such as facial features or cloth wrinkles) the way cloud neural models like Tripo v3 can.
          </li>
          <li>
            • <strong>Preservation of Original Sketch in Tripo v3:</strong> Tripo&apos;s <code className="font-mono">/v3/generation/image-to-model</code> endpoint reconstructs geometry from image pixels and does not accept free-form text prompts alongside <code className="font-mono">file_token</code>. Sketch2Shape maps IntentLock material/colour overrides into non-destructive Three.js PBR preview modes (<code className="font-mono">User Material Preview</code>) and companion <code className="font-mono">.MTL</code> exports without silently replacing your original drawing.
          </li>
          <li>
            • <strong>Single-View Occlusion:</strong> Faint, broken, or heavily overlapping perspective lines can merge into a single silhouette during binary thresholding; bold closed strokes yield the cleanest offline contour meshes.
          </li>
        </ul>
      </section>
    </div>
  );
};
