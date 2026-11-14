
// ======================================================
// CONFIGURACIÓN DE FÁBRICA DEL SATÉLITE
// ======================================================
// Esta configuración va integrada en el launcher para que los
// usuarios NO tengan que configurar nada: instalan, abren el
// Satélite, buscan a sus amigos y chatean.
//
// NOTA DEL DESARROLLADOR: si algún día cambias de proyecto de
// Firebase, guarda la nueva configuración desde el modal del
// Satélite ("%APPDATA%/eryon-launcher/eryon-firebase.json"); esa
// configuración local siempre tiene prioridad sobre esta. Para
// cambiar la de fábrica en nuevas instalaciones, edita este bloque
// antes de compilar.

export const EMBEDDED_FIREBASE_CONFIG = {
  apiKey: "AIzaSyCRZ2hJfBBb24vHpr4tiECoBWAV3qrtLhI",
  authDomain: "eryon-launcher.firebaseapp.com",
  databaseURL: "https://eryon-launcher-default-rtdb.firebaseio.com",
  projectId: "eryon-launcher",
  storageBucket: "eryon-launcher.firebasestorage.app",
  messagingSenderId: "507300115648",
  appId: "1:507300115648:web:f475e67431966cb8c3e925",
  measurementId: "G-TD4K6CK6R2"
};
