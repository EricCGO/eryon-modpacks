import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./EventsPage.css";

/**
 * PANEL DE ADMINISTRACION DE EVENTOS
 *
 * Vista independiente de la vista del jugador. El acceso se establece
 * con la clave admin (se verifica contra el servidor y se guarda solo
 * local; nunca vive en el codigo del launcher). Todas las operaciones
 * publican via Worker eryon-events con el token en el header.
 *
 * Estructura:
 * - Lista de eventos (orden, activar/desactivar, duplicar, borrar)
 * - Editor con vista previa en vivo (textos, fechas, colores,
 *   imagenes optimizadas a WEBP, acciones personalizadas)
 * - Editor del manifiesto de modpack del evento (archivos con URL,
 *   SHA-256 y tamano; helpers: hash desde URL y subida de archivo)
 * - Publicar: reemplaza el manifiesto del servidor y todos los
 *   launchers lo ven automaticamente en su siguiente refresco.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

const TIPOS_ACCION = [
  { value: "play", label: "Jugar ahora" },
  { value: "download", label: "Descargar actualización" },
  { value: "info", label: "Ver información" },
  { value: "discord", label: "Abrir Discord" },
  { value: "external", label: "Página externa" }
];

function nuevoEvento(orden) {
  const base = `evento-${Date.now().toString(36).slice(-5)}`;
  return {
    id: base,
    title: "Nuevo evento",
    subtitle: "",
    description: "",
    banner: null,
    cover: null,
    icon: null,
    buttonImage: null,
    accentColor: "#55d66b",
    startAt: null,
    endAt: null,
    state: "auto",
    enabled: true,
    order: orden,
    actions: [{ type: "play", label: "PARTICIPAR" }],
    minecraft: { version: "1.21.1", loader: "fabric", loaderVersion: "" },
    modpack: { name: "PDESAFIO", version: "" },
    packId: base,
    infoUrl: null,
    discordUrl: null
  };
}

function nuevoPack(id) {
  return {
    id,
    minecraft: "1.21.1",
    loader: "fabric",
    loaderVersion: "",
    files: [],
    remove: []
  };
}

/** Optimiza una imagen a WEBP con canvas (max dimension + calidad). */
async function optimizarImagenWebp(file, maxDim, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  try {
    const escala = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const ancho = Math.max(1, Math.round(bitmap.width * escala));
    const alto = Math.max(1, Math.round(bitmap.height * escala));

    const canvas = document.createElement("canvas");
    canvas.width = ancho;
    canvas.height = alto;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, ancho, alto);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("No se pudo optimizar la imagen"))),
        "image/webp",
        quality
      );
    });
    return blob;
  } finally {
    bitmap.close?.();
  }
}

function Campo({ label, children, ancho }) {
  return (
    <label className="admin-campo" style={ancho ? { gridColumn: `span ${ancho}` } : undefined}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function SubirImagen({
  etiqueta,
  valor,
  maxDim,
  onChange,
  onSubir
}) {
  const inputRef = useRef(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState("");

  async function manejarArchivo(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setError("");
    setOcupado(true);
    try {
      const blob = await optimizarImagenWebp(file, maxDim);
      const resultado = await onSubir(await blob.arrayBuffer(), "image/webp");
      onChange(resultado.url);
    } catch (e) {
      setError(e?.message || "No se pudo subir la imagen");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="admin-imagen-campo">
      <span className="admin-imagen-etiqueta">{etiqueta}</span>
      <div
        className={`admin-imagen-caja ${valor ? "llena" : ""}`}
        onClick={() => !ocupado && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") inputRef.current?.click();
        }}
        title="Clic para elegir una imagen (PNG, JPG o WEBP)"
      >
        {ocupado ? (
          <span>Optimizando y subiendo...</span>
        ) : valor ? (
          <img src={valor} alt={etiqueta} />
        ) : (
          <span>+ Elegir imagen</span>
        )}
      </div>
      {valor && (
        <button
          type="button"
          className="admin-mini-boton"
          onClick={() => onChange(null)}
        >
          Quitar
        </button>
      )}
      {error && <p className="admin-error">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={manejarArchivo}
      />
    </div>
  );
}

/** Tarjeta de vista previa en vivo del evento que se edita. */
function VistaPrevia({ evento }) {
  const estadoInfo = {
    upcoming: "Próximamente",
    active: "En curso",
    finished: "Finalizado"
  }[evento.state === "auto" ? "active" : evento.state] || "En curso";

  const fecha = (iso) =>
    iso
      ? new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" })
      : "";

  return (
    <div className="admin-preview">
      <h4>VISTA PREVIA EN VIVO</h4>
      <article
        className="event-card"
        style={{ "--evento-acento": evento.accentColor || "#55d66b" }}
      >
        <div className="event-card-media">
          {evento.banner ? (
            <img src={evento.banner} alt="" className="event-card-img" />
          ) : (
            <div className="event-imagen-fallback">
              <span>{(evento.title || "?").charAt(0)}</span>
            </div>
          )}
          <div className="event-card-sombra" />
          <div className="event-card-chip">
            <span className={`event-estado-chip estado-${evento.state === "auto" ? "active" : evento.state}`}>
              {estadoInfo}
            </span>
          </div>
        </div>
        <div className="event-card-body">
          <h3 className="event-card-titulo">{evento.title || "(sin título)"}</h3>
          {evento.subtitle && <p className="event-card-subtitulo">{evento.subtitle}</p>}
          <div className="event-card-meta">
            {evento.minecraft?.version && <span className="meta-pill">MC {evento.minecraft.version}</span>}
            {evento.minecraft?.loader && <span className="meta-pill">{evento.minecraft.loader}</span>}
            {evento.modpack?.version && <span className="meta-pill">v{evento.modpack.version}</span>}
          </div>
          {(evento.startAt || evento.endAt) && (
            <p className="event-card-fecha">
              {fecha(evento.startAt)} — {fecha(evento.endAt)}
            </p>
          )}
          <button type="button" className="event-card-boton">
            {evento.actions?.[0]?.label || "PARTICIPAR"}
          </button>
        </div>
      </article>
    </div>
  );
}

/** Editor del manifiesto de modpack de un evento. */
function EditorPack({ evento, pack, setPack, onPublicarPack, onMensaje, instances = [], importing = false, onImportInstance }) {
  const [hashBusy, setHashBusy] = useState(-1);
  const [fileInputIndex, setFileInputIndex] = useState(-1);
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [includeMods, setIncludeMods] = useState(true);
  const fileInputRef = useRef(null);

  function actualizar(indice, campo, valor) {
    setPack((prev) => {
      const files = [...prev.files];
      files[indice] = { ...files[indice], [campo]: valor };
      return { ...prev, files };
    });
  }

  async function hashDesdeUrl(indice) {
    const url = pack.files[indice]?.url;
    if (!url || !/^https:\/\//i.test(url)) {
      onMensaje({ error: "Escribe primero una URL https válida." });
      return;
    }
    setHashBusy(indice);
    try {
      const { sha256, size } = await window.eryon.hashFileFromUrl(url);
      actualizar(indice, "sha256", sha256);
      actualizar(indice, "size", size);
      if (!pack.files[indice]?.path) {
        const nombre = decodeURIComponent(url.split("/").pop() || "archivo.jar");
        actualizar(indice, "path", `mods/${nombre.split("?")[0]}`);
      }
      onMensaje({ ok: `SHA-256 calculado (${Math.round(size / 1024)} KB).` });
    } catch (e) {
      onMensaje({ error: e?.message || "No se pudo calcular el hash" });
    } finally {
      setHashBusy(-1);
    }
  }

  async function hashDelZip() {
    const url = pack.archive?.url;
    if (!url || !/^https:\/\//i.test(url)) {
      onMensaje({ error: "Escribe primero la URL https del ZIP." });
      return;
    }
    setHashBusy("archive");
    try {
      const { sha256, size } = await window.eryon.hashFileFromUrl(url);
      setPack((prev) => ({ ...prev, archive: { ...prev.archive, sha256, size } }));
      onMensaje({ ok: `ZIP verificado (${Math.round(size / 1024 / 1024)} MB).` });
    } catch (e) {
      onMensaje({ error: e?.message || "No se pudo calcular el hash del ZIP" });
    } finally {
      setHashBusy(-1);
    }
  }

  async function subirArchivoLocal(indice) {
    setFileInputIndex(indice);
    fileInputRef.current?.click();
  }

  async function manejarArchivoLocal(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || fileInputIndex < 0) return;

    onMensaje({ ok: `Subiendo ${file.name}...` });
    try {
      const buffer = await file.arrayBuffer();
      const resultado = await window.eryon.uploadEventFile(buffer, file.name);
      const destino =
        file.name.endsWith(".jar") ? "mods" : "config";
      actualizar(fileInputIndex, "url", resultado.url);
      actualizar(fileInputIndex, "sha256", resultado.sha256);
      actualizar(fileInputIndex, "size", resultado.size);
      if (!pack.files[fileInputIndex]?.path) {
        actualizar(fileInputIndex, "path", `${destino}/${file.name}`);
      }
      onMensaje({ ok: `Archivo subido: ${resultado.sha256.slice(0, 12)}…` });
    } catch (e) {
      onMensaje({ error: e?.message || "No se pudo subir el archivo" });
    }
  }

  const archivosValidos = Array.isArray(pack.files) && pack.files.length > 0 && pack.files.every(
      (f) => f.path && /^https:\/\//i.test(f.url) && SHA256_RE.test(f.sha256) && Number.isFinite(f.size)
  );
  const zipValido = pack.archive && /^https:\/\//i.test(pack.archive.url || "") &&
    SHA256_RE.test(pack.archive.sha256 || "") && Number.isFinite(pack.archive.size) && pack.archive.size > 0;
  const packValido = SLUG_RE.test(pack.id || "") && (archivosValidos || zipValido);

  return (
    <div className="admin-pack">
      <h4>MODPACK DEL EVENTO (manifiesto de instalación)</h4>

      <div className="admin-importar-instancia">
        <p className="admin-muted">
          Importa una instalaciÃ³n existente de Eryon. Se copiarÃ¡n mods,
          configuraciones, resourcepacks y shaders; los mundos y logs quedan fuera.
        </p>
        <div className="admin-pack-file-row">
          <select
            value={selectedInstanceId}
            onChange={(event) => setSelectedInstanceId(event.target.value)}
            disabled={importing}
          >
            <option value="">Selecciona una instalaciÃ³n</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name} Â· {instance.minecraftVersion} Â· {instance.loader}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary-button"
            disabled={!selectedInstanceId || importing}
            onClick={() => void onImportInstance?.(selectedInstanceId)}
          >
            {importing ? "IMPORTANDO..." : "IMPORTAR INSTALACIÃ“N"}
          </button>
        </div>
        <label className="admin-check-row">
          <input type="checkbox" checked={includeMods} onChange={(event) => setIncludeMods(event.target.checked)} disabled={importing} />
          Incluir mods (.jar) en esta versión
        </label>
        {!includeMods && <p className="admin-muted">Se incluirán solo configuraciones, resourcepacks y shaders.</p>}
      </div>

      <div className="admin-grid-3">
        <Campo label="Versión de Minecraft">
          <input
            value={pack.minecraft || ""}
            onChange={(e) => setPack((p) => ({ ...p, minecraft: e.target.value }))}
            placeholder="1.21.1"
          />
        </Campo>
        <Campo label="Loader">
          <select
            value={pack.loader || "fabric"}
            onChange={(e) => setPack((p) => ({ ...p, loader: e.target.value }))}
          >
            <option value="fabric">Fabric</option>
            <option value="forge">Forge</option>
            <option value="vanilla">Vanilla</option>
          </select>
        </Campo>
        <Campo label="Versión del loader">
          <input
            value={pack.loaderVersion || ""}
            onChange={(e) => setPack((p) => ({ ...p, loaderVersion: e.target.value }))}
            placeholder="automática si se deja vacío"
          />
        </Campo>
      </div>

      <div className="admin-importar-instancia">
        <h5>ZIP DEL MODPACK (GitHub Releases)</h5>
        <p className="admin-muted">
          Sube un ZIP a una Release de GitHub y pega aquí el enlace que termina en .zip.
          Debe contener mods, config, resourcepacks o shaderpacks.
        </p>
        <div className="admin-pack-file-row">
          <input
            value={pack.archive?.url || ""}
            placeholder="https://github.com/.../releases/download/.../modpack.zip"
            onChange={(e) => setPack((prev) => ({ ...prev, archive: { ...(prev.archive || {}), url: e.target.value } }))}
          />
          <button type="button" className="admin-mini-boton" onClick={() => void hashDelZip()} disabled={hashBusy === "archive"}>
            {hashBusy === "archive" ? "..." : "VERIFICAR ZIP"}
          </button>
        </div>
        <div className="admin-pack-file-row">
          <input className="admin-file-hash" value={pack.archive?.sha256 || ""} placeholder="SHA-256 del ZIP" onChange={(e) => setPack((prev) => ({ ...prev, archive: { ...(prev.archive || {}), sha256: e.target.value } }))} />
          <input className="admin-file-size" type="number" min="1" value={pack.archive?.size ?? ""} placeholder="bytes" onChange={(e) => setPack((prev) => ({ ...prev, archive: { ...(prev.archive || {}), size: Number(e.target.value) } }))} />
        </div>
      </div>

      <div className="admin-pack-files">
        {pack.files.map((file, i) => (
          <div key={i} className="admin-pack-file">
            <div className="admin-pack-file-row">
              <input
                className="admin-file-path"
                value={file.path || ""}
                placeholder="ruta dentro del juego (ej: mods/sodium.jar, config/fancymenu/...)"
                onChange={(e) => actualizar(i, "path", e.target.value)}
              />
              <button
                type="button"
                className="admin-mini-boton peligro"
                onClick={() => setPack((p) => ({ ...p, files: p.files.filter((_, j) => j !== i) }))}
              >
                ✕
              </button>
            </div>
            <div className="admin-pack-file-row">
              <input
                value={file.url || ""}
                placeholder="https:// URL de descarga"
                onChange={(e) => actualizar(i, "url", e.target.value)}
              />
              <button
                type="button"
                className="admin-mini-boton"
                onClick={() => void hashDesdeUrl(i)}
                disabled={hashBusy === i}
              >
                {hashBusy === i ? "..." : "HASH DESDE URL"}
              </button>
              <button
                type="button"
                className="admin-mini-boton"
                onClick={() => void subirArchivoLocal(i)}
              >
                SUBIR ARCHIVO
              </button>
            </div>
            <div className="admin-pack-file-row">
              <input
                className="admin-file-hash"
                value={file.sha256 || ""}
                placeholder="SHA-256 (64 hex)"
                onChange={(e) => actualizar(i, "sha256", e.target.value)}
              />
              <input
                className="admin-file-size"
                type="number"
                min="0"
                value={file.size ?? ""}
                placeholder="bytes"
                onChange={(e) => actualizar(i, "size", Number(e.target.value))}
              />
            </div>
            {file.url && file.sha256 && !SHA256_RE.test(file.sha256) && (
              <p className="admin-error">El SHA-256 debe tener 64 caracteres hexadecimales.</p>
            )}
          </div>
        ))}

        <input
          ref={fileInputRef}
          type="file"
          hidden
          onChange={manejarArchivoLocal}
        />

        <button
          type="button"
          className="secondary-button"
          onClick={() => setPack((p) => ({ ...p, files: [...p.files, {}] }))}
        >
          + Agregar archivo
        </button>
      </div>

      <Campo label="Archivos a eliminar en esta versión (rutas, una por línea)">
        <textarea
          rows={2}
          value={(pack.remove || []).join("\n")}
          onChange={(e) =>
            setPack((p) => ({
              ...p,
              remove: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean)
            }))
          }
          placeholder="mods/mod-viejo.jar"
        />
      </Campo>

      <button
        type="button"
        className="primary-button"
        onClick={() => void onPublicarPack(pack)}
        disabled={!packValido}
      >
        PUBLICAR MANIFIESTO DEL PACK
      </button>
      {!packValido && (
        <p className="admin-error">
          Todos los archivos necesitan ruta, URL https, SHA-256 y tamaño válidos.
        </p>
      )}
    </div>
  );
}

export default function EventsAdmin({ onVolver }) {
  const [token, setToken] = useState("");
  const [tokenListo, setTokenListo] = useState(false);
  const [accesoConcedido, setAccesoConcedido] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMensaje, setTokenMensaje] = useState("");
  const [tokenError, setTokenError] = useState("");

  const [eventos, setEventos] = useState(null);
  const [seleccion, setSeleccion] = useState(null);
  const [packEditado, setPackEditado] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [publicando, setPublicando] = useState(false);
  const [mensaje, setMensaje] = useState(null);
  const [vistaPack, setVistaPack] = useState(false);
  const [instancias, setInstancias] = useState([]);
  const [importandoPack, setImportandoPack] = useState(false);

  useEffect(() => {
    let vivo = true;

    async function cargarClave() {
      const data = await window.eryon?.getEventsAdminToken?.();
      if (!vivo) return;

      const guardada = data?.token || "";
      setToken(guardada);

      if (guardada) {
        try {
          await window.eryon.verifyEventsAdminToken(guardada);
          if (vivo) setAccesoConcedido(true);
        } catch (error) {
          if (vivo) {
            setToken("");
            setTokenError("La clave guardada ya no es válida. Escríbela de nuevo.");
          }
        }
      }

      if (vivo) setTokenListo(true);
    }

    void cargarClave();
    return () => {
      vivo = false;
    };
  }, []);

  const cargarManifiesto = useCallback(async (forzar = true) => {
    setCargando(true);
    try {
      const raw = await window.eryon.getRawEvents({ force: forzar });
      setEventos(Array.isArray(raw?.events) ? raw.events : []);
    } catch (e) {
      setMensaje({ error: e?.message || "No se pudo cargar el manifiesto" });
      setEventos([]);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (tokenListo && token) {
      void cargarManifiesto(true);
    }
  }, [tokenListo, token, cargarManifiesto]);

  useEffect(() => {
    if (!accesoConcedido) return;
    window.eryon?.getInstances?.()
      .then((items) => setInstancias(Array.isArray(items) ? items : []))
      .catch(() => setInstancias([]));
  }, [accesoConcedido]);

  async function guardarToken() {
    setTokenBusy(true);
    setTokenError("");
    setTokenMensaje("");
    try {
      await window.eryon.saveEventsAdminToken(token);
      setAccesoConcedido(true);
      setTokenMensaje("Clave verificada y guardada en esta computadora.");
    } catch (e) {
      setTokenError(e?.message || "No se pudo verificar la clave.");
    } finally {
      setTokenBusy(false);
    }
  }

  async function borrarToken() {
    setTokenBusy(true);
    try {
      await window.eryon.clearEventsAdminToken();
      setToken("");
      setAccesoConcedido(false);
      setTokenMensaje("Clave eliminada de esta computadora.");
    } catch (e) {
      setTokenError(e?.message || "No se pudo eliminar la clave.");
    } finally {
      setTokenBusy(false);
    }
  }

  const eventoEditado = useMemo(
    () => eventos?.find((ev) => ev.id === seleccion) || null,
    [eventos, seleccion]
  );

  function actualizarEvento(campo, valor) {
    setEventos((prev) =>
      prev.map((ev) => (ev.id === seleccion ? { ...ev, [campo]: valor } : ev))
    );
  }

  function actualizarMinecraft(campo, valor) {
    setEventos((prev) =>
      prev.map((ev) =>
        ev.id === seleccion
          ? { ...ev, minecraft: { ...ev.minecraft, [campo]: valor } }
          : ev
      )
    );
  }

  function agregarEvento() {
    const nuevo = nuevoEvento((eventos?.length || 0) + 1);
    setEventos((prev) => [...(prev || []), nuevo]);
    setSeleccion(nuevo.id);
    setVistaPack(false);
    setMensaje({ ok: `Evento "${nuevo.id}" creado localmente. Publica los cambios para que aparezca en todos los launchers.` });
  }

  function duplicarEvento(id) {
    const origen = eventos.find((ev) => ev.id === id);
    if (!origen) return;
    const base = `${origen.id}-copia`.slice(0, 60).replace(/-+$/, "");
    const copia = {
      ...JSON.parse(JSON.stringify(origen)),
      id: base,
      title: `${origen.title} (copia)`
    };
    setEventos((prev) => [...prev, copia]);
    setSeleccion(base);
  }

  function eliminarEvento(id) {
    setEventos((prev) => prev.filter((ev) => ev.id !== id));
    if (seleccion === id) {
      setSeleccion(null);
      setVistaPack(false);
    }
  }

  function moverEvento(id, direccion) {
    setEventos((prev) => {
      const lista = [...prev];
      const i = lista.findIndex((ev) => ev.id === id);
      const j = i + direccion;
      if (i < 0 || j < 0 || j >= lista.length) return lista;
      [lista[i], lista[j]] = [lista[j], lista[i]];
      // Reasigna el orden explicito segun la nueva posicion.
      return lista.map((ev, k) => ({ ...ev, order: k + 1 }));
    });
  }

  async function publicar() {
    setPublicando(true);
    setMensaje(null);
    try {
      await window.eryon.publishEvents({
        events: eventos.map((ev, i) => ({ ...ev, order: ev.order ?? i }))
      });
      setMensaje({ ok: "✓ Publicado. Todos los launchers lo verán en el próximo refresco." });
      await cargarManifiesto(false);
    } catch (e) {
      setMensaje({ error: e?.message || "No se pudo publicar" });
    } finally {
      setPublicando(false);
    }
  }

  async function publicarPack(pack) {
    setMensaje(null);
    try {
      await window.eryon.publishEventPack(pack.id, pack);
      setMensaje({ ok: `✓ Manifiesto del pack "${pack.id}" publicado.` });
    } catch (e) {
      setMensaje({ error: e?.message || "No se pudo publicar el pack" });
    }
  }

  async function importarInstancia(instanceId, options = {}) {
    setImportandoPack(true);
    setMensaje(null);
    try {
      const imported = await window.eryon.importEventInstance(instanceId, options);
      setPackEditado((current) => ({
        ...(current || {}),
        ...imported,
        id: current?.id || eventoEditado.packId
      }));
      setMensaje({ ok: "InstalaciÃ³n importada. Revisa los archivos y publÃ­cala cuando estÃ© lista." });
    } catch (error) {
      setMensaje({ error: error?.message || "No se pudo importar la instalaciÃ³n." });
    } finally {
      setImportandoPack(false);
    }
  }

  async function subirImagen(buffer, contentType) {
    return window.eryon.uploadEventImage(buffer, contentType);
  }

  // ---------- Acceso ----------
  if (!accesoConcedido) {
    return (
      <div className="event-admin-acceso">
        <button type="button" className="event-volver" onClick={onVolver}>
          ‹ Volver a eventos
        </button>
        <div className="event-admin-panel">
          <h2>ACCESO ADMINISTRADOR</h2>
          <p className="event-admin-descripcion">
            Escribe tu clave de administrador de eventos. Se verifica
            contra el servidor y se guarda solo en esta computadora
            (nunca dentro del código del launcher).
          </p>
          <div className="event-admin-fila">
            <input
              type="password"
              value={token}
              placeholder="Clave de administrador"
              onChange={(e) => setToken(e.target.value)}
              disabled={tokenBusy}
            />
            <button
              type="button"
              className="primary-button"
              onClick={() => void guardarToken()}
              disabled={tokenBusy || token.length < 16}
            >
              {tokenBusy ? "VERIFICANDO..." : "ENTRAR"}
            </button>
          </div>
          {tokenMensaje && <p className="event-admin-ok">{tokenMensaje}</p>}
          {tokenError && <p className="event-admin-error">{tokenError}</p>}
        </div>
      </div>
    );
  }

  // ---------- Panel ----------
  return (
    <div className="event-admin">
      <div className="event-admin-toolbar">
        <button type="button" className="event-volver" onClick={onVolver}>
          ‹ Volver a eventos
        </button>
        <div className="event-admin-toolbar-acciones">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void borrarToken()}
            disabled={tokenBusy}
            title="Cerrar sesión de administrador en esta computadora"
          >
            SALIR
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void cargarManifiesto(true)}
            disabled={cargando}
          >
            ⟳ SERVIDOR
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void publicar()}
            disabled={publicando || cargando || !eventos}
          >
            {publicando ? "PUBLICANDO..." : "PUBLICAR CAMBIOS"}
          </button>
        </div>
      </div>

      {mensaje?.ok && <p className="event-admin-ok">{mensaje.ok}</p>}
      {mensaje?.error && <p className="event-admin-error">{mensaje.error}</p>}

      <div className="event-admin-layout">
        {/* Lista */}
        <aside className="event-admin-lista">
          <div className="event-admin-lista-top">
            <h4>EVENTOS ({eventos?.length || 0})</h4>
            <button type="button" className="admin-mini-boton" onClick={agregarEvento}>
              + NUEVO
            </button>
          </div>

          {cargando && <p className="admin-muted">Cargando del servidor...</p>}

          {!cargando &&
            eventos?.map((ev) => (
              <div
                key={ev.id}
                className={`event-admin-item ${seleccion === ev.id ? "activo" : ""} ${ev.enabled === false ? "apagado" : ""}`}
              >
                <button
                  type="button"
                  className="event-admin-item-nombre"
                  onClick={() => {
                    setSeleccion(ev.id);
                    setPackEditado(null);
                    setVistaPack(false);
                  }}
                >
                  <strong>{ev.title || ev.id}</strong>
                  <span>{ev.id}</span>
                </button>
                <div className="event-admin-item-botones">
                  <button type="button" title="Subir" onClick={() => moverEvento(ev.id, -1)}>↑</button>
                  <button type="button" title="Bajar" onClick={() => moverEvento(ev.id, 1)}>↓</button>
                  <button
                    type="button"
                    title={ev.enabled === false ? "Activar" : "Desactivar"}
                    onClick={() => actualizarEventoEnLista(setEventos, ev.id, "enabled", ev.enabled === false)}
                  >
                    {ev.enabled === false ? "○" : "●"}
                  </button>
                  <button type="button" title="Duplicar" onClick={() => duplicarEvento(ev.id)}>⧉</button>
                  <button type="button" title="Eliminar" className="peligro" onClick={() => eliminarEvento(ev.id)}>✕</button>
                </div>
              </div>
            ))}

          {!cargando && eventos?.length === 0 && (
            <p className="admin-muted">No hay eventos. Crea el primero con + NUEVO.</p>
          )}
        </aside>

        {/* Editor */}
        <section className="event-admin-editor">
          {!eventoEditado && (
            <p className="admin-muted">Selecciona un evento de la lista o crea uno nuevo.</p>
          )}

          {eventoEditado && (
            <>
              <div className="event-admin-tabs">
                <button
                  type="button"
                  className={!vistaPack ? "activa" : ""}
                  onClick={() => setVistaPack(false)}
                >
                  CONTENIDO DEL EVENTO
                </button>
                <button
                  type="button"
                  className={vistaPack ? "activa" : ""}
                  onClick={() => {
                    if (!packEditado || packEditado.id !== eventoEditado.packId) {
                      window.eryon
                        .getEventPack(eventoEditado.packId)
                        .then((pack) => setPackEditado(pack))
                        .catch(() => setPackEditado(nuevoPack(eventoEditado.packId)));
                    }
                    setVistaPack(true);
                  }}
                >
                  MODPACK / INSTALACIÓN
                </button>
              </div>

              {!vistaPack && (
                <div className="admin-editor-grid">
                  <div className="admin-form">
                    <div className="admin-grid-2">
                      <Campo label="Identificador (slug, fijo al publicar)">
                        <input
                          value={eventoEditado.id}
                          onChange={(e) =>
                            actualizarEvento("id", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))
                          }
                        />
                      </Campo>
                      <Campo label="Título">
                        <input
                          value={eventoEditado.title || ""}
                          onChange={(e) => actualizarEvento("title", e.target.value)}
                          maxLength={120}
                        />
                      </Campo>
                      <Campo label="Subtítulo" ancho={2}>
                        <input
                          value={eventoEditado.subtitle || ""}
                          onChange={(e) => actualizarEvento("subtitle", e.target.value)}
                        />
                      </Campo>
                      <Campo label="Descripción" ancho={2}>
                        <textarea
                          rows={5}
                          value={eventoEditado.description || ""}
                          onChange={(e) => actualizarEvento("description", e.target.value)}
                        />
                      </Campo>
                      <Campo label="Inicio">
                        <input
                          type="datetime-local"
                          value={aValorInput(eventoEditado.startAt)}
                          onChange={(e) => actualizarEvento("startAt", deValorInput(e.target.value))}
                        />
                      </Campo>
                      <Campo label="Fin">
                        <input
                          type="datetime-local"
                          value={aValorInput(eventoEditado.endAt)}
                          onChange={(e) => actualizarEvento("endAt", deValorInput(e.target.value))}
                        />
                      </Campo>
                      <Campo label="Estado">
                        <select
                          value={eventoEditado.state || "auto"}
                          onChange={(e) => actualizarEvento("state", e.target.value)}
                        >
                          <option value="auto">Automático (por fechas)</option>
                          <option value="upcoming">Próximamente (fijo)</option>
                          <option value="active">En curso (fijo)</option>
                          <option value="finished">Finalizado (fijo)</option>
                        </select>
                      </Campo>
                      <Campo label="Color principal">
                        <input
                          type="color"
                          value={eventoEditado.accentColor || "#55d66b"}
                          onChange={(e) => actualizarEvento("accentColor", e.target.value)}
                        />
                      </Campo>
                      <Campo label="Minecraft">
                        <input
                          value={eventoEditado.minecraft?.version || ""}
                          onChange={(e) => actualizarMinecraft("version", e.target.value)}
                          placeholder="1.21.1"
                        />
                      </Campo>
                      <Campo label="Loader">
                        <select
                          value={eventoEditado.minecraft?.loader || "fabric"}
                          onChange={(e) => actualizarMinecraft("loader", e.target.value)}
                        >
                          <option value="fabric">Fabric</option>
                          <option value="forge">Forge</option>
                          <option value="vanilla">Vanilla</option>
                        </select>
                      </Campo>
                      <Campo label="Versión del loader">
                        <input
                          value={eventoEditado.minecraft?.loaderVersion || ""}
                          onChange={(e) => actualizarMinecraft("loaderVersion", e.target.value)}
                        />
                      </Campo>
                      <Campo label="Nombre del modpack">
                        <input
                          value={eventoEditado.modpack?.name || ""}
                          onChange={(e) =>
                            setEventos((prev) =>
                              prev.map((ev) =>
                                ev.id === seleccion
                                  ? { ...ev, modpack: { ...ev.modpack, name: e.target.value } }
                                  : ev
                              )
                            )
                          }
                        />
                      </Campo>
                      <Campo label="Versión del modpack">
                        <input
                          value={eventoEditado.modpack?.version || ""}
                          onChange={(e) =>
                            setEventos((prev) =>
                              prev.map((ev) =>
                                ev.id === seleccion
                                  ? { ...ev, modpack: { ...ev.modpack, version: e.target.value } }
                                  : ev
                              )
                            )
                          }
                        />
                      </Campo>
                      <Campo label="ID del pack (manifiesto de instalación)">
                        <input
                          value={eventoEditado.packId || ""}
                          onChange={(e) =>
                            actualizarEvento("packId", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))
                          }
                        />
                      </Campo>
                    </div>

                    <div className="admin-imagenes">
                      <SubirImagen
                        etiqueta="Banner (1920px)"
                        valor={eventoEditado.banner}
                        maxDim={1920}
                        onChange={(url) => actualizarEvento("banner", url)}
                        onSubir={subirImagen}
                      />
                      <SubirImagen
                        etiqueta="Portada / fondo"
                        valor={eventoEditado.cover}
                        maxDim={1600}
                        onChange={(url) => actualizarEvento("cover", url)}
                        onSubir={subirImagen}
                      />
                      <SubirImagen
                        etiqueta="Icono (512px)"
                        valor={eventoEditado.icon}
                        maxDim={512}
                        onChange={(url) => actualizarEvento("icon", url)}
                        onSubir={subirImagen}
                      />
                      <SubirImagen
                        etiqueta="Imagen del botón"
                        valor={eventoEditado.buttonImage}
                        maxDim={640}
                        onChange={(url) => actualizarEvento("buttonImage", url)}
                        onSubir={subirImagen}
                      />
                    </div>

                    <div className="admin-acciones-editor">
                      <h4>ACCIONES DEL EVENTO</h4>
                      {(eventoEditado.actions || []).map((accion, i) => (
                        <div key={i} className="admin-accion-fila">
                          <select
                            value={accion.type}
                            onChange={(e) => {
                              const acciones = [...eventoEditado.actions];
                              acciones[i] = { ...acciones[i], type: e.target.value };
                              actualizarEvento("actions", acciones);
                            }}
                          >
                            {TIPOS_ACCION.map((t) => (
                              <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                          </select>
                          <input
                            value={accion.label || ""}
                            placeholder="Texto del botón"
                            onChange={(e) => {
                              const acciones = [...eventoEditado.actions];
                              acciones[i] = { ...acciones[i], label: e.target.value };
                              actualizarEvento("actions", acciones);
                            }}
                          />
                          <input
                            value={accion.url || ""}
                            placeholder="https:// URL (solo acciones de enlace)"
                            onChange={(e) => {
                              const acciones = [...eventoEditado.actions];
                              acciones[i] = { ...acciones[i], url: e.target.value || null };
                              actualizarEvento("actions", acciones);
                            }}
                          />
                          <button
                            type="button"
                            className="admin-mini-boton peligro"
                            onClick={() =>
                              actualizarEvento(
                                "actions",
                                eventoEditado.actions.filter((_, j) => j !== i)
                              )
                            }
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          actualizarEvento("actions", [
                            ...(eventoEditado.actions || []),
                            { type: "discord", label: "ABRIR DISCORD", url: null }
                          ])
                        }
                      >
                        + Agregar acción
                      </button>
                    </div>
                  </div>

                  <VistaPrevia evento={eventoEditado} />
                </div>
              )}

              {vistaPack && packEditado && (
                <EditorPack
                  evento={eventoEditado}
                  pack={packEditado}
                  setPack={setPackEditado}
                  onPublicarPack={publicarPack}
                  onMensaje={setMensaje}
                  instances={instancias}
                  importing={importandoPack}
                  onImportInstance={(instanceId) => importarInstancia(instanceId, { includeMods })}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function actualizarEventoEnLista(setEventos, id, campo, valor) {
  setEventos((prev) =>
    prev.map((ev) => (ev.id === id ? { ...ev, [campo]: valor } : ev))
  );
}

function aValorInput(iso) {
  if (!iso) return "";
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())}T${pad(fecha.getHours())}:${pad(fecha.getMinutes())}`;
}

function deValorInput(valor) {
  if (!valor) return null;
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
}
