
import { useCallback, useEffect, useState } from "react";
import "./InstanceModsModal.css";
import useModalScrollTop from "../lib/useModalScrollTop";

// ======================================================
// MODS DE UNA INSTANCIA (ESTILO CURSEFORGE)
// ======================================================
// Muestra los .jar instalados en la carpeta mods de la
// instancia con el nombre y la versión leídos del propio
// archivo, y permite quitarlos individualmente.

function formatSize(bytes) {
  const size = Number(bytes) || 0;

  if (size >= 1024 * 1024) {
    return `${(size / 1048576).toFixed(1)} MB`;
  }

  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${size} B`;
}

export default function InstanceModsModal({
  instance,
  onClose,
  onExploreMore
}) {
  useModalScrollTop();

  const [mods, setMods] = useState(null);
  const [error, setError] = useState("");
  const [removingId, setRemovingId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  const loadMods = useCallback(async () => {
    const listMods = window.eryon?.listInstanceMods;

    if (!listMods) {
      throw new Error(
        "La vista de mods funciona solo dentro del launcher Eryon."
      );
    }

    const list = await listMods(instance.id);

    return Array.isArray(list) ? list : [];
  }, [instance.id]);

  useEffect(() => {
    let active = true;

    loadMods()
      .then((list) => {
        if (active) setMods(list);
      })
      .catch((loadError) => {
        if (active) {
          setError(
            loadError?.message ||
              "No se pudieron cargar los mods."
          );
          setMods([]);
        }
      });

    return () => {
      active = false;
    };
  }, [loadMods]);

  async function confirmRemove(item) {
    if (confirmId !== item.fileName) {
      setConfirmId(item.fileName);
      return;
    }

    setRemovingId(item.fileName);
    setConfirmId(null);
    setError("");

    try {
      await window.eryon?.deleteInstanceFile?.({
        instanceId: instance.id,
        fileName: item.fileName
      });

      const list = await loadMods();
      setMods(list);
    } catch (removeError) {
      setError(
        removeError?.message ||
          "No se pudo quitar el mod."
      );
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div
      className="instance-settings-backdrop"
      role="dialog"
      aria-modal="true"
    >
      <section className="instance-settings-modal instance-mods-modal">
        <header className="instance-mods-header">
          <div>
            <p className="instance-settings-eyebrow">
              MODS DE LA INSTALACIÓN
            </p>
            <h3>{instance.name}</h3>

            <div className="instance-mods-chips">
              <span className="status-pill">
                Minecraft {instance.minecraftVersion}
              </span>
              <span className="status-pill">
                {(instance.loader || "vanilla").toUpperCase()}
              </span>
              {mods && (
                <span className="status-pill">
                  {mods.length} mods
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            className="instance-settings-close"
            onClick={onClose}
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>

        {error && (
          <p className="settings-error">{error}</p>
        )}

        {mods === null && (
          <p className="field-hint">
            Leyendo los mods de la instalación...
          </p>
        )}

        {mods !== null && mods.length === 0 && (
          <div className="instance-mods-empty">
            <p className="field-hint">
              Esta instalación todavía no tiene mods. Puedes
              añadirlos desde el explorador de contenido
              eligiendo esta instalación como destino.
            </p>

            {onExploreMore && (
              <button
                className="primary-button"
                type="button"
                onClick={onExploreMore}
              >
                EXPLORAR MODS
              </button>
            )}
          </div>
        )}

        {mods !== null && mods.length > 0 && (
          <ul className="instance-mods-list">
            {mods.map((item) => (
              <li
                className="instance-mods-row"
                key={item.fileName}
              >
                <span
                  className="instance-mods-icon"
                  aria-hidden="true"
                >
                  ◆
                </span>

                <div className="instance-mods-info">
                  <div className="instance-mods-name">
                    <span title={item.name}>
                      {item.name}
                    </span>

                    {item.version && (
                      <span className="instance-mods-version">
                        {item.version}
                      </span>
                    )}
                  </div>

                  <p
                    className="instance-mods-file"
                    title={item.fileName}
                  >
                    {item.fileName} · {formatSize(item.size)}
                  </p>

                  {item.description && (
                    <p
                      className="instance-mods-description"
                      title={item.description}
                    >
                      {item.description}
                    </p>
                  )}
                </div>

                <button
                  className={`secondary-button compact ${
                    confirmId === item.fileName
                      ? "danger-button"
                      : ""
                  }`}
                  type="button"
                  onClick={() => confirmRemove(item)}
                  disabled={
                    removingId === item.fileName
                  }
                >
                  {removingId === item.fileName
                    ? "QUITANDO..."
                    : confirmId === item.fileName
                      ? "¿SEGURO?"
                      : "QUITAR"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
