
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./UpdateModal.css";
import useModalScrollTop from "../lib/useModalScrollTop";

export default function UpdateModal() {
  const [update, setUpdate] = useState(null);
  const [installing, setInstalling] = useState(false);

  useModalScrollTop(Boolean(update), false);

  useEffect(() => {
    if (!window.eryon?.onLaunchEvent) {
      console.error("[ERYON] No está disponible el listener de eventos.");
      return;
    }

    const unsubscribe = window.eryon.onLaunchEvent((event) => {
      if (event?.type !== "updater") return;

      if (event.action === "available") {
        setInstalling(false);
        setUpdate({
          status: "downloading",
          version: event.version ?? "",
          percent: 0
        });
      }

      if (event.action === "progress") {
        const rawPercent =
          event.percent ?? event.progress?.percent ?? 0;

        const percent = Math.max(
          0,
          Math.min(100, Number(rawPercent) || 0)
        );

        setUpdate((current) => ({
          status: "downloading",
          version: event.version ?? current?.version ?? "",
          percent
        }));
      }

      if (event.action === "downloaded") {
        setInstalling(false);
        setUpdate((current) => ({
          status: "ready",
          version: event.version ?? current?.version ?? "",
          percent: 100
        }));
      }

      if (event.action === "error") {
        setInstalling(false);
        setUpdate((current) => ({
          status: "error",
          version: current?.version ?? "",
          percent: current?.percent ?? 0,
          message:
            event.message ??
            event.error ??
            "No se pudo completar la actualización."
        }));
      }
    });

    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, []);

  async function handleInstall() {
    if (typeof window.eryon?.installUpdate !== "function") {
      setUpdate((current) => ({
        ...current,
        status: "error",
        message:
          "No se pudo instalar la actualización. Cierra y vuelve a abrir Eryon Launcher."
      }));
      return;
    }

    setInstalling(true);

    try {
      await window.eryon.installUpdate();
    } catch (error) {
      setInstalling(false);

      setUpdate((current) => ({
        ...current,
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "No se pudo instalar la actualización."
      }));
    }
  }

  function dismissError() {
    setUpdate(null);
  }

  if (!update) return null;

  const isReady = update.status === "ready";
  const isError = update.status === "error";
  const percent = Math.round(update.percent ?? 0);

  return createPortal(
    <div className="eryon-update-overlay">
      <section
        className="eryon-update-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eryon-update-title"
      >
        <div className="eryon-update-brand minimal">
          <img
            className="eryon-update-logo"
            src="../build/logo-splash.png"
            alt="Eryon Launcher"
          />

          <div className="eryon-update-copy">
            <p className="eryon-update-eyebrow">ERYON LAUNCHER</p>
            <h2 id="eryon-update-title">
              {isError
                ? "Error de actualización"
                : isReady
                  ? "Actualización lista"
                  : "Nueva actualización"}
            </h2>
          </div>
        </div>

        <p className="eryon-update-description update-error-message">
          {isError
            ? update.message
            : isReady
              ? "La actualización ya está descargada. Pulsa el botón para reiniciar, o ciérrala y se instala sola."
              : "Estamos descargando una nueva versión de Eryon Launcher. Puedes seguir el progreso aquí."}
        </p>

        {update.version && (
          <div className="eryon-update-version">
            <span>Versión</span>
            <strong>{update.version}</strong>
          </div>
        )}

        {!isError && (
          <div className="eryon-update-progress-section">
            <div className="eryon-update-progress-label visually-hidden">
              <span>
                {isReady
                  ? "Descarga completada"
                  : installing
                    ? "Preparando instalación..."
                    : "Descargando actualización"}
              </span>

              <strong>{percent}%</strong>
            </div>

            <strong className="eryon-update-percent">{percent}%</strong>

            <div
              className="eryon-update-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div
                className={`eryon-update-progress-fill ${
                  isReady ? "is-complete" : ""
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {isError && (
          <button
            className="eryon-update-button secondary"
            type="button"
            onClick={dismissError}
          >
            Cerrar
          </button>
        )}

        {isReady && !isError && (
          <button
            className="eryon-update-button primary"
            type="button"
            onClick={handleInstall}
            disabled={installing}
          >
            {installing
              ? "REINICIANDO..."
              : "REINICIAR Y ACTUALIZAR"}
          </button>
        )}

        {!isError && (
          <p className="eryon-update-footnote">
            {isReady
              ? "O cierra Eryon cuando quieras: se instala sola y vuelve a abrir con la versión nueva."
              : "Descargando la actualización. No necesitas hacer nada."}
          </p>
        )}
      </section>
    </div>,
    document.body
  );
}
