// The shell: shown before a place's own pages take over. It pairs the phone with up to two places (a PC, and the
// hub: the always-on server that runs the chats when every PC is off), then asks Rust to start a local proxy and move
// the web view to it. Opening the app tries the first place, and the second one when the first does not answer.
// Everything the shell asks of Rust is a small command with string or JSON values, so nothing depends on binary
// invoke bodies.
//
// The pages come back here with #repair (the pairing screen), or #open=main / #open=second (that place, no fallback).

import { invoke } from "@tauri-apps/api/core";

const $ = (id) => document.getElementById(id);
const isPhone = /Android/i.test(navigator.userAgent);

const views = { loading: $("view-loading"), enter: $("view-enter"), pair: $("view-pair") };
const trip = $("view-trip"); // Clawd hopping through the stars, above Starting and Connecting
const el = {
  name: $("name"),
  paste: $("paste"),
  scan: $("scan"),
  pair: $("pair"),
  error: $("pair-error"),
  note: $("pair-note"),
  places: $("places"),
  confirm: $("confirm"),
  confirmText: $("confirm-text"),
  replaceMain: $("replace-main"),
  replaceSecond: $("replace-second"),
  cancel: $("cancel"),
  enterPc: $("enter-pc"),
  enterLead: $("enter-lead"),
};

// The pairing text waiting for the user to pick which place it replaces.
let pending = null;
let busy = false;
let places = []; // [{ slot, state, name }] as Rust knows them

function show(name) {
  for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
  trip.hidden = name === "pair";
  document.body.classList.toggle("traveling", name !== "pair");
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
  el.replaceMain.disabled = on;
  el.replaceSecond.disabled = on;
  el.cancel.disabled = on;
  for (const b of el.places.querySelectorAll("button")) b.disabled = on;
  syncPairButton();
}

function syncPairButton() {
  el.pair.disabled = busy || !el.paste.value.trim();
}

const paired = () => places.filter((p) => p.state === "paired");
const placeOf = (slot) => places.find((p) => p.slot === slot);

async function loadState() {
  const s = await invoke("get_state");
  places = s.places || [];
  return s;
}

/** Opens a place's pages: its proxy is started (if it is not running yet) and the web view moves to it. */
async function enter(slot, fallback) {
  const p = placeOf(slot);
  const other = places.find((x) => x.slot !== slot && x.state === "paired");
  show("enter");
  el.enterPc.textContent = p && p.name ? ` to ${p.name}` : "";
  el.enterLead.textContent = fallback && other ? `If ${p.name} is off, ${other.name} opens instead.` : "";
  el.enterLead.hidden = !el.enterLead.textContent;
  try {
    // Rust starts the proxy and moves the window; this page is replaced when that happens.
    await invoke("open_place", { slot, fallback: !!fallback });
  } catch (e) {
    showPair(String(e));
  }
}

/** The pairing screen, with the places this phone knows. `problem` is an error under the form. */
function showPair(problem) {
  show("pair");
  const known = places.filter((p) => p.state !== "unpaired");
  el.places.hidden = !known.length;
  el.places.innerHTML = "";
  for (const p of known) {
    const row = document.createElement("div");
    row.className = "place";
    const label = document.createElement("p");
    const b = document.createElement("b");
    b.textContent = p.name;
    label.append(b, document.createTextNode(p.state === "revoked" ? ": removed this phone. Pair again to use it." : ": paired."));
    row.append(label);
    const btns = document.createElement("div");
    btns.className = "row";
    if (p.state === "paired") {
      const open = document.createElement("button");
      open.className = "secondary";
      open.type = "button";
      open.textContent = `Open ${p.name}`;
      open.addEventListener("click", () => void enter(p.slot, false));
      btns.append(open);
    }
    const forget = document.createElement("button");
    forget.className = "quiet";
    forget.type = "button";
    forget.textContent = `Forget ${p.name}`;
    forget.addEventListener("click", () => void forgetPlace(p.slot));
    btns.append(forget);
    row.append(btns);
    el.places.append(row);
  }
  el.note.hidden = known.length === 0;
  el.note.textContent = known.length === 1 ? "You can pair a second place: the hub, so the chats open when your PC is off. On your PC, open Connections, then the Hub panel, then Pair a phone with the hub." : "";
  if (known.length > 1) el.note.hidden = true;
  setError(problem || "");
  hideConfirm();
  setBusy(false);
}

function hideConfirm() {
  pending = null;
  el.confirm.hidden = true;
}

function askReplace(text, name) {
  const main = placeOf("main");
  const second = placeOf("second");
  pending = { text, name };
  el.confirmText.textContent = "This phone is paired with two places already. Which one does the new pairing replace?";
  el.replaceMain.textContent = `Replace ${(main && main.name) || "the first"}`;
  el.replaceSecond.textContent = `Replace ${(second && second.name) || "the second"}`;
  el.confirm.hidden = false;
  el.replaceMain.focus();
}

async function pairWith(text, slot) {
  const trimmed = (text || "").trim();
  if (!trimmed || busy) return;
  hideConfirm();
  setBusy(true);
  setError("");
  const name = el.name.value.trim() || "Phone";
  writeSaved("device-name", name);
  try {
    const info = await invoke("pair", { text: trimmed, name, slot: slot || null });
    el.paste.value = "";
    await loadState();
    await enter(info.slot, false);
  } catch (e) {
    setBusy(false);
    if (String(e) === "both_paired") askReplace(trimmed, name);
    else setError(String(e));
  }
}

async function replacePair(slot) {
  if (busy || !pending) return;
  const { text } = pending;
  hideConfirm();
  setBusy(true);
  setError("");
  try {
    await invoke("unpair", { slot });
    await loadState();
    setBusy(false);
    await pairWith(text, slot);
  } catch (e) {
    setBusy(false);
    setError(String(e));
  }
}

async function forgetPlace(slot) {
  if (busy) return;
  setBusy(true);
  try {
    await invoke("unpair", { slot });
    await loadState();
    history.replaceState(null, "", location.pathname);
    showPair("");
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
el.replaceMain.addEventListener("click", () => void replacePair("main"));
el.replaceSecond.addEventListener("click", () => void replacePair("second"));
el.cancel.addEventListener("click", () => {
  hideConfirm();
  setError("");
});

async function boot() {
  el.name.value = readSaved("device-name") || (isPhone ? "Phone" : "Computer");
  el.scan.hidden = !isPhone;
  show("loading");
  try {
    await loadState();
  } catch (e) {
    places = [];
    showPair(`The app could not start (${String(e)}).`);
    return;
  }
  const hash = location.hash;
  const asked = /^#open=(main|second)$/.exec(hash);
  if (asked && placeOf(asked[1]) && placeOf(asked[1]).state === "paired") {
    history.replaceState(null, "", location.pathname);
    await enter(asked[1], false);
    return;
  }
  const ready = paired();
  if (hash !== "#repair" && ready.length) {
    // the first place, and the second one when the first does not answer
    await enter(ready[0].slot, ready.length > 1);
  } else {
    showPair("");
  }
}

void boot();
