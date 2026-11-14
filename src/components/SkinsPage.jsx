import { lazy, Suspense, useEffect, useState } from "react";
import "./SkinsPage.css";

const SkinModelViewer = lazy(() => import("./SkinModelViewer"));

export default function SkinsPage({
  accountMode,
  activeAccount,
  localProfiles,
  activeLocalProfile,
  onAccountConnected,
  onAccountModeChange,
  onNavigate
}) {
  const [localProfileId, setLocalProfileId] = useState(
    activeLocalProfile?.id || ""
  );
  const [skinState, setSkinState] = useState(null);
  const [elybyAccount, setElybyAccount] = useState(null);
  const [variant, setVariant] = useState("classic");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (activeLocalProfile?.id) setLocalProfileId(activeLocalProfile.id);
  }, [activeLocalProfile?.id]);

  useEffect(() => {
    let active = true;
    async function loadElybyAccount() {
      try {
        if (!window.eryon?.getElybyAccount) {
          throw new Error("La conexión con Ely.by no está disponible.");
        }
        const account = await window.eryon.getElybyAccount();
        if (active) setElybyAccount(account || null);
      } catch (loadError) {
        if (active) {
          setError(loadError?.message || "No se pudo consultar la cuenta Ely.by.");
        }
      }
    }
    loadElybyAccount();
    return () => {
      active = false;
    };
  }, []);

  async function refreshSkin() {
    setError("");
    try {
      if (!window.eryon?.getSkinState) {
        throw new Error("La vista de skins no está disponible en este launcher.");
      }
      const state = await window.eryon.getSkinState({ localProfileId });
      setSkinState(state || null);
      if (state?.variant === "slim" || state?.variant === "classic") {
        setVariant(state.variant);
      }
    } catch (loadError) {
      setError(loadError?.message || "No se pudo cargar la skin.");
    }
  }

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        if (!window.eryon?.getSkinState) {
          throw new Error("La vista de skins no está disponible en este launcher.");
        }
        const state = await window.eryon.getSkinState({ localProfileId });
        if (!active) return;
        setSkinState(state || null);
        if (state?.variant === "slim" || state?.variant === "classic") {
          setVariant(state.variant);
        }
        setError("");
      } catch (loadError) {
        if (active) {
          setSkinState(null);
          setError(loadError?.message || "No se pudo cargar la skin.");
        }
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [accountMode, activeAccount?.id, localProfileId]);

  async function handleUpload() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await window.eryon?.uploadSkin?.({
        variant,
        localProfileId
      });
      if (result?.canceled) return;
      if (!result?.uploaded) throw new Error("No se pudo guardar la skin.");
      if (result.skinUrl) {
        setSkinState((current) => ({
          ...current,
          provider: result.provider,
          skinUrl: result.skinUrl,
          variant
        }));
      } else {
        await refreshSkin();
      }
      setMessage(
        result.provider === "local"
          ? "Se guardó la vista previa. No cambia la skin dentro del juego."
          : "La skin se actualizó en tu cuenta de Minecraft."
      );
    } catch (uploadError) {
      setError(uploadError?.message || "No se pudo actualizar la skin.");
    } finally {
      setBusy(false);
    }
  }

  async function handleElybyLogin(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const account = await window.eryon?.addElybyAccount?.({
        username,
        password,
        totp
      });
      if (!account) throw new Error("Ely.by no devolvió un perfil válido.");
      setElybyAccount(account);
      setPassword("");
      setTotp("");
      await onAccountConnected?.();
      await onAccountModeChange?.("elyby");
      setMessage(`Cuenta Ely.by conectada como ${account.name}.`);
    } catch (loginError) {
      setError(loginError?.message || "No se pudo conectar con Ely.by.");
    } finally {
      setPassword("");
      setTotp("");
      setBusy(false);
    }
  }

  async function handleDisconnectElyby() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await window.eryon?.disconnectElybyAccount?.();
      setElybyAccount(null);
      await onAccountConnected?.();
      setMessage("Se desconectó la cuenta Ely.by.");
    } catch (disconnectError) {
      setError(disconnectError?.message || "No se pudo desconectar Ely.by.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUseElyby() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await onAccountModeChange?.("elyby");
      await onAccountConnected?.();
      setMessage(`Se seleccionó la cuenta Ely.by de ${elybyAccount.name}.`);
    } catch (modeError) {
      setError(modeError?.message || "No se pudo seleccionar la cuenta Ely.by.");
    } finally {
      setBusy(false);
    }
  }

  async function openCatalog() {
    setError("");
    try {
      if (!window.eryon?.openSkinCatalog) {
        throw new Error("El catálogo no está disponible en este launcher.");
      }
      await window.eryon.openSkinCatalog();
    } catch (openError) {
      setError(openError?.message || "No se pudo abrir el catálogo de Ely.by.");
    }
  }

  const isLocal = accountMode === "local";
  const isElyby = accountMode === "elyby";
  const connectedElyby = Boolean(elybyAccount);

  return (
    <section className="skins-page">
      <header className="skins-heading">
        <span className="eyebrow">PERSONALIZACIÓN</span>
        <h1>Skins</h1>
        <p>Administra la skin de tu cuenta o usa una skin local en mundos de un jugador.</p>
      </header>

      {error && <p className="settings-error" role="alert">{error}</p>}
      {message && <p className="feedback-message" role="status">{message}</p>}

      <div className="skins-layout">
        <section className="panel skin-preview-panel">
          <div className="panel-heading">
            <span className="eyebrow">VISTA PREVIA</span>
            <span className="status-pill">
              {isLocal ? "PERFIL LOCAL" : isElyby ? "ELY.BY" : "MICROSOFT"}
            </span>
          </div>
          <div className="skin-preview">
            <Suspense fallback={<p className="skin-model-loading">Cargando vista 3D...</p>}>
              <SkinModelViewer
                skinUrl={skinState?.skinUrl}
                variant={variant}
                onError={(viewerError) => setError(viewerError.message)}
              />
            </Suspense>
          </div>
          <strong className="skin-account-name">
            {isLocal
              ? localProfiles.find((profile) => profile.id === localProfileId)?.name ||
                "Selecciona un perfil local"
              : isElyby
                ? activeAccount?.name || elybyAccount?.name || "Sin cuenta Ely.by"
                : activeAccount?.name || "Sin cuenta conectada"}
          </strong>
          {skinState?.note && <p className="field-hint">{skinState.note}</p>}
          <button
            className="secondary-button"
            type="button"
            onClick={refreshSkin}
            disabled={busy}
          >
            ACTUALIZAR VISTA PREVIA
          </button>
        </section>

        <section className="panel skin-controls-panel">
          <span className="eyebrow">TU SKIN</span>
          <h2>{isLocal ? "Skin de perfil local" : isElyby ? "Cuenta Ely.by" : "Cuenta Microsoft"}</h2>

          {isLocal ? (
            <>
              <label className="field-label" htmlFor="skin-local-profile">
                PERFIL LOCAL
              </label>
              <select
                id="skin-local-profile"
                className="text-input"
                value={localProfileId}
                onChange={(event) => setLocalProfileId(event.target.value)}
              >
                <option value="">Selecciona un perfil</option>
                {localProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
              <p className="field-hint">
                La skin se usa en mundos de un jugador con este perfil local. No requiere Ely.by ni cambia tu apariencia en servidores multijugador.
              </p>
              {localProfiles.length === 0 && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onNavigate?.("profiles")}
                >
                  CREAR PERFIL LOCAL
                </button>
              )}
            </>
          ) : isElyby ? (
            <p>
              La skin de Ely.by se carga en mundos de un jugador con authlib-injector. Para multijugador, el servidor debe ser compatible con Ely.by.
            </p>
          ) : (
            <>
              <p>
                Selecciona un PNG desde tu equipo para subirlo y aplicarlo directamente a tu cuenta Microsoft Java. La imagen debe medir 64×64 o 64×32 píxeles.
              </p>
              {!activeAccount && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onNavigate?.("profiles")}
                >
                  IR A PERFILES PARA CONECTAR MICROSOFT
                </button>
              )}
              <label className="field-label" htmlFor="skin-model">MODELO DEL BRAZO</label>
              <select
                id="skin-model"
                className="text-input"
                value={variant}
                onChange={(event) => setVariant(event.target.value)}
                disabled={busy}
              >
                <option value="classic">Clásico (Steve)</option>
                <option value="slim">Delgado (Alex)</option>
              </select>
            </>
          )}

          {!isElyby && (
            <button
              className="primary-button full-button"
              type="button"
              onClick={handleUpload}
              disabled={
                busy ||
                (isLocal && (!localProfileId || localProfiles.length === 0)) ||
                (!isLocal && !activeAccount)
              }
            >
              {busy ? "PROCESANDO..." : isLocal ? "GUARDAR SKIN PARA MODO INDIVIDUAL" : "SELECCIONAR PNG Y APLICAR SKIN"}
            </button>
          )}
        </section>
      </div>

      <section className="panel skin-elyby-panel">
        <div className="skin-elyby-heading">
          <div>
            <span className="eyebrow">CUENTA ALTERNATIVA</span>
            <h2>Ely.by</h2>
          </div>
          <span className="status-pill">
            {connectedElyby ? "CONECTADA" : "NO CONECTADA"}
          </span>
        </div>
        {connectedElyby ? (
          <>
            <p>
              {elybyAccount.name} · la contraseña no se conserva; el token de sesión se guarda cifrado en este equipo.
            </p>
            <div className="skin-elyby-actions">
              {accountMode !== "elyby" && (
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleUseElyby}
                  disabled={busy}
                >
                  USAR ELY.BY PARA JUGAR
                </button>
              )}
              <button
                className="secondary-button"
                type="button"
                onClick={openCatalog}
              >
                ADMINISTRAR SKIN EN ELY.BY
              </button>
              <button
                className="secondary-button danger-button"
                type="button"
                onClick={handleDisconnectElyby}
                disabled={busy}
              >
                DESCONECTAR
              </button>
            </div>
          </>
        ) : (
          <form className="elyby-login-form" onSubmit={handleElybyLogin}>
            <p>
              El inicio de sesión se envía por HTTPS directamente a Ely.by. Eryon no guarda tu contraseña; conserva solo el token cifrado localmente.
            </p>
            <label className="field-label" htmlFor="elyby-username">USUARIO O CORREO</label>
            <input
              id="elyby-username"
              className="text-input"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              maxLength={255}
              disabled={busy}
            />
            <label className="field-label" htmlFor="elyby-password">CONTRASEÑA</label>
            <input
              id="elyby-password"
              className="text-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              maxLength={512}
              disabled={busy}
            />
            <label className="field-label" htmlFor="elyby-totp">
              CÓDIGO 2FA <span>(si tu cuenta lo solicita)</span>
            </label>
            <input
              id="elyby-totp"
              className="text-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totp}
              onChange={(event) => setTotp(event.target.value)}
              maxLength={16}
              disabled={busy}
            />
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? "CONECTANDO..." : "CONECTAR ELY.BY"}
            </button>
          </form>
        )}
      </section>

      <section className="panel skin-catalog-panel">
        <div>
          <span className="eyebrow">DESCUBRE</span>
          <h2>Catálogo de skins</h2>
          <p>Explora y descarga skins desde el catálogo oficial de Ely.by.</p>
        </div>
        <button className="secondary-button" type="button" onClick={openCatalog}>
          EXPLORAR CATÁLOGO
        </button>
      </section>
    </section>
  );
}
