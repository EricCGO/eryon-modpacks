
// ======================================================
// FIREBASE — CARGA DIFERIDA (LANZA LIGERO)
// ======================================================
// El SDK de Firebase (~150 KB comprimido y varios MB en memoria
// después de cargarlo) solo tiene sentido si se usa el Satélite.
// Se importa dinámicamente en el momento de conectar: el arranque
// del launcher no paga ni el parseo ni la memoria del SDK.

// ======================================================
// ESTADO GLOBAL DEL MÓDULO
// ======================================================

let sdk = null;
let database = null;
let identity = null;
let presenceUnsub = null;
const gamePresenceKeys = new Set();

async function loadFirebaseSdk() {
  if (sdk) {
    return sdk;
  }

  const [appModule, databaseModule] = await Promise.all([
    import("firebase/app"),
    import("firebase/database")
  ]);

  sdk = {
    app: appModule,
    database: databaseModule
  };

  return sdk;
}

function requireSdk() {
  if (!sdk) {
    throw new Error(
      "Firebase no está configurado. Abre el Satélite y sigue los pasos de configuración."
    );
  }

  return sdk;
}

function requireDatabase() {
  if (!database) {
    throw new Error(
      "Firebase no está configurado. Abre el Satélite y sigue los pasos de configuración."
    );
  }

  return database;
}

// ======================================================
// IDENTIFICADORES SEGUROS PARA LA BASE DE DATOS
// ======================================================

export function nameKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .slice(0, 32);
}

export function chatPathFor(userKeyA, userKeyB) {
  return [userKeyA, userKeyB].sort().join("__");
}

// ======================================================
// CONFIGURACIÓN Y CONEXIÓN
// ======================================================

/**
 * Inicializa Firebase con la configuración guardada.
 * config = { apiKey, databaseURL, projectId, appId }
 *
 *Descarga y activa el SDK la primera vez (import dinamico); las
 * siguientes llamadas reutilizan la app ya inicializada.
 */
export async function connectFirebase(config) {
  if (!config?.apiKey || !config?.databaseURL) {
    throw new Error(
      "La configuración de Firebase está incompleta."
    );
  }

  const { app: appModule, database: databaseModule } =
    await loadFirebaseSdk();

  const current = appModule.getApps()[0];

  const app =
    current || appModule.initializeApp(config);

  database = databaseModule.getDatabase(app);

  return database;
}

export function isFirebaseReady() {
  return Boolean(database);
}

// ======================================================
// IDENTIDAD Y PRESENCIA (ONLINE / OFFLINE)
// ======================================================

/**
 * Registra al usuario en /users y activa la presencia.
 * Debe llamarse tras conectar y cada vez que cambie el perfil.
 */
export function registerIdentity({ name, uuid }) {
  const { database: databaseModule } = requireSdk();
  const db = requireDatabase();

  const { ref, onValue, set, update, onDisconnect } =
    databaseModule;

  if (presenceUnsub) {
    presenceUnsub();
    presenceUnsub = null;
  }

  const key = nameKey(name);

  identity = {
    key,
    name: String(name || "Jugador"),
    uuid: uuid ? String(uuid) : ""
  };

  // Perfil público visible para otros usuarios del launcher.
  update(ref(db, `users/${key}`), {
    name: identity.name,
    uuid: identity.uuid,
    app: "eryon"
  }).catch(() => {});

  // Presencia: true mientras el launcher está abierto.
  const presenceRef = ref(db, `presence/${key}`);
  const connectedRef = ref(db, ".info/connected");
  const lastSeenRef = ref(db, `users/${key}/lastSeen`);

  const lastSeenInterval = setInterval(() => {
    set(lastSeenRef, Date.now()).catch(() => {});
  }, 30000);

  set(lastSeenRef, Date.now()).catch(() => {});

  const offConnected = onValue(connectedRef, (snapshot) => {
    if (snapshot.val() === true) {
      onDisconnect(presenceRef)
        .set(null)
        .then(() => set(presenceRef, true))
        .catch(() => {});
    }
  });

  presenceUnsub = () => {
    clearInterval(lastSeenInterval);
    offConnected();

    // El .info/connected se dispara al reabrir sesión, pero el
    // listener retirado ya no actualizará presencia: la apagamos.
    set(presenceRef, null).catch(() => {});
    set(lastSeenRef, Date.now()).catch(() => {});
    presenceUnsub = null;
  };

  return identity;
}

export function currentIdentity() {
  return identity;
}

export async function setGamePresence({ name, uuid, playing }) {
  const { database: databaseModule } = requireSdk();
  const db = requireDatabase();
  const { ref, set, remove, onDisconnect } = databaseModule;

  if (!playing) {
    const key = nameKey(name);
    if (key) {
      if (!gamePresenceKeys.delete(key)) return;
      await remove(ref(db, `gamePresence/${key}`));
      return;
    }

    await Promise.all(
      [...gamePresenceKeys].map((currentKey) =>
        remove(ref(db, `gamePresence/${currentKey}`))
      )
    );
    gamePresenceKeys.clear();
    return;
  }

  const playerName = String(name || identity?.name || "").trim();
  const key = nameKey(playerName);
  if (!key) {
    throw new Error("No se pudo determinar el perfil para compartir presencia.");
  }

  const playerRef = ref(db, `gamePresence/${key}`);
  await onDisconnect(playerRef).remove();
  await set(playerRef, {
    name: playerName,
    uuid: String(uuid || identity?.uuid || ""),
    app: "eryon",
    playing: true,
    since: Date.now()
  });
  gamePresenceKeys.add(key);
}

// ======================================================
// USUARIOS
// ======================================================

export async function lookupUser(nickname) {
  const { database: databaseModule } = requireSdk();
  const { ref, get } = databaseModule;
  const db = requireDatabase();

  const snapshot = await get(ref(db, `users/${nameKey(nickname)}`));

  return snapshot.val();
}

export async function lookupPresence(userKey) {
  const { database: databaseModule } = requireSdk();
  const { ref, get } = databaseModule;
  const db = requireDatabase();

  const snapshot = await get(ref(db, `presence/${userKey}`));

  return snapshot.val() === true;
}

export function subscribePresence(userKey, callback) {
  const { database: databaseModule } = requireSdk();
  const { ref, onValue } = databaseModule;
  const db = requireDatabase();

  return onValue(ref(db, `presence/${userKey}`), (snapshot) => {
    callback(snapshot.val() === true);
  });
}

// ======================================================
// SOLICITUDES Y LISTA DE AMIGOS
// ======================================================

/**
 * Devuelve la lista de amigos y solicitudes de un usuario.
 * Estructura:
 *   friends/{key}/list/{friendKey}  = { name, uuid }
 *   friends/{key}/requests/{fromKey} = { name, uuid, at }
 */
export function subscribeFriends(userKey, callback, onError) {
  const { database: databaseModule } = requireSdk();
  const { ref, get, onValue } = databaseModule;
  const db = requireDatabase();
  const friendsRef = ref(db, `friends/${userKey}`);

  // Carga inicial explícita. En algunas instalaciones de Electron el
  // listener en tiempo real puede tardar en abrir el canal, pero la lectura
  // puntual sí responde inmediatamente.
  get(friendsRef)
    .then((snapshot) => {
      callback(snapshot.val() || { list: {}, requests: {} });
    })
    .catch((error) => {
      if (typeof onError === "function") onError(error);
    });

  return onValue(friendsRef, (snapshot) => {
    callback(snapshot.val() || { list: {}, requests: {} });
  }, (error) => {
    if (typeof onError === "function") {
      onError(error);
    }
  });
}

export async function sendFriendRequest({
  fromName,
  fromUuid,
  targetName
}) {
  const { database: databaseModule } = requireSdk();
  const { ref, update, get } = databaseModule;
  const db = requireDatabase();

  const fromKey = nameKey(fromName);
  const targetKey = nameKey(targetName);

  if (!fromKey || !targetKey || fromKey === targetKey) {
    throw new Error("Escribe el nombre de otro jugador.");
  }

  const targetSnapshot = await get(
    ref(db, `users/${targetKey}`)
  );

  const target = targetSnapshot.val();

  if (!target) {
    throw new Error(
      `El usuario "${targetName}" no se ha conectado nunca a Eryon.` +
        " Ambos deben abrir el launcher para agregarse."
    );
  }

  // Se avisa al otro usuario.
  await update(ref(db, `friends/${targetKey}/requests/${fromKey}`), {
    name: String(fromName),
    uuid: fromUuid ? String(fromUuid) : "",
    at: Date.now()
  });

  return target;
}

export async function acceptFriendRequest({
  userKey,
  userUuid,
  requestKey
}) {
  const { database: databaseModule } = requireSdk();
  const { ref, get, update, remove } = databaseModule;
  const db = requireDatabase();

  const friendData = await get(ref(db, `users/${requestKey}`));

  const friend = friendData.val();

  if (!friend) {
    throw new Error(
      "No se pudo aceptar la solicitud: el usuario no existe."
    );
  }

  await update(ref(db, `friends/${userKey}/list/${requestKey}`), {
    name: friend.name || requestKey,
    uuid: friend.uuid || "",
    since: Date.now()
  });

  await update(ref(db, `friends/${requestKey}/list/${userKey}`), {
    name: identity?.name || userKey.replace(/_/g, ""),
    uuid: userUuid || identity?.uuid || "",
    since: Date.now()
  });

  await remove(
    ref(db, `friends/${userKey}/requests/${requestKey}`)
  );
}

export async function denyFriendRequest(userKey, requestKey) {
  const { database: databaseModule } = requireSdk();
  const { ref, remove } = databaseModule;
  const db = requireDatabase();

  await remove(
    ref(db, `friends/${userKey}/requests/${requestKey}`)
  );
}

export async function removeFriend(userKey, friendKey) {
  const { database: databaseModule } = requireSdk();
  const { ref, remove } = databaseModule;
  const db = requireDatabase();

  await remove(ref(db, `friends/${userKey}/list/${friendKey}`));
  await remove(ref(db, `friends/${friendKey}/list/${userKey}`));
}

// ======================================================
// MENSAJES PRIVADOS
// ======================================================

function messageQueryFor(chatPath, listener, onError) {
  const { database: databaseModule } = requireSdk();
  const { ref, get, onValue } = databaseModule;
  const db = requireDatabase();

  const messagesRef = ref(db, `chats/${chatPath}/messages`);

  const readMessages = (snapshot) => {
    const data = snapshot.val() || {};

    const messages = Object.entries(data).map(
      ([id, message]) => ({
        id,
        from: message?.from || "",
        text: String(message?.text || ""),
        at: Number(message?.at) || 0
      })
    );

    messages.sort((a, b) => a.at - b.at);
    listener(messages);
  };

  get(messagesRef).then(readMessages).catch((error) => {
    if (typeof onError === "function") onError(error);
  });

  return onValue(messagesRef, readMessages, onError);
}

/** Escucha el historial de chat entre dos usuarios. */
export function subscribeMessages(userKeyA, userKeyB, listener, onError) {
  if (!database) {
    listener([]);
    return () => {};
  }

  return messageQueryFor(
    chatPathFor(userKeyA, userKeyB),
    listener,
    onError
  );
}

export async function sendMessage(userKeyA, userKeyB, text) {
  const { database: databaseModule } = requireSdk();
  const { ref, push } = databaseModule;
  const db = requireDatabase();

  const clean = String(text || "").trim();

  if (!clean) return;

  await push(
    ref(db, `chats/${chatPathFor(userKeyA, userKeyB)}/messages`),
    {
      from: identity?.key || nameKey(identity?.name),
      fromName: identity?.name || "",
      text: clean.slice(0, 500),
      at: Date.now()
    }
  );
}

/** Cierra la presencia al desmontar la app. */
export function disposePresence() {
  if (presenceUnsub) {
    presenceUnsub();
  }

  identity = null;
  database = null;
}
