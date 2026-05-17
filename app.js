const CLIENT_ID = "786778645862-cejadrqj2edabpdlk0emsvb1gc2hdijs.apps.googleusercontent.com";
const SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
].join(" ");
const SKIP_COURSES = ["Y2 SEN", "Y2 PAK", "Fyzika 2"];
const TOKEN_KEY = "cwa_token";

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
  if (window.google?.accounts?.oauth2) {
    initGis();
  } else {
    setTimeout(waitForGis, 100);
  }
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
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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
      const work = (cwResp.courseWork || []).map((cw) => ({
        ...cw,
        courseName: course.name,
        courseId: course.id,
        submission: subByCw.get(cw.id) || null,
      }));
      return work;
    })
  );

  const allWork = perCourse.flat();
  renderToday(allWork);
  renderFull(allWork);
  $("report").hidden = false;
}

function isPending(a) {
  const s = a.submission?.state;
  return !s || s === "NEW" || s === "CREATED" || s === "RECLAIMED_BY_STUDENT";
}

function isPostedToday(a) {
  if (!a.creationTime) return false;
  const created = new Date(a.creationTime);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 1);
  return created >= since;
}

function dueDateText(a) {
  if (!a.dueDate) return "No due date";
  const { year, month, day } = a.dueDate;
  const t = a.dueTime || {};
  const d = new Date(Date.UTC(year, month - 1, day, t.hours || 23, t.minutes || 59));
  const now = new Date();
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  const txt = d.toLocaleDateString(undefined, opts);
  const overdue = d < now && isPending(a);
  return { txt, overdue };
}

function submissionLabel(a) {
  const s = a.submission?.state;
  if (s === "TURNED_IN") return { txt: "Submitted", cls: "submitted" };
  if (s === "RETURNED") return { txt: "Returned", cls: "submitted" };
  if (s === "RECLAIMED_BY_STUDENT") return { txt: "Reclaimed", cls: "" };
  return { txt: "Not submitted", cls: "" };
}

function assignmentCard(a) {
  const due = dueDateText(a);
  const dueTxt = typeof due === "string" ? due : due.txt;
  const dueCls = typeof due === "object" && due.overdue ? "overdue" : "";
  const sub = submissionLabel(a);

  const el = document.createElement("div");
  el.className = "assignment";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = a.title || "(untitled)";
  const meta = document.createElement("div");
  meta.className = "meta";
  const courseSpan = document.createElement("span");
  courseSpan.textContent = a.courseName;
  const dueSpan = document.createElement("span");
  if (dueCls) dueSpan.className = dueCls;
  dueSpan.textContent = `Due: ${dueTxt}`;
  const subSpan = document.createElement("span");
  if (sub.cls) subSpan.className = sub.cls;
  subSpan.textContent = sub.txt;
  meta.append(courseSpan, dueSpan, subSpan);
  el.append(title, meta);
  el.addEventListener("click", () => openAi(a));
  return el;
}

function renderToday(all) {
  const list = $("todayList");
  list.innerHTML = "";
  const items = all.filter(isPostedToday);
  if (items.length === 0) {
    list.innerHTML = `<div class="empty">No new assignments since yesterday.</div>`;
    return;
  }
  items.forEach((a) => list.appendChild(assignmentCard(a)));
}

function renderFull(all) {
  const list = $("fullList");
  list.innerHTML = "";
  const pending = all.filter(isPending);
  if (pending.length === 0) {
    list.innerHTML = `<div class="empty">Nothing pending. Nice.</div>`;
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
    h.className = "course-name";
    h.textContent = course;
    group.appendChild(h);
    items
      .sort((a, b) => {
        const ad = a.dueDate ? new Date(a.dueDate.year, a.dueDate.month - 1, a.dueDate.day).getTime() : Infinity;
        const bd = b.dueDate ? new Date(b.dueDate.year, b.dueDate.month - 1, b.dueDate.day).getTime() : Infinity;
        return ad - bd;
      })
      .forEach((a) => group.appendChild(assignmentCard(a)));
    list.appendChild(group);
  }
}

function openAi(a) {
  activeAssignment = a;
  aiHistory = [];
  $("aiTitle").textContent = a.title || "Assignment";
  const due = dueDateText(a);
  const dueTxt = typeof due === "string" ? due : due.txt;
  $("aiContext").innerHTML = "";
  const ctxParts = [
    `<strong>${escapeHtml(a.courseName)}</strong>`,
    `Due: ${escapeHtml(dueTxt)}`,
  ];
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
