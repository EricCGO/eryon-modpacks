
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import LauncherPage from "./LauncherPage";
import ConfirmDialog from "./components/ConfirmDialog";
import UpdateModal from "./components/UpdateModal";
import SatellitePanel from "./components/SatellitePanel";
import FirebaseSetupModal from "./components/FirebaseSetupModal";
import EventsPage from "./components/EventsPage";
import ContentBrowser from "./components/ContentBrowser";
import InstanceDetailsPage from "./components/InstanceDetailsPage";
import InstanceLogo from "./components/InstanceLogo";
import InstanceLaunchProgress from "./components/InstanceLaunchProgress";
import SkinsPage from "./components/SkinsPage";
import {
  connectFirebase,
  registerIdentity,
  setGamePresence,
  subscribeFriends,
  nameKey
} from "./lib/firebase";
import { EMBEDDED_FIREBASE_CONFIG } from "./lib/firebase-embedded";
import useModalScrollTop from "./lib/useModalScrollTop";

// ======================================================
// NAVEGACIÓN
// ======================================================

const navigation = [
  { id: "home", label: "Inicio", icon: "⌂" },
  { id: "play", label: "Jugar", icon: "▶" },
  { id: "events", label: "Eventos", icon: "★" },
  { id: "modpacks", label: "Modpacks", icon: "▦" },
  { id: "profiles", label: "Perfiles", icon: "◉" },
  { id: "skins", label: "Skins", icon: "♟" },
  { id: "settings", label: "Configuración", icon: "⚙" }
];

function getErrorMessage(error, fallback) {
  return error?.message || fallback;
}

function getAvatarUrl(account) {
  if (!account) return "";
  if (account.avatarUrl) return account.avatarUrl;

  if (account.uuid) {
    return `https://mc-heads.net/avatar/${encodeURIComponent(
      account.uuid
    )}/100`;
  }

  return "";
}

function recommendedLoaderVersion(versions) {
  if (!Array.isArray(versions) || versions.length === 0) {
    return "";
  }

  const selected =
    versions.find((item) => item.recommended) ||
    versions.find((item) => item.latest && item.stable) ||
    versions.find((item) => item.stable) ||
    versions.find((item) => item.latest) ||
    versions[0];

  return selected?.version || "";
}

function loaderVersionLabel(item) {
  const labels = [];

  if (item.recommended) labels.push("Recomendada");
  if (item.latest) labels.push("Más reciente");
  if (item.stable === false) labels.push("No estable");

  return labels.length
    ? `${item.version} — ${labels.join(" · ")}`
    : item.version;
}

// ======================================================
// APLICACIÓN PRINCIPAL
// ======================================================

function App() {
  const [page, setPage] = useState("home");
  const [appInfo, setAppInfo] = useState(null);
  const [installingModpackIds, setInstallingModpackIds] = useState(
    () => new Set()
  );
  const [showInstalledInstances, setShowInstalledInstances] =
    useState(false);

  const updateInstallingModpack = useCallback((item, isInstalling) => {
    if (!item?.id) return;

    const key = `${item.source || "modrinth"}:${item.id}`;
    setInstallingModpackIds((current) => {
      const next = new Set(current);
      if (isInstalling) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const acknowledgeInstalledInstances = useCallback(() => {
    setShowInstalledInstances(false);
  }, []);

  const handleModpackInstallCompleted = useCallback(() => {
    setShowInstalledInstances(true);
    setPage("modpacks");
  }, []);

  // SATELITE: AMIGOS Y MENSAJES
  const [satelliteOpen, setSatelliteOpen] = useState(false);
  const [firebaseConfig, setFirebaseConfig] = useState(null);
  const [firebaseReady, setFirebaseReady] = useState(false);
  const [firebaseSetupOpen, setFirebaseSetupOpen] = useState(false);
  const [firebaseBusy, setFirebaseBusy] = useState(false);
  const [firebaseError, setFirebaseError] = useState("");
  const [friendRequests, setFriendRequests] = useState(0);
  const activeGamePresence = useRef(new Map());

  // Modo elegido en esta ventana; se inicializa desde las preferencias guardadas.
  const [accountMode, setAccountMode] = useState("premium");

  // CUENTAS MICROSOFT
  const [accounts, setAccounts] = useState([]);
  const [activeAccount, setActiveAccount] = useState(null);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");
  const [accountError, setAccountError] = useState("");

  // PERFILES LOCALES
  const [localProfiles, setLocalProfiles] = useState([]);
  const [activeLocalProfile, setActiveLocalProfile] = useState(null);
  const [localProfilesLoading, setLocalProfilesLoading] =
    useState(true);
  const [localProfileBusy, setLocalProfileBusy] = useState(false);
  const [localProfileName, setLocalProfileName] = useState("");
  const [localProfileMessage, setLocalProfileMessage] = useState("");
  const [localProfileError, setLocalProfileError] = useState("");

  // ====================================================
  // CAMBIAR Y GUARDAR MODO GLOBAL
  // ====================================================

  const changeAccountMode = useCallback(async (mode) => {
    if (mode !== "premium" && mode !== "local" && mode !== "elyby") {
      throw new Error("El modo de cuenta seleccionado no es válido.");
    }

    if (!window.eryon?.setAccountMode) {
      throw new Error(
        "El cambio de modo no está disponible. Reinicia Eryon Launcher e inténtalo de nuevo."
      );
    }

    await window.eryon.setAccountMode(mode);
    setAccountMode(mode);
  }, []);

  // ====================================================
  // CUENTAS MICROSOFT
  // ====================================================

  const refreshAccounts = useCallback(async () => {
    if (
      !window.eryon?.getAccounts ||
      !window.eryon?.getActiveAccount
    ) {
      setAccounts([]);
      setActiveAccount(null);
      setAccountsLoading(false);
      return;
    }

    try {
      const [accountList, active, mode] = await Promise.all([
        window.eryon.getAccounts(),
        window.eryon.getActiveAccount(),
        window.eryon.getAccountMode?.()
      ]);

      setAccounts(Array.isArray(accountList) ? accountList : []);
      setActiveAccount(active || null);
      if (mode === "premium" || mode === "local" || mode === "elyby") {
        setAccountMode(mode);
      }
      setAccountError("");
    } catch (error) {
      setAccountError(
        getErrorMessage(
          error,
          "No se pudieron cargar las cuentas de Microsoft."
        )
      );
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  const handleElybyConnected = useCallback(async () => {
    await refreshAccounts();
  }, [refreshAccounts]);

  // ====================================================
  // PERFILES LOCALES
  // ====================================================

  const refreshLocalProfiles = useCallback(async () => {
    if (!window.eryon?.getLocalProfiles) {
      setLocalProfiles([]);
      setActiveLocalProfile(null);
      setLocalProfilesLoading(false);
      return;
    }

    try {
      const result = await window.eryon.getLocalProfiles();

      const profiles = Array.isArray(result?.profiles)
        ? result.profiles
        : [];

      const activeProfile =
        result?.activeProfile ||
        profiles.find(
          (profile) => profile.id === result?.activeProfileId
        ) ||
        null;

      setLocalProfiles(profiles);
      setActiveLocalProfile(activeProfile);
      setLocalProfileError("");
    } catch (error) {
      setLocalProfileError(
        getErrorMessage(
          error,
          "No se pudieron cargar los perfiles locales."
        )
      );
    } finally {
      setLocalProfilesLoading(false);
    }
  }, []);

  // ====================================================
  // INICIALIZACIÓN
  // ====================================================

  useEffect(() => {
    let mounted = true;

    async function loadAppInfo() {
      try {
        if (!window.eryon?.getInfo) return;

        const info = await window.eryon.getInfo();

        if (mounted) setAppInfo(info);
      } catch {
        if (mounted) setAppInfo(null);
      }
    }

    async function loadAccountMode() {
      try {
        const mode = await window.eryon?.getAccountMode?.();

        if (
          mounted &&
          (mode === "premium" || mode === "local" || mode === "elyby")
        ) {
          setAccountMode(mode);
        }
      } catch {
        // Se mantiene el modo predeterminado.
      }
    }

    loadAppInfo();
    refreshAccounts();
    refreshLocalProfiles();
    loadAccountMode();

    return () => {
      mounted = false;
    };
  }, [refreshAccounts, refreshLocalProfiles]);

  // ====================================================
  // AÑADIR CUENTA MICROSOFT
  // ====================================================

  async function addAccount() {
    if (!window.eryon?.addAccount) {
      setAccountError(
        "La autenticación no está conectada. Reinicia Eryon Launcher e inténtalo de nuevo."
      );
      return;
    }

    setAccountBusy(true);
    setAccountMessage("");
    setAccountError("");

    try {
      const result = await window.eryon.addAccount();

      if (result === false || result?.success === false) {
        throw new Error(
          result?.message || "No se pudo añadir la cuenta."
        );
      }

      await refreshAccounts();

      // La cuenta añadida se usará en modo Premium.
      await changeAccountMode("premium");

      setAccountMessage("Cuenta Microsoft añadida y seleccionada para jugar.");
    } catch (error) {
      setAccountError(
        getErrorMessage(
          error,
          "No se pudo iniciar sesión con Microsoft."
        )
      );
    } finally {
      setAccountBusy(false);
    }
  }

  // ====================================================
  // SELECCIONAR CUENTA MICROSOFT
  // ====================================================

  async function selectAccount(accountId) {
    if (!window.eryon?.selectAccount) {
      setAccountError("La selección de cuenta no está disponible.");
      return;
    }

    setAccountBusy(true);
    setAccountMessage("");
    setAccountError("");

    try {
      const result = await window.eryon.selectAccount(accountId);

      if (result === false || result?.success === false) {
        throw new Error(
          result?.message || "No se pudo cambiar de cuenta."
        );
      }

      await changeAccountMode("premium");
      await refreshAccounts();

      setAccountMessage("Cuenta Microsoft seleccionada para jugar.");
    } catch (error) {
      setAccountError(
        getErrorMessage(error, "No se pudo cambiar de cuenta.")
      );
    } finally {
      setAccountBusy(false);
    }
  }

  // ====================================================
  // CERRAR SESIÓN
  // ====================================================

  async function logoutAccount(accountId) {
    if (!window.eryon?.logout) {
      setAccountError("Cerrar sesión no está disponible.");
      return;
    }

    if (
      !window.confirm(
        "¿Quieres cerrar sesión de esta cuenta de Minecraft en ERYON?"
      )
    ) {
      return;
    }

    setAccountBusy(true);
    setAccountMessage("");
    setAccountError("");

    try {
      const result = await window.eryon.logout(accountId);

      if (result === false || result?.success === false) {
        throw new Error(
          result?.message || "No se pudo cerrar sesión."
        );
      }

      await refreshAccounts();
      setAccountMessage("La sesión se ha cerrado.");
    } catch (error) {
      setAccountError(
        getErrorMessage(error, "No se pudo cerrar sesión.")
      );
    } finally {
      setAccountBusy(false);
    }
  }

  // ====================================================
  // CREAR PERFIL LOCAL
  // ====================================================

  async function addLocalProfile(event) {
    event.preventDefault();

    const cleanName = localProfileName.trim();

    setLocalProfileMessage("");
    setLocalProfileError("");

    if (!/^[A-Za-z0-9_]{3,16}$/.test(cleanName)) {
      setLocalProfileError(
        "Usa entre 3 y 16 caracteres: letras, números o _."
      );
      return;
    }

    if (!window.eryon?.addLocalProfile) {
      setLocalProfileError(
        "La gestión de perfiles locales no está conectada."
      );
      return;
    }

    setLocalProfileBusy(true);

    try {
      const result = await window.eryon.addLocalProfile(cleanName);

      if (result === false || result?.success === false) {
        throw new Error(
          result?.message || "No se pudo crear el perfil local."
        );
      }

      await refreshLocalProfiles();
      await changeAccountMode("local");

      setLocalProfileName("");
      setLocalProfileMessage(
        "Perfil local creado o perfil existente activado."
      );
    } catch (error) {
      setLocalProfileError(
        getErrorMessage(error, "No se pudo crear el perfil local.")
      );
    } finally {
      setLocalProfileBusy(false);
    }
  }

  // ====================================================
  // SELECCIONAR PERFIL LOCAL
  // ====================================================

  async function selectLocalProfile(profileId) {
    if (!window.eryon?.selectLocalProfile) {
      setLocalProfileError(
        "La selección de perfiles no está disponible."
      );
      return;
    }

    setLocalProfileBusy(true);
    setLocalProfileMessage("");
    setLocalProfileError("");

    try {
      const result =
        await window.eryon.selectLocalProfile(profileId);

      if (result === false || result?.success === false) {
        throw new Error(
          result?.message || "No se pudo seleccionar el perfil."
        );
      }
      await changeAccountMode("local");
      await changeAccountMode("local");
      await refreshLocalProfiles();

      setLocalProfileMessage("Perfil local seleccionado para jugar.");
    } catch (error) {
      setLocalProfileError(
        getErrorMessage(error, "No se pudo seleccionar el perfil.")
      );
    } finally {
      setLocalProfileBusy(false);
    }
  }

  // ====================================================
  // ELIMINAR PERFIL LOCAL
  // ====================================================

  async function deleteLocalProfile(profile) {
    if (!profile?.id) {
      setLocalProfileError("Selecciona un perfil válido.");
      return;
    }

    if (
      !window.confirm(
        `¿Quieres eliminar el perfil local "${profile.name}"?`
      )
    ) {
      return;
    }

    if (!window.eryon?.deleteLocalProfile) {
      setLocalProfileError(
        "La eliminación de perfiles no está disponible."
      );
      return;
    }

    setLocalProfileBusy(true);
    setLocalProfileMessage("");
    setLocalProfileError("");

    try {
      const result =
        await window.eryon.deleteLocalProfile(profile.id);

      if (result === false || result?.success === false) {
        throw new Error(
          result?.message || "No se pudo eliminar el perfil."
        );
      }

      await refreshLocalProfiles();

      setLocalProfileMessage(
        `El perfil "${profile.name}" ha sido eliminado.`
      );
    } catch (error) {
      setLocalProfileError(
        getErrorMessage(error, "No se pudo eliminar el perfil.")
      );
    } finally {
      setLocalProfileBusy(false);
    }
  }

  // ====================================================
  // IDENTIDAD MOSTRADA EN LA CABECERA
  // ====================================================

  const displayProfile =
    accountMode === "premium" || accountMode === "elyby"
      ? activeAccount
      : activeLocalProfile;

  const displayName =
    accountMode === "premium" || accountMode === "elyby"
      ? activeAccount?.name ||
        activeAccount?.username ||
        (accountMode === "elyby" ? "Sin cuenta Ely.by" : "Jugador")
      : activeLocalProfile?.name || "Jugador";

  const avatarUrl = getAvatarUrl(displayProfile);

  const displayedProfileType =
    accountMode === "elyby"
      ? activeAccount
        ? "Cuenta Ely.by"
        : "Sin cuenta Ely.by"
      : accountMode === "premium"
        ? activeAccount
          ? "Cuenta Microsoft"
          : "Sin cuenta Microsoft"
        : activeLocalProfile
          ? "Perfil local"
          : "Sin perfil local";

  // ====================================================
  // SATELITE: CONEXIÓN A FIREBASE
  // ====================================================

  const identityUuid =
    accountMode === "premium" ? activeAccount?.uuid || "" : "";

  useEffect(() => {
    let active = true;

    async function loadFirebaseConfig() {
      try {
        // La configuración guardada en este PC tiene prioridad
        // (la puede cambiar el desarrollador desde el modal).
        // Si no existe, se usa la configuración integrada: en una
        // instalación normal NO hace falta configurar nada.
        const saved = await window.eryon?.getFirebaseConfig?.();

        const savedIsOfficialDatabase =
          saved?.databaseURL === EMBEDDED_FIREBASE_CONFIG.databaseURL;

        // Si el launcher apunta a la base oficial de Eryon, usa siempre
        // la configuración integrada. Así una API key antigua o mal copiada
        // guardada localmente no deja el Satélite conectado sin datos.
        const config =
          saved?.apiKey && saved?.databaseURL && !savedIsOfficialDatabase
            ? saved
            : EMBEDDED_FIREBASE_CONFIG;

        if (!active || !config?.apiKey || !config?.databaseURL) {
          return;
        }

        await connectFirebase(config);

        if (active) {
          setFirebaseConfig(config);
          setFirebaseReady(true);
        }
      } catch (error) {
        if (active) {
          setFirebaseError(
            error?.message || "No se pudo conectar con Firebase."
          );
        }
        console.warn(
          "No se pudo conectar con Eryon Satélite:",
          error?.message || error
        );
      }
    }

    loadFirebaseConfig();

    return () => {
      active = false;
    };
  }, []);

  // El modo de gama baja también aligera la interfaz del launcher
  // (sin blur, sombras ni animaciones).
  useEffect(() => {
    let active = true;

    async function loadLowEndMode() {
      try {
        if (!window.eryon?.getSettings) return;

        const saved = await window.eryon.getSettings();

        if (active) {
          document.body.classList.toggle(
            "eryon-lowend",
            saved?.lowEndMode === true
          );
        }
      } catch {
        // Si no se pudo cargar, la interfaz queda con su estilo normal.
      }
    }

    loadLowEndMode();

    return () => {
      active = false;
    };
  }, []);

  // La identidad se registra cuando cambia el perfil activo.

  useEffect(() => {
    if (!firebaseReady || !displayName) return;

    registerIdentity({
      name: displayName,
      uuid: identityUuid
    });
  }, [firebaseReady, displayName, identityUuid]);

  useEffect(() => {
    if (!window.eryon?.onLaunchEvent) return undefined;

    const unsubscribe = window.eryon.onLaunchEvent((event) => {
      if (event?.type === "started") {
        const gamePresence = {
          name: event.playerName || displayName,
          uuid: event.playerUuid || identityUuid,
          playing: true
        };
        const key = event.gameAccountKey || nameKey(gamePresence.name);
        activeGamePresence.current.set(key, gamePresence);
        if (firebaseReady) {
          setGamePresence(gamePresence).catch((error) => {
            console.warn(
              "[ERYON] No se pudo compartir la presencia del juego:",
              error?.message || error
            );
          });
        }
      } else if (event?.type === "closed" || event?.type === "error") {
        const key = event.gameAccountKey;
        const gamePresence = activeGamePresence.current.get(key);
        if (key) activeGamePresence.current.delete(key);
        if (firebaseReady && (gamePresence || event.playerName)) {
          setGamePresence({
            name: gamePresence?.name || event.playerName,
            playing: false
          }).catch((error) => {
            console.warn(
              "[ERYON] No se pudo cerrar la presencia del juego:",
              error?.message || error
            );
          });
        }
      }
    });

    return typeof unsubscribe === "function" ? unsubscribe : undefined;
  }, [firebaseReady, displayName, identityUuid]);

  useEffect(() => {
    if (!firebaseReady || !activeGamePresence.current.size) return;

    for (const gamePresence of activeGamePresence.current.values()) {
      setGamePresence(gamePresence).catch((error) => {
        console.warn(
          "[ERYON] No se pudo compartir la presencia del juego:",
          error?.message || error
        );
      });
    }
  }, [firebaseReady]);

  // Contador de solicitudes de amistad pendientes (insignia).

  useEffect(() => {
    if (!firebaseReady || !displayName) {
      setFriendRequests(0);
      return;
    }

    const unsubscribe = subscribeFriends(
      nameKey(displayName),
      (data) => {
        setFriendRequests(
          Object.keys(data?.requests || {}).length
        );
      }
    );

    return unsubscribe;
  }, [firebaseReady, displayName]);

  async function handleSaveFirebaseConfig(config) {
    setFirebaseBusy(true);
    setFirebaseError("");

    try {
      const saved =
        window.eryon?.saveFirebaseConfig
          ? await window.eryon.saveFirebaseConfig(config)
          : config;

      await connectFirebase(saved);

      setFirebaseConfig(saved);
      setFirebaseReady(true);
      setFirebaseSetupOpen(false);
    } catch (error) {
      setFirebaseError(
        error.message || "No se pudo guardar la configuración."
      );
    } finally {
      setFirebaseBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          type="button"
          className="brand"
          onClick={() => setPage("home")}
          title="Ir al inicio"
        >
          <div className="brand-mark">E</div>

          <div className="brand-copy">
            <strong>ERYON</strong>
            <span>LAUNCHER</span>
          </div>
        </button>

        <nav className="navigation">
          {navigation.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${
                page === item.id ? "active" : ""
              }`}
              onClick={() => setPage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <div className="connection-indicator" title="Interfaz inicializada">
            <span className="status-dot" />
            <span>En línea</span>
          </div>

          <button
            type="button"
            className={`satellite-button ${
              satelliteOpen ? "open" : ""
            }`}
            onClick={() => setSatelliteOpen((open) => !open)}
            title="Satélite — amigos y mensajes"
          >
            <span className="satellite-icon">👥</span>
            <span className="satellite-label">Amigos</span>

            {friendRequests > 0 && (
              <span className="satellite-badge">
                {friendRequests}
              </span>
            )}
          </button>

          <button
            type="button"
            className="user-chip"
            onClick={() => setPage("profiles")}
            title="Administrar cuentas y perfiles"
          >
            <div className="user-avatar">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={`Avatar de ${displayName}`}
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              ) : (
                displayName.charAt(0).toUpperCase()
              )}
            </div>

            <div className="user-details">
              <strong>{displayName}</strong>
              <span>{displayedProfileType}</span>
            </div>
          </button>
        </div>
      </header>

      <main className="main-area">
        <div className="page-content">
          {page === "home" && (
            <HomePage
              nickname={displayName}
              avatarUrl={avatarUrl}
              onNavigate={setPage}
            />
          )}

          {page === "play" && <LauncherPage />}

          {page === "events" && <EventsPage />}

          {page === "modpacks" && (
            <ModpacksPage
              activeAccount={activeAccount}
              localProfiles={localProfiles}
              activeLocalProfile={activeLocalProfile}
              accountMode={accountMode}
              onAccountModeChange={changeAccountMode}
              installingModpackIds={installingModpackIds}
              onModpackInstallStateChange={updateInstallingModpack}
              showInstalledInstances={showInstalledInstances}
              onInstalledInstancesShown={acknowledgeInstalledInstances}
              onModpackInstallCompleted={handleModpackInstallCompleted}
            />
          )}

          {page === "profiles" && (
            <ProfilesPage
              accountMode={accountMode}
              accounts={accounts}
              activeAccount={accountMode === "premium" ? activeAccount : null}
              accountsLoading={accountsLoading}
              accountBusy={accountBusy}
              accountMessage={accountMessage}
              accountError={accountError}
              onAddAccount={addAccount}
              onSelectAccount={selectAccount}
              onLogout={logoutAccount}
              localProfiles={localProfiles}
              activeLocalProfile={activeLocalProfile}
              localProfilesLoading={localProfilesLoading}
              localProfileBusy={localProfileBusy}
              localProfileName={localProfileName}
              setLocalProfileName={setLocalProfileName}
              localProfileMessage={localProfileMessage}
              localProfileError={localProfileError}
              onAddLocalProfile={addLocalProfile}
              onSelectLocalProfile={selectLocalProfile}
              onDeleteLocalProfile={deleteLocalProfile}
            />
          )}

          {page === "skins" && (
            <SkinsPage
              accountMode={accountMode}
              activeAccount={activeAccount}
              localProfiles={localProfiles}
              activeLocalProfile={activeLocalProfile}
              onAccountConnected={handleElybyConnected}
              onAccountModeChange={changeAccountMode}
              onNavigate={setPage}
            />
          )}

          {page === "settings" && (
            <SettingsPage appInfo={appInfo} />
          )}
        </div>

        <footer className="footer">
          <span>ERYON LAUNCHER</span>
          <span>
            Tu Minecraft. Tu experiencia.
            {appInfo?.version ? ` · v${appInfo.version}` : ""}
          </span>
        </footer>
      </main>

      <SatellitePanel
        open={satelliteOpen}
        onClose={() => setSatelliteOpen(false)}
        onOpenFirebaseSetup={() => setFirebaseSetupOpen(true)}
        firebaseConnected={firebaseReady}
        firebaseError={firebaseError}
        identityName={displayName}
        identityUuid={identityUuid || ""}
      />

      {firebaseSetupOpen && (
        <FirebaseSetupModal
          initialValues={firebaseConfig}
          busy={firebaseBusy}
          error={firebaseError}
          onSave={handleSaveFirebaseConfig}
          onClose={() => {
            if (!firebaseBusy) setFirebaseSetupOpen(false);
          }}
        />
      )}

      <UpdateModal/>
    </div>
  );
}

// ======================================================
// ENCABEZADOS Y COMPONENTES GENERALES
// ======================================================

function SectionHeading({ eyebrow, title, description }) {
  return (
    <div className="section-heading">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function QuickCard({
  number,
  icon,
  title,
  description,
  action,
  onClick
}) {
  return (
    <button
      className="quick-card"
      type="button"
      onClick={onClick}
    >
      <div className="quick-card-top">
        <span className="quick-icon">{icon}</span>
        <span className="card-number">{number}</span>
      </div>

      <h3>{title}</h3>
      <p>{description}</p>

      <div className="quick-card-action">
        {action} <span>↗</span>
      </div>
    </button>
  );
}

// ======================================================
// INICIO
// ======================================================

function HomePage({ nickname, avatarUrl, onNavigate }) {
  return (
    <>
      <section className="hero hero-home">
        <div className="hero-content">
          <div className="hero-tag">
            <span className="status-dot" />
            TU CENTRO DE JUEGO
          </div>

          <h1>
            LISTO PARA
            <br />
            <span>JUGAR?</span>
          </h1>

          <p>
            Tu aventura empieza aquí. Gestiona tus instalaciones,
            organiza tus mods y prepara tu próxima partida.
          </p>

          <button
            className="primary-button"
            type="button"
            onClick={() => onNavigate("play")}
          >
            <span>▸</span> JUGAR MINECRAFT
          </button>

          <div className="hero-user">
            <div className="mini-avatar">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              ) : (
                nickname.charAt(0).toUpperCase()
              )}
            </div>

            <span>
              Jugando como <strong>{nickname}</strong>
            </span>
          </div>
        </div>

        <div className="hero-decoration" aria-hidden="true">
          <img
            className="hero-logo"
            src={`${import.meta.env.BASE_URL}images/logo-hero.png`}
            alt=""
            draggable="false"
          />
        </div>
      </section>

      <SectionHeading
        eyebrow="TU ESPACIO"
        title="Acceso rápido"
        description="Todo lo que necesitas, organizado en un solo lugar."
      />

      <div className="quick-grid">
        <QuickCard
          number="01"
          icon="▦"
          title="Modpacks"
          description="Instala Forge, Fabric y organiza tus instalaciones."
          action="ABRIR MODPACKS"
          onClick={() => onNavigate("modpacks")}
        />

        <QuickCard
          number="02"
          icon="◉"
          title="Perfiles"
          description="Administra tus cuentas Microsoft y perfiles locales."
          action="VER PERFILES"
          onClick={() => onNavigate("profiles")}
        />

        <QuickCard
          number="03"
          icon="⚙"
          title="Configuración"
          description="Personaliza los ajustes de la aplicación."
          action="CONFIGURAR"
          onClick={() => onNavigate("settings")}
        />
      </div>
    </>
  );
}

// ======================================================
// GESTOR DE INSTANCIAS Y MODPACKS
// ======================================================

function ModpacksPage({
  activeAccount,
  localProfiles,
  activeLocalProfile,
  accountMode,
  onAccountModeChange,
  installingModpackIds,
  onModpackInstallStateChange,
  showInstalledInstances,
  onInstalledInstancesShown,
  onModpackInstallCompleted
}) {
  const [instances, setInstances] = useState([]);
  const [versions, setVersions] = useState([]);

  // Dos vistas de la página: explorar/descargar contenido o
  // gestionar las instalaciones propias.
  const [pageView, setPageView] = useState("explorar");
  const [detailInstanceId, setDetailInstanceId] = useState("");
  const [explorerPresetCategory, setExplorerPresetCategory] =
    useState("mods");

  const [loadingInstances, setLoadingInstances] = useState(true);
  const [loadingVersions, setLoadingVersions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [installingPack, setInstallingPack] = useState(null);
  const [launchingInstance, setLaunchingInstance] = useState(null);
  const [pendingLaunch, setPendingLaunch] = useState(null);
  const [compatibilityBusy, setCompatibilityBusy] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState("");

  const [runningGames, setRunningGames] = useState(() => new Map());
  const gameRunning = runningGames.size > 0;

  const [name, setName] = useState("");
  const [showCreateInstance, setShowCreateInstance] = useState(false);
  useModalScrollTop(showCreateInstance);
  const [minecraftVersion, setMinecraftVersion] = useState("");
  const [loader, setLoader] = useState("fabric");
  const [loaderVersions, setLoaderVersions] = useState([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [loaderVersionsLoading, setLoaderVersionsLoading] =
    useState(false);
  const [loaderVersionsError, setLoaderVersionsError] = useState("");

  const [localProfileId, setLocalProfileId] = useState("");

  const [, setStatus] = useState(
    "Prepara tu primera instalación de Minecraft."
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [settingsInstance, setSettingsInstance] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const selectedGameAccountKey =
    accountMode === "premium"
      ? activeAccount?.id
        ? `premium:${activeAccount.id}`
        : ""
      : accountMode === "local"
        ? localProfileId
          ? `local:${localProfileId}`
          : ""
        : activeAccount?.id
          ? `elyby:${activeAccount.id}`
          : "";
  const selectedAccountIsRunning =
    Boolean(selectedGameAccountKey) &&
    runningGames.has(selectedGameAccountKey);

  // ====================================================
  // ACTUALIZAR INSTALACIONES
  // ====================================================

  const refreshInstances = useCallback(async () => {
    if (!window.eryon?.getInstances) {
      throw new Error(
        "El gestor de instalaciones no está conectado. Reinicia Eryon Launcher e inténtalo de nuevo."
      );
    }

    const result = await window.eryon.getInstances();
    const list = Array.isArray(result) ? result : [];

    setInstances(list);

    return list;
  }, []);

  // Al abrir MIS INSTALACIONES se recarga la lista: el explorador
  // puede haber instalado modpacks mientras estuvo activo.
  useEffect(() => {
    if (pageView !== "instalaciones") return;

    refreshInstances().catch(() => {
      // Silencio: si falla, se mantiene la lista anterior.
    });
  }, [pageView, refreshInstances]);

  useEffect(() => {
    if (!showInstalledInstances) return;

    setPageView("instalaciones");
    refreshInstances()
      .then(() => setError(""))
      .catch((refreshError) => {
        setError(
          refreshError?.message ||
            "El modpack se instaló, pero no se pudo actualizar la lista de instalaciones."
        );
      })
      .finally(() => onInstalledInstancesShown?.());
  }, [
    showInstalledInstances,
    refreshInstances,
    onInstalledInstancesShown
  ]);

  const [explorerPresetId, setExplorerPresetId] = useState("");

  // Callbacks estables para el explorador (React.memo): evitan
  // re-renderizar la lista de resultados con cada evento de juego.
  const handleExplorerModpackInstallStart = useCallback((item) => {
    onModpackInstallStateChange(item, true);
    setInstallingPack({
      id: item.id,
      source: item.source,
      name: item.name,
      iconUrl: item.iconUrl || "",
      message: "Preparando la descarga...",
      progress: 0,
      status: "installing"
    });
    setPageView("instalaciones");
  }, [onModpackInstallStateChange]);

  const handleExplorerModpackInstallFinish = useCallback(
    (item, result) => {
      onModpackInstallStateChange(item, false);
      if (result.success) {
        setInstallingPack(null);
        onModpackInstallCompleted?.();
      } else {
        setInstallingPack((current) =>
          current
            ? {
                ...current,
                message: result.error,
                status: "error"
              }
            : null
        );
      }
    },
    [onModpackInstallStateChange, onModpackInstallCompleted]
  );

  const detailInstance = instances.find(
    (instance) => instance.id === detailInstanceId
  );

  // ====================================================
  // CARGAR VERSIONES, INSTALACIONES Y MODO GLOBAL
  // ====================================================

  useEffect(() => {
    let mounted = true;

    async function loadVersions() {
      try {
        if (!window.eryon?.getVersions) {
          throw new Error(
            "No se encuentra el servicio de versiones de Minecraft."
          );
        }

        const result = await window.eryon.getVersions();

        if (!mounted) return;

        const available = Array.isArray(result?.versions)
          ? result.versions
          : [];

        setVersions(available);

        const selected = available.some(
          (item) => item.id === result?.latestRelease
        )
          ? result.latestRelease
          : available[0]?.id || "";

        setMinecraftVersion(selected);
      } catch (loadError) {
        if (mounted) {
          setError(
            loadError.message ||
              "No se pudieron cargar las versiones de Minecraft."
          );
        }
      } finally {
        if (mounted) setLoadingVersions(false);
      }
    }

    async function loadInstances() {
      try {
        await refreshInstances();
      } catch (loadError) {
        if (mounted) {
          setError(
            loadError.message ||
              "No se pudieron cargar las instalaciones."
          );
        }
      } finally {
        if (mounted) setLoadingInstances(false);
      }
    }

    async function loadSavedMode() {
      try {
        const savedMode = await window.eryon?.getAccountMode?.();

        if (
          mounted &&
          (savedMode === "premium" ||
            savedMode === "local" ||
            savedMode === "elyby")
        ) {
          await onAccountModeChange(savedMode);
        }
      } catch {
        // Se mantiene el modo compartido.
      }
    }

    loadVersions();
    loadInstances();
    loadSavedMode();

    const unsubscribe = window.eryon?.onLaunchEvent?.((event) => {
      if (!mounted || !event) return;

      if (event.type === "status") {
        setStatus(event.message || "Preparando Minecraft...");

        if (event.instanceId) {
          setLaunchingInstance((current) =>
            current?.instanceId === event.instanceId
              ? { ...current, message: event.message || current.message }
              : current
          );
        }
      }

      if (
        event.instanceId &&
        event.type === "progress"
      ) {
        const data = event.data || {};
        const phase = String(
          data.type || data.phase || data.task || "Archivos"
        );
        const currentCount = Number(data.current ?? data.task ?? 0);
        const totalCount = Number(data.total ?? 0);
        const hasCount =
          Number.isFinite(currentCount) &&
          Number.isFinite(totalCount) &&
          totalCount > 0;

        setLaunchingInstance((current) => {
          if (current?.instanceId !== event.instanceId) return current;

          return {
            ...current,
            message: hasCount
              ? `${phase}: ${currentCount} de ${totalCount}`
              : `Preparando ${phase}...`,
            progress: hasCount
              ? Math.min(100, (currentCount / totalCount) * 100)
              : null,
            status: "launching"
          };
        });
      }

      if (event.type === "modpack-progress") {
        setInstallingPack((current) => {
          if (!current) return current;

          return {
            ...current,
            name: event.name || current.name,
            iconUrl: event.iconUrl || current.iconUrl,
            message: event.message || current.message,
            progress:
              typeof event.progress === "number"
                ? event.progress
                : null,
            status: event.status || "installing"
          };
        });
      }

      if (event.type === "started") {
        if (event.gameAccountKey) {
          setRunningGames((current) =>
            new Map(current).set(
              event.gameAccountKey,
              event.instanceId || null
            )
          );
        }
        setStatus(event.message || "Minecraft iniciado.");
        if (event.instanceId) {
          setLaunchingInstance((current) =>
            current?.instanceId === event.instanceId
              ? {
                  ...current,
                  message: "Minecraft se abrió correctamente.",
                  progress: 100,
                  status: "running"
                }
              : current
          );
        }
        setBusy(false);
        setError("");
      }

      if (event.type === "closed") {
        if (event.gameAccountKey) {
          setRunningGames((current) => {
            const next = new Map(current);
            next.delete(event.gameAccountKey);
            return next;
          });
        }
        setBusy(false);
        setStatus(event.message || "Minecraft se ha cerrado.");
        if (event.instanceId) {
          setLaunchingInstance((current) =>
            current?.instanceId === event.instanceId ? null : current
          );
        }
      }

      if (event.type === "error") {
        setBusy(false);
        if (event.gameAccountKey) {
          setRunningGames((current) => {
            const next = new Map(current);
            next.delete(event.gameAccountKey);
            return next;
          });
        }
        setError(event.message || "Se produjo un error.");
        setStatus("No se pudo completar la operación.");
        if (event.instanceId) {
          setLaunchingInstance((current) =>
            current?.instanceId === event.instanceId
              ? {
                  ...current,
                  message: event.message || "No se pudo iniciar Minecraft.",
                  status: "error"
                }
              : current
          );
        }
      }
    });

    return () => {
      mounted = false;

      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [refreshInstances, onAccountModeChange]);

  // ====================================================
  // CARGAR VERSIONES DEL CARGADOR SELECCIONADO
  // ====================================================

  useEffect(() => {
    let mounted = true;

    async function loadLoaderVersions() {
      if (loader === "vanilla") {
        setLoaderVersions([]);
        setLoaderVersion("");
        setLoaderVersionsLoading(false);
        setLoaderVersionsError("");
        return;
      }

      if (!minecraftVersion) {
        setLoaderVersions([]);
        setLoaderVersion("");
        return;
      }

      if (!window.eryon?.getLoaderVersions) {
        setLoaderVersions([]);
        setLoaderVersion("");
        setLoaderVersionsLoading(false);
        setLoaderVersionsError(
          "El catálogo de versiones no está conectado. Reinicia Eryon Launcher e inténtalo de nuevo."
        );
        return;
      }

      setLoaderVersionsLoading(true);
      setLoaderVersionsError("");
      setLoaderVersions([]);

      try {
        const result = await window.eryon.getLoaderVersions(
          minecraftVersion,
          loader
        );

        if (!mounted) return;

        const available = Array.isArray(result) ? result : [];

        setLoaderVersions(available);

        if (available.length === 0) {
          setLoaderVersion("");
          setLoaderVersionsError(
            `No se encontraron versiones de ${loader} para Minecraft ${minecraftVersion}.`
          );
          return;
        }

        setLoaderVersion((current) => {
          if (
            current &&
            available.some((item) => item.version === current)
          ) {
            return current;
          }

          return recommendedLoaderVersion(available);
        });
      } catch (loadError) {
        if (mounted) {
          setLoaderVersions([]);
          setLoaderVersion("");
          setLoaderVersionsError(
            loadError.message ||
              `No se pudieron cargar las versiones de ${loader}.`
          );
        }
      } finally {
        if (mounted) setLoaderVersionsLoading(false);
      }
    }

    loadLoaderVersions();

    return () => {
      mounted = false;
    };
  }, [minecraftVersion, loader]);

  // ====================================================
  // SINCRONIZAR PERFIL LOCAL
  // ====================================================

  useEffect(() => {
    const exists = localProfiles.some(
      (profile) => profile.id === localProfileId
    );

    if (
      activeLocalProfile?.id &&
      localProfiles.some((profile) => profile.id === activeLocalProfile.id)
    ) {
      setLocalProfileId(activeLocalProfile.id);
    } else if (!exists) {
      setLocalProfileId(
        localProfiles[0]?.id ||
          ""
      );
    }
  }, [localProfiles, activeLocalProfile, localProfileId]);

  // ====================================================
  // CREAR INSTANCIA
  // ====================================================

  async function handleCreateInstance(event) {
    event.preventDefault();

    setMessage("");
    setError("");

    const cleanName = name.trim();

    if (cleanName.length < 2) {
      setError(
        "El nombre de la instalación debe tener al menos 2 caracteres."
      );
      return;
    }

    if (!minecraftVersion) {
      setError("Selecciona una versión de Minecraft.");
      return;
    }

    if (loader !== "vanilla") {
      if (loaderVersionsLoading) {
        setError(
          "Espera a que termine de cargar el catálogo de versiones."
        );
        return;
      }

      if (!loaderVersion) {
        setError(
          loaderVersionsError ||
            `Selecciona una versión compatible de ${loader}.`
        );
        return;
      }
    }

    if (!window.eryon?.installInstance) {
      setError(
        "La creación de instalaciones no está conectada. Reinicia Eryon Launcher e inténtalo de nuevo."
      );
      return;
    }

    setBusy(true);
    setStatus(`Preparando instalación ${cleanName}...`);

    try {
      const instance = await window.eryon.installInstance({
        name: cleanName,
        minecraftVersion,
        loader,
        loaderVersion:
          loader === "vanilla" ? undefined : loaderVersion
      });

      await refreshInstances();
      setShowCreateInstance(false);

      setMessage(
        `La instalación "${instance.name}" se ha creado correctamente.`
      );
      setStatus("Instalación preparada.");
      setName("");
    } catch (createError) {
      setError(
        createError.message ||
          "No se pudo crear la instalación."
      );
      setStatus("No se pudo crear la instalación.");
    } finally {
      setBusy(false);
    }
  }

  // ====================================================
  // IMPORTAR MODPACK
  // ====================================================

  async function handleImportModpack() {
    if (!window.eryon?.importModpack) {
      setError(
        "La importación no está conectada. Reinicia Eryon Launcher e inténtalo de nuevo."
      );
      return;
    }

    setBusy(true);
    setMessage("");
    setError("");
    setStatus("Abriendo el selector de modpacks...");

    try {
      const imported = await window.eryon.importModpack();

      if (!imported) {
        setStatus("Importación cancelada.");
        return;
      }

      await refreshInstances();

      setMessage(`El modpack "${imported.name}" se ha importado.`);
      setStatus("Modpack importado correctamente.");
    } catch (importError) {
      setError(
        importError.message ||
          "No se pudo importar el modpack."
      );
      setStatus("Falló la importación del modpack.");
    } finally {
      setBusy(false);
    }
  }

  // ====================================================
  // LANZAR INSTANCIA
  // ====================================================

  async function handleLaunchInstance(instance) {
    setMessage("");
    setError("");

    if (!window.eryon?.launchInstance) {
      setError(
        "El lanzamiento de instalaciones no está conectado."
      );
      return;
    }

    let profileSelection;

    if (accountMode === "premium") {
      if (!activeAccount) {
        setError(
          "No tienes una cuenta Microsoft guardada. Ve a Perfiles y añade una cuenta antes de jugar."
        );
        return;
      }

      profileSelection = {
        mode: "premium",
        accountId: activeAccount.id
      };
    } else if (accountMode === "elyby") {
      if (!activeAccount || activeAccount.accountType !== "Ely.by") {
        setError("Conecta una cuenta Ely.by desde el apartado Skins antes de jugar.");
        return;
      }
      profileSelection = { mode: "elyby" };
    } else {
      const selectedProfile = localProfiles.find(
        (profile) => profile.id === localProfileId
      );

      if (!selectedProfile) {
        setError(
          "Selecciona o crea un perfil local antes de jugar."
        );
        return;
      }

      profileSelection = {
        mode: "local",
        profileId: selectedProfile.id
      };
    }

    const gameAccountKey =
      profileSelection.mode === "premium"
        ? `premium:${profileSelection.accountId}`
        : profileSelection.mode === "local"
          ? `local:${profileSelection.profileId}`
          : `elyby:${activeAccount.id}`;

    if (runningGames.has(gameAccountKey)) {
      setError("Esta cuenta ya tiene Minecraft abierto.");
      return;
    }

    try {
      await launchInstanceNow(instance, profileSelection);
    } catch (launchError) {
      setError(
        launchError?.message ||
          "No se pudo comprobar la compatibilidad de los mods."
      );
      setStatus("No se pudo comprobar la instalación.");
    }
  }

  async function launchInstanceNow(instance, profileSelection) {
    setBusy(true);
    setLaunchingInstance({
      instanceId: instance.id,
      name: instance.name,
      iconUrl: instance.iconUrl || "",
      message: "Preparando Minecraft...",
      progress: null,
      status: "launching"
    });
    setStatus(`Iniciando ${instance.name}...`);

    try {
      const result = await window.eryon.launchInstance(
        instance.id,
        profileSelection
      );

      if (result?.started) {
        setStatus(
          `${instance.name} se está iniciando con ${
            result.playerName || "tu perfil"
          }.`
        );
      }
    } catch (launchError) {
      setLaunchingInstance((current) =>
        current?.instanceId === instance.id
          ? {
              ...current,
              message:
                launchError.message || "No se pudo iniciar Minecraft.",
              status: "error"
            }
          : current
      );
      setError(
        launchError.message ||
          "No se pudo iniciar la instalación."
      );
      setStatus("No se pudo iniciar Minecraft.");
    } finally {
      setBusy(false);
    }
  }

  async function installMissingDependencies() {
    if (!pendingLaunch) return;

    setCompatibilityBusy(true);
    setCompatibilityError("");
    try {
      const result = await window.eryon.installInstanceDependencies(
        pendingLaunch.instance.id
      );
      const report = result?.remaining;
      const hasIssues =
        report?.missingDependencies?.length ||
        report?.incompatibleMods?.length ||
        report?.conflicts?.length;

      if (!hasIssues) {
        const { instance, profileSelection } = pendingLaunch;
        setPendingLaunch(null);
        await launchInstanceNow(instance, profileSelection);
        return;
      }

      setPendingLaunch((current) =>
        current
          ? {
              ...current,
              report: {
                ...report,
                minecraftVersion: current.instance.minecraftVersion,
                loader: current.instance.loader,
                manualDependencies: result?.manualDependencies || []
              }
            }
          : current
      );
      setCompatibilityError("");
    } catch (installError) {
      setCompatibilityError(
        installError?.message ||
          "No se pudieron instalar automáticamente las dependencias."
      );
    } finally {
      setCompatibilityBusy(false);
    }
  }

  async function launchDespiteCompatibilityWarnings() {
    if (!pendingLaunch) return;
    const { instance, profileSelection } = pendingLaunch;
    setPendingLaunch(null);
    setCompatibilityError("");
    await launchInstanceNow(instance, profileSelection);
  }

  async function openMissingModsFolder() {
    if (!pendingLaunch) return;

    try {
      await window.eryon.openInstanceFolder(
        pendingLaunch.instance.id,
        "mods"
      );
    } catch (folderError) {
      setCompatibilityError(
        folderError?.message || "No se pudo abrir la carpeta de mods."
      );
    }
  }

  async function recheckInstanceCompatibility() {
    if (!pendingLaunch) return;

    setCompatibilityBusy(true);
    setCompatibilityError("");
    try {
      const report = await window.eryon.checkInstanceCompatibility(
        pendingLaunch.instance.id
      );
      const missingIds = new Set(
        (report.missingDependencies || []).map((item) =>
          String(item.id).toLowerCase()
        )
      );
      const manualDependencies = (
        pendingLaunch.report.manualDependencies || []
      ).filter((item) => missingIds.has(String(item.id).toLowerCase()));
      const hasIssues =
        report.missingDependencies?.length ||
        report.incompatibleMods?.length ||
        report.conflicts?.length;

      if (!hasIssues) {
        const { instance, profileSelection } = pendingLaunch;
        setPendingLaunch(null);
        await launchInstanceNow(instance, profileSelection);
        return;
      }

      setPendingLaunch((current) =>
        current
          ? {
              ...current,
              report: {
                ...report,
                minecraftVersion: current.instance.minecraftVersion,
                loader: current.instance.loader,
                manualDependencies
              }
            }
          : current
      );
    } catch (checkError) {
      setCompatibilityError(
        checkError?.message || "No se pudo volver a comprobar la instalación."
      );
    } finally {
      setCompatibilityBusy(false);
    }
  }

  // ====================================================
  // ABRIR CARPETA DE INSTANCIA
  // ====================================================

  async function handleOpenInstanceFolder(instance) {
    setMessage("");
    setError("");

    if (!window.eryon?.openInstanceFolder) {
      setError(
        "La función para abrir carpetas no está conectada. Reinicia Eryon Launcher e inténtalo de nuevo."
      );
      return;
    }

    try {
      await window.eryon.openInstanceFolder(instance.id);
      setMessage(`Se abrió la carpeta de "${instance.name}".`);
    } catch (folderError) {
      setError(
        folderError.message ||
          "No se pudo abrir la carpeta de la instalación."
      );
    }
  }

  // ====================================================
  // ELIMINAR INSTANCIA
  // ====================================================

  async function handleDeleteInstance(instance) {
    if (!window.eryon?.deleteInstance) {
      setError(
        "La eliminación de instalaciones no está conectada. Reinicia Eryon Launcher e inténtalo de nuevo."
      );
      return;
    }

    setError("");
    setMessage("");
    setDeleteTarget(instance);
  }

  async function confirmDeleteInstance() {
    if (!deleteTarget || deleting) return;

    const target = deleteTarget;

    setDeleting(true);

    try {
      const result = await window.eryon.deleteInstance(target.id);

      if (result?.deleted) {
        setInstances(
          Array.isArray(result.instances) ? result.instances : []
        );

        if (detailInstanceId === target.id) {
          setDetailInstanceId("");
          setPageView("instalaciones");
        }

        if (settingsInstance?.id === target.id) {
          setSettingsInstance(null);
        }

        setMessage(
          `La instalación "${target.name}" se ha eliminado.`
        );

        setStatus("Instalación eliminada.");
      } else {
        setStatus("Eliminación cancelada.");
      }

      setDeleteTarget(null);
    } catch (deleteError) {
      setDeleteTarget(null);
      setError(
        deleteError.message ||
          "No se pudo eliminar la instalación."
      );
    } finally {
      setDeleting(false);
    }
  }

  // ====================================================
  // ACTUALIZAR INSTALACIONES
  // ====================================================

  async function handleRefresh() {
    setBusy(true);
    setMessage("");
    setError("");

    try {
      await refreshInstances();
      setStatus("Lista de instalaciones actualizada.");
    } catch (refreshError) {
      setError(
        refreshError.message ||
          "No se pudo actualizar la lista."
      );
    } finally {
      setBusy(false);
      setLoadingInstances(false);
    }
  }

  async function handleInstanceUpdated(updatedInstance) {
    const list = await refreshInstances();

    const fresh =
      list.find((item) => item.id === updatedInstance.id) ||
      updatedInstance;

    setSettingsInstance(fresh);
    setMessage(`Se actualizaron los datos de "${fresh.name}".`);
  }

  const canCreate =
    !busy &&
    !loadingVersions &&
    versions.length > 0 &&
    Boolean(minecraftVersion) &&
    (
      loader === "vanilla" ||
      (
        !loaderVersionsLoading &&
        loaderVersions.length > 0 &&
        Boolean(loaderVersion)
      )
    );

  return (
    <div className="modpacks-page">
      <SectionHeading
        eyebrow="BIBLIOTECA DE MINECRAFT"
        title="Modpacks e instalaciones"
        description="Crea instalaciones independientes de Vanilla, Forge y Fabric, o importa tus paquetes .mrpack."
      />

      {/* Dos vistas: descargar contenido o gestionar instalaciones */}
      <div className="content-tabs modpacks-view-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={pageView === "explorar"}
          className={`content-tab ${
            pageView === "explorar" ? "active" : ""
          }`}
          onClick={() => setPageView("explorar")}
        >
          <span aria-hidden="true">▣</span>
          DESCARGAR CONTENIDO
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={
            pageView === "instalaciones" || pageView === "detalle"
          }
          className={`content-tab ${
            pageView === "instalaciones" || pageView === "detalle"
              ? "active"
              : ""
          }`}
          onClick={() => setPageView("instalaciones")}
        >
          <span aria-hidden="true">▦</span>
          MIS INSTALACIONES
        </button>
      </div>

      {pageView === "explorar" ? (
        <ContentBrowser
          onInstancesChanged={refreshInstances}
          presetInstanceId={explorerPresetId}
          presetCategory={explorerPresetCategory}
          installingModpackIds={installingModpackIds}
          onModpackInstallStart={handleExplorerModpackInstallStart}
          onModpackInstallFinish={handleExplorerModpackInstallFinish}
        />
      ) : pageView === "detalle" && detailInstance ? (
        <InstanceDetailsPage
          key={detailInstance.id}
          instance={detailInstance}
          busy={busy}
          gameRunning={gameRunning}
          launchProgress={
            launchingInstance?.instanceId === detailInstance.id
              ? launchingInstance
              : null
          }
          onDismissLaunchProgress={() => setLaunchingInstance(null)}
          onBack={() => setPageView("instalaciones")}
          onPlay={() => handleLaunchInstance(detailInstance)}
          onSearchMods={(category = "mods") => {
            setExplorerPresetId(detailInstance.id);
            setExplorerPresetCategory(category);
            setPageView("explorar");
          }}
          onOpenFolder={() => handleOpenInstanceFolder(detailInstance)}
          onConfigure={() => setSettingsInstance(detailInstance)}
          onDelete={() => handleDeleteInstance(detailInstance)}
        />
      ) : (
      <>
      {pageView === "instalaciones" && (
      <>
      {showCreateInstance && (
      <div
        className="instance-settings-backdrop modpack-actions-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) {
            setShowCreateInstance(false);
          }
        }}
      >
        <section
          className="instance-settings-modal modpack-actions-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modpack-actions-title"
        >
          <header className="instance-settings-header">
            <div>
              <p className="instance-settings-eyebrow">MIS INSTALACIONES</p>
              <h2 id="modpack-actions-title">Crear o importar instancia</h2>
              <p className="instance-settings-subtitle">
                Crea una instalación nueva o importa un archivo .mrpack.
              </p>
            </div>
            <button
              className="instance-settings-close"
              type="button"
              aria-label="Cerrar ventana"
              onClick={() => setShowCreateInstance(false)}
              disabled={busy}
            >
              ×
            </button>
          </header>
          <div className="modpack-actions-grid">
        <section className="panel modpack-create-panel">
          <div className="panel-heading">
            <span className="eyebrow">NUEVA INSTALACIÓN</span>
            <span className="status-pill">VANILLA / MODDED</span>
          </div>

          <form onSubmit={handleCreateInstance}>
            <label className="field-label" htmlFor="instance-name">
              NOMBRE DE LA INSTALACIÓN
            </label>

            <input
              id="instance-name"
              className="text-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ejemplo: Mi mundo con mods"
              maxLength={48}
              minLength={2}
              autoComplete="off"
              required
              disabled={busy}
            />

            <label className="field-label" htmlFor="instance-version">
              VERSIÓN DE MINECRAFT
            </label>

            <select
              id="instance-version"
              className="text-input"
              value={minecraftVersion}
              onChange={(event) => {
                setMinecraftVersion(event.target.value);
                setLoaderVersion("");
              }}
              disabled={loadingVersions || busy}
              required
            >
              {loadingVersions && (
                <option value="">Cargando versiones...</option>
              )}

              {!loadingVersions && versions.length === 0 && (
                <option value="">No hay versiones disponibles</option>
              )}

              {versions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                  {item.id === versions[0]?.id
                    ? " — reciente del catálogo"
                    : ""}
                </option>
              ))}
            </select>

            <label className="field-label" htmlFor="instance-loader">
              CARGADOR DE MODS
            </label>

            <select
              id="instance-loader"
              className="text-input"
              value={loader}
              onChange={(event) => {
                setLoader(event.target.value);
                setLoaderVersion("");
                setLoaderVersionsError("");
              }}
              disabled={busy}
            >
              <option value="vanilla">Vanilla — Minecraft original</option>
              <option value="forge">Forge — compatible con mods Forge</option>
              <option value="fabric">Fabric — cargador ligero de mods</option>
            </select>

            {(loader === "forge" || loader === "fabric") && (
              <div className="loader-version-selector">
                <label
                  className="field-label"
                  htmlFor="create-loader-version"
                >
                  VERSIÓN DE {loader.toUpperCase()}
                </label>

                <select
                  id="create-loader-version"
                  className="text-input"
                  value={loaderVersion}
                  onChange={(event) => setLoaderVersion(event.target.value)}
                  disabled={
                    busy ||
                    loadingVersions ||
                    loaderVersionsLoading ||
                    loaderVersions.length === 0
                  }
                >
                  {loaderVersionsLoading && (
                    <option value="">Consultando catálogo oficial...</option>
                  )}

                  {!loaderVersionsLoading &&
                    loaderVersions.length === 0 && (
                      <option value="">No hay versiones disponibles</option>
                    )}

                  {loaderVersions.map((item) => (
                    <option key={item.version} value={item.version}>
                      {loaderVersionLabel(item)}
                    </option>
                  ))}
                </select>

                {loaderVersionsLoading && (
                  <p className="field-hint">
                    Consultando las versiones compatibles con Minecraft{" "}
                    {minecraftVersion}...
                  </p>
                )}

                {!loaderVersionsLoading &&
                  !loaderVersionsError &&
                  loaderVersions.length > 0 && (
                    <p className="field-hint">
                      Puedes elegir cualquier versión compatible. La versión
                      predeterminada se elige desde el catálogo de{" "}
                      {loader === "forge" ? "Forge" : "Fabric"}.
                    </p>
                  )}

                {loaderVersionsError && (
                  <div className="settings-error" role="alert">
                    <p>{loaderVersionsError}</p>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy || loaderVersionsLoading}
                      onClick={async () => {
                        setLoaderVersionsError("");
                        setLoaderVersionsLoading(true);

                        try {
                          const result =
                            await window.eryon.getLoaderVersions(
                              minecraftVersion,
                              loader
                            );

                          const list = Array.isArray(result)
                            ? result
                            : [];

                          setLoaderVersions(list);
                          setLoaderVersion(
                            recommendedLoaderVersion(list)
                          );

                          setLoaderVersionsError(
                            list.length
                              ? ""
                              : "El catálogo no devolvió versiones."
                          );
                        } catch (retryError) {
                          setLoaderVersionsError(
                            retryError.message ||
                              "No se pudo consultar el catálogo."
                          );
                        } finally {
                          setLoaderVersionsLoading(false);
                        }
                      }}
                    >
                      REINTENTAR
                    </button>
                  </div>
                )}
              </div>
            )}

            <button
              className="primary-button full-button"
              type="submit"
              disabled={!canCreate}
            >
              {busy
                ? "PROCESANDO..."
                : loader === "vanilla"
                  ? "CREAR INSTALACIÓN VANILLA"
                  : `CREAR INSTALACIÓN ${loader.toUpperCase()}`}
            </button>
          </form>

          <p className="field-hint">
            Cada instalación dispone de su propia carpeta para separar
            sus mods, configuraciones y archivos.
          </p>
        </section>

        <section className="panel modpack-import-panel">
          <div className="panel-heading">
            <span className="eyebrow">IMPORTAR MODPACK</span>
            <span className="status-pill">.MRPACK</span>
          </div>

          <div className="notice-panel">
            <div className="notice-icon">▦</div>
            <div>
              <h3>¿Ya tienes un modpack?</h3>
              <p>
                Selecciona un archivo .mrpack compatible para prepararlo
                como una instalación independiente.
              </p>
            </div>
          </div>

          <button
            className="primary-button full-button"
            type="button"
            onClick={handleImportModpack}
            disabled={busy}
          >
            {busy ? "PROCESANDO..." : "IMPORTAR ARCHIVO .MRPACK"}
          </button>
        </section>
          </div>
        </section>
      </div>
      )}

      {error && (
        <section className="panel modpack-error-panel" role="alert">
          <div className="panel-heading">
            <span className="eyebrow">ERROR</span>
          </div>

          <strong>No se pudo completar la operación</strong>
          <p>{error}</p>
        </section>
      )}

      {message && (
        <p className="modpack-feedback-line" role="status">
          {message}
        </p>
      )}

      <div className="panel-heading modpack-list-heading">
        <div>
          <span className="eyebrow">TU BIBLIOTECA</span>
          <h2>Instalaciones guardadas</h2>
        </div>
        <div className="modpack-list-actions">
          <span className="status-pill">{instances.length}</span>
          <button
            className="secondary-button"
            type="button"
            onClick={handleRefresh}
            disabled={busy}
          >
            ACTUALIZAR
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => setShowCreateInstance(true)}
            disabled={showCreateInstance || busy}
          >
            CREAR / IMPORTAR INSTANCIA
          </button>
        </div>
      </div>

      {loadingInstances ? (
        <section className="panel">
          <p>Cargando instalaciones...</p>
        </section>
      ) : instances.length === 0 && !installingPack ? (
        <section className="panel">
          <div className="notice-panel">
            <div className="notice-icon">＋</div>
            <div>
              <h3>Tu biblioteca está vacía</h3>
              <p>
                Crea una instalación de Vanilla, Forge o Fabric, o importa
                un archivo .mrpack.
              </p>
            </div>
          </div>
        </section>
      ) : (
        <div className="feature-grid modpack-instance-grid">
          {installingPack && (
            <article
              className={`feature-card modpack-instance-card modpack-installing-card ${
                installingPack.status === "error" ? "has-error" : ""
              }`}
              key={`installing-${installingPack.source || "modrinth"}-${installingPack.id || installingPack.name}`}
              aria-live="polite"
            >
              <div className="modpack-instance-top">
                <span className="feature-icon">
                  <InstanceLogo
                    iconUrl={installingPack.iconUrl}
                    fallback="▦"
                  />
                </span>
                <span className="status-pill">
                  {installingPack.status === "error"
                    ? "ERROR"
                    : "INSTALANDO"}
                </span>
              </div>
              <h3>{installingPack.name}</h3>
              <p className="modpack-installing-message">
                {installingPack.message}
              </p>
              {installingPack.status === "error" ? (
                <button
                  className="secondary-button full-button"
                  type="button"
                  onClick={() => setInstallingPack(null)}
                >
                  CERRAR
                </button>
              ) : (
                <>
                  <div
                    className={`modpack-progress-track ${
                      installingPack.progress === null
                        ? "is-indeterminate"
                        : ""
                    }`}
                    role="progressbar"
                    aria-label={`Instalando ${installingPack.name}`}
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow={
                      typeof installingPack.progress === "number"
                        ? Math.round(installingPack.progress)
                        : undefined
                    }
                  >
                    <span
                      className="modpack-progress-fill"
                      style={{
                        width:
                          typeof installingPack.progress === "number"
                            ? `${Math.max(0, Math.min(100, installingPack.progress))}%`
                            : undefined
                      }}
                    />
                  </div>
                  <div className="modpack-progress-caption">
                    <span>Descargando e instalando</span>
                    {typeof installingPack.progress === "number" && (
                      <strong>
                        {Math.round(installingPack.progress)}%
                      </strong>
                    )}
                  </div>
                </>
              )}
            </article>
          )}
          {instances.map((instance) => (
            <article
              className="feature-card modpack-instance-card"
              key={instance.id}
            >
              <button
                className="modpack-instance-open"
                type="button"
                onClick={() => {
                  setDetailInstanceId(instance.id);
                  setPageView("detalle");
                }}
              >
                <div className="modpack-instance-top">
                  <span className="feature-icon">
                    <InstanceLogo
                      iconUrl={instance.iconUrl}
                      fallback={
                        instance.loader === "forge"
                          ? "⬡"
                          : instance.loader === "fabric"
                            ? "◇"
                            : "▦"
                      }
                    />
                  </span>
                  <span className="status-pill">
                    {String(instance.loader || "vanilla").toUpperCase()}
                  </span>
                </div>

                <h3>{instance.name}</h3>
                <p>Minecraft {instance.minecraftVersion}</p>
                <span className="modpack-instance-view-hint">
                  Ver mods y detalles →
                </span>
              </button>

              <div className="modpack-instance-actions">
                <button
                  className="primary-button full-button"
                  type="button"
                  disabled={busy || selectedAccountIsRunning}
                  onClick={() => handleLaunchInstance(instance)}
                >
                  {selectedAccountIsRunning
                    ? "MINECRAFT EN EJECUCIÓN"
                    : "JUGAR"}
                </button>

                <button
                  className="instance-reload-button"
                  type="button"
                  disabled={busy}
                  title="Recargar esta instalación (si añadiste mods a mano en la carpeta)"
                  aria-label={`Recargar ${instance.name}`}
                  onClick={() => {
                    refreshInstances().catch(() => {
                      // Silencio: si falla, se mantiene la lista anterior.
                    });
                  }}
                >
                  <span aria-hidden="true">↻</span>
                </button>
              </div>

              {launchingInstance?.instanceId === instance.id && (
                <InstanceLaunchProgress
                  instanceName={instance.name}
                  launchProgress={launchingInstance}
                  onDismiss={() => setLaunchingInstance(null)}
                />
              )}
            </article>
          ))}
        </div>
      )}

      <p className="launcher-disclaimer">
        La creación e importación necesita conexión a internet. Algunos
        modpacks pueden requerir dependencias o descargas manuales adicionales.
        Comprueba que los mods sean compatibles con Minecraft y el cargador
        seleccionados.
      </p>
      </>
      )}

      </>
      )}

      {settingsInstance && (
        <InstanceSettingsModal
          key={settingsInstance.id}
          instance={settingsInstance}
          onClose={() => setSettingsInstance(null)}
          onInstanceUpdated={handleInstanceUpdated}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Eliminar instalación"
          description={`¿Quieres eliminar "${deleteTarget.name}"?`}
          detail="Se borrarán sus mods, configuraciones y mundos guardados. No afecta a las demás instalaciones. Esta acción no se puede deshacer."
          confirmLabel="ELIMINAR INSTALACIÓN"
          confirmDelaySeconds={5}
          cancelLabel="CANCELAR"
          busyLabel="ELIMINANDO..."
          busy={deleting}
          onConfirm={confirmDeleteInstance}
          onCancel={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        />
      )}

    </div>
  );
}

// ======================================================
// CONFIGURAR UNA INSTALACIÓN
// ======================================================

function InstanceSettingsModal({
  instance,
  onClose,
  onInstanceUpdated
}) {
  useModalScrollTop();

  const [ramSettings, setRamSettings] = useState(null);
  const [ramLoading, setRamLoading] = useState(true);
  const [savingRam, setSavingRam] = useState(false);

  const [loaderVersions, setLoaderVersions] = useState([]);
  const [loaderVersionsLoading, setLoaderVersionsLoading] =
    useState(false);
  const [loaderVersionsError, setLoaderVersionsError] = useState("");
  const [selectedLoaderVersion, setSelectedLoaderVersion] =
    useState(instance.loaderVersion || "");
  const [changingLoader, setChangingLoader] = useState(false);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [nameValue, setNameValue] = useState(instance.name);
  const [renaming, setRenaming] = useState(false);
  const [savingLogo, setSavingLogo] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [logoMessage, setLogoMessage] = useState("");
  const logoInputRef = useRef(null);
  const [iconUrl, setIconUrl] = useState(instance.iconUrl || "");

  useEffect(() => {
    setIconUrl(instance.iconUrl || "");
  }, [instance.iconUrl]);

  const isModded =
    instance.loader === "forge" ||
    instance.loader === "fabric";

  async function handleSaveLogo(file) {
    if (!file) return;

    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setLogoError("El logo debe ser un archivo PNG, JPG o WebP.");
      return;
    }

    if (file.size > 1024 * 1024) {
      setLogoError("El logo no puede superar 1 MB.");
      return;
    }

    setSavingLogo(true);
    setLogoError("");
    setLogoMessage("");

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
        reader.readAsDataURL(file);
      });

      if (!window.eryon?.setInstanceIcon) {
        throw new Error("No se pueden guardar logos en este launcher.");
      }

      const updated = await window.eryon.setInstanceIcon(instance.id, dataUrl);
      setIconUrl(updated.iconUrl || "");
      await onInstanceUpdated(updated);
      setLogoMessage("Se guardó el logo de la instalación.");
    } catch (logoSaveError) {
      setLogoError(logoSaveError?.message || "No se pudo guardar el logo.");
    } finally {
      setSavingLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  }

  async function handleRemoveLogo() {
    setSavingLogo(true);
    setLogoError("");
    setLogoMessage("");

    try {
      if (!window.eryon?.setInstanceIcon) {
        throw new Error("No se pueden guardar logos en este launcher.");
      }

      const updated = await window.eryon.setInstanceIcon(instance.id, "");
      setIconUrl("");
      await onInstanceUpdated(updated);
      setLogoMessage("Se quitó el logo personalizado.");
    } catch (logoSaveError) {
      setLogoError(logoSaveError?.message || "No se pudo quitar el logo.");
    } finally {
      setSavingLogo(false);
    }
  }

  useEffect(() => {
    let active = true;

    async function loadRamSettings() {
      try {
        if (!window.eryon?.getInstanceSettings) {
          throw new Error(
            "La configuración de instancias no está conectada."
          );
        }

        const result =
          await window.eryon.getInstanceSettings(instance.id);

        if (!active) return;

        setRamSettings({
          useCustomRam: result.useCustomRam === true,
          minRamGB: Number(result.minRamGB ?? 2),
          maxRamGB: Number(result.maxRamGB ?? 4),
          useCustomResolution: result.useCustomResolution === true,
          resolution: result.resolution || "default",
          useCustomJvmArgs: result.useCustomJvmArgs === true,
          jvmArgs: result.jvmArgs || "",
          totalRamGB: Number(result.totalRamGB ?? 8),
          maxAllowedRamGB: Number(result.maxAllowedRamGB ?? 6)
        });
      } catch (loadError) {
        if (active) {
          setError(
            loadError.message ||
              "No se pudo cargar la configuración de RAM."
          );
        }
      } finally {
        if (active) setRamLoading(false);
      }
    }

    loadRamSettings();

    return () => {
      active = false;
    };
  }, [instance.id]);

  useEffect(() => {
    let active = true;

    async function loadLoaderCatalog() {
      if (!isModded) {
        setLoaderVersions([]);
        setLoaderVersionsLoading(false);
        setLoaderVersionsError("");
        return;
      }

      if (!window.eryon?.getLoaderVersions) {
        setLoaderVersionsError(
          "El catálogo de versiones no está conectado. Reinicia Eryon Launcher e inténtalo de nuevo."
        );
        return;
      }

      setLoaderVersionsLoading(true);
      setLoaderVersionsError("");

      try {
        const result = await window.eryon.getLoaderVersions(
          instance.minecraftVersion,
          instance.loader
        );

        if (!active) return;

        const available = Array.isArray(result) ? result : [];
        setLoaderVersions(available);

        const currentExists = available.some(
          (item) => item.version === instance.loaderVersion
        );

        if (currentExists || instance.loaderVersion) {
          setSelectedLoaderVersion(instance.loaderVersion);
        } else {
          setSelectedLoaderVersion(
            recommendedLoaderVersion(available)
          );
        }

        if (available.length === 0) {
          setLoaderVersionsError(
            `No hay versiones disponibles de ${instance.loader} para Minecraft ${instance.minecraftVersion}.`
          );
        }
      } catch (catalogError) {
        if (active) {
          setLoaderVersions([]);
          setLoaderVersionsError(
            catalogError.message || "No se pudo consultar el catálogo."
          );
        }
      } finally {
        if (active) setLoaderVersionsLoading(false);
      }
    }

    loadLoaderCatalog();

    return () => {
      active = false;
    };
  }, [
    instance.id,
    instance.minecraftVersion,
    instance.loader,
    instance.loaderVersion,
    isModded
  ]);

  function updateRamField(field, value) {
    setRamSettings((current) => ({
      ...current,
      [field]: value
    }));

    setMessage("");
    setError("");
  }

  async function handleSaveRam(event) {
    event.preventDefault();

    if (!ramSettings) return;

    setSavingRam(true);
    setMessage("");
    setError("");

    try {
      if (!window.eryon?.saveInstanceSettings) {
        throw new Error(
          "La función para guardar RAM no está conectada."
        );
      }

      const saved = await window.eryon.saveInstanceSettings(
        instance.id,
        {
          useCustomRam: ramSettings.useCustomRam,
          minRamGB: Number(ramSettings.minRamGB),
          maxRamGB: Number(ramSettings.maxRamGB),
          useCustomResolution: ramSettings.useCustomResolution,
          resolution: ramSettings.resolution,
          useCustomJvmArgs: ramSettings.useCustomJvmArgs,
          jvmArgs: ramSettings.jvmArgs
        }
      );

      setRamSettings({
        useCustomRam: saved.useCustomRam === true,
        minRamGB: Number(saved.minRamGB),
        maxRamGB: Number(saved.maxRamGB),
        useCustomResolution: saved.useCustomResolution === true,
        resolution: saved.resolution || "default",
        useCustomJvmArgs: saved.useCustomJvmArgs === true,
        jvmArgs: saved.jvmArgs || "",
        totalRamGB: Number(saved.totalRamGB),
        maxAllowedRamGB: Number(saved.maxAllowedRamGB)
      });

      setMessage(
        saved.useCustomRam
          ? `RAM personalizada guardada: ${saved.minRamGB}–${saved.maxRamGB} GB.`
          : "Se guardó la configuración para usar la RAM global."
      );
    } catch (saveError) {
      setError(
        saveError.message ||
          "No se pudo guardar la RAM de esta instalación."
      );
    } finally {
      setSavingRam(false);
    }
  }

  async function handleChangeLoaderVersion() {
    if (!isModded) return;

    setMessage("");
    setError("");

    if (!selectedLoaderVersion) {
      setError("Selecciona una versión válida del cargador.");
      return;
    }

    if (selectedLoaderVersion === instance.loaderVersion) {
      setMessage("Esta versión ya está instalada.");
      return;
    }

    if (!window.eryon?.updateInstanceLoader) {
      setError(
        "La actualización del cargador no está conectada. Reinicia Eryon Launcher e inténtalo de nuevo."
      );
      return;
    }

    const confirmed = window.confirm(
      `¿Cambiar ${instance.loader} de ${
        instance.loaderVersion || "la versión actual"
      } a ${selectedLoaderVersion}?\n\n` +
      "ERYON intentará conservar tus carpetas mods, config y saves. " +
      "Algunos mods podrían dejar de ser compatibles con la nueva versión."
    );

    if (!confirmed) return;

    setChangingLoader(true);

    try {
      const updated = await window.eryon.updateInstanceLoader(
        instance.id,
        selectedLoaderVersion
      );

      await onInstanceUpdated(updated);

      setSelectedLoaderVersion(
        updated.loaderVersion || selectedLoaderVersion
      );

      setMessage(
        `${instance.loader.toUpperCase()} se actualizó a ${updated.loaderVersion}.`
      );
    } catch (changeError) {
      setError(
        changeError.message ||
          "No se pudo cambiar la versión del cargador."
      );
    } finally {
      setChangingLoader(false);
    }
  }

  async function handleRenameInstance(event) {
    event.preventDefault();

    setMessage("");
    setError("");

    const cleanName = nameValue.trim();

    if (cleanName.length < 2) {
      setError("El nombre debe tener al menos 2 caracteres.");
      return;
    }

    if (cleanName === instance.name) {
      setMessage("El nombre no ha cambiado.");
      return;
    }

    if (!window.eryon?.renameInstance) {
      setError(
        "Cambiar el nombre no está disponible. Reinicia Eryon Launcher e inténtalo de nuevo."
      );
      return;
    }

    setRenaming(true);

    try {
      const updated = await window.eryon.renameInstance(
        instance.id,
        cleanName
      );

      setNameValue(updated.name);
      await onInstanceUpdated(updated);
      setMessage(`Esta instalación ahora se llama "${updated.name}".`);
    } catch (renameError) {
      setError(
        renameError.message ||
          "No se pudo cambiar el nombre de la instalación."
      );
    } finally {
      setRenaming(false);
    }
  }

  const maxAllowed = Math.max(
    2,
    Number(ramSettings?.maxAllowedRamGB ?? 2)
  );

  const maxOptions = Array.from(
    { length: Math.max(1, maxAllowed - 1) },
    (_, index) => index + 2
  );

  const minOptions = Array.from(
    {
      length: Math.max(1, Number(ramSettings?.maxRamGB ?? 2))
    },
    (_, index) => index + 1
  );

  const memoryWarning =
    ramSettings &&
    ramSettings.useCustomRam &&
    Number(ramSettings.maxRamGB) >
      Number(ramSettings.totalRamGB) * 0.75;

  const currentVersionListed = loaderVersions.some(
    (item) => item.version === instance.loaderVersion
  );

  return (
    <div className="instance-settings-backdrop">
      <section
        className="instance-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="instance-settings-title"
      >
        <header className="instance-settings-header">
          <div>
            <p className="instance-settings-eyebrow">
              AJUSTES DEL MODPACK
            </p>

            <h2 id="instance-settings-title">{instance.name}</h2>

            <p className="instance-settings-subtitle">
              Minecraft {instance.minecraftVersion}
              {" · "}
              {instance.loader.toUpperCase()}
            </p>
          </div>

          <button
            type="button"
            className="instance-settings-close"
            onClick={onClose}
            aria-label="Cerrar configuración"
            disabled={savingRam || changingLoader || renaming}
          >
            ×
          </button>
        </header>

        <section className="instance-settings-section">
          <div className="instance-settings-section-title">
            <span aria-hidden="true">✎</span>
            <div>
              <h3>Nombre de la instalación</h3>
              <p>
                Cambia cómo se muestra este modpack en tu biblioteca.
                La carpeta y los archivos instalados no se modifican.
              </p>
            </div>
          </div>

          <form
            className="instance-rename-form"
            onSubmit={handleRenameInstance}
          >
            <label
              className="instance-settings-field"
              htmlFor="instance-name-input"
            >
              <span>NOMBRE</span>

              <input
                id="instance-name-input"
                className="text-input"
                type="text"
                value={nameValue}
                maxLength={48}
                onChange={(event) => setNameValue(event.target.value)}
                disabled={renaming}
                placeholder="Nombre de la instalación"
              />
            </label>

            <button
              className="primary-button full-button"
              type="submit"
              disabled={
                renaming ||
                !nameValue.trim() ||
                nameValue.trim() === instance.name
              }
            >
              {renaming ? "GUARDANDO NOMBRE..." : "GUARDAR NOMBRE"}
            </button>
          </form>
        </section>

        {isModded && (
          <section className="instance-settings-section">
            <div className="instance-settings-section-title">
              <span aria-hidden="true">🧩</span>
              <div>
                <h3>Versión del cargador</h3>
                <p>
                  Cambia la versión de {instance.loader} sin cambiar
                  la versión de Minecraft.
                </p>
              </div>
            </div>

            <div className="instance-settings-current-version">
              <span>Versión instalada</span>
              <strong>{instance.loaderVersion || "No determinada"}</strong>
            </div>

            <label
              className="instance-settings-field"
              htmlFor="instance-new-loader-version"
            >
              <span>NUEVA VERSIÓN DE {instance.loader.toUpperCase()}</span>

              <select
                id="instance-new-loader-version"
                className="text-input"
                value={selectedLoaderVersion}
                onChange={(event) =>
                  setSelectedLoaderVersion(event.target.value)
                }
                disabled={
                  loaderVersionsLoading ||
                  changingLoader ||
                  loaderVersions.length === 0
                }
              >
                {loaderVersionsLoading && (
                  <option value="">Consultando catálogo...</option>
                )}

                {!loaderVersionsLoading &&
                  !currentVersionListed &&
                  instance.loaderVersion && (
                    <option value={instance.loaderVersion}>
                      {instance.loaderVersion} — instalada, fuera del catálogo actual
                    </option>
                  )}

                {loaderVersions.map((item) => (
                  <option key={item.version} value={item.version}>
                    {loaderVersionLabel(item)}
                  </option>
                ))}
              </select>
            </label>

            {loaderVersionsLoading && (
              <p className="instance-settings-help">
                Consultando versiones compatibles con Minecraft{" "}
                {instance.minecraftVersion}...
              </p>
            )}

            {loaderVersionsError && (
              <p className="instance-settings-error" role="alert">
                {loaderVersionsError}
              </p>
            )}

            <button
              className="secondary-button full-button"
              type="button"
              onClick={handleChangeLoaderVersion}
              disabled={
                loaderVersionsLoading ||
                changingLoader ||
                !selectedLoaderVersion ||
                selectedLoaderVersion === instance.loaderVersion ||
                !loaderVersions.some(
                  (item) => item.version === selectedLoaderVersion
                )
              }
            >
              {changingLoader
                ? "INSTALANDO NUEVA VERSIÓN..."
                : "APLICAR VERSIÓN DEL CARGADOR"}
            </button>

            <p className="instance-settings-help">
              Cambiar la versión puede afectar la compatibilidad de los mods.
              Haz una copia de seguridad antes de cambiarla.
            </p>
          </section>
        )}

        <section className="instance-settings-section">
          <div className="instance-settings-section-title">
            <span aria-hidden="true">▧</span>
            <div>
              <h3>Logo del modpack</h3>
              <p>
                Elige una imagen para identificar esta instalación en tu
                biblioteca. Acepta PNG, JPG o WebP de hasta 1 MB.
              </p>
            </div>
          </div>

          <div className="instance-settings-logo-row">
            <div className="instance-settings-logo-preview">
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
            <div className="instance-settings-logo-actions">
              <input
                ref={logoInputRef}
                className="instance-settings-logo-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Elegir logo del modpack"
                disabled={savingLogo}
                onChange={(event) => handleSaveLogo(event.target.files?.[0])}
              />
              <button
                className="secondary-button"
                type="button"
                disabled={savingLogo}
                onClick={() => logoInputRef.current?.click()}
              >
                {savingLogo ? "GUARDANDO LOGO..." : "CAMBIAR LOGO"}
              </button>
              {iconUrl && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={savingLogo}
                  onClick={handleRemoveLogo}
                >
                  QUITAR LOGO
                </button>
              )}
            </div>
          </div>
          {logoError && <p className="instance-settings-error" role="alert">{logoError}</p>}
          {logoMessage && <p className="feedback-message" role="status">{logoMessage}</p>}
        </section>

        <section className="instance-settings-section">
          <div className="instance-settings-section-title">
            <span aria-hidden="true">🧠</span>
            <div>
              <h3>Memoria RAM</h3>
              <p>
                Decide cuánta memoria Java podrá utilizar esta instalación
                al iniciar Minecraft.
              </p>
            </div>
          </div>

          {ramLoading ? (
            <p>Cargando ajustes de memoria...</p>
          ) : !ramSettings ? (
            <p className="instance-settings-error">
              No se pudo cargar la configuración de RAM.
            </p>
          ) : (
            <form onSubmit={handleSaveRam}>
              <label className="instance-settings-toggle">
                <input
                  type="checkbox"
                  checked={ramSettings.useCustomRam}
                  onChange={(event) =>
                    updateRamField("useCustomRam", event.target.checked)
                  }
                  disabled={savingRam}
                />

                <span>
                  <strong>Personalizar RAM para esta instalación</strong>
                  <small>
                    Si está desactivado, se utilizará la RAM global del launcher.
                  </small>
                </span>
              </label>

              <div className="instance-settings-memory-grid">
                <label className="instance-settings-field">
                  <span>RAM mínima</span>

                  <select
                    className="text-input"
                    value={ramSettings.minRamGB}
                    disabled={!ramSettings.useCustomRam || savingRam}
                    onChange={(event) =>
                      updateRamField("minRamGB", Number(event.target.value))
                    }
                  >
                    {minOptions.map((gb) => (
                      <option key={gb} value={gb}>{gb} GB</option>
                    ))}
                  </select>
                </label>

                <label className="instance-settings-field">
                  <span>RAM máxima</span>

                  <select
                    className="text-input"
                    value={ramSettings.maxRamGB}
                    disabled={!ramSettings.useCustomRam || savingRam}
                    onChange={(event) => {
                      const maxRamGB = Number(event.target.value);

                      setRamSettings((current) => ({
                        ...current,
                        maxRamGB,
                        minRamGB: Math.min(
                          Number(current.minRamGB),
                          maxRamGB
                        )
                      }));
                    }}
                  >
                    {maxOptions.map((gb) => (
                      <option key={gb} value={gb}>{gb} GB</option>
                    ))}
                  </select>
                </label>
              </div>

              <p className="instance-settings-help">
                RAM detectada: {ramSettings.totalRamGB} GB. Deja memoria
                disponible para Windows y otras aplicaciones.
              </p>

              {memoryWarning && (
                <div className="instance-settings-warning">
                  La memoria seleccionada supera el 75 % de la RAM detectada.
                  Esto podría dejar poca memoria para Windows y otras aplicaciones.
                </div>
              )}

              <button
                className="primary-button full-button"
                type="submit"
                disabled={savingRam}
              >
                {savingRam
                  ? "GUARDANDO RAM..."
                  : "GUARDAR CONFIGURACIÓN DE RAM"}
              </button>
            </form>
          )}
        </section>

        <section className="instance-settings-section">
          <div className="instance-settings-section-title">
            <span aria-hidden="true">⚙</span>
            <div>
              <h3>Perfil de juego de esta instalación</h3>
              <p>Estos valores no cambian la configuración global de Perfiles.</p>
            </div>
          </div>
          {ramSettings && (
            <div className="instance-profile-settings">
              <label className="instance-settings-toggle">
                <input
                  type="checkbox"
                  checked={ramSettings.useCustomResolution}
                  onChange={(event) =>
                    updateRamField("useCustomResolution", event.target.checked)
                  }
                  disabled={savingRam}
                />
                <span>
                  <strong>Usar resolución propia</strong>
                  <small>Desactívalo para heredar la resolución global.</small>
                </span>
              </label>
              <select
                className="text-input"
                value={ramSettings.resolution}
                disabled={!ramSettings.useCustomResolution || savingRam}
                onChange={(event) =>
                  updateRamField("resolution", event.target.value)
                }
                aria-label="Resolución de esta instalación"
              >
                <option value="default">Predeterminada</option>
                <option value="1280x720">1280 × 720</option>
                <option value="1600x900">1600 × 900</option>
                <option value="1920x1080">1920 × 1080</option>
              </select>

              <label className="instance-settings-toggle">
                <input
                  type="checkbox"
                  checked={ramSettings.useCustomJvmArgs}
                  onChange={(event) =>
                    updateRamField("useCustomJvmArgs", event.target.checked)
                  }
                  disabled={savingRam}
                />
                <span>
                  <strong>Usar argumentos JVM propios</strong>
                  <small>Solo argumentos adicionales; no reemplaza los del cargador.</small>
                </span>
              </label>
              <textarea
                className="text-input instance-jvm-args"
                value={ramSettings.jvmArgs}
                onChange={(event) =>
                  updateRamField("jvmArgs", event.target.value)
                }
                disabled={!ramSettings.useCustomJvmArgs || savingRam}
                placeholder="-XX:+UseG1GC"
                maxLength={2048}
                aria-label="Argumentos JVM de esta instalación"
              />
              <button
                className="primary-button full-button"
                type="button"
                onClick={handleSaveRam}
                disabled={savingRam}
              >
                GUARDAR PERFIL DE JUEGO
              </button>
            </div>
          )}
        </section>

        {error && (
          <p className="instance-settings-error" role="alert">{error}</p>
        )}

        {message && (
          <p className="feedback-message" role="status">{message}</p>
        )}

        <footer className="instance-settings-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={savingRam || changingLoader || renaming}
          >
            CERRAR
          </button>
        </footer>
      </section>
    </div>
  );
}

// ======================================================
// CUENTAS Y PERFILES
// ======================================================

function ProfilesPage({
  accountMode,
  accounts,
  activeAccount,
  accountsLoading,
  accountBusy,
  accountMessage,
  accountError,
  onAddAccount,
  onSelectAccount,
  onLogout,
  localProfiles,
  activeLocalProfile,
  localProfilesLoading,
  localProfileBusy,
  localProfileName,
  setLocalProfileName,
  localProfileMessage,
  localProfileError,
  onAddLocalProfile,
  onSelectLocalProfile,
  onDeleteLocalProfile
}) {
  return (
    <>
      <SectionHeading
        eyebrow="IDENTIDAD"
        title="Tus perfiles"
        description="Selecciona la cuenta o perfil que utilizarás para jugar desde esta ventana."
      />

      <div className="content-grid">
        <section className="panel profile-panel">
          <div className="panel-heading">
            <span className="eyebrow">
              {accountMode === "elyby" ? "CUENTA ELY.BY" : "CUENTA PREMIUM"}
            </span>
            <span className="status-pill">
              {activeAccount ? "CONECTADA" : "SIN CUENTA"}
            </span>
          </div>

          {activeAccount ? (
            <>
              <div className="profile-preview">
                <AccountAvatar account={activeAccount} />
                <div>
                  <h2>
                    {activeAccount.name ||
                      activeAccount.username ||
                      "Jugador"}
                  </h2>
                  <p>Cuenta de Minecraft Java</p>
                  {activeAccount.uuid && (
                    <p className="field-hint">
                      UUID: {activeAccount.uuid}
                    </p>
                  )}
                </div>
              </div>

              <button
                className="secondary-button full-button"
                type="button"
                onClick={() => onLogout(activeAccount.id)}
                disabled={accountBusy}
              >
                CERRAR SESIÓN
              </button>
            </>
          ) : (
            <div className="profile-preview">
              <div className="profile-avatar">E</div>
              <div>
                <h2>Sin cuenta conectada</h2>
                <p>Añade tu cuenta Microsoft.</p>
              </div>
            </div>
          )}

          <button
            className="primary-button full-button"
            type="button"
            onClick={onAddAccount}
            disabled={accountBusy}
          >
            {accountBusy ? "PROCESANDO..." : "+ AÑADIR CUENTA MICROSOFT"}
          </button>

          {accountsLoading && (
            <p className="field-hint">Cargando cuentas guardadas...</p>
          )}

          {accountError && (
            <p className="settings-error" role="alert">{accountError}</p>
          )}

          {accountMessage && (
            <p className="feedback-message" role="status">
              {accountMessage}
            </p>
          )}

          <div className="divider-line" />

          <div className="panel-heading">
            <span className="eyebrow">CUENTAS GUARDADAS</span>
            <span className="status-pill">{accounts.length}</span>
          </div>

          {accountsLoading ? (
            <p>Cargando cuentas...</p>
          ) : accounts.length === 0 ? (
            <p>Todavía no hay cuentas Microsoft guardadas.</p>
          ) : (
            <div className="account-list">
              {accounts.map((account) => {
                const isActive =
                  accountMode === "premium" &&
                  account.id === activeAccount?.id;

                const isStoredActive =
                  account.id === activeAccount?.id;

                const accountName =
                  account.name || account.username || "Jugador";

                return (
                  <article className="account-item" key={account.id}>
                    <div className="account-item-main">
                      <AccountAvatar account={account} />

                      <div className="account-item-details">
                        <strong>{accountName}</strong>
                        <span>
                          {isActive
                            ? "Seleccionada para jugar"
                            : isStoredActive
                              ? "Guardada · modo Premium inactivo"
                              : "Cuenta guardada"}
                        </span>
                      </div>
                    </div>

                    <button
                      className="status-pill status-pill-action"
                      type="button"
                      disabled={accountBusy}
                      title={
                        isActive
                          ? "Cuenta Microsoft seleccionada para jugar"
                          : "Seleccionar esta cuenta y activar Premium"
                      }
                      aria-label={`Usar la cuenta Microsoft ${accountName}`}
                      aria-pressed={isActive}
                      onClick={() => onSelectAccount(account.id)}
                    >
                      {isActive ? "ACTIVA" : "INACTIVA"}
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="panel info-panel">
          <div className="panel-heading">
            <span className="eyebrow">PERFILES LOCALES</span>
            <span className="status-pill">{localProfiles.length}</span>
          </div>

          <p>
            Crea nombres locales que podrás volver a seleccionar cuando
            abras ERYON.
          </p>

          {activeLocalProfile && (
            <div className="profile-preview">
              <div className="profile-avatar">
                {activeLocalProfile.name?.charAt(0).toUpperCase() || "E"}
              </div>

              <div>
                <h2>{activeLocalProfile.name}</h2>
                <p>
                  {accountMode === "local"
                    ? "Perfil seleccionado para jugar"
                    : "Perfil guardado · modo local inactivo"}
                </p>
              </div>
            </div>
          )}

          <div className="divider-line" />

          <form onSubmit={onAddLocalProfile}>
            <label
              className="field-label"
              htmlFor="local-profile-name"
            >
              NOMBRE DEL PERFIL
            </label>

            <input
              id="local-profile-name"
              className="text-input"
              value={localProfileName}
              onChange={(event) =>
                setLocalProfileName(event.target.value)
              }
              placeholder="Ejemplo: YoshiPlayer"
              minLength={3}
              maxLength={16}
              pattern="[A-Za-z0-9_]{3,16}"
              autoComplete="off"
              required
              disabled={localProfileBusy}
            />

            <p className="field-hint">
              Entre 3 y 16 caracteres: letras, números o _.
            </p>

            <button
              className="primary-button full-button"
              type="submit"
              disabled={localProfileBusy}
            >
              {localProfileBusy
                ? "PROCESANDO..."
                : "+ CREAR PERFIL LOCAL"}
            </button>
          </form>

          {localProfileError && (
            <p className="settings-error" role="alert">
              {localProfileError}
            </p>
          )}

          {localProfileMessage && (
            <p className="feedback-message" role="status">
              {localProfileMessage}
            </p>
          )}

          <div className="divider-line" />

          <div className="panel-heading">
            <span className="eyebrow">PERFILES GUARDADOS</span>
            <span className="status-pill">{localProfiles.length}</span>
          </div>

          {localProfilesLoading ? (
            <p>Cargando perfiles locales...</p>
          ) : localProfiles.length === 0 ? (
            <p>Todavía no has creado perfiles locales.</p>
          ) : (
            <div className="account-list">
              {localProfiles.map((profile) => {
                const isActive =
                  accountMode === "local" &&
                  profile.id === activeLocalProfile?.id;

                const isStoredActive =
                  profile.id === activeLocalProfile?.id;

                return (
                  <article className="account-item" key={profile.id}>
                    <div className="account-item-main">
                      <div className="profile-avatar">
                        {profile.name?.charAt(0).toUpperCase() || "E"}
                      </div>

                      <div className="account-item-details">
                        <strong>{profile.name}</strong>
                        <span>
                          {isActive
                            ? "Seleccionado para jugar"
                            : isStoredActive
                              ? "Guardado · modo local inactivo"
                              : "Perfil guardado"}
                        </span>
                      </div>
                    </div>

                    <div className="profile-actions">
                      <button
                        className="status-pill status-pill-action"
                        type="button"
                        disabled={localProfileBusy}
                        title={
                          isActive
                            ? "Perfil local seleccionado para jugar"
                            : "Seleccionar este perfil y activar el modo local"
                        }
                        aria-label={`Usar el perfil local ${profile.name}`}
                        aria-pressed={isActive}
                        onClick={() => onSelectLocalProfile(profile.id)}
                      >
                        {isActive ? "ACTIVO" : "INACTIVO"}
                      </button>

                      <button
                        className="secondary-button"
                        type="button"
                        disabled={localProfileBusy}
                        onClick={() => onDeleteLocalProfile(profile)}
                      >
                        Eliminar
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <div className="divider-line" />

          <span className="eyebrow">IMPORTANTE</span>

          <p className="field-hint">
            Los perfiles locales no verifican la propiedad de Minecraft Java.
            Utilízalos para jugar en solitario o en servidores que permitan
            conexiones sin autenticación.
          </p>
        </aside>
      </div>
    </>
  );
}

// ======================================================
// AVATAR
// ======================================================

function AccountAvatar({ account }) {
  const [failed, setFailed] = useState(false);

  const url = getAvatarUrl(account);
  const name = account?.name || account?.username || "Jugador";

  useEffect(() => {
    setFailed(false);
  }, [url]);

  return (
    <div className="profile-avatar account-avatar">
      {url && !failed ? (
        <img
          src={url}
          alt={`Avatar de ${name}`}
          onError={() => setFailed(true)}
        />
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </div>
  );
}

// ======================================================
// CONFIGURACIÓN GENERAL
// ======================================================

function SettingsPage({ appInfo }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [javaCheck, setJavaCheck] = useState(null);
  const [checkingJava, setCheckingJava] = useState(false);

  useEffect(() => {
    let active = true;

    async function loadSettings() {
      try {
        if (!window.eryon?.getSettings) {
          throw new Error(
            "No se pudo cargar la configuración. Reinicia Eryon Launcher e inténtalo de nuevo."
          );
        }

        const result = await window.eryon.getSettings();

        if (active) setSettings(result);
      } catch (loadError) {
        if (active) {
          setError(
            loadError.message ||
              "No se pudieron cargar los ajustes."
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadSettings();

    return () => {
      active = false;
    };
  }, []);

  function update(key, value) {
    setSettings((current) => ({
      ...current,
      [key]: value
    }));

    setMessage("");
    setError("");

    if (key === "javaPath") {
      setJavaCheck(null);
    }
  }

  async function selectDirectory() {
    try {
      const selected = await window.eryon.chooseGameDirectory();

      if (selected) update("gameDirectory", selected);
    } catch (selectError) {
      setError(
        selectError.message || "No se pudo seleccionar la carpeta."
      );
    }
  }

  async function selectJava() {
    try {
      const selected = await window.eryon.chooseJava();

      if (selected) update("javaPath", selected);
    } catch (selectError) {
      setError(
        selectError.message || "No se pudo seleccionar Java."
      );
    }
  }

  async function checkJava() {
    if (!window.eryon?.checkJava) {
      setError(
        "La función de comprobación de Java no está disponible."
      );
      return;
    }

    setCheckingJava(true);
    setJavaCheck(null);
    setMessage("");
    setError("");

    try {
      const result = await window.eryon.checkJava(settings.javaPath);
      setJavaCheck(result);
    } catch (checkError) {
      setError(
        checkError.message || "No se pudo comprobar la instalación de Java."
      );
    } finally {
      setCheckingJava(false);
    }
  }

  async function openDirectory() {
    try {
      await window.eryon.openGameDirectory();
    } catch (openError) {
      setError(
        openError.message || "No se pudo abrir la carpeta."
      );
    }
  }

  async function save() {
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const saved = await window.eryon.saveSettings(settings);
      setSettings(saved);

      document.body.classList.toggle(
        "eryon-lowend",
        saved?.lowEndMode === true
      );

      setMessage("Configuración guardada correctamente.");
    } catch (saveError) {
      setError(
        saveError.message || "No se pudo guardar la configuración."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="panel">
        <p>Cargando configuración...</p>
      </section>
    );
  }

  if (!settings) {
    return (
      <>
        <SectionHeading
          eyebrow="SISTEMA"
          title="Configuración"
          description="Ajustes de ERYON Launcher."
        />

        <section className="panel">
          <h3>No se pudo cargar la configuración</h3>
          <p className="settings-error">
            {error || "Reinicia Eryon Launcher e inténtalo de nuevo."}
          </p>
        </section>
      </>
    );
  }

  return (
    <>
      <SectionHeading
        eyebrow="SISTEMA"
        title="Configuración"
        description="Personaliza las preferencias de la aplicación y del juego."
      />

      <section className="panel settings-panel">
        <div className="panel-heading">
          <span className="eyebrow">MEMORIA</span>
          <span className="status-pill">{settings.ramGB} GB</span>
        </div>

        <label className="field-label" htmlFor="ram">
          RAM GLOBAL DEL LAUNCHER
        </label>

        <select
          id="ram"
          className="text-input"
          value={settings.ramGB}
          onChange={(event) =>
            update("ramGB", Number(event.target.value))
          }
        >
          {[2, 4, 6, 8, 12, 16].map((ram) => (
            <option key={ram} value={ram}>{ram} GB</option>
          ))}
        </select>

        <p className="field-hint">
          Las instalaciones que no tengan RAM personalizada utilizarán
          este valor global.
        </p>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.lowEndMode === true}
            onChange={(event) =>
              update("lowEndMode", event.target.checked)
            }
          />
          Modo para PC de gama baja
        </label>

        <p className="field-hint">
          Aligera el propio launcher (sin desenfoques, sombras ni
          animaciones) y usa menos memoria y un recolector de basura
          ligero (Serial GC) al iniciar Minecraft. Recomendado en equipos
          con 8 GB de RAM o menos; con este modo activo, elige 2 GB de
          RAM arriba salvo que sepas lo que haces.
        </p>

        <div className="divider-line" />

        <label className="field-label" htmlFor="resolution">
          RESOLUCIÓN DEL JUEGO
        </label>

        <select
          id="resolution"
          className="text-input"
          value={settings.resolution}
          onChange={(event) => update("resolution", event.target.value)}
        >
          <option value="default">Predeterminada</option>
          <option value="1280x720">1280 × 720</option>
          <option value="1600x900">1600 × 900</option>
          <option value="1920x1080">1920 × 1080</option>
        </select>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.fullscreen}
            onChange={(event) =>
              update("fullscreen", event.target.checked)
            }
          />
          Iniciar en pantalla completa
        </label>

        <div className="divider-line" />

        <label className="field-label" htmlFor="gameDirectory">
          DIRECTORIO GLOBAL DE MINECRAFT
        </label>

        <div className="settings-path">
          <input
            id="gameDirectory"
            className="text-input"
            value={settings.gameDirectory}
            readOnly
          />

          <button
            className="secondary-button"
            type="button"
            onClick={selectDirectory}
          >
            Elegir
          </button>

          <button
            className="secondary-button"
            type="button"
            onClick={openDirectory}
          >
            Abrir
          </button>
        </div>

        <div className="divider-line" />

        <label className="field-label" htmlFor="javaPath">
          EJECUTABLE DE JAVA
        </label>

        <div className="settings-path">
          <input
            id="javaPath"
            className="text-input"
            value={settings.javaPath}
            readOnly
            placeholder="Selecciona java.exe si lo necesitas"
          />

          <button
            className="secondary-button"
            type="button"
            onClick={selectJava}
          >
            Elegir
          </button>
        </div>

        <p className="field-hint">
          Puedes comprobar el ejecutable antes de iniciar Minecraft.
        </p>

        <div className="settings-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={checkJava}
            disabled={checkingJava}
          >
            {checkingJava ? "COMPROBANDO..." : "COMPROBAR JAVA"}
          </button>
        </div>

        {javaCheck && (
          <div className="notice-panel" role="status">
            <div className="notice-icon">✓</div>
            <div>
              <span className="eyebrow">RESULTADO DE JAVA</span>
              <h3>Java {javaCheck.major} detectado</h3>

              <p>
                <strong>Ejecutable:</strong> {javaCheck.path}
              </p>

              {javaCheck.requiredMajor != null && (
                <p>
                  Minecraft necesita Java {javaCheck.requiredMajor}.
                </p>
              )}

              {javaCheck.compatible === true && (
                <p className="feedback-message">
                  Java coincide con la versión requerida.
                </p>
              )}

              {javaCheck.compatible === false && (
                <p className="settings-error">
                  La versión detectada no coincide con la requerida.
                </p>
              )}

              {javaCheck.compatible === null && (
                <p className="field-hint">
                  No hay una versión de Minecraft guardada para compararla.
                </p>
              )}
            </div>
          </div>
        )}

        <label className="field-label settings-label" htmlFor="jvmArgs">
          ARGUMENTOS JVM ADICIONALES
        </label>

        <textarea
          id="jvmArgs"
          className="text-input settings-textarea"
          value={settings.jvmArgs}
          onChange={(event) => update("jvmArgs", event.target.value)}
          placeholder="Opcional"
          maxLength={2000}
        />

        <p className="field-hint">
          Un argumento incorrecto puede impedir que Minecraft arranque.
        </p>

        <div className="divider-line" />

        <div className="info-row">
          <span>Aplicación</span>
          <strong>ERYON Launcher</strong>
        </div>

        <div className="info-row">
          <span>Versión</span>
          <strong>{appInfo?.version ?? "—"}</strong>
        </div>

        <div className="info-row">
          <span>Sistema</span>
          <strong>{appInfo?.platform ?? "Desconocido"}</strong>
        </div>

        {error && (
          <p className="settings-error" role="alert">{error}</p>
        )}

        {message && (
          <p className="feedback-message" role="status">{message}</p>
        )}

        <button
          className="primary-button full-button"
          type="button"
          onClick={save}
          disabled={saving}
        >
          {saving ? "GUARDANDO..." : "GUARDAR CONFIGURACIÓN"}
        </button>
      </section>
    </>
  );
}

export default App;
