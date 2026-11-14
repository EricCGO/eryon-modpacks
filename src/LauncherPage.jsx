import { useEffect, useState } from "react";
import "./LauncherPage.css";

function LauncherPage() {
  // ====================================================
  // VERSIONES Y CONFIGURACIÓN
  // ====================================================

  const [versions, setVersions] = useState([]);
  const [version, setVersion] = useState("");
  const [settings, setSettings] = useState(null);
  const [loadingVersions, setLoadingVersions] = useState(true);

  // ====================================================
  // ESTADO DEL LANZAMIENTO
  // ====================================================

  const [launching, setLaunching] = useState(false);
  const [runningAccountKeys, setRunningAccountKeys] = useState(
    () => new Set()
  );

  const [status, setStatus] = useState(
    "Preparado para instalar Minecraft."
  );

  const [error, setError] = useState("");
  const [logs, setLogs] = useState([]);

  const [download, setDownload] = useState({
    phase: "Preparando archivos",
    current: 0,
    total: 0,
    percent: 0
  });

  // ====================================================
  // MODO DE CUENTA
  //
  // premium = Cuenta Microsoft
  // local   = Perfil local
  // ====================================================

  const [launchMode, setLaunchMode] = useState("premium");

  // ====================================================
  // CUENTA PREMIUM ACTIVA
  // ====================================================

  const [activeAccount, setActiveAccount] = useState(null);
  const [accountLoading, setAccountLoading] = useState(true);

  // ====================================================
  // PERFILES LOCALES
  // ====================================================

  const [localProfiles, setLocalProfiles] = useState([]);
  const [selectedLocalProfileId, setSelectedLocalProfileId] =
    useState("");
  const [, setActiveLocalProfile] = useState(null);
  const [localProfilesLoading, setLocalProfilesLoading] =
    useState(true);
  const [profileError, setProfileError] = useState("");
  const [profileMessage, setProfileMessage] = useState("");

  // ====================================================
  // CARGA INICIAL Y EVENTOS DE MINECRAFT
  // ====================================================

  useEffect(() => {
    let mounted = true;
    let unsubscribe;

    async function loadLauncherData() {
      try {
        // -----------------------------------------------
        // 1. Recuperar ajustes
        // -----------------------------------------------

        let savedSettings = {};

        try {
          if (window.eryon?.getSettings) {
            savedSettings = await window.eryon.getSettings();
          }
        } catch (settingsError) {
          console.error(
            "No se pudieron recuperar los ajustes:",
            settingsError
          );
        }

        if (!mounted) return;

        setSettings(savedSettings);

        // -----------------------------------------------
        // 2. Consultar las versiones disponibles
        // -----------------------------------------------

        if (!window.eryon?.getVersions) {
          throw new Error(
            "No se encontró la función para consultar las versiones."
          );
        }

        const result = await window.eryon.getVersions();

        if (!mounted) return;

        const availableVersions = Array.isArray(result?.versions)
          ? result.versions
          : [];

        setVersions(availableVersions);

        const savedVersion = savedSettings?.selectedVersion;

        const savedVersionExists = availableVersions.some(
          (item) => item.id === savedVersion
        );

        const latestReleaseExists = availableVersions.some(
          (item) => item.id === result?.latestRelease
        );

        const initialVersion = savedVersionExists
          ? savedVersion
          : latestReleaseExists
            ? result.latestRelease
            : availableVersions[0]?.id || "";

        setVersion(initialVersion);

        // Guardar la versión inicial si hace falta.
        if (
          initialVersion &&
          initialVersion !== savedSettings?.selectedVersion
        ) {
          try {
            const updatedSettings =
              await window.eryon.saveSettings({
                selectedVersion: initialVersion
              });

            if (mounted) {
              setSettings(updatedSettings);
            }
          } catch (saveError) {
            console.error(
              "No se pudo guardar la versión inicial:",
              saveError
            );
          }
        }
      } catch (err) {
        if (mounted) {
          setError(
            err.message ||
              "No se pudieron consultar las versiones."
          );
        }
      } finally {
        if (mounted) {
          setLoadingVersions(false);
        }
      }

      // -----------------------------------------------
      // 3. Recuperar la cuenta Microsoft activa
      // -----------------------------------------------

      try {
        if (window.eryon?.getActiveAccount) {
          const account = await window.eryon.getActiveAccount();

          if (mounted) {
            setActiveAccount(account || null);
          }
        }
      } catch (accountError) {
        console.error(
          "No se pudo recuperar la cuenta activa:",
          accountError
        );

        if (mounted) {
          setActiveAccount(null);
        }
      } finally {
        if (mounted) {
          setAccountLoading(false);
        }
      }

      // -----------------------------------------------
      // 4. Recuperar los perfiles locales guardados
      // -----------------------------------------------

      try {
        if (window.eryon?.getLocalProfiles) {
          const result = await window.eryon.getLocalProfiles();

          if (!mounted) return;

          const profiles = Array.isArray(result?.profiles)
            ? result.profiles
            : [];

          const activeProfile =
            result?.activeProfile ||
            profiles.find(
              (profile) =>
                profile.id === result?.activeProfileId
            ) ||
            null;

          setLocalProfiles(profiles);
          setActiveLocalProfile(activeProfile);

          const initialProfileId =
            activeProfile?.id ||
            result?.activeProfileId ||
            profiles[0]?.id ||
            "";

          setSelectedLocalProfileId(initialProfileId);
        }
      } catch (localError) {
        console.error(
          "No se pudieron cargar los perfiles locales:",
          localError
        );

        if (mounted) {
          setProfileError(
            localError.message ||
              "No se pudieron cargar los perfiles locales."
          );
        }
      } finally {
        if (mounted) {
          setLocalProfilesLoading(false);
        }
      }
    }

    loadLauncherData();

    // -----------------------------------------------
    // 5. Escuchar eventos del proceso principal
    // -----------------------------------------------

    if (window.eryon?.onLaunchEvent) {
      unsubscribe = window.eryon.onLaunchEvent((event) => {
        if (!mounted || !event) return;

        if (event.type === "status") {
          setStatus(event.message || "Preparando Minecraft...");
          setError("");
        }

        if (event.type === "started") {
          setStatus(
            event.message || "Minecraft se ha iniciado."
          );

          setLaunching(false);
          if (event.gameAccountKey) {
            setRunningAccountKeys((current) =>
              new Set(current).add(event.gameAccountKey)
            );
          }
          setDownload((previous) => ({
            ...previous,
            percent: 100
          }));
        }

        if (event.type === "progress") {
          const data = event.data || {};

          const phase = String(
            data.type ||
              data.phase ||
              "Descargando archivos"
          );

          const current = Number(
            data.task ?? data.current ?? 0
          );

          const total = Number(data.total ?? 0);

          const validProgress =
            Number.isFinite(current) &&
            Number.isFinite(total) &&
            total > 0;

          const percent = validProgress
            ? Math.min(
                100,
                Math.round((current / total) * 100)
              )
            : 0;

          setDownload({
            phase,
            current: validProgress ? current : 0,
            total: validProgress ? total : 0,
            percent
          });

          if (validProgress) {
            setStatus(`${phase}: ${current} de ${total}`);
          } else {
            setStatus(`Preparando ${phase}...`);
          }
        }

        if (event.type === "download-status") {
          const data = event.data || {};

          const phase = String(
            data.type ||
              data.task ||
              "Descargando archivos"
          );

          setStatus(`${phase}: descargando...`);
        }

        if (event.type === "log") {
          setLogs((current) =>
            [...current, String(event.message || "")].slice(-12)
          );
        }

        if (event.type === "error") {
          setLaunching(false);
          if (event.gameAccountKey) {
            setRunningAccountKeys((current) => {
              const next = new Set(current);
              next.delete(event.gameAccountKey);
              return next;
            });
          }
          setError(event.message || "Se produjo un error.");
          setStatus("No se pudo completar el inicio.");
        }

        if (event.type === "closed") {
          setLaunching(false);
          if (event.gameAccountKey) {
            setRunningAccountKeys((current) => {
              const next = new Set(current);
              next.delete(event.gameAccountKey);
              return next;
            });
          }
          setStatus(event.message || "Minecraft se ha cerrado.");

          setDownload((previous) => ({
            ...previous,
            percent: 0
          }));
        }
      });
    }

    return () => {
      mounted = false;

      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, []);

  // ====================================================
  // CAMBIAR LA VERSIÓN
  // ====================================================

  async function handleVersionChange(event) {
    const nextVersion = event.target.value;

    setVersion(nextVersion);
    setError("");

    setSettings((previous) => ({
      ...(previous || {}),
      selectedVersion: nextVersion
    }));

    try {
      if (!window.eryon?.saveSettings) {
        throw new Error(
          "La función para guardar los ajustes no está disponible."
        );
      }

      const savedSettings = await window.eryon.saveSettings({
        selectedVersion: nextVersion
      });

      setSettings(savedSettings);
    } catch (err) {
      setError(
        `No se pudo guardar la versión: ${
          err.message || "error desconocido"
        }`
      );
    }
  }

  // ====================================================
  // CAMBIAR EL MODO PREMIUM / LOCAL
  // ====================================================

  function handleLaunchModeChange(event) {
    const nextMode = event.target.value;

    if (nextMode !== "premium" && nextMode !== "local") {
      return;
    }

    setLaunchMode(nextMode);
    setError("");
    setProfileError("");
    setProfileMessage("");

    if (nextMode === "premium") {
      setStatus("Modo Premium seleccionado.");
    } else {
      setStatus("Modo de perfil local seleccionado.");
    }
  }

  // ====================================================
  // SELECCIONAR UN PERFIL LOCAL
  // ====================================================

  async function handleLocalProfileChange(event) {
    const profileId = event.target.value;

    setSelectedLocalProfileId(profileId);
    setProfileError("");
    setProfileMessage("");
    setError("");

    const selectedProfile = localProfiles.find(
      (profile) => profile.id === profileId
    );

    if (selectedProfile) {
      setStatus(
        `Perfil local seleccionado: ${selectedProfile.name}.`
      );
    }

    if (!profileId) return;

    if (!window.eryon?.selectLocalProfile) {
      setProfileError(
        "La selección de perfiles locales no está disponible. " +
          "Reinicia Eryon Launcher e inténtalo de nuevo."
      );
      return;
    }

    try {
      const result =
        await window.eryon.selectLocalProfile(profileId);

      if (result === false || result?.success === false) {
        throw new Error(
          result?.message ||
            "No se pudo seleccionar el perfil local."
        );
      }

      setActiveLocalProfile(
        result?.profile ||
          result?.activeProfile ||
          selectedProfile ||
          null
      );

      setProfileMessage("Perfil local seleccionado.");
    } catch (err) {
      setProfileError(
        err.message ||
          "No se pudo guardar la selección del perfil."
      );
    }
  }

  // ====================================================
  // INICIAR MINECRAFT
  // ====================================================

  async function startGame() {
    if (!version || launching) return;

    setError("");
    setProfileError("");
    setProfileMessage("");

    // -----------------------------------------------
    // Preparar la selección de cuenta
    // -----------------------------------------------

    let launchSelection;

    if (launchMode === "premium") {
      if (accountLoading) {
        setError(
          "Espera a que termine de cargarse la cuenta Microsoft."
        );
        return;
      }

      if (!activeAccount) {
        setError(
          "No tienes una cuenta Microsoft activa. " +
            "Ve a Perfiles, añade tu cuenta y vuelve a intentarlo."
        );
        return;
      }

      launchSelection = {
        mode: "premium",
        accountId: activeAccount.id
      };
    } else {
      if (localProfilesLoading) {
        setError(
          "Espera a que terminen de cargarse los perfiles locales."
        );
        return;
      }

      if (!selectedLocalProfileId) {
        setError(
          "No has seleccionado un perfil local. " +
            "Ve a Perfiles y crea uno antes de continuar."
        );
        return;
      }

      const selectedProfile = localProfiles.find(
        (profile) => profile.id === selectedLocalProfileId
      );

      if (!selectedProfile) {
        setError(
          "El perfil seleccionado ya no está disponible. " +
            "Actualiza la lista de perfiles e inténtalo de nuevo."
        );
        return;
      }

      launchSelection = {
        mode: "local",
        profileId: selectedLocalProfileId
      };
    }

    const gameAccountKey =
      launchSelection.mode === "premium"
        ? `premium:${launchSelection.accountId}`
        : `local:${launchSelection.profileId}`;
    if (runningAccountKeys.has(gameAccountKey)) {
      setError("Esta cuenta ya tiene Minecraft abierto.");
      return;
    }

    if (!window.eryon?.launchMinecraft) {
      setError(
        "El lanzamiento no está disponible. " +
          "Reinicia Eryon Launcher e inténtalo de nuevo."
      );
      return;
    }

    // -----------------------------------------------
    // Preparar la interfaz de progreso
    // -----------------------------------------------

    setLaunching(true);
    setLogs([]);

    setStatus(
      launchMode === "premium"
        ? "Preparando Minecraft con la cuenta Microsoft..."
        : "Preparando Minecraft con el perfil local..."
    );

    setDownload({
      phase: "Preparando archivos",
      current: 0,
      total: 0,
      percent: 0
    });

    try {
      // Guardar la versión elegida antes del lanzamiento.
      if (window.eryon?.saveSettings) {
        await window.eryon.saveSettings({
          selectedVersion: version
        });
      }

      // Enviar el modo y, cuando corresponda, el ID del perfil.
      await window.eryon.launchMinecraft(
        version,
        launchSelection
      );
    } catch (err) {
      setError(
        err.message || "No se pudo iniciar Minecraft."
      );

      setStatus("No se pudo completar el inicio.");
      setLaunching(false);
    }
  }

  // ====================================================
  // ESTADO DEL BOTÓN
  // ====================================================

  const selectedLocalProfile = localProfiles.find(
    (profile) => profile.id === selectedLocalProfileId
  );

  const selectedGameAccountKey =
    launchMode === "premium"
      ? activeAccount?.id
        ? `premium:${activeAccount.id}`
        : ""
      : selectedLocalProfileId
        ? `local:${selectedLocalProfileId}`
        : "";
  const selectedAccountIsRunning =
    Boolean(selectedGameAccountKey) &&
    runningAccountKeys.has(selectedGameAccountKey);
  const isBusy = launching || selectedAccountIsRunning;

  const canLaunchWithSelectedProfile =
    launchMode === "premium"
      ? !accountLoading && Boolean(activeAccount)
      : !localProfilesLoading && Boolean(selectedLocalProfile);

  const buttonLabel = selectedAccountIsRunning
    ? "MINECRAFT EN EJECUCIÓN"
    : launching
      ? download.total > 0
        ? `DESCARGANDO ${download.phase.toUpperCase()} · ${download.percent}%`
        : "PREPARANDO MINECRAFT..."
      : loadingVersions
        ? "CARGANDO VERSIONES..."
        : launchMode === "local"
          ? "INSTALAR / JUGAR CON PERFIL LOCAL"
          : "INSTALAR / JUGAR CON MICROSOFT";

  // ====================================================
  // INTERFAZ
  // ====================================================

  return (
    <div className="launcher-page">
      {/* HERO */}

      <section className="launcher-hero">
        <div className="launcher-hero-copy">
          <span className="eyebrow">ERYON GAME CENTER</span>

          <h1>
            TU MUNDO.
            <br />
            <span>TUS REGLAS.</span>
          </h1>

          <p>
            Elige tu versión de Minecraft Java Edition y el perfil
            con el que quieres jugar desde ERYON.
          </p>
        </div>

        <img
          className="launcher-hero-logo"
          src={`${import.meta.env.BASE_URL}images/logo-hero.png`}
          alt=""
          aria-hidden="true"
        />
      </section>

      {/* PANEL PRINCIPAL */}

      <section className="launcher-install-panel">
        <div className="launcher-panel-heading">
          <div>
            <span className="eyebrow">JAVA EDITION</span>
            <h2>Preparar partida</h2>
          </div>

          <span className="launcher-pill">
            {launchMode === "premium" ? "PREMIUM" : "LOCAL"}
          </span>
        </div>

        {/* SELECTOR DE MODO */}

        <label className="field-label" htmlFor="launch-mode">
          MODO DE CUENTA
        </label>

        <select
          id="launch-mode"
          className="text-input"
          value={launchMode}
          onChange={handleLaunchModeChange}
          disabled={isBusy}
        >
          <option value="premium">Premium — Cuenta Microsoft</option>
          <option value="local">No Premium — Perfil local</option>
        </select>

        {/* INFORMACIÓN SEGÚN EL MODO */}

        {launchMode === "premium" ? (
          <div className="launcher-profile-card">
            <div className="launcher-info-row">
              <span>Cuenta Microsoft</span>
              <span>
                {accountLoading
                  ? "Cargando cuenta..."
                  : activeAccount
                    ? "Cuenta activa"
                    : "No conectada"}
              </span>
            </div>

            {activeAccount ? (
              <div className="launcher-info-row">
                <span>Jugador</span>
                <strong>
                  {activeAccount.name ||
                    activeAccount.username ||
                    "Jugador"}
                </strong>
              </div>
            ) : (
              <p className="field-hint">
                Para jugar en este modo, ve a Perfiles y añade una
                cuenta Microsoft con acceso a Minecraft Java Edition.
              </p>
            )}
          </div>
        ) : (
          <div className="launcher-profile-card">
            <label
              className="field-label"
              htmlFor="local-profile"
            >
              PERFIL LOCAL
            </label>

            {localProfilesLoading ? (
              <p className="field-hint">
                Cargando perfiles locales...
              </p>
            ) : localProfiles.length > 0 ? (
              <>
                <select
                  id="local-profile"
                  className="text-input"
                  value={selectedLocalProfileId}
                  onChange={handleLocalProfileChange}
                  disabled={isBusy || localProfilesLoading}
                >
                  {localProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>

                <div className="launcher-info-row">
                  <span>Nombre seleccionado</span>
                  <strong>
                    {selectedLocalProfile?.name || "Ninguno"}
                  </strong>
                </div>
              </>
            ) : (
              <p className="field-hint">
                Todavía no tienes perfiles locales. Ve a la sección
                Perfiles para crear uno y vuelve aquí para seleccionarlo.
              </p>
            )}

            <p className="field-hint">
              Los perfiles locales no verifican la propiedad de
              Minecraft Java. Este modo está destinado al juego de
              un jugador y a servidores que permiten conexiones sin
              autenticación oficial.
            </p>

            {profileError && (
              <div className="launcher-error" role="alert">
                <strong>No se pudo gestionar el perfil</strong>
                <p>{profileError}</p>
              </div>
            )}

            {profileMessage && (
              <p className="feedback-message" role="status">
                {profileMessage}
              </p>
            )}
          </div>
        )}

        {/* SELECTOR DE VERSIÓN */}

        <label
          className="field-label"
          htmlFor="minecraft-version"
        >
          VERSIÓN DE MINECRAFT
        </label>

        <select
          id="minecraft-version"
          className="text-input"
          value={version}
          onChange={handleVersionChange}
          disabled={loadingVersions || isBusy}
        >
          {loadingVersions && (
            <option value="">
              Consultando versiones...
            </option>
          )}

          {!loadingVersions && versions.length === 0 && (
            <option value="">
              No hay versiones disponibles
            </option>
          )}

          {versions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id}
              {item.id === versions[0]?.id
                ? " — reciente"
                : ""}
            </option>
          ))}
        </select>

        {/* INFORMACIÓN DEL LANZAMIENTO */}

        <div className="launcher-info-row">
          <span>Directorio del juego</span>
          <span>
            {settings?.gameDirectory
              ? "Configuración guardada"
              : "Configuración de ERYON"}
          </span>
        </div>

        <div className="launcher-info-row">
          <span>Autenticación</span>
          <span>
            {launchMode === "premium"
              ? "Microsoft"
              : "Perfil local"}
          </span>
        </div>

        <div className="launcher-info-row">
          <span>Perfil de lanzamiento</span>
          <span>
            {launchMode === "premium"
              ? activeAccount?.name ||
                activeAccount?.username ||
                "Sin cuenta"
              : selectedLocalProfile?.name || "Sin perfil"}
          </span>
        </div>

        {/* BOTÓN DE JUGAR */}

        <button
          className={`primary-button launcher-play-button ${
            launching ? "is-downloading" : ""
          }`}
          type="button"
          onClick={startGame}
          disabled={
            loadingVersions ||
            !version ||
            launching ||
            selectedAccountIsRunning ||
            versions.length === 0 ||
            !canLaunchWithSelectedProfile
          }
          aria-label={
            launching
              ? `${buttonLabel}. ${download.current} de ${download.total}`
              : buttonLabel
          }
        >
          {launching && (
            <span
              className="button-progress-fill"
              style={{
                width: `${download.percent}%`
              }}
            />
          )}

          <span className="button-content">
            <span className="button-main-label">
              {buttonLabel}
            </span>

            {launching && download.total > 0 && (
              <span className="button-progress-details">
                {download.phase.toUpperCase()} ·{" "}
                {download.current.toLocaleString("es-CO")} /{" "}
                {download.total.toLocaleString("es-CO")} archivos
              </span>
            )}

            {launching && download.total <= 0 && (
              <span className="button-progress-details">
                Conectando, comprobando e instalando recursos
              </span>
            )}
          </span>
        </button>

        {/* ESTADO */}

        <div
          className="launcher-status"
          role="status"
          aria-live="polite"
        >
          <span
            className={`launcher-status-dot ${
              isBusy ? "busy" : ""
            }`}
          />

          <span>{status}</span>
        </div>

        {/* ERRORES */}

        {error && (
          <div className="launcher-error" role="alert">
            <strong>No se pudo continuar</strong>
            <p>{error}</p>
          </div>
        )}

        {/* REGISTROS TÉCNICOS */}

        {logs.length > 0 && (
          <details className="launcher-logs">
            <summary>Detalles técnicos</summary>

            <div>
              {logs.map((line, index) => (
                <p key={`${index}-${line}`}>{line}</p>
              ))}
            </div>
          </details>
        )}
      </section>

      {/* AVISO FINAL */}

      <p className="launcher-disclaimer">
        La primera instalación requiere conexión a internet y puede
        tardar. El modo Premium requiere una cuenta Microsoft con acceso
        a Minecraft Java Edition. El modo local no sustituye la
        autenticación oficial necesaria para entrar en servidores que
        la exigen. Esta pantalla instala versiones vanilla de Minecraft;
        para Forge, Fabric o modpacks ya preparados, usa la sección
        Modpacks.
      </p>
    </div>
  );
}

export default LauncherPage;
