import { useEffect, useMemo, useRef, useState } from "react";
import "./InstanceDetailsPage.css";
import InstanceLogo from "./InstanceLogo";
import InstanceLaunchProgress from "./InstanceLaunchProgress";

function formatSize(bytes) {
  const size = Number(bytes) || 0;

  if (size >= 1024 * 1024) return `${(size / 1048576).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function formatDate(value) {
  if (!value) return "Nunca";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Desconocido"
    : date.toLocaleString();
}

function ModIcon({ mod }) {
  const [failed, setFailed] = useState(false);

  if (mod.iconUrl && !failed) {
    return (
      <img
        className="instance-details-mod-image"
        src={mod.iconUrl}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className="instance-details-mod-icon" aria-hidden="true">
      ◆
    </span>
  );
}

const CONTENT_PAGES = [
  { id: "mods", label: "MODS" },
  { id: "textures", label: "TEXTURAS" },
  { id: "shaders", label: "SHADERS" }
];

export default function InstanceDetailsPage({
  instance,
  busy,
  gameRunning,
  launchProgress,
  onDismissLaunchProgress,
  onBack,
  onPlay,
  onSearchMods,
  onOpenFolder,
  onConfigure,
  onDelete
}) {
  const [mods, setMods] = useState(null);
  const [modUpdates, setModUpdates] = useState([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingFile, setUpdatingFile] = useState("");
  const [resourceContent, setResourceContent] = useState({
    textures: null,
    shaders: null
  });
  const [resourceErrors, setResourceErrors] = useState({});
  const [worlds, setWorlds] = useState(null);
  const [worldAction, setWorldAction] = useState("");
  const [instanceStatus, setInstanceStatus] = useState(null);
  const [activeContent, setActiveContent] = useState("mods");
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState("name-asc");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersMenuRef = useRef(null);
  // Incrementa al picarle al botón de recarga: vuelve a leer
  // los mods/texturas/shaders/mundos del disco (útil si el
  // usuario metió archivos a mano en las carpetas).
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [removingFile, setRemovingFile] = useState("");
  const [confirmFile, setConfirmFile] = useState("");
  const [sharing, setSharing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [exportingPack, setExportingPack] = useState(false);
  const [iconUrl, setIconUrl] = useState(instance.iconUrl || "");

  useEffect(() => {
    setIconUrl(instance.iconUrl || "");
  }, [instance.iconUrl]);

  useEffect(() => {
    if (!filtersOpen) return undefined;

    function handlePointerDown(event) {
      if (!filtersMenuRef.current?.contains(event.target)) {
        setFiltersOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [filtersOpen]);

  useEffect(() => {
    let active = true;

    async function loadMods() {
      try {
        const listMods = window.eryon?.listInstanceMods;
        if (!listMods) {
          throw new Error("La lista de mods no está disponible en este launcher.");
        }

        const result = await listMods(instance.id);
        if (active) setMods(Array.isArray(result) ? result : []);
      } catch (loadError) {
        if (active) {
          setError(loadError?.message || "No se pudieron cargar los mods.");
          setMods([]);
        }
      }
    }

    setMods(null);
    setError("");
    setMessage("");
    loadMods();

    return () => {
      active = false;
    };
  }, [instance.id, refreshKey]);

  useEffect(() => {
    let active = true;
    async function loadWorldsAndStatus() {
      try {
        const [worldList, status] = await Promise.all([
          window.eryon?.listInstanceWorlds?.(instance.id),
          window.eryon?.getInstanceStatus?.(instance.id)
        ]);
        if (!active) return;
        setWorlds(Array.isArray(worldList) ? worldList : []);
        setInstanceStatus(status || null);
      } catch (loadError) {
        if (active) {
          setError(loadError?.message || "No se pudo cargar el estado de la instalación.");
        }
      }
    }

    setWorlds(null);
    loadWorldsAndStatus();
    return () => {
      active = false;
    };
  }, [instance.id, refreshKey]);

  useEffect(() => {
    let active = true;

    async function loadResourceContent(category) {
      try {
        const listContent = window.eryon?.listInstanceContent;
        if (!listContent) {
          throw new Error("El contenido de la instalación no está disponible.");
        }

        const result = await listContent({
          instanceId: instance.id,
          category
        });
        if (active) {
          setResourceContent((current) => ({
            ...current,
            [category]: Array.isArray(result) ? result : []
          }));
        }
      } catch (loadError) {
        if (active) {
          setResourceContent((current) => ({
            ...current,
            [category]: []
          }));
          setResourceErrors((current) => ({
            ...current,
            [category]:
              loadError?.message ||
              `No se pudieron cargar las ${category === "textures" ? "texturas" : "sombras"}.`
          }));
        }
      }
    }

    setResourceContent({ textures: null, shaders: null });
    setResourceErrors({});
    loadResourceContent("textures");
    loadResourceContent("shaders");

    return () => {
      active = false;
    };
  }, [instance.id, refreshKey]);

  const currentItems =
    activeContent === "mods" ? mods : resourceContent[activeContent];
  const currentError =
    activeContent === "mods"
      ? error
      : error || resourceErrors[activeContent];

  function reloadInstanceContent() {
    setQuery("");
    setConfirmFile("");
    setError("");
    setMessage("");
    setModUpdates([]);
    setMods(null);
    setResourceContent({ textures: null, shaders: null });
    setWorlds(null);
    setRefreshKey((key) => key + 1);
  }

  const filteredMods = useMemo(() => {
    let items = currentItems ?? [];

    const search = query.trim().toLocaleLowerCase();
    if (search) {
      items = items.filter((item) =>
        [item.name, item.version, item.fileName, item.description]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase().includes(search))
      );
    }

    const sorted = [...items];

    if (sortMode === "name-desc") {
      sorted.sort((a, b) => String(b.name ?? "").localeCompare(a.name ?? ""));
    } else if (sortMode === "size-desc") {
      sorted.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    } else if (sortMode === "size-asc") {
      sorted.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
    } else {
      sorted.sort((a, b) => String(a.name ?? "").localeCompare(b.name ?? ""));
    }

    return sorted;
  }, [currentItems, query, sortMode]);

  async function removeContent(mod) {
    if (confirmFile !== mod.fileName) {
      setConfirmFile(mod.fileName);
      return;
    }

    setRemovingFile(mod.fileName);
    setConfirmFile("");
    setError("");
    setMessage("");

    try {
      const deleteFile = window.eryon?.deleteInstanceFile;
      if (!deleteFile) {
        throw new Error("No se puede quitar contenido en este launcher.");
      }

      await deleteFile({
        instanceId: instance.id,
        fileName: mod.fileName,
        category: activeContent
      });

      if (activeContent === "mods") {
        const result = await window.eryon.listInstanceMods(instance.id);
        setMods(Array.isArray(result) ? result : []);
      } else {
        const result = await window.eryon.listInstanceContent({
          instanceId: instance.id,
          category: activeContent
        });
        setResourceContent((current) => ({
          ...current,
          [activeContent]: Array.isArray(result) ? result : []
        }));
      }

      setMessage(
        `${activeContent === "textures" ? "Textura" : activeContent === "shaders" ? "Shader" : "Mod"} quitado: ${mod.name}.`
      );
    } catch (removeError) {
      setError(
        removeError?.message || "No se pudo quitar el archivo."
      );
    } finally {
      setRemovingFile("");
    }
  }

  async function checkModUpdates() {
    setCheckingUpdates(true);
    setError("");
    setMessage("");
    try {
      const updates = await window.eryon?.checkInstanceModUpdates?.(instance.id);
      setModUpdates(Array.isArray(updates) ? updates : []);
      setMessage(
        updates?.length
          ? `Se encontraron ${updates.length} actualizaciones compatibles.`
          : "No se encontraron actualizaciones compatibles para los mods reconocidos."
      );
    } catch (updateError) {
      setError(updateError?.message || "No se pudieron comprobar las actualizaciones.");
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function updateMod(update) {
    setUpdatingFile(update.fileName);
    setError("");
    setMessage("");
    try {
      await window.eryon?.updateInstanceMod?.({
        instanceId: instance.id,
        fileName: update.fileName,
        projectId: update.projectId,
        versionId: update.versionId
      });
      const list = await window.eryon?.listInstanceMods?.(instance.id);
      setMods(Array.isArray(list) ? list : []);
      setInstanceStatus(
        await window.eryon?.getInstanceStatus?.(instance.id) || null
      );
      setModUpdates((current) =>
        current.filter((item) => item.fileName !== update.fileName)
      );
      setMessage(`${update.name} se actualizó a ${update.latestVersion}.`);
    } catch (updateError) {
      setError(updateError?.message || "No se pudo actualizar el mod.");
    } finally {
      setUpdatingFile("");
    }
  }

  async function refreshWorlds() {
    const result = await window.eryon?.listInstanceWorlds?.(instance.id);
    setWorlds(Array.isArray(result) ? result : []);
  }

  async function backupWorld(world) {
    setWorldAction(`backup:${world.name}`);
    setError("");
    setMessage("");
    try {
      await window.eryon?.backupInstanceWorld?.({
        instanceId: instance.id,
        worldName: world.name
      });
      await refreshWorlds();
      setInstanceStatus(
        await window.eryon?.getInstanceStatus?.(instance.id) || null
      );
      setMessage(`Se creó un respaldo de "${world.name}".`);
    } catch (backupError) {
      setError(backupError?.message || "No se pudo respaldar el mundo.");
    } finally {
      setWorldAction("");
    }
  }

  async function restoreWorld(world, backup) {
    setWorldAction(`restore:${backup.id}`);
    setError("");
    setMessage("");
    try {
      const restored = await window.eryon?.restoreInstanceWorldBackup?.({
        instanceId: instance.id,
        worldName: world.name,
        backupId: backup.id
      });
      await refreshWorlds();
      setInstanceStatus(
        await window.eryon?.getInstanceStatus?.(instance.id) || null
      );
      setMessage(`Respaldo restaurado como "${restored.worldName}".`);
    } catch (restoreError) {
      setError(restoreError?.message || "No se pudo restaurar el respaldo.");
    } finally {
      setWorldAction("");
    }
  }

  async function repairInstallation() {
    setRepairing(true);
    setError("");
    setMessage("");
    try {
      const result = await window.eryon?.repairInstance?.(instance.id);
      if (!result?.repaired) {
        throw new Error("La reparación no se completó.");
      }
      setMessage(result.message || "Se verificaron los archivos de la instalación.");
      const status = await window.eryon?.getInstanceStatus?.(instance.id);
      setInstanceStatus(status || null);
    } catch (repairError) {
      setError(repairError?.message || "No se pudo reparar la instalación.");
    } finally {
      setRepairing(false);
    }
  }

  async function openLogs(folder = "logs") {
    setError("");
    try {
      await window.eryon?.openInstanceFolder?.(instance.id, folder);
    } catch (logError) {
      setError(logError?.message || "No se pudieron abrir los registros.");
    }
  }

  async function exportModpack() {
    setExportingPack(true);
    setError("");
    setMessage("");
    try {
      const result = await window.eryon?.exportInstanceModpack?.(instance.id);
      if (result?.canceled) return;
      if (!result?.exported) {
        throw new Error("No se pudo completar la exportación.");
      }
      setMessage(`Modpack exportado: ${result.filePath}`);
    } catch (exportError) {
      setError(exportError?.message || "No se pudo exportar el modpack.");
    } finally {
      setExportingPack(false);
    }
  }

  async function shareInstance() {
    const modList = (mods ?? []).map((mod) => {
      const version = mod.version ? ` (${mod.version})` : "";
      return `- ${mod.name}${version}`;
    });
    const text = [
      `Estoy usando "${instance.name}" en Eryon Launcher`,
      `Minecraft ${instance.minecraftVersion} · ${(instance.loader || "vanilla").toUpperCase()}`,
      `${mods?.length ?? 0} mods`,
      ...modList
    ].join("\n");

    setSharing(true);
    setError("");
    setMessage("");

    try {
      if (navigator.share) {
        await navigator.share({ title: instance.name, text });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("Compartir no está disponible en este sistema.");
      }

      setMessage(
        navigator.share
          ? "Se compartieron los detalles de la instalación."
          : "Se copió al portapapeles la lista de la instalación."
      );
    } catch (shareError) {
      if (shareError?.name !== "AbortError") {
        setError(shareError?.message || "No se pudo compartir la instalación.");
      }
    } finally {
      setSharing(false);
    }
  }

  return (
    <section className="instance-details-page">
      <button className="instance-details-back" type="button" onClick={onBack}>
        ← VOLVER A MIS INSTALACIONES
      </button>

      <header className="instance-details-hero panel">
        <div className="instance-details-cover" aria-hidden="true">
          <InstanceLogo
            iconUrl={iconUrl}
            fallback={
              instance.loader === "forge"
                ? "⬡"
                : instance.loader === "fabric"
                  ? "◇"
                  : "▦"
            }
          />
        </div>

        <div className="instance-details-heading">
          <span className="eyebrow">
            {instance.kind === "modpack" ? "MODPACK" : "INSTALACIÓN"}
          </span>
          <h1>{instance.name}</h1>
          <div className="instance-details-chips">
            <span className="status-pill">Minecraft {instance.minecraftVersion}</span>
            <span className="status-pill">{(instance.loader || "vanilla").toUpperCase()}</span>
            {mods && <span className="status-pill">{mods.length} mods</span>}
            {instanceStatus && (
              <>
                <span className="status-pill">
                  {formatSize(instanceStatus.size)} usados
                </span>
                <span className="status-pill">
                  Último inicio: {formatDate(instanceStatus.lastPlayedAt)}
                </span>
                {instanceStatus.lastCrash && (
                  <span
                    className="status-pill instance-crash-status"
                    title={instanceStatus.lastCrash.reportName}
                  >
                    Último cierre inesperado: código{" "}
                    {instanceStatus.lastCrash.code} ·{" "}
                    {formatDate(instanceStatus.lastCrash.createdAt)}
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="instance-details-actions">
          <button
            className="primary-button"
            type="button"
            onClick={onPlay}
            disabled={
              busy ||
              gameRunning ||
              repairing ||
              exportingPack ||
              Boolean(updatingFile) ||
              Boolean(worldAction)
            }
          >
            {gameRunning ? "MINECRAFT EN EJECUCIÓN" : "JUGAR"}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={shareInstance}
            disabled={sharing || mods === null}
          >
            {sharing ? "COMPARTIENDO..." : "COMPARTIR"}
          </button>
          <button className="secondary-button" type="button" onClick={onSearchMods}>
            BUSCAR MODS
          </button>
        </div>
        <InstanceLaunchProgress
          instanceName={instance.name}
          launchProgress={launchProgress}
          onDismiss={onDismissLaunchProgress}
        />
      </header>

      <div className="instance-details-content">
        <section className="panel instance-details-mods">
          <div className="instance-content-tabs" role="tablist" aria-label="Contenido de la instalación">
            {CONTENT_PAGES.map((page) => {
              const items =
                page.id === "mods" ? mods : resourceContent[page.id];
              return (
                <button
                  key={page.id}
                  type="button"
                  role="tab"
                  aria-selected={activeContent === page.id}
                  className={`content-tab ${
                    activeContent === page.id ? "active" : ""
                  }`}
                  onClick={() => {
                    setActiveContent(page.id);
                    setQuery("");
                    setSoloActualizables(false);
                    setConfirmFile("");
                    setError("");
                    setMessage("");
                  }}
                >
                  {page.label}
                  <span className="instance-content-tab-count">
                    {items === null ? "…" : items?.length ?? 0}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="instance-details-section-heading">
            <div>
              <span className="eyebrow">CONTENIDO</span>
              <h2>
                {activeContent === "mods"
                  ? "Mods instalados"
                  : activeContent === "textures"
                    ? "Texturas instaladas"
                    : "Shaders instalados"}
              </h2>
            </div>
            <div className="instance-details-content-actions">
              <button
                className="instance-reload-button"
                type="button"
                onClick={reloadInstanceContent}
                disabled={currentItems === null}
                title="Recargar contenido (si añadiste mods o texturas a mano en la carpeta)"
                aria-label="Recargar contenido de la instalación"
              >
                <span
                  className={currentItems === null ? "girando" : ""}
                  aria-hidden="true"
                >
                  ↻
                </span>
              </button>
              <span className="status-pill">
                {currentItems === null
                  ? "CARGANDO"
                  : `${currentItems.length} TOTAL`}
              </span>
              {activeContent === "mods" && (
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={checkModUpdates}
                  disabled={checkingUpdates || mods === null || Boolean(updatingFile)}
                >
                  {checkingUpdates
                    ? "BUSCANDO..."
                    : `BUSCAR ACTUALIZACIONES${modUpdates.length ? ` (${modUpdates.length})` : ""}`}
                </button>
              )}
            </div>
          </div>

          <div className="instance-details-filters">
            <label className="instance-details-search">
              <span aria-hidden="true">⌕</span>
              <input
                className="text-input"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Buscar ${
                  activeContent === "mods"
                    ? "mods"
                    : activeContent === "textures"
                      ? "texturas"
                      : "shaders"
                }...`}
                aria-label={`Buscar ${
                  activeContent === "mods"
                    ? "mods"
                    : activeContent === "textures"
                      ? "texturas"
                      : "shaders"
                } instalados`}
              />
            </label>

            <div className="instance-filter-menu" ref={filtersMenuRef}>
            <button
              className={`secondary-button compact instance-filter-button${filtersOpen ? " active" : ""}`}
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              aria-controls="instance-filter-panel"
            >
              FILTROS
            </button>
            <div className="instance-filter-panel" id="instance-filter-panel" hidden={!filtersOpen}>
            <label>
              <span>Ordenar por</span>
            <select
              className="text-input instance-filter-select"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value)}
              aria-label="Ordenar contenido"
            >
              <option value="name-asc">Nombre (A-Z)</option>
              <option value="name-desc">Nombre (Z-A)</option>
              <option value="size-desc">Tamaño (mayor a menor)</option>
              <option value="size-asc">Tamaño (menor a mayor)</option>
            </select>
            </label>
            </div>
            </div>

          </div>

          {currentError && <p className="settings-error" role="alert">{currentError}</p>}
          {message && <p className="feedback-message" role="status">{message}</p>}

          {currentItems === null ? (
            <p className="field-hint">
              Cargando{" "}
              {activeContent === "mods"
                ? "mods"
                : activeContent === "textures"
                  ? "texturas"
                  : "shaders"}{" "}
              de la instalación...
            </p>
          ) : currentItems.length === 0 ? (
            <div className="instance-details-empty">
              <p className="field-hint">
                {activeContent === "mods"
                  ? "Esta instalación todavía no tiene mods."
                  : activeContent === "textures"
                    ? "Esta instalación todavía no tiene packs de texturas."
                    : "Esta instalación todavía no tiene shaders."}{" "}
                Busca contenido compatible para añadirlo.
              </p>
              <button
                className="primary-button"
                type="button"
                onClick={() => onSearchMods(activeContent)}
              >
                BUSCAR {activeContent === "mods" ? "MODS" : activeContent === "textures" ? "TEXTURAS" : "SHADERS"}
              </button>
            </div>
          ) : filteredMods.length === 0 ? (
            <p className="field-hint">No hay archivos que coincidan con la búsqueda.</p>
          ) : (
            <ul className="instance-details-mod-list">
              {filteredMods.map((item) => (
                <li className="instance-details-mod" key={item.fileName}>
                  <ModIcon mod={item} />
                  <div className="instance-details-mod-info">
                    <strong>{item.name}</strong>
                    <span title={item.fileName}>
                      {item.version ? `${item.version} · ` : ""}
                      {item.fileName} · {formatSize(item.size)}
                    </span>
                    {item.description && <p>{item.description}</p>}
                  </div>
                  <button
                    className={`secondary-button compact ${
                      confirmFile === item.fileName ? "danger-button" : ""
                    }`}
                    type="button"
                    disabled={removingFile === item.fileName}
                    onClick={() => removeContent(item)}
                  >
                    {removingFile === item.fileName
                      ? "QUITANDO..."
                      : confirmFile === item.fileName
                        ? "¿SEGURO?"
                        : "QUITAR"}
                  </button>
                  {activeContent === "mods" &&
                    modUpdates.find((update) => update.fileName === item.fileName) && (
                      <button
                        className="secondary-button compact"
                        type="button"
                        disabled={
                          Boolean(updatingFile) ||
                          checkingUpdates ||
                          busy ||
                          gameRunning ||
                          repairing ||
                          Boolean(worldAction)
                        }
                        onClick={() =>
                          updateMod(
                            modUpdates.find(
                              (update) => update.fileName === item.fileName
                            )
                          )
                        }
                        title={`Actualizar ${item.name} a ${modUpdates.find((update) => update.fileName === item.fileName)?.latestVersion}`}
                      >
                        {updatingFile === item.fileName
                          ? "ACTUALIZANDO..."
                          : "ACTUALIZAR"}
                      </button>
                    )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="panel instance-details-manage">
          <span className="eyebrow">ADMINISTRAR</span>
          <h2>Instalación</h2>
          <div className="instance-details-meta">
            <span>Versión del cargador</span>
            <strong>{instance.loaderVersion || "Original"}</strong>
            <span>Tipo</span>
            <strong>
              {instance.kind === "modpack" ? "Modpack importado" : "Instalación independiente"}
            </strong>
          </div>
          <button className="secondary-button" type="button" onClick={onConfigure}>
            CONFIGURAR
          </button>
          <details className="instance-tools">
            <summary>HERRAMIENTAS DE INSTALACIÓN</summary>
            <div className="instance-tools-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={repairInstallation}
                disabled={
                  repairing ||
                  busy ||
                  gameRunning ||
                  Boolean(worldAction)
                }
                title="Verifica archivos de Minecraft, bibliotecas y recursos"
              >
                {repairing ? "REPARANDO..." : "REPARAR INSTALACIÓN"}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => openLogs("logs")}
              >
                ABRIR REGISTROS
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => openLogs("crash-reports")}
              >
                ABRIR INFORMES DE CIERRE
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={exportModpack}
                disabled={exportingPack || busy || gameRunning}
              >
                {exportingPack ? "EXPORTANDO..." : "EXPORTAR MODPACK"}
              </button>
            </div>
          </details>
          <button
            className="secondary-button"
            type="button"
            onClick={onOpenFolder}
          >
            ABRIR CARPETA
          </button>
          <button
            className="secondary-button danger-button"
            type="button"
            onClick={onDelete}
            disabled={busy || gameRunning}
          >
            ELIMINAR INSTALACIÓN
          </button>
        </aside>
      </div>

      <section className="panel instance-world-backups">
        <div className="instance-details-section-heading">
          <div>
            <span className="eyebrow">MUNDOS</span>
            <h2>Respaldos manuales</h2>
          </div>
          <span className="status-pill">
            {worlds === null ? "CARGANDO" : `${worlds.length} MUNDOS`}
          </span>
        </div>
        <p className="field-hint">
          Se conservan hasta 5 respaldos por mundo. Restaurar crea una copia
          nueva y no sobrescribe el mundo actual.
        </p>
        {worlds?.length === 0 && (
          <p className="field-hint">No hay mundos guardados en esta instalación.</p>
        )}
        {worlds?.map((world) => (
          <div className="instance-world-backup-row" key={world.name}>
            <div className="instance-world-backup-info">
              <strong>{world.name}</strong>
              <span>
                {formatSize(world.size)} · {world.backups.length} respaldos
              </span>
            </div>
            <button
              className="secondary-button compact"
              type="button"
              disabled={
                Boolean(worldAction) ||
                busy ||
                gameRunning ||
                repairing ||
                world.modifiedAt === 0
              }
              onClick={() => backupWorld(world)}
            >
              {worldAction === `backup:${world.name}` ? "RESPALDANDO..." : "CREAR RESPALDO"}
            </button>
            {world.backups.map((backup) => (
              <button
                className="secondary-button compact"
                key={backup.id}
                type="button"
                disabled={
                  Boolean(worldAction) ||
                  busy ||
                  gameRunning ||
                  repairing
                }
                title={`Respaldo del ${formatDate(backup.createdAt)} · ${formatSize(backup.size)}`}
                onClick={() => restoreWorld(world, backup)}
              >
                {worldAction === `restore:${backup.id}`
                  ? "RESTAURANDO..."
                  : `RESTAURAR ${new Date(backup.createdAt).toLocaleDateString()}`}
              </button>
            ))}
          </div>
        ))}
      </section>
    </section>
  );
}
