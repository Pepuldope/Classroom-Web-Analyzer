const CLIENT_ID = "786778645862-cejadrqj2edabpdlk0emsvb1gc2hdijs.apps.googleusercontent.com";
const SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
].join(" ");
const SKIP_COURSES = ["Y2 SEN", "Y2 PAK", "Fyzika 2"];
const TOKEN_KEY = "cwa_token";
const ENRICH_KEY = "cwa_enrich_v1";
const WEEK_DAYS = 7;

let tokenClient = null;
let accessToken = null;
let activeAssignment = null;
let aiHistory = [];

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.classList.toggle("error", !!isError);
}

function loadStoredToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() < expiresAt) return token;
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
  return null;
}

function storeToken(token, expiresInSec) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    token,
    expiresAt: Date.now() + (expiresInSec - 30) * 1000,
  }));
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  accessToken = null;
}

function loadEnrichCache() {
  try { return JSON.parse(localStorage.getItem(ENRICH_KEY) || "{}"); } catch { return {}; }
}
function saveEnrichCache(cache) {
  localStorage.setItem(ENRICH_KEY, JSON.stringify(cache));
}
function enrichCacheKey(a) {
  return `${a.id}:${a.updateTime || ""}`;
}

function initGis() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) {
        setStatus(`Auth failed: ${resp.error}`, true);
        return;
      }
      accessToken = resp.access_token;
      storeToken(accessToken, resp.expires_in);
      onSignedIn();
    },
  });

  const stored = loadStoredToken();
  if (stored) {
    accessToken = stored;
    onSignedIn();
  }
}

function waitForGis() {
  if (window.google?.accounts?.oauth2) initGis();
  else setTimeout(waitForGis, 100);
}
waitForGis();

$("loginBtn").addEventListener("click", () => {
  if (!tokenClient) {
    setStatus("Google client not loaded yet, try again.", true);
    return;
  }
  tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
});

$("logoutBtn").addEventListener("click", () => {
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  clearToken();
  $("loginBtn").hidden = false;
  $("logoutBtn").hidden = true;
  $("report").hidden = true;
  setStatus("Signed out.");
});

async function gFetch(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (r.status === 401) {
    clearToken();
    throw new Error("Session expired — sign in again.");
  }
  if (!r.ok) throw new Error(`Classroom API ${r.status}: ${await r.text()}`);
  return r.json();
}

async function onSignedIn() {
  $("loginBtn").hidden = true;
  $("logoutBtn").hidden = false;
  setStatus("Loading your courses…");
  try {
    await loadReport();
    setStatus("");
  } catch (e) {
    setStatus(e.message, true);
  }
}

function dueDateObj(a) {
  if (!a.dueDate) return null;
  const { year, month, day } = a.dueDate;
  const t = a.dueTime || {};
  return new Date(year, month - 1, day, t.hours ?? 23, t.minutes ?? 59);
}

function isPending(a) {
  const s = a.submission?.state;
  return !s || s === "NEW" || s === "CREATED" || s === "RECLAIMED_BY_STUDENT";
}

function isPostedSinceYesterday(a) {
  if (!a.creationTime) return false;
  const created = new Date(a.creationTime);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 1);
  return created >= since;
}

function daysUntil(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function isInScope(a) {
  if (isPostedSinceYesterday(a)) return true;
  if (!isPending(a)) return false;
  const due = dueDateObj(a);
  if (!due) return false;
  const d = daysUntil(due);
  return d >= -1 && d <= WEEK_DAYS;
}

async function loadReport() {
  const coursesResp = await gFetch("https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=100");
  const courses = (coursesResp.courses || []).filter(
    (c) => !SKIP_COURSES.some((skip) => (c.name || "").toLowerCase().includes(skip.toLowerCase()))
  );

  const perCourse = await Promise.all(
    courses.map(async (course) => {
      const [cwResp, subResp] = await Promise.all([
        gFetch(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork?pageSize=100&orderBy=updateTime%20desc`).catch(() => ({})),
        gFetch(`https://classroom.googleapis.com/v1/courses/${course.id}/courseWork/-/studentSubmissions?userId=me&pageSize=200`).catch(() => ({})),
      ]);
      const submissions = subResp.studentSubmissions || [];
      const subByCw = new Map(submissions.map((s) => [s.courseWorkId, s]));
      return (cwResp.courseWork || []).map((cw) => ({
        ...cw,
        courseName: course.name,
        courseId: course.id,
        submission: subByCw.get(cw.id) || null,
      }));
    })
  );

  const allWork = perCourse.flat();
  const inScope = allWork.filter(isInScope);

  await enrichInScope(inScope);

  renderStatBar(allWork, inScope);
  renderDoNow(inScope);
  renderWeek(inScope);
  renderTodayNew(allWork);
  renderFull(allWork);
  $("report").hidden = false;
}

async function enrichInScope(items) {
  if (items.length === 0) return;
  const cache = loadEnrichCache();
  const need = [];
  for (const a of items) {
    const key = enrichCacheKey(a);
    if (cache[key]) {
      a.enrichment = cache[key];
    } else {
      need.push(a);
    }
  }
  if (need.length === 0) return;

  setStatus(`Analyzing ${need.length} assignment${need.length === 1 ? "" : "s"}…`);
  try {
    const r = await fetch("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assignments: need.map((a) => ({
          id: a.id,
          courseName: a.courseName,
          title: a.title,
          description: a.description,
          materials: a.materials,
          workType: a.workType,
        })),
      }),
    });
    if (!r.ok) {
      console.warn("Enrichment failed", await r.text());
      return;
    }
    const data = await r.json();
    const byId = new Map((data.enrichments || []).map((e) => [e.id, e]));
    for (const a of need) {
      const e = byId.get(a.id);
      if (e) {
        a.enrichment = e;
        cache[enrichCacheKey(a)] = e;
      }
    }
    saveEnrichCache(cache);
  } catch (e) {
    console.warn("Enrichment error", e);
  }
}

function renderStatBar(all, inScope) {
  const overdue = all.filter((a) => {
    if (!isPending(a)) return false;
    const due = dueDateObj(a);
    return due && due < new Date();
  }).length;
  const totalMinutes = inScope.reduce((s, a) => s + (a.enrichment?.estimatedMinutes || 0), 0);
  const hours = Math.round(totalMinutes / 60 * 10) / 10;
  $("statBar").innerHTML = "";
  const stats = [
    { label: "This week", value: inScope.length },
    { label: "Overdue", value: overdue, alert: overdue > 0 },
    { label: "Est. hours", value: hours || "—" },
  ];
  for (const s of stats) {
    const el = document.createElement("div");
    el.className = "stat" + (s.alert ? " alert" : "");
    el.innerHTML = `<strong></strong><span class="label"></span>`;
    el.querySelector("strong").textContent = s.value;
    el.querySelector(".label").textContent = s.label;
    $("statBar").appendChild(el);
  }
}

function priorityClass(weight) {
  if (!weight) return "";
  return `p${Math.max(1, Math.min(5, Math.round(weight)))}`;
}

function actionVerbClass(actionType) {
  if (actionType === "in_person") return "in-person";
  if (actionType === "study_only") return "study";
  return "";
}

function defaultVerb(a) {
  if (a.workType === "ASSIGNMENT") return "Submit";
  if (a.workType === "SHORT_ANSWER_QUESTION" || a.workType === "MULTIPLE_CHOICE_QUESTION") return "Answer";
  return "Do";
}

function assignmentCard(a) {
  const due = dueDateObj(a);
  const e = a.enrichment;
  const verb = e?.actionVerb || defaultVerb(a);
  const verbCls = actionVerbClass(e?.actionType);
  const isInPerson = e?.actionType === "in_person";

  const el = document.createElement("div");
  el.className = "assignment";

  const dot = document.createElement("div");
  dot.className = `priority-dot ${priorityClass(e?.weight)}`;
  if (e?.weight) dot.title = `Priority ${e.weight}/5`;

  const body = document.createElement("div");
  body.className = "assignment-body";

  const titleLine = document.createElement("div");
  const verbEl = document.createElement("span");
  verbEl.className = `verb ${verbCls}`;
  verbEl.textContent = verb;
  const titleEl = document.createElement("span");
  titleEl.className = "title";
  titleEl.textContent = a.title || "(untitled)";
  titleLine.append(verbEl, titleEl);

  body.appendChild(titleLine);

  if (e?.oneLineSummary) {
    const sum = document.createElement("div");
    sum.className = "summary";
    sum.textContent = e.oneLineSummary;
    body.appendChild(sum);
  }

  const meta = document.createElement("div");
  meta.className = "meta";

  const courseSpan = document.createElement("span");
  courseSpan.textContent = a.courseName;
  meta.appendChild(courseSpan);

  if (due) {
    const dueSpan = document.createElement("span");
    const days = daysUntil(due);
    let label;
    if (days < 0) label = `Overdue ${-days}d`;
    else if (days === 0) label = "Due today";
    else if (days === 1) label = "Due tomorrow";
    else label = `Due in ${days}d`;
    dueSpan.textContent = label;
    if (days < 0 && isPending(a)) dueSpan.className = "overdue";
    meta.appendChild(dueSpan);
  }

  if (e?.estimatedMinutes) {
    const eff = document.createElement("span");
    eff.className = "effort";
    eff.textContent = e.estimatedMinutes >= 60
      ? `~${Math.round(e.estimatedMinutes / 60 * 10) / 10}h`
      : `~${e.estimatedMinutes}m`;
    meta.appendChild(eff);
  }

  if (isInPerson) {
    const ip = document.createElement("span");
    ip.textContent = "In-person";
    ip.className = "effort";
    meta.appendChild(ip);
  } else if (a.submission?.state === "TURNED_IN") {
    const ts = document.createElement("span");
    ts.textContent = "Submitted";
    ts.className = "submitted";
    meta.appendChild(ts);
  }

  body.appendChild(meta);
  el.append(dot, body);
  el.addEventListener("click", () => openAi(a));
  return el;
}

function sortByPriorityThenDue(items) {
  return [...items].sort((a, b) => {
    const aw = a.enrichment?.weight || 0;
    const bw = b.enrichment?.weight || 0;
    if (aw !== bw) return bw - aw;
    const ad = dueDateObj(a)?.getTime() ?? Infinity;
    const bd = dueDateObj(b)?.getTime() ?? Infinity;
    return ad - bd;
  });
}

function renderDoNow(inScope) {
  const list = $("doNowList");
  list.innerHTML = "";
  const items = inScope.filter((a) => {
    if (!isPending(a)) return false;
    const due = dueDateObj(a);
    if (!due) return false;
    const d = daysUntil(due);
    return d <= 1 && d >= -7;
  });
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">Nothing urgent for today or tomorrow.</div>`;
    return;
  }
  sortByPriorityThenDue(items).forEach((a) => list.appendChild(assignmentCard(a)));
}

function renderWeek(inScope) {
  const list = $("weekList");
  list.innerHTML = "";
  const items = inScope.filter((a) => {
    if (!isPending(a)) return false;
    const due = dueDateObj(a);
    if (!due) return false;
    const d = daysUntil(due);
    return d >= 2 && d <= WEEK_DAYS;
  });
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">Nothing else due this week.</div>`;
    return;
  }
  const byDay = new Map();
  for (const a of items) {
    const d = daysUntil(dueDateObj(a));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(a);
  }
  const sortedDays = [...byDay.keys()].sort((x, y) => x - y);
  for (const d of sortedDays) {
    const group = document.createElement("div");
    group.className = "day-group";
    const label = document.createElement("div");
    label.className = "day-label";
    const dayDate = new Date(); dayDate.setDate(dayDate.getDate() + d);
    const name = dayDate.toLocaleDateString(undefined, { weekday: "long" });
    const dateText = dayDate.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const dayItems = byDay.get(d);
    const dayMinutes = dayItems.reduce((s, a) => s + (a.enrichment?.estimatedMinutes || 0), 0);
    label.innerHTML = `<span></span><span class="day-meta"></span>`;
    label.children[0].textContent = `${name} · ${dateText}`;
    label.children[1].textContent = dayMinutes
      ? `${dayItems.length} task${dayItems.length === 1 ? "" : "s"} · ~${dayMinutes >= 60 ? Math.round(dayMinutes / 60 * 10) / 10 + "h" : dayMinutes + "m"}`
      : `${dayItems.length} task${dayItems.length === 1 ? "" : "s"}`;
    group.appendChild(label);
    sortByPriorityThenDue(dayItems).forEach((a) => group.appendChild(assignmentCard(a)));
    list.appendChild(group);
  }
}

function renderTodayNew(all) {
  const list = $("todayList");
  list.innerHTML = "";
  const items = all.filter(isPostedSinceYesterday);
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">No new assignments posted since yesterday.</div>`;
    return;
  }
  items.forEach((a) => list.appendChild(assignmentCard(a)));
}

function renderFull(all) {
  const list = $("fullList");
  list.innerHTML = "";
  const pending = all.filter(isPending);
  if (pending.length === 0) {
    list.innerHTML = `<div class="empty">Nothing pending.</div>`;
    return;
  }
  const byCourse = new Map();
  pending.forEach((a) => {
    if (!byCourse.has(a.courseName)) byCourse.set(a.courseName, []);
    byCourse.get(a.courseName).push(a);
  });
  for (const [course, items] of byCourse) {
    const group = document.createElement("div");
    group.className = "course-group";
    const h = document.createElement("div");
    h.className = "day-label";
    h.textContent = course;
    group.appendChild(h);
    items
      .sort((a, b) => (dueDateObj(a)?.getTime() ?? Infinity) - (dueDateObj(b)?.getTime() ?? Infinity))
      .forEach((a) => group.appendChild(assignmentCard(a)));
    list.appendChild(group);
  }
}

function openAi(a) {
  activeAssignment = a;
  aiHistory = [];
  $("aiTitle").textContent = a.title || "Assignment";
  const due = dueDateObj(a);
  const dueTxt = due ? due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "No due date";
  const e = a.enrichment;
  const ctxParts = [
    `<strong>${escapeHtml(a.courseName)}</strong>`,
    `Due: ${escapeHtml(dueTxt)}`,
  ];
  if (e?.oneLineSummary) ctxParts.push(escapeHtml(e.oneLineSummary));
  if (e?.actionType === "in_person") ctxParts.push("<em>In-person task — no upload needed</em>");
  if (a.description) ctxParts.push(escapeHtml(a.description).slice(0, 600));
  $("aiContext").innerHTML = ctxParts.join("<br>");
  $("aiMessages").innerHTML = "";
  $("ai").hidden = false;
  $("aiInput").focus();
}

$("aiClose").addEventListener("click", () => {
  $("ai").hidden = true;
  activeAssignment = null;
});

$("aiForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("aiInput").value.trim();
  if (!text) return;
  $("aiInput").value = "";
  sendAi(text);
});

document.querySelectorAll(".ai-quick button").forEach((btn) => {
  btn.addEventListener("click", () => sendAi(btn.dataset.prompt));
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function addMsg(role, text) {
  const el = document.createElement("div");
  el.className = `ai-msg ${role}`;
  el.textContent = text;
  $("aiMessages").appendChild(el);
  $("aiMessages").scrollTop = $("aiMessages").scrollHeight;
  return el;
}

async function sendAi(userText) {
  if (!activeAssignment) return;
  addMsg("user", userText);
  aiHistory.push({ role: "user", content: userText });
  const thinking = addMsg("assistant", "…");

  const a = activeAssignment;
  const context = [
    `Course: ${a.courseName}`,
    `Assignment: ${a.title || "(untitled)"}`,
    a.description ? `Description: ${a.description}` : null,
    a.materials ? `Materials: ${JSON.stringify(a.materials).slice(0, 1500)}` : null,
  ].filter(Boolean).join("\n");

  const messages = [
    { role: "system", content: `You are a study assistant helping a student with this Google Classroom assignment. Be concise and clear.\n\n${context}` },
    ...aiHistory,
  ];

  try {
    const r = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!r.ok) throw new Error(`AI error ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const reply = data.reply || "(no response)";
    thinking.textContent = reply;
    aiHistory.push({ role: "assistant", content: reply });
  } catch (e) {
    thinking.className = "ai-msg error";
    thinking.textContent = e.message;
  }
}
