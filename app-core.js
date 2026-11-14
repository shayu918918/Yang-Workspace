/* 小羊工作台 · 核心逻辑
 * 只放纯计算与状态管理，不碰 DOM。可在 Node 中直接 require 测试。
 */
"use strict";

const STORAGE_KEY = "xiaoyang-workbench-v1"; // 沿用旧键，数据无缝迁移

const habitDefs = [
  { id: "meditation", title: "冥想", tracking: "timer" },
  { id: "standing", title: "站桩", tracking: "timer" },
  { id: "reading", title: "读书", tracking: "timer" },
  { id: "walking", title: "散步", tracking: "timer" },
  { id: "focus", title: "专注学习", tracking: "timer" },
  { id: "baduanjin", title: "八段锦", tracking: "count" }
];

function defaultHabitTimers() {
  return Object.fromEntries(habitDefs.filter((habit) => habit.tracking === "timer").map((habit) => [habit.id, null]));
}

const weekNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
// 课程表按周一至周日排列
const editableDays = [1, 2, 3, 4, 5, 6, 0];

/* ---------- 存储（localStorage 不可用时降级为内存） ---------- */
const memoryStore = {};
function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryStore[key] || null;
  }
}
function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    memoryStore[key] = value;
  }
}

/* ---------- 状态 ---------- */
function defaultState() {
  return {
    stillnessSessions: [],
    runningSessions: [],
    runDraft: null,
    scheduleWeeks: {},
    habitTimers: defaultHabitTimers(),
    settings: {
      caloriesPerKm: 60,
      breakMinutes: 30
    }
  };
}

function normalizeStillnessSession(item) {
  const normalized = {
    id: item.id || uid("stillness"),
    type: item.type,
    date: item.date,
    startedAt: item.startedAt || item.endedAt,
    endedAt: item.endedAt || item.startedAt,
    durationSeconds: Number(item.durationSeconds) || 0
  };
  if (item.type === "baduanjin") {
    normalized.count = countForSession(item);
    normalized.durationSeconds = 0;
  }
  return normalized;
}

function normalizeRunRecord(item) {
  const distanceKm = Number(item.distanceKm) || 0;
  // 旧数据存的是 durationMinutes，统一迁移为 durationSeconds
  const durationSeconds = Number(item.durationSeconds) || (Number(item.durationMinutes) || 0) * 60;
  return {
    id: item.id || uid("run"),
    date: item.date,
    distanceKm,
    durationSeconds,
    paceSecondsPerKm: durationSeconds && distanceKm ? Math.round(durationSeconds / distanceKm) : 0,
    calories: Number(item.calories) || 0,
    note: item.note || "",
    createdAt: item.createdAt || item.date
  };
}

function normalizeState(saved) {
  const defaults = defaultState();
  const s = { ...defaults, ...(saved || {}) };
  s.settings = { ...defaults.settings, ...(s.settings || {}) };
  delete s.settings.readingTickEnabled;
  s.stillnessSessions = Array.isArray(s.stillnessSessions) ? s.stillnessSessions.map(normalizeStillnessSession) : [];
  s.runningSessions = Array.isArray(s.runningSessions) ? s.runningSessions.map(normalizeRunRecord) : [];
  s.scheduleWeeks = s.scheduleWeeks && typeof s.scheduleWeeks === "object" ? s.scheduleWeeks : {};
  s.scheduleWeeks = Object.fromEntries(Object.entries(s.scheduleWeeks).map(([key, week]) => {
    if (!week || typeof week !== "object" || !Array.isArray(week.slots)) return [key, week];
    const restored = { ...week, slots: week.slots.map((slot) => ({ ...slot })) };
    normalizeWeekSchedule(restored);
    return [key, restored];
  }));
  s.habitTimers = { ...defaultHabitTimers(), ...(s.habitTimers || {}) };
  delete s.habitTimers.baduanjin;
  s.runDraft = normalizeRunDraft(s.runDraft);
  return s;
}

function normalizeRunDraft(draft) {
  if (!draft || typeof draft !== "object") return null;
  const fields = {};
  ["runDate", "runDistance", "runMinutes", "runSeconds", "runNote"].forEach((id) => {
    fields[id] = typeof draft[id] === "string" ? draft[id] : "";
  });
  const timer = draft.timer || {};
  const started = Number(timer.startTs);
  return {
    ...fields,
    timer: {
      running: timer.running === true && Number.isFinite(started) && started > 0,
      startTs: Number.isFinite(started) && started > 0 ? started : 0,
      accSec: Math.max(0, Number(timer.accSec) || 0)
    }
  };
}

function normalizeBackup(saved) {
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
  if (!isObject(saved) || !Array.isArray(saved.stillnessSessions) || !Array.isArray(saved.runningSessions) || !isObject(saved.scheduleWeeks)) {
    throw new Error("缺少工作台备份数据");
  }
  if (saved.stillnessSessions.some((session) => !isObject(session) || !isDate(session.date) || !habitDefs.some((habit) => habit.id === session.type))) {
    throw new Error("静修记录格式不完整");
  }
  if (saved.runningSessions.some((session) => !isObject(session) || !isDate(session.date) || !(Number(session.distanceKm) > 0))) {
    throw new Error("跑步记录格式不完整");
  }
  Object.entries(saved.scheduleWeeks).forEach(([date, week]) => {
    if (!isDate(date) || !isObject(week) || !Array.isArray(week.slots) || week.slots.some((slot) =>
      !isObject(slot) || typeof slot.id !== "string" || !editableDays.includes(slot.day) ||
      typeof slot.title !== "string" || typeof slot.part !== "string" || typeof slot.name !== "string" ||
      !normalizeManualTime(slot.start) || !normalizeManualTime(slot.end))) {
      throw new Error("课程表格式不完整");
    }
  });
  return normalizeState(saved);
}

function loadState() {
  const raw = storageGet(STORAGE_KEY);
  if (!raw) return defaultState();
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  storageSet(STORAGE_KEY, JSON.stringify(state));
}

const state = loadState();

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function habitTitle(id) {
  const def = habitDefs.find((habit) => habit.id === id);
  return def ? def.title : id;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value = "") {
  return escapeHtml(value).replaceAll("\n", " ");
}

/* ---------- 日期与时间 ---------- */
function pad(value) {
  return String(value).padStart(2, "0");
}

function dateToISO(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayISO() {
  return dateToISO(new Date());
}

function startOfWeek(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return dateToISO(date);
}

function addDays(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateToISO(date);
}

function daysBetween(start, end) {
  return Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000);
}

function inRange(date, start, end) {
  return date >= start && date <= end;
}

function formatLongDate(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  return `${dateValue} ${weekNames[date.getDay()]}`;
}

// ISO 时间字符串 → 本地 "HH:MM"
function hhmmFromIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeToMinutes(time) {
  const parts = String(time || "00:00").split(":").map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

function normalizeManualTime(value) {
  let raw = String(value || "").trim().replaceAll("：", ":");
  if (/^\d{3,4}$/.test(raw)) raw = `${raw.slice(0, -2)}:${raw.slice(-2)}`;
  const match = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

function validateSlotTimeRange(startValue, endValue) {
  const start = normalizeManualTime(startValue);
  const end = normalizeManualTime(endValue);
  if (!start || !end) return { error: "请输入 08:30 或 0830 这样的时间。" };
  if (timeToMinutes(end) <= timeToMinutes(start)) return { error: "结束时间要晚于开始时间。" };
  return { start, end };
}

function addMinutesToTime(time, minutes) {
  const total = timeToMinutes(time) + minutes;
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

function nowHHMM() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- 统计周期 ---------- */
function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function periodFor(range, baseDate) {
  if (range === "day") return { label: "日", start: baseDate, end: baseDate };
  if (range === "month") {
    const y = Number(baseDate.slice(0, 4));
    const m = Number(baseDate.slice(5, 7)) - 1;
    const start = `${baseDate.slice(0, 7)}-01`;
    const end = `${baseDate.slice(0, 7)}-${pad(lastDayOfMonth(y, m))}`;
    return { label: "月", start, end };
  }
  const start = startOfWeek(baseDate);
  return { label: "周", start, end: addDays(start, 6) };
}

function previousPeriod(period) {
  const days = daysBetween(period.start, period.end) + 1;
  const end = addDays(period.start, -1);
  return { start: addDays(end, -days + 1), end };
}

// 周期前后翻页：返回新的参考日期（处理跨月、跨年、月末钳制）
function shiftBaseDate(range, baseDate, dir) {
  const d = new Date(`${baseDate}T00:00:00`);
  if (range === "day") {
    d.setDate(d.getDate() + dir);
  } else if (range === "week") {
    d.setDate(d.getDate() + dir * 7);
  } else {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + dir);
    const last = lastDayOfMonth(d.getFullYear(), d.getMonth());
    d.setDate(Math.min(day, last));
  }
  return dateToISO(d);
}

function periodText(period) {
  return period.start === period.end ? period.start : `${period.start} 至 ${period.end}`;
}

/* ---------- 四习惯计时（壁钟式，刷新/关闭页面不丢） ---------- */
function getHabitTimer(stateValue, id) {
  return stateValue.habitTimers[id] || null;
}

function timerElapsedMs(timer) {
  if (!timer) return 0;
  return (timer.accMs || 0) + (timer.running ? Date.now() - timer.startedAtTs : 0);
}

function startHabitTimer(stateValue, id) {
  const habit = habitDefs.find((item) => item.id === id);
  if (!habit || habit.tracking !== "timer") return;
  const t = stateValue.habitTimers[id];
  if (t && t.running) return;
  stateValue.habitTimers[id] = { running: true, accMs: t ? t.accMs : 0, startedAtTs: Date.now() };
}

function pauseHabitTimer(stateValue, id) {
  const t = stateValue.habitTimers[id];
  if (!t || !t.running) return;
  t.accMs += Date.now() - t.startedAtTs;
  t.running = false;
}

// 结束计时并生成记录；不足 1 秒视为误触，返回 null
function finishHabitTimer(stateValue, id) {
  const t = stateValue.habitTimers[id];
  if (!t) return null;
  const ms = timerElapsedMs(t);
  stateValue.habitTimers[id] = null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return null;
  const endedAt = new Date().toISOString();
  const session = {
    id: uid("stillness"),
    type: id,
    date: dateToISO(new Date()),
    startedAt: t.startedAtTs ? new Date(t.startedAtTs).toISOString() : endedAt,
    endedAt,
    durationSeconds: seconds
  };
  stateValue.stillnessSessions.unshift(session);
  return session;
}

function recordCountHabit(stateValue, id, date = todayISO()) {
  const habit = habitDefs.find((item) => item.id === id);
  if (!habit || habit.tracking !== "count") return null;
  const now = new Date().toISOString();
  const session = {
    id: uid("stillness"),
    type: id,
    date,
    startedAt: now,
    endedAt: now,
    durationSeconds: 0,
    count: 1
  };
  stateValue.stillnessSessions.unshift(session);
  return session;
}

function removeLatestCountHabit(stateValue, id, date = todayISO()) {
  const index = stateValue.stillnessSessions.findIndex((item) => item.type === id && item.date === date);
  if (index < 0) return false;
  const count = countForSession(stateValue.stillnessSessions[index]);
  if (count > 1) stateValue.stillnessSessions[index].count = count - 1;
  else stateValue.stillnessSessions.splice(index, 1);
  return true;
}

function countForSession(session) {
  const count = Number(session.count);
  return Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1;
}

function sessionMeasure(session) {
  return session.type === "baduanjin" ? `${countForSession(session)} 次` : formatDuration(session.durationSeconds);
}

function countHabitRecords(stateValue, id, start, end) {
  return stateValue.stillnessSessions
    .filter((item) => item.type === id && (!start || !end || inRange(item.date, start, end)))
    .reduce((total, item) => total + countForSession(item), 0);
}

/* ---------- 课程表数据 ---------- */
function schedulePartForTime(time) {
  const normalized = normalizeManualTime(time);
  if (!normalized) return null;
  const minutes = timeToMinutes(normalized);
  return minutes < 12 * 60 ? "上午" : minutes < 18 * 60 ? "下午" : "晚上";
}

function compareScheduleSlots(a, b) {
  const minutes = (value) => {
    const normalized = normalizeManualTime(value);
    return normalized ? timeToMinutes(normalized) : Number.MAX_SAFE_INTEGER;
  };
  return minutes(a.start) - minutes(b.start)
    || minutes(a.end) - minutes(b.end)
    || String(a.id || "").localeCompare(String(b.id || ""));
}

function migrateScheduleSlot(slot) {
  // 先依据旧标记记录来源，再重算时段；移到上午的自定义课程仍可删除。
  if (typeof slot.custom !== "boolean") {
    slot.custom = slot.part === "晚上" || slot.name === "晚间" || /(?:^|[-_])evening(?:[-_]|$)/i.test(String(slot.id || ""));
  }
  if (!slot.custom && !slot.templateKey) {
    const legacyKeys = { "上午第1节": "morning-1", "上午第2节": "morning-2", "下午第1节": "afternoon-1", "下午第2节": "afternoon-2" };
    const key = legacyKeys[`${slot.part}${slot.name}`];
    if (key) slot.templateKey = key;
  }
}

function normalizeDaySchedule(week, day) {
  if (!week || !Array.isArray(week.slots)) return [];
  const daySlots = week.slots.filter((slot) => slot && slot.day === day);
  let changed = false;
  let nextCustomOrder = Math.max(0, ...daySlots.map((slot) => Number.isInteger(slot.customOrder) && slot.customOrder > 0 ? slot.customOrder : 0));
  const knownOrders = new Set();
  daySlots.forEach((slot) => {
    migrateScheduleSlot(slot);
    if (slot.custom) {
      if (!Number.isInteger(slot.customOrder) || slot.customOrder < 1 || knownOrders.has(slot.customOrder)) slot.customOrder = ++nextCustomOrder;
      knownOrders.add(slot.customOrder);
    }
    const start = normalizeManualTime(slot.start);
    const end = normalizeManualTime(slot.end);
    if (start && slot.start !== start) { slot.start = start; changed = true; }
    if (end && slot.end !== end) { slot.end = end; changed = true; }
  });
  daySlots.sort(compareScheduleSlots);
  const counters = {};
  daySlots.forEach((slot) => {
    const part = schedulePartForTime(slot.start);
    if (!part) return; // 历史值无法解释时保留原记录，不丢弃课程。
    counters[part] = (counters[part] || 0) + 1;
    const name = `第${counters[part]}节`;
    if (slot.part !== part || slot.name !== name) changed = true;
    slot.part = part;
    slot.name = name;
  });
  week.slots.sort((a, b) => editableDays.indexOf(a.day) - editableDays.indexOf(b.day) || compareScheduleSlots(a, b));
  if (changed) week.report = null;
  return daySlots;
}

function normalizeWeekSchedule(week) {
  if (!week || !Array.isArray(week.slots)) return week;
  [...new Set(week.slots.filter(Boolean).map((slot) => slot.day))].forEach((day) => normalizeDaySchedule(week, day));
  return week;
}

function fixedSlotTemplates(breakMinutes) {
  const b = Math.min(120, Math.max(5, Number(breakMinutes) || 30));
  const am1 = { templateKey: "morning-1", part: "上午", name: "第1节", start: "08:30", end: "09:30" };
  const am2Start = addMinutesToTime(am1.end, b);
  const pm1 = { templateKey: "afternoon-1", part: "下午", name: "第1节", start: "15:00", end: "15:45" };
  const pm2Start = addMinutesToTime(pm1.end, b);
  return [
    am1,
    { templateKey: "morning-2", part: "上午", name: "第2节", start: am2Start, end: addMinutesToTime(am2Start, 60) },
    pm1,
    { templateKey: "afternoon-2", part: "下午", name: "第2节", start: pm2Start, end: addMinutesToTime(pm2Start, 45) }
  ];
}

function ensureWeek(stateValue, weekStart) {
  if (stateValue.scheduleWeeks[weekStart]) return normalizeWeekSchedule(stateValue.scheduleWeeks[weekStart]);
  const slots = [];
  editableDays.forEach((day) => {
    fixedSlotTemplates(stateValue.settings.breakMinutes).forEach((tpl) => {
      slots.push({ id: uid("slot"), day, ...tpl, custom: false, title: "", done: false });
    });
    // 晚间默认一个打卡条目，可增删
    slots.push({ id: uid("slot"), day, part: "晚上", name: "晚间", custom: true, start: "21:00", end: "22:30", title: "", done: false });
  });
  const week = { weekStart, slots, report: null };
  stateValue.scheduleWeeks[weekStart] = week;
  return normalizeWeekSchedule(week);
}

function getWeek(stateValue, weekStart) {
  return ensureWeek(stateValue, weekStart);
}

function addScheduleSlot(stateValue, weekStart, day) {
  const week = getWeek(stateValue, weekStart);
  const endTimes = week.slots.filter((slot) => slot.day === day && normalizeManualTime(slot.end)).map((slot) => timeToMinutes(normalizeManualTime(slot.end)));
  const lastEnd = endTimes.length ? Math.max(...endTimes) : 9 * 60;
  const startMinutes = lastEnd + 60 < 24 * 60 ? lastEnd : 9 * 60;
  const start = `${pad(Math.floor(startMinutes / 60))}:${pad(startMinutes % 60)}`;
  const slot = { id: uid("slot"), day, custom: true, start, end: addMinutesToTime(start, 60), title: "", done: false };
  week.slots.push(slot);
  week.report = null;
  normalizeDaySchedule(week, day);
  return slot;
}

function removeScheduleSlot(stateValue, weekStart, slotId) {
  const week = getWeek(stateValue, weekStart);
  const slot = week.slots.find((s) => s.id === slotId);
  if (!slot || !slot.custom) return false;
  week.slots = week.slots.filter((s) => s.id !== slotId);
  week.report = null;
  normalizeDaySchedule(week, slot.day);
  return true;
}

// 保留旧调用名与备份兼容；权限由 custom 决定，不再由展示时段决定。
function addEveningSlot(stateValue, weekStart, day) { return addScheduleSlot(stateValue, weekStart, day); }
function removeEveningSlot(stateValue, weekStart, slotId) { return removeScheduleSlot(stateValue, weekStart, slotId); }

// 按设置的课间时长重排本周第2节（上午/下午）的起止时间
function applyBreakToWeek(stateValue, weekStart) {
  const week = getWeek(stateValue, weekStart);
  week.report = null;
  const tpl = fixedSlotTemplates(stateValue.settings.breakMinutes);
  editableDays.forEach((day) => {
    const am2 = week.slots.find((s) => s.day === day && s.templateKey === "morning-2" && !s.custom);
    const pm2 = week.slots.find((s) => s.day === day && s.templateKey === "afternoon-2" && !s.custom);
    if (am2) { am2.start = tpl[1].start; am2.end = tpl[1].end; }
    if (pm2) { pm2.start = tpl[3].start; pm2.end = tpl[3].end; }
    normalizeDaySchedule(week, day);
  });
}

// 固定条目按稳定来源对齐，自定义按复制关联/顺序对齐；目标多出课程保留。
function copyWeekTitles(stateValue, weekStart) {
  const source = stateValue.scheduleWeeks[addDays(weekStart, -7)];
  const week = getWeek(stateValue, weekStart);
  if (!source) return false;
  normalizeWeekSchedule(source);
  week.report = null;
  editableDays.forEach((day) => {
    const sourceSlots = source.slots.filter((slot) => slot.day === day).sort(compareScheduleSlots);
    const targets = week.slots.filter((slot) => slot.day === day).sort(compareScheduleSlots);
    const used = new Set();
    sourceSlots.forEach((previous) => {
      let target = targets.find((slot) => !used.has(slot) && slot.custom === previous.custom && slot.copySourceId === previous.id);
      if (!target && !previous.custom && previous.templateKey) {
        target = targets.find((slot) => !used.has(slot) && !slot.custom && slot.templateKey === previous.templateKey);
      }
      if (!target && previous.custom) {
        // 使用稳定创建顺序，而非当前时间顺序；目标额外的早课不会被抢占。
        target = targets.find((slot) => !used.has(slot) && slot.custom && slot.customOrder === previous.customOrder);
      }
      if (!target && !previous.custom && !previous.templateKey) {
        target = targets.find((slot) => !used.has(slot) && !slot.custom && !slot.templateKey);
      }
      if (target) {
        const id = target.id;
        Object.assign(target, previous, { id, done: false, copySourceId: previous.id });
        used.add(target);
      } else {
        week.slots.push({ ...previous, id: uid("slot"), done: false, copySourceId: previous.id });
      }
    });
    normalizeDaySchedule(week, day);
  });
  return true;
}

function clearWeekTitles(stateValue, weekStart) {
  const week = getWeek(stateValue, weekStart);
  week.report = null;
  week.slots.forEach((slot) => {
    slot.title = "";
    slot.done = false;
  });
}

/* ---------- 汇总与格式化 ---------- */
function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function avg(values) {
  return values.length ? Math.round(sum(values) / values.length) : 0;
}

function max(values) {
  return values.length ? Math.max(...values.map(Number)) : 0;
}

function min(values) {
  return values.length ? Math.min(...values.map(Number)) : 0;
}

function formatClock(seconds) {
  const safe = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

function formatDuration(seconds) {
  const safe = Math.round(seconds || 0);
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ""}`;
  if (minutes > 0) return `${minutes}分钟${secs ? `${secs}秒` : ""}`;
  return `${secs}秒`;
}

function formatRunDuration(seconds) {
  const safe = Math.round(seconds || 0);
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ""}${secs ? `${secs}秒` : ""}`;
  if (minutes > 0) return `${minutes}分钟${secs ? `${secs}秒` : ""}`;
  return `${secs}秒`;
}

function formatPace(secondsPerKm) {
  if (!secondsPerKm) return "暂无";
  return `${Math.floor(secondsPerKm / 60)}'${pad(secondsPerKm % 60)}"/km`;
}

// 一组日期中的最长连续天数
function maxStreak(dateList) {
  const set = new Set(dateList);
  if (!set.size) return 0;
  const sorted = [...set].sort();
  let best = 1;
  let cur = 1;
  for (let i = 1; i < sorted.length; i++) {
    cur = addDays(sorted[i - 1], 1) === sorted[i] ? cur + 1 : 1;
    if (cur > best) best = cur;
  }
  return best;
}

/* ---------- 报告 ---------- */
function stillnessSessionsIn(stateValue, habit, start, end) {
  return stateValue.stillnessSessions
    .filter((s) => (habit === "all" || s.type === habit) && inRange(s.date, start, end))
    .sort((a, b) => String(a.startedAt || a.endedAt || a.date).localeCompare(String(b.startedAt || b.endedAt || b.date)));
}

function runningRecordsIn(stateValue, start, end) {
  return stateValue.runningSessions
    .filter((r) => inRange(r.date, start, end))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || "").localeCompare(b.createdAt || ""));
}

function buildStillnessReport(stateValue, opts) {
  const habit = opts.habit && habitDefs.some((h) => h.id === opts.habit) ? opts.habit : "all";
  const range = opts.range === "day" || opts.range === "month" ? opts.range : "week";
  const baseDate = opts.baseDate || todayISO();
  const period = periodFor(range, baseDate);
  const previous = previousPeriod(period);
  const selectedSessions = stillnessSessionsIn(stateValue, habit, period.start, period.end);
  const previousSelected = stillnessSessionsIn(stateValue, habit, previous.start, previous.end);
  const countSessions = selectedSessions.filter((session) => session.type === "baduanjin");
  const previousCountSessions = previousSelected.filter((session) => session.type === "baduanjin");

  if (habit === "baduanjin") {
    const count = sum(countSessions.map(countForSession));
    const previousCount = sum(previousCountSessions.map(countForSession));
    const activeDays = new Set(countSessions.map((session) => session.date)).size;
    const streak = maxStreak(countSessions.map((session) => session.date));
    const lines = [
      `【八段锦 · ${period.label}报告】`,
      `统计区间：${periodText(period)}。`,
      "",
      count ? `共完成 ${count} 次，分布在 ${activeDays} 天${streak >= 2 ? `，最长连续 ${streak} 天` : ""}。` : "本周期暂无练习记录。",
      "",
      "明细（按时间顺序）："
    ];
    if (!countSessions.length) lines.push("- 暂无记录。");
    else countSessions.forEach((session) => lines.push(`- ${session.date.slice(5)} ${hhmmFromIso(session.startedAt || session.endedAt)} · ${sessionMeasure(session)}`));
    lines.push("");
    if (!count && !previousCount) lines.push("评价与建议：先从完整练习 1 次开始，完成后随手记下即可。");
    else if (count && !previousCount) lines.push(`评价与建议：本周期已经完成 ${count} 次，先保持稳定频率，不必急着加量。`);
    else if (!count && previousCount) lines.push(`评价与建议：上一周期完成 ${previousCount} 次，本周期尚未记录，可以先恢复 1 次。`);
    else lines.push(`评价与建议：本周期比上一周期${count >= previousCount ? "多" : "少"} ${Math.abs(count - previousCount)} 次，继续以动作完整和呼吸稳定为先。`);
    return lines.join("\n");
  }

  const sessions = selectedSessions.filter((session) => session.type !== "baduanjin");
  const prevSessions = previousSelected.filter((session) => session.type !== "baduanjin");
  const durations = sessions.map((s) => s.durationSeconds);
  const prevDurations = prevSessions.map((s) => s.durationSeconds);
  const activeDays = new Set(sessions.map((s) => s.date)).size;
  const streak = maxStreak(sessions.map((s) => s.date));
  const title = habit === "all" ? "全部静修" : habitTitle(habit);
  const lines = [];
  lines.push(`【${title} · ${period.label}报告】`);
  lines.push(`统计区间：${periodText(period)}。`);
  lines.push("");
  if (!sessions.length && !countSessions.length) {
    lines.push("本周期暂无练习记录。");
  }
  if (sessions.length) {
    const streakText = streak >= 2 ? `，其中最长连续 ${streak} 天` : "";
    lines.push(`共练习 ${sessions.length} 次，总时长 ${formatDuration(sum(durations))}，平均每次 ${formatDuration(avg(durations))}，最长单次 ${formatDuration(max(durations))}，最短单次 ${formatDuration(min(durations))}；共在 ${activeDays} 天练习${streakText}。`);
  }
  if (countSessions.length) lines.push(`八段锦另完成 ${sum(countSessions.map(countForSession))} 次。`);
  lines.push("");
  lines.push("明细（按时间顺序）：");
  if (!selectedSessions.length) {
    lines.push("- 暂无记录。");
  } else {
    selectedSessions.forEach((s) => {
      const prefix = habit === "all" ? `${habitTitle(s.type)} · ` : "";
      const measure = sessionMeasure(s);
      lines.push(`- ${s.date.slice(5)} ${hhmmFromIso(s.startedAt || s.endedAt)} · ${prefix}${measure}`);
    });
  }
  lines.push("");
  if (!sessions.length && countSessions.length) {
    lines.push(`评价与建议：本周期八段锦完成 ${sum(countSessions.map(countForSession))} 次，继续保持随练随记即可。`);
  } else {
    lines.push(`评价与建议：${buildStillnessAdvice({
      habitId: habit,
      count: sessions.length,
      total: sum(durations),
      averageSec: avg(durations),
      activeDays,
      streak,
      previousCount: prevSessions.length,
      previousTotal: sum(prevDurations),
      previousAverageSec: avg(prevDurations),
      previousActiveDays: new Set(prevSessions.map((s) => s.date)).size
    })}`);
  }
  return lines.join("\n");
}

function buildStillnessAdvice(o) {
  if (!o.count && !o.previousCount) {
    return "还没有可比较的记录。先从一次 10 分钟开始，挑一个每天固定的时段，入口越轻越好坚持。";
  }
  if (o.count && !o.previousCount) {
    return `本周期有了 ${o.count} 次记录，共 ${formatDuration(o.total)}。先别急着加时长，下一步重点是让练习连续出现几天。`;
  }
  if (!o.count && o.previousCount) {
    return `本周期没有记录，上一周期有 ${o.previousCount} 次。先把单次门槛降到 5–10 分钟，把节奏接回来，再谈延长。`;
  }
  const totalDiff = o.total - o.previousTotal;
  const countDiff = o.count - o.previousCount;
  const diffPart = `总时长比上一周期${totalDiff >= 0 ? "多" : "少"} ${formatDuration(Math.abs(totalDiff))}`;
  const freqPart = countDiff > 0 ? `次数多 ${countDiff} 次` : countDiff < 0 ? `次数少 ${Math.abs(countDiff)} 次` : "次数与上一周期相同";
  let core;
  if (totalDiff > 0 && countDiff > 0 && o.activeDays >= o.previousActiveDays) {
    core = `${diffPart}，${freqPart}，覆盖天数也在涨。节奏已经立住了，单次时长可以暂时不加，先把入口保持住。`;
  } else if (totalDiff > 0 && countDiff <= 0) {
    core = `${diffPart}，但主要是单次拉长带来的。下一周期先把频率稳住，再考虑加时。`;
  } else if (countDiff > 0 && totalDiff <= 0) {
    core = `${freqPart}，但总时长没跟上，说明单次在变短。方向可以保留，继续把入口做轻。`;
  } else if (totalDiff < 0) {
    core = `${diffPart}，${freqPart}，静修量回落了。先把目标调回容易完成的区间，规律感比补时长更重要。`;
  } else if (o.averageSec > o.previousAverageSec + 60) {
    core = `总量与上一周期接近，但单次平均更扎实（${formatDuration(o.averageSec)}，上周期 ${formatDuration(o.previousAverageSec)}）。下一步观察能不能把节奏铺得更均匀。`;
  } else if (o.averageSec < o.previousAverageSec - 60) {
    core = `总量与上一周期接近，但单次平均变短（${formatDuration(o.averageSec)}，上周期 ${formatDuration(o.previousAverageSec)}）。注意保持每次练习的完整性，宁少勿碎。`;
  } else {
    core = "总量与上一周期接近，节奏比较稳定。继续维持即可，不必急着加压。";
  }
  const parts = [core];
  if (o.count) {
    const flavors = {
      meditation: "冥想可以固定在每天同一个时段，形成身体记忆。",
      standing: "站桩重在姿势与呼吸的配合，时长稳中有升即可，不必快。",
      reading: "读书时先定一个容易开始的时段，读完留两三分钟整理要点，效果更好。",
      walking: "散步贵在放松，不必追求速度与时长。",
      focus: "专注学习可先以 25–50 分钟为一段，息屏后计时仍按真实经过时间累计。"
    };
    if (flavors[o.habitId]) parts.push(flavors[o.habitId]);
  }
  if (o.streak >= 2) parts.push(`本周期最长连续 ${o.streak} 天有练习。`);
  if (o.count < 3) {
    parts.push("下一周期建议至少隔天一次（3–4 次）。");
  } else {
    parts.push("下一周期保持现有节奏即可，有余力可尝试把单次延长 5 分钟。");
  }
  return parts.join("");
}

function buildRunningReport(stateValue, opts) {
  const range = opts.range === "day" || opts.range === "month" ? opts.range : "week";
  const baseDate = opts.baseDate || todayISO();
  const period = periodFor(range, baseDate);
  const previous = previousPeriod(period);
  const runs = runningRecordsIn(stateValue, period.start, period.end);
  const prevRuns = runningRecordsIn(stateValue, previous.start, previous.end);
  const totalKm = sum(runs.map((r) => r.distanceKm));
  const totalSec = sum(runs.map((r) => r.durationSeconds));
  const prevKm = sum(prevRuns.map((r) => r.distanceKm));
  const prevSec = sum(prevRuns.map((r) => r.durationSeconds));
  const avgPace = totalKm ? Math.round(totalSec / totalKm) : 0;
  const prevPace = prevKm ? Math.round(prevSec / prevKm) : 0;
  const lines = [];
  lines.push(`【跑步 · ${period.label}报告】`);
  lines.push(`统计区间：${periodText(period)}。`);
  lines.push("");
  if (!runs.length) {
    lines.push("本周期暂无跑步记录。");
  } else {
    lines.push(`共跑 ${runs.length} 次，总距离 ${totalKm.toFixed(2)} 公里，总用时 ${formatDuration(totalSec)}，平均配速 ${formatPace(avgPace)}，总消耗约 ${Math.round(sum(runs.map((r) => r.calories)))} 大卡，平均每次 ${(totalKm / runs.length).toFixed(2)} 公里，最多单次 ${max(runs.map((r) => r.distanceKm)).toFixed(2)} 公里。`);
  }
  lines.push("");
  lines.push("明细（按时间顺序）：");
  if (!runs.length) {
    lines.push("- 暂无记录。");
  } else {
    runs.forEach((r) => {
      const pace = r.paceSecondsPerKm || (r.distanceKm ? Math.round(r.durationSeconds / r.distanceKm) : 0);
      lines.push(`- ${r.date.slice(5)}：${r.distanceKm.toFixed(2)} 公里，用时 ${formatRunDuration(r.durationSeconds)}，配速 ${formatPace(pace)}，消耗 ${Math.round(r.calories)} 大卡`);
    });
  }
  lines.push("");
  lines.push(`评价与建议：${buildRunningAdvice({
    count: runs.length,
    totalKm,
    totalSec,
    avgPaceSec: avgPace,
    avgKm: runs.length ? totalKm / runs.length : 0,
    activeDays: new Set(runs.map((r) => r.date)).size,
    previousCount: prevRuns.length,
    previousKm: prevKm,
    previousSec: prevSec,
    previousPaceSec: prevPace,
    previousActiveDays: new Set(prevRuns.map((r) => r.date)).size
  })}`);
  return lines.join("\n");
}

function buildRunningAdvice(o) {
  if (!o.count && !o.previousCount) {
    return "还没有可比较的跑步记录。先记一趟轻松跑，把基线立起来。";
  }
  if (o.count && !o.previousCount) {
    return `本周期跑了 ${o.count} 次，共 ${o.totalKm.toFixed(2)} 公里。先稳住每周出现次数，再看配速。`;
  }
  if (!o.count && o.previousCount) {
    return `本周期没有跑步记录，上一周期 ${o.previousCount} 次。先恢复一次轻松跑，不急着提强度。`;
  }
  const kmDiff = o.totalKm - o.previousKm;
  const countDiff = o.count - o.previousCount;
  const kmPart = `总距离比上一周期${kmDiff >= 0 ? "多" : "少"} ${Math.abs(kmDiff).toFixed(2)} 公里`;
  const freqPart = countDiff > 0 ? `次数多 ${countDiff} 次` : countDiff < 0 ? `次数少 ${Math.abs(countDiff)} 次` : "次数与上一周期相同";
  let core;
  if (kmDiff > 0 && countDiff > 0 && o.activeDays >= o.previousActiveDays) {
    core = `${kmPart}，${freqPart}，增长不靠单趟拉长。下一步注意恢复，别连续加量太快。`;
  } else if (kmDiff > 0 && countDiff <= 0) {
    core = `${kmPart}，但更像是单趟拉长带来的。下一周期先补频率，再看要不要继续加距离。`;
  } else if (countDiff > 0 && kmDiff <= 0) {
    core = `${freqPart}，但总距离没跟上。这个阶段先稳住节奏，别急着把每次跑得太重。`;
  } else if (kmDiff < 0) {
    core = `${kmPart}，${freqPart}，跑量回落了。先把固定跑日找回来，比追配速更重要。`;
  } else {
    core = "总量与上一周期接近，说明底子已经在了。下一步继续观察配速和体感。";
  }
  const parts = [core];
  if (o.count && o.avgPaceSec && o.previousPaceSec) {
    const diff = o.previousPaceSec - o.avgPaceSec;
    if (diff >= 10) parts.push(`平均配速比上一周期快了 ${diff} 秒/公里（${formatPace(o.avgPaceSec)}，上周期 ${formatPace(o.previousPaceSec)}）。`);
    if (diff <= -10) parts.push(`平均配速比上一周期慢了 ${-diff} 秒/公里（${formatPace(o.avgPaceSec)}，上周期 ${formatPace(o.previousPaceSec)}），注意恢复与休息。`);
  }
  if (!o.count) return parts.join("");
  if (o.count < 2) {
    parts.push("下一周期建议每周至少 2–3 次，先保频率。");
  } else if (o.avgKm > 8) {
    parts.push("单次距离较长，注意跑前热身与跑后拉伸，跑休结合。");
  } else {
    parts.push("保持现有节奏，下一周期可观察配速和体感变化。");
  }
  return parts.join("");
}

function slotTitleText(slot) {
  if (slot.part === "晚上") return slot.title.trim() ? `晚间《${slot.title.trim()}》` : "晚间条目";
  return `《${slot.title.trim()}》`;
}

function buildScheduleReport(stateValue, weekStart) {
  const week = getWeek(stateValue, weekStart);
  const named = week.slots.filter((slot) => slot.title.trim());
  const done = named.filter((slot) => slot.done);
  const rate = named.length ? Math.round((done.length / named.length) * 100) : 0;
  const byDay = editableDays.map((day, index) => {
    const daySlots = named
      .filter((slot) => slot.day === day)
      .sort(compareScheduleSlots);
    const dayDate = addDays(weekStart, index);
    if (!daySlots.length) return `${weekNames[day]}（${dayDate.slice(5)}）：无打卡课程。`;
    const dayDone = daySlots.filter((slot) => slot.done);
    if (dayDone.length === daySlots.length) {
      return `${weekNames[day]}（${dayDate.slice(5)}）：${daySlots.length} 节全部完成（${daySlots.map(slotTitleText).join("、")}）。`;
    }
    const undone = daySlots.filter((slot) => !slot.done).map(slotTitleText);
    return `${weekNames[day]}（${dayDate.slice(5)}）：${daySlots.length} 节，完成 ${dayDone.length} 节；未完成：${undone.join("、")}。`;
  });
  const allDoneDays = editableDays.filter((day) => {
    const daySlots = named.filter((slot) => slot.day === day);
    return daySlots.length > 0 && daySlots.every((slot) => slot.done);
  }).length;
  const lines = [];
  lines.push("【课程表周报】");
  lines.push(`本周：${weekStart} 至 ${addDays(weekStart, 6)}。`);
  lines.push("");
  lines.push(`已打卡 ${done.length} 节 / 已填写课名 ${named.length} 节，完成率 ${rate}%。`);
  lines.push("");
  lines.push("每日情况：");
  byDay.forEach((text) => lines.push(`- ${text}`));
  lines.push("");
  lines.push(`评价与建议：${buildScheduleAdvice(rate, named.length, allDoneDays)}`);
  return lines.join("\n");
}

function buildScheduleAdvice(rate, total, allDoneDays) {
  if (!total) return "本周没有课程记录。";
  if (rate >= 100) return `完成率 100%，其中 ${allDoneDays} 天全部打卡。节奏很稳，下一周照常安排即可。`;
  if (rate >= 80) return `完成率 ${rate}%，漏打的集中在少数几节（见明细）。下周上完课就打卡，避免积压。`;
  if (rate >= 50) return `完成率 ${rate}%，未完成的课程较多。可以先少填一点，保住真正要打卡的课。`;
  return `完成率 ${rate}%，明显偏低。建议核对日程安排，难以保证的课先空着不填。`;
}

function buildWeeklySummary(stateValue, baseDate) {
  const weekStart = startOfWeek(baseDate || todayISO());
  const weekEnd = addDays(weekStart, 6);
  const habitRows = habitDefs.map((habit) => {
    const sessions = stillnessSessionsIn(stateValue, habit.id, weekStart, weekEnd);
    return {
      title: habit.title,
      tracking: habit.tracking,
      count: habit.tracking === "count"
        ? sum(sessions.map(countForSession))
        : sessions.length,
      seconds: sum(sessions.map((session) => session.durationSeconds))
    };
  });
  const runs = runningRecordsIn(stateValue, weekStart, weekEnd);
  const runSeconds = sum(runs.map((run) => run.durationSeconds));
  const runDistance = runs.reduce((total, run) => total + run.distanceKm, 0);
  const week = getWeek(stateValue, weekStart);
  const namedSlots = week.slots.filter((slot) => slot.title.trim());
  const doneSlots = namedSlots
    .filter((slot) => slot.done)
    .sort((a, b) => editableDays.indexOf(a.day) - editableDays.indexOf(b.day) || compareScheduleSlots(a, b));
  const totalSeconds = sum(habitRows.map((row) => row.seconds)) + runSeconds;
  const lines = [
    "【每周总结】",
    `${weekStart} 至 ${weekEnd}`,
    "",
    `总记录时间：${formatDuration(totalSeconds)}`,
    ...habitRows.map((row) => row.tracking === "count"
      ? `- ${row.title}：${row.count} 次`
      : `- ${row.title}：${formatDuration(row.seconds)}（${row.count} 次）`),
    `- 跑步：${formatRunDuration(runSeconds)}（${runs.length} 次，共 ${runDistance.toFixed(2)} 公里）`,
    "",
    `完成课程：${doneSlots.length}/${namedSlots.length}`
  ];
  if (doneSlots.length) {
    doneSlots.forEach((slot) => {
      const date = addDays(weekStart, editableDays.indexOf(slot.day));
      lines.push(`- ${date.slice(5)} ${slot.title.trim()}`);
    });
  } else {
    lines.push("- 暂无已完成课程");
  }
  return lines.join("\n");
}

/* ---------- 供 Node 测试 ---------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    STORAGE_KEY,
    habitDefs,
    defaultHabitTimers,
    weekNames,
    editableDays,
    defaultState,
    normalizeState,
    normalizeRunDraft,
    normalizeBackup,
    loadState,
    saveState,
    uid,
    habitTitle,
    escapeHtml,
    escapeAttribute,
    dateToISO,
    todayISO,
    startOfWeek,
    addDays,
    daysBetween,
    inRange,
    formatLongDate,
    hhmmFromIso,
    timeToMinutes,
    normalizeManualTime,
    validateSlotTimeRange,
    addMinutesToTime,
    nowHHMM,
    periodFor,
    previousPeriod,
    shiftBaseDate,
    periodText,
    getHabitTimer,
    timerElapsedMs,
    startHabitTimer,
    pauseHabitTimer,
    finishHabitTimer,
    recordCountHabit,
    removeLatestCountHabit,
    countHabitRecords,
    countForSession,
    sessionMeasure,
    fixedSlotTemplates,
    schedulePartForTime,
    compareScheduleSlots,
    normalizeDaySchedule,
    normalizeWeekSchedule,
    ensureWeek,
    getWeek,
    addScheduleSlot,
    removeScheduleSlot,
    addEveningSlot,
    removeEveningSlot,
    applyBreakToWeek,
    copyWeekTitles,
    clearWeekTitles,
    sum,
    avg,
    max,
    min,
    formatClock,
    formatDuration,
    formatRunDuration,
    formatPace,
    maxStreak,
    stillnessSessionsIn,
    runningRecordsIn,
    buildStillnessReport,
    buildRunningReport,
    buildScheduleReport,
    buildWeeklySummary
  };
}
