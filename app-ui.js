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
  renderAll();
  setViewFromHash();
  startGlobalLoop();
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
  habitDefs.forEach((habit) => {
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
    button.classList.toggle("active", button.dataset.view === normalized);
  });
  if (updateHash) history.replaceState(null, "", `#${normalized}`);
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  if (normalized === "reports") renderReport();
  if (normalized === "schedule") refreshBanner();
}

/* ---------- 表单与静态控件绑定 ---------- */
function bindForms() {
  document.getElementById("runForm").addEventListener("submit", saveRun);
  document.getElementById("runTimerButton").addEventListener("click", toggleRunTimer);
  ["runDistance", "runMinutes", "runSeconds"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateRunPreview);
  });
  document.getElementById("settingsForm").addEventListener("submit", saveSettings);
  document.getElementById("applyBreakButton").addEventListener("click", applyBreakNow);
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
    if (ok) showToast("已复制上周的课名和时间。");
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
  document.getElementById("runDate").value = today;
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
    .filter((item) => item.date === today)
    .reduce((acc, item) => acc + item.durationSeconds, 0);
  document.getElementById("homeStillnessMeta").textContent = `今天 ${Math.round(stillnessSeconds / 60)} 分钟`;
  const runsToday = state.runningSessions.filter((item) => item.date === today);
  const runDistance = runsToday.reduce((acc, item) => acc + item.distanceKm, 0);
  document.getElementById("homeRunMeta").textContent = `今天 ${runDistance.toFixed(2)} 公里 · 累计 ${state.runningSessions.length} 次`;
  renderHomeBanner();
  renderHomeHabits();
  const weekStart = startOfWeek(today);
  const day = new Date().getDay();
  const todaySlots = getWeek(state, weekStart).slots
    .filter((slot) => slot.day === day && slot.title.trim())
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
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
    : `<div class="list-item"><div class="item-title">今天没有要打卡的课程</div></div>`;
  list.querySelectorAll("[data-home-toggle]").forEach((button) => {
    button.addEventListener("click", () => toggleSlotDone(button.dataset.homeToggle, weekStart));
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
        <div class="home-habit-head">
          <h4>${habit.title}</h4>
          <span class="home-habit-clock" data-home-clock="${habit.id}">${elapsedSec ? formatClock(elapsedSec) : ""}</span>
        </div>
        <div class="home-habit-meta"><span>今日</span><strong>${formatDuration(todayTotal)}</strong></div>
        <button class="secondary-button home-habit-button" type="button" data-home-start="${habit.id}">${buttonIcon}<span>${label}</span></button>
      </article>`;
  }).join("");
  grid.querySelectorAll("[data-home-start]").forEach((button) => {
    button.addEventListener("click", () => homeTimerAction(button.dataset.homeStart));
  });
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

/* ---------- 四习惯计时 ---------- */
function renderHabitTimers() {
  const grid = document.getElementById("habitTimerGrid");
  grid.innerHTML = habitDefs.map((habit) => {
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
        <div class="timer-row">
          <div>
            <h3>${habit.title}</h3>
            <div class="timer-meta">
              <span><small>今日</small><strong>${formatDuration(todayTotal)}</strong></span>
              <span><small>最近</small><strong>${recent ? `${recent.date.slice(5)} · ${formatDuration(recent.durationSeconds)}` : "暂无记录"}</strong></span>
            </div>
          </div>
          <div class="timer-clock" data-clock="${habit.id}">${formatClock(elapsedSec)}</div>
        </div>
        <div class="timer-actions">
          <button class="${active ? "timer-end-button" : "primary-button"} timer-toggle-button" type="button" data-timer-action="${habit.id}">${buttonIcon}<span>${active ? "结束计时" : "开始计时"}</span></button>
        </div>
      </article>`;
  }).join("");
  grid.querySelectorAll("[data-timer-action]").forEach((button) => {
    button.addEventListener("click", () => homeTimerAction(button.dataset.timerAction));
  });
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
  saveState(state);
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
}

function renderRunTimerButton() {
  const button = document.getElementById("runTimerButton");
  const icon = runTimer.running
    ? `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>`
    : `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5Z"></path></svg>`;
  button.innerHTML = `${icon}<span>${runTimer.running ? "停止计时" : "开始计时"}</span>`;
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
  tabs.innerHTML = editableDays.map((day) => `<button class="day-tab ${day === activeScheduleDay ? "active" : ""}" type="button" data-day="${day}">${weekNames[day]} ${addDays(currentWeekStart, editableDays.indexOf(day)).slice(5)}</button>`).join("");
  tabs.querySelectorAll("[data-day]").forEach((button) => {
    button.addEventListener("click", () => {
      activeScheduleDay = Number(button.dataset.day);
      renderSchedule();
      renderHome();
    });
  });
  const activeDayButton = tabs.querySelector(".day-tab.active");
  if (activeDayButton) {
    requestAnimationFrame(() => {
      tabs.scrollLeft = activeDayButton.offsetLeft - (tabs.clientWidth - activeDayButton.offsetWidth) / 2;
    });
  }
  const slots = getWeek(state, currentWeekStart).slots
    .filter((slot) => slot.day === activeScheduleDay)
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const list = document.getElementById("scheduleEditor");
  list.innerHTML = `
    <div class="schedule-quick-list" aria-label="课程表编辑区">
      ${slots.map((slot) => `
        <article class="schedule-quick-card ${slot.done ? "done" : ""}" data-schedule-card="${slot.id}">
          <div class="schedule-quick-head">
            <div>
              <div class="schedule-slot-label">${slot.part} · ${slot.name}</div>
              <div class="schedule-slot-time" data-slot-time="${slot.id}">${slot.start}–${slot.end}</div>
            </div>
            ${slot.part === "晚上" ? `<button class="delete-link" type="button" data-remove-evening="${slot.id}"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="m9 7 1-3h4l1 3"></path><path d="m6 7 1 14h10l1-14"></path></svg><span>删除</span></button>` : ""}
          </div>
          <div class="schedule-entry-row">
            <input class="schedule-title-input" type="text" value="${escapeAttribute(slot.title)}" placeholder="课名" data-slot-field="${slot.id}" data-field="title" enterkeyhint="next" aria-label="${slot.part}${slot.name}课名">
            <button class="secondary-button schedule-done-button" type="button" data-toggle-slot="${slot.id}" ${slot.title.trim() ? "" : "disabled"}>${slot.done ? "取消" : "完成"}</button>
          </div>
          <details class="schedule-time-editor">
            <summary>调整时间</summary>
            <div class="schedule-time-fields">
              <input type="time" value="${slot.start}" data-slot-field="${slot.id}" data-field="start" aria-label="开始时间">
              <span class="schedule-time-sep">-</span>
              <input type="time" value="${slot.end}" data-slot-field="${slot.id}" data-field="end" aria-label="结束时间">
            </div>
          </details>
        </article>
      `).join("")}
      <button class="secondary-button table-add-button" type="button" data-add-evening>添加晚间时段</button>
    </div>
  `;
  list.querySelectorAll("[data-slot-field]").forEach((input) => {
    input.addEventListener("change", updateSlotField);
    input.addEventListener("input", updateSlotField);
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
      removeEveningSlot(state, currentWeekStart, button.dataset.removeEvening);
      saveState(state);
      showToast("已删除该晚间条目。");
      renderSchedule();
    });
  });
  list.querySelectorAll("[data-add-evening]").forEach((button) => {
    button.addEventListener("click", () => {
      addEveningSlot(state, currentWeekStart, activeScheduleDay);
      saveState(state);
      showToast("已添加一个晚间时段。");
      renderSchedule();
    });
  });
  renderWeekReportPanel();
}

function updateSlotField(event) {
  const week = getWeek(state, currentWeekStart);
  const slot = week.slots.find((s) => s.id === event.target.dataset.slotField);
  if (!slot) return;
  slot[event.target.dataset.field] = event.target.value;
  if (!slot.title.trim()) slot.done = false;
  const card = document.querySelector(`[data-schedule-card="${slot.id}"]`);
  const toggleButton = document.querySelector(`[data-toggle-slot="${slot.id}"]`);
  const timeText = document.querySelector(`[data-slot-time="${slot.id}"]`);
  if (card) card.classList.toggle("done", slot.done);
  if (toggleButton) {
    toggleButton.disabled = !slot.title.trim();
    toggleButton.textContent = slot.done ? "取消" : "完成";
  }
  if (timeText) timeText.textContent = `${slot.start}–${slot.end}`;
  saveState(state);
  renderHome();
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
  saveState(state);
  if (slot.done) {
    const daySlots = week.slots
      .filter((s) => s.day === slot.day && s.title.trim())
      .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
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
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
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
  document.getElementById("periodLabel").textContent = periodText(period);
  renderManagerList();
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
      items.push(`<div class="manager-item"><span>${s.date} ${hhmmFromIso(s.startedAt || s.endedAt)} · ${habitTitle(s.type)} · ${formatDuration(s.durationSeconds)}</span><button class="delete-link" type="button" data-del-stillness="${escapeAttribute(s.id)}"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="m9 7 1-3h4l1 3"></path><path d="m6 7 1 14h10l1-14"></path></svg><span>删除</span></button></div>`);
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
  document.getElementById("breakMinutes").value = state.settings.breakMinutes;
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
  state.settings.breakMinutes = Math.min(120, Math.max(5, Number(document.getElementById("breakMinutes").value) || 30));
  saveState(state);
  showToast("设置已保存。");
}

function applyBreakNow() {
  const minutes = Math.min(120, Math.max(5, Number(document.getElementById("breakMinutes").value) || 30));
  state.settings.breakMinutes = minutes;
  applyBreakToWeek(state, currentWeekStart);
  saveState(state);
  renderSchedule();
  showToast(`已按课间 ${minutes} 分钟调整当前周上午、下午第2节课的时间。`);
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
      const restored = JSON.parse(reader.result);
      if (!restored || typeof restored !== "object" || Array.isArray(restored)) {
        throw new Error("备份根节点不是对象");
      }
      Object.keys(state).forEach((key) => delete state[key]);
      Object.assign(state, normalizeState(restored));
      ensureWeek(state, currentWeekStart);
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
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then((registration) => {
      registration.update();
    }).catch(() => {});
  }
}
