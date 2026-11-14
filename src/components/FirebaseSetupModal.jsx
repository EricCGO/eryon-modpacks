
import { useState } from "react";
import "./FirebaseSetupModal.css";
import useModalScrollTop from "../lib/useModalScrollTop";

// ======================================================
// MODAL DE CONFIGURACIÓN INICIAL DE FIREBASE
// ======================================================

function parsePastedConfig(raw) {
  const text = String(raw || "").trim();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // El usuario pegó el bloque completo de Firebase (con imports,
    // comentarios y demás). Se busca el objeto real más abajo.
  }

  // Si pegaron todo el snippet de Firebase, lo que interesa viene
  // justo después de la palabra "firebaseConfig".
  const anchor = text.indexOf("firebaseConfig");
  const source = anchor >= 0 ? text.slice(anchor) : text;

  const match = source.match(/\{[\s\S]*\}/);

  if (!match) return null;

  const candidate = match[0]
    // claves sin comillas -> entre comillas
    .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
    // comillas simples -> dobles
    .replace(/'/g, '"')
    // comas finales -> fuera
    .replace(/,(\s*[}\]])/g, "$1");

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export default function FirebaseSetupModal({
  initialValues,
  busy,
  error,
  onSave,
  onClose
}) {
  useModalScrollTop();

  const [apiKey, setApiKey] = useState(initialValues?.apiKey || "");
  const [databaseURL, setDatabaseURL] = useState(
    initialValues?.databaseURL || ""
  );
  const [projectId, setProjectId] = useState(
    initialValues?.projectId || ""
  );
  const [appId, setAppId] = useState(initialValues?.appId || "");
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState("");

  function handlePaste(event) {
    event.preventDefault();

    const parsed = parsePastedConfig(pasted);

    if (!parsed) {
      setPasteError(
        "No se reconoció la configuración. Copia el bloque firebaseConfig completo."
      );
      return;
    }

    setPasteError("");

    setApiKey(parsed.apiKey || "");
    setDatabaseURL(parsed.databaseURL || "");
    setProjectId(parsed.projectId || "");
    setAppId(parsed.appId || "");
  }

  function handleSubmit(event) {
    event.preventDefault();
    onSave({ apiKey, databaseURL, projectId, appId });
  }

  return (
    <div className="instance-settings-backdrop">
      <section
        className="instance-settings-modal firebase-setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="firebase-setup-title"
      >
        <header className="instance-settings-header">
          <div>
            <p className="instance-settings-eyebrow">
              SISTEMA DE AMIGOS
            </p>

            <h2 id="firebase-setup-title">Conecta Eryon Satélite</h2>

            <p className="instance-settings-subtitle">
              Los amigos y mensajes se sincronizan con Firebase
              Realtime Database. El launcher ya trae una conexión
              integrada y funcionando: esto es solo para el creador del
              launcher, para apuntar a otra base de datos propia.
            </p>
          </div>

          <button
            type="button"
            className="instance-settings-close"
            onClick={onClose}
            aria-label="Cerrar configuración"
          >
            ×
          </button>
        </header>

        <section className="instance-settings-section">
          <div className="instance-settings-section-title">
            <span aria-hidden="true">📋</span>
            <div>
              <h3>1. Pega tu configuración</h3>
              <p>
                En console.firebase.google.com crea un proyecto gratuito,
                añade una "Web App" y copia aquí el objeto{" "}
                <code>firebaseConfig</code>.
              </p>
            </div>
          </div>

          <form onSubmit={handlePaste} className="firebase-paste-form">
            <textarea
              className="text-input settings-textarea"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder={'{\n  "apiKey": "...",\n  "databaseURL": "...",\n  ... }\n'}
              spellCheck={false}
            />

            {pasteError && (
              <p className="settings-error" role="alert">{pasteError}</p>
            )}

            <button
              className="secondary-button"
              type="submit"
              disabled={!pasted.trim()}
            >
              DETECTAR CONFIGURACIÓN
            </button>
          </form>
        </section>

        <section className="instance-settings-section">
          <div className="instance-settings-section-title">
            <span aria-hidden="true">🔑</span>
            <div>
              <h3>2. Datos del proyecto</h3>
              <p>
                Se guardan en tu PC. La clave{" "}
                <code>databaseURL</code> es la importante: se crea al
                configurar Realtime Database.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="firebase-setup-form">
            <label className="instance-settings-field">
              <span>API KEY</span>
              <input
                className="text-input"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="AIza..."
                autoComplete="off"
                required
              />
            </label>

            <label className="instance-settings-field">
              <span>DATABASE URL</span>
              <input
                className="text-input"
                value={databaseURL}
                onChange={(event) => setDatabaseURL(event.target.value)}
                placeholder="https://tu-proyecto-default-rtdb.firebaseio.com/"
                autoComplete="off"
                required
              />
            </label>

            <label className="instance-settings-field">
              <span>PROJECT ID</span>
              <input
                className="text-input"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                placeholder="tu-proyecto"
                autoComplete="off"
                required
              />
            </label>

            <label className="instance-settings-field">
              <span>APP ID (opcional)</span>
              <input
                className="text-input"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder="1:000000000:web:..."
                autoComplete="off"
              />
            </label>

            {error && (
              <p className="instance-settings-error" role="alert">
                {error}
              </p>
            )}

            <button
              className="primary-button full-button"
              type="submit"
              disabled={busy}
            >
              {busy
                ? "GUARDANDO CONEXIÓN..."
                : "GUARDAR Y CONECTAR"}
            </button>
          </form>

          <details className="firebase-rules">
            <summary>Reglas recomendadas de Realtime Database</summary>
            <pre>{`{
  "rules": {
    "users":     { ".read": true, "$uid": { ".write": true } },
    "presence":  { "$uid": { ".write": true, ".read": true } },
    "gamePresence": { ".read": true, "$player": { ".write": true } },
    "friends":   { "$uid": { ".write": true, ".read": true } },
    "chats":     { "$chat": { ".write": true, ".read": true } }
  }
}`}</pre>
            <p>
              Pega estas reglas en la pestaña "Reglas" de Realtime
              Database. Son válidas mientras tu launcher sea de uso
              privado; si lo distribuyes masivamente, endurecelas validando
              la identidad del usuario. La regla de lectura de
              <code> gamePresence </code> permite que el distintivo encuentre
              jugadores Eryon conectados al mismo servidor.
            </p>
          </details>
        </section>
      </section>
    </div>
  );
}
