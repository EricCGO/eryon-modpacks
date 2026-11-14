
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  nameKey,
  subscribeFriends,
  subscribeMessages,
  subscribePresence,
  sendMessage,
  sendFriendRequest,
  acceptFriendRequest,
  denyFriendRequest,
  removeFriend
} from "../lib/firebase";
import "./SatellitePanel.css";

// ======================================================
// FUNCIONES AUXILIARES
// ======================================================

function avatarUrl(name, uuid) {
  if (uuid) {
    return `https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/100`;
  }

  if (name) {
    return `https://mc-heads.net/avatar/${encodeURIComponent(name)}/100`;
  }

  return "";
}

function formatTime(timestamp) {
  if (!timestamp) return "";

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ======================================================
// AVATAR DE JUGADOR
// ======================================================

function Avatar({ friend, size }) {
  const [failed, setFailed] = useState(false);

  const url = avatarUrl(friend.name, friend.uuid);

  return (
    <div
      className="sat-avatar"
      style={{ width: size, height: size }}
    >
      {url && !failed ? (
        <img
          src={url}
          alt={`Avatar de ${friend.name}`}
          onError={() => setFailed(true)}
        />
      ) : (
        (friend.name || "?").charAt(0).toUpperCase()
      )}
    </div>
  );
}

// ======================================================
// SECCIÓN DE LISTA CON TÍTULO
// ======================================================

function FriendsSection({ title, empty, children }) {
  const hasItems = Array.isArray(children)
    ? children.length
      ? children
      : false
    : Boolean(children);

  return (
    <section className="sat-section">
      <div className="sat-section-title">
        <span>{title}</span>
      </div>

      {hasItems ? children : (
        <p className="sat-empty">{empty}</p>
      )}
    </section>
  );
}

// ======================================================
// ÁREA DE CHAT
// ======================================================

function ChatArea({
  ownKey,
  friend,
  messages,
  draft,
  setDraft,
  sending,
  onSend,
  bottomRef,
  onBack
}) {
  return (
    <>
      <header className="sat-chat-header">
        <button
          type="button"
          className="sat-icon-button"
          title="Volver a la lista de amigos"
          onClick={onBack}
        >
          ‹
        </button>

        <Avatar friend={friend} size={30} />
        <strong>{friend.name}</strong>
      </header>

      <div className="sat-messages">
        {messages.length === 0 && (
          <p className="sat-empty">
            Sin mensajes con {friend.name}. Envíale el primero:
            aparecerá en su Satélite al instante.
          </p>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`sat-message ${
              message.from === ownKey ? "mine" : ""
            }`}
          >
            <div className="sat-bubble">
              <p>{message.text}</p>
              <span className="sat-time">
                {formatTime(message.at)}
              </span>
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      <form className="sat-composer" onSubmit={onSend}>
        <input
          className="text-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Mensaje para ${friend.name}…`}
          maxLength={500}
          autoComplete="off"
        />

        <button
          className="sat-send-button"
          type="submit"
          disabled={sending || !draft.trim()}
          title="Enviar mensaje"
        >
          ➤
        </button>
      </form>
    </>
  );
}

// ======================================================
// VENTANA SATELITE PRINCIPAL
// ======================================================

export default function SatellitePanel({
  identityName,
  identityUuid,
  open,
  onClose,
  onOpenFirebaseSetup,
  firebaseConnected,
  firebaseError
}) {
  // Pestaña visible: "friends" (lista) o "chats" (conversación).
  const [tab, setTab] = useState("friends");
  const [activeChat, setActiveChat] = useState(null);

  const [friendsData, setFriendsData] = useState({
    list: {},
    requests: {}
  });
  const [friendsError, setFriendsError] = useState("");

  const [presenceMap, setPresenceMap] = useState({});
  const [messages, setMessages] = useState([]);

  const [search, setSearch] = useState("");
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const [unread, setUnread] = useState({});
  const [position, setPosition] = useState({ x: null, y: null });

  const dragRef = useRef(null);
  const messagesBottomRef = useRef(null);
  const activeChatRef = useRef(null);
  const baselineRef = useRef({});

  activeChatRef.current = activeChat;

  const userKey = useMemo(
    () => (identityName ? nameKey(identityName) : ""),
    [identityName]
  );

  // ====================================================
  // LISTA DE AMIGOS EN TIEMPO REAL
  // ====================================================

  useEffect(() => {
    if (!open || !firebaseConnected || !userKey) {
      setFriendsData({ list: {}, requests: {} });
      setFriendsError("");
      return;
    }

    let unsubscribe;

    try {
      unsubscribe = subscribeFriends(
        userKey,
        (data) => {
          setFriendsData({
            list: data?.list || {},
            requests: data?.requests || {}
          });
          setFriendsError("");
        },
        (error) => {
          const message = String(error?.message || "");

          setFriendsError(
            message.toLowerCase().includes("permission") ||
            message.toLowerCase().includes("denied")
              ? "Firebase rechazó el acceso a tus amigos. Revisa las reglas de Realtime Database."
              : `No se pudo cargar la lista de amigos: ${message || "error de conexión"}.`
          );
        }
      );
    } catch (error) {
      setFriendsError(
        error?.message || "No se pudo conectar con la lista de amigos."
      );
    }

    return () => unsubscribe?.();
  }, [open, firebaseConnected, userKey]);

  // ====================================================
  // PRESENCIA (ONLINE) DE CADA AMIGO
  // ====================================================

  useEffect(() => {
    if (!open || !firebaseConnected || !friendsData) {
      return;
    }

    const friendKeys = Object.keys(friendsData.list || {});

    if (friendKeys.length === 0) {
      setPresenceMap({});
      return;
    }

    setPresenceMap((current) =>
      friendKeys.reduce((next, key) => {
        next[key] = current[key] === true;
        return next;
      }, {})
    );

    const unsubscribers = friendKeys.map((friendKey) =>
      subscribePresence(friendKey, (online) => {
        setPresenceMap((current) => ({
          ...current,
          [friendKey]: online === true
        }));
      })
    );

    return () => unsubscribers.forEach((fn) => fn());
  }, [open, firebaseConnected, friendsData]);

  // ====================================================
  // MENSAJES DEL CHAT ABIERTO + CONTADOR DE NO LEÍDOS
  // ====================================================

  useEffect(() => {
    if (!open || !firebaseConnected || !userKey) {
      setMessages([]);
      setUnread({});
      baselineRef.current = {};
      return;
    }

    const friendKeys = Object.keys(friendsData?.list || {});

    if (friendKeys.length === 0) {
      setMessages([]);
      setUnread({});
      return;
    }

    const unsubscribers = friendKeys.map((friendKey) =>
      subscribeMessages(userKey, friendKey, (list) => {
        // Base de referencia: el historial que había al abrir el
        // satélite cuenta como leído.
        if (baselineRef.current[friendKey] === undefined) {
          baselineRef.current[friendKey] = list.length;
        }

        // Chat abierto: se considera todo leído y se anota la base.
        if (activeChatRef.current?.key === friendKey) {
          baselineRef.current[friendKey] = list.length;

          setMessages(list);

          setUnread((current) => {
            if (!current[friendKey]) return current;

            const next = { ...current };
            delete next[friendKey];

            return next;
          });

          return;
        }

        const baseline = baselineRef.current[friendKey];
        const pending = Math.max(0, list.length - baseline);

        if (pending === 0) return;

        setUnread((current) => ({
          ...current,
          [friendKey]: pending
        }));
      }, (error) => {
        setFriendsError(
          error?.message || "No se pudo cargar el historial del chat."
        );
      })
    );

    return () => unsubscribers.forEach((fn) => fn());
  }, [open, firebaseConnected, userKey, friendsData, activeChat?.key]);

  // Desplazar los mensajes hasta el último.

  useEffect(() => {
    if (!open || !activeChat) return;

    messagesBottomRef.current?.scrollIntoView({
      block: "end"
    });
  }, [messages, open, activeChat]);

  // ====================================================
  // ARRASTRAR LA VENTANA
  // ====================================================

  const onDragStart = useCallback((event) => {
    const panel = dragRef.current;

    if (!panel || event.button !== 0 || event.target.closest("button, input, textarea, details")) {
      return;
    }

    const rect = panel.getBoundingClientRect();
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;

    function onMove(moveEvent) {
      setPosition({
        x: Math.max(8, moveEvent.clientX - startX),
        y: Math.max(8, moveEvent.clientY - startY)
      });
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // ====================================================
  // ACCIONES DE AMISTAD
  // ====================================================

  async function handleAddFriend(event) {
    event.preventDefault();

    const target = addName.trim();

    setAddError("");

    if (!target) return;

    setAddBusy(true);

    try {
      await sendFriendRequest({
        fromName: identityName,
        fromUuid: identityUuid,
        targetName: target
      });

      setAddName("");
    } catch (error) {
      setAddError(error.message || "No se pudo enviar la solicitud.");
    } finally {
      setAddBusy(false);
    }
  }

  function openChat(key, entry) {
    const friend = {
      key,
      name: entry?.name || key,
      uuid: entry?.uuid || ""
    };

    setMessages([]);
    setActiveChat(friend);
    setTab("chats");
  }

  async function handleAccept(requestKey) {
    try {
      await acceptFriendRequest({
        userKey,
        userUuid: identityUuid,
        requestKey
      });
    } catch (error) {
      setFriendsError(error.message || "No se pudo aceptar la solicitud.");
    }
  }

  async function handleDeny(requestKey) {
    try {
      await denyFriendRequest(userKey, requestKey);
    } catch (error) {
      setFriendsError(error.message || "No se pudo rechazar la solicitud.");
    }
  }

  async function handleRemove(friendKey, friendName) {
    if (!window.confirm(`¿Quieres eliminar a ${friendName} de tus amigos?`)) {
      return;
    }

    if (activeChat?.key === friendKey) {
      setActiveChat(null);
      setTab("friends");
    }

    try {
      await removeFriend(userKey, friendKey);
    } catch (error) {
      setFriendsError(error.message || "No se pudo eliminar el amigo.");
    }
  }

  async function handleSend(event) {
    event.preventDefault();

    const text = draft.trim();

    if (!text || !activeChat || sending) return;

    setSending(true);

    try {
      await sendMessage(userKey, activeChat.key, text);
      setDraft("");
    } catch (error) {
      setAddError(error.message || "No se pudo enviar el mensaje.");
    } finally {
      setSending(false);
    }
  }

  // ====================================================
  // DERIVADOS PARA EL RENDER
  // ====================================================

  const requests = Object.entries(friendsData?.requests || {});
  const friends = Object.entries(friendsData?.list || {}).map(
    ([key, entry]) => ({
      key,
      name: entry?.name || key,
      uuid: entry?.uuid || "",
      online: presenceMap[key] === true
    })
  );

  const onlineFriends = friends
    .filter((friend) => friend.online)
    .sort((a, b) =>
      a.name.localeCompare(b.name, "es", { sensitivity: "base" })
    );

  const offlineFriends = friends
    .filter((friend) => !friend.online)
    .sort((a, b) =>
      a.name.localeCompare(b.name, "es", { sensitivity: "base" })
    );

  const filter = search.trim().toLowerCase();

  const visibleRequests = requests.filter(([, entry]) =>
    String(entry?.name || "").toLowerCase().includes(filter)
  );

  const visibleOnline = onlineFriends.filter((friend) =>
    friend.name.toLowerCase().includes(filter)
  );

  const visibleOffline = offlineFriends.filter((friend) =>
    friend.name.toLowerCase().includes(filter)
  );

  const totalUnread = Object.values(unread).reduce(
    (sum, count) => sum + (count || 0),
    0
  );

  if (!open) {
    return null;
  }

  function FriendRow({ friend }) {
    return (
      <div className="sat-friend-row">
        <span
          className={`sat-presence ${friend.online ? "online" : ""}`}
        />

        <Avatar friend={friend} size={34} />

        <button
          className="sat-friend-main"
          type="button"
          onClick={() => openChat(friend.key, friend)}
        >
          <strong>{friend.name}</strong>
          <span>
            {friend.online ? "En línea" : "Desconectado"}
          </span>
        </button>

        {unread[friend.key] ? (
          <span className="sat-badge">{unread[friend.key]}</span>
        ) : null}

        <button
          className="sat-friend-remove"
          type="button"
          title={`Eliminar a ${friend.name}`}
          onClick={() => handleRemove(friend.key, friend.name)}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div
      className="sat-panel"
      ref={dragRef}
      style={
        position.x != null
          ? { left: position.x, top: position.y, right: "auto" }
          : undefined
      }
    >
      {/* Barra superior de la ventana */}

      <header className="sat-header" onMouseDown={onDragStart}>
        <div className="sat-title">
          <span className="sat-logo">E</span>
          <strong>Satélite</strong>

          <span
            className={`sat-connection ${
              firebaseConnected ? "ok" : ""
            }`}
            title={
              firebaseConnected
                ? "Conectado a Eryon Satélite"
                : "Sin conexión"
            }
          />
        </div>

        <div className="sat-header-actions">
          <button
            type="button"
            className="sat-icon-button"
            title="Cerrar Satélite"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>

      {!firebaseConnected ? (
        <div className="sat-setup">
          <span className="eyebrow">CONEXIÓN PENDIENTE</span>
          <h3>Conecta tu Satélite</h3>
          <p>
            Para ver a tus amigos y enviarles mensajes hay que conectar
            Eryon con Firebase Realtime Database. Solo el desarrollador
            del launcher necesita hacerlo una vez.
          </p>

          {firebaseError && (
            <p className="sat-error" role="alert">
              Error de conexión: {firebaseError}
            </p>
          )}

          <button
            className="primary-button full-button"
            type="button"
            onClick={onOpenFirebaseSetup}
          >
            CONFIGURAR CONEXIÓN
          </button>
        </div>
      ) : (
        <>
          {/* Pestañas principales */}

          <div className="sat-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "friends"}
              className={`sat-tab ${
                tab === "friends" ? "active" : ""
              }`}
              onClick={() => {
                setTab("friends");
                setActiveChat(null);
              }}
            >
              Amigos

              {requests.length > 0 && (
                <span className="sat-badge">{requests.length}</span>
              )}

              {totalUnread > 0 && (
                <span className="sat-badge solid">{totalUnread}</span>
              )}
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={tab === "chats"}
              className={`sat-tab ${
                tab === "chats" ? "active" : ""
              }`}
              onClick={() => setTab("chats")}
            >
              Chats
            </button>
          </div>

          {friendsError && (
            <p className="sat-error" role="alert">{friendsError}</p>
          )}

          {/* Pestaña: LISTA DE AMIGOS */}

          {tab === "friends" && (
            <div className="sat-friends">
              <div className="sat-friends-toolbar">
                <form
                  className="sat-add-form"
                  onSubmit={handleAddFriend}
                >
                  <input
                    className="text-input"
                    value={addName}
                    onChange={(event) => setAddName(event.target.value)}
                    placeholder="Agrega con el nombre de Minecraft…"
                    autoComplete="off"
                  />

                  <button
                    className="primary-button"
                    type="submit"
                    disabled={addBusy || !addName.trim()}
                  >
                    +
                  </button>
                </form>

                <input
                  className="text-input sat-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="🔍 Buscar amigos…"
                  autoComplete="off"
                />
              </div>

              {addError && (
                <p className="sat-error" role="alert">{addError}</p>
              )}

              <FriendsSection
                title={`Solicitudes (${visibleRequests.length})`}
                empty={
                  filter
                    ? "Nadie coincide con la búsqueda."
                    : "Sin solicitudes pendientes."
                }
              >
                {visibleRequests.map(([requestKey, entry]) => (
                  <div
                    className="sat-friend-row request"
                    key={`request-${requestKey}`}
                  >
                    <Avatar
                      friend={{
                        name: entry?.name || requestKey,
                        uuid: entry?.uuid || ""
                      }}
                      size={34}
                    />

                    <div className="sat-friend-main">
                      <strong>{entry?.name || requestKey}</strong>
                      <span>Quiere agregarte</span>
                    </div>

                    <button
                      className="sat-mini-button accept"
                      type="button"
                      onClick={() => handleAccept(requestKey)}
                    >
                      Aceptar
                    </button>

                    <button
                      className="sat-mini-button"
                      type="button"
                      onClick={() => handleDeny(requestKey)}
                    >
                      Rechazar
                    </button>
                  </div>
                ))}
              </FriendsSection>

              <FriendsSection
                title={`En línea (${visibleOnline.length})`}
                empty={
                  filter
                    ? "Ningún amigo conectado coincide con la búsqueda."
                    : "Ningún amigo conectado ahora mismo."
                }
              >
                {visibleOnline.map((friend) => (
                  <FriendRow key={friend.key} friend={friend} />
                ))}
              </FriendsSection>

              <FriendsSection
                title={`Desconectados (${visibleOffline.length})`}
                empty="Sin amigos todavía. Agrega a otros jugadores de Eryon con su nombre."
              >
                {visibleOffline.map((friend) => (
                  <FriendRow key={friend.key} friend={friend} />
                ))}
              </FriendsSection>

              {friends.length === 0 && !filter && (
                <p className="sat-hint">
                  Al igual que Lunar: cuando otro jugador tenga Eryon
                  Launcher abierto con el mismo nombre de Minecraft,
                  aquí aparecerá su estado.
                </p>
              )}
            </div>
          )}

          {/* Pestaña: CHATS */}

          {tab === "chats" && (
            <div className="sat-chats">
              {activeChat ? (
                <ChatArea
                  ownKey={userKey}
                  friend={activeChat}
                  messages={messages}
                  draft={draft}
                  setDraft={setDraft}
                  sending={sending}
                  onSend={handleSend}
                  bottomRef={messagesBottomRef}
                  onBack={() => {
                    setActiveChat(null);
                    setTab("friends");
                  }}
                />
              ) : friends.length === 0 ? (
                <div className="sat-chat-empty">
                  <p>
                    No hay conversaciones todavía. Agrega un amigo y
                    comienza a escribirle.
                  </p>
                </div>
              ) : (
                <>
                  <div className="sat-section-title">
                    <span>TUS CONVERSACIONES</span>
                  </div>

                  {friends.map((friend) => (
                    <div className="sat-friend-row" key={friend.key}>
                      <span
                        className={`sat-presence ${
                          friend.online ? "online" : ""
                        }`}
                      />

                      <Avatar friend={friend} size={34} />

                      <button
                        className="sat-friend-main"
                        type="button"
                        onClick={() => openChat(friend.key, friend)}
                      >
                        <strong>{friend.name}</strong>
                        <span>
                          {friend.online
                            ? "En línea"
                            : "Desconectado"}
                        </span>
                      </button>

                      {unread[friend.key] ? (
                        <span className="sat-badge">
                          {unread[friend.key]}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
