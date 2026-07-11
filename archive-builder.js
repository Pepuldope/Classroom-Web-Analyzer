// archive-builder.js — builds a personal archive bundle (same schema as the
// offline `School Backup/` pipeline's archive.json) client-side, straight from
// the Google Classroom API, for students who don't have Peter's offline vault.
//
// Everything here runs in the student's own browser: the raw Classroom data
// never leaves it except via the caller-supplied `gFetch` (the app's own
// authenticated fetch helper — this module never touches auth itself), and
// the resulting bundle is handed back to the caller to persist locally
// (see archive.js's storeArchiveBundle). Nothing is ever POSTed anywhere.
//
// `schoolYearOf`, `subjectKeyOf` and `bundleFromRaw` are pure and DOM-free so
// they're node-testable, mirroring archive.js's own pure/impure split.

import { foldText } from "./archive.js";

const CLASSROOM_BASE = "https://classroom.googleapis.com/v1";
const PAGE_SIZE = 100;
const COURSE_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// School-year assignment (simplified from School Backup/scripts/assign-years.mjs
// — that script also consults each course's `section` field and hand-curated
// overrides; here we only have `creationTime`, which is fine for a one-shot
// in-app build).
// ---------------------------------------------------------------------------

/**
 * Slovak school-year string ("YYYY-YY") for a Classroom `creationTime`.
 * Boundary: Aug–Dec belongs to `thatYear-(thatYear+1)`, Jan–Jul to
 * `(thatYear-1)-thatYear` (a course set up in August already belongs to the
 * school year starting that September).
 */
export function schoolYearOf(creationTime) {
  const d = new Date(creationTime);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  const startYear = m >= 8 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Subject-key grouping for the Curriculum map (per-subject-across-years grid).
// ---------------------------------------------------------------------------

// Standalone tokens that identify a year/track rather than the subject itself
// (e.g. "Y2", "Digi", "Lambda", "Sem1") — stripped so same-subject courses
// across years/tracks land on the same row.
const STANDALONE_TRACK_TOKEN_RE = /^(y\d|[0-9]+|i{1,3}|sem\d?|digi|lambda|epsilon|delta)$/;

/** Normalize a course name into a subject grouping key (fold diacritics, drop year/track tokens). */
export function subjectKeyOf(courseName) {
  const folded = foldText(courseName || "");
  const tokens = folded.match(/[a-z0-9]+/g) || [];
  const kept = tokens.filter((tok) => !STANDALONE_TRACK_TOKEN_RE.test(tok));
  return kept.join(" ");
}

// ---------------------------------------------------------------------------
// Path sanitization (vault-relative note paths — mirrors School Backup's
// slugify() concerns re: [ ] # ^ colliding with wikilink syntax, though we
// don't write wikilinks here — just keeping paths filesystem/URL-safe).
// ---------------------------------------------------------------------------

const MAX_SEGMENT_LEN = 100;

function sanitizeSegment(s) {
  let out = String(s == null ? "" : s)
    .replace(/[/\\[\]#^\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!out) out = "untitled";
  if (out.length > MAX_SEGMENT_LEN) out = out.slice(0, MAX_SEGMENT_LEN).trim();
  return out;
}

function makeUniquePath(basePath, usedPaths) {
  if (!usedPaths.has(basePath)) {
    usedPaths.add(basePath);
    return basePath;
  }
  let i = 2;
  let candidate = `${basePath} (${i})`;
  while (usedPaths.has(candidate)) {
    i++;
    candidate = `${basePath} (${i})`;
  }
  usedPaths.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Note-body synthesis — mirrors School Backup/scripts/build-vault.mjs's
// fmtMaterials/workNoteMd/announcementsMd conventions closely enough that the
// browse UI (which just renders `x` as light markdown) looks the same.
// ---------------------------------------------------------------------------

function fmtMaterialLine(m) {
  if (!m) return null;
  if (m.driveFile) {
    const f = m.driveFile.driveFile || m.driveFile;
    return `- [${f.title || "Drive file"}](${f.alternateLink || f.webViewLink || ""})`;
  }
  if (m.youTubeVideo) return `- [${m.youTubeVideo.title || "YouTube video"}](${m.youTubeVideo.alternateLink || ""})`;
  if (m.link) return `- [${m.link.title || m.link.url || "Link"}](${m.link.url || ""})`;
  if (m.form) return `- [${m.form.title || "Form"}](${m.form.formUrl || ""})`;
  return null;
}

function fmtMaterialsList(materials) {
  if (!Array.isArray(materials) || materials.length === 0) return null;
  const lines = materials.map(fmtMaterialLine).filter(Boolean);
  if (lines.length === 0) return null;
  return `Materials:\n${lines.join("\n")}`;
}

function fmtDueDate(dueDate, dueTime) {
  if (!dueDate || !dueDate.year) return null;
  const pad = (n) => String(n).padStart(2, "0");
  let s = `${dueDate.year}-${pad(dueDate.month)}-${pad(dueDate.day)}`;
  if (dueTime && (dueTime.hours != null || dueTime.minutes != null)) {
    s += ` ${pad(dueTime.hours || 0)}:${pad(dueTime.minutes || 0)}`;
  }
  return `Due: ${s}`;
}

function fmtSubmission(sub, maxPoints) {
  if (!sub) return null;
  let stateLine = `Submission: ${sub.state || "UNKNOWN"}`;
  if (sub.assignedGrade != null) {
    stateLine += `, grade ${sub.assignedGrade}${maxPoints != null ? ` / ${maxPoints}` : ""}`;
  }
  const lines = [stateLine];
  const attachments = sub.assignmentSubmission && sub.assignmentSubmission.attachments;
  if (Array.isArray(attachments) && attachments.length) {
    const attLines = attachments.map(fmtMaterialLine).filter(Boolean);
    if (attLines.length) lines.push(...attLines);
  }
  return lines.join("\n");
}

function courseWorkBody(item, submission) {
  const parts = [];
  if (item.description) parts.push(item.description.trim());
  const materialsBlock = fmtMaterialsList(item.materials);
  if (materialsBlock) parts.push(materialsBlock);
  const due = fmtDueDate(item.dueDate, item.dueTime);
  if (due) parts.push(due);
  if (item.maxPoints != null) parts.push(`Max points: ${item.maxPoints}`);
  const subText = fmtSubmission(submission, item.maxPoints);
  if (subText) parts.push(subText);
  return parts.join("\n\n");
}

function materialBody(item) {
  const parts = [];
  if (item.description) parts.push(item.description.trim());
  const materialsBlock = fmtMaterialsList(item.materials);
  if (materialsBlock) parts.push(materialsBlock);
  return parts.join("\n\n");
}

function announcementBlock(a) {
  const lines = [`## ${a.creationTime ? a.creationTime.slice(0, 10) : ""}`];
  if (a.text) lines.push("", a.text.trim());
  const materialsBlock = fmtMaterialsList(a.materials);
  if (materialsBlock) lines.push("", materialsBlock);
  if (a.alternateLink) lines.push("", `[Open in Classroom](${a.alternateLink})`);
  return lines.join("\n");
}

function announcementsBody(announcements) {
  const sorted = [...announcements].sort((a, b) => ((a.creationTime || "") < (b.creationTime || "") ? 1 : -1));
  return sorted.map(announcementBlock).join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Pure bundle synthesis. `raw` shape:
//   {
//     courses: [{ id, name, creationTime, ... }],
//     courseData: {
//       [courseId]: {
//         topics: [{ topicId, name }],
//         courseWork: [{ id, title, description, topicId, dueDate, dueTime, maxPoints, materials, alternateLink }],
//         courseWorkMaterials: [{ id, title, description, topicId, materials }],
//         announcements: [{ id, text, creationTime, materials, alternateLink }],
//         submissions: [{ courseWorkId, state, assignedGrade, assignmentSubmission: { attachments } }],
//       }
//     }
//   }
// ---------------------------------------------------------------------------

/** Build a `{version:1, source:"classroom", ...}` bundle from raw Classroom API data. Pure, node-testable. */
export function bundleFromRaw(raw) {
  const notes = [];
  const courses = [];
  const usedPaths = new Set();
  const courseList = Array.isArray(raw.courses) ? raw.courses : [];

  for (const course of courseList) {
    const year = schoolYearOf(course.creationTime);
    const data = (raw.courseData && raw.courseData[course.id]) || {};
    const topics = Array.isArray(data.topics) ? data.topics : [];
    const topicNameById = new Map(topics.map((t) => [t.topicId, t.name]));
    const submissions = Array.isArray(data.submissions) ? data.submissions : [];
    const subByCwId = new Map(submissions.map((s) => [s.courseWorkId, s]));
    const courseNameSan = sanitizeSegment(course.name);
    let noteCount = 0;

    for (const cw of data.courseWork || []) {
      const topicName = (cw.topicId && topicNameById.get(cw.topicId)) || "Uncategorized";
      const title = (cw.title || "").trim();
      const basePath = `${year}/vault/${courseNameSan}/${sanitizeSegment(topicName)}/${sanitizeSegment(title)}`;
      notes.push({
        p: makeUniquePath(basePath, usedPaths),
        t: title,
        course: course.name,
        y: year,
        topic: topicName,
        kind: "note",
        s: null,
        x: courseWorkBody(cw, subByCwId.get(cw.id)),
      });
      noteCount++;
    }

    for (const m of data.courseWorkMaterials || []) {
      const topicName = (m.topicId && topicNameById.get(m.topicId)) || "Uncategorized";
      const title = (m.title || "").trim();
      const basePath = `${year}/vault/${courseNameSan}/${sanitizeSegment(topicName)}/${sanitizeSegment(title)}`;
      notes.push({
        p: makeUniquePath(basePath, usedPaths),
        t: title,
        course: course.name,
        y: year,
        topic: topicName,
        kind: "note",
        s: null,
        x: materialBody(m),
      });
      noteCount++;
    }

    const announcements = data.announcements || [];
    if (announcements.length > 0) {
      const title = `${course.name} - Announcements`;
      const basePath = `${year}/vault/${courseNameSan}/${sanitizeSegment(title)}`;
      notes.push({
        p: makeUniquePath(basePath, usedPaths),
        t: title,
        course: course.name,
        y: year,
        topic: null,
        kind: "announcements",
        s: null,
        x: announcementsBody(announcements),
      });
      noteCount++;
    }

    courses.push({ name: course.name, y: year, family: null, noteCount });
  }

  const years = [...new Set(courses.map((c) => c.y))].sort();

  return {
    version: 1,
    source: "classroom",
    generatedAt: new Date().toISOString(),
    years,
    courses,
    notes,
    clusters: [],
  };
}

// ---------------------------------------------------------------------------
// Live fetch from the Classroom API. Takes the app's own authenticated
// `gFetch(url) -> Promise<json>` helper (see app.js) so auth/refresh/401
// handling stays in exactly one place.
// ---------------------------------------------------------------------------

function abortError() {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

// gFetch (app.js) throws `Error("Classroom API ${status}: ...")` on non-ok
// responses — parsed back out here so per-facet 403/404s (some archived
// courses deny specific endpoints) can be skipped instead of failing the
// whole build. This is a light coupling to gFetch's error message shape,
// not a re-implementation of its auth/retry logic.
function statusOf(err) {
  const m = /Classroom API (\d+)/.exec((err && err.message) || "");
  return m ? Number(m[1]) : null;
}

async function fetchAllPages(gFetch, urlBuilder, listKey, signal) {
  const items = [];
  let pageToken;
  do {
    if (signal && signal.aborted) throw abortError();
    const resp = await gFetch(urlBuilder(pageToken));
    const page = resp[listKey];
    if (Array.isArray(page)) items.push(...page);
    pageToken = resp.nextPageToken || null;
  } while (pageToken);
  return items;
}

async function fetchFacetGraceful(gFetch, urlBuilder, listKey, signal, failCounter) {
  try {
    return await fetchAllPages(gFetch, urlBuilder, listKey, signal);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    const status = statusOf(e);
    if (status === 403 || status === 404) {
      failCounter.count++;
      return [];
    }
    throw e;
  }
}

const noop = () => {};

/**
 * Fetch everything needed for a personal archive straight from the Classroom
 * API and synthesize it into a bundle. `gFetch` is the caller's authenticated
 * fetch helper. `onProgress({phase, message, done, total})` is called
 * throughout for a live log + progress bar. `signal` (an AbortSignal) lets
 * the caller cancel cleanly — a pending abort surfaces as an `AbortError`.
 */
export async function buildArchiveFromClassroom(gFetch, { onProgress = noop, signal } = {}) {
  onProgress({ phase: "courses", message: "Finding your courses…" });
  const courses = await fetchAllPages(
    gFetch,
    (pageToken) =>
      `${CLASSROOM_BASE}/courses?courseStates=ACTIVE&courseStates=ARCHIVED&pageSize=${PAGE_SIZE}${pageToken ? `&pageToken=${pageToken}` : ""}`,
    "courses",
    signal
  );
  onProgress({
    phase: "courses",
    message: `Found ${courses.length} course${courses.length === 1 ? "" : "s"}.`,
    done: 0,
    total: courses.length,
  });

  const courseData = {};
  let failures = 0;
  let completed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < courses.length) {
      if (signal && signal.aborted) throw abortError();
      const course = courses[cursor++];
      const failCounter = { count: 0 };
      const [topics, courseWork, courseWorkMaterials, announcements, submissions] = await Promise.all([
        fetchFacetGraceful(
          gFetch,
          (pt) => `${CLASSROOM_BASE}/courses/${course.id}/topics?pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`,
          "topic",
          signal,
          failCounter
        ),
        fetchFacetGraceful(
          gFetch,
          (pt) =>
            `${CLASSROOM_BASE}/courses/${course.id}/courseWork?pageSize=${PAGE_SIZE}&courseWorkStates=PUBLISHED${pt ? `&pageToken=${pt}` : ""}`,
          "courseWork",
          signal,
          failCounter
        ),
        fetchFacetGraceful(
          gFetch,
          (pt) =>
            `${CLASSROOM_BASE}/courses/${course.id}/courseWorkMaterials?pageSize=${PAGE_SIZE}&courseWorkMaterialStates=PUBLISHED${pt ? `&pageToken=${pt}` : ""}`,
          "courseWorkMaterial",
          signal,
          failCounter
        ),
        fetchFacetGraceful(
          gFetch,
          (pt) =>
            `${CLASSROOM_BASE}/courses/${course.id}/announcements?pageSize=${PAGE_SIZE}&announcementStates=PUBLISHED${pt ? `&pageToken=${pt}` : ""}`,
          "announcements",
          signal,
          failCounter
        ),
        fetchFacetGraceful(
          gFetch,
          (pt) =>
            `${CLASSROOM_BASE}/courses/${course.id}/courseWork/-/studentSubmissions?userId=me&pageSize=${PAGE_SIZE}${pt ? `&pageToken=${pt}` : ""}`,
          "studentSubmissions",
          signal,
          failCounter
        ),
      ]);
      courseData[course.id] = { topics, courseWork, courseWorkMaterials, announcements, submissions };
      failures += failCounter.count;
      completed++;
      const noteCount = courseWork.length + courseWorkMaterials.length + (announcements.length > 0 ? 1 : 0);
      onProgress({
        phase: "course",
        message: `Fetching course ${completed}/${courses.length}… ${course.name} (${noteCount} note${noteCount === 1 ? "" : "s"})`,
        done: completed,
        total: courses.length,
      });
    }
  }

  const workerCount = Math.max(1, Math.min(COURSE_CONCURRENCY, courses.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  onProgress({ phase: "build", message: "Building your archive…" });
  const bundle = bundleFromRaw({ courses, courseData });
  onProgress({
    phase: "done",
    message: `${bundle.notes.length.toLocaleString()} notes from ${bundle.courses.length} courses across ${bundle.years.length} year${
      bundle.years.length === 1 ? "" : "s"
    }${failures ? ` (${failures} endpoint${failures === 1 ? "" : "s"} skipped)` : ""}.`,
    done: courses.length,
    total: courses.length,
  });
  return bundle;
}
