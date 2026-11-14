import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EventsAdmin from "./EventsAdmin";
import "./EventsPage.css";

/**
 * EVENTOS DEL LAUNCHER
 *
 * Seccion publica de eventos. Los datos llegan del Worker
 * eryon-events (con caché local del main process), cada evento trae
 * sus acciones y su manifiesto de modpack. El flujo de preparacion
 * (descarga incremental + verificacion) vive en el main process y
 * reporta progreso por eryon:launch-event (type "event-progress").
 */

const ESTADO_LABELS = {
  upcoming: { texto: "Próximamente", clase: "upcoming" },
  active: { texto: "En curso", clase: "active" },
  finished: { texto: "Finalizado", clase: "finished" }
};

function formatearFecha(iso) {
  if (!iso) return "";
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "";
  return fecha.toLocaleDateString("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function formatearRango(inicio, fin) {
  const a = formatearFecha(inicio);
  const b = formatearFecha(fin);
  if (a && b) return `${a} — ${b}`;
  return a || b || "Sin fecha definida";
}

function formatearVelocidad(bytesPorSegundo) {
  if (!Number.isFinite(bytesPorSegundo) || bytesPorSegundo <= 0) return "";
  const mb = bytesPorSegundo / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPorSegundo / 1024))} KB/s`;
}

function formatearEta(segundos) {
  if (!Number.isFinite(segundos) || segundos <= 0) return "";
  const minutos = Math.floor(segundos / 60);
  const resto = Math.round(segundos % 60);
  if (minutos >= 1) return `~${minutos} min ${resto}s`;
  return `~${resto}s`;
}

function EstadoChip({ estado }) {
  const info = ESTADO_LABELS[estado] || ESTADO_LABELS.active;
  return (
    <span className={`event-estado-chip estado-${info.clase}`}>
      {info.texto}
    </span>
  );
}

/** Imagen con respaldo: si no hay URL o falla, muestra un degradado
 * con la inicial del evento. */
function EventImage({ src, alt, className, accentColor, letra }) {
  const [rota, setRota] = useState(false);

  if (!src || rota) {
    return (
      <div
        className={`${className || ""} event-imagen-fallback`}
        style={
          accentColor
            ? { "--evento-acento": accentColor }
            : undefined
        }
      >
        <span>{letra}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt || ""}
      className={className}
      draggable="false"
      loading="lazy"
      onError={() => setRota(true)}
    />
  );
}

/**
 * Bloque de progreso de preparacion del evento: barra, %, velocidad,
 * archivos descargados/pendientes y tiempo estimado.
 */
function EventProgress({ progreso }) {
  if (!progreso) return null;

  const percent = Math.max(0, Math.min(100, Number(progreso.percent) || 0));
  const descargados = Number(progreso.downloadedFiles) || 0;
  const total = Number(progreso.totalFiles) || 0;
  const pendientes = Math.max(0, total - descargados);
  const velocidad = formatearVelocidad(progreso.speedBytes);
  const eta = formatearEta(progreso.etaSeconds);
  const estado = progreso.status || progreso.stage || "";

  return (
    <div className={`event-progress estado-${estado}`}>
      <div className="event-progress-top">
        <span className="event-progress-message">
          {progreso.message || "Preparando el evento..."}
        </span>
        <span className="event-progress-percent">{Math.round(percent)}%</span>
      </div>

      <div className="event-progress-bar">
        <div
          className="event-progress-fill"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="event-progress-stats">
        {total > 0 && (
          <span>
            Archivos: <strong>{descargados}</strong>/{total}
            {pendientes > 0 && estado === "downloading" ? ` · faltan ${pendientes}` : ""}
          </span>
        )}
        {velocidad && <span>{velocidad}</span>}
        {eta && estado === "downloading" && <span>queda {eta}</span>}
      </div>
    </div>
  );
}

function EventCard({ evento, progreso, preparando, listo, pendienteActualizacion, onAbrir, onAccionPrimaria }) {
  const accion = evento.actions?.find((a) => a.type === "play" || a.type === "download") ||
    evento.actions?.[0];

  const finalizado = evento.state === "finished";
  const etiquetaBoton = listo
    ? "▸ JUGAR"
    : preparando
      ? "PREPARANDO..."
      : pendienteActualizacion
        ? "↓ DESCARGAR ACTUALIZACIÓN"
        : accion.label || (accion.type === "download" ? "DESCARGAR ACTUALIZACIÓN" : "PARTICIPAR");

  return (
    <article
      className={`event-card estado-${evento.state} ${listo ? "listo" : ""}`}
      style={evento.accentColor ? { "--evento-acento": evento.accentColor } : undefined}
      onClick={() => onAbrir(evento.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onAbrir(evento.id);
        }
      }}
    >
      <div className="event-card-media">
        <EventImage
          src={evento.banner || evento.cover}
          alt={evento.title}
          className="event-card-img"
          accentColor={evento.accentColor}
          letra={evento.title.charAt(0)}
        />
        <div className="event-card-sombra" />
        <div className="event-card-chip">
          <EstadoChip estado={evento.state} />
        </div>
      </div>

      <div className="event-card-body">
        <h3 className="event-card-titulo">{evento.title}</h3>
        {evento.subtitle && (
          <p className="event-card-subtitulo">{evento.subtitle}</p>
        )}

        <div className="event-card-meta">
          {evento.minecraft?.version && (
            <span className="meta-pill">MC {evento.minecraft.version}</span>
          )}
          {evento.minecraft?.loader && (
            <span className="meta-pill">{evento.minecraft.loader}</span>
          )}
          {evento.modpack?.version && (
            <span className="meta-pill">v{evento.modpack.version}</span>
          )}
        </div>

        <p className="event-card-fecha">{formatearRango(evento.startAt, evento.endAt)}</p>

        {!finalizado && accion && (
          <button
            type="button"
            className={`event-card-boton ${listo ? "jugar" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onAccionPrimaria(evento, listo ? { type: "play" } : { type: pendienteActualizacion ? "download" : accion.type });
            }}
            disabled={preparando}
          >
            {etiquetaBoton}
          </button>
        )}

        {progreso && <EventProgress progreso={progreso} />}
      </div>
    </article>
  );
}

function EventoDetalle({ evento, progreso, preparando, listo, pendienteActualizacion, onVolver, onAccionPrimaria, onAccionEnlace }) {
  const acciones = evento.actions || [];

  return (
    <div className="event-detalle">
      <button type="button" className="event-volver" onClick={onVolver}>
        ‹ Volver a eventos
      </button>

      <div
        className="event-detalle-hero"
        style={evento.accentColor ? { "--evento-acento": evento.accentColor } : undefined}
      >
        <EventImage
          src={evento.banner || evento.cover}
          alt={evento.title}
          className="event-detalle-img"
          accentColor={evento.accentColor}
          letra={evento.title.charAt(0)}
        />
        <div className="event-detalle-overlay">
          <EstadoChip estado={evento.state} />
          <h2>{evento.title}</h2>
          {evento.subtitle && <p className="event-detalle-subtitulo">{evento.subtitle}</p>}
          <p className="event-detalle-fecha">{formatearRango(evento.startAt, evento.endAt)}</p>
        </div>
      </div>

      <div className="event-detalle-contenido">
        {evento.description && (
          <section className="event-detalle-bloque">
            <h4>SOBRE EL EVENTO</h4>
            <p className="event-detalle-descripcion">{evento.description}</p>
          </section>
        )}

        <section className="event-detalle-bloque">
          <h4>INFORMACIÓN TÉCNICA</h4>
          <div className="event-meta-grid">
            {evento.minecraft?.version && (
              <div className="event-meta-item">
                <span>Minecraft</span>
                <strong>{evento.minecraft.version}</strong>
              </div>
            )}
            {evento.minecraft?.loader && (
              <div className="event-meta-item">
                <span>Cargador</span>
                <strong>{evento.minecraft.loader}</strong>
              </div>
            )}
            {evento.minecraft?.loaderVersion && (
              <div className="event-meta-item">
                <span>Versión del cargador</span>
                <strong>{evento.minecraft.loaderVersion}</strong>
              </div>
            )}
            {evento.modpack?.name && (
              <div className="event-meta-item">
                <span>Modpack</span>
                <strong>{evento.modpack.name}</strong>
              </div>
            )}
            {evento.modpack?.version && (
              <div className="event-meta-item">
                <span>Versión del modpack</span>
                <strong>{evento.modpack.version}</strong>
              </div>
            )}
          </div>
        </section>

        {acciones.length > 0 && (
          <section className="event-detalle-bloque">
            <h4>ACCIONES</h4>
            <div className="event-acciones">
              {acciones.map((accion, index) => {
                const esPrincipal = accion.type === "play" || accion.type === "download";
                if (esPrincipal) {
                  const accionDinamica = listo && accion.type !== "download"
                    ? { type: "play" }
                    : pendienteActualizacion && accion.type !== "download"
                      ? { type: "download" }
                      : accion;
                  const etiqueta = listo && accion.type !== "download"
                    ? "▸ JUGAR"
                    : preparando
                      ? "PREPARANDO..."
                      : pendienteActualizacion
                        ? "↓ DESCARGAR ACTUALIZACIÓN"
                        : accion.label || (accion.type === "download" ? "DESCARGAR ACTUALIZACIÓN" : "PARTICIPAR");

                  return (
                    <button
                      key={`${accion.type}-${index}`}
                      type="button"
                      className="primary-button"
                      onClick={() => onAccionPrimaria(evento, accionDinamica)}
                      disabled={preparando}
                    >
                      {etiqueta}
                    </button>
                  );
                }

                if (accion.type === "info") {
                  return (
                    <button
                      key={`${accion.type}-${index}`}
                      type="button"
                      className="secondary-button"
                      onClick={() => onAccionEnlace(accion.url || evento.infoUrl)}
                    >
                      {accion.label || "VER INFORMACIÓN"}
                    </button>
                  );
                }

                return (
                  <button
                    key={`${accion.type}-${index}`}
                    type="button"
                    className="secondary-button"
                    onClick={() => onAccionEnlace(accion.url)}
                  >
                    {accion.label || (accion.type === "discord" ? "ABRIR DISCORD" : "ABRIR ENLACE")}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {(progreso || preparando) && (
          <section className="event-detalle-bloque">
            <h4>PROGRESO</h4>
            <EventProgress progreso={progreso || { status: "starting", message: "Iniciando..." }} />
          </section>
        )}

        {progreso?.error && (
          <div className="event-error-inline">
            <p>{progreso.error}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onAccionPrimaria(evento, { type: "play", label: "REINTENTAR" })}
            >
              REINTENTAR
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EventosAdmin({ onVolver }) {
  return <EventsAdmin onVolver={onVolver} />;
}

export default function EventsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detalleId, setDetalleId] = useState(null);
  const [vistaAdmin, setVistaAdmin] = useState(false);
  const [progresos, setProgresos] = useState({});
  const [preparandoIds, setPreparandoIds] = useState(() => new Set());
  const [listos, setListos] = useState(() => ({}));
  const [pendientesActualizar, setPendientesActualizar] = useState(() => ({}));

  const cargar = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const resultado = await window.eryon.getEvents({ force });
      setData(resultado);
    } catch (e) {
      setData({ ok: false, events: [], error: e?.message || "Error al cargar los eventos" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar(false);
  }, [cargar]);

  // Restaura el estado de preparacion de cada evento (listo /
  // actualizacion disponible) desde el main process.
  useEffect(() => {
    if (!data?.ok || !Array.isArray(data.events)) return;

    let vivo = true;
    (async () => {
      for (const evento of data.events) {
        try {
          const status = await window.eryon.getEventStatus(evento.id);
          if (!vivo || !status) continue;

          if (status.status === "ready" && status.instanceId) {
            setListos((prev) => ({ ...prev, [evento.id]: status.instanceId }));
          } else if (status.status === "update-available" && status.instanceId) {
            setListos((prev) => ({ ...prev, [evento.id]: status.instanceId }));
            setPendientesActualizar((prev) => ({ ...prev, [evento.id]: true }));
          }
        } catch {
          // Sin estado: el evento se ve como no preparado.
        }
      }
    })();

    return () => {
      vivo = false;
    };
  }, [data]);

  // Refresco remoto + progreso de preparacion por eryon:launch-event.
  useEffect(() => {
    if (!window.eryon?.onLaunchEvent) return undefined;

    const desuscribir = window.eryon.onLaunchEvent((event) => {
      if (event?.type === "events" && event.action === "published") {
        void cargar(true);
        return;
      }
      if (event?.type !== "event-progress" || !event.eventId) return;

      setProgresos((prev) => ({
        ...prev,
        [event.eventId]: { ...prev[event.eventId], ...event }
      }));

      if (event.status === "ready" && event.instanceId) {
        setListos((prev) => ({ ...prev, [event.eventId]: event.instanceId }));
        setPendientesActualizar((prev) => {
          const next = { ...prev };
          delete next[event.eventId];
          return next;
        });
        setPreparandoIds((prev) => {
          const next = new Set(prev);
          next.delete(event.eventId);
          return next;
        });
      }
      if (event.status === "error") {
        setPreparandoIds((prev) => {
          const next = new Set(prev);
          next.delete(event.eventId);
          return next;
        });
      }
    });

    return desuscribir;
  }, [cargar]);

  const eventoDetalle = useMemo(
    () => (data?.events || []).find((ev) => ev.id === detalleId) || null,
    [data, detalleId]
  );

  const eventosVisibles = useMemo(() => {
    const lista = (data?.events || []).filter((ev) => ev.enabled !== false);
    // Destacados primero: activos, luego proximos, luego finalizados;
    // dentro de cada grupo se respeta el orden manual (order).
    const peso = { active: 0, upcoming: 1, finished: 2 };
    return [...lista].sort(
      (a, b) => (peso[a.state] ?? 3) - (peso[b.state] ?? 3) || (a.order || 0) - (b.order || 0)
    );
  }, [data]);

  const abrirEnlace = useCallback((url) => {
    if (url && /^https:\/\//i.test(url)) {
      window.open(url, "_blank");
    }
  }, []);

  const accionPrimaria = useCallback(
    async (evento, accion) => {
      const eventId = evento.id;
      if (accion?.type === "download") {
        setListos((prev) => ({ ...prev, [eventId]: undefined }));
      }

      if (listos[eventId] && (!accion || accion.type !== "download")) {
        // Ya preparado: lanzar el juego directo.
        try {
          await window.eryon.launchInstance(listos[eventId]);
        } catch (e) {
          setProgresos((prev) => ({
            ...prev,
            [eventId]: {
              ...(prev[eventId] || {}),
              status: "error",
              error: e?.message || "No se pudo iniciar Minecraft"
            }
          }));
        }
        return;
      }

      setPreparandoIds((prev) => new Set(prev).add(eventId));
      setProgresos((prev) => ({
        ...prev,
        [eventId]: { status: "starting", message: "Comprobando la instalación del evento...", percent: 0 }
      }));

      try {
        await window.eryon.prepareEvent(eventId, {
          forzarDescarga: accion?.type === "download"
        });
      } catch (e) {
        setPreparandoIds((prev) => {
          const next = new Set(prev);
          next.delete(eventId);
          return next;
        });
        setProgresos((prev) => ({
          ...prev,
          [eventId]: {
            status: "error",
            error: e?.message || "No se pudo iniciar la preparación del evento"
          }
        }));
      }
    },
    [listos]
  );

  if (vistaAdmin) {
    return <EventosAdmin onVolver={() => setVistaAdmin(false)} />;
  }

  if (detalleId) {
    return (
      <EventoDetalle
        evento={eventoDetalle}
        progreso={progresos[detalleId]}
        preparando={preparandoIds.has(detalleId)}
        listo={listos[detalleId]}
        pendienteActualizacion={pendientesActualizar[detalleId]}
        onVolver={() => setDetalleId(null)}
        onAccionPrimaria={accionPrimaria}
        onAccionEnlace={abrirEnlace}
      />
    );
  }

  return (
    <>
      <section className="events-hero">
        <div className="hero-content">
          <div className="hero-tag">
            <span className="status-dot" />
            EVENTOS DEL LAUNCHER
          </div>
          <h1>
            EVENTOS
            <br />
            <span>ERYON</span>
          </h1>
          <p>
            Temporadas, torneos y actividades de la comunidad con su
            modpack listo para jugar. Participa y el launcher prepara
            todo por ti.
          </p>
        </div>
      </section>

      <div className="events-header-row">
        <div>
          <h2 className="events-titulo-seccion">Eventos disponibles</h2>
          {data?.updated && (
            <span className="events-actualizado">
              Última publicación: {formatearFecha(data.updated)}
              {data.source === "cache-offline" ? " · sin conexión (caché local)" : ""}
            </span>
          )}
        </div>

        <div className="events-header-acciones">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void cargar(true)}
            disabled={loading}
          >
            {loading ? "ACTUALIZANDO..." : "⟳ ACTUALIZAR"}
          </button>
          <button
            type="button"
            className="event-admin-link"
            onClick={() => setVistaAdmin(true)}
            title="Acceso de administrador de eventos"
          >
            Acceso admin
          </button>
        </div>
      </div>

      {loading && !data && (
        <div className="events-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="event-card event-card-cargando">
              <div className="event-card-media skeleton" />
              <div className="event-card-body">
                <div className="skeleton linea" />
                <div className="skeleton linea corta" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && data && !data.ok && (
        <div className="events-vacio">
          <h3>No se pudieron cargar los eventos</h3>
          <p>{data.error}</p>
          <button type="button" className="primary-button" onClick={() => void cargar(true)}>
            REINTENTAR
          </button>
        </div>
      )}

      {!loading && data && data.ok && eventosVisibles.length === 0 && (
        <div className="events-vacio">
          <h3>No hay eventos publicados todavía</h3>
          <p>
            Cuando el equipo publique un evento aparecerá aquí
            automáticamente.
          </p>
        </div>
      )}

      {!loading && data?.ok && eventosVisibles.length > 0 && (
        <div className="events-grid">
          {eventosVisibles.map((evento) => (
            <EventCard
              key={evento.id}
              evento={evento}
              progreso={progresos[evento.id]}
              preparando={preparandoIds.has(evento.id)}
              listo={listos[evento.id]}
              pendienteActualizacion={pendientesActualizar[evento.id]}
              onAbrir={setDetalleId}
              onAccionPrimaria={accionPrimaria}
            />
          ))}
        </div>
      )}
    </>
  );
}
