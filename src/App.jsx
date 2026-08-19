import React, { useState, useMemo, useRef, useEffect } from "react";
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";

// Bump manually for each meaningful change; shown in the sidebar footer. BUILD_TIME is
// injected by build.mjs (esbuild `define`) at build time — always the actual build moment,
// never edited by hand.
const APP_VERSION = "1.8.0";
const BUILD_TIME = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : null;

function formatBuildTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// jsPDF's built-in fonts (base-14 PDF fonts, WinAnsi-encoded) cover umlauts and German
// quotes fine, but not arrow/dingbat glyphs — those render as missing/blank in the PDF, so any
// text going into it needs these swapped for plain ASCII first.
function pdfSafe(str) {
  return String(str).replace(/→/g, "->").replace(/↳/g, "->");
}

const PALETTE = ["#2B6CB0", "#C4432B", "#2F8F5B", "#7B4FA0", "#B8860B", "#1B2430", "#0E7C86", "#A23E7A"];

// Closes a dropdown when the user clicks/taps outside it or presses Escape.
// `ref` must be attached to the element wrapping both the trigger button
// and the open panel.
function useDropdownClose(open, setOpen, ref) {
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    function handleKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open, setOpen, ref]);
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function toMin(t) {
  if (!t) return null;
  const parts = t.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  const [h, m, s = 0] = parts;
  return h * 60 + m + s / 60;
}

function toTimeStr(min) {
  const totalSeconds = Math.round(min * 60);
  const wrapped = ((totalSeconds % 86400) + 86400) % 86400;
  const h = Math.floor(wrapped / 3600);
  const m = Math.floor((wrapped % 3600) / 60);
  const s = wrapped % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  if (s === 0) return `${hh}:${mm}`;
  const ss = String(s).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// Printed timetables always round down to the whole minute (16:24:30 -> 16:24, never up) so
// nobody reads a departure as later than it actually is.
function toTimeStrFloorMin(min) {
  const totalMinutes = Math.floor(min + 1e-9);
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function toKm(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isNaN(n) ? 0 : n;
}

function kmOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isNaN(n) ? null : n;
}

function toDurationMin(str) {
  if (!str) return null;
  const parts = String(str).split(":").map((p) => Number(p.replace(",", ".")));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 1) return parts[0];
  const [mm, ss = 0] = parts;
  return mm + ss / 60;
}

const initialVehicles = [
  { id: "sbahn", name: "S-Bahn", vmax: 120, accel: 1.0, decel: 1.2 },
  { id: "regional", name: "Regionalzug", vmax: 160, accel: 0.7, decel: 0.8 },
  { id: "fernverkehr", name: "Fernverkehr", vmax: 320, accel: 0.4, decel: 0.5 },
];

// Add future languages here (and a matching block in TRANSLATIONS below) —
// the language dropdown in the sidebar renders itself from this list.
const LANGUAGES = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
];

const TRANSLATIONS = {
  de: {
    eyebrow: "Streckendiagramm",
    title: "Grafischer Fahrplan",
    modeProportional: "Maßstäblich",
    modeSchematic: "Schematisch",
    tabDiagram: "Diagramm",
    tabStations: "Stationen",
    tabKurse: "Kurse",
    tabCsv: "CSV-Import",
    tabSave: "Speichern/Laden",
    tabVehicles: "Fahrzeuge",
    tabAccount: "Konto",
    collapseSidebar: "Navigation einklappen",
    expandSidebar: "Navigation ausklappen",
    groupData: "Daten",
    groupFile: "Datei",
    groupAccount: "Konto",
    emptyTitle: "Noch kein Szenario geladen.",
    emptyDesc: 'Lade unter "Speichern/Laden" ein zuvor gespeichertes Szenario (.json) oder lege im Tab "Stationen" und "Kurse" eines von Hand an.',
    emptyButton: 'Zu "Speichern/Laden"',
    windowFrom: "Zeitfenster von",
    windowTo: "bis",
    zoomLabel: "Zoom",
    zoomOutLabel: "Rauszoomen",
    zoomInLabel: "Reinzoomen",
    zoomReset: "Zoom zurücksetzen",
    zoomHint: "oder Alt+Scrollen im Diagramm",
    conflictsTitle: "Gleiskonflikte",
    conflictsNone: "Keine Gleiskonflikte im Zeitfenster.",
    conflictStation: "Station {name}: {need} Züge gleichzeitig um {t} (nur {tracks})",
    conflictSection: "Abschnitt {a}–{b}: {need} Züge gleichzeitig um {t} (nur {tracks})",
    trackSingular: "Gleis",
    trackPlural: "Gleise",
    conflictsHint: "Geprüft werden nur Stationen/Abschnitte mit hinterlegter Gleiszahl.",
    conflictsNoneShort: "Keine Gleiskonflikte",
    widthLabel: "Breite",
    widthOutLabel: "Schmaler",
    widthInLabel: "Breiter",
    widthReset: "Breite zurücksetzen",
    kursPrefix: "Kurs",
    noKurseYet: "Noch keine Kurse angelegt.",
    kurseMenuLabel: "Kurse",
    kurseShowAll: "Alle anzeigen",
    kurseHideAll: "Alle ausblenden",
    languageLabel: "Sprache",
    intervalSuffix: "′-Takt",
    untilSuffix: "bis",
    diagramHint: "Punkte lassen sich im Diagramm senkrecht ziehen (30-Sekunden-Raster) – gefüllt = manuell gesetzte Zeit, hohl = automatisch berechnet (wird beim Ziehen zu einer fixen Zeit). Gestrichelte Fahrtlinie = Mindest-Fahrzeit zwischen den Stationen (siehe Stationen-Tab) unterschritten.",
    unfix: "Entfixen (wieder automatisch berechnen)",
    splitDeparture: "Abfahrt trennen (+30 Sek.)",
    noActions: "Keine Aktionen verfügbar",
    mainStrecke: "Hauptstrecke",
    colName: "Name",
    colKm: "km",
    colDistance: "Abstand",
    colMinFahrzeit: "Mindestfahrzeit",
    colMaxSpeed: "Höchstgeschw.",
    colTracks: "Gleise Strecke",
    colStationTracks: "Gleise Station",
    tracksSingle: "1-gleisig",
    tracksDouble: "2-gleisig",
    routeBandTitle: "Streckenband",
    segmentFieldsHint: "Diese Felder gelten jeweils für den Abschnitt zur vorherigen Station. Höchstgeschwindigkeit wird zusammen mit dem im Kurs gewählten Fahrzeugtyp für die automatische Fahrzeitberechnung und die Konflikterkennung verwendet. Gleise ist aktuell nur ein Datenfeld für eine spätere Funktion (Kreuzungsdarstellung).",
    distanceFirst: "–",
    kmOptional: "0.00",
    kmHint: "Die Reihenfolge der Stationen wird über die ↑/↓-Pfeile bestimmt, nicht über die Km-Angabe. Km ist rein informativ und wird nur für die maßstäbliche Darstellung sowie für automatische Fahrzeitberechnungen anhand von Distanzen verwendet.",
    colDwell: "Haltezeit (Min.)",
    colBranch: "Zweig",
    colStrecke: "Strecke",
    colFahrzeit: "Fahrzeit (Min.)",
    moveUp: "Nach oben",
    dragHandle: "Ziehen zum Verschieben",
    moveDown: "Nach unten",
    removeStation: "Station löschen",
    addStation: "+ Station hinzufügen",
    removeSignal: "Signal löschen",
    addSignal: "+ Signal hinzufügen",
    addSignalToBranch: '+ Signal zu "{name}" hinzufügen',
    signalBadge: "Signal",
    signalHint: "Signale unterteilen die Strecke zwischen Stationen in Blockabschnitte: In jedem Abschnitt zwischen Station–Station, Signal–Station oder Signal–Signal darf sich immer nur ein Zug befinden. So können mehrere Züge gleichzeitig zwischen zwei Stationen unterwegs sein.",
    branchesTitle: "Zweige (Abzweigungen)",
    branchesDesc: "Ein Zweig zweigt an einer Station der Hauptstrecke ab. Die Abzweigstation selbst wird automatisch als erste Station im Zweig mit angezeigt.",
    branchNamePlaceholder: "Zweigname",
    branchesFrom: "zweigt ab bei",
    branchJoinsAt: "mündet ein bei",
    branchDirectionAfter: "→ Zweig (danach)",
    branchDirectionBefore: "← Zulauf (davor)",
    branchDirectionToggleHint: "Richtung umschalten: Zweig danach/davor",
    removeBranch: "✕ Zweig entfernen",
    authTitle: "Konto",
    authEmailLabel: "E-Mail",
    authPasswordLabel: "Passwort",
    authSignIn: "Anmelden",
    authSignUp: "Konto erstellen",
    authSignOut: "Abmelden",
    authSwitchToSignUp: "Noch kein Konto? Registrieren",
    authSwitchToSignIn: "Schon ein Konto? Anmelden",
    authForgotPassword: "Passwort vergessen?",
    authLoggedInAs: "Angemeldet als {email}",
    authResetSent: "E-Mail zum Zurücksetzen des Passworts wurde gesendet.",
    authErrInvalidEmail: "Ungültige E-Mail-Adresse.",
    authErrEmailInUse: "Diese E-Mail wird bereits verwendet.",
    authErrWeakPassword: "Passwort zu schwach (mind. 6 Zeichen).",
    authErrInvalidCredential: "E-Mail oder Passwort falsch.",
    authErrNeedEmailForReset: "Bitte zuerst E-Mail-Adresse eingeben.",
    cloudProjectsTitle: "Cloud-Projekte",
    cloudProjectPick: "— Projekt wählen —",
    cloudPreviewUpdated: "Zuletzt bearbeitet",
    cloudPreviewStations: "{n} Stationen",
    cloudPreviewKurse: "{n} Kurse",
    cloudLoadBtn: "Laden",
    cloudSaveBtn: "In Cloud speichern",
    cloudSaveAsNewBtn: "Als neues Projekt speichern",
    cloudLoggedOutHint: "Melde dich an, um Projekte in der Cloud zu speichern.",
    cloudNoProjects: "Noch keine Cloud-Projekte gespeichert.",
    cloudSaved: "In der Cloud gespeichert.",
    cloudErrGeneric: "Fehler: {msg}",
    cloudErrNotFound: "Projekt nicht gefunden.",
    cloudCurrentBadge: "aktuell geladen",
    addStationToBranch: '+ Station zu "{name}" hinzufügen',
    addBranch: "+ Zweig hinzufügen",
    dwellHelp: "Haltezeit im Format MM:SS (z. B. 01:30 für 1,5 Minuten): Standardwert, falls bei einem Kurs-Halt an dieser Station nur die Ankunft (manuell oder automatisch berechnet) angegeben ist, aber keine Abfahrt und keine eigene Haltezeit beim jeweiligen Halt im Kurs hinterlegt wurde. Leer entspricht dem bisherigen Verhalten (Abfahrt = Ankunft).",
    travelTimesTitle: "Fahrzeiten zwischen Stationen",
    travelTimesDesc: "Wird bei einem Kurs-Halt Ankunft und/oder Abfahrt leer gelassen, berechnet das Tool die fehlende Zeit automatisch aus diesen Standard-Fahrzeiten (ausgehend von der letzten bekannten Zeit im Kurs). Leer lassen, wenn keine automatische Berechnung gewünscht ist.",
    branchLabel: "Zweig: {name}",
    kursNamePlaceholder: "Kursbezeichnung",
    takt: "Takt (Min.)",
    endzeit: "Endzeit",
    vehicleType: "Fahrzeugtyp",
    vehiclesTitle: "Fahrzeuge",
    vehiclesDesc: "Vordefinierte und eigene Fahrzeugprofile für die automatische Fahrzeitberechnung. Jedes Profil kann bei einem Kurs im Kurse-Tab ausgewählt werden.",
    colVmax: "Vmax (km/h)",
    colAccel: "Beschleunigung (m/s²)",
    colDecel: "Bremsverzögerung (m/s²)",
    removeVehicle: "Fahrzeug löschen",
    addVehicle: "+ Fahrzeug hinzufügen",
    defaultVehicleName: "Fahrzeug {n}",
    vehicleNone: "keiner (nur manuell/Mindestfahrzeit)",
    vehicleSbahn: "S-Bahn (1,0 m/s² / 120 km/h)",
    vehicleRegional: "Regionalzug (0,7 m/s² / 160 km/h)",
    vehicleFernverkehr: "Fernverkehr (0,4 m/s² / 320 km/h)",
    vehicleHelp: " Ist ein Fahrzeugtyp gewählt, wird die Fahrzeit für Abschnitte ohne eingetragene Zeit automatisch aus Distanz, Beschleunigung/Bremsverzögerung des Fahrzeugs und der Streckenhöchstgeschwindigkeit (Stationen-Tab) berechnet – auch beim Durchfahren mehrerer Stationen ohne Halt, jeweils mit der dort geltenden Höchstgeschwindigkeit. Ohne Fahrzeugtyp bleiben nicht eingegebene Zeiten leer. Vereinfachtes Modell (Geschwindigkeitsprofil aus Beschleunigungs-/Bremsphasen), keine hochpräzise Simulation.",
    removeKurs: "✕ entfernen",
    collapseKurs: "Einklappen",
    expandAll: "Alle aufklappen",
    collapseAll: "Alle einklappen",
    expandKurs: "Ausklappen",
    stopsCount: "{n} Halte",
    copyKurs: "Kurs kopieren",
    shiftAllTimes: "Alle Zeiten verschieben (Min.)",
    shiftPlaceholder: "z. B. 7.5",
    shiftButton: "Verschieben",
    kursHelp1: "Stationen der Reihe nach eingeben, in der der Kurs sie durchfährt (Stationen dürfen mehrfach vorkommen, z. B. bei Fahrtrichtungswechsel).",
    kursHelpInterval: " Diese Runde wiederholt sich alle {n} Minuten; aufeinanderfolgende Runden werden im Diagramm mit einer dünnen Linie verbunden.",
    kursHelpEndTime: " Nach {t} beginnt keine neue Runde mehr; die letzte Fahrt darf unterwegs enden, sobald mindestens eine weitere Station erreicht wurde.",
    kursHelpDwell: " Haltezeit im Format MM:SS wirkt nur, wenn Ankunft gesetzt (oder berechnet) und Abfahrt leer ist – sonst Standardwert der Station (Stationen-Tab) bzw. keine Haltezeit.",
    colHash: "#",
    colStation: "Station",
    colArrival: "Ankunft",
    colDeparture: "Abfahrt",
    colDwellShort: "Haltezeit",
    removeHalt: "Halt löschen",
    addWaypoint: "+ Halt hinzufügen",
    orRange: "oder Bereich:",
    rangeTo: "bis",
    addRange: "+ Bereich hinzufügen",
    addKurs: "+ Kurs hinzufügen",
    csvFormatDesc: 'Format pro Zeile: {code}. Erste Zeile darf eine Kopfzeile sein (beginnend mit "Kurs"). Farbe, Takt, Endzeit und Haltezeit optional. Zeilen werden in der angegebenen Reihenfolge als Halte desselben Kurses übernommen, Stationen dürfen sich wiederholen. Unbekannte Stationen werden neu angelegt.',
    importText: "Text importieren",
    uploadCsv: "CSV-Datei hochladen",
    saveDesc: "Zwei Formate zur Wahl: {json} speichert alles (Stationen, Kurse, Zeitfenster, Achsen-Modus) in einer Datei und eignet sich am besten, um ein Szenario 1:1 wiederherzustellen. {csv} speichert Kurse bzw. Stationen als Tabelle – bearbeitbar in Excel und über den CSV-Import-Tab direkt wieder einlesbar. Beides landet im Download-Ordner deines Browsers; leg dir dafür am besten einen eigenen Ordner an, in den du die Dateien verschiebst.",
    scenarioName: "Szenarioname",
    scenarioNamePlaceholder: "z. B. Nachtbetrieb",
    jsonFull: "JSON (vollständig)",
    saveScenario: "Szenario speichern (.json)",
    csvForExcel: "CSV (für Excel)",
    kurseAsCsv: "Kurse als CSV",
    stationsAsCsv: "Stationen als CSV",
    loadTitle: "Laden",
    loadScenario: "Szenario laden (.json)",
    loadHint: "Lädt nur vollständige JSON-Szenarien. Bearbeitete CSV-Dateien lädst du über den CSV-Import-Tab (dort auch die Stationen-Namen entsprechend anpassen). Das Laden ersetzt die aktuell angezeigten Stationen und Kurse vollständig.",
    msgNoData: "Keine Daten gefunden.",
    msgNoValidRows: "Keine gültigen Zeilen erkannt.",
    msgHaltImported: "{n} Halte importiert.",
    msgSavedAs: 'Gespeichert als "{name}.json" (im Download-Ordner deines Browsers).',
    msgKurseSaved: 'Kurse gespeichert als "{name}-kurse.csv" – lässt sich direkt wieder über den CSV-Import laden.',
    msgStationsSaved: 'Stationen gespeichert als "{name}-stationen.csv".',
    msgInvalidScenario: "Diese Datei enthält kein gültiges Fahrplanszenario.",
    msgLoaded: '"{name}" geladen.',
    msgLoadFailed: "Datei konnte nicht gelesen werden (kein gültiges JSON).",
    defaultScenarioName: "Fahrplan",
    defaultKursName: "Kurs {n}",
    defaultStationName: "Neue Station",
    defaultSignalName: "Neues Signal",
    tabExport: "Tabellenfahrplan",
    exportNoRange: "Mindestens eine Linie aktivieren und Start-/Zielstation wählen.",
    exportWindowFrom: "Zeitraum von",
    exportWindowTo: "bis",
    exportStationsTitle: "Abfahrtszeit anzeigen:",
    exportShowArrival: "Ankunft zusätzlich anzeigen",
    exportNoTrains: "Keine Fahrten im gewählten Zeitraum auf diesem Abschnitt.",
    exportColStation: "Station",
    exportSavePdf: "Als PDF speichern",
    exportGenerating: "PDF wird erstellt…",
    exportGeneratedAt: "Erstellt am {date}",
    exportDirectionLabel: "{from} → {to}",
    exportPreviewTitle: "Vorschau",
    exportTrainsCount: "{n} Fahrten",
  },
  en: {
    eyebrow: "Line diagram",
    title: "Graphical Timetable",
    modeProportional: "To scale",
    modeSchematic: "Schematic",
    tabDiagram: "Diagram",
    tabStations: "Stations",
    tabKurse: "Services",
    tabCsv: "CSV import",
    tabSave: "Save/Load",
    tabVehicles: "Vehicles",
    tabAccount: "Account",
    collapseSidebar: "Collapse navigation",
    expandSidebar: "Expand navigation",
    groupData: "Data",
    groupFile: "File",
    groupAccount: "Account",
    emptyTitle: "No scenario loaded yet.",
    emptyDesc: 'Load a previously saved scenario (.json) under "Save/Load", or create one by hand in the "Stations" and "Services" tabs.',
    emptyButton: 'Go to "Save/Load"',
    windowFrom: "Time window from",
    windowTo: "to",
    zoomLabel: "Zoom",
    zoomOutLabel: "Zoom out",
    zoomInLabel: "Zoom in",
    zoomReset: "Reset zoom",
    zoomHint: "or Alt+Scroll over the diagram",
    conflictsTitle: "Track conflicts",
    conflictsNone: "No track conflicts within the time window.",
    conflictStation: "Station {name}: {need} trains at once at {t} (only {tracks})",
    conflictSection: "Section {a}–{b}: {need} trains at once at {t} (only {tracks})",
    trackSingular: "track",
    trackPlural: "tracks",
    conflictsHint: "Only stations/sections with a track count set are checked.",
    conflictsNoneShort: "No track conflicts",
    widthLabel: "Width",
    widthOutLabel: "Narrower",
    widthInLabel: "Wider",
    widthReset: "Reset width",
    kursPrefix: "Service",
    noKurseYet: "No services created yet.",
    kurseMenuLabel: "Services",
    kurseShowAll: "Show all",
    kurseHideAll: "Hide all",
    languageLabel: "Language",
    intervalSuffix: "′ headway",
    untilSuffix: "until",
    diagramHint: "Points can be dragged vertically in the diagram (30-second grid) – filled = manually set time, hollow = automatically calculated (becomes fixed once dragged). Dashed line = minimum travel time between stations (see Stations tab) not met.",
    unfix: "Unfix (calculate automatically again)",
    splitDeparture: "Split departure (+30 sec.)",
    noActions: "No actions available",
    mainStrecke: "Main line",
    colName: "Name",
    colKm: "km",
    colDistance: "Distance",
    colMinFahrzeit: "Min. travel time",
    colMaxSpeed: "Max. speed",
    colTracks: "Section tracks",
    colStationTracks: "Station tracks",
    tracksSingle: "Single track",
    tracksDouble: "Double track",
    routeBandTitle: "Route band",
    segmentFieldsHint: "These fields apply to the section leading to the previous station. Max speed is used together with the vehicle type selected on a service for automatic travel-time calculation and conflict detection. Tracks is currently just a data field for a future feature (crossing/meet display).",
    distanceFirst: "–",
    kmOptional: "0.00",
    kmHint: "The order of stations is set using the ↑/↓ arrows, not by the km value. Km is purely informational and only used for the to-scale view and for automatic travel-time calculations based on distance.",
    colDwell: "Dwell time (min.)",
    colBranch: "Branch",
    colStrecke: "Section",
    colFahrzeit: "Travel time (min.)",
    moveUp: "Move up",
    dragHandle: "Drag to reorder",
    moveDown: "Move down",
    removeStation: "Delete station",
    addStation: "+ Add station",
    removeSignal: "Delete signal",
    addSignal: "+ Add signal",
    addSignalToBranch: '+ Add signal to "{name}"',
    signalBadge: "Signal",
    signalHint: "Signals subdivide the line between stations into block sections: only one train may be in any section between Station–Station, Signal–Station, or Signal–Signal at a time. This lets several trains be between two stations at once.",
    branchesTitle: "Branches",
    branchesDesc: "A branch splits off from a station on the main line. The junction station itself is automatically shown as the first station of the branch too.",
    branchNamePlaceholder: "Branch name",
    branchesFrom: "branches off at",
    branchJoinsAt: "joins at",
    branchDirectionAfter: "→ Branch (after)",
    branchDirectionBefore: "← Feeder (before)",
    branchDirectionToggleHint: "Switch direction: branch after/before main",
    removeBranch: "✕ Remove branch",
    authTitle: "Account",
    authEmailLabel: "Email",
    authPasswordLabel: "Password",
    authSignIn: "Sign in",
    authSignUp: "Create account",
    authSignOut: "Sign out",
    authSwitchToSignUp: "No account yet? Sign up",
    authSwitchToSignIn: "Already have an account? Sign in",
    authForgotPassword: "Forgot password?",
    authLoggedInAs: "Signed in as {email}",
    authResetSent: "Password reset email sent.",
    authErrInvalidEmail: "Invalid email address.",
    authErrEmailInUse: "This email is already in use.",
    authErrWeakPassword: "Password too weak (min. 6 characters).",
    authErrInvalidCredential: "Wrong email or password.",
    authErrNeedEmailForReset: "Please enter your email address first.",
    cloudProjectsTitle: "Cloud projects",
    cloudProjectPick: "— Select a project —",
    cloudPreviewUpdated: "Last edited",
    cloudPreviewStations: "{n} stations",
    cloudPreviewKurse: "{n} services",
    cloudLoadBtn: "Load",
    cloudSaveBtn: "Save to cloud",
    cloudSaveAsNewBtn: "Save as new project",
    cloudLoggedOutHint: "Sign in to save projects to the cloud.",
    cloudNoProjects: "No cloud projects saved yet.",
    cloudSaved: "Saved to the cloud.",
    cloudErrGeneric: "Error: {msg}",
    cloudErrNotFound: "Project not found.",
    cloudCurrentBadge: "currently loaded",
    addStationToBranch: '+ Add station to "{name}"',
    addBranch: "+ Add branch",
    dwellHelp: "Dwell time in MM:SS format (e.g. 01:30 for 1.5 minutes): default value used when a service stop at this station only has an arrival (manual or auto-calculated) but no departure and no dwell time of its own set at that stop. Leave empty for the previous behavior (departure = arrival).",
    travelTimesTitle: "Travel times between stations",
    travelTimesDesc: "If arrival and/or departure are left blank at a service stop, the tool automatically calculates the missing time from these default travel times (starting from the last known time in the service). Leave blank if you don't want automatic calculation.",
    branchLabel: "Branch: {name}",
    kursNamePlaceholder: "Service name",
    takt: "Headway (min.)",
    endzeit: "End time",
    vehicleType: "Vehicle type",
    vehiclesTitle: "Vehicles",
    vehiclesDesc: "Predefined and custom vehicle profiles for automatic travel-time calculation. Each profile can be selected on a service in the Services tab.",
    colVmax: "Max speed (km/h)",
    colAccel: "Acceleration (m/s²)",
    colDecel: "Braking rate (m/s²)",
    removeVehicle: "Delete vehicle",
    addVehicle: "+ Add vehicle",
    defaultVehicleName: "Vehicle {n}",
    vehicleNone: "none (manual/min. travel time only)",
    vehicleSbahn: "S-Bahn / commuter (1.0 m/s² / 120 km/h)",
    vehicleRegional: "Regional train (0.7 m/s² / 160 km/h)",
    vehicleFernverkehr: "Long-distance (0.4 m/s² / 320 km/h)",
    vehicleHelp: " If a vehicle type is selected, travel time for sections without an entered time is calculated automatically from distance, the vehicle's acceleration/braking rate, and the track's max speed (Stations tab) – including when passing through several stations without stopping, respecting each section's own speed limit. Without a vehicle type, unentered times simply stay blank. Simplified model (speed profile built from acceleration/braking phases), not a high-precision simulation.",
    removeKurs: "✕ remove",
    collapseKurs: "Collapse",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    expandKurs: "Expand",
    stopsCount: "{n} stops",
    copyKurs: "Copy service",
    shiftAllTimes: "Shift all times (min.)",
    shiftPlaceholder: "e.g. 7.5",
    shiftButton: "Shift",
    kursHelp1: "Enter stations in the order the service passes through them (stations may appear more than once, e.g. when the direction reverses).",
    kursHelpInterval: " This run repeats every {n} minutes; consecutive runs are connected in the diagram with a thin line.",
    kursHelpEndTime: " No new run starts after {t}; the last run may end mid-way as soon as at least one more station has been reached.",
    kursHelpDwell: " Dwell time in MM:SS format only applies when arrival is set (or calculated) and departure is blank – otherwise the station's default (Stations tab) or no dwell time is used.",
    colHash: "#",
    colStation: "Station",
    colArrival: "Arrival",
    colDeparture: "Departure",
    colDwellShort: "Dwell time",
    removeHalt: "Delete stop",
    addWaypoint: "+ Add stop",
    orRange: "or range:",
    rangeTo: "to",
    addRange: "+ Add range",
    addKurs: "+ Add service",
    csvFormatDesc: 'Format per line: {code}. The first line may be a header row (starting with "Kurs"). Color, headway, end time and dwell time are optional. Rows are added in the given order as stops of the same service; stations may repeat. Unknown stations are created automatically.',
    importText: "Import text",
    uploadCsv: "Upload CSV file",
    saveDesc: "Two formats to choose from: {json} saves everything (stations, services, time window, axis mode) in one file and is best for restoring a scenario exactly. {csv} saves services or stations as a table – editable in Excel and can be read back in directly via the CSV import tab. Both land in your browser's downloads folder; it's best to create your own folder to move the files into.",
    scenarioName: "Scenario name",
    scenarioNamePlaceholder: "e.g. night service",
    jsonFull: "JSON (complete)",
    saveScenario: "Save scenario (.json)",
    csvForExcel: "CSV (for Excel)",
    kurseAsCsv: "Services as CSV",
    stationsAsCsv: "Stations as CSV",
    loadTitle: "Load",
    loadScenario: "Load scenario (.json)",
    loadHint: "Only loads complete JSON scenarios. Load edited CSV files via the CSV import tab (adjust station names there too). Loading fully replaces the currently shown stations and services.",
    msgNoData: "No data found.",
    msgNoValidRows: "No valid rows recognized.",
    msgHaltImported: "{n} stops imported.",
    msgSavedAs: 'Saved as "{name}.json" (in your browser\'s downloads folder).',
    msgKurseSaved: 'Services saved as "{name}-services.csv" – can be loaded directly again via CSV import.',
    msgStationsSaved: 'Stations saved as "{name}-stations.csv".',
    msgInvalidScenario: "This file doesn't contain a valid timetable scenario.",
    msgLoaded: '"{name}" loaded.',
    msgLoadFailed: "File could not be read (not valid JSON).",
    defaultScenarioName: "Timetable",
    defaultKursName: "Service {n}",
    defaultStationName: "New station",
    defaultSignalName: "New signal",
    tabExport: "Timetable export",
    exportNoRange: "Enable at least one line and pick its start/end stations.",
    exportWindowFrom: "Time range from",
    exportWindowTo: "to",
    exportStationsTitle: "Show departure time:",
    exportShowArrival: "Also show arrival",
    exportNoTrains: "No services run through this section in the selected time range.",
    exportColStation: "Station",
    exportSavePdf: "Save as PDF",
    exportGenerating: "Generating PDF…",
    exportGeneratedAt: "Generated on {date}",
    exportDirectionLabel: "{from} → {to}",
    exportPreviewTitle: "Preview",
    exportTrainsCount: "{n} services",
  },
};

const initialStations = [];

const initialKurse = [];

export default function GraphicalTimetable() {
  const [stations, setStations] = useState(initialStations);
  const [branches, setBranches] = useState([]);
  const [vehicles, setVehicles] = useState(initialVehicles);
  const [kurse, setKurse] = useState(initialKurse);
  const [yMode, setYMode] = useState("schematic");
  const [tab, setTab] = useState("diagram");
  const [visible, setVisible] = useState(() =>
    Object.fromEntries(initialKurse.map((k) => [k.id, true]))
  );
  const [tooltip, setTooltip] = useState(null);
  const [csvText, setCsvText] = useState("");
  const [csvMsg, setCsvMsg] = useState("");
  const [winStart, setWinStart] = useState("00:45");
  const [winEnd, setWinEnd] = useState("02:05");
  const [scenarioName, setScenarioName] = useState("Fahrplan");
  const [exportMainEnabled, setExportMainEnabled] = useState(true);
  const [exportMainFromId, setExportMainFromId] = useState("");
  const [exportMainToId, setExportMainToId] = useState("");
  const [exportBranchEnabled, setExportBranchEnabled] = useState({});
  const [exportBranchFromId, setExportBranchFromId] = useState({});
  const [exportBranchToId, setExportBranchToId] = useState({});
  const [exportShowArrival, setExportShowArrival] = useState({});
  const [exportWinStart, setExportWinStart] = useState("00:00");
  const [exportWinEnd, setExportWinEnd] = useState("23:59");
  const [exportGenerating, setExportGenerating] = useState(false);
  const [lang, setLang] = useState("de");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("signin"); // "signin" | "signup"
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [cloudProjects, setCloudProjects] = useState([]);
  const [cloudProjectsLoading, setCloudProjectsLoading] = useState(false);
  const [selectedCloudProjectId, setSelectedCloudProjectId] = useState("");
  const [currentCloudProjectId, setCurrentCloudProjectId] = useState(null);
  const [cloudMsg, setCloudMsg] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const autoLoadedUidRef = useRef(null);
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setAuthUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);
  function t(key, vars) {
    let str = (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS.de[key] || key;
    if (vars) {
      Object.keys(vars).forEach((k) => {
        str = str.replace(`{${k}}`, vars[k]);
      });
    }
    return str;
  }
  const [shiftInputs, setShiftInputs] = useState({});
  const [rangeInputs, setRangeInputs] = useState({});
  const [collapsedKurse, setCollapsedKurse] = useState({});
  const [collapsedLines, setCollapsedLines] = useState({});
  const [draggedBranchId, setDraggedBranchId] = useState(null);
  const [dragOverBranchId, setDragOverBranchId] = useState(null);
  const [draggedStationId, setDraggedStationId] = useState(null);
  const [dragOverStationId, setDragOverStationId] = useState(null);
  const [draggedWaypoint, setDraggedWaypoint] = useState(null);
  const [dragOverWaypointId, setDragOverWaypointId] = useState(null);
  const [maxSpeeds, setMaxSpeeds] = useState({});
  const [trackCounts, setTrackCounts] = useState({});
  const [saveMsg, setSaveMsg] = useState("");
  const [pxPerMin, setPxPerMin] = useState(6);
  const [stationSpacing, setStationSpacing] = useState(72);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [kurseMenuOpen, setKurseMenuOpen] = useState(false);
  const [exportStationsMenuOpen, setExportStationsMenuOpen] = useState(false);
  const langMenuRef = useRef(null);
  const kurseMenuRef = useRef(null);
  const exportStationsMenuRef = useRef(null);
  const fileInputRef = useRef(null);
  const loadFileInputRef = useRef(null);
  const diagramWrapRef = useRef(null);
  const bodySvgRef = useRef(null);
  const [draggingKey, setDraggingKey] = useState(null);
  const draggingKeyRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null);
  const pendingScrollRef = useRef(null);

  const mainStations = useMemo(
    () =>
      stations
        .filter((s) => !s.branchId)
        .sort((a, b) => (a.order ?? toKm(a.km)) - (b.order ?? toKm(b.km))),
    [stations]
  );
  const branchStationsMap = useMemo(() => {
    const m = new Map();
    for (const br of branches) {
      m.set(
        br.id,
        stations
          .filter((s) => s.branchId === br.id)
          .sort((a, b) => (a.order ?? toKm(a.km)) - (b.order ?? toKm(b.km)))
      );
    }
    return m;
  }, [stations, branches]);
  // Anzeigereihenfolge: Hauptstrecke zuerst, danach je Zweig dessen eigene Stationen
  const sortedStations = useMemo(() => {
    const list = [...mainStations];
    for (const br of branches) {
      list.push(...(branchStationsMap.get(br.id) || []));
    }
    return list;
  }, [mainStations, branches, branchStationsMap]);
  const stationIndex = useMemo(
    () => new Map(sortedStations.map((s, i) => [s.id, i])),
    [sortedStations]
  );
  // Signals aren't stoppable — only real stations may be picked as a Kurs waypoint.
  const stoppableStations = useMemo(
    () => sortedStations.filter((s) => s.kind !== "signal"),
    [sortedStations]
  );
  const stationName = useMemo(
    () => new Map(sortedStations.map((s) => [s.id, s.name])),
    [sortedStations]
  );
  const stationDwell = useMemo(
    () => new Map(sortedStations.map((s) => [s.id, toDurationMin(s.dwell) || 0])),
    [sortedStations]
  );
  const stationBranchMap = useMemo(
    () => new Map(sortedStations.map((s) => [s.id, s.branchId || null])),
    [sortedStations]
  );
  const stationsById = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const branchFromIds = useMemo(() => new Set(branches.map((b) => b.fromStationId)), [branches]);

  function chainFor(branchId) {
    if (!branchId) return mainStations;
    const br = branches.find((b) => b.id === branchId);
    if (!br) return [];
    const attach = stations.find((s) => s.id === br.fromStationId);
    const bStations = branchStationsMap.get(branchId) || [];
    return attach ? [attach, ...bStations] : bStations;
  }
  // "Section tracks" (colTracks) is only ever configured on a real Station row, keyed by
  // adjacent REAL station pairs. Signals add extra block boundaries between two real
  // stations without a tracks field of their own, so every fine adjacent pair in the
  // ordered line (station-or-signal to station-or-signal) needs to resolve back to the
  // enclosing real-station-pair key that actually holds the configured capacity.
  const capacityKeyMap = useMemo(() => {
    const map = new Map();
    const addChain = (chain) => {
      for (let i = 0; i < chain.length - 1; i++) {
        let pi = i;
        while (pi >= 0 && chain[pi].kind === "signal") pi--;
        let ni = i + 1;
        while (ni < chain.length && chain[ni].kind === "signal") ni++;
        if (pi < 0 || ni >= chain.length) continue;
        map.set(segKey(chain[i].id, chain[i + 1].id), segKey(chain[pi].id, chain[ni].id));
      }
    };
    addChain(mainStations);
    for (const br of branches) addChain(chainFor(br.id));
    return map;
  }, [mainStations, branches, branchStationsMap, stations]);
  // Allowed concurrent trains for a fine block segment, given its segKey(idA,idB) — see
  // capacityKeyMap.
  function capacityAt(key) {
    const raw = parseInt(trackCounts[capacityKeyMap.get(key) ?? key], 10);
    return isNaN(raw) ? null : Math.max(0, raw);
  }
  // Nearest real station at or before index idx in an ordered station/signal list, skipping
  // signals — used to key the "Section tracks" input, which (like capacityKeyMap) always
  // describes the span between two real stations, not a fine signal-bounded sub-segment.
  function prevRealId(list, idx) {
    for (let i = idx - 1; i >= 0; i--) {
      if (list[i].kind !== "signal") return list[i].id;
    }
    return null;
  }
  // Liste aller physischen Stationen (in Reihenfolge) zwischen zwei Stationen, zweigfähig.
  function chainPath(chain, idA, idB) {
    const ia = chain.findIndex((s) => s.id === idA);
    const ib = chain.findIndex((s) => s.id === idB);
    if (ia === -1 || ib === -1) return null;
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    const slice = chain.slice(lo, hi + 1).map((s) => s.id);
    return ia <= ib ? slice : slice.reverse();
  }
  function vehicleForKurs(k) {
    if (!vehicles.length) return null;
    return vehicles.find((v) => v.id === k.vehicleType) || vehicles[0];
  }
  function pathBetween(idA, idB) {
    if (idA === idB) return [idA];
    const brA = stationBranchMap.get(idA) || null;
    const brB = stationBranchMap.get(idB) || null;
    if (brA === brB) return chainPath(chainFor(brA), idA, idB);
    if (!brA) {
      const branch = branches.find((b) => b.id === brB);
      if (!branch) return null;
      const p1 = chainPath(mainStations, idA, branch.fromStationId);
      const p2 = chainPath(chainFor(brB), branch.fromStationId, idB);
      if (!p1 || !p2) return null;
      return [...p1, ...p2.slice(1)];
    }
    if (!brB) {
      const rev = pathBetween(idB, idA);
      return rev ? [...rev].reverse() : null;
    }
    const branchA = branches.find((b) => b.id === brA);
    const branchB = branches.find((b) => b.id === brB);
    if (!branchA || !branchB) return null;
    const legA = chainPath(chainFor(brA), idA, branchA.fromStationId);
    const legMain = chainPath(mainStations, branchA.fromStationId, branchB.fromStationId);
    const legB = chainPath(chainFor(brB), branchB.fromStationId, idB);
    if (!legA || !legMain || !legB) return null;
    return [...legA, ...legMain.slice(1), ...legB.slice(1)];
  }

  // Effektive Km einer Station innerhalb einer bestimmten Kette: Auf einem Zweig zählt die
  // Abzweigstation selbst als Km 0 (siehe "Abstand"-Spalte im Stationen-Tab), reale Zweig-Stationen
  // nutzen ihre eigene (bereits relative) Km-Angabe.
  function effectiveKmInChain(stationId, contextBranchId) {
    if (!contextBranchId) return kmOrNull(stationsById.get(stationId)?.km);
    const branch = branches.find((b) => b.id === contextBranchId);
    if (branch && stationId === branch.fromStationId) return 0;
    return kmOrNull(stationsById.get(stationId)?.km);
  }
  function chainDistanceKm(chain, contextBranchId, idA, idB) {
    const ia = chain.findIndex((s) => s.id === idA);
    const ib = chain.findIndex((s) => s.id === idB);
    if (ia === -1 || ib === -1) return null;
    if (ia === ib) return 0;
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    let sum = 0;
    for (let i = lo; i < hi; i++) {
      const kmA = effectiveKmInChain(chain[i].id, contextBranchId);
      const kmB = effectiveKmInChain(chain[i + 1].id, contextBranchId);
      if (kmA === null || kmB === null) return null;
      sum += Math.abs(kmB - kmA);
    }
    return sum;
  }
  function distanceBetweenKm(idA, idB) {
    if (idA === idB) return 0;
    const brA = stationBranchMap.get(idA) || null;
    const brB = stationBranchMap.get(idB) || null;
    if (brA === brB) return chainDistanceKm(chainFor(brA), brA, idA, idB);
    if (!brA) {
      const branch = branches.find((b) => b.id === brB);
      if (!branch) return null;
      const d1 = chainDistanceKm(mainStations, null, idA, branch.fromStationId);
      const d2 = chainDistanceKm(chainFor(brB), brB, branch.fromStationId, idB);
      return d1 !== null && d2 !== null ? d1 + d2 : null;
    }
    if (!brB) return distanceBetweenKm(idB, idA);
    const branchA = branches.find((b) => b.id === brA);
    const branchB = branches.find((b) => b.id === brB);
    if (!branchA || !branchB) return null;
    const dA = chainDistanceKm(chainFor(brA), brA, branchA.fromStationId, idA);
    const dB = chainDistanceKm(chainFor(brB), brB, branchB.fromStationId, idB);
    const dMain = chainDistanceKm(mainStations, null, branchA.fromStationId, branchB.fromStationId);
    return dA !== null && dB !== null && dMain !== null ? dA + dB + dMain : null;
  }
  // Fahrzeit für ein einzelnes Segment mit gegebener Ein-/Austrittsgeschwindigkeit (u, w in m/s),
  // Distanz d (m) und Streckenlimit vLim (m/s): beschleunigen, ggf. konstant fahren, abbremsen.
  function segmentTravelTime(u, w, d, vLim, a, b) {
    const dAcc = Math.max(0, (vLim * vLim - u * u) / (2 * a));
    const dDec = Math.max(0, (vLim * vLim - w * w) / (2 * b));
    if (dAcc + dDec <= d) {
      const cruiseD = d - dAcc - dDec;
      return (vLim - u) / a + cruiseD / vLim + (vLim - w) / b;
    }
    const p2 = (d + (u * u) / (2 * a) + (w * w) / (2 * b)) / (1 / (2 * a) + 1 / (2 * b));
    const p = Math.sqrt(Math.max(p2, u * u, w * w));
    return (p - u) / a + (p - w) / b;
  }
  // Mehrsegment-Geschwindigkeitsprofil über eine Stationsfolge: pro physischem Abschnitt gilt die
  // jeweils eigene Streckenhöchstgeschwindigkeit (Minimum aus Fahrzeug-Vmax und Strecke), sodass auch
  // beim Durchfahren ohne Halt zwischen unterschiedlichen Limits beschleunigt/gebremst wird. Start und
  // Ziel der Gesamtstrecke gelten als Halt (Geschwindigkeit 0), dazwischen werden die Übergänge so
  // geglättet, dass sie physikalisch (Beschleunigung/Bremsverzögerung) erreichbar sind.
  function multiSegmentPhysicsTime(pathIds, vehicle) {
    if (!vehicle || !pathIds || pathIds.length < 2) return null;
    const n = pathIds.length - 1;
    const distances = [];
    const limits = [];
    for (let i = 0; i < n; i++) {
      const dKm = distanceBetweenKm(pathIds[i], pathIds[i + 1]);
      if (dKm === null) return null;
      const raw = maxSpeeds[segKey(pathIds[i], pathIds[i + 1])];
      const trackV = raw !== undefined && raw !== null && raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : null;
      const limKmh = trackV !== null ? Math.min(vehicle.vmax, trackV) : vehicle.vmax;
      distances.push(dKm * 1000);
      limits.push(limKmh / 3.6);
    }
    const boundary = new Array(n + 1).fill(Infinity);
    boundary[0] = 0;
    boundary[n] = 0;
    for (let j = 1; j < n; j++) {
      boundary[j] = Math.min(limits[j - 1], limits[j]);
    }
    for (let j = 1; j <= n; j++) {
      const vAcc = Math.sqrt(boundary[j - 1] * boundary[j - 1] + 2 * vehicle.accel * distances[j - 1]);
      boundary[j] = Math.min(boundary[j], vAcc, limits[j - 1]);
    }
    boundary[n] = 0;
    for (let j = n - 1; j >= 0; j--) {
      const vDec = Math.sqrt(boundary[j + 1] * boundary[j + 1] + 2 * vehicle.decel * distances[j]);
      boundary[j] = Math.min(boundary[j], vDec);
    }
    boundary[0] = 0;
    let totalSec = 0;
    for (let j = 0; j < n; j++) {
      totalSec += segmentTravelTime(boundary[j], boundary[j + 1], distances[j], limits[j], vehicle.accel, vehicle.decel);
    }
    return totalSec / 60; // Minuten
  }

  // Maximale gleichzeitige Überlappung einer Menge von geschlossenen Zeitintervallen [start, end].
  // Punkt-Intervalle (start === end, z. B. Durchfahrten) werden korrekt mitgezählt. Gibt die höchste
  // gleichzeitige Anzahl und einen repräsentativen Zeitpunkt zurück.
  function maxOverlap(intervals) {
    if (intervals.length === 0) return { count: 0, atMin: null };
    const criticals = [];
    for (const iv of intervals) {
      criticals.push(iv.s);
      criticals.push(iv.e);
    }
    let best = 0;
    let bestT = null;
    for (const c of criticals) {
      let n = 0;
      for (const iv of intervals) {
        if (iv.s - 1e-6 <= c && c <= iv.e + 1e-6) n++;
      }
      if (n > best) {
        best = n;
        bestT = c;
      }
    }
    return { count: best, atMin: bestT };
  }

  // Fixed direction per track, with an odd leftover track shared dynamically: floor(N/2) tracks
  // are permanently dedicated to each direction, and if N is odd there's one "swing" track that
  // either direction may use — it isn't reserved, so whichever direction needs it takes it, and
  // it's free again as soon as that train clears the block. N=1 is the degenerate case (0
  // dedicated each, everything through the swing track), which reduces to the original
  // undirected single-track behavior.
  //
  // A conflict occurs at a moment in time when the combined overflow beyond each direction's own
  // dedicated capacity exceeds what the swing track(s) can cover — one direction's spare
  // dedicated capacity can never bail out the other, only the swing capacity is flexible:
  //   excess(t) = max(0, ascCount(t) - dedicated) + max(0, descCount(t) - dedicated)
  //   conflict when excess(t) > swing
  function evaluateDirectionalCapacity(ascIvs, descIvs, dedicated, swing) {
    const events = [];
    const pushEvents = (ivs, dir) => {
      for (const iv of ivs) {
        if (iv.e - iv.s <= 1e-9) continue; // point intervals don't occupy the block
        events.push({ t: iv.s, d: 1, dir });
        events.push({ t: iv.e, d: -1, dir });
      }
    };
    pushEvents(ascIvs, "asc");
    pushEvents(descIvs, "desc");
    if (events.length === 0) return { conflict: false, atMin: null, need: 0, windows: [] };
    events.sort((a, b) => (a.t - b.t) || (a.d - b.d)); // ends before starts (half-open)
    let curA = 0;
    let curB = 0;
    let bestExcess = 0;
    let bestAtMin = null;
    let bestNeed = 0;
    const windows = [];
    let openStart = null;
    const excessOf = (a, b) => Math.max(0, a - dedicated) + Math.max(0, b - dedicated);
    for (const e of events) {
      const wasOver = excessOf(curA, curB) > swing;
      if (e.dir === "asc") curA += e.d;
      else curB += e.d;
      const ex = excessOf(curA, curB);
      if (ex > bestExcess) {
        bestExcess = ex;
        bestAtMin = e.t;
        bestNeed = curA + curB;
      }
      const isOver = ex > swing;
      if (!wasOver && isOver) openStart = e.t;
      else if (wasOver && !isOver && openStart !== null) {
        if (e.t > openStart + 1e-9) windows.push([openStart, e.t]);
        openStart = null;
      }
    }
    return { conflict: bestExcess > swing, atMin: bestAtMin, need: bestNeed, windows };
  }

  // Wie maxOverlap, aber mit halboffenen Intervallen [start, end): eine reine Berührung am Rand
  // (z. B. ein Zug fährt im Bahnhof ab, während der Gegenzug im selben Moment ankommt) zählt NICHT
  // als Konflikt. Verwendet für Streckenabschnitte – die Zugkreuzung findet im Bahnhof statt, nicht
  // auf der Strecke. Gibt zusätzlich die beteiligten Kurs-IDs am Konfliktzeitpunkt zurück.
  function maxOverlapHalfOpen(intervals) {
    const events = [];
    for (const iv of intervals) {
      if (iv.e - iv.s <= 1e-9) continue; // Punkt-/Nullintervalle belegen die Strecke nicht
      events.push({ t: iv.s, d: 1, kursId: iv.kursId });
      events.push({ t: iv.e, d: -1, kursId: iv.kursId });
    }
    if (events.length === 0) return { count: 0, atMin: null };
    // Bei gleichem Zeitpunkt zuerst Enden (-1), dann Anfänge (+1) verarbeiten → [s,e)-Semantik
    events.sort((a, b) => (a.t - b.t) || (a.d - b.d));
    let cur = 0;
    let best = 0;
    let bestT = null;
    for (const e of events) {
      cur += e.d;
      if (cur > best) {
        best = cur;
        bestT = e.t;
      }
    }
    return { count: best, atMin: bestT };
  }

  // Liefert die zusammengefassten Zeitfenster [start, end], in denen mehr als 'capacity' Intervalle
  // gleichzeitig belegt sind. pointEps > 0 gibt Punkt-Intervallen (Durchfahrten) eine winzige Dauer,
  // damit sie in der Belegungszählung berücksichtigt werden (für Stationen). endsFirst=true verwendet
  // halboffene [s,e)-Semantik (für Strecken – Berührung am Bahnhofsrand zählt nicht).
  function overCapacityWindows(intervals, capacity, pointEps, endsFirst) {
    const events = [];
    for (const iv of intervals) {
      let e = iv.e;
      if (e - iv.s <= 1e-9) {
        if (pointEps > 0) e = iv.s + pointEps;
        else continue;
      }
      events.push({ t: iv.s, d: 1 });
      events.push({ t: e, d: -1 });
    }
    if (events.length === 0) return [];
    // endsFirst: bei Gleichstand Enden vor Anfängen (halboffen). Sonst Anfänge vor Enden (geschlossen).
    events.sort((a, b) => (a.t - b.t) || (endsFirst ? a.d - b.d : b.d - a.d));
    const windows = [];
    let cur = 0;
    let openStart = null;
    for (const e of events) {
      const wasOver = cur > capacity;
      cur += e.d;
      const isOver = cur > capacity;
      if (!wasOver && isOver) openStart = e.t;
      else if (wasOver && !isOver && openStart !== null) {
        if (e.t > openStart + 1e-9) windows.push([openStart, e.t]);
        openStart = null;
      }
    }
    return windows;
  }

  // Sammelt für alle Taktfahrten aller Kurse die Gleisbelegung je Station und je physischem
  // Streckenabschnitt und meldet Stellen, an denen mehr Züge gleichzeitig anwesend sind als Gleise
  // vorhanden. Richtungsunabhängig. Nur Stationen/Abschnitte mit hinterlegter Gleiszahl (>=1) werden
  // geprüft; ohne Angabe erfolgt keine Prüfung (kein Fehlalarm).
  function computeConflicts() {
    const stationOcc = new Map(); // stationId -> [{s,e,kursId,tripLabel}]
    const sectionOcc = new Map(); // segKey -> [{s,e,kursId,dir}]
    const addOcc = (map, key, s, e, kursId, dir) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ s: Math.min(s, e), e: Math.max(s, e), kursId, dir });
    };
    for (const k of kurse) {
      if (visible[k.id] === false) continue; // hidden services don't count toward conflicts
      const vehicle = vehicleForKurs(k);
      const resolved = resolveWaypoints(k.waypoints, vehicle);
      let baseFirst = null;
      for (const rwp of resolved) {
        if (rwp.arrMin !== null) { baseFirst = rwp.arrMin; break; }
        if (rwp.depMin !== null) { baseFirst = rwp.depMin; break; }
      }
      if (baseFirst === null) continue;
      const interval = Number(k.interval) || 0;
      const endTimeMin = toMin(k.endTime);
      let idx = 0;
      while (true) {
        const shift = interval > 0 ? idx * interval : 0;
        const shiftedFirst = baseFirst + shift;
        if (shiftedFirst > maxTime + 1e-6) break;
        if (endTimeMin !== null && shiftedFirst > endTimeMin + 1e-6) break;
        // Besuchsliste dieser Fahrt (nur Wegpunkte mit Zeit, innerhalb Fenster grob)
        const visits = [];
        for (let wi = 0; wi < k.waypoints.length; wi++) {
          const wp = k.waypoints[wi];
          const rwp = resolved[wi];
          const a = rwp.arrMin !== null ? rwp.arrMin + shift : null;
          const d = rwp.depMin !== null ? rwp.depMin + shift : null;
          if (a === null && d === null) continue;
          visits.push({ stationId: wp.stationId, arr: a, dep: d });
        }
        // Stationsbelegung
        for (const v of visits) {
          const s = v.arr !== null ? v.arr : v.dep;
          const e = v.dep !== null ? v.dep : v.arr;
          if (e < minTime - 1e-6 || s > maxTime + 1e-6) continue;
          addOcc(stationOcc, v.stationId, s, e, k.id);
        }
        // Streckenbelegung: je aufeinanderfolgendem Besuchspaar, anteilig nach Distanz
        for (let vi = 0; vi < visits.length - 1; vi++) {
          const v1 = visits[vi];
          const v2 = visits[vi + 1];
          if (v1.stationId === v2.stationId) continue;
          const tA = v1.dep !== null ? v1.dep : v1.arr;
          const tB = v2.arr !== null ? v2.arr : v2.dep;
          if (tA === null || tB === null) continue;
          const path = pathBetween(v1.stationId, v2.stationId);
          if (!path || path.length < 2) continue;
          const dists = [];
          let total = 0;
          for (let pi = 0; pi < path.length - 1; pi++) {
            const dkm = distanceBetweenKm(path[pi], path[pi + 1]);
            const dd = dkm === null ? 0 : Math.max(0, dkm);
            dists.push(dd);
            total += dd;
          }
          let cum = 0;
          for (let pi = 0; pi < path.length - 1; pi++) {
            const key = segKey(path[pi], path[pi + 1]);
            // "asc"/"desc" just means "same order as the canonical (sorted) key" or not — an
            // arbitrary but consistent label per physical segment, used to tell the two
            // directions of travel apart for capacity purposes (see splitTrackCapacity).
            const dir = path[pi] === key.split("|")[0] ? "asc" : "desc";
            let entry, exit;
            if (total > 0) {
              entry = tA + ((cum) / total) * (tB - tA);
              exit = tA + ((cum + dists[pi]) / total) * (tB - tA);
            } else {
              entry = tA;
              exit = tB;
            }
            cum += dists[pi];
            if (exit < minTime - 1e-6 || entry > maxTime + 1e-6) continue;
            addOcc(sectionOcc, key, entry, exit, k.id, dir);
          }
        }
        if (interval <= 0) break;
        idx++;
        if (idx > 500) break;
      }
    }
    const stationConflicts = [];
    const stationWindows = new Map(); // stationId -> [[s,e],...]
    for (const [stationId, ivs] of stationOcc.entries()) {
      const raw = parseInt(stationsById.get(stationId)?.stationTracks, 10);
      if (isNaN(raw) || raw < 1) continue;
      const { count, atMin } = maxOverlap(ivs);
      if (count > raw) {
        stationConflicts.push({
          stationId,
          name: stationsById.get(stationId)?.name || stationId,
          need: count,
          have: raw,
          atMin,
        });
        const wins = overCapacityWindows(ivs, raw, 0.02, false);
        if (wins.length) stationWindows.set(stationId, wins);
      }
    }
    const sectionConflicts = [];
    const sectionWindows = new Map(); // segKey -> { asc: [[s,e],...], desc: [[s,e],...] }
    for (const [key, ivs] of sectionOcc.entries()) {
      const raw = capacityAt(key);
      if (raw === null || raw < 1) continue;
      let [idA, idB] = key.split("|");
      const oa = stationIndex.get(idA);
      const ob = stationIndex.get(idB);
      if (oa !== undefined && ob !== undefined && ob < oa) {
        [idA, idB] = [idB, idA];
      }
      const nameA = stationsById.get(idA)?.name || idA;
      const nameB = stationsById.get(idB)?.name || idB;
      const dedicated = Math.floor(raw / 2);
      const swing = raw - dedicated * 2; // 0 or 1 — see evaluateDirectionalCapacity
      const winsForKey = {};
      if (swing === 0) {
        // No shared track: each direction's capacity is fully independent, so check (and
        // highlight) them separately — a same-direction pile-up still conflicts even though
        // the section overall isn't "full", and the other direction is never implicated.
        const checkDir = (dirIvs, cap, dirLabel) => {
          const { count, atMin } = maxOverlapHalfOpen(dirIvs);
          if (count <= cap) return;
          sectionConflicts.push({ key, nameA, nameB, need: count, have: cap, atMin, dir: dirLabel });
          const wins = overCapacityWindows(dirIvs, cap, 0, true);
          if (wins.length) winsForKey[dirLabel] = wins;
        };
        checkDir(ivs.filter((iv) => iv.dir === "asc"), dedicated, "asc");
        checkDir(ivs.filter((iv) => iv.dir === "desc"), dedicated, "desc");
      } else {
        const r = evaluateDirectionalCapacity(
          ivs.filter((iv) => iv.dir === "asc"),
          ivs.filter((iv) => iv.dir === "desc"),
          dedicated,
          swing
        );
        if (r.conflict) {
          sectionConflicts.push({ key, nameA, nameB, need: r.need, have: raw, atMin: r.atMin, dir: "shared" });
          // Which direction the swing track was needed by can shift moment to moment within
          // the same window, so both directions' trips through it are flagged together.
          if (r.windows.length) {
            winsForKey.asc = r.windows;
            winsForKey.desc = r.windows;
          }
        }
      }
      if (winsForKey.asc || winsForKey.desc) sectionWindows.set(key, winsForKey);
    }
    stationConflicts.sort((a, b) => (a.atMin ?? 0) - (b.atMin ?? 0));
    sectionConflicts.sort((a, b) => (a.atMin ?? 0) - (b.atMin ?? 0));
    return { stationConflicts, sectionConflicts, stationWindows, sectionWindows };
  }

  function fracWithin(panelStations, st) {
    if (yMode === "schematic") {
      const pos = panelStations.findIndex((s) => s.id === st.id);
      return panelStations.length > 1 ? pos / (panelStations.length - 1) : 0;
    }
    const kms = panelStations.map((s) => toKm(s.km));
    const mn = Math.min(...kms);
    const mx = Math.max(...kms);
    const span = Math.max(mx - mn, 1);
    return (toKm(st.km) - mn) / span;
  }
  // Wie fracWithin, aber die Abzweigstation zählt für den Zweig immer als Km 0,
  // unabhängig von ihrer tatsächlichen Kilometrierung auf der Hauptstrecke.
  function fracWithinBranch(bp, st) {
    let frac;
    if (yMode === "schematic") {
      const pos = bp.stations.findIndex((s) => s.id === st.id);
      frac = bp.stations.length > 1 ? pos / (bp.stations.length - 1) : 0;
    } else {
      const effectiveKm = (s) => (bp.attach && s.id === bp.attach.id ? 0 : toKm(s.km));
      const kms = bp.stations.map(effectiveKm);
      const mn = Math.min(0, ...kms);
      const mx = Math.max(0, ...kms);
      const span = Math.max(mx - mn, 1);
      frac = (effectiveKm(st) - mn) / span;
    }
    // A "before" (mirrored) branch's own stations are stored/ordered exactly like a normal
    // branch (attach first), but need to render as the mirror image — attach at the panel's
    // right edge (touching main) instead of its left.
    return bp.mirrored ? 1 - frac : frac;
  }

  let minTime = toMin(winStart);
  let maxTime = toMin(winEnd);
  if (minTime === null || maxTime === null || maxTime <= minTime) {
    minTime = 0;
    maxTime = 120;
  }
  const timeSpan = maxTime - minTime;

  const CHAR_WIDTH_ESTIMATE = 6.4; // grobe Breitenschätzung pro Zeichen bei 12px Fontgröße
  const maxNameLen = sortedStations.length ? Math.max(...sortedStations.map((s) => s.name.length)) : 0;
  const maxLabelPx = maxNameLen * CHAR_WIDTH_ESTIMATE;
  const diagonalComponent = maxLabelPx / Math.SQRT2; // Anteil in x/y bei 45°-Drehung
  const TRACK_BAND_H = 20; // Höhe des horizontalen Gleisbands im Diagrammkopf
  const HEADER_HEIGHT = Math.max(44, diagonalComponent + 20) + (branches.length ? 14 : 0) + TRACK_BAND_H;
  const margin = { top: 16, right: Math.max(30, diagonalComponent + 16), bottom: 20, left: 80 };
  const PANEL_GAP = 56;
  const mainCount = Math.max(mainStations.length, 2);
  const mainChartW = Math.max(220, (mainCount - 1) * stationSpacing);
  function makeBranchPanel(br) {
    const attach = stations.find((s) => s.id === br.fromStationId) || null;
    const ownStations = branchStationsMap.get(br.id) || [];
    const displayStations = attach ? [attach, ...ownStations] : ownStations;
    const count = Math.max(displayStations.length, 1);
    const w = Math.max(120, (count > 1 ? count - 1 : 1) * stationSpacing);
    return { branch: br, stations: displayStations, ownStations, attach, width: w, mirrored: br.direction === "before" };
  }
  // "before" branches feed INTO the main line and render as their own panels to its left — the
  // mirror image of the normal (diverging, "after") branches to its right. Left-to-right, the
  // whole diagram reads as: before-branches in their configured order, then main, then
  // after-branches in their configured order.
  const beforeBranches = branches.filter((b) => b.direction === "before");
  const afterBranches = branches.filter((b) => b.direction !== "before");
  const beforePanels = beforeBranches.map(makeBranchPanel);
  const afterPanels = afterBranches.map(makeBranchPanel);
  const branchPanels = [...beforePanels, ...afterPanels];
  let runningX = margin.left;
  const beforePanelOffsets = beforePanels.map((bp) => {
    const left = runningX;
    runningX = left + bp.width + PANEL_GAP;
    return left;
  });
  const mainLeft = runningX;
  runningX = mainLeft + mainChartW;
  const afterPanelOffsets = afterPanels.map((bp) => {
    const left = runningX + PANEL_GAP;
    runningX = left + bp.width;
    return left;
  });
  const branchPanelOffsets = [...beforePanelOffsets, ...afterPanelOffsets];
  const chartW = runningX - margin.left;
  const chartH = Math.max(240, timeSpan * pxPerMin);
  const svgW = margin.left + chartW + margin.right;
  const svgH = margin.top + chartH + margin.bottom;

  function timeY(min) {
    return margin.top + ((min - minTime) / timeSpan) * chartH;
  }
  function panelEdges(branchId) {
    if (!branchId) return { left: mainLeft, right: mainLeft + mainChartW };
    const idx = branchPanels.findIndex((bp) => bp.branch.id === branchId);
    if (idx === -1) return { left: mainLeft, right: mainLeft + mainChartW };
    const left = branchPanelOffsets[idx];
    return { left, right: left + branchPanels[idx].width };
  }
  // Effective horizontal position, for comparing which of two lines sits further right in the
  // diagram — real panel X, not array order, since a "before" branch can sit earlier in the
  // `branches` array while still rendering to the right of an "after" branch (or vice versa).
  function branchOrderIndex(branchId) {
    return panelEdges(branchId).left;
  }
  function stubPath(x, y, direction) {
    const len = 14;
    const endX = x + direction * len;
    const midX = x + (direction * len) / 2;
    const cy = y - 6;
    return `M ${x} ${y} Q ${midX} ${cy} ${endX} ${y}`;
  }
  function dwellCurveD(p1, p2) {
    const midy = (p1.y + p2.y) / 2;
    const bulge = Math.max(8, Math.abs(p2.y - p1.y) * 0.2 + 5);
    const isRightHalf = p1.x > margin.left + chartW / 2;
    const cx = isRightHalf ? p1.x + bulge : p1.x - bulge;
    return `M ${p1.x} ${p1.y} Q ${cx} ${midy} ${p2.x} ${p2.y}`;
  }
  function stationX(idx) {
    const st = sortedStations[idx];
    if (!st) return mainLeft;
    const branchId = st.branchId || null;
    if (!branchId) {
      const frac = fracWithin(mainStations, st);
      return mainLeft + frac * mainChartW;
    }
    const bpIdx = branchPanels.findIndex((bp) => bp.branch.id === branchId);
    if (bpIdx === -1) return margin.left;
    const bp = branchPanels[bpIdx];
    const left = branchPanelOffsets[bpIdx];
    if (bp.stations.length <= 1) return left + bp.width / 2;
    const frac = fracWithinBranch(bp, st);
    return left + frac * bp.width;
  }
  // x-Position der Abzweigstation innerhalb eines Zweig-Panels (links bei normalen, rechts bei
  // gespiegelten/"before"-Zweigen — siehe fracWithinBranch)
  function branchAttachX(bp) {
    const left = branchPanelOffsets[branchPanels.indexOf(bp)];
    if (bp.stations.length <= 1) return left + bp.width / 2;
    const frac = fracWithinBranch(bp, bp.attach);
    return left + frac * bp.width;
  }

  // Horizontales Gleisband im Diagrammkopf: je Station N kurze waagrechte Linien (fixe Länge),
  // je Streckenabschnitt M durchgehende waagrechte Linien (M/N = Gleiszahl). Bei erkanntem Konflikt
  // rot, dünner und gestrichelt. Läuft synchron zur horizontalen Stationsachse.
  function renderTrackBand() {
    const sortedIndexById = new Map(sortedStations.map((s, i) => [s.id, i]));
    const xById = (id) => {
      const i = sortedIndexById.get(id);
      return i === undefined ? null : stationX(i);
    };
    const bandTop = HEADER_HEIGHT - TRACK_BAND_H;
    const cy = bandTop + TRACK_BAND_H / 2;
    const trackGap = 3.5;
    const STATION_HALF = 8;
    const laneYs = (m) => {
      const ys = [];
      for (let i = 0; i < m; i++) ys.push(cy + (i - (m - 1) / 2) * trackGap);
      return ys;
    };
    const els = [];
    // stA/stB: the two endpoint stations/signals, so the short gap that visually marks a
    // station stop can be skipped at a signal — the line stays unbroken through it (the
    // signal's own dot marker is drawn on top, not a gap in the line).
    const drawSection = (xA, stA, xB, stB, key) => {
      if (xA === null || xB === null) return;
      const aIsLo = xA <= xB;
      const gapLo = (aIsLo ? stA : stB).kind !== "signal" ? STATION_HALF : 0;
      const gapHi = (aIsLo ? stB : stA).kind !== "signal" ? STATION_HALF : 0;
      const lo = Math.min(xA, xB) + gapLo;
      const hi = Math.max(xA, xB) - gapHi;
      if (hi <= lo) return;
      const raw = capacityAt(key);
      const m = raw === null ? 0 : raw;
      if (m === 0) {
        els.push(<line key={`sec-${key}`} x1={lo} y1={cy} x2={hi} y2={cy} stroke="#D7DBD5" strokeWidth={1} strokeDasharray="2 3" />);
        return;
      }
      laneYs(m).forEach((y, li) => {
        els.push(
          <line
            key={`sec-${key}-${li}`}
            x1={lo} y1={y} x2={hi} y2={y}
            stroke="#171B1F"
            strokeWidth={1.6}
          />
        );
      });
    };
    // Signal nodes get a small dot per lane of the enclosing block section (see
    // capacityKeyMap) instead of a station's platform-track ticks — shorter, so it reads
    // as a boundary marker rather than a stop.
    const drawSignalNode = (x, st, neighborKey) => {
      if (x === null) return;
      const raw = neighborKey !== null ? capacityAt(neighborKey) : null;
      const n = Math.max(1, raw || 0);
      laneYs(n).forEach((y, li) => {
        els.push(<circle key={`sig-${st.id}-${li}`} cx={x} cy={y} r={1.3} fill="#171B1F" />);
      });
    };
    const drawNode = (x, st) => {
      if (x === null) return;
      const raw = parseInt(st.stationTracks, 10);
      const n = isNaN(raw) ? 0 : Math.max(0, raw);
      if (n === 0) {
        els.push(<circle key={`nd-${st.id}`} cx={x} cy={cy} r={2.4} fill="#fff" stroke="#848C82" strokeWidth={1} />);
        return;
      }
      laneYs(n).forEach((y, li) => {
        els.push(
          <line
            key={`nd-${st.id}-${li}`}
            x1={x - STATION_HALF} y1={y} x2={x + STATION_HALF} y2={y}
            stroke="#171B1F"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        );
      });
    };
    // Hauptstrecke
    for (let i = 0; i < mainStations.length; i++) {
      if (i > 0) {
        drawSection(
          xById(mainStations[i - 1].id), mainStations[i - 1],
          xById(mainStations[i].id), mainStations[i],
          segKey(mainStations[i - 1].id, mainStations[i].id)
        );
      }
    }
    mainStations.forEach((st, idx) => {
      const x = xById(st.id);
      if (st.kind === "signal") {
        const neighborKey = idx > 0 ? segKey(mainStations[idx - 1].id, st.id) : null;
        drawSignalNode(x, st, neighborKey);
      } else {
        drawNode(x, st);
      }
    });
    // Zweige
    branchPanels.forEach((bp) => {
      const seq = bp.stations; // [attach, ...own]
      const xOf = (st, idx) => (idx === 0 && bp.attach ? branchAttachX(bp) : xById(st.id));
      for (let i = 1; i < seq.length; i++) {
        drawSection(
          xOf(seq[i - 1], i - 1), seq[i - 1],
          xOf(seq[i], i), seq[i],
          segKey(seq[i - 1].id, seq[i].id)
        );
      }
      seq.forEach((st, idx) => {
        // Abzweigstation-Echo nur als Knoten zeichnen, wenn sie eigene Gleise hat
        if (idx === 0 && bp.attach) {
          drawNode(branchAttachX(bp), st);
        } else if (st.kind === "signal") {
          const neighborKey = idx > 0 ? segKey(seq[idx - 1].id, st.id) : null;
          drawSignalNode(xOf(st, idx), st, neighborKey);
        } else {
          drawNode(xOf(st, idx), st);
        }
      });
    });
    return els;
  }

  function zoomBy(factor, anchorYInContainer) {
    const container = diagramWrapRef.current;
    if (!container) return;
    const mouseYInContainer = anchorYInContainer ?? container.clientHeight / 2;
    const mouseYInContent = mouseYInContainer + container.scrollTop;
    setPxPerMin((prevPx) => {
      const nextPx = Math.min(40, Math.max(1, prevPx * factor));
      const timeUnderMouse = minTime + (mouseYInContent - margin.top) / prevPx;
      const newContentY = margin.top + (timeUnderMouse - minTime) * nextPx;
      pendingScrollRef.current = newContentY - mouseYInContainer;
      return nextPx;
    });
  }

  useEffect(() => {
    const container = diagramWrapRef.current;
    if (!container) return;
    function handleWheel(e) {
      if (!e.altKey) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const mouseYInContainer = e.clientY - rect.top;
      const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomBy(zoomFactor, mouseYInContainer);
    }
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [minTime, margin.top, tab, stations.length]);

  useEffect(() => {
    if (pendingScrollRef.current !== null && diagramWrapRef.current) {
      diagramWrapRef.current.scrollTop = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }
  }, [pxPerMin]);

  function resetZoom() {
    setPxPerMin(6);
  }
  function widthZoomBy(factor) {
    setStationSpacing((prev) => Math.min(500, Math.max(60, prev * factor)));
  }
  function resetWidthZoom() {
    setStationSpacing(72);
  }

  useEffect(() => {
    if (!contextMenu) return;
    function handleOutside() {
      setContextMenu(null);
    }
    function handleKey(e) {
      if (e.key === "Escape") setContextMenu(null);
    }
    window.addEventListener("pointerdown", handleOutside);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handleOutside);
      window.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  // Generic outside-click / Escape closing for the header dropdown menus
  // (language switcher, services visibility). Unlike the diagram context
  // menu above, these check DOM containment via ref instead of relying on
  // stopPropagation, so re-clicking the trigger button toggles cleanly
  // instead of instantly reopening.
  useDropdownClose(langMenuOpen, setLangMenuOpen, langMenuRef);
  useDropdownClose(kurseMenuOpen, setKurseMenuOpen, kurseMenuRef);
  useDropdownClose(exportStationsMenuOpen, setExportStationsMenuOpen, exportStationsMenuRef);

  const NICE_MINUTE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
  const TARGET_GRID_PX = 36;
  const minuteStep =
    NICE_MINUTE_STEPS.find((s) => s * pxPerMin >= TARGET_GRID_PX) ||
    NICE_MINUTE_STEPS[NICE_MINUTE_STEPS.length - 1];
  const gridLines = [];
  const gridStart = Math.ceil(minTime / minuteStep) * minuteStep;
  for (let m = gridStart; m <= maxTime; m += minuteStep) {
    gridLines.push(m);
  }

  function segKey(a, b) {
    return [a, b].sort().join("|");
  }
  function resolveWaypoints(waypoints, vehicle) {
    let lastTime = null;
    let lastStationId = null;
    return waypoints.map((wp) => {
      let a = toMin(wp.arr);
      let d = toMin(wp.dep);
      const wpDwell = toDurationMin(wp.dwell);
      const dwell = wpDwell !== null ? wpDwell : stationDwell.get(wp.stationId) || 0;
      if (a === null && lastTime !== null && lastStationId !== null && vehicle) {
        const path = pathBetween(lastStationId, wp.stationId);
        const seg = path ? multiSegmentPhysicsTime(path, vehicle) : null;
        if (seg !== null) {
          a = lastTime + seg;
          // Berechnete Ankunft immer auf die nächste 00/30-Sekunden-Marke aufrunden – auch bei
          // Durchfahrten (Ankunft = Abfahrt). Ergibt sauberere Fahrplandaten und nur Pufferzeit.
          a = Math.ceil(a * 2) / 2;
        }
      }
      if (d === null && a !== null) {
        d = a + dwell;
      }
      lastStationId = wp.stationId;
      lastTime = d !== null ? d : a !== null ? a : null;
      return { stationId: wp.stationId, arrMin: a, depMin: d };
    });
  }

  // --- Table timetable export (tab "export") ---------------------------------------------

  // Walks a single, non-branching chain (main line, or one branch's own [attach, ...stations])
  // from fromId to toId and returns the station ids in between, in that order (either
  // direction). Returns null if either id isn't actually on this chain. Unlike pathBetween,
  // this never crosses into another chain, so a branch selection can never accidentally pull in
  // unrelated main-line stations — each line's row range is deterministic and self-contained.
  function sliceChain(chain, fromId, toId) {
    const filtered = chain.filter((s) => s.kind !== "signal");
    const fromIdx = filtered.findIndex((s) => s.id === fromId);
    const toIdx = filtered.findIndex((s) => s.id === toId);
    if (fromIdx === -1 || toIdx === -1) return null;
    const step = fromIdx <= toIdx ? 1 : -1;
    const ids = [];
    for (let i = fromIdx; step > 0 ? i <= toIdx : i >= toIdx; i += step) ids.push(filtered[i].id);
    return ids;
  }

  // Row groups for the printed table: the main line (if enabled) plus every branch the user
  // explicitly opted into, each with its own independently chosen From/To range — stacked below
  // the main line "similar to the station editing page", in branch order. Each row is a real
  // station (signals are never rows).
  function buildExportBlocks() {
    const blocks = [];
    function pushBranchBlock(br) {
      if (!exportBranchEnabled[br.id]) return;
      const fromId = exportBranchFromId[br.id];
      const toId = exportBranchToId[br.id];
      if (!fromId || !toId) return;
      const ids = sliceChain(chainFor(br.id), fromId, toId);
      if (!ids) return;
      blocks.push({
        label: br.name,
        attachId: br.fromStationId,
        rows: ids.map((id) => ({ id, echo: id === br.fromStationId, rowKey: `${br.id}:${id}` })),
      });
    }
    // Stacking order mirrors the diagram's left-to-right reading, top to bottom: "before"
    // (feeder) branches first, then the main line, then "after" (diverging) branches.
    for (const br of beforeBranches) pushBranchBlock(br);
    if (exportMainEnabled && exportMainFromId && exportMainToId) {
      const ids = sliceChain(mainStations, exportMainFromId, exportMainToId);
      if (ids) blocks.push({ label: null, attachId: null, rows: ids.map((id) => ({ id, rowKey: `0:${id}` })) });
    }
    for (const br of afterBranches) pushBranchBlock(br);
    return blocks.length ? blocks : null;
  }

  // Every individual train run (a headway service expands into one column per occurrence),
  // with its full physical route (for the |/ "runs through"/"doesn't run here" distinction) and
  // its resolved stop times per station it's an explicit waypoint of.
  function buildExportTrips(untilMin) {
    const trips = [];
    for (const k of kurse) {
      if (visible[k.id] === false) continue;
      const vehicle = vehicleForKurs(k);
      const resolved = resolveWaypoints(k.waypoints, vehicle);
      let baseFirst = null;
      for (const rwp of resolved) {
        if (rwp.arrMin !== null) { baseFirst = rwp.arrMin; break; }
        if (rwp.depMin !== null) { baseFirst = rwp.depMin; break; }
      }
      if (baseFirst === null) continue;
      const interval = Number(k.interval) || 0;
      const endTimeMin = toMin(k.endTime);
      let idx = 0;
      while (true) {
        const shift = interval > 0 ? idx * interval : 0;
        const shiftedFirst = baseFirst + shift;
        if (shiftedFirst > untilMin + 1e-6) break;
        if (endTimeMin !== null && shiftedFirst > endTimeMin + 1e-6) break;
        const stopsByStation = new Map();
        const routeIds = [];
        let truncated = false;
        for (let wi = 0; wi < k.waypoints.length; wi++) {
          const wp = k.waypoints[wi];
          const rwp = resolved[wi];
          const a = rwp.arrMin !== null ? rwp.arrMin + shift : null;
          const d = rwp.depMin !== null ? rwp.depMin + shift : null;
          if (endTimeMin !== null && ((a !== null && a > endTimeMin + 1e-6) || (d !== null && d > endTimeMin + 1e-6))) {
            truncated = true;
            break;
          }
          if (wi === 0) {
            routeIds.push(wp.stationId);
          } else {
            const leg = pathBetween(k.waypoints[wi - 1].stationId, wp.stationId);
            if (leg) routeIds.push(...leg.slice(1));
          }
          if (a !== null || d !== null) stopsByStation.set(wp.stationId, { arr: a, dep: d });
        }
        if (stopsByStation.size > 0) {
          trips.push({ tripId: `${k.id}-${idx}`, name: k.name, color: k.color, stopsByStation, routeIds });
        }
        if (interval <= 0) break;
        if (truncated) break;
        idx++;
        if (idx > 500) break;
      }
    }
    return trips;
  }

  // Filters trips to the selected time window and direction, and resolves each printed row to a
  // stop / "|" (runs through) / "/" (doesn't run here) cell for that trip.
  function computeExportColumns(blocks, trips, winStartMin, winEndMin) {
    const flatRows = blocks.flatMap((b) => b.rows);
    const columns = [];
    for (const trip of trips) {
      const routeIndexById = new Map();
      trip.routeIds.forEach((id, i) => {
        if (!routeIndexById.has(id)) routeIndexById.set(id, i);
      });

      // Direction: checked independently against every enabled line — each has its own
      // explicit From→To, so each imposes its own ordering constraint. The rows of any one
      // line this trip actually touches must appear in the same order along the trip's own
      // route as they do in that line's row list.
      let wrongDirection = false;
      for (const block of blocks) {
        const touched = [];
        block.rows.forEach((r, i) => {
          if (routeIndexById.has(r.id)) touched.push([i, routeIndexById.get(r.id)]);
        });
        for (let i = 1; i < touched.length; i++) {
          if (touched[i][1] < touched[i - 1][1]) { wrongDirection = true; break; }
        }
        if (wrongDirection) break;
      }
      if (wrongDirection) continue;

      // Window-overlap span: the trip's actual physical presence across every printed row,
      // from its earliest arrival-or-departure to its latest.
      let presenceStart = null;
      let presenceEnd = null;
      for (const r of flatRows) {
        const stop = trip.stopsByStation.get(r.id);
        if (!stop) continue;
        const s = stop.arr !== null ? stop.arr : stop.dep;
        const e = stop.dep !== null ? stop.dep : stop.arr;
        if (presenceStart === null || s < presenceStart) presenceStart = s;
        if (presenceEnd === null || e > presenceEnd) presenceEnd = e;
      }
      if (presenceStart === null) continue; // no explicit stop anywhere printed — nothing to show
      if (presenceEnd < winStartMin - 1e-6 || presenceStart > winEndMin + 1e-6) continue;

      // Sort key: the departure (what's actually printed by default) at the first row — in
      // table print order — this trip has a stop at. Not the same as presenceStart above, which
      // prefers arrival and ignores table order.
      let sortT = presenceStart;
      for (const r of flatRows) {
        const stop = trip.stopsByStation.get(r.id);
        if (!stop) continue;
        sortT = stop.dep !== null ? stop.dep : stop.arr;
        break;
      }

      const cells = {};
      for (const block of blocks) {
        // A branch's echoed junction row only makes sense for trips that actually continue onto
        // that branch — for any other trip, a time there would look like it's heading onto the
        // branch when it isn't, so force it to "/" regardless of what the main row shows.
        const ownBranchIds = block.attachId
          ? block.rows.filter((r) => !r.echo).map((r) => r.id)
          : null;
        for (const r of block.rows) {
          if (r.echo && ownBranchIds && !ownBranchIds.some((id) => routeIndexById.has(id))) {
            cells[r.rowKey] = { kind: "none" };
            continue;
          }
          const stop = trip.stopsByStation.get(r.id);
          if (stop) cells[r.rowKey] = { kind: "stop", arr: stop.arr, dep: stop.dep };
          else if (routeIndexById.has(r.id)) cells[r.rowKey] = { kind: "through" };
          else cells[r.rowKey] = { kind: "none" };
        }
      }
      columns.push({ tripId: trip.tripId, name: trip.name, color: trip.color, sortT, cells });
    }
    // Column order: comparing two trains by "each one's own first row" breaks down once they
    // start from different rows — e.g. a train starting further down the table can have a
    // smaller absolute time than one starting at the top, while still genuinely departing later
    // from every row they actually share. So compare using the first row (in table order) BOTH
    // trains have a real stop at; only fall back to each one's own sortT when they share none.
    const rowKeysInOrder = flatRows.map((r) => r.rowKey);
    columns.sort((a, b) => {
      for (const rk of rowKeysInOrder) {
        const ca = a.cells[rk];
        const cb = b.cells[rk];
        if (ca && ca.kind === "stop" && cb && cb.kind === "stop") {
          const ta = ca.dep !== null ? ca.dep : ca.arr;
          const tb = cb.dep !== null ? cb.dep : cb.arr;
          if (ta !== tb) return ta - tb;
        }
      }
      return a.sortT - b.sortT;
    });
    return splitOvertakes(columns, flatRows);
  }

  // A column must read top-to-bottom as one continuous, increasing timeline. An overtake breaks
  // that: train A (left) is overtaken by train B (right) at some station, so from there down A's
  // times are earlier than B's while still sitting to A's own left — visually backwards. Real
  // printed timetables fix this by splitting the overtaken train's column at that station: the
  // arrival stays in A's original column, and a new column carrying A's departure and everything
  // after is spliced in immediately right of B. Runs top-to-bottom once, re-scanning each row
  // after every split since column positions shift (so a train overtaken twice — at two
  // different stations — gets a third segment automatically).
  //
  // When more than one train overtakes A at the very same station, A must jump past all of them
  // in one move: finding only the nearest (adjacent) one and splitting repeatedly would relocate
  // A one step at a time, and each intermediate stop re-triggers a further split — leaving an
  // empty vestigial column behind at the first stopping point. So for the column being split, we
  // look for the *last* (rightmost) present column it's still out of order with, and insert its
  // "after" segment directly there.
  function splitOvertakes(columns, flatRows) {
    let order = columns.map((c) => ({ ...c }));
    for (const row of flatRows) {
      const rk = row.rowKey;
      let changed = true;
      while (changed) {
        changed = false;
        const present = [];
        order.forEach((col, idx) => {
          const cell = col.cells[rk];
          if (cell && cell.kind === "stop") {
            present.push({ idx, t: cell.dep !== null ? cell.dep : cell.arr });
          }
        });
        for (let i = 0; i < present.length; i++) {
          let lastFaster = -1;
          for (let j = i + 1; j < present.length; j++) {
            if (present[j].t < present[i].t) lastFaster = j;
          }
          if (lastFaster === -1) continue; // not overtaken by anyone (left) at this row

          const beforeIdx = present[i].idx;
          const insertAfterIdx = present[lastFaster].idx;
          const beforeCol = order[beforeIdx];
          const beforeCell = beforeCol.cells[rk];
          if (beforeCell.dep === null) break; // terminates here — nothing to carry into a split

          const afterCells = {};
          const newBeforeCells = {};
          let reachedSplit = false;
          for (const r2 of flatRows) {
            if (r2.rowKey === rk) {
              newBeforeCells[r2.rowKey] = { kind: "stop", arr: beforeCell.arr, dep: null };
              afterCells[r2.rowKey] = { kind: "stop", arr: null, dep: beforeCell.dep };
              reachedSplit = true;
              continue;
            }
            newBeforeCells[r2.rowKey] = reachedSplit ? { kind: "blank" } : beforeCol.cells[r2.rowKey];
            afterCells[r2.rowKey] = reachedSplit ? beforeCol.cells[r2.rowKey] : { kind: "blank" };
          }
          order[beforeIdx] = { ...beforeCol, cells: newBeforeCells };
          order.splice(insertAfterIdx + 1, 0, {
            ...beforeCol,
            tripId: `${beforeCol.tripId}~split${rk}`,
            cells: afterCells,
          });
          changed = true;
          break;
        }
      }
    }
    return order;
  }

  // Flattens blocks into the actual printed rows, splitting a station into separate "an"/"ab"
  // sub-rows when its arrival checkbox is on (default: departure only).
  function buildExportPrintRows(blocks) {
    const rows = [];
    blocks.forEach((block, bi) => {
      if (bi > 0) rows.push({ type: "divider", block });
      block.rows.forEach((r) => {
        if (exportShowArrival[r.id]) {
          rows.push({ type: "an", stationId: r.id, rowKey: r.rowKey, echo: r.echo });
          rows.push({ type: "ab", stationId: r.id, rowKey: r.rowKey, echo: r.echo });
        } else {
          rows.push({ type: "single", stationId: r.id, rowKey: r.rowKey, echo: r.echo });
        }
      });
    });
    return rows;
  }

  function exportCellText(cell, rowType) {
    if (!cell) return "";
    if (cell.kind === "blank") return ""; // the other half of a split (overtake) column — see splitOvertakes
    if (cell.kind === "through") return "|";
    if (cell.kind === "none") return "/";
    if (rowType === "an") return cell.arr !== null ? toTimeStrFloorMin(cell.arr) : "";
    if (rowType === "ab") return cell.dep !== null ? toTimeStrFloorMin(cell.dep) : "";
    // "single" row (departure only by default) — fall back to arrival at a terminus that has
    // no departure of its own.
    if (cell.dep !== null) return toTimeStrFloorMin(cell.dep);
    if (cell.arr !== null) return toTimeStrFloorMin(cell.arr);
    return "";
  }

  // "Main line: Alpha → Delta · Branch1: Beta → Zeta" — one From→To summary per enabled line,
  // used in both the on-screen preview title and the PDF title.
  function exportLineSummary(blocks) {
    return blocks
      .map((b) => {
        const label = b.label || t("mainStrecke");
        const from = stationsById.get(b.rows[0].id)?.name || "";
        const to = stationsById.get(b.rows[b.rows.length - 1].id)?.name || "";
        return t("exportDirectionLabel", { from: `${label}: ${from}`, to });
      })
      .join(" · ");
  }

  const kursPaths = kurse.map((k) => {
    const vehicle = vehicleForKurs(k);
    const resolved = resolveWaypoints(k.waypoints, vehicle);
    let baseFirst = null;
    for (const rwp of resolved) {
      if (rwp.arrMin !== null) { baseFirst = rwp.arrMin; break; }
      if (rwp.depMin !== null) { baseFirst = rwp.depMin; break; }
    }
    const trips = [];
    if (baseFirst === null) return { ...k, trips };
    const interval = Number(k.interval) || 0;
    const endTimeMin = toMin(k.endTime);
    let idx = 0;
    while (true) {
      const shift = interval > 0 ? idx * interval : 0;
      const shiftedFirst = baseFirst + shift;
      if (shiftedFirst > maxTime + 1e-6) break;
      if (endTimeMin !== null && shiftedFirst > endTimeMin + 1e-6) break;
      const points = [];
      let truncated = false;
      for (let wi = 0; wi < k.waypoints.length; wi++) {
        const wp = k.waypoints[wi];
        const rwp = resolved[wi];
        const si = stationIndex.get(wp.stationId);
        if (si === undefined) continue;
        const a = rwp.arrMin;
        const d = rwp.depMin;
        const x = stationX(si);
        const name = stationName.get(wp.stationId) || "";
        if (a !== null && d !== null && a !== d) {
          const aMin = a + shift;
          const dMin = d + shift;
          if (endTimeMin !== null && aMin > endTimeMin + 1e-6) { truncated = true; break; }
          points.push({
            x, y: timeY(aMin), t: toTimeStr(aMin), station: name, stationId: wp.stationId, min: aMin,
            wid: wp.wid, field: "arr", isManual: wp.arr !== "" && wp.arr !== undefined, shift, kursId: k.id,
          });
          if (endTimeMin !== null && dMin > endTimeMin + 1e-6) { truncated = true; break; }
          points.push({
            x, y: timeY(dMin), t: toTimeStr(dMin), station: name, stationId: wp.stationId, min: dMin,
            wid: wp.wid, field: "dep", isManual: wp.dep !== "" && wp.dep !== undefined, shift, kursId: k.id,
          });
        } else if (a !== null) {
          const aMin = a + shift;
          if (endTimeMin !== null && aMin > endTimeMin + 1e-6) { truncated = true; break; }
          points.push({
            x, y: timeY(aMin), t: toTimeStr(aMin), station: name, stationId: wp.stationId, min: aMin,
            wid: wp.wid, field: "both", isManual: wp.arr !== "" && wp.arr !== undefined, shift, kursId: k.id,
          });
        } else if (d !== null) {
          const dMin = d + shift;
          if (endTimeMin !== null && dMin > endTimeMin + 1e-6) { truncated = true; break; }
          points.push({
            x, y: timeY(dMin), t: toTimeStr(dMin), station: name, stationId: wp.stationId, min: dMin,
            wid: wp.wid, field: "dep", isManual: wp.dep !== "" && wp.dep !== undefined, shift, kursId: k.id,
          });
        }
      }
      if (points.length === 0) break;
      const anyInWindow = points.some((p) => p.y >= margin.top - 1 && p.y <= margin.top + chartH + 1);
      if (anyInWindow) trips.push({ tripId: `${k.id}-${idx}`, points });
      if (interval <= 0) break;
      if (truncated) break;
      idx++;
      if (idx > 500) break;
    }
    return { ...k, trips };
  });

  const conflictData = computeConflicts();
  const conflictSectionKeys = new Set(conflictData.sectionConflicts.map((c) => c.key));
  const conflictStationIds = new Set(conflictData.stationConflicts.map((c) => c.stationId));
  const visibleKurseCount = kurse.filter((k) => visible[k.id] !== false).length;

  let exportBlocks = null;
  let exportColumns = [];
  let exportPrintRows = [];
  if (tab === "export") {
    exportBlocks = buildExportBlocks();
    if (exportBlocks) {
      const exportWinStartMin = toMin(exportWinStart) ?? 0;
      const exportWinEndMin = toMin(exportWinEnd) ?? 24 * 60;
      const trips = buildExportTrips(Math.max(exportWinEndMin, 24 * 60));
      exportColumns = computeExportColumns(exportBlocks, trips, exportWinStartMin, exportWinEndMin);
      exportPrintRows = buildExportPrintRows(exportBlocks);
    }
  }

  // Renders the current preview (exportBlocks/exportColumns/exportPrintRows) into a real,
  // paginated PDF: trains are chunked into as many columns as fit the page width, each chunk
  // becomes its own page group repeating the full station list on the left.
  function handleExportPdf() {
    if (!exportBlocks || exportColumns.length === 0) return;
    setExportGenerating(true);
    setTimeout(() => {
      try {
        const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
        const pageWidth = doc.internal.pageSize.getWidth();
        const margin = 10;
        const stationColWidth = 40;
        const labelColWidth = 7;
        const minTrainColWidth = 15;
        const usableWidth = pageWidth - margin * 2 - stationColWidth - labelColWidth;
        const trainsPerPage = Math.max(1, Math.floor(usableWidth / minTrainColWidth));

        const title = pdfSafe(`${scenarioName || t("defaultScenarioName")}: ${exportLineSummary(exportBlocks)}`);
        const generatedAt = formatBuildTime(new Date().toISOString());

        const columnChunks = [];
        for (let i = 0; i < exportColumns.length; i += trainsPerPage) {
          columnChunks.push(exportColumns.slice(i, i + trainsPerPage));
        }

        columnChunks.forEach((chunk, chunkIdx) => {
          if (chunkIdx > 0) doc.addPage();
          const head = [[t("exportColStation"), "", ...chunk.map((c) => c.name)]];
          const body = [];
          exportPrintRows.forEach((row) => {
            if (row.type === "divider") {
              body.push([
                {
                  content: "",
                  colSpan: 2 + chunk.length,
                  styles: {
                    fillColor: [242, 244, 241],
                    minCellHeight: 2.5,
                    cellPadding: 0,
                    lineWidth: { top: 0.15, bottom: 0.15, left: 0, right: 0 },
                    lineColor: [215, 219, 213],
                  },
                },
              ]);
              return;
            }
            const st = stationsById.get(row.stationId);
            const rowArr = [];
            if (row.type !== "ab") {
              rowArr.push({
                content: st?.name || "",
                rowSpan: row.type === "an" ? 2 : 1,
                styles: row.echo ? { fontStyle: "italic", textColor: [132, 140, 130] } : { fontStyle: "bold" },
              });
              rowArr.push({ content: row.type === "an" ? "an" : "", styles: { fontSize: 6, textColor: [132, 140, 130] } });
            } else {
              rowArr.push({ content: "ab", styles: { fontSize: 6, textColor: [132, 140, 130] } });
            }
            chunk.forEach((c) => {
              const cell = c.cells[row.rowKey];
              const isSpanSymbol = cell && (cell.kind === "through" || cell.kind === "none" || cell.kind === "blank");
              if (row.type === "ab" && isSpanSymbol) return; // already rendered spanning from the "an" row
              rowArr.push({
                content: exportCellText(cell, row.type),
                rowSpan: row.type === "an" && isSpanSymbol ? 2 : 1,
                styles: isSpanSymbol
                  ? { halign: "center", valign: "middle", textColor: [190, 190, 190] }
                  : { halign: "center", valign: "middle" },
              });
            });
            body.push(rowArr);
          });

          autoTable(doc, {
            head,
            body,
            startY: 22,
            margin: { top: 22, left: margin, right: margin, bottom: 12 },
            styles: { fontSize: 7.5, cellPadding: 1.3, valign: "middle", lineColor: [215, 219, 213], lineWidth: 0.1 },
            headStyles: { fillColor: [23, 27, 31], textColor: [255, 255, 255], fontSize: 7.5, halign: "center" },
            columnStyles: { 0: { cellWidth: stationColWidth, halign: "left" }, 1: { cellWidth: labelColWidth, halign: "center" } },
            didDrawPage: () => {
              doc.setFontSize(11);
              doc.setFont(undefined, "bold");
              doc.text(title, margin, 12);
              doc.setFont(undefined, "normal");
              doc.setFontSize(8);
              doc.text(t("exportGeneratedAt", { date: generatedAt }), margin, 17);
              if (columnChunks.length > 1) {
                doc.text(`${chunkIdx + 1} / ${columnChunks.length}`, pageWidth - margin, 12, { align: "right" });
              }
            },
          });
        });

        const safeName = `${scenarioName || t("defaultScenarioName")}-timetable`.replace(/[^\w\-]+/g, "_");
        doc.save(`${safeName}.pdf`);
      } finally {
        setExportGenerating(false);
      }
    }, 0);
  }

  // Prüft, ob ein Zugsegment (p1→p2) auf einem überbelegten Abschnitt in dessen Konfliktzeitfenster
  // liegt. Deckt auch Durchfahrten über mehrere Stationen ab (jeder Teilabschnitt wird geprüft).
  function segmentTrackConflict(p1, p2) {
    if (conflictData.sectionWindows.size === 0) return false;
    if (p1.stationId === p2.stationId) return false;
    const path = pathBetween(p1.stationId, p2.stationId);
    if (!path || path.length < 2) return false;
    const s = Math.min(p1.min, p2.min);
    const e = Math.max(p1.min, p2.min);
    for (let i = 0; i < path.length - 1; i++) {
      const key = segKey(path[i], path[i + 1]);
      const byDir = conflictData.sectionWindows.get(key);
      if (!byDir) continue;
      const dir = path[i] === key.split("|")[0] ? "asc" : "desc";
      const wins = byDir[dir];
      if (!wins) continue;
      for (const [ws, we] of wins) {
        if (s < we - 1e-9 && ws < e - 1e-9) return true; // echte Zeitüberlappung
      }
    }
    return false;
  }

  function updateStation(id, field, value) {
    setStations((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }
  function addStation() {
    const maxOrder = mainStations.length ? Math.max(...mainStations.map((s) => s.order ?? 0)) : -1;
    const id = uid();
    setStations((prev) => [
      ...prev,
      { id, name: t("defaultStationName"), km: "", dwell: "", branchId: null, order: maxOrder + 1 },
    ]);
  }
  // Signals are lightweight points on the same ordered line as stations: only Name/Km/track
  // speed apply. They act as block boundaries for train-conflict detection (see computeConflicts /
  // capacityKeyMap) and get their own thin waypoint/max-speed leg, but are never a Kurs stop.
  function addSignal() {
    const maxOrder = mainStations.length ? Math.max(...mainStations.map((s) => s.order ?? 0)) : -1;
    const id = uid();
    setStations((prev) => [
      ...prev,
      { id, kind: "signal", name: t("defaultSignalName"), km: "", branchId: null, order: maxOrder + 1 },
    ]);
  }
  function removeStation(id) {
    setStations((prev) =>
      prev
        .filter((s) => s.id !== id)
        .map((s) =>
          s.branchId && branches.some((b) => b.id === s.branchId && b.fromStationId === id)
            ? { ...s, branchId: null }
            : s
        )
    );
    setBranches((prev) => prev.filter((b) => b.fromStationId !== id));
    setKurse((prev) =>
      prev.map((k) => ({ ...k, waypoints: k.waypoints.filter((wp) => wp.stationId !== id) }))
    );
  }
  function moveStation(id, dir) {
    setStations((prev) => {
      const st = prev.find((s) => s.id === id);
      if (!st) return prev;
      const groupBranch = st.branchId || null;
      const group = prev
        .filter((s) => (s.branchId || null) === groupBranch)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const idx = group.findIndex((s) => s.id === id);
      const swapIdx = idx + dir;
      if (idx < 0 || swapIdx < 0 || swapIdx >= group.length) return prev;
      const a = group[idx];
      const b = group[swapIdx];
      return prev.map((s) => {
        if (s.id === a.id) return { ...s, order: b.order ?? swapIdx };
        if (s.id === b.id) return { ...s, order: a.order ?? idx };
        return s;
      });
    });
  }
  function reorderStations(draggedId, targetId) {
    if (!draggedId || draggedId === targetId) return;
    setStations((prev) => {
      const draggedSt = prev.find((s) => s.id === draggedId);
      const targetSt = prev.find((s) => s.id === targetId);
      if (!draggedSt || !targetSt) return prev;
      const groupBranch = draggedSt.branchId || null;
      if ((targetSt.branchId || null) !== groupBranch) return prev; // nur innerhalb derselben Gruppe
      const group = prev
        .filter((s) => (s.branchId || null) === groupBranch)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const fromIdx = group.findIndex((s) => s.id === draggedId);
      const toIdx = group.findIndex((s) => s.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const newGroup = [...group];
      const [moved] = newGroup.splice(fromIdx, 1);
      newGroup.splice(toIdx, 0, moved);
      const orderMap = new Map(newGroup.map((s, i) => [s.id, i]));
      return prev.map((s) => (orderMap.has(s.id) ? { ...s, order: orderMap.get(s.id) } : s));
    });
  }
  function addBranch() {
    const id = uid();
    const fromStationId = mainStations[0] ? mainStations[0].id : "";
    setBranches((prev) => [...prev, { id, name: `Zweig ${prev.length + 1}`, fromStationId, direction: "after" }]);
  }
  function updateBranch(id, field, value) {
    setBranches((prev) => prev.map((b) => (b.id === id ? { ...b, [field]: value } : b)));
  }
  function removeBranch(id) {
    setBranches((prev) => prev.filter((b) => b.id !== id));
    setStations((prev) => prev.map((s) => (s.branchId === id ? { ...s, branchId: null } : s)));
  }
  // Drag-reorders a branch among its own side only ("before" branches among themselves, "after"
  // among themselves) — this order drives both the diagram's left-to-right panel order and the
  // timetable exporter's top-to-bottom block stacking.
  function reorderBranches(draggedId, targetId) {
    if (!draggedId || draggedId === targetId) return;
    setBranches((prev) => {
      const draggedBr = prev.find((b) => b.id === draggedId);
      const targetBr = prev.find((b) => b.id === targetId);
      if (!draggedBr || !targetBr) return prev;
      const dir = draggedBr.direction === "before" ? "before" : "after";
      if ((targetBr.direction === "before" ? "before" : "after") !== dir) return prev;
      const group = prev.filter((b) => (b.direction === "before" ? "before" : "after") === dir);
      const fromIdx = group.findIndex((b) => b.id === draggedId);
      const toIdx = group.findIndex((b) => b.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const newGroup = [...group];
      const [moved] = newGroup.splice(fromIdx, 1);
      newGroup.splice(toIdx, 0, moved);
      let gi = 0;
      return prev.map((b) => ((b.direction === "before" ? "before" : "after") === dir ? newGroup[gi++] : b));
    });
  }
  function toggleLineCollapsed(key) {
    setCollapsedLines((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function addVehicle() {
    const id = uid();
    setVehicles((prev) => [
      ...prev,
      { id, name: t("defaultVehicleName", { n: prev.length + 1 }), vmax: 100, accel: 0.7, decel: 0.8 },
    ]);
  }
  function updateVehicle(id, field, value) {
    setVehicles((prev) =>
      prev.map((v) => (v.id === id ? { ...v, [field]: field === "name" ? value : value === "" ? "" : Number(value) } : v))
    );
  }
  function removeVehicle(id) {
    setVehicles((prev) => prev.filter((v) => v.id !== id));
    setKurse((prev) => prev.map((k) => (k.vehicleType === id ? { ...k, vehicleType: "" } : k)));
  }
  function addStationToBranch(branchId) {
    const bStations = branchStationsMap.get(branchId) || [];
    const maxOrder = bStations.length ? Math.max(...bStations.map((s) => s.order ?? 0)) : -1;
    const id = uid();
    setStations((prev) => [
      ...prev,
      { id, name: t("defaultStationName"), km: "", dwell: "", branchId, order: maxOrder + 1 },
    ]);
  }
  function addSignalToBranch(branchId) {
    const bStations = branchStationsMap.get(branchId) || [];
    const maxOrder = bStations.length ? Math.max(...bStations.map((s) => s.order ?? 0)) : -1;
    const id = uid();
    setStations((prev) => [
      ...prev,
      { id, kind: "signal", name: t("defaultSignalName"), km: "", branchId, order: maxOrder + 1 },
    ]);
  }

  function addKurs() {
    const id = uid();
    const color = PALETTE[kurse.length % PALETTE.length];
    const firstStation = stoppableStations[0];
    setKurse((prev) => [
      ...prev,
      {
        id,
        name: t("defaultKursName", { n: prev.length + 1 }),
        color,
        interval: 0,
        endTime: "",
        vehicleType: vehicles[0] ? vehicles[0].id : "",
        waypoints: firstStation ? [{ wid: uid(), stationId: firstStation.id, arr: "", dep: "" }] : [],
      },
    ]);
    setVisible((prev) => ({ ...prev, [id]: true }));
  }
  function removeKurs(id) {
    setKurse((prev) => prev.filter((k) => k.id !== id));
  }
  function toggleKursCollapsed(id) {
    setCollapsedKurse((prev) => ({ ...prev, [id]: !prev[id] }));
  }
  function expandAllKurse() {
    setCollapsedKurse({});
  }
  function collapseAllKurse() {
    setCollapsedKurse(Object.fromEntries(kurse.map((k) => [k.id, true])));
  }
  function duplicateKurs(id) {
    setKurse((prev) => {
      const source = prev.find((k) => k.id === id);
      if (!source) return prev;
      const newId = uid();
      const copy = {
        ...source,
        id: newId,
        name: `${source.name} (Kopie)`,
        waypoints: source.waypoints.map((wp) => ({ ...wp, wid: uid() })),
      };
      const idx = prev.findIndex((k) => k.id === id);
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      setVisible((v) => ({ ...v, [newId]: true }));
      return next;
    });
  }
  function applyShift(id) {
    const delta = parseFloat(String(shiftInputs[id]).replace(",", "."));
    if (Number.isNaN(delta) || delta === 0) return;
    setKurse((prev) =>
      prev.map((k) => {
        if (k.id !== id) return k;
        return {
          ...k,
          waypoints: k.waypoints.map((wp) => {
            const a = toMin(wp.arr);
            const d = toMin(wp.dep);
            return {
              ...wp,
              arr: a !== null ? toTimeStr(a + delta) : wp.arr,
              dep: d !== null ? toTimeStr(d + delta) : wp.dep,
            };
          }),
        };
      })
    );
  }
  function updateKursField(id, field, value) {
    setKurse((prev) =>
      prev.map((k) => (k.id === id ? { ...k, [field]: field === "interval" ? Number(value) : value } : k))
    );
  }
  function addWaypoint(kursId) {
    setKurse((prev) =>
      prev.map((k) => {
        if (k.id !== kursId) return k;
        const lastStation = k.waypoints.length
          ? k.waypoints[k.waypoints.length - 1].stationId
          : stoppableStations[0] && stoppableStations[0].id;
        return {
          ...k,
          waypoints: [...k.waypoints, { wid: uid(), stationId: lastStation, arr: "", dep: "", dwell: "" }],
        };
      })
    );
  }
  function addStationRange(kursId) {
    const range = rangeInputs[kursId] || {};
    const fromId = range.from || (stoppableStations[0] && stoppableStations[0].id);
    const toId = range.to || (stoppableStations[stoppableStations.length - 1] && stoppableStations[stoppableStations.length - 1].id);
    if (!fromId || !toId) return;
    const fromIdx = stationIndex.get(fromId);
    const toIdx = stationIndex.get(toId);
    if (fromIdx === undefined || toIdx === undefined) return;
    const step = fromIdx <= toIdx ? 1 : -1;
    const newWaypoints = [];
    // Skip signals — a range only ever adds real, stoppable stations.
    for (let i = fromIdx; step > 0 ? i <= toIdx : i >= toIdx; i += step) {
      if (sortedStations[i].kind === "signal") continue;
      newWaypoints.push({ wid: uid(), stationId: sortedStations[i].id, arr: "", dep: "", dwell: "" });
    }
    setKurse((prev) =>
      prev.map((k) => (k.id === kursId ? { ...k, waypoints: [...k.waypoints, ...newWaypoints] } : k))
    );
  }
  function updateWaypoint(kursId, wid, field, value) {
    setKurse((prev) =>
      prev.map((k) => {
        if (k.id !== kursId) return k;
        return {
          ...k,
          waypoints: k.waypoints.map((wp) => (wp.wid === wid ? { ...wp, [field]: value } : wp)),
        };
      })
    );
  }
  function setPointTimeFromDrag(point, rawMin) {
    const snapped = Math.round(rawMin / 0.5) * 0.5; // 30-Sekunden-Raster
    const newBase = snapped - point.shift;
    const newStr = toTimeStr(newBase);
    setKurse((prev) =>
      prev.map((k) => {
        if (k.id !== point.kursId) return k;
        return {
          ...k,
          waypoints: k.waypoints.map((wp) => {
            if (wp.wid !== point.wid) return wp;
            if (point.field === "arr") return { ...wp, arr: newStr };
            if (point.field === "dep") return { ...wp, dep: newStr };
            // "both": zusammengeführter Punkt (keine Standzeit) – Ankunft immer setzen,
            // Abfahrt nur mitziehen, wenn sie bereits explizit gesetzt war
            return { ...wp, arr: newStr, dep: wp.dep !== "" && wp.dep !== undefined ? newStr : wp.dep };
          }),
        };
      })
    );
  }
  function unfixPoint(point) {
    setKurse((prev) =>
      prev.map((k) => {
        if (k.id !== point.kursId) return k;
        return {
          ...k,
          waypoints: k.waypoints.map((wp) => {
            if (wp.wid !== point.wid) return wp;
            if (point.field === "arr") return { ...wp, arr: "" };
            if (point.field === "dep") return { ...wp, dep: "" };
            return { ...wp, arr: "", dep: "" };
          }),
        };
      })
    );
    setContextMenu(null);
  }
  function splitDeparture(point) {
    const baseArr = point.min - point.shift;
    const arrStr = toTimeStr(baseArr);
    const depStr = toTimeStr(baseArr + 0.5); // +30 Sekunden
    setKurse((prev) =>
      prev.map((k) => {
        if (k.id !== point.kursId) return k;
        return {
          ...k,
          waypoints: k.waypoints.map((wp) =>
            wp.wid !== point.wid ? wp : { ...wp, arr: arrStr, dep: depStr }
          ),
        };
      })
    );
    setContextMenu(null);
  }
  function removeWaypoint(kursId, wid) {
    setKurse((prev) =>
      prev.map((k) => (k.id === kursId ? { ...k, waypoints: k.waypoints.filter((wp) => wp.wid !== wid) } : k))
    );
  }
  function moveWaypoint(kursId, wid, dir) {
    setKurse((prev) =>
      prev.map((k) => {
        if (k.id !== kursId) return k;
        const idx = k.waypoints.findIndex((wp) => wp.wid === wid);
        const swapIdx = idx + dir;
        if (idx < 0 || swapIdx < 0 || swapIdx >= k.waypoints.length) return k;
        const wps = [...k.waypoints];
        [wps[idx], wps[swapIdx]] = [wps[swapIdx], wps[idx]];
        return { ...k, waypoints: wps };
      })
    );
  }
  function reorderWaypoints(kursId, draggedWid, targetWid) {
    if (!draggedWid || draggedWid === targetWid) return;
    setKurse((prev) =>
      prev.map((k) => {
        if (k.id !== kursId) return k;
        const wps = [...k.waypoints];
        const fromIdx = wps.findIndex((wp) => wp.wid === draggedWid);
        const toIdx = wps.findIndex((wp) => wp.wid === targetWid);
        if (fromIdx === -1 || toIdx === -1) return k;
        const [moved] = wps.splice(fromIdx, 1);
        wps.splice(toIdx, 0, moved);
        return { ...k, waypoints: wps };
      })
    );
  }

  function parseCsv(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return { added: 0, error: t("msgNoData") };
    let start = 0;
    if (/^kurs/i.test(lines[0]) || /^zug/i.test(lines[0])) start = 1;
    const stationByName = new Map(stations.map((s) => [s.name.toLowerCase(), s.id]));
    let newStations = [...stations];
    const kursMap = new Map(kurse.map((k) => [k.name, { ...k, waypoints: [...k.waypoints] }]));
    const seenOrder = [];
    let added = 0;
    for (let i = start; i < lines.length; i++) {
      const parts = lines[i].split(",").map((p) => p.trim());
      if (parts.length < 5) continue;
      const [kursName, farbe, stationNameVal, ank, ab, takt, endzeit, haltezeit] = parts;
      if (!kursName || !stationNameVal) continue;
      let stationId = stationByName.get(stationNameVal.toLowerCase());
      if (!stationId) {
        stationId = uid();
        const nextOrder = newStations.length
          ? Math.max(...newStations.map((s) => s.order ?? toKm(s.km))) + 1
          : 0;
        newStations = [...newStations, { id: stationId, name: stationNameVal, km: "", order: nextOrder }];
        stationByName.set(stationNameVal.toLowerCase(), stationId);
      }
      if (!kursMap.has(kursName)) {
        const color = /^#/.test(farbe) ? farbe : PALETTE[kursMap.size % PALETTE.length];
        kursMap.set(kursName, {
          id: uid(),
          name: kursName,
          color,
          interval: takt ? Number(takt) : 0,
          endTime: endzeit || "",
          vehicleType: vehicles[0] ? vehicles[0].id : "",
          waypoints: [],
        });
        seenOrder.push(kursName);
      } else {
        if (takt) kursMap.get(kursName).interval = Number(takt);
        if (endzeit) kursMap.get(kursName).endTime = endzeit;
      }
      kursMap.get(kursName).waypoints.push({
        wid: uid(),
        stationId,
        arr: ank || "",
        dep: ab || "",
        dwell: haltezeit || "",
      });
      added++;
    }
    setStations(newStations);
    setKurse(Array.from(kursMap.values()));
    return { added, error: added === 0 ? t("msgNoValidRows") : "" };
  }

  function handleCsvImport() {
    const result = parseCsv(csvText);
    setCsvMsg(result.error || t("msgHaltImported", { n: result.added }));
  }

  function handleFileUpload(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target.result || "");
      setCsvText(text);
      const result = parseCsv(text);
      setCsvMsg(result.error || t("msgHaltImported", { n: result.added }));
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function safeFileName() {
    return (
      (scenarioName || "fahrplan").trim().replace(/[^a-z0-9äöüß_\- ]/gi, "").replace(/\s+/g, "-") ||
      "fahrplan"
    );
  }

  // The full scenario as plain data — shared by local JSON export and cloud (Firestore) save,
  // so both write/read exactly the same shape.
  function scenarioData() {
    return {
      type: "grafischer-fahrplan-szenario",
      version: 4,
      name: scenarioName || "Fahrplan",
      stations,
      branches,
      kurse,
      vehicles,
      yMode,
      winStart,
      winEnd,
      maxSpeeds,
      trackCounts,
    };
  }
  function exportScenario() {
    const data = scenarioData();
    const name = safeFileName();
    downloadFile(JSON.stringify(data, null, 2), `${name}.json`, "application/json");
    setSaveMsg(t("msgSavedAs", { name }));
  }

  function csvEscape(v) {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportKurseCsv() {
    const rows = [["Kurs", "Farbe", "Station", "Ankunft", "Abfahrt", "Takt", "Endzeit", "Haltezeit"]];
    kurse.forEach((k) => {
      k.waypoints.forEach((wp) => {
        rows.push([
          k.name,
          k.color,
          stationName.get(wp.stationId) || "",
          wp.arr || "",
          wp.dep || "",
          k.interval || 0,
          k.endTime || "",
          wp.dwell || "",
        ]);
      });
    });
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    const name = safeFileName();
    downloadFile(csv, `${name}-kurse.csv`, "text/csv");
    setSaveMsg(t("msgKurseSaved", { name }));
  }

  function exportStationsCsv() {
    const rows = [["Station", "Km", "Haltezeit", "Zweig"]];
    sortedStations.forEach((s) =>
      rows.push([s.name, s.km, s.dwell || "", branches.find((b) => b.id === s.branchId)?.name || ""])
    );
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    const name = safeFileName();
    downloadFile(csv, `${name}-stationen.csv`, "text/csv");
    setSaveMsg(t("msgStationsSaved", { name }));
  }

  // Applies a parsed scenario object (from a local .json file or a Firestore project doc) to
  // app state. Returns true on success, false if the shape is invalid.
  function applyScenarioData(data) {
    if (!data || !Array.isArray(data.stations) || !Array.isArray(data.kurse)) return false;
    setStations(data.stations);
    setBranches(Array.isArray(data.branches) ? data.branches : []);
    setKurse(data.kurse);
    setVehicles(Array.isArray(data.vehicles) && data.vehicles.length ? data.vehicles : initialVehicles);
    if (data.yMode) setYMode(data.yMode);
    if (data.winStart) setWinStart(data.winStart);
    if (data.winEnd) setWinEnd(data.winEnd);
    if (data.name) setScenarioName(data.name);
    setMaxSpeeds(data.maxSpeeds && typeof data.maxSpeeds === "object" ? data.maxSpeeds : {});
    setTrackCounts(data.trackCounts && typeof data.trackCounts === "object" ? data.trackCounts : {});
    setVisible(Object.fromEntries(data.kurse.map((k) => [k.id, true])));
    return true;
  }
  function loadScenarioFromText(text) {
    try {
      const data = JSON.parse(text);
      if (!applyScenarioData(data)) {
        setSaveMsg(t("msgInvalidScenario"));
        return;
      }
      setSaveMsg(t("msgLoaded", { name: data.name || t("defaultScenarioName") }));
    } catch (err) {
      setSaveMsg(t("msgLoadFailed"));
    }
  }

  // --- Cloud projects (Firestore, per-user) ---
  function cloudProjectsCollection(uid) {
    return collection(db, "users", uid, "projects");
  }
  async function fetchCloudProjects() {
    if (!authUser) return [];
    setCloudProjectsLoading(true);
    try {
      const q = query(cloudProjectsCollection(authUser.uid), orderBy("updatedAt", "desc"));
      const snap = await getDocs(q);
      const list = snap.docs.map((d) => {
        const v = d.data();
        const inner = v.data || {};
        return {
          id: d.id,
          name: v.name || t("defaultScenarioName"),
          updatedAt: v.updatedAt && v.updatedAt.toDate ? v.updatedAt.toDate() : null,
          stationCount: Array.isArray(inner.stations) ? inner.stations.length : 0,
          kursCount: Array.isArray(inner.kurse) ? inner.kurse.length : 0,
        };
      });
      setCloudProjects(list);
      return list;
    } catch (err) {
      setCloudMsg(t("cloudErrGeneric", { msg: err.message || String(err) }));
      return [];
    } finally {
      setCloudProjectsLoading(false);
    }
  }
  async function loadCloudProject(id) {
    if (!authUser || !id) return;
    setCloudBusy(true);
    setCloudMsg("");
    try {
      const snap = await getDoc(doc(db, "users", authUser.uid, "projects", id));
      if (!snap.exists()) {
        setCloudMsg(t("cloudErrNotFound"));
        return;
      }
      const v = snap.data();
      applyScenarioData(v.data);
      setScenarioName(v.name || t("defaultScenarioName"));
      setCurrentCloudProjectId(id);
      setSelectedCloudProjectId(id);
      setSaveMsg(t("msgLoaded", { name: v.name || t("defaultScenarioName") }));
    } catch (err) {
      setCloudMsg(t("cloudErrGeneric", { msg: err.message || String(err) }));
    } finally {
      setCloudBusy(false);
    }
  }
  async function saveCloudProject(asNew) {
    if (!authUser) return;
    setCloudBusy(true);
    setCloudMsg("");
    try {
      const payload = {
        name: scenarioName || t("defaultScenarioName"),
        data: scenarioData(),
        updatedAt: serverTimestamp(),
      };
      if (currentCloudProjectId && !asNew) {
        await setDoc(doc(db, "users", authUser.uid, "projects", currentCloudProjectId), payload);
      } else {
        const ref = await addDoc(cloudProjectsCollection(authUser.uid), payload);
        setCurrentCloudProjectId(ref.id);
        setSelectedCloudProjectId(ref.id);
      }
      setCloudMsg(t("cloudSaved"));
      fetchCloudProjects();
    } catch (err) {
      setCloudMsg(t("cloudErrGeneric", { msg: err.message || String(err) }));
    } finally {
      setCloudBusy(false);
    }
  }
  // On sign-in, load the most recently edited cloud project automatically (once per session).
  useEffect(() => {
    if (authUser) {
      if (autoLoadedUidRef.current !== authUser.uid) {
        autoLoadedUidRef.current = authUser.uid;
        (async () => {
          const list = await fetchCloudProjects();
          if (list.length) await loadCloudProject(list[0].id);
        })();
      }
    } else {
      autoLoadedUidRef.current = null;
      setCloudProjects([]);
      setCurrentCloudProjectId(null);
      setSelectedCloudProjectId("");
      setCloudMsg("");
    }
  }, [authUser]);

  function authErrorMessage(err) {
    const code = err && err.code;
    if (code === "auth/invalid-email") return t("authErrInvalidEmail");
    if (code === "auth/email-already-in-use") return t("authErrEmailInUse");
    if (code === "auth/weak-password") return t("authErrWeakPassword");
    if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found")
      return t("authErrInvalidCredential");
    return (err && err.message) || String(err);
  }
  async function handleAuthSubmit(e) {
    e.preventDefault();
    setAuthError("");
    setAuthBusy(true);
    try {
      if (authMode === "signup") {
        await createUserWithEmailAndPassword(auth, authEmail, authPassword);
      } else {
        await signInWithEmailAndPassword(auth, authEmail, authPassword);
      }
      setAuthPassword("");
    } catch (err) {
      setAuthError(authErrorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  }
  async function handleSignOut() {
    await signOut(auth);
  }
  async function handlePasswordReset() {
    setAuthError("");
    if (!authEmail) {
      setAuthError(t("authErrNeedEmailForReset"));
      return;
    }
    setAuthBusy(true);
    try {
      await sendPasswordResetEmail(auth, authEmail);
      setAuthError(t("authResetSent"));
    } catch (err) {
      setAuthError(authErrorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  }

  function handleLoadFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => loadScenarioFromText(String(ev.target.result || ""));
    reader.readAsText(file);
    e.target.value = "";
  }

  // Schematisches Streckenband: zeichnet für eine Stationsfolge je Station so viele parallele
  // Linien wie Stationsgleise und je Abschnitt so viele wie Streckengleise. Läuft vertikal
  // synchron zur Stationstabelle (gleiche Zeilenhöhe ROW_H, halbe Höhe oben/unten als Rand).
  function RouteBand({ stationList }) {
    const ROW_H = 41; // muss zur Tabellenzeilenhöhe passen
    const TOP_PAD = 8;
    const STATION_HALF = 8; // halbe Länge des Stationsknoten-Segments (in Laufrichtung = vertikal)
    const n = stationList.length;
    if (n === 0) return null;
    const height = TOP_PAD * 2 + n * ROW_H;
    const maxTracks = Math.max(
      1,
      ...stationList.map((s) => Math.max(0, parseInt(s.stationTracks, 10) || 0)),
      ...stationList.slice(1).map((s, i) => Math.max(0, capacityAt(segKey(stationList[i].id, s.id)) || 0))
    );
    const trackGap = 4;
    const width = 24 + maxTracks * trackGap;
    const cx = width / 2;
    const rowCenter = (i) => TOP_PAD + i * ROW_H + ROW_H / 2;
    // x-Positionen für t parallele (vertikale) Gleislinien, zentriert um cx
    const laneXs = (t) => {
      const xs = [];
      for (let i = 0; i < t; i++) xs.push(cx + (i - (t - 1) / 2) * trackGap);
      return xs;
    };
    return (
      <svg width={width} height={height} style={{ flexShrink: 0, display: "block" }}>
        {/* Abschnitte: M durchgehende vertikale Linien zwischen den Stationen */}
        {stationList.slice(1).map((s, i) => {
          const key = segKey(stationList[i].id, s.id);
          const t = Math.max(0, capacityAt(key) || 0);
          // No gap on a signal's side — the line stays unbroken through it.
          const y1 = rowCenter(i) + (stationList[i].kind !== "signal" ? STATION_HALF : 0);
          const y2 = rowCenter(i + 1) - (s.kind !== "signal" ? STATION_HALF : 0);
          if (t === 0) {
            return <line key={key} x1={cx} y1={y1} x2={cx} y2={y2} stroke="#D7DBD5" strokeWidth="1" strokeDasharray="2 3" />;
          }
          return (
            <g key={key}>
              {laneXs(t).map((x, li) => (
                <line
                  key={li} x1={x} y1={y1} x2={x} y2={y2}
                  stroke="#171B1F"
                  strokeWidth={1.6}
                />
              ))}
            </g>
          );
        })}
        {/* Stationen: N kurze vertikale Segmente (fixe Länge); Signale: ein kurzer Punkt je Gleis */}
        {stationList.map((s, i) => {
          const y = rowCenter(i);
          if (s.kind === "signal") {
            const neighborKey = i > 0 ? segKey(stationList[i - 1].id, s.id) : null;
            const t = Math.max(1, (neighborKey !== null ? capacityAt(neighborKey) : null) || 0);
            return (
              <g key={s.id}>
                {laneXs(t).map((x, li) => (
                  <circle key={li} cx={x} cy={y} r="1.3" fill="#171B1F" />
                ))}
              </g>
            );
          }
          const raw = parseInt(s.stationTracks, 10);
          const t = Math.max(0, isNaN(raw) ? 0 : raw);
          if (t === 0) {
            return <circle key={s.id} cx={cx} cy={y} r="2.4" fill="#fff" stroke="#848C82" strokeWidth="1" />;
          }
          return (
            <g key={s.id}>
              {laneXs(t).map((x, li) => (
                <line
                  key={li} x1={x} y1={y - STATION_HALF} x2={x} y2={y + STATION_HALF}
                  stroke="#171B1F"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                />
              ))}
            </g>
          );
        })}
      </svg>
    );
  }

  const IconDiagram = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M2 13 L14 3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 4 L14 11" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
  const IconStations = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M2 8 L8 2.5 L14 8" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M3.5 7 V13.5 H12.5 V7" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
  const IconKurse = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 12.5 L13.5 3.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="2.5" cy="12.5" r="1.4" fill="currentColor" />
      <circle cx="13.5" cy="3.5" r="1.4" fill="currentColor" />
    </svg>
  );
  const IconVehicles = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="2.5" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 8.5 H13" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.5" cy="13" r="1.1" fill="currentColor" />
      <circle cx="10.5" cy="13" r="1.1" fill="currentColor" />
    </svg>
  );
  const IconImport = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M8 2 V9.5 M5 6.5 L8 9.5 L11 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 12 H13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
  const IconSave = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path d="M3 2.5 H11 L13 4.5 V13 H3 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <rect x="5" y="2.5" width="4.5" height="3.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="5" y="9" width="6" height="4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
  const IconExport = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2.5" width="12" height="11" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 6.5 H14 M6 6.5 V13.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
  const IconCollapse = ({ collapsed }) => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
      {collapsed ? (
        <path d="M6 3 L11 8 L6 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M10 3 L5 8 L10 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
  const IconAccount = () => (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="5.5" r="2.7" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 13.5 C2.5 10.5 5 9 8 9 C11 9 13.5 10.5 13.5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );

  const navMain = [
    { key: "diagram", label: t("tabDiagram"), Icon: IconDiagram },
    { key: "export", label: t("tabExport"), Icon: IconExport },
  ];
  const navData = [
    { key: "stations", label: t("tabStations"), Icon: IconStations },
    { key: "kurse", label: t("tabKurse"), Icon: IconKurse },
    { key: "vehicles", label: t("tabVehicles"), Icon: IconVehicles },
  ];
  const navFile = [
    { key: "csv", label: t("tabCsv"), Icon: IconImport },
    { key: "save", label: t("tabSave"), Icon: IconSave },
  ];
  const navAccount = [
    { key: "account", label: t("tabAccount"), Icon: IconAccount },
  ];
  function renderNavItem({ key, label, Icon }) {
    const active = tab === key;
    return (
      <button
        key={key}
        onClick={() => setTab(key)}
        title={sidebarCollapsed ? label : undefined}
        style={{
          ...styles.navItem,
          ...(active ? styles.navItemActive : {}),
          justifyContent: sidebarCollapsed ? "center" : "flex-start",
        }}
      >
        <Icon />
        {!sidebarCollapsed && <span>{label}</span>}
      </button>
    );
  }

  function renderExportBranchRow(br) {
    const chain = chainFor(br.id).filter((s) => s.kind !== "signal");
    const enabled = !!exportBranchEnabled[br.id];
    return (
      <div key={br.id} style={styles.exportLineRow}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            setExportBranchEnabled((prev) => ({ ...prev, [br.id]: e.target.checked }))
          }
        />
        <span style={styles.exportLineName}>{br.name}</span>
        <select
          value={exportBranchFromId[br.id] || ""}
          onChange={(e) =>
            setExportBranchFromId((prev) => ({ ...prev, [br.id]: e.target.value }))
          }
          disabled={!enabled}
        >
          <option value="">—</option>
          {chain.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <span style={styles.exportLineToLabel}>{t("rangeTo")}</span>
        <select
          value={exportBranchToId[br.id] || ""}
          onChange={(e) =>
            setExportBranchToId((prev) => ({ ...prev, [br.id]: e.target.value }))
          }
          disabled={!enabled}
        >
          <option value="">—</option>
          {chain.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
    );
  }

  function renderBranchBlock(br) {
    const bStations = branchStationsMap.get(br.id) || [];
    const attachStation = mainStations.find((s) => s.id === br.fromStationId);
    const isMirrored = br.direction === "before";
    const isCollapsed = !!collapsedLines[br.id];
    return (
      <div
        key={br.id}
        onDragOver={(e) => {
          e.preventDefault();
          if (dragOverBranchId !== br.id) setDragOverBranchId(br.id);
        }}
        onDragLeave={() => {
          setDragOverBranchId((prev) => (prev === br.id ? null : prev));
        }}
        onDrop={(e) => {
          e.preventDefault();
          reorderBranches(draggedBranchId, br.id);
          setDraggedBranchId(null);
          setDragOverBranchId(null);
        }}
        style={{
          marginBottom: 20,
          paddingBottom: 16,
          borderBottom: "1px solid #D7DBD5",
          opacity: draggedBranchId === br.id ? 0.4 : 1,
          borderTop: dragOverBranchId === br.id && draggedBranchId !== br.id ? "2px solid #9C7A2E" : undefined,
        }}
      >
        <div style={styles.rangeRow}>
          <button
            onClick={() => toggleLineCollapsed(br.id)}
            style={styles.chevronBtn}
            aria-label={isCollapsed ? t("expandKurs") : t("collapseKurs")}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
          <span
            draggable
            onDragStart={(e) => {
              setDraggedBranchId(br.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDraggedBranchId(null);
              setDragOverBranchId(null);
            }}
            style={styles.dragHandle}
            aria-label={t("dragHandle")}
            title={t("dragHandle")}
          >
            ⠿
          </span>
          <input
            type="text"
            value={br.name}
            onChange={(e) => updateBranch(br.id, "name", e.target.value)}
            style={{ width: 140, fontWeight: 600 }}
            placeholder={t("branchNamePlaceholder")}
          />
          <button
            onClick={() => updateBranch(br.id, "direction", isMirrored ? "after" : "before")}
            style={styles.addBtnSmall}
            title={t("branchDirectionToggleHint")}
          >
            {isMirrored ? t("branchDirectionBefore") : t("branchDirectionAfter")}
          </button>
          <span style={{ fontSize: 12, color: "#848C82" }}>{isMirrored ? t("branchJoinsAt") : t("branchesFrom")}</span>
          <select
            value={br.fromStationId}
            onChange={(e) => updateBranch(br.id, "fromStationId", e.target.value)}
          >
            {mainStations.map((st) => (
              <option key={st.id} value={st.id}>{st.name}</option>
            ))}
          </select>
          <button onClick={() => removeBranch(br.id)} style={styles.iconBtn} aria-label={t("removeBranch")}>
            {t("removeBranch")}
          </button>
        </div>
        {!isCollapsed && (
          <>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
          <div style={{ overflowX: "auto", flex: 1 }}>
          <table className="station-table" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th style={{ width: 70 }}></th>
                <th style={{ width: 220 }}>{t("colName")}</th>
                <th style={{ width: 110 }}>{t("colKm")}</th>
                <th style={{ width: 90 }}>{t("colDistance")}</th>
                <th style={{ width: 100 }}>{t("colMaxSpeed")}</th>
                <th style={{ width: 90 }}>{t("colStationTracks")}</th>
                <th style={{ width: 90 }}>{t("colTracks")}</th>
                <th style={{ width: 120 }}>{t("colDwell")}</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                return attachStation ? (
                  <tr style={{ background: "#F2F4F1" }}>
                    <td></td>
                    <td style={{ color: "#848C82" }}>{attachStation.name} ⑂</td>
                    <td>
                      <input
                        type="text"
                        value="0"
                        disabled
                        style={{ width: 90, background: "#E9ECE7", color: "#848C82" }}
                      />
                    </td>
                    <td className="mono" style={{ color: "#848C82", fontSize: 12 }}>{t("distanceFirst")}</td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td></td>
                  </tr>
                ) : null;
              })()}
              {bStations.map((st, idx) => {
                const isSignal = st.kind === "signal";
                return (
                <tr
                  key={st.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragOverStationId !== st.id) setDragOverStationId(st.id);
                  }}
                  onDragLeave={() => {
                    setDragOverStationId((prev) => (prev === st.id ? null : prev));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    reorderStations(draggedStationId, st.id);
                    setDraggedStationId(null);
                    setDragOverStationId(null);
                  }}
                  style={{
                    opacity: draggedStationId === st.id ? 0.4 : 1,
                    background: isSignal ? "#F5F1E8" : undefined,
                    borderTop: dragOverStationId === st.id && draggedStationId !== st.id ? "2px solid #9C7A2E" : undefined,
                  }}
                >
                  <td>
                    <span
                      draggable
                      onDragStart={(e) => {
                        setDraggedStationId(st.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDraggedStationId(null);
                        setDragOverStationId(null);
                      }}
                      style={styles.dragHandle}
                      aria-label={t("dragHandle")}
                      title={t("dragHandle")}
                    >
                      ⠿
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="text"
                        value={st.name}
                        onChange={(e) => updateStation(st.id, "name", e.target.value)}
                        style={{ width: "100%" }}
                      />
                      {isSignal && <span style={styles.signalBadge}>{t("signalBadge")}</span>}
                    </div>
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={st.km}
                      onChange={(e) => updateStation(st.id, "km", e.target.value)}
                      style={{ width: 90 }}
                      placeholder={t("kmOptional")}
                    />
                  </td>
                  <td className="mono" style={{ color: "#848C82", fontSize: 12 }}>
                    {(() => {
                      const cur = kmOrNull(st.km);
                      const prev = idx === 0 ? 0 : kmOrNull(bStations[idx - 1].km);
                      if (cur === null || prev === null) return t("distanceFirst");
                      const d = cur - prev;
                      return `${d < 0 ? "⚠ " : ""}${d.toFixed(2)} km`;
                    })()}
                  </td>
                  <td>
                    {(() => {
                      const prevId = idx === 0 ? (attachStation && attachStation.id) : bStations[idx - 1].id;
                      if (!prevId) return null;
                      const key = segKey(prevId, st.id);
                      return (
                        <input
                          type="number"
                          step="1"
                          min="0"
                          value={maxSpeeds[key] ?? ""}
                          onChange={(e) => setMaxSpeeds((prev) => ({ ...prev, [key]: e.target.value }))}
                          style={{ width: 80 }}
                          placeholder="km/h"
                        />
                      );
                    })()}
                  </td>
                  <td>
                    {isSignal ? (
                      <span style={{ color: "#848C82" }}>—</span>
                    ) : (
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={st.stationTracks ?? ""}
                        onChange={(e) => updateStation(st.id, "stationTracks", e.target.value)}
                        style={{ width: 60 }}
                        placeholder="—"
                      />
                    )}
                  </td>
                  <td>
                    {isSignal ? (
                      <span style={{ color: "#848C82" }}>—</span>
                    ) : (() => {
                      const chain = attachStation ? [attachStation, ...bStations] : bStations;
                      const prevId = prevRealId(chain, attachStation ? idx + 1 : idx);
                      if (!prevId) return null;
                      const key = segKey(prevId, st.id);
                      return (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={trackCounts[key] ?? ""}
                          onChange={(e) => setTrackCounts((prev) => ({ ...prev, [key]: e.target.value }))}
                          style={{ width: 60 }}
                          placeholder="—"
                        />
                      );
                    })()}
                  </td>
                  <td>
                    {isSignal ? (
                      <span style={{ color: "#848C82" }}>—</span>
                    ) : (
                      <input
                        type="text"
                        inputMode="numeric"
                        value={st.dwell ?? ""}
                        onChange={(e) => updateStation(st.id, "dwell", e.target.value)}
                        style={{ width: 90 }}
                        placeholder="MM:SS"
                      />
                    )}
                  </td>
                  <td>
                    <button
                      onClick={() => removeStation(st.id)}
                      style={styles.iconBtn}
                      aria-label={isSignal ? t("removeSignal") : t("removeStation")}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {(() => {
            const bandStations = attachStation ? [attachStation, ...bStations] : bStations;
            return bandStations.length > 0 ? (
              <div style={{ paddingTop: 25 }} title={t("routeBandTitle")}>
                <RouteBand stationList={bandStations} />
              </div>
            ) : null;
          })()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => addStationToBranch(br.id)} style={styles.addBtn}>
              {t("addStationToBranch", { name: br.name })}
            </button>
            <button onClick={() => addSignalToBranch(br.id)} style={styles.addBtn} title={t("signalHint")}>
              {t("addSignalToBranch", { name: br.name })}
            </button>
          </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; font-family: 'Space Grotesk', sans-serif; }
        .mono { font-family: 'IBM Plex Mono', monospace; }
        input[type=text], input[type=number], input[type=time], input[type=color], select {
          font-family: 'IBM Plex Mono', monospace;
          border: 1px solid #D7DBD5;
          border-radius: 3px;
          padding: 4px 6px;
          font-size: 13px;
          background: #fff;
          color: #171B1F;
        }
        input[type=text]:focus, input[type=number]:focus, input[type=time]:focus, select:focus {
          outline: none;
          border-color: #9C7A2E;
          box-shadow: 0 0 0 2px rgba(232,163,61,0.25);
        }
        button { cursor: pointer; font-family: 'Space Grotesk', sans-serif; }
        .kurs-name-input:focus { outline: none; border-bottom-color: #9C7A2E; }
        .kurs-name-input::placeholder { color: #848C82; font-weight: 500; }
        input[type=color] { cursor: pointer; }
        .ghost-btn:hover { color: #171B1F; text-decoration: underline; }
        .ghost-btn-danger:hover { color: #A32D2D; }
        table { border-collapse: collapse; width: 100%; }
        th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #D7DBD5; }
        th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #5C6570; font-weight: 600; }
        .station-table tbody tr { height: 41px; }
        .station-table tbody td { height: 41px; box-sizing: border-box; }
        .station-table thead th { height: 33px; box-sizing: border-box; }
      `}</style>

      <div style={styles.appShell}>
        <nav style={{ ...styles.sidebar, width: sidebarCollapsed ? 56 : 208 }}>
          <div style={styles.sidebarTop}>
            {!sidebarCollapsed && <span style={styles.brandName}>{t("title")}</span>}
            <button
              onClick={() => setSidebarCollapsed((p) => !p)}
              style={styles.collapseBtn}
              aria-label={sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
            >
              <IconCollapse collapsed={sidebarCollapsed} />
            </button>
          </div>

          <div style={styles.navGroup}>{navMain.map(renderNavItem)}</div>

          <div style={styles.navGroup}>
            {!sidebarCollapsed && <div style={styles.navGroupLabel}>{t("groupData")}</div>}
            {navData.map(renderNavItem)}
          </div>

          <div style={styles.navGroup}>
            {!sidebarCollapsed && <div style={styles.navGroupLabel}>{t("groupFile")}</div>}
            {navFile.map(renderNavItem)}
          </div>

          <div style={styles.navGroup}>
            {!sidebarCollapsed && <div style={styles.navGroupLabel}>{t("groupAccount")}</div>}
            {navAccount.map(renderNavItem)}
          </div>

          <div style={styles.sidebarFooter}>
            {!sidebarCollapsed && (
              <div style={styles.versionInfo} title={BUILD_TIME || undefined}>
                v{APP_VERSION} · {formatBuildTime(BUILD_TIME)}
              </div>
            )}
            <div ref={langMenuRef} style={styles.langMenuWrap}>
              <button
                onClick={() => setLangMenuOpen((o) => !o)}
                style={{
                  ...styles.langToggleSidebar,
                  justifyContent: sidebarCollapsed ? "center" : "space-between",
                }}
                aria-haspopup="listbox"
                aria-expanded={langMenuOpen}
                aria-label={t("languageLabel")}
                title={sidebarCollapsed ? t("languageLabel") : undefined}
              >
                <span>{sidebarCollapsed ? lang.toUpperCase() : (LANGUAGES.find((l) => l.code === lang) || {}).label || lang}</span>
                {!sidebarCollapsed && <span style={styles.dropdownCaret}>▾</span>}
              </button>
              {langMenuOpen && (
                <div style={styles.langMenu} role="listbox" aria-label={t("languageLabel")}>
                  {LANGUAGES.map((l) => (
                    <button
                      key={l.code}
                      type="button"
                      role="option"
                      aria-selected={lang === l.code}
                      onClick={() => {
                        setLang(l.code);
                        setLangMenuOpen(false);
                      }}
                      style={{
                        ...styles.langMenuItem,
                        ...(lang === l.code ? styles.langMenuItemActive : {}),
                      }}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </nav>

        <div style={{ ...styles.mainArea, ...(tab === "diagram" ? {} : styles.mainAreaScroll) }}>

      {tab === "diagram" && stations.length === 0 && (
        <div style={styles.emptyState}>
          <p style={{ margin: "0 0 10px", fontWeight: 500 }}>{t("emptyTitle")}</p>
          <p style={{ margin: "0 0 14px", color: "#5C6570" }}>{t("emptyDesc")}</p>
          <button onClick={() => setTab("save")} style={styles.addBtn}>{t("emptyButton")}</button>
        </div>
      )}

      {tab === "diagram" && stations.length > 0 && (
        <div style={styles.diagramTab}>
          <div style={styles.toolbarRow}>
            <div style={styles.segmented}>
              <button
                onClick={() => setYMode("proportional")}
                style={{ ...styles.segBtn, ...(yMode === "proportional" ? styles.segBtnActive : {}) }}
              >
                {t("modeProportional")}
              </button>
              <button
                onClick={() => setYMode("schematic")}
                style={{ ...styles.segBtn, ...(yMode === "schematic" ? styles.segBtnActive : {}) }}
              >
                {t("modeSchematic")}
              </button>
            </div>
            <span style={styles.toolbarSep} />
            <label style={styles.windowLabel}>
              {t("windowFrom")}
              <input type="time" value={winStart} onChange={(e) => setWinStart(e.target.value)} />
            </label>
            <label style={styles.windowLabel}>
              {t("windowTo")}
              <input type="time" value={winEnd} onChange={(e) => setWinEnd(e.target.value)} />
            </label>
            <span style={styles.toolbarSep} />
            <div style={styles.zoomCluster} title={t("zoomHint")}>
              <span style={styles.zoomIcon}>↕</span>
              <button onClick={() => zoomBy(1 / 1.3)} style={styles.stepBtn} aria-label={t("zoomOutLabel")}>−</button>
              <span style={styles.zoomVal}>{Math.round((pxPerMin / 6) * 100)}%</span>
              <button onClick={() => zoomBy(1.3)} style={styles.stepBtn} aria-label={t("zoomInLabel")}>+</button>
              <button onClick={resetZoom} style={styles.stepBtnReset} aria-label={t("zoomReset")}>⟳</button>
            </div>
            <div style={styles.zoomCluster}>
              <span style={styles.zoomIcon}>↔</span>
              <button onClick={() => widthZoomBy(1 / 1.2)} style={styles.stepBtn} aria-label={t("widthOutLabel")}>−</button>
              <span style={styles.zoomVal}>{Math.round((stationSpacing / 72) * 100)}%</span>
              <button onClick={() => widthZoomBy(1.2)} style={styles.stepBtn} aria-label={t("widthInLabel")}>+</button>
              <button onClick={resetWidthZoom} style={styles.stepBtnReset} aria-label={t("widthReset")}>⟳</button>
            </div>
          </div>

          <div style={styles.legendConflictRow}>
            {kurse.length === 0 ? (
              <span style={{ color: "#5C6570", fontSize: 13 }}>{t("noKurseYet")}</span>
            ) : (
              <div ref={kurseMenuRef} style={styles.kurseMenuWrap}>
                <button
                  onClick={() => setKurseMenuOpen((o) => !o)}
                  style={styles.kurseMenuTrigger}
                  aria-haspopup="true"
                  aria-expanded={kurseMenuOpen}
                >
                  <span>{t("kurseMenuLabel")}</span>
                  <span style={styles.kurseMenuCount} className="mono">
                    {visibleKurseCount}/{kurse.length}
                  </span>
                  <span style={styles.dropdownCaret}>▾</span>
                </button>
                {kurseMenuOpen && (
                  <div style={styles.kurseMenu}>
                    <div style={styles.kurseMenuActions}>
                      <button
                        type="button"
                        className="ghost-btn"
                        style={styles.kurseMenuActionBtn}
                        onClick={() => setVisible(Object.fromEntries(kurse.map((k) => [k.id, true])))}
                      >
                        {t("kurseShowAll")}
                      </button>
                      <button
                        type="button"
                        className="ghost-btn"
                        style={styles.kurseMenuActionBtn}
                        onClick={() => setVisible(Object.fromEntries(kurse.map((k) => [k.id, false])))}
                      >
                        {t("kurseHideAll")}
                      </button>
                    </div>
                    <div style={styles.legend}>
                      {kurse.map((k) => (
                        <label key={k.id} style={styles.legendItem}>
                          <input
                            type="checkbox"
                            checked={visible[k.id] !== false}
                            onChange={(e) => setVisible((prev) => ({ ...prev, [k.id]: e.target.checked }))}
                            style={{ accentColor: k.color }}
                          />
                          <span style={{ ...styles.legendSwatch, background: k.color }} />
                          <span className="mono" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
                            {k.name}
                            {Number(k.interval) > 0 ? ` · ${k.interval}${t("intervalSuffix")}` : ""}
                            {k.endTime ? ` · ${t("untilSuffix")} ${k.endTime}` : ""}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {(() => {
              const { stationConflicts, sectionConflicts } = conflictData;
              const total = stationConflicts.length + sectionConflicts.length;
              const chips = [
                ...sectionConflicts.map((c) => ({
                  key: `s-${c.key}-${c.dir}-${c.atMin}`,
                  where: `${c.nameA}–${c.nameB}`,
                  at: c.atMin !== null ? toTimeStr(c.atMin) : "—",
                })),
                ...stationConflicts.map((c) => ({
                  key: `st-${c.stationId}-${c.atMin}`,
                  where: c.name,
                  at: c.atMin !== null ? toTimeStr(c.atMin) : "—",
                })),
              ];
              return (
                <div style={styles.conflictBar}>
                  <span style={{ ...styles.conflictDot, background: total > 0 ? "#B23A3A" : "#2F8F5B" }} />
                  {total === 0 ? (
                    <span style={{ fontSize: 12.5, color: "#5C6570" }}>{t("conflictsNoneShort")}</span>
                  ) : (
                    <div style={styles.conflictChips}>
                      {chips.map((c) => (
                        <span key={c.key} style={styles.conflictChip}>
                          <span style={{ fontWeight: 600 }}>{c.where}</span>
                          <span className="mono" style={{ marginLeft: 5 }}>{c.at}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div style={styles.diagramWrap} ref={diagramWrapRef}>
            <div style={styles.diagramHeaderSticky}>
              <svg width={svgW} height={HEADER_HEIGHT} style={{ background: "#EAEDE8", display: "block" }}>
                <rect x={0} y={0} width={svgW} height={HEADER_HEIGHT} fill="#EAEDE8" />
                {sortedStations.map((st, idx) => (
                  <text
                    key={st.id}
                    x={stationX(idx)}
                    y={HEADER_HEIGHT - TRACK_BAND_H - 8}
                    textAnchor="start"
                    fontSize={st.kind === "signal" ? "10" : "12"}
                    fontWeight="500"
                    fill={st.kind === "signal" ? "#848C82" : "#171B1F"}
                    transform={`rotate(-45 ${stationX(idx)} ${HEADER_HEIGHT - TRACK_BAND_H - 8})`}
                  >
                    {st.name}
                    {branchFromIds.has(st.id) ? " ⑂" : ""}
                  </text>
                ))}
                {beforePanels.length > 0 && (
                  <line
                    x1={mainLeft - PANEL_GAP / 2}
                    y1={0}
                    x2={mainLeft - PANEL_GAP / 2}
                    y2={HEADER_HEIGHT - TRACK_BAND_H}
                    stroke="#D7DBD5"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                )}
                {branchPanels.map((bp, i) => (
                  <g key={bp.branch.id}>
                    <line
                      x1={branchPanelOffsets[i] - PANEL_GAP / 2}
                      y1={0}
                      x2={branchPanelOffsets[i] - PANEL_GAP / 2}
                      y2={HEADER_HEIGHT - TRACK_BAND_H}
                      stroke="#D7DBD5"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                    />
                    <text
                      x={branchPanelOffsets[i]}
                      y={14}
                      textAnchor="start"
                      fontSize="11"
                      fontWeight="600"
                      fill="#5C6570"
                    >
                      {bp.mirrored ? "← " : "→ "}{bp.branch.name}
                    </text>
                    {bp.attach && (
                      <text
                        x={branchAttachX(bp)}
                        y={HEADER_HEIGHT - TRACK_BAND_H - 8}
                        textAnchor="start"
                        fontSize="12"
                        fontWeight="500"
                        fill="#5C6570"
                        transform={`rotate(-45 ${branchAttachX(bp)} ${HEADER_HEIGHT - TRACK_BAND_H - 8})`}
                      >
                        {bp.attach.name} ⑂
                      </text>
                    )}
                  </g>
                ))}
                {renderTrackBand()}
                <line
                  x1={0}
                  y1={HEADER_HEIGHT - 1}
                  x2={svgW}
                  y2={HEADER_HEIGHT - 1}
                  stroke="#D7DBD5"
                  strokeWidth={1}
                />
              </svg>
            </div>
            <svg ref={bodySvgRef} width={svgW} height={svgH} style={{ background: "#EAEDE8", display: "block" }}>
              {gridLines.map((m) => {
                const isHour = m % 60 === 0;
                return (
                  <g key={m}>
                    <line
                      x1={margin.left}
                      y1={timeY(m)}
                      x2={margin.left + chartW}
                      y2={timeY(m)}
                      stroke={isHour ? "#A8AEA3" : "#D7DBD5"}
                      strokeWidth={isHour ? 1.2 : 0.6}
                    />
                    <text
                      x={margin.left - 10}
                      y={timeY(m) + 4}
                      textAnchor="end"
                      className="mono"
                      fontSize="11"
                      fill="#5C6570"
                    >
                      {toTimeStr(m)}
                    </text>
                  </g>
                );
              })}

              {beforePanels.length > 0 && (
                <line
                  x1={mainLeft - PANEL_GAP / 2}
                  y1={margin.top}
                  x2={mainLeft - PANEL_GAP / 2}
                  y2={margin.top + chartH}
                  stroke="#D7DBD5"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
              )}
              {branchPanels.map((bp, i) => (
                <line
                  key={bp.branch.id}
                  x1={branchPanelOffsets[i] - PANEL_GAP / 2}
                  y1={margin.top}
                  x2={branchPanelOffsets[i] - PANEL_GAP / 2}
                  y2={margin.top + chartH}
                  stroke="#D7DBD5"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
              ))}

              {sortedStations.map((st, idx) => (
                <line
                  key={st.id}
                  x1={stationX(idx)}
                  y1={margin.top}
                  x2={stationX(idx)}
                  y2={margin.top + chartH}
                  stroke="#D7DBD5"
                  strokeWidth={1}
                />
              ))}
              {branchPanels.map(
                (bp) =>
                  bp.attach && (
                    <line
                      key={`attach-${bp.branch.id}`}
                      x1={branchAttachX(bp)}
                      y1={margin.top}
                      x2={branchAttachX(bp)}
                      y2={margin.top + chartH}
                      stroke="#D7DBD5"
                      strokeWidth={1}
                    />
                  )
              )}

              <line
                x1={margin.left}
                y1={margin.top}
                x2={margin.left + chartW}
                y2={margin.top}
                stroke="#171B1F"
                strokeWidth={1.2}
              />

              {kursPaths.map((k) => {
                if (visible[k.id] === false) return null;
                return (
                  <g key={k.id}>
                    {k.trips.map((trip) => {
                      if (trip.points.length < 2) return null;
                      const segments = [];
                      for (let i = 0; i < trip.points.length - 1; i++) {
                        const p1 = trip.points[i];
                        const p2 = trip.points[i + 1];
                        const isDwell = Math.abs(p1.x - p2.x) < 0.01;
                        const branch1 = stationBranchMap.get(p1.stationId) || null;
                        const branch2 = stationBranchMap.get(p2.stationId) || null;
                        const isBranchTransition = !isDwell && branch1 !== branch2;
                        let conflict = false;
                        if (!isDwell) {
                          const vehicle = vehicleForKurs(k);
                          if (vehicle) {
                            const path = pathBetween(p1.stationId, p2.stationId);
                            const required = path ? multiSegmentPhysicsTime(path, vehicle) : null;
                            if (required !== null && p2.min - p1.min < required - 1e-6) {
                              conflict = true;
                            }
                          }
                        }
                        segments.push({ id: `${trip.tripId}-${i}`, p1, p2, isDwell, isBranchTransition, branch1, branch2, conflict, trackConflict: !isDwell && segmentTrackConflict(p1, p2) });
                      }
                      return (
                        <g key={trip.tripId}>
                          {(() => {
                            function renderPointCircle(p, keySuffix) {
                              const pointKey = `${p.kursId}-${p.wid}-${p.field}-${trip.tripId}`;
                              const isDragging = draggingKey === pointKey;
                              return (
                                <circle
                                  key={keySuffix}
                                  cx={p.x}
                                  cy={p.y}
                                  r={isDragging ? 5 : 3.2}
                                  fill={p.isManual ? k.color : "#EAEDE8"}
                                  stroke={k.color}
                                  strokeWidth={p.isManual ? 1 : 1.8}
                                  style={{ cursor: "ns-resize", touchAction: "none" }}
                                  onPointerDown={(e) => {
                                    if (e.button === 2) return; // Rechtsklick löst kein Ziehen aus
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (e.currentTarget.setPointerCapture) {
                                      e.currentTarget.setPointerCapture(e.pointerId);
                                    }
                                    draggingKeyRef.current = pointKey;
                                    setDraggingKey(pointKey);
                                  }}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setTooltip(null);
                                    setContextMenu({
                                      clientX: e.clientX,
                                      clientY: e.clientY,
                                      point: p,
                                      kursName: k.name,
                                    });
                                  }}
                                  onPointerMove={(e) => {
                                    if (draggingKeyRef.current !== pointKey) return;
                                    const svg = bodySvgRef.current;
                                    if (!svg) return;
                                    const rect = svg.getBoundingClientRect();
                                    const relY = e.clientY - rect.top;
                                    const rawMin = minTime + ((relY - margin.top) / chartH) * timeSpan;
                                    setPointTimeFromDrag(p, rawMin);
                                    setTooltip({
                                      x: p.x,
                                      y: p.y,
                                      text: `${k.name} · ${toTimeStr(Math.round(rawMin / 0.5) * 0.5)}`,
                                    });
                                  }}
                                  onPointerUp={(e) => {
                                    if (e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) {
                                      e.currentTarget.releasePointerCapture(e.pointerId);
                                    }
                                    draggingKeyRef.current = null;
                                    setDraggingKey(null);
                                    setTooltip(null);
                                  }}
                                  onMouseEnter={() => {
                                    if (!draggingKeyRef.current) {
                                      setTooltip({ x: p.x, y: p.y, text: `${k.name} · ${p.t}` });
                                    }
                                  }}
                                  onMouseLeave={() => {
                                    if (!draggingKeyRef.current) setTooltip(null);
                                  }}
                                />
                              );
                            }
                            return (
                              <>
                                {segments.map((seg, segIdx) => {
                                  if (seg.isDwell) {
                                    return (
                                      <path
                                        key={seg.id}
                                        d={dwellCurveD(seg.p1, seg.p2)}
                                        fill="none"
                                        stroke={k.color}
                                        strokeWidth={1.1}
                                      />
                                    );
                                  }
                                  if (seg.isBranchTransition) {
                                    const branchId = seg.branch1 || seg.branch2;
                                    const bp = branchId ? branchPanels.find((b) => b.branch.id === branchId) : null;
                                    const attachId = bp && bp.attach ? bp.attach.id : null;
                                    if (bp && attachId && seg.p1.stationId === attachId) {
                                      // Hauptstrecke -> Zweig: p1 (z. B. Abfahrt) liegt an der Abzweigstation
                                      const prevSeg = segIdx > 0 ? segments[segIdx - 1] : null;
                                      const hasPair = prevSeg && prevSeg.isDwell && prevSeg.p2.stationId === attachId;
                                      const echoExit = { ...seg.p1, x: branchAttachX(bp) };
                                      const echoEntry = hasPair ? { ...prevSeg.p1, x: branchAttachX(bp) } : null;
                                      return (
                                        <g key={seg.id}>
                                          <path d={stubPath(seg.p1.x, seg.p1.y, 1)} fill="none" stroke={k.color} strokeWidth={1.1} />
                                          {echoEntry ? (
                                            <>
                                              <path d={stubPath(echoEntry.x, echoEntry.y, -1)} fill="none" stroke={k.color} strokeWidth={1.1} />
                                              <path d={dwellCurveD(echoEntry, echoExit)} fill="none" stroke={k.color} strokeWidth={1.1} />
                                              {renderPointCircle(echoEntry, `${seg.id}-echo-entry`)}
                                            </>
                                          ) : (
                                            <path d={stubPath(echoExit.x, echoExit.y, -1)} fill="none" stroke={k.color} strokeWidth={1.1} />
                                          )}
                                          <line
                                            x1={echoExit.x} y1={echoExit.y} x2={seg.p2.x} y2={seg.p2.y}
                                            stroke={seg.trackConflict ? "#B23A3A" : k.color} strokeWidth={seg.trackConflict ? 1.5 : 2.2}
                                            strokeDasharray={seg.trackConflict ? "4 3" : seg.conflict ? "5 4" : undefined}
                                          />
                                          {renderPointCircle(echoExit, `${seg.id}-echo-exit`)}
                                        </g>
                                      );
                                    }
                                    if (bp && attachId && seg.p2.stationId === attachId) {
                                      // Zweig -> Hauptstrecke: p2 (z. B. Ankunft) liegt an der Abzweigstation
                                      const nextSeg = segIdx < segments.length - 1 ? segments[segIdx + 1] : null;
                                      const hasPair = nextSeg && nextSeg.isDwell && nextSeg.p1.stationId === attachId;
                                      const echoEntry = { ...seg.p2, x: branchAttachX(bp) };
                                      const echoExit = hasPair ? { ...nextSeg.p2, x: branchAttachX(bp) } : null;
                                      return (
                                        <g key={seg.id}>
                                          <line
                                            x1={seg.p1.x} y1={seg.p1.y} x2={echoEntry.x} y2={echoEntry.y}
                                            stroke={seg.trackConflict ? "#B23A3A" : k.color} strokeWidth={seg.trackConflict ? 1.5 : 2.2}
                                            strokeDasharray={seg.trackConflict ? "4 3" : seg.conflict ? "5 4" : undefined}
                                          />
                                          {renderPointCircle(echoEntry, `${seg.id}-echo-entry`)}
                                          {echoExit ? (
                                            <>
                                              <path d={dwellCurveD(echoEntry, echoExit)} fill="none" stroke={k.color} strokeWidth={1.1} />
                                              <path d={stubPath(echoExit.x, echoExit.y, -1)} fill="none" stroke={k.color} strokeWidth={1.1} />
                                              {renderPointCircle(echoExit, `${seg.id}-echo-exit`)}
                                            </>
                                          ) : (
                                            <path d={stubPath(echoEntry.x, echoEntry.y, -1)} fill="none" stroke={k.color} strokeWidth={1.1} />
                                          )}
                                          <path d={stubPath(seg.p2.x, seg.p2.y, 1)} fill="none" stroke={k.color} strokeWidth={1.1} />
                                        </g>
                                      );
                                    }
                                    // Kein Halt an der Abzweigstation in diesem Kurs: nur kurze Andeutungen
                                    const goingRight = branchOrderIndex(seg.branch2) > branchOrderIndex(seg.branch1);
                                    return (
                                      <g key={seg.id}>
                                        <path
                                          d={stubPath(seg.p1.x, seg.p1.y, goingRight ? 1 : -1)}
                                          fill="none" stroke={k.color} strokeWidth={1.1}
                                        />
                                        <path
                                          d={stubPath(seg.p2.x, seg.p2.y, goingRight ? -1 : 1)}
                                          fill="none" stroke={k.color} strokeWidth={1.1}
                                        />
                                      </g>
                                    );
                                  }
                                  return (
                                    <line
                                      key={seg.id}
                                      x1={seg.p1.x}
                                      y1={seg.p1.y}
                                      x2={seg.p2.x}
                                      y2={seg.p2.y}
                                      stroke={seg.trackConflict ? "#B23A3A" : k.color}
                                      strokeWidth={seg.trackConflict ? 1.5 : 2.2}
                                      strokeDasharray={seg.trackConflict ? "4 3" : seg.conflict ? "5 4" : undefined}
                                    />
                                  );
                                })}
                                {trip.points.map((p, i) => renderPointCircle(p, i))}
                              </>
                            );
                          })()}
                        </g>
                      );
                    })}
                  </g>
                );
              })}

              {/* Stationskonflikte: roter gestrichelter Kreis am Kreuzungs-/Halte­punkt */}
              {Array.from(conflictData.stationWindows.entries()).flatMap(([stationId, wins]) => {
                const si = stationIndex.get(stationId);
                if (si === undefined) return [];
                const x = stationX(si);
                return wins.map(([ws, we], wi) => {
                  const mid = (ws + we) / 2;
                  if (mid < minTime - 1e-6 || mid > maxTime + 1e-6) return null;
                  return (
                    <circle
                      key={`stconf-${stationId}-${wi}`}
                      cx={x}
                      cy={timeY(mid)}
                      r={8}
                      fill="none"
                      stroke="#B23A3A"
                      strokeWidth={1.5}
                      strokeDasharray="3 2.5"
                    />
                  );
                }).filter(Boolean);
              })}

              {tooltip && (() => {
                const tooltipW = Math.max(50, tooltip.text.length * 6.5 + 16);
                const tooltipX = Math.min(tooltip.x + 10, svgW - tooltipW - 10);
                return (
                  <g>
                    <rect
                      x={tooltipX}
                      y={tooltip.y - 26}
                      width={tooltipW}
                      height={22}
                      fill="#171B1F"
                      rx={3}
                    />
                    <text
                      x={tooltipX + 8}
                      y={tooltip.y - 11}
                      className="mono"
                      fontSize="11"
                      fill="#EAEDE8"
                    >
                      {tooltip.text}
                    </text>
                  </g>
                );
              })()}
            </svg>
          </div>

          {contextMenu && (
            <div
              style={{ ...styles.contextMenu, left: contextMenu.clientX, top: contextMenu.clientY }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div style={styles.contextMenuHeader}>
                {t("kursPrefix")} {contextMenu.kursName} · {contextMenu.point.station} · {contextMenu.point.t}
              </div>
              {contextMenu.point.isManual && (
                <button style={styles.contextMenuItem} onClick={() => unfixPoint(contextMenu.point)}>
                  {t("unfix")}
                </button>
              )}
              {contextMenu.point.field === "both" && (
                <button style={styles.contextMenuItem} onClick={() => splitDeparture(contextMenu.point)}>
                  {t("splitDeparture")}
                </button>
              )}
              {!contextMenu.point.isManual && contextMenu.point.field !== "both" && (
                <div style={styles.contextMenuEmpty}>{t("noActions")}</div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "export" && (
        <div style={{ ...styles.panel, maxWidth: 1400 }}>
          <div style={styles.toolbarRow}>
            <label style={styles.windowLabel}>
              {t("exportWindowFrom")}
              <input type="time" value={exportWinStart} onChange={(e) => setExportWinStart(e.target.value)} />
            </label>
            <label style={styles.windowLabel}>
              {t("exportWindowTo")}
              <input type="time" value={exportWinEnd} onChange={(e) => setExportWinEnd(e.target.value)} />
            </label>
            <span style={styles.toolbarSep} />
            <button
              onClick={handleExportPdf}
              style={styles.addBtn}
              disabled={!exportBlocks || exportColumns.length === 0 || exportGenerating}
            >
              {exportGenerating ? t("exportGenerating") : t("exportSavePdf")}
            </button>
          </div>

          <div style={styles.exportLinesList}>
            {beforeBranches.map(renderExportBranchRow)}
            <div style={styles.exportLineRow}>
              <input
                type="checkbox"
                checked={exportMainEnabled}
                onChange={(e) => setExportMainEnabled(e.target.checked)}
              />
              <span style={styles.exportLineName}>{t("mainStrecke")}</span>
              <select
                value={exportMainFromId}
                onChange={(e) => setExportMainFromId(e.target.value)}
                disabled={!exportMainEnabled}
              >
                <option value="">—</option>
                {mainStations.filter((s) => s.kind !== "signal").map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <span style={styles.exportLineToLabel}>{t("rangeTo")}</span>
              <select
                value={exportMainToId}
                onChange={(e) => setExportMainToId(e.target.value)}
                disabled={!exportMainEnabled}
              >
                <option value="">—</option>
                {mainStations.filter((s) => s.kind !== "signal").map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            {afterBranches.map(renderExportBranchRow)}
          </div>

          {!exportBlocks ? (
            <p style={{ color: "#5C6570", fontSize: 13, marginTop: 12 }}>{t("exportNoRange")}</p>
          ) : (
            <>
              <div style={{ marginTop: 16, marginBottom: 18 }}>
                {(() => {
                  // Dedupe by station id — a branch's echoed junction row is the same station as
                  // its main-line row, and the checkbox (keyed by station id) controls both at once.
                  const seenStationIds = new Set();
                  const allExportRows = exportBlocks
                    .flatMap((b) => b.rows)
                    .filter((r) => (seenStationIds.has(r.id) ? false : (seenStationIds.add(r.id), true)));
                  const checkedCount = allExportRows.filter((r) => exportShowArrival[r.id]).length;
                  return (
                    <div ref={exportStationsMenuRef} style={styles.kurseMenuWrap}>
                      <button
                        onClick={() => setExportStationsMenuOpen((o) => !o)}
                        style={styles.kurseMenuTrigger}
                        aria-haspopup="true"
                        aria-expanded={exportStationsMenuOpen}
                      >
                        <span>{t("exportStationsTitle")}</span>
                        <span style={styles.kurseMenuCount} className="mono">
                          {checkedCount}/{allExportRows.length}
                        </span>
                        <span style={styles.dropdownCaret}>▾</span>
                      </button>
                      {exportStationsMenuOpen && (
                        <div style={styles.kurseMenu}>
                          <div style={styles.kurseMenuActions}>
                            <button
                              type="button"
                              className="ghost-btn"
                              style={styles.kurseMenuActionBtn}
                              onClick={() =>
                                setExportShowArrival(Object.fromEntries(allExportRows.map((r) => [r.id, true])))
                              }
                            >
                              {t("kurseShowAll")}
                            </button>
                            <button
                              type="button"
                              className="ghost-btn"
                              style={styles.kurseMenuActionBtn}
                              onClick={() =>
                                setExportShowArrival(Object.fromEntries(allExportRows.map((r) => [r.id, false])))
                              }
                            >
                              {t("kurseHideAll")}
                            </button>
                          </div>
                          <div style={styles.legend}>
                            {allExportRows.map((r) => (
                              <label key={r.id} style={styles.legendItem}>
                                <input
                                  type="checkbox"
                                  checked={!!exportShowArrival[r.id]}
                                  onChange={(e) =>
                                    setExportShowArrival((prev) => ({ ...prev, [r.id]: e.target.checked }))
                                  }
                                />
                                <span className="mono" style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
                                  {stationsById.get(r.id)?.name}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              <p style={{ fontSize: 13, fontWeight: 500, margin: "16px 0 8px" }}>
                {t("exportPreviewTitle")} — {exportLineSummary(exportBlocks)}
                {" · "}
                {t("exportTrainsCount", { n: exportColumns.length })}
              </p>

              {exportColumns.length === 0 ? (
                <p style={{ color: "#5C6570", fontSize: 13 }}>{t("exportNoTrains")}</p>
              ) : (
                <div style={styles.exportTableWrap}>
                  <table style={styles.exportTable}>
                    <thead>
                      <tr>
                        <th style={styles.exportStationHeaderCell}>{t("exportColStation")}</th>
                        <th style={styles.exportLabelHeaderCell}></th>
                        {exportColumns.map((c) => (
                          <th key={c.tripId} style={{ ...styles.exportTrainHeaderCell, color: c.color }}>
                            {c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {exportPrintRows.map((row, ri) => {
                        if (row.type === "divider") {
                          return (
                            <tr key={`div-${ri}`}>
                              <td colSpan={2 + exportColumns.length} style={styles.exportDividerCell} />
                            </tr>
                          );
                        }
                        const st = stationsById.get(row.stationId);
                        return (
                          <tr key={`${row.stationId}-${row.type}-${ri}`}>
                            {row.type !== "ab" && (
                              <td
                                rowSpan={row.type === "an" ? 2 : 1}
                                style={{
                                  ...styles.exportStationCell,
                                  ...(row.echo ? styles.exportEchoCell : {}),
                                }}
                              >
                                {st?.name}
                              </td>
                            )}
                            <td style={styles.exportLabelCell}>{row.type === "single" ? "" : row.type}</td>
                            {exportColumns.map((c) => {
                              const cell = c.cells[row.rowKey];
                              const isSpanSymbol = cell && (cell.kind === "through" || cell.kind === "none" || cell.kind === "blank");
                              if (row.type === "ab" && isSpanSymbol) return null;
                              return (
                                <td
                                  key={c.tripId}
                                  rowSpan={row.type === "an" && isSpanSymbol ? 2 : 1}
                                  style={{
                                    ...styles.exportCell,
                                    ...(isSpanSymbol ? styles.exportCellSymbol : {}),
                                  }}
                                >
                                  {exportCellText(cell, row.type)}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "stations" && (
        <div style={{ ...styles.panel, maxWidth: 1280 }}>
          {beforeBranches.map(renderBranchBlock)}

          <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 8px" }}>
            <button
              onClick={() => toggleLineCollapsed("main")}
              style={styles.chevronBtn}
              aria-label={collapsedLines.main ? t("expandKurs") : t("collapseKurs")}
            >
              {collapsedLines.main ? "▸" : "▾"}
            </button>
            <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>{t("mainStrecke")}</p>
          </div>
          {!collapsedLines.main && (
          <>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
          <div style={{ overflowX: "auto", flex: 1 }}>
          <table className="station-table" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th style={{ width: 70 }}></th>
                <th style={{ width: 220 }}>{t("colName")}</th>
                <th style={{ width: 110 }}>{t("colKm")}</th>
                <th style={{ width: 90 }}>{t("colDistance")}</th>
                <th style={{ width: 100 }}>{t("colMaxSpeed")}</th>
                <th style={{ width: 90 }}>{t("colStationTracks")}</th>
                <th style={{ width: 90 }}>{t("colTracks")}</th>
                <th style={{ width: 120 }}>{t("colDwell")}</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {mainStations.map((st, idx) => {
                const isSignal = st.kind === "signal";
                return (
                <tr
                  key={st.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragOverStationId !== st.id) setDragOverStationId(st.id);
                  }}
                  onDragLeave={() => {
                    setDragOverStationId((prev) => (prev === st.id ? null : prev));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    reorderStations(draggedStationId, st.id);
                    setDraggedStationId(null);
                    setDragOverStationId(null);
                  }}
                  style={{
                    opacity: draggedStationId === st.id ? 0.4 : 1,
                    background: isSignal ? "#F5F1E8" : undefined,
                    borderTop: dragOverStationId === st.id && draggedStationId !== st.id ? "2px solid #9C7A2E" : undefined,
                  }}
                >
                  <td>
                    <span
                      draggable
                      onDragStart={(e) => {
                        setDraggedStationId(st.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => {
                        setDraggedStationId(null);
                        setDragOverStationId(null);
                      }}
                      style={styles.dragHandle}
                      aria-label={t("dragHandle")}
                      title={t("dragHandle")}
                    >
                      ⠿
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="text"
                        value={st.name}
                        onChange={(e) => updateStation(st.id, "name", e.target.value)}
                        style={{ width: "100%" }}
                      />
                      {isSignal && <span style={styles.signalBadge}>{t("signalBadge")}</span>}
                    </div>
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={st.km}
                      onChange={(e) => updateStation(st.id, "km", e.target.value)}
                      style={{ width: 90 }}
                      placeholder={t("kmOptional")}
                    />
                  </td>
                  <td className="mono" style={{ color: "#848C82", fontSize: 12 }}>
                    {(() => {
                      if (idx === 0) return t("distanceFirst");
                      const cur = kmOrNull(st.km);
                      const prev = kmOrNull(mainStations[idx - 1].km);
                      if (cur === null || prev === null) return t("distanceFirst");
                      const d = cur - prev;
                      return `${d < 0 ? "⚠ " : ""}${d.toFixed(2)} km`;
                    })()}
                  </td>
                  <td>
                    {idx > 0 && (() => {
                      const key = segKey(mainStations[idx - 1].id, st.id);
                      return (
                        <input
                          type="number"
                          step="1"
                          min="0"
                          value={maxSpeeds[key] ?? ""}
                          onChange={(e) => setMaxSpeeds((prev) => ({ ...prev, [key]: e.target.value }))}
                          style={{ width: 80 }}
                          placeholder="km/h"
                        />
                      );
                    })()}
                  </td>
                  <td>
                    {isSignal ? (
                      <span style={{ color: "#848C82" }}>—</span>
                    ) : (
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={st.stationTracks ?? ""}
                        onChange={(e) => updateStation(st.id, "stationTracks", e.target.value)}
                        style={{ width: 60 }}
                        placeholder="—"
                      />
                    )}
                  </td>
                  <td>
                    {isSignal ? (
                      <span style={{ color: "#848C82" }}>—</span>
                    ) : (() => {
                      const prevId = prevRealId(mainStations, idx);
                      if (!prevId) return null;
                      const key = segKey(prevId, st.id);
                      return (
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={trackCounts[key] ?? ""}
                          onChange={(e) => setTrackCounts((prev) => ({ ...prev, [key]: e.target.value }))}
                          style={{ width: 60 }}
                          placeholder="—"
                        />
                      );
                    })()}
                  </td>
                  <td>
                    {isSignal ? (
                      <span style={{ color: "#848C82" }}>—</span>
                    ) : (
                      <input
                        type="text"
                        inputMode="numeric"
                        value={st.dwell ?? ""}
                        onChange={(e) => updateStation(st.id, "dwell", e.target.value)}
                        style={{ width: 90 }}
                        placeholder="MM:SS"
                      />
                    )}
                  </td>
                  <td>
                    <button
                      onClick={() => removeStation(st.id)}
                      style={styles.iconBtn}
                      aria-label={isSignal ? t("removeSignal") : t("removeStation")}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {mainStations.length > 0 && (
            <div style={{ paddingTop: 25 }} title={t("routeBandTitle")}>
              <RouteBand stationList={mainStations} />
            </div>
          )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button onClick={addStation} style={styles.addBtn}>{t("addStation")}</button>
            <button onClick={addSignal} style={styles.addBtn} title={t("signalHint")}>{t("addSignal")}</button>
          </div>
          </>
          )}

          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #D7DBD5" }}>
            {afterBranches.map(renderBranchBlock)}
            <button onClick={addBranch} style={styles.addBtn} disabled={mainStations.length === 0}>
              {t("addBranch")}
            </button>
          </div>

        </div>
      )}

      {tab === "kurse" && (
        <div style={{ maxWidth: 1100 }}>
          {kurse.length > 1 && (
            <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
              <button onClick={expandAllKurse} style={styles.addBtnSmall}>{t("expandAll")}</button>
              <button onClick={collapseAllKurse} style={styles.addBtnSmall}>{t("collapseAll")}</button>
            </div>
          )}
          {kurse.map((k) => {
            const isCollapsed = !!collapsedKurse[k.id];
            const kVehicleId = k.vehicleType || (vehicles[0] && vehicles[0].id) || "";
            return (
            <div key={k.id} style={styles.kursCard}>
              <div style={styles.kursHeaderRow}>
                <button
                  onClick={() => toggleKursCollapsed(k.id)}
                  style={styles.chevronBtn}
                  aria-label={isCollapsed ? t("expandKurs") : t("collapseKurs")}
                >
                  {isCollapsed ? "▸" : "▾"}
                </button>
                <input
                  type="color"
                  value={k.color}
                  onChange={(e) => updateKursField(k.id, "color", e.target.value)}
                  style={styles.colorDot}
                />
                <input
                  type="text"
                  className="kurs-name-input"
                  value={k.name}
                  onChange={(e) => updateKursField(k.id, "name", e.target.value)}
                  style={styles.kursNameInput}
                  placeholder={t("kursNamePlaceholder")}
                />
                {isCollapsed && (
                  <span className="mono" style={{ fontSize: 12, color: "#848C82", whiteSpace: "nowrap" }}>
                    {t("stopsCount", { n: k.waypoints.length })}
                    {Number(k.interval) > 0 ? ` · ${k.interval}${t("intervalSuffix")}` : ""}
                    {k.endTime ? ` · ${t("untilSuffix")} ${k.endTime}` : ""}
                  </span>
                )}
                <button onClick={() => removeKurs(k.id)} style={styles.ghostBtnDanger} className="ghost-btn-danger" aria-label={t("removeKurs")}>
                  ✕
                </button>
              </div>

              {!isCollapsed && (
              <>
              <div style={styles.metaRow}>
                <div style={styles.metaField}>
                  <span style={styles.metaLabel}>{t("takt")}</span>
                  <input
                    type="number"
                    min="0"
                    value={k.interval || 0}
                    onChange={(e) => updateKursField(k.id, "interval", e.target.value)}
                    style={{ width: 64 }}
                  />
                </div>
                <div style={styles.metaField}>
                  <span style={styles.metaLabel}>{t("endzeit")}</span>
                  <input
                    type="time"
                    value={k.endTime || ""}
                    onChange={(e) => updateKursField(k.id, "endTime", e.target.value)}
                    style={{ width: 90 }}
                  />
                </div>
                <div style={styles.metaField}>
                  <span style={styles.metaLabel}>{t("vehicleType")}</span>
                  <select
                    value={kVehicleId}
                    onChange={(e) => updateKursField(k.id, "vehicleType", e.target.value)}
                    style={{ fontSize: 12, padding: "3px 5px" }}
                  >
                    {vehicles.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={styles.utilityRow}>
                <button onClick={() => duplicateKurs(k.id)} style={styles.addBtnSmall}>
                  {t("copyKurs")}
                </button>
                <span>{t("shiftAllTimes")}</span>
                <input
                  type="number"
                  step="0.5"
                  value={shiftInputs[k.id] ?? ""}
                  onChange={(e) => setShiftInputs((prev) => ({ ...prev, [k.id]: e.target.value }))}
                  style={{ width: 64 }}
                  placeholder={t("shiftPlaceholder")}
                />
                <button onClick={() => applyShift(k.id)} style={styles.addBtnSmall}>
                  {t("shiftButton")}
                </button>
              </div>

              <table>
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th>{t("colStation")}</th>
                    <th style={{ width: 110 }}>{t("colArrival")}</th>
                    <th style={{ width: 110 }}>{t("colDeparture")}</th>
                    <th style={{ width: 100 }}>{t("colDwellShort")}</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {k.waypoints.map((wp) => (
                    <tr
                      key={wp.wid}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragOverWaypointId !== wp.wid) setDragOverWaypointId(wp.wid);
                      }}
                      onDragLeave={() => {
                        setDragOverWaypointId((prev) => (prev === wp.wid ? null : prev));
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (draggedWaypoint && draggedWaypoint.kursId === k.id) {
                          reorderWaypoints(k.id, draggedWaypoint.wid, wp.wid);
                        }
                        setDraggedWaypoint(null);
                        setDragOverWaypointId(null);
                      }}
                      style={{
                        opacity: draggedWaypoint && draggedWaypoint.wid === wp.wid ? 0.4 : 1,
                        borderTop:
                          dragOverWaypointId === wp.wid && !(draggedWaypoint && draggedWaypoint.wid === wp.wid)
                            ? "2px solid #9C7A2E"
                            : undefined,
                      }}
                    >
                      <td>
                        <span
                          draggable
                          onDragStart={(e) => {
                            setDraggedWaypoint({ kursId: k.id, wid: wp.wid });
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragEnd={() => {
                            setDraggedWaypoint(null);
                            setDragOverWaypointId(null);
                          }}
                          style={styles.dragHandle}
                          aria-label={t("dragHandle")}
                          title={t("dragHandle")}
                        >
                          ⠿
                        </span>
                      </td>
                      <td>
                        <select
                          value={wp.stationId}
                          onChange={(e) => updateWaypoint(k.id, wp.wid, "stationId", e.target.value)}
                        >
                          {stoppableStations.map((st) => (
                            <option key={st.id} value={st.id}>{st.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="time"
                          step="1"
                          value={wp.arr}
                          onChange={(e) => updateWaypoint(k.id, wp.wid, "arr", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="time"
                          step="1"
                          value={wp.dep}
                          onChange={(e) => updateWaypoint(k.id, wp.wid, "dep", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={wp.dwell ?? ""}
                          onChange={(e) => updateWaypoint(k.id, wp.wid, "dwell", e.target.value)}
                          style={{ width: 70 }}
                          placeholder="MM:SS"
                        />
                      </td>
                      <td>
                        <button onClick={() => removeWaypoint(k.id, wp.wid)} style={styles.iconBtn} aria-label={t("removeHalt")}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={styles.addStopsRow}>
                <button onClick={() => addWaypoint(k.id)} style={styles.addBtn}>{t("addWaypoint")}</button>
                {stoppableStations.length > 1 && (
                  <>
                    <span style={{ fontSize: 12, color: "#848C82" }}>{t("orRange")}</span>
                    <select
                      value={(rangeInputs[k.id] && rangeInputs[k.id].from) || stoppableStations[0].id}
                      onChange={(e) =>
                        setRangeInputs((prev) => ({
                          ...prev,
                          [k.id]: { ...(prev[k.id] || {}), from: e.target.value },
                        }))
                      }
                    >
                      {stoppableStations.map((st) => (
                        <option key={st.id} value={st.id}>{st.name}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 12, color: "#848C82" }}>{t("rangeTo")}</span>
                    <select
                      value={
                        (rangeInputs[k.id] && rangeInputs[k.id].to) ||
                        stoppableStations[stoppableStations.length - 1].id
                      }
                      onChange={(e) =>
                        setRangeInputs((prev) => ({
                          ...prev,
                          [k.id]: { ...(prev[k.id] || {}), to: e.target.value },
                        }))
                      }
                    >
                      {stoppableStations.map((st) => (
                        <option key={st.id} value={st.id}>{st.name}</option>
                      ))}
                    </select>
                    <button onClick={() => addStationRange(k.id)} style={styles.addBtnSmall}>
                      {t("addRange")}
                    </button>
                  </>
                )}
              </div>
              </>
              )}
            </div>
            );
          })}
          <button onClick={addKurs} style={styles.addBtn}>{t("addKurs")}</button>
        </div>
      )}

      {tab === "vehicles" && (
        <div style={styles.panel}>
          <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 4px" }}>{t("vehiclesTitle")}</p>
          <table>
            <thead>
              <tr>
                <th>{t("colName")}</th>
                <th style={{ width: 130 }}>{t("colVmax")}</th>
                <th style={{ width: 150 }}>{t("colAccel")}</th>
                <th style={{ width: 150 }}>{t("colDecel")}</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={v.id}>
                  <td>
                    <input
                      type="text"
                      value={v.name}
                      onChange={(e) => updateVehicle(v.id, "name", e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={v.vmax}
                      onChange={(e) => updateVehicle(v.id, "vmax", e.target.value)}
                      style={{ width: 100 }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={v.accel}
                      onChange={(e) => updateVehicle(v.id, "accel", e.target.value)}
                      style={{ width: 100 }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={v.decel}
                      onChange={(e) => updateVehicle(v.id, "decel", e.target.value)}
                      style={{ width: 100 }}
                    />
                  </td>
                  <td>
                    <button onClick={() => removeVehicle(v.id)} style={styles.iconBtn} aria-label={t("removeVehicle")}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={addVehicle} style={styles.addBtn}>{t("addVehicle")}</button>
        </div>
      )}

      {tab === "csv" && (
        <div style={styles.panel}>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={
              "Kurs,Farbe,Station,Ankunft,Abfahrt,Takt,Endzeit,Haltezeit\n" +
              "501,#2B6CB0,KP WA,,,20,,\n" +
              "501,#2B6CB0,KP,,00:52,20,,\n" +
              "501,#2B6CB0,FP,00:59,,20,,03:00\n" +
              "501,#2B6CB0,KP,01:09,01:12,20,,\n" +
              "501,#2B6CB0,KP WA,,,20,,"
            }
            rows={8}
            className="mono"
            style={{ width: "100%", fontSize: 12, border: "1px solid #D7DBD5", borderRadius: 4, padding: 8 }}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
            <button onClick={handleCsvImport} style={styles.addBtn}>{t("importText")}</button>
            <button onClick={() => fileInputRef.current && fileInputRef.current.click()} style={styles.addBtn}>
              {t("uploadCsv")}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileUpload}
              style={{ display: "none" }}
            />
            {csvMsg && <span style={{ fontSize: 13, color: "#5C6570" }}>{csvMsg}</span>}
          </div>
        </div>
      )}

      {tab === "account" && (
        <div style={styles.panel}>
          <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 8px" }}>{t("authTitle")}</p>
          {authLoading ? null : authUser ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 13 }}>{t("authLoggedInAs", { email: authUser.email })}</span>
              <button onClick={handleSignOut} style={styles.addBtn}>{t("authSignOut")}</button>
            </div>
          ) : (
            <form onSubmit={handleAuthSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 280 }}>
              <input
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder={t("authEmailLabel")}
                autoComplete="email"
                required
              />
              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder={t("authPasswordLabel")}
                autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                required
                minLength={6}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button type="submit" style={styles.addBtn} disabled={authBusy}>
                  {authMode === "signup" ? t("authSignUp") : t("authSignIn")}
                </button>
                <button
                  type="button"
                  onClick={() => { setAuthMode((m) => (m === "signup" ? "signin" : "signup")); setAuthError(""); }}
                  style={styles.ghostBtn}
                >
                  {authMode === "signup" ? t("authSwitchToSignIn") : t("authSwitchToSignUp")}
                </button>
              </div>
              {authMode === "signin" && (
                <button type="button" onClick={handlePasswordReset} style={{ ...styles.ghostBtn, alignSelf: "flex-start" }}>
                  {t("authForgotPassword")}
                </button>
              )}
              {authError && <p style={{ fontSize: 12, color: "#B3261E", margin: 0 }}>{authError}</p>}
            </form>
          )}
        </div>
      )}

      {tab === "save" && (
        <div style={styles.panel}>
          <div style={{ marginBottom: 24, paddingBottom: 20, borderBottom: "1px solid #D7DBD5" }}>
            <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 8px" }}>{t("cloudProjectsTitle")}</p>
            {!authUser ? (
              <p style={{ fontSize: 13, color: "#848C82" }}>{t("cloudLoggedOutHint")}</p>
            ) : (
              <>
                {cloudProjectsLoading ? (
                  <p style={{ fontSize: 13, color: "#848C82" }}>…</p>
                ) : cloudProjects.length === 0 ? (
                  <p style={{ fontSize: 13, color: "#848C82" }}>{t("cloudNoProjects")}</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
                    <select
                      value={selectedCloudProjectId}
                      onChange={(e) => setSelectedCloudProjectId(e.target.value)}
                    >
                      <option value="">{t("cloudProjectPick")}</option>
                      {cloudProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.updatedAt ? ` · ${formatBuildTime(p.updatedAt.toISOString())}` : ""}
                        </option>
                      ))}
                    </select>
                    {(() => {
                      const p = cloudProjects.find((p) => p.id === selectedCloudProjectId);
                      if (!p) return null;
                      return (
                        <div style={{ fontSize: 12, color: "#5C6570", display: "flex", flexDirection: "column", gap: 2 }}>
                          {p.id === currentCloudProjectId && (
                            <span style={{ color: "#9C7A2E", fontWeight: 500 }}>{t("cloudCurrentBadge")}</span>
                          )}
                          <span>{t("cloudPreviewStations", { n: p.stationCount })} · {t("cloudPreviewKurse", { n: p.kursCount })}</span>
                          {p.updatedAt && <span>{t("cloudPreviewUpdated")}: {formatBuildTime(p.updatedAt.toISOString())}</span>}
                          <button
                            onClick={() => loadCloudProject(p.id)}
                            style={{ ...styles.addBtn, alignSelf: "flex-start", marginTop: 4 }}
                            disabled={cloudBusy}
                          >
                            {t("cloudLoadBtn")}
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  <button onClick={() => saveCloudProject(false)} style={styles.addBtn} disabled={cloudBusy}>
                    {t("cloudSaveBtn")}
                  </button>
                  {currentCloudProjectId && (
                    <button onClick={() => saveCloudProject(true)} style={styles.ghostBtn} disabled={cloudBusy}>
                      {t("cloudSaveAsNewBtn")}
                    </button>
                  )}
                </div>
                {cloudMsg && <p style={{ fontSize: 13, color: "#171B1F", marginTop: 8 }}>{cloudMsg}</p>}
              </>
            )}
          </div>

          <label style={{ ...styles.intervalLabel, marginBottom: 14 }}>
            {t("scenarioName")}
            <input
              type="text"
              value={scenarioName}
              onChange={(e) => setScenarioName(e.target.value)}
              style={{ width: 220 }}
              placeholder={t("scenarioNamePlaceholder")}
            />
          </label>

          <div style={{ marginBottom: 20 }}>
            <p style={{ fontSize: 12, color: "#848C82", margin: "0 0 6px", fontWeight: 500 }}>{t("jsonFull")}</p>
            <button onClick={exportScenario} style={styles.addBtn}>{t("saveScenario")}</button>
          </div>

          <div style={{ marginBottom: 20 }}>
            <p style={{ fontSize: 12, color: "#848C82", margin: "0 0 6px", fontWeight: 500 }}>{t("csvForExcel")}</p>
            <button onClick={exportKurseCsv} style={{ ...styles.addBtn, marginRight: 8 }}>
              {t("kurseAsCsv")}
            </button>
            <button onClick={exportStationsCsv} style={styles.addBtn}>
              {t("stationsAsCsv")}
            </button>
          </div>

          <div>
            <p style={{ fontSize: 12, color: "#848C82", margin: "0 0 6px", fontWeight: 500 }}>{t("loadTitle")}</p>
            <button onClick={() => loadFileInputRef.current && loadFileInputRef.current.click()} style={styles.addBtn}>
              {t("loadScenario")}
            </button>
            <input
              ref={loadFileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleLoadFile}
              style={{ display: "none" }}
            />
          </div>

          {saveMsg && (
            <p style={{ fontSize: 13, color: "#171B1F", marginTop: 12 }}>{saveMsg}</p>
          )}
        </div>
      )}

        </div>
      </div>
    </div>
  );
}

const styles = {
  app: {
    background: "#F2F4F1",
    color: "#171B1F",
    height: "100vh",
    overflow: "hidden",
    fontSize: 14,
  },
  appShell: {
    display: "flex",
    height: "100vh",
  },
  sidebar: {
    flexShrink: 0,
    background: "#F2F4F1",
    borderRight: "1px solid #D7DBD5",
    padding: "16px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
    transition: "width 0.15s ease",
  },
  sidebarTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 4px",
    marginBottom: 4,
  },
  brandName: {
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  collapseBtn: {
    background: "transparent",
    border: "none",
    color: "#5C6570",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 4,
  },
  navGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  navGroupLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.09em",
    color: "#5C6570",
    fontWeight: 600,
    padding: "0 10px 4px",
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 6,
    fontSize: 13,
    color: "#5C6570",
    background: "transparent",
    border: "none",
    textAlign: "left",
    whiteSpace: "nowrap",
  },
  navItemActive: {
    background: "#9C7A2E14",
    color: "#171B1F",
    fontWeight: 500,
  },
  sidebarFooter: {
    marginTop: "auto",
    paddingTop: 10,
    borderTop: "1px solid #D7DBD5",
  },
  versionInfo: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 10.5,
    color: "#848C82",
    marginBottom: 8,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  langToggleSidebar: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "transparent",
    border: "1px solid #D7DBD5",
    borderRadius: 4,
    padding: "5px 8px",
    fontSize: 11,
    color: "#5C6570",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  dropdownCaret: {
    fontSize: 27,
    lineHeight: 1,
    opacity: 0.65,
    flexShrink: 0,
  },
  langMenuWrap: {
    position: "relative",
  },
  langMenu: {
    position: "absolute",
    bottom: "calc(100% + 6px)",
    left: 0,
    width: "max-content",
    minWidth: "100%",
    background: "#fff",
    border: "1px solid #D7DBD5",
    borderRadius: 6,
    boxShadow: "0 4px 16px rgba(27,36,48,0.18)",
    overflow: "hidden",
    zIndex: 20,
  },
  langMenuItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "7px 10px",
    fontSize: 12.5,
    background: "#fff",
    border: "none",
    borderBottom: "1px solid #E9ECE7",
    color: "#171B1F",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  langMenuItemActive: {
    background: "#F2F4F1",
    fontWeight: 600,
  },
  kurseMenuWrap: {
    position: "relative",
  },
  kurseMenuTrigger: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#fff",
    border: "1px solid #D7DBD5",
    borderRadius: 4,
    padding: "6px 10px",
    fontSize: 13,
    color: "#171B1F",
  },
  kurseMenuCount: {
    fontSize: 11,
    color: "#5C6570",
  },
  kurseMenu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    zIndex: 20,
    background: "#fff",
    border: "1px solid #D7DBD5",
    borderRadius: 6,
    boxShadow: "0 4px 16px rgba(27,36,48,0.18)",
    width: "max-content",
    minWidth: 220,
    maxWidth: "min(560px, 90vw)",
    maxHeight: 320,
    overflowY: "auto",
  },
  kurseMenuActions: {
    display: "flex",
    gap: 12,
    padding: "8px 10px",
    borderBottom: "1px solid #E9ECE7",
    background: "#F2F4F1",
    position: "sticky",
    top: 0,
  },
  kurseMenuActionBtn: {
    background: "transparent",
    border: "none",
    color: "#5C6570",
    fontSize: 11.5,
    padding: 0,
  },
  mainArea: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    padding: 24,
    boxSizing: "border-box",
  },
  tabScroll: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
  },
  mainAreaScroll: {
    display: "block",
    overflowY: "auto",
  },
  diagramTab: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  segmented: {
    display: "flex",
    border: "1px solid #D7DBD5",
    borderRadius: 4,
    overflow: "hidden",
  },
  segBtn: {
    padding: "5px 12px",
    background: "#fff",
    border: "none",
    fontSize: 12.5,
    color: "#5C6570",
  },
  segBtnActive: {
    background: "#171B1F",
    color: "#F2F4F1",
  },
  toolbarRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
    flexShrink: 0,
  },
  toolbarSep: {
    width: 1,
    height: 20,
    background: "#D7DBD5",
  },
  zoomCluster: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    border: "1px solid #D7DBD5",
    borderRadius: 4,
    padding: "2px 5px",
    background: "#fff",
  },
  zoomIcon: {
    fontSize: 12,
    color: "#848C82",
    marginRight: 1,
  },
  zoomVal: {
    fontSize: 12,
    color: "#171B1F",
    fontFamily: "'IBM Plex Mono', monospace",
    minWidth: 34,
    textAlign: "center",
  },
  stepBtn: {
    width: 20,
    height: 20,
    lineHeight: "18px",
    textAlign: "center",
    background: "#F2F4F1",
    border: "1px solid #D7DBD5",
    borderRadius: 3,
    fontSize: 13,
    color: "#171B1F",
    padding: 0,
  },
  stepBtnReset: {
    width: 20,
    height: 20,
    lineHeight: "18px",
    textAlign: "center",
    background: "transparent",
    border: "none",
    fontSize: 12,
    color: "#848C82",
    padding: 0,
  },
  legendConflictRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 8,
    flexShrink: 0,
  },
  windowRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 18,
    marginBottom: 14,
  },
  windowLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12.5,
    color: "#5C6570",
  },
  zoomIndicator: {
    fontSize: 12,
    color: "#5C6570",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  legend: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "6px 10px 8px",
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 0",
  },
  legendSwatch: {
    width: 16,
    height: 3,
    borderRadius: 2,
    display: "inline-block",
  },
  conflictBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 22,
  },
  conflictChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  },
  conflictChip: {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 12,
    color: "#B23A3A",
    border: "1px solid #B23A3A55",
    background: "#B23A3A0F",
    borderRadius: 4,
    padding: "2px 7px",
  },
  conflictDot: {
    width: 9,
    height: 9,
    borderRadius: "50%",
    flexShrink: 0,
  },
  diagramWrap: {
    overflow: "auto",
    flex: 1,
    minHeight: 0,
    border: "1px solid #D7DBD5",
    borderRadius: 4,
  },
  diagramHeaderSticky: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    background: "#EAEDE8",
  },
  contextMenu: {
    position: "fixed",
    zIndex: 20,
    background: "#fff",
    border: "1px solid #D7DBD5",
    borderRadius: 6,
    boxShadow: "0 4px 16px rgba(27,36,48,0.18)",
    minWidth: 220,
    overflow: "hidden",
  },
  contextMenuHeader: {
    padding: "8px 12px",
    fontSize: 11,
    fontFamily: "'IBM Plex Mono', monospace",
    color: "#5C6570",
    background: "#F2F4F1",
    borderBottom: "1px solid #D7DBD5",
  },
  contextMenuItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "9px 12px",
    fontSize: 13,
    background: "#fff",
    border: "none",
    borderBottom: "1px solid #E9ECE7",
    color: "#171B1F",
  },
  contextMenuEmpty: {
    padding: "9px 12px",
    fontSize: 12,
    color: "#848C82",
  },
  panel: {
    background: "#fff",
    border: "1px solid #D7DBD5",
    borderRadius: 6,
    padding: 16,
    maxWidth: 780,
  },
  emptyState: {
    background: "#fff",
    border: "1px dashed #D7DBD5",
    borderRadius: 6,
    padding: 24,
    maxWidth: 480,
  },
  kursCard: {
    background: "#fff",
    border: "1px solid #D7DBD5",
    borderRadius: 10,
    padding: "14px 18px",
    marginBottom: 14,
  },
  kursHeaderRow: {
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  chevronBtn: {
    background: "transparent",
    border: "none",
    color: "#5C6570",
    fontSize: 39,
    lineHeight: 1,
    width: 40,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  colorDot: {
    width: 20,
    height: 20,
    padding: 0,
    border: "1px solid #D7DBD5",
    borderRadius: "50%",
    flexShrink: 0,
    overflow: "hidden",
  },
  kursNameInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "'Space Grotesk', sans-serif",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid transparent",
    borderRadius: 0,
    padding: "2px 0",
    color: "#171B1F",
  },
  ghostBtn: {
    background: "transparent",
    border: "none",
    color: "#5C6570",
    fontSize: 12.5,
    padding: "2px 2px",
  },
  ghostBtnDanger: {
    background: "transparent",
    border: "none",
    color: "#848C82",
    fontSize: 13,
    padding: "2px 4px",
    flexShrink: 0,
  },
  metaRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 20,
    margin: "12px 0 10px",
    paddingLeft: 30,
  },
  metaField: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  metaLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#848C82",
    fontWeight: 600,
  },
  utilityRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    color: "#848C82",
    paddingLeft: 30,
    marginBottom: 10,
  },
  utilityDivider: {
    width: 1,
    height: 12,
    background: "#D7DBD5",
    margin: "0 4px",
  },
  addStopsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
    marginTop: 10,
    paddingLeft: 30,
  },
  rangeRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
    marginTop: 10,
  },
  addBtnSmall: {
    background: "#fff",
    border: "1px solid #D7DBD5",
    borderRadius: 4,
    padding: "5px 10px",
    fontSize: 12,
    fontWeight: 500,
    color: "#171B1F",
  },
  intervalLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#5C6570",
    whiteSpace: "nowrap",
  },
  addBtn: {
    marginTop: 10,
    background: "#fff",
    border: "1px solid #D7DBD5",
    borderRadius: 4,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 500,
    color: "#171B1F",
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "#C4432B",
    fontSize: 12,
  },
  signalBadge: {
    flexShrink: 0,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 10,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "#9C7A2E",
    background: "#F0E6CC",
    border: "1px solid #E0CE9E",
    borderRadius: 3,
    padding: "1px 5px",
  },
  iconBtnNeutral: {
    background: "transparent",
    border: "none",
    color: "#5C6570",
    fontSize: 12,
    padding: "0 4px",
  },
  collapseToggleBtn: {
    background: "#E9ECE7",
    border: "1px solid #D7DBD5",
    borderRadius: 4,
    color: "#171B1F",
    fontSize: 18,
    lineHeight: 1,
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  dragHandle: {
    cursor: "grab",
    fontSize: 16,
    color: "#848C82",
    userSelect: "none",
    display: "inline-block",
    padding: "2px 4px",
  },
  exportLinesList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    background: "#fff",
    border: "1px solid #D7DBD5",
    borderRadius: 6,
    padding: "12px 14px",
    marginTop: 14,
    maxWidth: 720,
  },
  exportLineRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
  },
  exportLineName: {
    minWidth: 110,
    fontWeight: 500,
  },
  exportLineToLabel: {
    fontSize: 12,
    color: "#848C82",
  },
  exportTableWrap: {
    overflow: "auto",
    border: "1px solid #D7DBD5",
    borderRadius: 6,
    maxHeight: "70vh",
  },
  exportTable: {
    borderCollapse: "collapse",
    fontSize: 12,
  },
  exportStationHeaderCell: {
    position: "sticky",
    left: 0,
    top: 0,
    zIndex: 3,
    background: "#171B1F",
    color: "#F2F4F1",
    padding: "7px 10px",
    textAlign: "left",
    minWidth: 160,
    borderBottom: "1px solid #171B1F",
  },
  exportLabelHeaderCell: {
    position: "sticky",
    left: 160,
    top: 0,
    zIndex: 3,
    background: "#171B1F",
    borderBottom: "1px solid #171B1F",
    minWidth: 28,
  },
  exportTrainHeaderCell: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    background: "#171B1F",
    padding: "7px 8px",
    textAlign: "center",
    fontWeight: 600,
    whiteSpace: "nowrap",
    borderBottom: "1px solid #171B1F",
  },
  exportStationCell: {
    position: "sticky",
    left: 0,
    zIndex: 1,
    background: "#fff",
    padding: "5px 10px",
    fontWeight: 500,
    whiteSpace: "nowrap",
    borderBottom: "1px solid #D7DBD5",
    borderRight: "1px solid #D7DBD5",
  },
  exportEchoCell: {
    fontStyle: "italic",
    color: "#848C82",
    fontWeight: 400,
  },
  exportLabelCell: {
    position: "sticky",
    left: 160,
    zIndex: 1,
    background: "#fff",
    padding: "5px 4px",
    fontSize: 10.5,
    color: "#848C82",
    textAlign: "center",
    borderBottom: "1px solid #D7DBD5",
    borderRight: "1px solid #D7DBD5",
  },
  exportCell: {
    padding: "5px 8px",
    textAlign: "center",
    fontFamily: "'IBM Plex Mono', monospace",
    whiteSpace: "nowrap",
    borderBottom: "1px solid #D7DBD5",
  },
  exportCellSymbol: {
    color: "#C7CCC3",
  },
  exportDividerCell: {
    height: 10,
    padding: 0,
    lineHeight: 0,
    fontSize: 0,
    background: "#F2F4F1",
    borderTop: "1px solid #D7DBD5",
    borderBottom: "1px solid #D7DBD5",
  },
};
