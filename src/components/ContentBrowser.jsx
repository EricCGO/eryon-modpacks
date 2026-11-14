
import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./ContentBrowser.css";
import useModalScrollTop from "../lib/useModalScrollTop";

// ======================================================
// EXPLORADOR DE CONTENIDO (ESTILO CURSEFORGE)
// ======================================================
// Pestañas: mods, modpacks, texturas y shaders.
// BÚSQUEDA CON MODRINTH Y CURSEFORGE: no pide ninguna clave
// al usuario (Eryon trae su clave de CurseForge integrada de
// fábrica). El chip de CurseForge solo se activa cuando el
// backend confirma que la clave es válida.
//
// La instalación elige la instancia activa: cada tipo de
// contenido va a su carpeta (mods, resourcepacks,
// shaderpacks). Los modpacks se descargan e instalan
// DIRECTAMENTE como una nueva instancia del launcher.

const CATEGORIES = [
  { id: "mods", label: "MODS", icon: "▣" },
  { id: "modpacks", label: "MODPACKS", icon: "▦" },
  { id: "textures", label: "TEXTURAS", icon: "◐" },
  { id: "shaders", label: "SHADERS", icon: "✦" }
];

const PLACEHOLDERS = {
  mods: "Buscar mods (JourneyMap, Sodium, JEI...)",
  modpacks: "Buscar modpacks (RLCraft, SkyFactory...)",
  textures: "Buscar packs de texturas...",
  shaders: "Buscar shaders..."
};

const LOADERS = [
  { id: "", label: "Todos" },
  { id: "fabric", label: "Fabric" },
  { id: "forge", label: "Forge" },
  { id: "neoforge", label: "NeoForge" },
  { id: "quilt", label: "Quilt" }
];

function parseCompatibilityError(value) {
  const match = String(value || "").match(
    /Este mod es para (.+?) y la instancia utiliza (.+?)(?:\.|$)/i
  );

  if (!match) return null;

  return {
    required: match[1],
    selected: match[2]
  };
}

const CATEGORY_TRANSLATIONS = {
  adventure: "Aventura",
  challenging: "Desafiante",
  combat: "Combate",
  culinary: "Cocina",
  decoration: "Decoración",
  economy: "Economía",
  equipment: "Equipamiento",
  exploration: "Exploración",
  fantasy: "Fantasía",
  "game-mechanics": "Mecánicas de juego",
  library: "Biblioteca",
  magic: "Magia",
  management: "Gestión",
  minigame: "Minijuegos",
  mobs: "Criaturas",
  optimization: "Optimización",
  social: "Social",
  storage: "Almacenamiento",
  technology: "Tecnología",
  transportation: "Transporte",
  utility: "Utilidades",
  worldgen: "Generación del mundo",
  "16x": "16x",
  "32x": "32x",
  "64x": "64x",
  "128x": "128x",
  "256x": "256x",
  "512x": "512x",
  "8x": "8x",
  realistic: "Realista",
  "semi-realistic": "Semirrealista",
  "vanilla-like": "Similar a vanilla",
  themed: "Temática",
  pvp: "PvP",
  modded: "Modificado",
  cartoon: "Caricaturesco",
  atmospheric: "Atmosférico",
  "low-end": "Gama baja",
  "high-end": "Gama alta",
  "path-traced": "Trazado de rutas"
};

function translateCategoryName(name) {
  const normalized = String(name ?? "").trim().toLocaleLowerCase();
  return CATEGORY_TRANSLATIONS[normalized] || name;
}

const CONTENT_PAGE_SIZE = 24;
const MAX_CONTENT_OFFSET = 960;

// Carpetas destino de cada tipo de contenido (constante, fuera
// del componente para no recrearla en cada render).
const CONTENT_FOLDERS = {
  mods: "mods",
  textures: "resourcepacks",
  shaders: "shaderpacks"
};

function formatDownloads(value) {
  const downloads = Number(value) || 0;

  if (downloads >= 1_000_000) {
    return `${(downloads / 1_000_000).toFixed(1)}M`;
  }

  if (downloads >= 1000) {
    return `${(downloads / 1000).toFixed(1)}K`;
  }

  return String(downloads);
}

export default memo(function ContentBrowser({
  onInstancesChanged,
  presetInstanceId = "",
  presetCategory = "mods",
  installingModpackIds = new Set(),
  onModpackInstallStart,
  onModpackInstallFinish
}) {
  const [instanceList, setInstanceList] = useState([]);
  const [selectedInstanceId, setSelectedInstanceId] =
    useState("");

  const [category, setCategory] = useState(presetCategory);
  const [query, setQuery] = useState("");
  const [loader, setLoader] = useState("");

  const [results, setResults] = useState([]);
  const [totalResults, setTotalResults] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const [pageInput, setPageInput] = useState("1");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [installingId, setInstallingId] = useState(null);

  // Selector de versiones: lista de ediciones publicadas del
  // contenido elegido (versión de Minecraft, cargador, fecha).
  const [versionsTarget, setVersionsTarget] = useState(null);
  const [versionsList, setVersionsList] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState("");

  // Filtro por versión del juego: SOLO las versiones que el
  // propio contenido admite (deducidas de sus publicaciones).
  const [filterOptions, setFilterOptions] = useState([]);
  const [gameVersionFilter, setGameVersionFilter] = useState("");
  const [source, setSource] = useState("modrinth");
  const [curseforgeReady, setCurseforgeReady] = useState(false);
  const [sortBy, setSortBy] = useState("relevance");
  const [categoryId, setCategoryId] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersMenuRef = useRef(null);
  const [filterCatalog, setFilterCatalog] = useState({
    modrinth: { mods: [], modpacks: [], textures: [], shaders: [] },
    curseforge: { mods: [], modpacks: [], textures: [], shaders: [] }
  });

  // Identificador del pedido de búsqueda más reciente: si el
  // usuario cambia de fuente o filtro muy rápido, la respuesta
  // vieja ya no pisa la nueva (evita resultados cruzados).
  const searchRequestIdRef = useRef(0);
  // Cache de resultados por clave de búsqueda: alternar entre
  // Modrinth y CurseForge (o regresar a una página ya vista)
  // es instantáneo porque no vuelve a pedir nada a la API.
  const searchCacheRef = useRef(new Map());
  // Última clave "base" (fuente + categoría + filtros + query):
  // cuando cambia, se limpian los resultados viejos en lugar de
  // mostrar los de la otra fuente mientras carga.
  const lastBaseKeyRef = useRef("");
  const LIMITE_CACHE = 30;

  useModalScrollTop(Boolean(versionsTarget), false);

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
    setPageInput(String(Math.floor(pageOffset / CONTENT_PAGE_SIZE) + 1));
  }, [pageOffset]);

  const selectedInstance = instanceList.find(
    (instance) => instance.id === selectedInstanceId
  );

  const needsInstance =
    category === "mods" ||
    category === "textures" ||
    category === "shaders";

  function isModpackInstalling(item) {
    return (
      installingId === item.id ||
      installingModpackIds.has(
        `${item.source || "modrinth"}:${item.id}`
      )
    );
  }

  useEffect(() => {
    let active = true;

    async function loadInitialState() {
      try {
        const instances = await window.eryon?.getInstances?.();

        if (!active) return;

        const list = Array.isArray(instances)
          ? instances
          : [];

        setInstanceList(list);

        if (list.length > 0) {
          setSelectedInstanceId(
            list.find((instance) => instance.id === presetInstanceId)?.id ||
              list[0].id
          );
        }
      } catch {
        // Silencio: la interfaz funciona igualmente en modo consulta.
      }
    }

    loadInitialState();

    return () => {
      active = false;
    };
  }, [presetInstanceId]);

  useEffect(() => {
    let active = true;

    async function loadContentStatus() {
      try {
        const status = await window.eryon?.getModsStatus?.();

        if (active && status) {
          setCurseforgeReady(Boolean(status.curseforgeReady));
        }
      } catch {
        // Silencio: sin CurseForge el explorador sigue con Modrinth.
      }
    }

    loadContentStatus();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadFilters() {
      try {
        const catalog = await window.eryon?.getContentFilters?.();

        if (active && catalog) {
          setFilterCatalog(catalog);
        }
      } catch {
        // Silencio: sin catálogo, solo orden y búsqueda por texto.
      }
    }

    loadFilters();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function runSearch() {
      const requestId = ++searchRequestIdRef.current;

      // Si cambió la fuente/categoría/filtros/query, borramos de
      // una vez los resultados viejos: nunca se mezclan dos
      // fuentes en pantalla.
      const baseKey = JSON.stringify({
        source,
        type: category,
        query,
        gameVersion: selectedInstance?.minecraftVersion || "",
        loader: category === "mods" ? loader : "",
        sort: sortBy,
        category: categoryId
      });

      if (lastBaseKeyRef.current !== baseKey) {
        lastBaseKeyRef.current = baseKey;
        setResults([]);
        setTotalResults(0);
      }

      const cacheKey = JSON.stringify({ ...JSON.parse(baseKey), offset: pageOffset });
      const cached = searchCacheRef.current.get(cacheKey);

      if (cached) {
        setResults(cached.results);
        setTotalResults(cached.total);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const browse = window.eryon?.browseContent;

        if (!browse) {
          throw new Error(
            "El explorador funciona solo dentro del launcher Eryon."
          );
        }

        const payload = await browse({
          source,
          type: category,
          query,
          gameVersion: selectedInstance?.minecraftVersion || "",
          loader: category === "mods" ? loader : "",
          sort: sortBy,
          category: categoryId,
          offset: pageOffset
        });

        // Llegó tarde o el componente se desmontó: se ignora.
        if (requestId !== searchRequestIdRef.current || !active) {
          return;
        }

        const entrada = {
          results: payload.results ?? [],
          total: payload.total ?? 0
        };
        searchCacheRef.current.set(cacheKey, entrada);
        if (searchCacheRef.current.size > LIMITE_CACHE) {
          const masVieja = searchCacheRef.current.keys().next().value;
          searchCacheRef.current.delete(masVieja);
        }

        setResults(entrada.results);
        setTotalResults(entrada.total);
      } catch (searchError) {
        if (requestId !== searchRequestIdRef.current || !active) {
          return;
        }

        setResults([]);
        setTotalResults(0);
        setError(
          searchError?.message ||
            "No se pudo buscar contenido."
        );
      } finally {
        if (requestId === searchRequestIdRef.current && active) {
          setLoading(false);
        }
      }
    }

    runSearch();

    return () => {
      active = false;
    };
    // La búsqueda no reacciona a cada tecla: se dispara por
    // categoría, fuente, orden, filtros o botón BUSCAR.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, loader, source, sortBy, categoryId, selectedInstanceId, pageOffset]);

  // Pre-carga al vuelo: al apuntar a un chip de fuente, ya se
  // está pidiendo la primera página de la otra fuente, así que
  // el cambio se siente instantáneo.
  function prefetchSource(otherSource) {
    const browse = window.eryon?.browseContent;

    if (!browse) {
      return;
    }

    const cacheKey = JSON.stringify({
      source: otherSource,
      type: category,
      query,
      gameVersion: selectedInstance?.minecraftVersion || "",
      loader: category === "mods" ? loader : "",
      sort: sortBy,
      category: categoryId,
      offset: 0
    });

    if (searchCacheRef.current.has(cacheKey)) {
      return;
    }

    browse({
      source: otherSource,
      type: category,
      query,
      gameVersion: selectedInstance?.minecraftVersion || "",
      loader: category === "mods" ? loader : "",
      sort: sortBy,
      category: categoryId,
      offset: 0
    })
      .then((payload) => {
        searchCacheRef.current.set(cacheKey, {
          results: payload.results ?? [],
          total: payload.total ?? 0
        });

        if (searchCacheRef.current.size > LIMITE_CACHE) {
          const masVieja = searchCacheRef.current.keys().next().value;
          searchCacheRef.current.delete(masVieja);
        }
      })
      .catch(() => {
        // Silencio: si falla la pre-carga, la búsqueda normal lo
        // reintenta con su propio manejo de errores.
      });
  }

  async function runManualSearch() {
    setError("");

    const requestId = ++searchRequestIdRef.current;

    if (pageOffset !== 0) {
      setPageOffset(0);
      return;
    }

    // El botón BUSCAR siempre refresca de la API (no usa cache)
    // y actualiza la cache con el resultado fresco.
    setLoading(true);

    try {
      const browse = window.eryon?.browseContent;

      if (!browse) {
        throw new Error(
          "El explorador funciona solo dentro del launcher Eryon."
        );
      }

      const cacheKey = JSON.stringify({
        source,
        type: category,
        query,
        gameVersion: selectedInstance?.minecraftVersion || "",
        loader: category === "mods" ? loader : "",
        sort: sortBy,
        category: categoryId,
        offset: 0
      });

      const payload = await browse({
        source,
        type: category,
        query,
        gameVersion: selectedInstance?.minecraftVersion || "",
        loader: category === "mods" ? loader : "",
        sort: sortBy,
        category: categoryId,
        offset: 0
      });

      if (requestId !== searchRequestIdRef.current) {
        return;
      }

      searchCacheRef.current.set(cacheKey, {
        results: payload.results ?? [],
        total: payload.total ?? 0
      });

      setResults(payload.results ?? []);
      setTotalResults(payload.total ?? 0);
    } catch (searchError) {
      if (requestId !== searchRequestIdRef.current) {
        return;
      }

      setResults([]);
      setTotalResults(0);
      setError(
        searchError?.message || "No se pudo buscar contenido."
      );
    } finally {
      if (requestId === searchRequestIdRef.current) {
        setLoading(false);
      }
    }
  }

  function changeContentPage(offset) {
    setPageOffset(offset);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goToContentPage(event) {
    event.preventDefault();

    const requestedPage = Number(pageInput);
    const maxPage = Math.min(
      Math.ceil(totalResults / CONTENT_PAGE_SIZE),
      Math.floor(MAX_CONTENT_OFFSET / CONTENT_PAGE_SIZE) + 1
    );

    if (
      !Number.isInteger(requestedPage) ||
      requestedPage < 1 ||
      requestedPage > maxPage
    ) {
      setError(`Ingresa una página entre 1 y ${maxPage}.`);
      return;
    }

    setError("");
    changeContentPage((requestedPage - 1) * CONTENT_PAGE_SIZE);
  }

  async function refreshInstances() {
    const list = await window.eryon?.getInstances?.();

    if (Array.isArray(list)) {
      setInstanceList(list);

      if (
        list.length > 0 &&
        !list.some((i) => i.id === selectedInstanceId)
      ) {
        setSelectedInstanceId(list[0].id);
        setPageOffset(0);
      }
    }
  }

  async function install(item, versionId = "") {
    const installFn = window.eryon?.installContent;

    if (!installFn) {
      setError(
        "El explorador funciona solo dentro del launcher Eryon."
      );
      return;
    }

    if (needsInstance && !selectedInstance) {
      setError(
        "Primero elige una instalación aquí arriba (o crea una en el apartado Modpacks)."
      );
      return;
    }

    setInstallingId(item.id);
    setError("");
    setMessage("");

    try {
      const installed = await installFn({
        source: item.source,
        type: item.type,
        projectId: item.id,
        instanceId: selectedInstance?.id,
        gameVersion: selectedInstance?.minecraftVersion || "",
        loader: item.type === "mods" ? loader : "",
        iconUrl: item.iconUrl || "",
        versionId: versionId || ""
      });

      setMessage(
        `Instalado: ${installed.fileName} en ${
          CONTENT_FOLDERS[item.type] ?? "la instancia"
        } de ${selectedInstance?.name ?? "la instalación"}.`
      );
    } catch (installError) {
      setError(
        installError?.message ||
          "No se pudo instalar el contenido."
      );
    } finally {
      setInstallingId(null);
    }
  }

  // Instalar un MODPACK completo como NUEVA instancia:
  // el launcher descarga el pack, lo descomprime y deja la
  // instalación lista para jugar, sin pasos manuales.
  async function installPack(item, versionId = "") {
    const installPackFn = window.eryon?.installModpackContent;

    if (!installPackFn) {
      setError(
        "El explorador funciona solo dentro del launcher Eryon."
      );
      return;
    }

    // No se permite instalar el mismo modpack dos veces:
    // si ya está en curso, se avisa y se cancela el duplicado.
    if (isModpackInstalling(item)) {
      setError(
        `"${item.name}" ya se está instalando. Espera a que termine antes de volver a intentarlo.`
      );
      return;
    }

    setInstallingId(item.id);
    setError("");
    setMessage("");
    onModpackInstallStart?.(item);

    try {
      // Los packs grandes tardan: se informa el progreso en la
      // barra de estado del launcher mientras avanza.
      setMessage(
        `Descargando e instalando "${item.name}" como instancia nueva... Esto puede tardar varios minutos.`
      );

      const instance = await installPackFn({
        source: item.source,
        projectId: item.id,
        name: item.name,
        iconUrl: item.iconUrl,
        versionId: versionId || ""
      });

      // Actualiza la lista del explorador y avisa a la página de
      // Modpacks para que MIS INSTALACIONES refresque al instante.
      try {
        await onInstancesChanged?.();
      } catch {
        // La lista de la página se actualizará al cambiar de vista.
      }

      await refreshInstances();

      onModpackInstallFinish?.(item, { success: true });
      setMessage(
        `Modpack "${instance?.name ?? item.name}" instalado como instancia nueva. Mírala en la pestaña MIS INSTALACIONES.`
      );
    } catch (installError) {
      onModpackInstallFinish?.(item, {
        success: false,
        error:
          installError?.message ||
          "No se pudo instalar el modpack."
      });
      setMessage("");
      setError(
        installError?.message ||
          "No se pudo instalar el modpack."
      );
    } finally {
      setInstallingId(null);
    }
  }

  function formatVersionDate(value) {
    if (!value) return "sin fecha";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "sin fecha";

    return date.toLocaleDateString("es-ES", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
  }

  function formatVersionSize(value) {
    const bytes = Number(value) || 0;

    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    if (bytes >= 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }

    return `${bytes} B`;
  }

  async function loadVersionsFor(item, filter) {
    setVersionsLoading(true);
    setVersionsError("");
    setVersionsList([]);

    try {
      const listVersions = window.eryon?.listContentVersions;

      if (!listVersions) {
        throw new Error(
          "El explorador funciona solo dentro del launcher Eryon."
        );
      }

      const payload = await listVersions({
        source: item.source,
        type: item.type || "modpack",
        projectId: item.id,
        gameVersion: filter || ""
      });

      setVersionsList(
        Array.isArray(payload?.versions) ? payload.versions : []
      );

      // El conjunto de versiones admitidas se recalcula solo en
      // la consulta sin filtro (con filtro ya está en pantalla).
      if (!filter) {
        const options = Array.isArray(payload?.gameVersions)
          ? payload.gameVersions
          : [];

        setFilterOptions(options);

        // Si el contenido solo admite una versión, queda elegida.
        if (options.length === 1) {
          setGameVersionFilter(options[0]);
        }
      }
    } catch (versionsLoadError) {
      setVersionsError(
        versionsLoadError?.message ||
          "No se pudieron cargar las versiones."
      );
    } finally {
      setVersionsLoading(false);
    }
  }

  async function openVersions(item) {
    setVersionsTarget(item);
    setGameVersionFilter("");
    setFilterOptions([]);
    await loadVersionsFor(item, "");
  }

  function changeGameVersionFilter(value) {
    const item = versionsTarget;

    if (!item || versionsLoading) return;

    setGameVersionFilter(value);
    loadVersionsFor(item, value);
  }

  function closeVersions() {
    if (versionsLoading) return;
    setVersionsTarget(null);
    setVersionsList([]);
    setVersionsError("");
  }

  function installChosenVersion(version) {
    const item = versionsTarget;

    if (!item || versionsLoading) return;

    closeVersions();

    if (category === "modpacks") {
      installPack(item, version.versionId);
    } else {
      install(item, version.versionId);
    }
  }

  return (
    <section className="panel content-browser">
      <div className="panel-heading">
        <span className="eyebrow">EXPLORADOR</span>
        <span className="status-pill">Modrinth</span>
      </div>

      <h3 className="content-title">
        Descubre contenido nuevo
      </h3>

      {/* Selección de instalación */}
      {needsInstance && (
        <div className="content-instance-row">
          <label className="field-label" htmlFor="browser-instance">
            INSTALACIÓN DESTINO
          </label>

          {instanceList.length === 0 ? (
            <p className="field-hint">
              No hay instalaciones todavía. Crea una con
              <strong> NUEVA INSTALACIÓN</strong> abajo y aquí
              podrás instalarle mods, texturas y shaders.
            </p>
          ) : (
            <select
              id="browser-instance"
              className="text-input"
              value={selectedInstanceId}
              onChange={(event) => {
                setSelectedInstanceId(event.target.value);
                setPageOffset(0);
              }}
            >
              {instanceList.map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instance.name} · Minecraft{" "}
                  {instance.minecraftVersion} ·{" "}
                  {instance.loader || "vanilla"}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Pestañas por categoría */}
      <div className="content-tabs" role="tablist">
        {CATEGORIES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            className={`content-tab ${
              category === item.id ? "active" : ""
            }`}
            onClick={() => {
              setCategory(item.id);
              setCategoryId("");
              setPageOffset(0);
            }}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>

      {/* Fuente + buscador */}
      <div className="content-search-row">
        <div className="content-source-chips">
          <button
            type="button"
            className={`source-chip${source === "modrinth" ? " active" : ""}`}
            onClick={() => {
              setSource("modrinth");
              setCategoryId("");
              setPageOffset(0);
            }}
            aria-pressed={source === "modrinth"}
          >
            Modrinth
          </button>

          <button
            type="button"
            className={`source-chip${source === "curseforge" ? " active" : ""}${
              curseforgeReady ? "" : " locked"
            }`}
            title={
              curseforgeReady
                ? "Buscar en CurseForge"
                : "CurseForge no disponible en este momento"
            }
            onClick={() => {
              if (!curseforgeReady) return;
              setSource("curseforge");
              setCategoryId("");
              setPageOffset(0);
            }}
            aria-pressed={source === "curseforge"}
            aria-disabled={!curseforgeReady}
          >
            CurseForge
          </button>
        </div>

        <div className="content-filter-menu" ref={filtersMenuRef}>
          <button
            className={`secondary-button content-filter-button${filtersOpen ? " active" : ""}`}
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            aria-controls="content-filter-panel"
          >
            FILTROS{loader || sortBy !== "relevance" || categoryId ? " •" : ""}
          </button>

          <div
            className="content-filter-panel"
            id="content-filter-panel"
            hidden={!filtersOpen}
          >
        {category === "mods" && (
          <select
            className="text-input content-loader-select"
            value={loader}
            onChange={(event) => {
              setLoader(event.target.value);
              setPageOffset(0);
            }}
            aria-label="Cargador de mods"
          >
            {LOADERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        )}

        {/* Orden de resultados (todas las categorías) */}
        <select
          className="text-input content-loader-select"
          value={sortBy}
          onChange={(event) => {
            setSortBy(event.target.value);
            setPageOffset(0);
          }}
          aria-label="Ordenar resultados"
        >
          <option value="relevance">Relevancia</option>
          <option value="downloads">Más descargados</option>
          <option value="newest">Más recientes</option>
          <option value="updated">Actualizados</option>
        </select>

        {/* Categoría específica (según fuente y tipo de contenido) */}
        {(filterCatalog[source]?.[category]?.length ?? 0) > 0 && (
          <select
            className="text-input content-loader-select"
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
              setPageOffset(0);
            }}
            aria-label="Filtrar por categoría"
          >
            <option value="">Todas las categorías</option>
            {filterCatalog[source][category].map((item) => (
              <option key={item.id} value={item.id}>
                {translateCategoryName(item.name)}
              </option>
            ))}
          </select>
        )}

          </div>
        </div>

        <div className="content-search-box">
          <input
            className="text-input"
            value={query}
            placeholder={
              PLACEHOLDERS[category] ?? "Buscar contenido..."
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") runManualSearch();
            }}
          />

          <button
            className="secondary-button"
            type="button"
            onClick={runManualSearch}
            disabled={loading}
          >
            {loading ? "BUSCANDO..." : "BUSCAR"}
          </button>
        </div>
      </div>

      {error && (() => {
        const compatibility = parseCompatibilityError(error);

        if (!compatibility) {
          return <p className="settings-error">{error}</p>;
        }

        return (
          <div className="content-compatibility-error" role="alert">
            <div className="content-compatibility-icon" aria-hidden="true">
              !
            </div>
            <div className="content-compatibility-copy">
              <strong>Mod incompatible con esta instancia</strong>
              <p>El mod no se instaló porque necesita un cargador diferente.</p>
              <div className="content-compatibility-details">
                <span>
                  Requiere <b>{compatibility.required}</b>
                </span>
                <span>
                  Instancia <b>{compatibility.selected}</b>
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {message && (
        <p className="feedback-message">{message}</p>
      )}

      {category === "modpacks" && (
        <p className="field-hint">
          Los modpacks se instalan <strong>DIRECTAMENTE COMO UNA
          NUEVA INSTANCIA</strong>: pulsa DESCARGAR COMO INSTANCIA y
          Eryon baja el pack completo (mods, shaders y
          configuraciones incluidos). La nueva instalación aparece{" "}
          <strong>en BIBLIOTECA abajo</strong>, lista para jugar.
        </p>
      )}

      {!loading && results.length === 0 && !error && (
        <p className="field-hint">
          Sin resultados todavía. Pulsa BUSCAR.
        </p>
      )}

      {/* Resultados */}
      {!loading && results.length > 0 && (
        <p className="content-total">
          {totalResults > 0
            ? `Mostrando ${pageOffset + 1}-${pageOffset + results.length} de ${totalResults} resultados`
            : `${results.length} resultados`}
        </p>
      )}

      <div className="content-grid-list">
        {results.map((item) => (
          <article
            className="content-card"
            key={`${item.source}-${item.id}`}
          >
            <div className="content-card-icon">
              {item.iconUrl ? (
                <img
                  src={item.iconUrl}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span aria-hidden="true">◆</span>
              )}
            </div>

            <div className="content-card-info">
              <h4>{item.name}</h4>

              <p>{item.description}</p>

              <div className="content-card-meta">
                <span>
                  {formatDownloads(item.downloads)} descargas
                </span>
                <span>
                  {item.source === "modrinth"
                    ? "Modrinth"
                    : "CurseForge"}
                </span>
              </div>
            </div>

            <div className="content-card-actions">
              <button
                className="content-versions-button"
                type="button"
                onClick={() => openVersions(item)}
                disabled={
                  installingId === item.id ||
                  (category === "modpacks" &&
                    isModpackInstalling(item))
                }
              >
                VERSIONES ▾
              </button>

              {category === "modpacks" ? (
                <button
                  className="primary-button compact"
                  type="button"
                  onClick={() => installPack(item)}
                  disabled={isModpackInstalling(item)}
                >
                  {isModpackInstalling(item)
                    ? "INSTALANDO..."
                    : "DESCARGAR"}
                </button>
              ) : (
                <button
                  className="primary-button compact"
                  type="button"
                  onClick={() => install(item)}
                  disabled={
                    installingId === item.id ||
                    (needsInstance && !selectedInstance)
                  }
                >
                  {installingId === item.id
                    ? "BAJANDO..."
                    : needsInstance && !selectedInstance
                      ? "SIN INSTANCIA"
                      : "DESCARGAR"}
                </button>
              )}

              {item.pageUrl && (
                <a
                  className="content-link-button"
                  href={item.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  web
                </a>
              )}
            </div>
          </article>
        ))}
      </div>

      {!loading && totalResults > CONTENT_PAGE_SIZE && (
        <nav
          className="content-pagination"
          aria-label="Paginación de contenido"
        >
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              changeContentPage(
                Math.max(0, pageOffset - CONTENT_PAGE_SIZE)
              )
            }
            disabled={pageOffset === 0}
          >
            ANTERIOR
          </button>
          <form
            className="content-page-form"
            onSubmit={goToContentPage}
          >
            <label htmlFor="content-page-number">Página</label>
            <input
              id="content-page-number"
              className="text-input"
              type="number"
              min="1"
              max={Math.min(
                Math.ceil(totalResults / CONTENT_PAGE_SIZE),
                Math.floor(MAX_CONTENT_OFFSET / CONTENT_PAGE_SIZE) + 1
              )}
              step="1"
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              aria-label="Número de página"
            />
            <span>
              de{" "}
              {Math.min(
                Math.ceil(totalResults / CONTENT_PAGE_SIZE),
                Math.floor(MAX_CONTENT_OFFSET / CONTENT_PAGE_SIZE) + 1
              )}
            </span>
            <button
              className="secondary-button"
              type="submit"
              disabled={loading}
            >
              IR
            </button>
          </form>
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              changeContentPage(pageOffset + CONTENT_PAGE_SIZE)
            }
            disabled={
              pageOffset >= MAX_CONTENT_OFFSET ||
              pageOffset + results.length >= totalResults
            }
          >
            SIGUIENTE
          </button>
        </nav>
      )}

      {loading && (
        <div className="content-loading">
          <p className="field-hint">
            Buscando contenido...
          </p>
        </div>
      )}

      {/* Selector de versiones del contenido */}
      {versionsTarget && (
        createPortal(
        <div
          className="content-key-backdrop content-versions-backdrop"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !versionsLoading
            ) {
              closeVersions();
            }
          }}
        >
          <div
            className="content-key-modal content-versions-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="content-versions-title"
          >
            <header>
              <div>
                <p className="instance-settings-eyebrow">
                  VERSIONES DISPONIBLES
                </p>
                <h3 id="content-versions-title">
                  {versionsTarget.name}
                </h3>
              </div>

              <button
                type="button"
                className="instance-settings-close"
                onClick={closeVersions}
                aria-label="Cerrar"
              >
                ×
              </button>
            </header>

            <p className="field-hint">
              Solo se muestran las versiones del juego que admite
              el contenido. Elige la edición que quieras instalar.
            </p>

            <select
              className="text-input content-versions-filter"
              value={gameVersionFilter}
              onChange={(event) =>
                changeGameVersionFilter(event.target.value)
              }
              disabled={versionsLoading || filterOptions.length === 0}
              aria-label="Filtrar por versiones que admite el contenido"
            >
              <option value="">
                Todas las versiones que admite
              </option>

              {filterOptions.map((versionId) => (
                <option key={versionId} value={versionId}>
                  {versionId}
                </option>
              ))}
            </select>

            {versionsLoading && (
              <p className="field-hint">Buscando versiones...</p>
            )}

            {versionsError && (
              <p className="settings-error">{versionsError}</p>
            )}

            <ul className="content-versions-list">
              {versionsList.map((version) => (
                <li
                  className="content-version-row"
                  key={version.versionId}
                >
                  <div className="content-version-info">
                    <strong>{version.name}</strong>

                    <span className="content-version-meta">
                      {[...version.gameVersions, ...version.loaders]
                        .filter(Boolean)
                        .join(" · ") || "sin datos de versión"}
                    </span>

                    <span className="content-version-meta">
                      {formatVersionDate(version.date)} ·{" "}
                      {formatVersionSize(version.size)}
                    </span>
                  </div>

                  <button
                    className="primary-button compact"
                    type="button"
                    onClick={() =>
                      installChosenVersion(version)
                    }
                    disabled={versionsLoading}
                  >
                    INSTALAR
                  </button>
                </li>
              ))}
            </ul>

            {!versionsLoading &&
              !versionsError &&
              versionsList.length === 0 && (
                <p className="field-hint">
                  Este contenido no tiene versiones publicadas.
                </p>
              )}
          </div>
        </div>,
        document.body
        )
      )}
    </section>
  );
});
