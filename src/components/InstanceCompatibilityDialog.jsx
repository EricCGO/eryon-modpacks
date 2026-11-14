import "./ConfirmDialog.css";
import useModalScrollTop from "../lib/useModalScrollTop";

export default function InstanceCompatibilityDialog({
  instanceName,
  report,
  busy,
  error,
  onCancel,
  onInstallDependencies,
  onOpenModsFolder,
  onRecheck,
  onLaunchAnyway
}) {
  useModalScrollTop();

  const issues = [
    ...(report?.missingDependencies || []).map((item) => ({
      id: `missing-${item.id}`,
      title: `Falta ${item.name}`,
      detail: `Requerido por ${item.requiredBy}`
    })),
    ...(report?.incompatibleMods || []).map((item, index) => ({
      id: `incompatible-${index}`,
      title: `${item.mod} no parece compatible`,
      detail: `${item.dependency}: requiere ${item.expected}, detectado ${item.actual}`
    })),
    ...(report?.conflicts || []).map((item, index) => ({
      id: `conflict-${index}`,
      title: `Posible conflicto: ${item.mod}`,
      detail: `Declara incompatibilidad con ${item.conflict}`
    }))
  ];

  return (
    <div className="eryon-confirm-overlay">
      <section
        className="eryon-confirm-modal instance-compatibility-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="instance-compatibility-title"
      >
        <div className="eryon-confirm-brand">
          <div className="eryon-confirm-logo">!</div>
          <div>
            <p className="eryon-confirm-eyebrow">COMPROBACIÓN DE MODS</p>
            <h2 id="instance-compatibility-title">Revisa antes de iniciar</h2>
          </div>
        </div>

        <p className="eryon-confirm-description">
          Se detectaron posibles problemas en <strong>{instanceName}</strong>.
          Puedes instalar las dependencias faltantes automáticamente desde
          CurseForge/Modrinth o iniciar bajo tu responsabilidad.
        </p>

        <div className="eryon-confirm-detail instance-compatibility-issues">
          {issues.map((issue) => (
            <div className="instance-compatibility-issue" key={issue.id}>
              <strong>{issue.title}</strong>
              <span>{issue.detail}</span>
            </div>
          ))}
          {issues.length === 0 && (
            <p>La comprobación terminó; revisa los detalles antes de continuar.</p>
          )}
        </div>

        {report?.manualDependencies?.length > 0 && (
          <div className="eryon-confirm-detail instance-manual-dependencies">
            <strong>No se pudieron instalar desde Eryon</strong>
            <p>
              Descarga estos mods desde sus páginas oficiales y coloca los
              archivos en la carpeta <code>mods</code> de esta instalación.
              Revisa que sean para Minecraft {report.minecraftVersion || "indicado"}
              {report.loader ? ` y ${report.loader}` : ""}.
            </p>
            {report.manualDependencies.map((dependency) => (
              <div
                className="instance-compatibility-issue"
                key={`manual-${dependency.id}`}
              >
                <strong>{dependency.name}</strong>
                <span>
                  {dependency.version
                    ? `Versión requerida: ${dependency.version}. `
                    : ""}
                  Necesario para {dependency.requiredBy}. {dependency.reason}
                </span>
                <a
                  href={dependency.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  ABRIR PÁGINA DE DESCARGA
                </a>
              </div>
            ))}
            <div className="eryon-confirm-actions">
              <button
                className="eryon-confirm-button secondary"
                type="button"
                onClick={onOpenModsFolder}
                disabled={busy}
              >
                ABRIR CARPETA MODS
              </button>
              <button
                className="eryon-confirm-button secondary"
                type="button"
                onClick={onRecheck}
                disabled={busy}
              >
                {busy ? "COMPROBANDO..." : "YA LOS INSTALÉ, COMPROBAR"}
              </button>
            </div>
          </div>
        )}

        {error && <p className="settings-error" role="alert">{error}</p>}

        <div className="eryon-confirm-actions instance-compatibility-actions">
          <button
            className="eryon-confirm-button secondary"
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            CANCELAR
          </button>
          {report?.missingDependencies?.length > 0 && (
            <button
              className="eryon-confirm-button secondary"
              type="button"
              onClick={onInstallDependencies}
              disabled={busy}
            >
              {busy ? "INSTALANDO MODS..." : "INSTALAR MODS FALTANTES"}
            </button>
          )}
          <button
            className="eryon-confirm-button danger"
            type="button"
            onClick={onLaunchAnyway}
            disabled={busy}
          >
            INICIAR DE TODOS MODOS
          </button>
        </div>
      </section>
    </div>
  );
}
