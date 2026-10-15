// The shell: shown before the PC's own pages take over. It pairs the phone, then asks Rust to
// start the local proxy and move the web view to it. Everything the shell asks of Rust is a
// small command with string or JSON values, so nothing depends on binary invoke bodies.

import { invoke } from "@tauri-apps/api/core";

const $ = (id) => document.getElementById(id);
const isPhone = /Android/i.test(navigator.userAgent);

const views = { loading: $("view-loading"), enter: $("view-enter"), pair: $("view-pair") };
const el = {
  name: $("name"),
  paste: $("paste"),
  scan: $("scan"),
  pair: $("pair"),
  error: $("pair-error"),
  note: $("pair-note"),
  known: $("known"),
  knownName: $("known-name"),
  back: $("back"),
  forget: $("forget"),
  enterPc: $("enter-pc"),
  confirm: $("confirm"),
  confirmText: $("confirm-text"),
  replace: $("replace"),
  cancel: $("cancel"),
};

// The pairing text waiting for the user to confirm replacing the current PC.
let pending = null;

let busy = false;

function show(name) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
}

function readSaved(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSaved(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not saving the name is fine.
  }
}

function setError(text) {
  el.error.textContent = text ? `Problem: ${text}` : "";
  el.error.hidden = !text;
}

function setBusy(on) {
  busy = on;
  el.scan.disabled = on;
  el.forget.disabled = on;
  el.back.disabled = on;
  el.replace.disabled = on;
  el.cancel.disabled = on;
  syncPairButton();
}

function syncPairButton() {
  el.pair.disabled = busy || !el.paste.value.trim();
}

/** Opens the PC's pages: the proxy is started (if it is not running yet) and the web view moves to it. */
async function enter(name) {
  show("enter");
  el.enterPc.textContent = name ? ` to ${name}` : "";
  try {
    // Rust starts the proxy and moves the window; this page is replaced when that happens.
    await invoke("open_pc");
  } catch (e) {
    showPair({ state: "paired", name }, String(e));
  }
}

/** The pairing screen. `note` is a line above the form, `problem` an error under it. */
function showPair(saved, problem) {
  show("pair");
  const known = saved && saved.state !== "unpaired";
  el.known.hidden = !known;
  el.back.hidden = !(saved && saved.state === "paired");
  el.knownName.textContent = known ? saved.name : "";
  if (saved && saved.state === "revoked") {
    el.note.textContent = `${saved.name} removed this phone. Pair again to keep using it.`;
    el.note.hidden = false;
  } else {
    el.note.hidden = true;
  }
  setError(problem || "");
  hideConfirm();
  setBusy(false);
}

function hideConfirm() {
  pending = null;
  el.confirm.hidden = true;
}

async function askReplace(text, name) {
  const saved = await invoke("get_state").catch(() => null);
  const current = (saved && saved.name) || "this PC";
  pending = { text, name };
  el.confirmText.textContent = `Replace ${current}?`;
  el.confirm.hidden = false;
  el.replace.focus();
}

async function pairWith(text) {
  const trimmed = (text || "").trim();
  if (!trimmed || busy) return;
  hideConfirm();
  setBusy(true);
  setError("");
  const name = el.name.value.trim() || "Phone";
  writeSaved("device-name", name);
  try {
    const info = await invoke("pair", { text: trimmed, name });
    el.paste.value = "";
    await enter(info.name);
  } catch (e) {
    setBusy(false);
    if (String(e) === "already_paired") {
      await askReplace(trimmed, name);
    } else {
      setError(String(e));
    }
  }
}

async function replacePair() {
  if (busy || !pending) return;
  const { text, name } = pending;
  hideConfirm();
  setBusy(true);
  setError("");
  try {
    await invoke("unpair");
    const info = await invoke("pair", { text, name });
    el.paste.value = "";
    await enter(info.name);
  } catch (e) {
    setBusy(false);
    setError(String(e));
  }
}

// Phones only. The scanner plugin is not part of the computer build, so it is loaded on demand.
async function scanQr() {
  if (busy) return;
  setError("");
  try {
    const scanner = await import("@tauri-apps/plugin-barcode-scanner");
    let permission = await scanner.checkPermissions();
    if (permission !== "granted") permission = await scanner.requestPermissions();
    if (permission !== "granted") {
      throw new Error("The camera is not allowed. Allow it in the phone's settings for this app, or paste the pairing text instead.");
    }
    const result = await scanner.scan({ windowed: false, formats: [scanner.Format.QRCode] });
    el.paste.value = result.content;
    syncPairButton();
    await pairWith(result.content);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    // Backing out of the scanner is not a failure.
    if (/cancel/i.test(text)) return;
    setError(`Could not scan. ${text}`);
  }
}

el.paste.addEventListener("input", syncPairButton);
el.pair.addEventListener("click", () => void pairWith(el.paste.value));
el.scan.addEventListener("click", () => void scanQr());
el.replace.addEventListener("click", () => void replacePair());
el.cancel.addEventListener("click", () => {
  hideConfirm();
  setError("");
});
el.back.addEventListener("click", async () => {
  const saved = await invoke("get_state").catch(() => null);
  void enter(saved && saved.name);
});
el.forget.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    await invoke("unpair");
    history.replaceState(null, "", location.pathname);
    showPair({ state: "unpaired", name: null }, "");
  } catch (e) {
    setBusy(false);
    setError(String(e));
  }
});

async function boot() {
  el.name.value = readSaved("device-name") || (isPhone ? "Phone" : "Computer");
  el.scan.hidden = !isPhone;
  show("loading");
  let saved;
  try {
    saved = await invoke("get_state");
  } catch (e) {
    showPair({ state: "unpaired", name: null }, `The app could not start (${String(e)}).`);
    return;
  }
  const wantsPairing = location.hash === "#repair";
  if (saved.state === "paired" && !wantsPairing) {
    await enter(saved.name);
  } else {
    showPair(saved, "");
  }
}

void boot();
