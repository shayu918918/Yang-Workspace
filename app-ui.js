/* 小羊工作台 · 界面交互层（依赖 app-core.js 的全局函数与 state） */
"use strict";

/* ---------- 界面状态 ---------- */
let activeScheduleDay = new Date().getDay();
let currentWeekStart = startOfWeek(todayISO());
let toastTimer;
let lastKnownDay = todayISO();
let lastBannerKey = null;
let pollCount = 0;
const runTimer = { running: false, startTs: 0, accSec: 0 };
const scheduleTimeDrafts = new Map();
const openScheduleTimeEditors = new Set();

document.addEventListener("DOMContentLoaded", init);

function init() {
  registerServiceWorker();
  ensureWeek(state, currentWeekStart);
  autoGeneratePastWeekReports();
  bindNavigation();
  bindForms();
  bindScheduleStatic();
  bindReportsStatic();
  initDates();
  restoreRunDraft();
  renderAll();
  setViewFromHash();
  startGlobalLoop();
  bindResumeRefresh();
}

function bindResumeRefresh() {
  const refreshElapsedTime = () => {
    checkDayChange();
    updateTimerClocks();
    updateRunTimerDisplay();
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshElapsedTime();
    else persistRunDraft();
  });
  window.addEventListener("pagehide", persistRunDraft);
  window.addEventListener("pageshow", refreshElapsedTime);
  window.addEventListener("focus", refreshElapsedTime);
}

/* ---------- 全局节拍：刷新计时表盘与慢任务 ---------- */
function startGlobalLoop() {
  setInterval(() => {
    pollCount += 1;
    updateTimerClocks();
    updateRunTimerDisplay();
    if (pollCount % 40 === 0) {
      // 约每 20 秒
      refreshBanner();
      renderHomeBanner();
      checkScheduleTransitions();
      checkDayChange();
    }
  }, 500);
}

function updateTimerClocks() {
  habitDefs.filter((habit) => habit.tracking === "timer").forEach((habit) => {
    const timer = getHabitTimer(state, habit.id);
    const el = document.querySelector(`[data-clock="${habit.id}"]`);
    if (el && timer) el.textContent = formatClock(Math.round(timerElapsedMs(timer) / 1000));
    const homeEl = document.querySelector(`[data-home-clock="${habit.id}"]`);
    if (homeEl) homeEl.textContent = timer ? formatClock(Math.round(timerElapsedMs(timer) / 1000)) : "";
  });
}

function updateRunTimerDisplay() {
  if (!runTimer.running) return;
  const el = document.getElementById("runTimerDisplay");
  if (!el) return;
  const elapsed = runTimer.accSec + Math.floor((Date.now() - runTimer.startTs) / 1000);
  el.textContent = formatClock(elapsed);
}

function checkDayChange() {
  const today = todayISO();
  if (today === lastKnownDay) return;
  lastKnownDay = today;
  initDates();
  autoGeneratePastWeekReports();
  renderAll();
}

/* ---------- 导航 ---------- */
function bindNavigation() {
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    document.getElementById("mainContent").focus();
    window.scrollTo({ top: 0, behavior: "auto" });
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelectorAll("[data-jump]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.jump));
  });
  window.addEventListener("hashchange", setViewFromHash);
}

function setViewFromHash() {
  const view = location.hash.replace("#", "") || "home";
  setView(view, false);
}

function viewGroup(view) {
  if (["stillness", "running"].includes(view)) return "record";
  if (["reports", "settings"].includes(view)) return "more";
  return view;
}

function setView(view, updateHash = true) {
  const normalized = ["home", "stillness", "running", "schedule", "reports", "settings"].includes(view) ? view : "home";
  const group = viewGroup(normalized);
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `view-${normalized}`);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    const buttonGroup = button.dataset.navGroup || button.dataset.view;
    const active = buttonGroup === group;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".section-tab").forEach((button) => {
    const active = button.dataset.view === normalized;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (updateHash) history.replaceState(null, "", `#${normalized}`);
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  if (normalized === "reports") renderReport();
  if (normalized === "schedule") {
    refreshBanner();
    centerActiveScheduleDay();
  }
}

/* ---------- 表单与静态控件绑定 ---------- */
function bindForms() {
  document.getElementById("runForm").addEventListener("submit", saveRun);
  document.getElementById("runTimerButton").addEventListener("click", toggleRunTimer);
  ["runDistance", "runMinutes", "runSeconds"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateRunPreview);
  });
  ["runDate", "runDistance", "runMinutes", "runSeconds", "runNote"].forEach((id) => {
    document.getElementById(id).addEventListener("input", persistRunDraft);
  });
  document.getElementById("settingsForm").addEventListener("submit", saveSettings);
  document.getElementById("refreshAppButton").addEventListener("click", refreshApplication);
  document.getElementById("backupButton").addEventListener("click", exportBackup);
  document.getElementById("restoreInput").addEventListener("change", restoreBackup);
  document.getElementById("runList").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-del-run]");
    if (!btn) return;
    state.runningSessions = state.runningSessions.filter((r) => r.id !== btn.dataset.delRun);
    saveState(state);
    showToast("已删除该条跑步记录。");
    renderAll();
  });
}

function bindScheduleStatic() {
  document.getElementById("weekPrevButton").addEventListener("click", () => shiftScheduleWeek(-7));
  document.getElementById("weekNextButton").addEventListener("click", () => shiftScheduleWeek(7));
  document.getElementById("backToCurrentWeekButton").addEventListener("click", () => {
    currentWeekStart = startOfWeek(todayISO());
    ensureWeek(state, currentWeekStart);
    renderSchedule();
    renderHome();
  });
  document.getElementById("copyLastWeekButton").addEventListener("click", () => {
    const ok = copyWeekTitles(state, currentWeekStart);
    if (ok) {
      const sourceIds = new Set(state.scheduleWeeks[addDays(currentWeekStart, -7)].slots.map((slot) => slot.id));
      getWeek(state, currentWeekStart).slots.forEach((slot) => {
        if (sourceIds.has(slot.copySourceId)) scheduleTimeDrafts.delete(`${currentWeekStart}:${slot.id}`);
      });
      showToast("已复制上周的课名和时间。");
    }
    else showToast("上周没有可复制的课表。");
    saveState(state);
    renderSchedule();
    renderHome();
  });
  document.getElementById("clearWeekTitlesButton").addEventListener("click", () => {
    clearWeekTitles(state, currentWeekStart);
    saveState(state);
    showToast("已清空当前周的课名。");
    renderSchedule();
    renderHome();
  });
  document.getElementById("weekReportButton").addEventListener("click", () => {
    const week = getWeek(state, currentWeekStart);
    week.report = buildScheduleReport(state, currentWeekStart);
    saveState(state);
    renderWeekReportPanel();
    showToast("周报告已生成，保存在本机。");
  });
}

function shiftScheduleWeek(dir) {
  currentWeekStart = addDays(currentWeekStart, dir);
  ensureWeek(state, currentWeekStart);
  renderSchedule();
  renderHome();
}

function renderWeekReportPanel() {
  const week = getWeek(state, currentWeekStart);
  const output = document.getElementById("weekReportOutput");
  if (week.report) {
    output.textContent = week.report;
    return;
  }
  // 已结束的周，翻到时自动生成并保存
  if (addDays(currentWeekStart, 6) < todayISO()) {
    week.report = buildScheduleReport(state, currentWeekStart);
    saveState(state);
    output.textContent = week.report;
    return;
  }
  output.textContent = "点「生成周报告」查看当前周的汇总。";
}

function bindReportsStatic() {
  ["reportKind", "reportRange", "reportDate", "reportHabit"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderReport);
  });
  document.querySelectorAll("[data-report-range]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      document.getElementById("reportRange").value = button.dataset.reportRange;
      renderReport();
    });
  });
  document.getElementById("copyReportButton").addEventListener("click", copyReport);
  document.getElementById("exportReportButton").addEventListener("click", exportReportText);
  document.getElementById("periodPrevButton").addEventListener("click", () => shiftReportPeriod(-1));
  document.getElementById("periodNextButton").addEventListener("click", () => shiftReportPeriod(1));
  document.getElementById("periodTodayButton").addEventListener("click", () => {
    document.getElementById("reportDate").value = todayISO();
    renderReport();
  });
  document.getElementById("managerList").addEventListener("click", (event) => {
    const delStill = event.target.closest("[data-del-stillness]");
    const delRun = event.target.closest("[data-del-run]");
    if (delStill) {
      state.stillnessSessions = state.stillnessSessions.filter((s) => s.id !== delStill.dataset.delStillness);
      showToast("已删除该条静修记录。");
    }
    if (delRun) {
      state.runningSessions = state.runningSessions.filter((r) => r.id !== delRun.dataset.delRun);
      showToast("已删除该条跑步记录。");
    }
    if (delStill || delRun) {
      saveState(state);
      renderAll();
      renderReport();
    }
  });
}

function initDates() {
  const today = todayISO();
  if (!state.runDraft) document.getElementById("runDate").value = today;
  document.getElementById("reportDate").value = today;
  activeScheduleDay = editableDays.includes(activeScheduleDay) ? activeScheduleDay : 1;
  document.getElementById("todayLabel").textContent = formatLongDate(today);
  lastKnownDay = today;
}

function renderAll() {
  renderHome();
  renderHabitTimers();
  renderRuns();
  renderSchedule();
  hydrateSettings();
  saveState(state);
}

/* ---------- 首页 ---------- */
function renderHome() {
  const today = todayISO();
  const stillnessSeconds = state.stillnessSessions
    .filter((item) => item.date === today && item.type !== "baduanjin")
    .reduce((acc, item) => acc + item.durationSeconds, 0);
  const baduanjinCount = countHabitRecords(state, "baduanjin", today, today);
  document.getElementById("homeStillnessMeta").textContent = `今天 ${Math.round(stillnessSeconds / 60)} 分钟 · 八段锦 ${baduanjinCount} 次`;
  const runsToday = state.runningSessions.filter((item) => item.date === today);
  const runDistance = runsToday.reduce((acc, item) => acc + item.distanceKm, 0);
  document.getElementById("homeRunMeta").textContent = `今天 ${runDistance.toFixed(2)} 公里 · 累计 ${state.runningSessions.length} 次`;
  renderHomeBanner();
  renderHomeHabits();
  const weekStart = startOfWeek(today);
  const day = new Date().getDay();
  const todaySlots = getWeek(state, weekStart).slots
    .filter((slot) => slot.day === day && slot.title.trim())
    .sort(compareScheduleSlots);
  const doneCount = todaySlots.filter((slot) => slot.done).length;
  document.getElementById("todayScheduleMeta").textContent = todaySlots.length ? `${doneCount}/${todaySlots.length} 已完成` : "今天没有课";
  const list = document.getElementById("homeScheduleList");
  list.innerHTML = todaySlots.length
    ? todaySlots.map((slot) => `
      <div class="list-item action-row">
        <div class="action-row-text">
          <div class="item-title">《${escapeHtml(slot.title)}》</div>
          <div class="item-meta">${slot.start}-${slot.end} · ${slot.done ? "已完成" : "待打卡"}</div>
        </div>
        <button class="secondary-button" type="button" data-home-toggle="${slot.id}">${slot.done ? "取消" : "完成"}</button>
      </div>
    `).join("")
    : `<div class="list-item action-row empty-state"><div class="action-row-text"><div class="item-title">留一点时间，给想做的事</div><p class="item-meta">今天还没有安排课程。</p></div><button class="secondary-button" type="button" data-home-schedule>安排课程</button></div>`;
  list.querySelectorAll("[data-home-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleSlotDone(button.dataset.homeToggle, weekStart));
  });
  const scheduleButton = list.querySelector("[data-home-schedule]");
  if (scheduleButton) scheduleButton.addEventListener("click", () => {
    currentWeekStart = weekStart;
    activeScheduleDay = day;
    renderSchedule();
    setView("schedule");
  });
}

function renderHomeBanner() {
  const banner = document.getElementById("homeBanner");
  const status = statusFor(nowHHMM());
  if (status.key === "none") {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.textContent = status.text;
}

function renderHomeHabits() {
  const grid = document.getElementById("homeHabitGrid");
  const today = todayISO();
  grid.innerHTML = habitDefs.map((habit) => {
    if (habit.tracking === "count") {
      const todayCount = countHabitRecords(state, habit.id, today, today);
      return `
        <article class="home-habit-card habit-${habit.id} count-habit-card">
          ${habitArtwork(habit)}
          <div class="home-habit-content">
          <div class="home-habit-head">
            <h4>${habit.title}</h4>
            <span class="home-count-value">${todayCount}<small>次</small></span>
          </div>
          <div class="home-habit-meta"><span>今日</span><strong>${todayCount ? `已完成 ${todayCount} 次` : "尚未记录"}</strong></div>
          <button class="secondary-button home-habit-button" type="button" data-home-count="${habit.id}" aria-label="${habit.title}记一次">
            <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg><span>记一次</span>
          </button>
          </div>
        </article>`;
    }
    const timer = getHabitTimer(state, habit.id);
    const running = !!(timer && timer.running);
    const active = !!timer;
    const elapsedSec = Math.round(timerElapsedMs(timer) / 1000);
    const todayTotal = state.stillnessSessions
      .filter((s) => s.date === today && s.type === habit.id)
      .reduce((acc, s) => acc + s.durationSeconds, 0);
    const label = active ? "结束" : "开始";
    const buttonIcon = active
      ? `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>`
      : `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5Z"></path></svg>`;
    return `
      <article class="home-habit-card habit-${habit.id} ${running ? "running" : ""}">
        ${habitArtwork(habit, running)}
        <div class="home-habit-content">
        <div class="home-habit-head">
          <h4>${habit.title}</h4>
          <span class="home-habit-clock" data-home-clock="${habit.id}" role="timer" aria-label="${habit.title}已计时">${active ? formatClock(elapsedSec) : ""}</span>
        </div>
        <div class="home-habit-meta"><span>今日</span><strong>${formatDuration(todayTotal)}</strong></div>
        <button class="secondary-button home-habit-button" type="button" data-home-start="${habit.id}" aria-label="${active ? "结束" : "开始"}${habit.title}计时" aria-pressed="${active}">${buttonIcon}<span>${label}</span></button>
        </div>
      </article>`;
  }).join("");
  grid.querySelectorAll("[data-home-start]").forEach((button) => {
    button.addEventListener("click", () => {
      homeTimerAction(button.dataset.homeStart);
      grid.querySelector(`[data-home-start="${button.dataset.homeStart}"]`)?.focus({ preventScroll: true });
    });
  });
  grid.querySelectorAll("[data-home-count]").forEach((button) => {
    button.addEventListener("click", () => {
      addCountHabit(button.dataset.homeCount);
      grid.querySelector(`[data-home-count="${button.dataset.homeCount}"]`)?.focus({ preventScroll: true });
    });
  });
}

// Each practice has its own full illustration, shared by the home and record cards.
function habitArtwork(habit, running = false) {
  const captions = { meditation: "呼吸 · 觉察", standing: "松静 · 养气", reading: "开卷 · 有得", walking: "缓行 · 观景", focus: "专心 · 致知", baduanjin: "舒展 · 调息" };
  return `<div class="habit-art" aria-hidden="true"><img src="assets/${habit.id}-v47.webp" alt="" width="768" height="512" loading="lazy" decoding="async"><span class="habit-art-label">${running ? "计时中" : captions[habit.id]}</span></div>`;
}

function homeTimerAction(id) {
  const timer = getHabitTimer(state, id);
  if (timer) {
    finishTimer(id);
    return;
  }
  startTimer(id);
  showToast(`${habitTitle(id)}开始计时。`);
}

/* ---------- 静修计时与次数记录 ---------- */
function renderHabitTimers() {
  const grid = document.getElementById("habitTimerGrid");
  grid.innerHTML = habitDefs.map((habit) => {
    if (habit.tracking === "count") {
      const today = todayISO();
      const todayCount = countHabitRecords(state, habit.id, today, today);
      const recent = state.stillnessSessions.find((s) => s.type === habit.id);
      return `
        <article class="timer-card habit-${habit.id} count-timer-card">
          ${habitArtwork(habit)}
          <div class="timer-content">
          <div class="timer-row count-timer-row">
            <div>
              <h3>${habit.title}</h3>
              <div class="timer-meta">
                <span><small>记录方式</small><strong>每完成一遍记 1 次</strong></span>
                <span><small>最近</small><strong>${recent ? `${recent.date.slice(5)} · ${sessionMeasure(recent)}` : "暂无记录"}</strong></span>
              </div>
            </div>
            <div class="count-display" aria-label="今日${habit.title} ${todayCount} 次"><strong>${todayCount}</strong><small>次</small></div>
          </div>
          <div class="count-actions">
            <button class="secondary-button" type="button" data-count-undo="${habit.id}" aria-label="撤销一次${habit.title}" ${todayCount ? "" : "disabled"}>撤销一次</button>
            <button class="primary-button" type="button" data-count-add="${habit.id}" aria-label="${habit.title}记一次">
              <svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg><span>记一次</span>
            </button>
          </div>
          </div>
        </article>`;
    }
    const timer = getHabitTimer(state, habit.id);
    const elapsedSec = Math.round(timerElapsedMs(timer) / 1000);
    const running = !!(timer && timer.running);
    const active = !!timer;
    const todayTotal = state.stillnessSessions
      .filter((s) => s.date === todayISO() && s.type === habit.id)
      .reduce((acc, s) => acc + s.durationSeconds, 0);
    const recent = state.stillnessSessions.find((s) => s.type === habit.id);
    const buttonIcon = active
      ? `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>`
      : `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5Z"></path></svg>`;
    return `
      <article class="timer-card habit-${habit.id} ${running ? "running" : ""}">
        ${habitArtwork(habit, running)}
        <div class="timer-content">
        <div class="timer-row">
          <div>
            <h3>${habit.title}</h3>
            <div class="timer-meta">
              <span><small>今日</small><strong>${formatDuration(todayTotal)}</strong></span>
              <span><small>最近</small><strong>${recent ? `${recent.date.slice(5)} · ${formatDuration(recent.durationSeconds)}` : "暂无记录"}</strong></span>
            </div>
          </div>
          <div class="timer-clock" data-clock="${habit.id}" role="timer" aria-label="${habit.title}已计时">${formatClock(elapsedSec)}</div>
        </div>
        <div class="timer-actions">
          <button class="${active ? "timer-end-button" : "primary-button"} timer-toggle-button" type="button" data-timer-action="${habit.id}" aria-label="${active ? "结束" : "开始"}${habit.title}计时" aria-pressed="${active}">${buttonIcon}<span>${active ? "结束计时" : habit.id === "focus" ? "开始专注" : "开始计时"}</span></button>
        </div>
        </div>
      </article>`;
  }).join("");
  grid.querySelectorAll("[data-timer-action]").forEach((button) => {
    button.addEventListener("click", () => {
      homeTimerAction(button.dataset.timerAction);
      grid.querySelector(`[data-timer-action="${button.dataset.timerAction}"]`)?.focus({ preventScroll: true });
    });
  });
  grid.querySelectorAll("[data-count-add]").forEach((button) => {
    button.addEventListener("click", () => {
      addCountHabit(button.dataset.countAdd);
      grid.querySelector(`[data-count-add="${button.dataset.countAdd}"]`)?.focus({ preventScroll: true });
    });
  });
  grid.querySelectorAll("[data-count-undo]").forEach((button) => {
    button.addEventListener("click", () => {
      undoCountHabit(button.dataset.countUndo);
      const nextUndo = grid.querySelector(`[data-count-undo="${button.dataset.countUndo}"]`);
      (nextUndo?.disabled ? grid.querySelector(`[data-count-add="${button.dataset.countUndo}"]`) : nextUndo)?.focus({ preventScroll: true });
    });
  });
}

function addCountHabit(id) {
  const session = recordCountHabit(state, id);
  if (!session) return;
  saveState(state);
  showToast(`已记下${habitTitle(id)} 1 次。`);
  renderAll();
}

function undoCountHabit(id) {
  if (!removeLatestCountHabit(state, id)) {
    showToast("今天还没有可撤销的记录。");
    return;
  }
  saveState(state);
  showToast(`已撤销今天最近一次${habitTitle(id)}记录。`);
  renderAll();
}

function startTimer(id) {
  const timer = getHabitTimer(state, id);
  if (timer && timer.running) return;
  startHabitTimer(state, id);
  saveState(state);
  renderHabitTimers();
  renderHome();
}

function finishTimer(id) {
  const session = finishHabitTimer(state, id);
  if (!session) {
    saveState(state);
    showToast("计时不足 1 秒，未记录。");
    renderHabitTimers();
    renderHome();
    return;
  }
  saveState(state);
  showToast(`已记下${habitTitle(id)} ${formatDuration(session.durationSeconds)}。`);
  renderAll();
}

/* ---------- 跑步 ---------- */
function persistRunDraft() {
  const fields = {};
  ["runDate", "runDistance", "runMinutes", "runSeconds", "runNote"].forEach((id) => {
    fields[id] = document.getElementById(id).value;
  });
  const hasDraft = runTimer.running || ["runDistance", "runMinutes", "runSeconds", "runNote"].some((id) => fields[id] !== "");
  state.runDraft = hasDraft ? { ...fields, timer: { ...runTimer } } : null;
  saveState(state);
}

function restoreRunDraft() {
  const draft = normalizeRunDraft(state.runDraft);
  if (draft) {
    ["runDate", "runDistance", "runMinutes", "runSeconds", "runNote"].forEach((id) => {
      document.getElementById(id).value = draft[id] || (id === "runDate" ? todayISO() : "");
    });
    Object.assign(runTimer, draft.timer);
  }
  renderRunTimerButton();
  updateRunPreview();
}

function saveRun(event) {
  event.preventDefault();
  if (runTimer.running) {
    runTimer.accSec += Math.floor((Date.now() - runTimer.startTs) / 1000);
    runTimer.running = false;
    document.getElementById("runMinutes").value = Math.floor(runTimer.accSec / 60);
    document.getElementById("runSeconds").value = runTimer.accSec % 60;
  }
  runTimer.accSec = 0;
  renderRunTimerButton();
  persistRunDraft();
  const date = document.getElementById("runDate").value || todayISO();
  const km = Number(document.getElementById("runDistance").value);
  const minutes = Number(document.getElementById("runMinutes").value) || 0;
  const seconds = Number(document.getElementById("runSeconds").value) || 0;
  const durationSeconds = minutes * 60 + seconds;
  if (!km || km <= 0) {
    showToast("距离要大于 0。");
    return;
  }
  if (!durationSeconds) {
    showToast("用时不能为 0，可以点「开始计时」。");
    return;
  }
  const calPerKm = Number(state.settings.caloriesPerKm) || 60;
  state.runningSessions.unshift({
    id: uid("run"),
    date,
    distanceKm: km,
    durationSeconds,
    paceSecondsPerKm: Math.round(durationSeconds / km),
    calories: Math.round(km * calPerKm),
    note: document.getElementById("runNote").value.trim(),
    createdAt: new Date().toISOString()
  });
  document.getElementById("runDistance").value = "";
  document.getElementById("runMinutes").value = "";
  document.getElementById("runSeconds").value = "";
  document.getElementById("runNote").value = "";
  persistRunDraft();
  showToast("跑步记录已保存。");
  updateRunPreview();
  renderAll();
}

function toggleRunTimer() {
  if (runTimer.running) {
    runTimer.accSec += Math.floor((Date.now() - runTimer.startTs) / 1000);
    runTimer.running = false;
    document.getElementById("runMinutes").value = Math.floor(runTimer.accSec / 60);
    document.getElementById("runSeconds").value = runTimer.accSec % 60;
    updateRunPreview();
    showToast("计时已停止，用时已填入。");
  } else {
    runTimer.running = true;
    runTimer.startTs = Date.now();
    runTimer.accSec = 0;
    showToast("计时开始，跑完点「停止计时」。");
  }
  renderRunTimerButton();
  persistRunDraft();
}

function renderRunTimerButton() {
  const button = document.getElementById("runTimerButton");
  const icon = runTimer.running
    ? `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>`
    : `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5Z"></path></svg>`;
  button.innerHTML = `${icon}<span>${runTimer.running ? "停止计时" : "开始计时"}</span>`;
  button.setAttribute("aria-label", runTimer.running ? "停止跑步计时" : "开始跑步计时");
  button.setAttribute("aria-pressed", String(runTimer.running));
  button.classList.toggle("timer-end-button", runTimer.running);
  document.getElementById("runMinutes").readOnly = runTimer.running;
  document.getElementById("runSeconds").readOnly = runTimer.running;
  document.getElementById("runTimerDisplay").textContent = formatClock(runTimer.running
    ? runTimer.accSec + Math.floor((Date.now() - runTimer.startTs) / 1000)
    : runTimer.accSec);
}

function updateRunPreview() {
  const km = Number(document.getElementById("runDistance").value);
  const minutes = Number(document.getElementById("runMinutes").value) || 0;
  const seconds = Number(document.getElementById("runSeconds").value) || 0;
  const total = minutes * 60 + seconds;
  const hint = document.getElementById("runDraftHint");
  if (km > 0 && total > 0) {
    const calPerKm = Number(state.settings.caloriesPerKm) || 60;
    hint.textContent = `配速约 ${formatPace(Math.round(total / km))}，预计消耗 ${Math.round(km * calPerKm)} 大卡。`;
    hint.hidden = false;
  } else {
    hint.textContent = "";
    hint.hidden = true;
  }
}

function renderRuns() {
  const list = document.getElementById("runList");
  document.getElementById("runListMeta").textContent = `${state.runningSessions.length} 次`;
  const items = state.runningSessions.slice(0, 20);
  list.innerHTML = items.length
    ? items.map((run) => `
      <div class="list-item">
        <div class="item-title">${run.date} · ${run.distanceKm.toFixed(2)} 公里</div>
        <div class="item-meta">用时 ${formatRunDuration(run.durationSeconds)} · 配速 ${formatPace(run.paceSecondsPerKm)} · ${Math.round(run.calories)} 大卡${run.note ? ` · ${escapeHtml(run.note)}` : ""}</div>
        <button class="delete-link" type="button" data-del-run="${escapeAttribute(run.id)}"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="m9 7 1-3h4l1 3"></path><path d="m6 7 1 14h10l1-14"></path></svg><span>删除</span></button>
      </div>
    `).join("")
    : `<div class="list-item"><div class="item-title">还没有跑步记录</div></div>`;
}

/* ---------- 课程表 ---------- */
function formatScheduleTimeDraft(rawValue, cursorPosition = String(rawValue).length) {
  const raw = String(rawValue).replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10)).replace(/[：;；]/g, ":");
  const colon = raw.indexOf(":");
  const digits = (text) => text.replace(/\D/g, "");
  if (colon >= 0) {
    const hours = digits(raw.slice(0, colon)).slice(0, 2);
    const minutes = digits(raw.slice(colon + 1)).slice(0, 2);
    const value = `${hours}:${minutes}`;
    const cursor = cursorPosition <= colon
      ? Math.min(digits(raw.slice(0, cursorPosition)).length, hours.length)
      : hours.length + 1 + Math.min(digits(raw.slice(colon + 1, cursorPosition)).length, minutes.length);
    return { value, cursor };
  }
  let valueDigits = digits(raw).slice(0, 4);
  let digitCursor = Math.min(digits(raw.slice(0, cursorPosition)).length, valueDigits.length);
  // A leading 3–9 is an unambiguous one-digit hour: 930 becomes 09:30.
  if (valueDigits.length >= 2 && Number(valueDigits[0]) >= 3) {
    valueDigits = `0${valueDigits}`.slice(0, 4);
    digitCursor += 1;
  }
  const value = valueDigits.length >= 2 ? `${valueDigits.slice(0, 2)}:${valueDigits.slice(2)}` : valueDigits;
  return { value, cursor: Math.min(value.length, digitCursor >= 2 ? digitCursor + 1 : digitCursor) };
}

function rememberScheduleTimeDraft(form) {
  const start = form.querySelector('[data-field="start"]').value;
  const end = form.querySelector('[data-field="end"]').value;
  scheduleTimeDrafts.set(`${currentWeekStart}:${form.dataset.slotTimeForm}`, { start, end });
  form.querySelector("button").disabled = false;
  form.querySelector(".schedule-time-feedback").hidden = true;
  form.querySelectorAll("input").forEach((input) => input.removeAttribute("aria-invalid"));
}

function bindScheduleTimeInput(input, form) {
  input.addEventListener("focus", () => input.select());
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || input.selectionStart !== input.selectionEnd) return;
    const cursor = input.selectionStart;
    const value = input.value;
    if ((event.key === ":" || event.key === "：") && value[cursor] === ":") {
      event.preventDefault();
      input.setSelectionRange(cursor + 1, cursor + 1);
    } else if (event.key === "Backspace" && value[cursor - 1] === ":" && cursor > 1) {
      event.preventDefault();
      input.value = value.slice(0, cursor - 2) + value.slice(cursor - 1);
      input.setSelectionRange(cursor - 2, cursor - 2);
      rememberScheduleTimeDraft(form);
    } else if (event.key === "Delete" && value[cursor] === ":") {
      event.preventDefault();
      input.value = value.slice(0, cursor + 1) + value.slice(cursor + 2);
      input.setSelectionRange(cursor + 1, cursor + 1);
      rememberScheduleTimeDraft(form);
    }
  });
  input.addEventListener("input", (event) => {
    if (event.isComposing) return;
    const raw = input.value;
    const previousCursor = input.selectionStart ?? raw.length;
    const formatted = formatScheduleTimeDraft(raw, previousCursor);
    input.value = formatted.value;
    let cursor = formatted.cursor;
    if (event.inputType?.startsWith("insert") && cursor === 2 && formatted.value[2] === ":") cursor = 3;
    input.setSelectionRange(cursor, cursor);
    rememberScheduleTimeDraft(form);
  });
  input.addEventListener("blur", () => {
    // Complete single-digit hours may be padded, but partial edits stay intact.
    if (!/^\d{1,2}:\d{2}$/.test(input.value)) return;
    const normalized = normalizeManualTime(input.value);
    if (normalized && normalized !== input.value) {
      input.value = normalized;
      rememberScheduleTimeDraft(form);
    }
  });
}

function centerActiveScheduleDay() {
  requestAnimationFrame(() => {
    const tabs = document.getElementById("dayTabs");
    const active = tabs.querySelector(".day-tab.active");
    if (!active || !tabs.clientWidth) return;
    const tabBounds = tabs.getBoundingClientRect();
    const activeBounds = active.getBoundingClientRect();
    tabs.scrollLeft += activeBounds.left - tabBounds.left - (tabs.clientWidth - activeBounds.width) / 2;
  });
}

function scheduleTimeMarkup(slot) {
  return `<span class="schedule-time-start">${escapeHtml(slot.start)}</span><span class="schedule-time-dash">–</span><span class="schedule-time-end">${escapeHtml(slot.end)}</span>`;
}

function renderSchedule() {
  ensureWeek(state, currentWeekStart);
  const isCurrentWeek = currentWeekStart === startOfWeek(todayISO());
  const weekEnd = addDays(currentWeekStart, 6);
  const shortWeekStart = currentWeekStart.slice(5).replace("-", ".");
  const shortWeekEnd = weekEnd.slice(5).replace("-", ".");
  document.getElementById("weekNavLabel").textContent = `${isCurrentWeek ? "本周 · " : ""}${shortWeekStart}—${shortWeekEnd}`;
  const banner = document.getElementById("nowBanner");
  banner.hidden = !isCurrentWeek;
  if (isCurrentWeek) refreshBanner();
  const tabs = document.getElementById("dayTabs");
  tabs.innerHTML = editableDays.map((day) => {
    const date = addDays(currentWeekStart, editableDays.indexOf(day));
    const isToday = date === todayISO();
    const label = `${date} ${weekNames[day]}${isToday ? " 今天" : ""}`;
    return `<button class="day-tab ${day === activeScheduleDay ? "active" : ""}" type="button" data-day="${day}" data-today="${isToday}" aria-pressed="${day === activeScheduleDay}" ${isToday ? 'aria-current="date"' : ""} aria-label="${label}" title="${label}"><span class="day-tab-week">${isToday ? "今天" : weekNames[day]}</span><span class="day-tab-date">${date.slice(8)}</span></button>`;
  }).join("");
  tabs.querySelectorAll("[data-day]").forEach((button) => {
    button.addEventListener("click", () => {
      activeScheduleDay = Number(button.dataset.day);
      renderSchedule();
      renderHome();
    });
  });
  centerActiveScheduleDay();
  const slots = normalizeDaySchedule(getWeek(state, currentWeekStart), activeScheduleDay);
  const groups = ["上午", "下午", "晚上"].map((part) => ({ part, slots: slots.filter((slot) => slot.part === part) })).filter((group) => group.slots.length);
  const list = document.getElementById("scheduleEditor");
  list.innerHTML = `
    <div class="schedule-groups" aria-label="课程表编辑区">
      ${groups.map((group) => `<section class="schedule-day-group" data-schedule-part="${group.part}" aria-label="${group.part}课程">
        <div class="schedule-group-heading"><span class="schedule-group-mark" aria-hidden="true"></span><h3>${group.part}</h3><span>${group.slots.length} 个时段</span></div>
        <div class="schedule-quick-list">
      ${group.slots.map((slot) => `
        <article class="schedule-quick-card ${slot.done ? "done" : ""}" data-schedule-card="${slot.id}">
          <div class="schedule-quick-head">
            <div>
              <div class="schedule-slot-time" data-slot-time="${slot.id}">${scheduleTimeMarkup(slot)}</div>
              <div class="schedule-slot-label">${slot.name}</div>
            </div>
            ${slot.custom ? `<button class="delete-link" type="button" data-remove-evening="${slot.id}" aria-label="删除${slot.part}${slot.name}时段"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="m9 7 1-3h4l1 3"></path><path d="m6 7 1 14h10l1-14"></path></svg><span>删除</span></button>` : ""}
          </div>
          <div class="schedule-entry-row">
            <input class="schedule-title-input" type="text" value="${escapeAttribute(slot.title)}" placeholder="课名" data-slot-field="${slot.id}" data-field="title" enterkeyhint="next" aria-label="${slot.part}${slot.name}课名">
            <button class="secondary-button schedule-done-button" type="button" data-toggle-slot="${slot.id}" ${slot.title.trim() ? "" : "disabled"}>${slot.done ? "取消" : "完成"}</button>
          </div>
          <details class="schedule-time-editor" data-time-editor="${currentWeekStart}:${slot.id}" ${openScheduleTimeEditors.has(`${currentWeekStart}:${slot.id}`) || scheduleTimeDrafts.has(`${currentWeekStart}:${slot.id}`) ? "open" : ""}>
          <summary>修改时间<span class="time-editor-hint">自动补冒号</span></summary>
          <form class="schedule-time-form" data-slot-time-form="${slot.id}" aria-label="${slot.part}${slot.name}时间段">
            <div class="schedule-time-fields schedule-time-fields-direct">
              <label><span>开始</span><input class="schedule-time-input" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="done" value="${escapeAttribute(scheduleTimeDrafts.get(`${currentWeekStart}:${slot.id}`)?.start ?? slot.start)}" placeholder="08:30" data-slot-time-input="${slot.id}" data-field="start" aria-label="${slot.part}${slot.name}开始时间" aria-describedby="time-hint-${slot.id}"></label>
              <span class="schedule-time-sep">—</span>
              <label><span>结束</span><input class="schedule-time-input" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="done" value="${escapeAttribute(scheduleTimeDrafts.get(`${currentWeekStart}:${slot.id}`)?.end ?? slot.end)}" placeholder="09:30" data-slot-time-input="${slot.id}" data-field="end" aria-label="${slot.part}${slot.name}结束时间" aria-describedby="time-hint-${slot.id}"></label>
            </div>
            <div class="schedule-time-footer"><span class="form-note" id="time-hint-${slot.id}">任选先填 · 输入 0830 即 08:30</span><button class="primary-button schedule-time-save" type="submit" ${scheduleTimeDrafts.has(`${currentWeekStart}:${slot.id}`) ? "" : "disabled"}>保存时间</button></div>
            <p class="schedule-time-feedback" role="status" hidden></p>
          </form>
          </details>
        </article>
      `).join("")}</div></section>`).join("")}
      <button class="secondary-button table-add-button" type="button" data-add-evening><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>添加时段</button>
    </div>
  `;
  list.querySelectorAll("[data-slot-field]").forEach((input) => {
    input.addEventListener("change", updateSlotField);
    input.addEventListener("input", updateSlotField);
  });
  list.querySelectorAll("[data-time-editor]").forEach((editor) => {
    editor.addEventListener("toggle", () => {
      if (!editor.isConnected) return;
      if (editor.open) openScheduleTimeEditors.add(editor.dataset.timeEditor);
      else openScheduleTimeEditors.delete(editor.dataset.timeEditor);
    });
  });
  list.querySelectorAll("[data-slot-time-form]").forEach((form) => {
    form.addEventListener("submit", commitSlotTime);
    form.querySelectorAll(".schedule-time-input").forEach((input) => bindScheduleTimeInput(input, form));
  });
  const titleInputs = [...list.querySelectorAll('[data-field="title"]')];
  titleInputs.forEach((input, index) => {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      const nextInput = titleInputs[index + 1];
      if (nextInput) nextInput.focus();
      else input.blur();
    });
  });
  list.querySelectorAll("[data-toggle-slot]").forEach((button) => {
    button.addEventListener("click", () => toggleSlotDone(button.dataset.toggleSlot));
  });
  list.querySelectorAll("[data-remove-evening]").forEach((button) => {
    button.addEventListener("click", () => {
      removeScheduleSlot(state, currentWeekStart, button.dataset.removeEvening);
      scheduleTimeDrafts.delete(`${currentWeekStart}:${button.dataset.removeEvening}`);
      openScheduleTimeEditors.delete(`${currentWeekStart}:${button.dataset.removeEvening}`);
      saveState(state);
      showToast("已删除该时段。");
      renderSchedule();
      renderHome();
    });
  });
  list.querySelectorAll("[data-add-evening]").forEach((button) => {
    button.addEventListener("click", () => {
      const added = addScheduleSlot(state, currentWeekStart, activeScheduleDay);
      openScheduleTimeEditors.add(`${currentWeekStart}:${added.id}`);
      saveState(state);
      showToast("已添加时段，可填写课程与时间。");
      renderSchedule();
      list.querySelector(`[data-schedule-card="${added.id}"] .schedule-title-input`)?.focus();
    });
  });
  renderWeekReportPanel();
}

function updateSlotField(event) {
  const week = getWeek(state, currentWeekStart);
  const slot = week.slots.find((s) => s.id === event.target.dataset.slotField);
  if (!slot) return;
  slot.title = event.target.value;
  week.report = "";
  if (!slot.title.trim()) slot.done = false;
  const card = document.querySelector(`[data-schedule-card="${slot.id}"]`);
  const toggleButton = document.querySelector(`[data-toggle-slot="${slot.id}"]`);
  const timeText = document.querySelector(`[data-slot-time="${slot.id}"]`);
  if (card) card.classList.toggle("done", slot.done);
  if (toggleButton) {
    toggleButton.disabled = !slot.title.trim();
    toggleButton.textContent = slot.done ? "取消" : "完成";
  }
  if (timeText) timeText.innerHTML = scheduleTimeMarkup(slot);
  saveState(state);
  renderHome();
  renderWeekReportPanel();
}

function commitSlotTime(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const week = getWeek(state, currentWeekStart);
  const slot = week.slots.find((item) => item.id === form.dataset.slotTimeForm);
  if (!slot) return;
  const startInput = form.querySelector('[data-field="start"]');
  const endInput = form.querySelector('[data-field="end"]');
  const range = validateSlotTimeRange(startInput.value, endInput.value);
  const feedback = form.querySelector(".schedule-time-feedback");
  if (range.error) {
    feedback.textContent = range.error;
    feedback.hidden = false;
    startInput.setAttribute("aria-invalid", "true");
    endInput.setAttribute("aria-invalid", "true");
    showToast(range.error);
    return;
  }
  slot.start = range.start;
  slot.end = range.end;
  normalizeDaySchedule(week, slot.day);
  startInput.value = range.start;
  endInput.value = range.end;
  startInput.removeAttribute("aria-invalid");
  endInput.removeAttribute("aria-invalid");
  scheduleTimeDrafts.delete(`${currentWeekStart}:${slot.id}`);
  form.querySelector("button").disabled = true;
  feedback.hidden = true;
  week.report = "";
  saveState(state);
  renderSchedule();
  const savedCard = document.querySelector(`[data-schedule-card="${slot.id}"]`);
  savedCard?.querySelector("summary")?.focus({ preventScroll: true });
  savedCard?.scrollIntoView({ block: "nearest", behavior: "auto" });
  renderHome();
  renderWeekReportPanel();
  refreshBanner();
  showToast(`已保存 ${slot.start}–${slot.end}，排入${slot.part}。`);
}

function toggleSlotDone(id, weekStart) {
  const week = getWeek(state, weekStart || currentWeekStart);
  const slot = week.slots.find((s) => s.id === id);
  if (!slot) return;
  if (!slot.title.trim()) {
    showToast("请先填写课名。");
    return;
  }
  slot.done = !slot.done;
  week.report = "";
  saveState(state);
  if (slot.done) {
    const daySlots = week.slots
      .filter((s) => s.day === slot.day && s.title.trim())
      .sort(compareScheduleSlots);
    const next = daySlots.find((s) => s.start > slot.start);
    if (next) {
      const gap = timeToMinutes(next.start) - timeToMinutes(slot.end);
      showToast(`${slotTitleText(slot)}已打卡。${gap > 0 ? `课间约 ${gap} 分钟` : "课间较紧"}，下一节${slotTitleText(next)}${next.start} 开始。`);
    } else {
      showToast(`${slotTitleText(slot)}已打卡，今天的课都完成了。`);
    }
  } else {
    showToast(`已取消${slotTitleText(slot)}的打卡。`);
  }
  renderSchedule();
  renderHome();
}

/* ---------- 课表实时状态与课间提醒 ---------- */
function todayNamedSlots() {
  const week = getWeek(state, startOfWeek(todayISO()));
  const day = new Date().getDay();
  return week.slots
    .filter((s) => s.day === day && s.title.trim())
    .sort(compareScheduleSlots);
}

function statusFor(now) {
  const slots = todayNamedSlots();
  if (!slots.length) {
    return { key: "none", text: "今天还没有要打卡的课。先在课表里把课名填上。", toast: null };
  }
  for (const s of slots) {
    if (now >= s.start && now < s.end) {
      return {
        key: `in:${s.id}`,
        text: `正在进行：${slotTitleText(s)}（${s.start}–${s.end}）。结束后点「完成」打卡。`,
        toast: `${slotTitleText(s)}开始了（${s.start}–${s.end}）。`
      };
    }
  }
  let prev = null;
  let next = null;
  for (const s of slots) if (s.end <= now) prev = s;
  for (const s of slots) {
    if (s.start > now) { next = s; break; }
  }
  if (prev && next) {
    const gap = timeToMinutes(next.start) - timeToMinutes(prev.end);
    return {
      key: `gap:${prev.id}`,
      text: `课间休息。上一节${slotTitleText(prev)}已结束，下一节${slotTitleText(next)}将于 ${next.start} 开始。`,
      toast: `${slotTitleText(prev)}已结束。${gap > 0 ? `课间约 ${gap} 分钟` : "课间较紧"}，下一节${slotTitleText(next)}${next.start} 开始。`
    };
  }
  if (prev && !next) {
    return { key: "after", text: "今天的课都结束了。", toast: "今天的课都结束了。" };
  }
  return { key: "before", text: `今天第一节课${slotTitleText(slots[0])}将于 ${slots[0].start} 开始。`, toast: null };
}

function refreshBanner() {
  const banner = document.getElementById("nowBanner");
  if (!banner || banner.hidden) return;
  banner.textContent = statusFor(nowHHMM()).text;
}

function checkScheduleTransitions() {
  const status = statusFor(nowHHMM());
  if (status.key !== lastBannerKey) {
    if (lastBannerKey !== null && status.toast && status.key !== "none") {
      showToast(status.toast);
    }
    lastBannerKey = status.key;
  }
}

/* ---------- 周报自动生成 ---------- */
function autoGeneratePastWeekReports() {
  const today = todayISO();
  let changed = false;
  Object.keys(state.scheduleWeeks).forEach((ws) => {
    const week = state.scheduleWeeks[ws];
    if (addDays(ws, 6) < today && !week.report) {
      week.report = buildScheduleReport(state, ws);
      changed = true;
    }
  });
  if (changed) saveState(state);
}

/* ---------- 报告 ---------- */
function syncReportControls() {
  const kind = document.getElementById("reportKind").value;
  const fixedToWeek = kind === "schedule" || kind === "weekly";
  document.getElementById("reportHabitField").hidden = kind !== "stillness";
  document.getElementById("reportRange").disabled = fixedToWeek;
  if (fixedToWeek) document.getElementById("reportRange").value = "week";
  const range = document.getElementById("reportRange").value;
  document.querySelectorAll("[data-report-range]").forEach((button) => {
    const active = button.dataset.reportRange === range;
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("active", active);
    button.disabled = fixedToWeek && button.dataset.reportRange !== "week";
  });
  const labels = {
    day: ["前一天", "后一天", "回到今天"],
    week: ["上一周", "下一周", "回到本周"],
    month: ["上一月", "下一月", "回到本月"]
  }[range];
  ["periodPrevButton", "periodNextButton"].forEach((id, index) => {
    document.getElementById(id).setAttribute("aria-label", labels[index]);
    document.getElementById(id).title = labels[index];
  });
  document.getElementById("periodTodayButton").textContent = labels[2];
}

function shiftReportPeriod(dir) {
  const kind = document.getElementById("reportKind").value;
  const fixedToWeek = kind === "schedule" || kind === "weekly";
  const range = fixedToWeek ? "week" : document.getElementById("reportRange").value;
  const baseDate = document.getElementById("reportDate").value || todayISO();
  document.getElementById("reportDate").value = shiftBaseDate(range, baseDate, dir);
  renderReport();
}

function renderReport() {
  syncReportControls();
  const kind = document.getElementById("reportKind").value;
  const range = document.getElementById("reportRange").value;
  const baseDate = document.getElementById("reportDate").value || todayISO();
  const period = kind === "schedule" || kind === "weekly"
    ? { label: "周", start: startOfWeek(baseDate), end: addDays(startOfWeek(baseDate), 6) }
    : periodFor(range, baseDate);
  let text = "";
  if (kind === "stillness") text = buildStillnessReport(state, { habit: document.getElementById("reportHabit").value, range, baseDate });
  if (kind === "running") text = buildRunningReport(state, { range, baseDate });
  if (kind === "schedule") text = buildScheduleReport(state, startOfWeek(baseDate));
  if (kind === "weekly") text = buildWeeklySummary(state, baseDate);
  document.getElementById("reportOutput").textContent = text;
  renderReportDocument(text);
  document.getElementById("periodLabel").textContent = periodText(period);
  document.getElementById("reportSheetTitle").textContent = kind === "weekly" ? "每周总结" : `${{ stillness: "静修", running: "跑步", schedule: "课表" }[kind]}${{day:"日",week:"周",month:"月"}[range]}报告`;
  renderReportOverview(kind, period);
  renderManagerList();
}

function renderReportDocument(text) {
  // The first block repeats the sheet title and selected date range.
  const blocks = text.trim().split(/\n\s*\n/).slice(1);
  document.getElementById("reportDocument").innerHTML = blocks.map((block) => {
    if (block.startsWith("评价与建议：")) {
      return `<section class="report-note"><h4>评价与建议</h4><p>${escapeHtml(block.slice(6))}</p></section>`;
    }
    const lines = block.split("\n");
    const heading = lines.length > 1 && /[：:]$/.test(lines[0]) ? lines.shift().replace(/[：:]$/, "") : "";
    const body = lines.every((line) => line.startsWith("- "))
      ? `<ul>${lines.map((line) => `<li>${escapeHtml(line.slice(2))}</li>`).join("")}</ul>`
      : `<p>${lines.map(escapeHtml).join("<br>")}</p>`;
    return `<section>${heading ? `<h4>${escapeHtml(heading)}</h4>` : ""}${body}</section>`;
  }).join("");
}

function renderReportOverview(kind, period) {
  const habit = kind === "stillness" ? document.getElementById("reportHabit").value : "all";
  const sessions = stillnessSessionsIn(state, habit, period.start, period.end);
  const timed = sessions.filter((session) => session.type !== "baduanjin");
  const seconds = sum(timed.map((session) => session.durationSeconds));
  const runs = runningRecordsIn(state, period.start, period.end);
  const minutes = (value) => String(Math.round(value / 6) / 10);
  let stats;
  if (kind === "stillness") {
    stats = habit === "baduanjin"
      ? [["count", "完成次数", sum(sessions.map(countForSession)), "次"], ["days", "练习天数", new Set(sessions.map((session) => session.date)).size, "天"], ["records", "练习记录", sessions.length, "条"]]
      : [["minutes", "静修时长", minutes(seconds), "分钟"], ["records", "练习记录", sessions.length, "条"], ["days", "练习天数", new Set(sessions.map((session) => session.date)).size, "天"]];
  } else if (kind === "running") {
    stats = [["distance", "累计里程", sum(runs.map((run) => run.distanceKm)).toFixed(2), "公里"], ["minutes", "跑步用时", minutes(sum(runs.map((run) => run.durationSeconds))), "分钟"], ["records", "跑步次数", runs.length, "次"]];
  } else {
    const named = getWeek(state, period.start).slots.filter((slot) => slot.title.trim());
    const done = named.filter((slot) => slot.done).length;
    stats = kind === "schedule"
      ? [["planned", "已排课程", named.length, "节"], ["completed", "完成课程", done, "节"], ["rate", "完成比例", named.length ? Math.round(done / named.length * 100) : 0, "%"]]
      : [["minutes", "静修时长", minutes(seconds), "分钟"], ["distance", "跑步里程", sum(runs.map((run) => run.distanceKm)).toFixed(2), "公里"], ["completed", "完成课程", done, "节"]];
  }
  document.getElementById("reportOverview").innerHTML = stats.map(([key, label, value, unit]) => `<div class="report-stat" data-stat="${key}"><span>${label}</span><strong><span data-stat-value>${value}</span><small>${unit}</small></strong></div>`).join("");
}

function renderManagerList() {
  const kind = document.getElementById("reportKind").value;
  const range = document.getElementById("reportRange").value;
  const baseDate = document.getElementById("reportDate").value || todayISO();
  const container = document.getElementById("managerList");
  const items = [];
  if (kind === "stillness") {
    const period = periodFor(range, baseDate);
    const sessions = stillnessSessionsIn(state, document.getElementById("reportHabit").value, period.start, period.end);
    sessions.forEach((s) => {
      items.push(`<div class="manager-item"><span>${s.date} ${hhmmFromIso(s.startedAt || s.endedAt)} · ${habitTitle(s.type)} · ${sessionMeasure(s)}</span><button class="delete-link" type="button" data-del-stillness="${escapeAttribute(s.id)}" aria-label="删除 ${s.date} ${habitTitle(s.type)} ${sessionMeasure(s)}记录"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="m9 7 1-3h4l1 3"></path><path d="m6 7 1 14h10l1-14"></path></svg><span>删除</span></button></div>`);
    });
  } else if (kind === "running") {
    const period = periodFor(range, baseDate);
    const runs = runningRecordsIn(state, period.start, period.end);
    runs.forEach((r) => {
      items.push(`<div class="manager-item"><span>${r.date} · ${r.distanceKm.toFixed(2)} 公里 · ${formatRunDuration(r.durationSeconds)}</span><button class="delete-link" type="button" data-del-run="${escapeAttribute(r.id)}"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="m9 7 1-3h4l1 3"></path><path d="m6 7 1 14h10l1-14"></path></svg><span>删除</span></button></div>`);
    });
  } else if (kind === "schedule") {
    container.innerHTML = `<div class="manager-item"><span>课表的修改在「课表」页完成。</span></div>`;
    return;
  } else {
    container.innerHTML = `<div class="manager-item"><span>每周总结由各项记录自动汇总。</span></div>`;
    return;
  }
  container.innerHTML = items.length ? items.join("") : `<div class="manager-item"><span>该周期内没有可删除的记录。</span></div>`;
}

function copyReport() {
  const text = document.getElementById("reportOutput").textContent;
  const result = navigator.clipboard && navigator.clipboard.writeText(text);
  if (result && result.then) {
    result.then(
      () => showToast("已复制报告。"),
      () => showToast("复制失败，可手动选中。")
    );
    return;
  }
  showToast("复制失败，可手动选中。");
}

function exportReportText() {
  const text = document.getElementById("reportOutput").textContent;
  const kind = document.getElementById("reportKind").value;
  const date = document.getElementById("reportDate").value || todayISO();
  const names = { stillness: "静修报告", running: "跑步报告", schedule: "课表报告", weekly: "每周总结" };
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${names[kind] || "报告"}-${date}.txt`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("文本已导出。");
}

/* ---------- 设置 ---------- */
function hydrateSettings() {
  document.getElementById("caloriesPerKm").value = state.settings.caloriesPerKm;
  updateBackupSummary();
}

function updateBackupSummary(options = {}) {
  const title = document.getElementById("backupSummaryTitle");
  const meta = document.getElementById("backupSummaryMeta");
  const badge = document.getElementById("backupState");
  if (!title || !meta || !badge) return;

  const stillnessCount = state.stillnessSessions.length;
  const runCount = state.runningSessions.length;
  const courseCount = Object.values(state.scheduleWeeks).reduce((sum, week) => {
    const slots = week && Array.isArray(week.slots) ? week.slots : [];
    return sum + slots.filter((slot) => slot.title && slot.title.trim()).length;
  }, 0);

  if (options.restored) {
    title.textContent = `已恢复「${options.fileName || "备份文件"}」`;
    badge.textContent = "恢复成功";
    badge.classList.add("success");
  } else {
    title.textContent = "数据保存在当前浏览器";
    badge.textContent = "本机存储";
    badge.classList.remove("success");
  }
  meta.textContent = `静修 ${stillnessCount} 条 · 跑步 ${runCount} 条 · 已填写课程 ${courseCount} 项`;
}

function saveSettings(event) {
  event.preventDefault();
  state.settings.caloriesPerKm = Number(document.getElementById("caloriesPerKm").value) || 60;
  saveState(state);
  showToast("设置已保存。");
}

async function refreshApplication() {
  const button = document.getElementById("refreshAppButton");
  if (button.disabled) return;
  const label = button.querySelector("span");
  const originalLabel = label.textContent;
  const feedback = document.getElementById("refreshFeedback");
  const showFeedback = (message, failed = false) => {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.hidden = false;
    feedback.classList.toggle("error", failed);
  };
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  label.textContent = "正在获取新版…";
  showFeedback("正在检查连接并准备最新界面…");
  if (typeof persistRunDraft === "function") persistRunDraft();
  saveState(state);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const appBase = new URL("./", location.href);
  const freshUrl = new URL("index.html", appBase);
  const nonce = Date.now().toString();
  const responses = new Map();
  let stagingCache = null;
  let cacheReady = false;
  const fetchFresh = async (url) => {
    const probe = new URL(url);
    probe.searchParams.set("__workbench_refresh", nonce);
    const response = await fetch(probe, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // 读完响应体后才算资源准备完成，失败时仍保留旧缓存。
    const bytes = await response.arrayBuffer();
    const stored = new Response(bytes, { status: response.status, headers: response.headers });
    responses.set(url, stored);
    return stored.clone();
  };
  try {
    const html = await (await fetchFresh(freshUrl.href)).text();
    const nextPage = new DOMParser().parseFromString(html, "text/html");
    if (!nextPage.querySelector('#view-home') || !nextPage.querySelector('script[src*="app-ui.js"]')) {
      throw new Error("不是有效的应用页面");
    }
    const dependencyUrls = new Set([...nextPage.querySelectorAll('script[src], link[rel="stylesheet"], link[rel="manifest"], link[rel="icon"], link[rel="apple-touch-icon"], meta[name="workbench-asset"], img[src]')]
      .map((element) => new URL(element.getAttribute("src") || element.getAttribute("href") || element.getAttribute("content"), freshUrl))
      .filter((url) => url.origin === location.origin && url.pathname.startsWith(appBase.pathname))
      .map((url) => url.href));
    await Promise.all([...dependencyUrls].map(async (url) => {
      const response = await fetchFresh(url);
      if (!new URL(url).pathname.endsWith(".css")) return;
      const css = await response.text();
      const assetUrls = [...css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)]
        .map((match) => new URL(match[1], url))
        .filter((asset) => asset.origin === location.origin && asset.pathname.startsWith(appBase.pathname));
      await Promise.all([...new Set(assetUrls.map((asset) => asset.href))].map((asset) => fetchFresh(asset)));
    }));
    clearTimeout(timeout);
    if ("caches" in window) {
      stagingCache = `xiaoyang-workbench-refreshed-${nonce}`;
      const prepared = await caches.open(stagingCache);
      await Promise.all([...responses].map(([url, response]) => prepared.put(url, response.clone())));
      cacheReady = true;
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((key) => key.startsWith("xiaoyang-workbench-") && key !== stagingCache)
        .map((key) => caches.delete(key).catch(() => false)));
    }
    // 新缓存已就绪，再请求后台更新；不让 SW 激活打断当前录入。
    registerServiceWorker();
    showFeedback("新版已准备好，正在重新载入。记录和计时已保留。");
    const url = new URL(location.href);
    url.searchParams.delete("v");
    url.searchParams.set("refresh", nonce);
    location.replace(url.toString());
  } catch {
    controller.abort();
    if (stagingCache && !cacheReady && "caches" in window) await caches.delete(stagingCache).catch(() => {});
    showFeedback("暂时无法获取完整新版，请联网后重试。当前界面和本地记录已保留。", true);
    button.disabled = false;
    label.textContent = originalLabel;
  } finally {
    clearTimeout(timeout);
    button.removeAttribute("aria-busy");
  }
}

/* ---------- 备份 ---------- */
function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `小羊工作台备份-${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function restoreBackup(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const buttonLabel = document.getElementById("restoreButtonLabel");
  const feedback = document.getElementById("restoreFeedback");
  buttonLabel.textContent = "正在读取…";
  feedback.hidden = true;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const restored = normalizeBackup(JSON.parse(reader.result));
      ensureWeek(restored, currentWeekStart);
      Object.keys(state).forEach((key) => delete state[key]);
      Object.assign(state, restored);
      scheduleTimeDrafts.clear();
      openScheduleTimeEditors.clear();
      Object.assign(runTimer, { running: false, startTs: 0, accSec: 0 });
      ["runDistance", "runMinutes", "runSeconds", "runNote"].forEach((id) => { document.getElementById(id).value = ""; });
      restoreRunDraft();
      saveState(state);
      renderAll();
      updateBackupSummary({ restored: true, fileName: file.name });
      feedback.textContent = "恢复完成，页面数据已经重新载入。首页只显示今天的数据，历史记录可在“报告”中查看。";
      feedback.className = "restore-feedback success";
      feedback.hidden = false;
      showToast("备份已恢复，数据已重新载入。");
    } catch {
      feedback.textContent = "无法恢复：请选择由“小羊工作台”导出的 JSON 备份文件。";
      feedback.className = "restore-feedback error";
      feedback.hidden = false;
      showToast("备份文件无法读取。");
    } finally {
      buttonLabel.textContent = "恢复备份";
    }
  };
  reader.onerror = () => {
    buttonLabel.textContent = "恢复备份";
    feedback.textContent = "文件读取失败，请重新选择。";
    feedback.className = "restore-feedback error";
    feedback.hidden = false;
    showToast("文件读取失败。");
  };
  reader.readAsText(file);
  event.target.value = "";
}

/* ---------- 通用 ---------- */
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => {});
  }
}
