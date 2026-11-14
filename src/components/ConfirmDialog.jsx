import { useEffect, useRef, useState } from "react";
import "./ConfirmDialog.css";
import useModalScrollTop from "../lib/useModalScrollTop";

/**
 * Diálogo de confirmación con el mismo lenguaje visual
 * que la ventana de actualización de Eryon.
 */
export default function ConfirmDialog({
  eyebrow = "ERYON LAUNCHER",
  title,
  description,
  detail,
  confirmLabel = "CONFIRMAR",
  cancelLabel = "CANCELAR",
  confirmDelaySeconds = 0,
  busy = false,
  busyLabel = "PROCESANDO...",
  onConfirm,
  onCancel
}) {
  const confirmRef = useRef(null);
  const [countdown, setCountdown] = useState(confirmDelaySeconds);

  useModalScrollTop(Boolean(title));

  useEffect(() => {
    setCountdown(confirmDelaySeconds);
  }, [confirmDelaySeconds, title]);

  useEffect(() => {
    if (!title || countdown <= 0) return undefined;

    const timer = window.setTimeout(() => {
      setCountdown((remaining) => Math.max(0, remaining - 1));
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [countdown, title]);

  useEffect(() => {
    confirmRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape" && !busy) {
        onCancel?.();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [busy, onCancel]);

  if (!title) return null;

  return (
    <div className="eryon-confirm-overlay">
      <section
        className="eryon-confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="eryon-confirm-title"
        aria-describedby="eryon-confirm-description"
      >
        <div className="eryon-confirm-brand">
          <div className="eryon-confirm-logo">E</div>

          <div>
            <p className="eryon-confirm-eyebrow">{eyebrow}</p>
            <h2 id="eryon-confirm-title">{title}</h2>
          </div>
        </div>

        <p
          className="eryon-confirm-description"
          id="eryon-confirm-description"
        >
          {description}
        </p>

        {detail && (
          <div className="eryon-confirm-detail">{detail}</div>
        )}

        <div className="eryon-confirm-actions">
          <button
            className="eryon-confirm-button secondary"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>

          <button
            ref={confirmRef}
            className="eryon-confirm-button danger"
            type="button"
            onClick={onConfirm}
            disabled={busy || countdown > 0}
          >
            {busy
              ? busyLabel
              : countdown > 0
                ? `ESPERA ${countdown}S`
                : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
