export default function InstanceLaunchProgress({
  instanceName,
  launchProgress,
  onDismiss
}) {
  if (!launchProgress) return null;

  const isError = launchProgress.status === "error";
  const isRunning = launchProgress.status === "running";
  const progress =
    typeof launchProgress.progress === "number"
      ? Math.max(0, Math.min(100, launchProgress.progress))
      : null;

  return (
    <div
      className={`instance-launch-progress ${isError ? "has-error" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="instance-launch-progress-heading">
        <strong>
          {isError
            ? "No se pudo iniciar"
            : isRunning
              ? "Minecraft abierto"
              : "Preparando Minecraft"}
        </strong>
        {isError && onDismiss && (
          <button
            type="button"
            className="instance-launch-dismiss"
            onClick={onDismiss}
            aria-label="Cerrar estado de inicio"
          >
            ×
          </button>
        )}
      </div>
      <span className="instance-launch-progress-message">
        {launchProgress.message}
      </span>
      {!isError && (
        <>
          <div
            className={`modpack-progress-track ${
              progress === null ? "is-indeterminate" : ""
            }`}
            role="progressbar"
            aria-label={`Preparando Minecraft para ${instanceName}`}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={progress === null ? undefined : Math.round(progress)}
          >
            <span
              className="modpack-progress-fill"
              style={{ width: progress === null ? undefined : `${progress}%` }}
            />
          </div>
          {progress !== null && (
            <span className="instance-launch-progress-percent">
              {Math.round(progress)}%
            </span>
          )}
        </>
      )}
    </div>
  );
}
