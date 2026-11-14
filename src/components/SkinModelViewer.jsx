import { IdleAnimation, SkinViewer } from "skinview3d";
import { useEffect, useRef, useState } from "react";
import defaultSteveSkin from "../assets/default-steve.png";

export default function SkinModelViewer({ skinUrl, variant, onError }) {
  const canvasRef = useRef(null);
  const viewerRef = useRef(null);
  const onErrorRef = useRef(onError);
  const [autoRotate, setAutoRotate] = useState(true);

  onErrorRef.current = onError;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let viewer;
    let resizeObserver;
    try {
      viewer = new SkinViewer({
        canvas,
        width: canvas.clientWidth || 260,
        height: canvas.clientHeight || 300,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5)
      });
      viewerRef.current = viewer;
      viewer.background = 0x0a110c;
      viewer.animation = new IdleAnimation();
      viewer.autoRotate = true;
      viewer.controls.enableRotate = true;
      viewer.controls.enableZoom = true;
      viewer.controls.enablePan = false;

      resizeObserver = new ResizeObserver(() => {
        if (canvas.clientWidth && canvas.clientHeight) {
          viewer.setSize(canvas.clientWidth, canvas.clientHeight);
        }
      });
      resizeObserver.observe(canvas);
    } catch (viewerError) {
      onErrorRef.current?.(
        new Error(`No se pudo iniciar la vista 3D: ${viewerError.message}`)
      );
    }

    return () => {
      resizeObserver?.disconnect();
      viewer?.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (!skinUrl) {
      viewer.loadSkin(defaultSteveSkin, { model: "default" });
      return;
    }

    viewer.loadSkin(skinUrl, {
      model: variant === "slim" ? "slim" : "default"
    }).catch((skinError) => {
      viewer.loadSkin(defaultSteveSkin, { model: "default" });
      onErrorRef.current?.(
        new Error(`No se pudo cargar la skin; se muestra Steve. ${skinError.message}`)
      );
    });
  }, [skinUrl, variant]);

  function toggleAutoRotate() {
    const nextAutoRotate = !autoRotate;
    setAutoRotate(nextAutoRotate);
    if (viewerRef.current) viewerRef.current.autoRotate = nextAutoRotate;
  }

  function resetView() {
    viewerRef.current?.resetCameraPose();
  }

  return (
    <div className="skin-model-viewer">
      <canvas
        ref={canvasRef}
        className="skin-model-canvas"
        aria-label="Vista 3D del personaje. Arrastra para girar y usa la rueda para acercar."
      />
      <div className="skin-model-controls">
        <button
          className="secondary-button"
          type="button"
          onClick={toggleAutoRotate}
          aria-pressed={autoRotate}
        >
          {autoRotate ? "DETENER GIRO" : "GIRO AUTOMÁTICO"}
        </button>
        <button className="secondary-button" type="button" onClick={resetView}>
          RESTABLECER VISTA
        </button>
      </div>
      <small className="skin-model-hint">Arrastra para girar · rueda para acercar</small>
    </div>
  );
}
