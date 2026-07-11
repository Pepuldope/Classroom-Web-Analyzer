// archive.js — client-side personal archive (past school years, exported from
// Obsidian by a separate pipeline into a single archive.json bundle).
//
// Everything here is gated on a bundle being loaded: with no archive, every
// exported function is either a no-op or returns an empty result, and app.js
// never shows archive UI. Nothing here ever leaves the browser except the
// small `archiveNotes` slice sent to /api/ai (see sendAi in app.js).
//
// The search/scoring functions in this file are intentionally DOM- and
// IndexedDB-free so they can be imported and unit-tested in plain node.
// Only loadArchiveFromDisk/importArchive/removeArchive touch indexedDB, and
// only inside their own function bodies (never at module top level).

// ---------------------------------------------------------------------------
// In-memory archive state
// ---------------------------------------------------------------------------

let archive = null; // the parsed bundle, or null if none loaded
let _indexCache = null;
let _indexNotesRef = null;

/** Set the in-memory archive directly (used by disk I/O below, and by tests). */
export function setArchive(bundle) {
  archive = bundle || null;
  _indexCache = null;
  _indexNotesRef = null;
  return archive;
}

/** Current in-memory archive bundle, or null. */
export function getArchive() {
  return archive;
}

// ---------------------------------------------------------------------------
// Pure, DOM-free search functions
// ---------------------------------------------------------------------------

/** Lowercase + strip combining diacritics (š→s, á→a, ž→z, …). */
export function foldText(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const TOKEN_RE = /[a-z0-9]+/g;

/** Split folded text into alphanumeric tokens. */
export function tokenize(s) {
  const folded = foldText(s);
  const out = folded.match(TOKEN_RE);
  return out || [];
}

// Two folded tokens are considered a match if identical, or if they share a
// long-enough prefix — a lightweight stand-in for stemming that lets short
// queries hit inflected Slovak forms (e.g. "matematika" ~ "matematická").
function tokenFuzzyMatch(indexToken, queryToken) {
  if (indexToken === queryToken) return true;
  const minLen = Math.min(indexToken.length, queryToken.length);
  if (minLen < 4) return false;
  const stemLen = Math.min(6, minLen);
  return indexToken.slice(0, stemLen) === queryToken.slice(0, stemLen);
}

/**
 * Inverted index: token → { title: Set<noteIndex>, summary: Set<noteIndex>, body: Set<noteIndex> }.
 * Built once per notes array and cached (see ensureIndex).
 */
export function buildIndex(notes) {
  const index = new Map();
  const add = (tok, field, i) => {
    let entry = index.get(tok);
    if (!entry) {
      entry = { title: new Set(), summary: new Set(), body: new Set() };
      index.set(tok, entry);
    }
    entry[field].add(i);
  };
  notes.forEach((n, i) => {
    for (const tok of tokenize(n.t)) add(tok, "title", i);
    if (n.s) for (const tok of tokenize(n.s)) add(tok, "summary", i);
    if (n.x) for (const tok of tokenize(n.x)) add(tok, "body", i);
  });
  return index;
}

function ensureIndex(notes) {
  if (_indexCache && _indexNotesRef === notes) return _indexCache;
  _indexCache = buildIndex(notes);
  _indexNotesRef = notes;
  return _indexCache;
}

const FIELD_WEIGHT = { title: 5, summary: 3, body: 1 };

function scoreNotes(notes, qTokens, { requireTitleOrSummary = false } = {}) {
  const idx = ensureIndex(notes);
  const scores = new Map(); // noteIndex -> { score, matched: Set<qToken>, titleOrSummaryHit: bool }
  for (const qt of qTokens) {
    for (const [tok, fields] of idx) {
      if (!tokenFuzzyMatch(tok, qt)) continue;
      for (const field of ["title", "summary", "body"]) {
        const weight = FIELD_WEIGHT[field];
        for (const i of fields[field]) {
          let rec = scores.get(i);
          if (!rec) {
            rec = { score: 0, matched: new Set(), titleOrSummaryHit: false };
            scores.set(i, rec);
          }
          rec.score += weight;
          rec.matched.add(qt);
          if (field === "title" || field === "summary") rec.titleOrSummaryHit = true;
        }
      }
    }
  }
  const results = [];
  for (const [i, rec] of scores) {
    if (requireTitleOrSummary && !rec.titleOrSummaryHit) continue;
    let score = rec.score;
    if (rec.matched.size === qTokens.length) score += 2; // bonus: all query tokens present
    results.push({ index: i, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

function findMatchPos(text, qTokens) {
  const folded = foldText(text);
  const re = /[a-z0-9]+/g;
  let m;
  while ((m = re.exec(folded))) {
    for (const qt of qTokens) {
      if (tokenFuzzyMatch(m[0], qt)) return m.index;
    }
  }
  return -1;
}

const SNIPPET_LEN = 160;

function buildSnippet(note, qTokens) {
  const source = note.x || note.s || "";
  if (!source) return "";
  const pos = findMatchPos(source, qTokens);
  if (pos === -1) {
    return source.length > SNIPPET_LEN ? source.slice(0, SNIPPET_LEN).trim() + "…" : source.trim();
  }
  const start = Math.max(0, pos - 40);
  const end = Math.min(source.length, start + SNIPPET_LEN);
  let snippet = source.slice(start, end).trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < source.length) snippet += "…";
  return snippet;
}

/**
 * Full-text search across the loaded archive's notes.
 * score = title hits ×5 + summary hits ×3 + body hits ×1, +2 bonus if every
 * query token matched somewhere in the note. Returns top `limit` notes with
 * a `_score` and a ~160-char `_snippet` around the first body/summary hit.
 */
export function searchArchive(query, { limit = 50 } = {}) {
  if (!archive || !Array.isArray(archive.notes)) return [];
  const notes = archive.notes;
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const scored = scoreNotes(notes, qTokens);
  return scored.slice(0, limit).map(({ index, score }) => ({
    ...notes[index],
    _score: score,
    _snippet: buildSnippet(notes[index], qTokens),
  }));
}

/**
 * Notes relevant to a Classroom assignment, for the AI panel's "From your
 * archive" strip. Requires at least one title-or-summary token hit (never
 * surfaces a note that only matched somewhere deep in its body) to avoid
 * garbage matches.
 */
export function findRelated(assignment, limit = 5) {
  if (!archive || !Array.isArray(archive.notes)) return [];
  if (!assignment) return [];
  const notes = archive.notes;
  const query = [
    assignment.title || "",
    (assignment.description || "").slice(0, 300),
    assignment.courseName || "",
  ].filter(Boolean).join(" ");
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const scored = scoreNotes(notes, qTokens, { requireTitleOrSummary: true });
  return scored.slice(0, limit).map(({ index, score }) => ({
    ...notes[index],
    _score: score,
    _snippet: buildSnippet(notes[index], qTokens),
  }));
}

// ---------------------------------------------------------------------------
// Light, safe markdown rendering for note bodies (headings, bold, italics,
// inline code, lists, code fences). HTML is escaped first — this never does
// innerHTML of raw archive content.
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
}

/** Render a small safe markdown subset of `text` to an HTML string. */
export function renderLightMarkdown(text) {
  const lines = escapeHtml(text == null ? "" : text).split("\n");
  let html = "";
  let inCode = false;
  let codeBuf = [];
  let listOpen = null; // 'ul' | 'ol' | null

  const closeList = () => { if (listOpen) { html += `</${listOpen}>`; listOpen = null; } };

  for (const raw of lines) {
    const fence = raw.match(/^```(\w*)\s*$/);
    if (fence) {
      if (!inCode) { inCode = true; codeBuf = []; closeList(); }
      else { inCode = false; html += `<pre><code>${codeBuf.join("\n")}</code></pre>`; codeBuf = []; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`;
      continue;
    }

    const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listOpen !== "ol") { closeList(); html += "<ol>"; listOpen = "ol"; }
      html += `<li>${inlineMd(ol[1])}</li>`;
      continue;
    }
    const ul = raw.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (listOpen !== "ul") { closeList(); html += "<ul>"; listOpen = "ul"; }
      html += `<li>${inlineMd(ul[1])}</li>`;
      continue;
    }

    closeList();
    if (raw.trim() === "") continue;
    html += `<p>${inlineMd(raw)}</p>`;
  }
  closeList();
  if (inCode && codeBuf.length) html += `<pre><code>${codeBuf.join("\n")}</code></pre>`;
  return html;
}

// ---------------------------------------------------------------------------
// IndexedDB persistence (browser only — never referenced at module top level)
// ---------------------------------------------------------------------------

const DB_NAME = "cwa-archive";
const DB_VERSION = 1;
const STORE_NAME = "archive";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load a previously-imported bundle from IndexedDB into memory, if any. */
export async function loadArchiveFromDisk() {
  try {
    const record = await idbGet("bundle");
    if (record && record.data) {
      setArchive(record.data);
      return record.data;
    }
  } catch (e) {
    console.warn("Archive: failed to load from IndexedDB", e);
  }
  return null;
}

// Shared by importArchive (file) and storeArchiveBundle (in-memory bundle,
// e.g. built client-side from the Classroom API by archive-builder.js) so
// validation/persistence only lives in one place.
async function persistBundle(parsed) {
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
    throw new Error("Unsupported archive version — expected version 1.");
  }
  if (!Array.isArray(parsed.notes)) {
    throw new Error("Archive is missing its notes array.");
  }
  await idbPut({ id: "bundle", data: parsed });
  await idbPut({
    id: "meta",
    noteCount: parsed.notes.length,
    years: Array.isArray(parsed.years) ? parsed.years : [],
    generatedAt: parsed.generatedAt || null,
    importedAt: new Date().toISOString(),
  });
  setArchive(parsed);
  return parsed;
}

/** Parse + validate a File (archive.json), persist it, and load it into memory. */
export async function importArchive(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  return persistBundle(parsed);
}

/** Validate + persist an in-memory bundle (e.g. built client-side by archive-builder.js) the same way importArchive does for a file. */
export async function storeArchiveBundle(bundle) {
  return persistBundle(bundle);
}

/** Delete the stored archive from IndexedDB and clear it from memory. */
export async function removeArchive() {
  try { await idbDelete("bundle"); } catch {}
  try { await idbDelete("meta"); } catch {}
  setArchive(null);
}
