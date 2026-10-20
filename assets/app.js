import {
  MAX_BODY,
  MAX_PHOTOS,
  SEEDED_KEY,
  SETTINGS_KEY,
  TIME_FEELS,
  TIME_MAP,
  addDays,
  dateKey,
  formatBytes,
  formatFullDate,
  formatMonthDay,
  formatMonthYear,
  isEditable,
  mergeData,
  monthCells,
  normalizeImport,
  remapAnnotations,
  segmentBody,
  sortAnnotations,
  sortEntries,
  todayKey,
  uid,
  validateAnnotation,
  validateEntry,
  weekdayCN
} from "./model.js";
import * as db from "./db.js";
import {
  blobToDataUrl,
  compressPhoto,
  dataUrlToBlob,
  isImageFile,
  makePhoto,
  photoSize
} from "./photos.js";

const viewEl = document.getElementById("view");
const modalRoot = document.getElementById("modal-root");
const pill = document.getElementById("selection-pill");
const toastEl = document.getElementById("toast");
const storageNote = document.getElementById("storage-note");

const state = {
  entries: [],
  annotations: [],
  photos: new Map(),
  photoUrls: new Map(),
  settings: { signature: "余温", penName: "我" },
  view: "today",
  entryId: null,
  entryFrom: "log",
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selection: null,
  draft: null,
  modal: null,
  storageOk: true,
  forceMemory: false,
  processingPhotos: false,
  usage: { used: 0, quota: 0 }
};

/* ── small helpers ─────────────────────────────────────── */

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function byDate(date) {
  return state.entries.find((entry) => entry.date === date) || null;
}

function byId(id) {
  return state.entries.find((entry) => entry.id === id) || null;
}

function notesFor(entryId) {
  return sortAnnotations(state.annotations.filter((annotation) => annotation.entryId === entryId));
}

function currentEntry() {
  if (state.view === "entry") return byId(state.entryId);
  if (state.view === "today") return byDate(todayKey());
  return null;
}

function timeLabel(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function previewText(entry, length = 64) {
  const text = String(entry.body || "").replace(/\s+/g, " ").trim();
  if (!text) return entry.photos?.length ? "只有一张照片。" : "";
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function timeColor(entry) {
  return (TIME_MAP[entry.time] || TIME_MAP.night).color;
}

function timeLabelOf(entry) {
  return (TIME_MAP[entry.time] || TIME_MAP.night).label;
}

function guessTime() {
  const hour = new Date().getHours();
  if (hour < 5) return "latenight";
  if (hour < 7) return "dawn";
  if (hour < 11) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 19) return "dusk";
  if (hour < 23) return "night";
  return "latenight";
}

function photoUrl(photoId) {
  const photo = state.photos.get(photoId);
  if (!photo?.blob) return "";
  if (!state.photoUrls.has(photoId)) {
    state.photoUrls.set(photoId, URL.createObjectURL(photo.blob));
  }
  return state.photoUrls.get(photoId);
}

function revokePhotoUrl(photoId) {
  const url = state.photoUrls.get(photoId);
  if (url) {
    URL.revokeObjectURL(url);
    state.photoUrls.delete(photoId);
  }
}

function showToast(message, kind = "ok") {
  toastEl.textContent = message;
  toastEl.classList.toggle("is-error", kind === "error");
  toastEl.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toastEl.classList.remove("is-visible");
  }, 2600);
}

function friendlyStorageError(error) {
  if (error?.name === "QuotaExceededError") {
    return "本地空间不够了。先导出备份，再删掉一些照片或旧日记。";
  }
  return error?.message || "没有保存成功，请再试一次。";
}

function updateBrand() {
  document.querySelectorAll(".brand-name").forEach((element) => {
    element.textContent = state.settings.signature || "余温";
  });
  document.title = `${state.settings.signature || "余温"} · Afterglow`;
}

/* ── boot ──────────────────────────────────────────────── */

async function boot() {
  try {
    const rawSettings = localStorage.getItem(SETTINGS_KEY);
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings);
      state.settings = {
        signature: String(parsed.signature || "余温"),
        penName: String(parsed.penName || "我")
      };
    }
  } catch {
    // Keep defaults when settings are unreadable.
  }
  updateBrand();

  const params = new URLSearchParams(location.search);
  const forceMemory = params.get("storage") === "memory";

  if (forceMemory) {
    state.forceMemory = true;
    state.storageOk = false;
    storageNote.textContent = "预览模式：刷新后内容会重置";
    storageNote.style.color = "#8b3c1e";
    await seedFirstRun();
    applyRoute();
    render();
    if (params.get("compose") === "1") openComposer();
    return;
  }

  try {
    const [entries, annotations, photos] = await Promise.all([
      db.getAll("entries"),
      db.getAll("annotations"),
      db.getAll("photos")
    ]);

    state.entries = sortEntries(entries);
    state.annotations = sortAnnotations(annotations);
    for (const photo of photos) state.photos.set(photo.id, photo);

    const seeded = localStorage.getItem(SEEDED_KEY) === "1";
    if (state.entries.length === 0 && !seeded) {
      await seedFirstRun();
    }
  } catch (error) {
    state.storageOk = false;
    storageNote.textContent = "本地存储不可用，刷新会丢失";
    storageNote.style.color = "#8b3c1e";
    showToast(error.message || "本地数据库没有打开", "error");
    if (state.entries.length === 0) await seedFirstRun();
  }

  applyRoute();
  render();
  if (params.get("compose") === "1") openComposer();
}

async function seedFirstRun() {
  const today = todayKey();
  const twoDaysAgo = addDays(today, -2);
  const yesterday = addDays(today, -1);

  const entryA = {
    id: "seed-entry-older",
    date: twoDaysAgo,
    time: "afternoon",
    word: "隙",
    body:
      "整理旧书的时候，从一本诗集里掉出一张车票。日期已经模糊，只认得出是从前的城市。\n\n" +
      "我不记得那次旅程了，却记得书页里有一句话被铅笔轻轻划过。原来有些日子不是被记住的，是被夹在什么地方，等很多年以后自己掉出来。\n\n" +
      "傍晚的光斜斜地落在书脊上。我把车票放回去，没有扔。",
    photos: [],
    author: "余温",
    createdAt: new Date(`${twoDaysAgo}T16:40:00`).toISOString(),
    updatedAt: new Date(`${twoDaysAgo}T16:40:00`).toISOString()
  };

  const entryB = {
    id: "seed-entry-recent",
    date: yesterday,
    time: "night",
    word: "缓",
    body:
      "今天没有发生什么大事。\n\n" +
      "午后把窗开了十分钟，风把桌上的纸吹起一角，又轻轻放下。我忽然觉得，所谓安稳，可能就是这样：有东西被风吹动，但没有真的离开。\n\n" +
      "晚上煮了一碗面，等水开的时候看了一会儿楼下。有人牵着狗慢慢走，路灯把影子拉得很长。\n\n" +
      "把这一天记下来，不是因为它特别，而是因为它足够普通，普通到以后大概会忘记。",
    photos: [],
    author: "余温",
    createdAt: new Date(`${yesterday}T22:12:00`).toISOString(),
    updatedAt: new Date(`${yesterday}T22:12:00`).toISOString()
  };

  const quote = "有些日子不是被记住的，是被夹在什么地方";
  const start = entryA.body.indexOf(quote);
  const annotation = {
    id: "seed-note-1",
    entryId: entryA.id,
    quote,
    start,
    end: start + quote.length,
    note: "这句话让我想起抽屉里那叠没寄出的明信片。",
    createdAt: new Date(`${twoDaysAgo}T21:03:00`).toISOString(),
    orphan: false
  };

  state.entries = sortEntries([entryA, entryB]);
  state.annotations = [annotation];

  if (!state.storageOk) return;

  try {
    await db.putEntry(entryA);
    await db.putEntry(entryB);
    await db.putAnnotation(annotation);
    localStorage.setItem(SEEDED_KEY, "1");
  } catch {
    state.storageOk = false;
    storageNote.textContent = "本地存储写入失败，刷新会丢失";
    storageNote.style.color = "#8b3c1e";
  }
}

/* ── routing ───────────────────────────────────────────── */

function applyRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [head, ...rest] = raw.split("/");

  if (head === "entry" && rest.length) {
    const id = decodeURIComponent(rest.join("/"));
    if (byId(id)) {
      state.view = "entry";
      state.entryId = id;
      if (!state.entryFrom) state.entryFrom = "log";
      return;
    }
  }

  if (head === "log" || head === "calendar") {
    state.view = head;
    state.entryId = null;
    return;
  }

  state.view = "today";
  state.entryId = null;
}

function routeTo(hash) {
  if (location.hash === hash) {
    applyRoute();
    render();
    return;
  }
  location.hash = hash;
}

function navigate(view) {
  closeModal({ silent: true });
  state.view = view;
  state.entryId = null;
  routeTo(`#/${view}`);
}

function openEntry(id, from) {
  if (!byId(id)) {
    showToast("这一页找不到了", "error");
    return;
  }
  state.entryFrom = from || state.view;
  routeTo(`#/entry/${encodeURIComponent(id)}`);
}

/* ── render shell / views ──────────────────────────────── */

function render() {
  syncNav();
  hideSelectionPill();
  renderView();
  renderFooter();
}

function syncNav() {
  const active = state.view === "entry" ? state.entryFrom : state.view;
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.nav === active);
  });
}

function renderFooter() {
  if (state.forceMemory) {
    storageNote.textContent = "预览模式 · 刷新后内容会重置";
    storageNote.style.color = "#8b3c1e";
    return;
  }
  if (!state.storageOk) {
    storageNote.textContent = "本地存储不可用，刷新会丢失";
    storageNote.style.color = "#8b3c1e";
    return;
  }
  storageNote.textContent = "文字和照片只存在这台设备上";
  storageNote.style.color = "";
}

function renderView() {
  if (state.view === "log") {
    viewEl.innerHTML = renderLog();
  } else if (state.view === "calendar") {
    viewEl.innerHTML = renderCalendar();
  } else if (state.view === "entry") {
    const entry = byId(state.entryId);
    if (!entry) {
      viewEl.innerHTML = renderEmptyState();
    } else {
      viewEl.innerHTML = renderEntry(entry, { back: true });
    }
  } else {
    viewEl.innerHTML = renderToday();
  }
}

function renderToday() {
  const entry = byDate(todayKey());
  if (entry) return renderEntry(entry, { back: false });

  const latest = state.entries[0];
  return `
    <div class="today-empty">
      <section class="empty">
        ${emptyMark()}
        <h1>今天还没有落笔</h1>
        <p>写几句话，或者放一张今天的照片。一天只留一页，写完就收进柜子里。</p>
        <div class="empty-actions">
          <button class="btn btn-primary" type="button" data-action="compose">写今天</button>
          <button class="btn" type="button" data-action="compose-photo">放一张照片</button>
        </div>
      </section>
      ${
        latest
          ? `
        <button class="latest-card" type="button" data-action="open-entry" data-id="${esc(latest.id)}" data-from="today">
          <span class="latest-label">最近一页</span>
          <span class="latest-date">${esc(formatMonthDay(latest.date))} · ${esc(latest.word)}</span>
          <span class="latest-preview">${esc(previewText(latest, 52))}</span>
          <span class="latest-arrow">→</span>
        </button>`
          : ""
      }
    </div>
  `;
}

function emptyMark() {
  return `
    <svg class="empty-mark" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="2" width="8" height="11" fill="#2a251f" />
      <rect x="5" y="3" width="6" height="9" fill="#b3552e" />
      <rect x="6" y="4" width="4" height="7" fill="#f3ecdf" />
      <rect x="3" y="13" width="10" height="1" fill="#2a251f" />
    </svg>
  `;
}

function renderEntry(entry, options = {}) {
  const editable = isEditable(entry.date);
  const notes = notesFor(entry.id);
  const activeNotes = notes.filter((note) => !note.orphan);
  const segments = segmentBody(entry.body, activeNotes);
  const bodyHtml = segments
    .map((segment) => {
      if (!segment.ids.length) return esc(segment.text);
      return `<span class="mark" data-ids="${esc(segment.ids.join(" "))}">${esc(segment.text)}</span>`;
    })
    .join("");

  const photoIds = (entry.photos || []).filter((id) => state.photos.has(id));
  const backLabel = state.entryFrom === "calendar" ? "字历" : state.entryFrom === "today" ? "今天" : "册页";
  const photosHtml = photoIds.length
    ? `
      <div class="photo-grid" data-count="${photoIds.length}">
        ${photoIds
          .map(
            (id, index) => `
          <button class="photo-frame" type="button" data-action="lightbox" data-photo="${esc(id)}" data-entry="${esc(entry.id)}" aria-label="查看第 ${index + 1} 张照片">
            <img src="${photoUrl(id)}" alt="这一页的第 ${index + 1} 张照片" loading="lazy" />
            <span class="photo-num">${String(index + 1).padStart(2, "0")}</span>
          </button>`
          )
          .join("")}
      </div>`
    : "";

  return `
    <article class="entry">
      <aside class="entry-rail">
        <div>
          <div class="rail-date">${esc(formatMonthDay(entry.date))}</div>
          <div class="rail-week">${esc(weekdayCN(entry.date))}</div>
        </div>
        <div class="rail-word">${esc(entry.word)}</div>
        <div class="rail-word-label">今日之字</div>
        <div class="rail-author">${esc(entry.author || "我")} 记</div>
      </aside>
      <div class="entry-main">
        ${
          options.back
            ? `<div style="margin-bottom:18px"><button class="btn btn-ghost btn-sm" type="button" data-action="back">← 回到${backLabel}</button></div>`
            : ""
        }
        <header class="entry-head">
          <span class="time-badge" style="--tf:${timeColor(entry)}">${esc(timeLabelOf(entry))}</span>
          <span class="entry-meta">${esc(formatFullDate(entry.date))} · ${esc(weekdayCN(entry.date))}</span>
          <span class="entry-state ${editable ? "is-open" : ""}">${editable ? "今日可改" : "已封存"}</span>
        </header>
        ${
          entry.body
            ? `<div class="entry-body" id="entry-body">${bodyHtml}</div>`
            : ""
        }
        ${photosHtml}
        <div class="entry-tools">
          <span class="hint">${entry.body ? "选中正文里的一句话，写旁注" : "这一页只留下照片"}</span>
          <div class="entry-actions">
            ${editable ? `<button class="btn btn-sm" type="button" data-action="edit-entry" data-id="${esc(entry.id)}">编辑这一页</button>` : ""}
          </div>
        </div>
        ${
          notes.length
            ? `
          <section class="notes">
            <div class="notes-head"><span>旁注</span><span class="notes-count">${notes.length}</span></div>
            ${notes
              .map(
                (note) => `
              <div class="note ${note.orphan ? "is-orphan" : ""}" data-note-id="${esc(note.id)}" tabindex="0">
                <div class="note-quote">「${esc(note.quote)}」</div>
                <div class="note-text">${esc(note.note)}</div>
                <div class="note-meta">${esc(state.settings.penName || "我")} · ${esc(timeLabel(note.createdAt))}${note.orphan ? " · 原文已改" : ""}</div>
              </div>`
              )
              .join("")}
          </section>`
            : ""
        }
      </div>
    </article>
  `;
}

function renderLog() {
  const groups = new Map();
  for (const entry of state.entries) {
    const month = entry.date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(entry);
  }

  const rows = [...groups.entries()]
    .map(
      ([month, entries]) => `
      <div class="log-month">${esc(monthKeyLabel(month))}</div>
      ${entries
        .map((entry) => {
          const noteCount = state.annotations.filter((annotation) => annotation.entryId === entry.id).length;
          const firstPhoto = (entry.photos || []).find((id) => state.photos.has(id));
          return `
            <button class="log-row" type="button" data-action="open-entry" data-id="${esc(entry.id)}" data-from="log">
              <span class="log-date">${esc(entry.date.slice(5, 7))}月<span class="log-day">${esc(String(Number(entry.date.slice(8, 10))))}</span></span>
              <span class="log-word">${esc(entry.word)}</span>
              <span class="log-body">
                <span class="log-preview">${esc(previewText(entry))}</span>
                <span class="log-sub">
                  <i class="dot" style="--tf:${timeColor(entry)}"></i>
                  <span>${esc(timeLabelOf(entry))}</span>
                  <span>·</span>
                  <span>${esc(entry.author || "我")}</span>
                </span>
              </span>
              <span class="log-side">
                ${firstPhoto ? `<img class="log-thumb" src="${photoUrl(firstPhoto)}" alt="" loading="lazy" />` : ""}
                ${noteCount ? `<span class="log-ann">${noteCount}</span>` : ""}
              </span>
            </button>`;
        })
        .join("")}
    `
    )
    .join("");

  return `
    <div class="page-title">
      <h1>册页</h1>
      <p>${state.entries.length} 页</p>
      <span class="spacer"></span>
      <button class="btn btn-primary btn-sm" type="button" data-action="compose">写一页</button>
    </div>
    ${state.entries.length ? rows : `<section class="empty">${emptyMark()}<h1>册页还是空的</h1><p>写下第一页，之后它会自己排在这里。</p><div class="empty-actions"><button class="btn btn-primary" type="button" data-action="compose">写今天</button></div></section>`}
  `;
}

function monthKeyLabel(month) {
  const [year, monthNumber] = month.split("-");
  return `${year}年${Number(monthNumber)}月`;
}

function renderCalendar() {
  const year = state.calMonth.getFullYear();
  const monthIndex = state.calMonth.getMonth();
  const cells = monthCells(year, monthIndex);
  const entryMap = new Map(state.entries.map((entry) => [entry.date, entry]));
  const monthLabel = formatMonthYear(dateKey(state.calMonth));

  const cellsHtml = cells
    .map((cell) => {
      if (!cell) return `<span class="cal-cell is-empty" aria-hidden="true"></span>`;
      const entry = entryMap.get(cell.key);
      if (!entry) {
        return `<span class="cal-cell is-empty"><span class="cal-day">${cell.day}</span></span>`;
      }
      return `
        <button class="cal-cell has-entry" type="button" data-action="open-entry" data-id="${esc(entry.id)}" data-from="calendar" style="--tf:${timeColor(entry)}" aria-label="${esc(cell.key)} ${esc(entry.word)}">
          <span class="cal-day">${cell.day}</span>
          <span class="cal-word">${esc(entry.word)}</span>
          ${(entry.photos || []).length ? `<i class="cal-photo" aria-hidden="true"></i>` : ""}
          <span class="cal-bar"></span>
        </button>`;
    })
    .join("");

  return `
    <div class="page-title">
      <h1>字历</h1>
      <p>每天一个字</p>
      <span class="spacer"></span>
      <div class="cal-nav">
        <button class="btn btn-sm" type="button" data-action="cal-prev" aria-label="上个月">←</button>
        <span class="cal-month">${esc(monthLabel)}</span>
        <button class="btn btn-sm" type="button" data-action="cal-next" aria-label="下个月">→</button>
      </div>
    </div>
    <div class="cal-week">
      ${["日", "一", "二", "三", "四", "五", "六"].map((day) => `<span>${day}</span>`).join("")}
    </div>
    <div class="cal-grid">${cellsHtml}</div>
    <div class="cal-legend">
      ${TIME_FEELS.map((item) => `<span style="--tf:${item.color}"><i></i>${item.label}</span>`).join("")}
    </div>
  `;
}

function renderEmptyState() {
  return `<section class="empty">${emptyMark()}<h1>这一页找不到了</h1><p>它可能被清空了。回到今天，重新写一页吧。</p><div class="empty-actions"><button class="btn btn-primary" type="button" data-action="nav" data-view="today">回到今天</button></div></section>`;
}

/* ── modals ────────────────────────────────────────────── */

function renderModal() {
  if (!state.modal) {
    modalRoot.innerHTML = "";
    return;
  }

  if (state.modal.type === "composer") {
    modalRoot.innerHTML = renderComposer();
    return;
  }

  if (state.modal.type === "annotation") {
    modalRoot.innerHTML = renderAnnotationModal();
    return;
  }

  if (state.modal.type === "settings") {
    modalRoot.innerHTML = renderSettings();
    return;
  }

  if (state.modal.type === "confirm") {
    modalRoot.innerHTML = renderConfirm();
    return;
  }

  if (state.modal.type === "lightbox") {
    modalRoot.innerHTML = renderLightbox();
  }
}

function sheetHead(title, subtitle) {
  return `
    <div class="sheet-head">
      <div>
        <h2>${esc(title)}</h2>
        ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
      </div>
      <button class="sheet-close" type="button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
  `;
}

function renderComposer() {
  const draft = state.draft;
  const editing = Boolean(state.modal.entryId);
  const photoItems = draft.photos
    .map((photo) => {
      const url = photo.new ? photo.url : photoUrl(photo.id);
      if (!url) return "";
      return `
        <div class="photo-tile">
          <img src="${url}" alt="" />
          <button class="photo-remove" type="button" data-action="remove-photo" data-photo="${esc(photo.id)}" aria-label="移除照片">×</button>
        </div>`;
    })
    .join("");

  return `
    <div class="modal" data-modal="composer">
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        ${sheetHead(editing ? "编辑这一页" : "写一页", "一天一页 · 隔夜封存")}
        <div class="sheet-body">
          ${state.modal.error ? `<p class="form-error">${esc(state.modal.error)}</p>` : ""}
          <div class="field">
            <div class="field-label">日期 <em id="date-hint"></em></div>
            <input class="input input-date" type="date" name="date" value="${esc(draft.date)}" max="${todayKey()}" />
          </div>
          <div class="field">
            <div class="field-label">这段时间的感觉</div>
            <div class="time-swatches" id="time-swatches">
              ${TIME_FEELS.map(
                (item) => `
                <button class="swatch ${draft.time === item.key ? "is-active" : ""}" type="button" data-action="pick-time" data-time="${item.key}" style="--tf:${item.color}">
                  <i></i>${item.label}
                </button>`
              ).join("")}
            </div>
          </div>
          <div class="field">
            <div class="field-label">今日之字 <em>一个字，或一个短词</em></div>
            <div class="word-row">
              <input class="input input-word" type="text" name="word" value="${esc(draft.word)}" maxlength="6" placeholder="缓" />
              <span class="word-hint">它会出现在字历里。</span>
            </div>
          </div>
          <div class="field">
            <div class="field-label">正文 <em>可以留空，只放照片</em></div>
            <textarea class="textarea" name="body" maxlength="${MAX_BODY}" placeholder="今天发生了什么？">${esc(draft.body)}</textarea>
          </div>
          <div class="field">
            <div class="field-label">照片 <em>${draft.photos.length} / ${MAX_PHOTOS} · 自动压缩后保存在本机</em></div>
            <div class="photo-picker" id="photo-picker">
              ${photoItems}
              ${
                state.processingPhotos
                  ? `<div class="photo-tile" style="display:grid;place-items:center;font-size:10px;color:var(--muted)">处理中…</div>`
                  : ""
              }
              ${
                draft.photos.length < MAX_PHOTOS
                  ? `
                <button class="photo-add" type="button" data-action="add-photo"><span>＋</span>选照片</button>
                <button class="photo-add" type="button" data-action="take-photo"><span>◎</span>拍一张</button>`
                  : ""
              }
            </div>
            <input id="photo-input" type="file" accept="image/*" multiple hidden />
            <input id="camera-input" type="file" accept="image/*" capture="environment" hidden />
          </div>
        </div>
        <div class="sheet-actions">
          <button class="btn btn-ghost" type="button" data-action="close-modal">先不写</button>
          <button class="btn btn-primary" type="button" data-action="save-entry">${editing ? "保存修改" : "收进柜子"}</button>
        </div>
      </div>
    </div>
  `;
}

function renderAnnotationModal() {
  const modal = state.modal;
  return `
    <div class="modal" data-modal="annotation">
      <div class="sheet sheet-narrow" role="dialog" aria-modal="true" aria-labelledby="annotation-title">
        ${sheetHead("写一条旁注", "它只附着在这句话旁边")}
        <div class="sheet-body">
          ${modal.error ? `<p class="form-error">${esc(modal.error)}</p>` : ""}
          <div class="note-quote" style="margin-bottom:16px">「${esc(modal.quote)}」</div>
          <textarea class="textarea" id="annotation-note" style="min-height:130px" maxlength="2000" placeholder="你此刻想到了什么？"></textarea>
        </div>
        <div class="sheet-actions">
          <button class="btn btn-ghost" type="button" data-action="close-modal">取消</button>
          <button class="btn btn-primary" type="button" data-action="save-annotation">留下旁注</button>
        </div>
      </div>
    </div>
  `;
}

function renderConfirm() {
  const modal = state.modal;
  return `
    <div class="modal" data-modal="confirm">
      <div class="sheet sheet-narrow" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        ${sheetHead(modal.title, "")}
        <div class="sheet-body">
          <p style="margin:0;font-size:14px;line-height:1.9;color:var(--ink-soft)">${esc(modal.message)}</p>
        </div>
        <div class="sheet-actions">
          <button class="btn btn-ghost" type="button" data-action="close-modal">再想想</button>
          <button class="btn btn-danger" type="button" data-action="confirm-action">${esc(modal.confirmLabel || "确定")}</button>
        </div>
      </div>
    </div>
  `;
}

function renderLightbox() {
  const modal = state.modal;
  const entry = byId(modal.entryId);
  const photos = (entry?.photos || []).filter((id) => state.photos.has(id));
  const index = Math.max(0, photos.findIndex((id) => id === modal.photoId));
  const photoId = photos[index] || modal.photoId;
  return `
    <div class="lightbox" data-modal="lightbox">
      <button class="lightbox-close" type="button" data-action="close-modal" aria-label="关闭">×</button>
      <img src="${photoUrl(photoId)}" alt="这一页的照片" />
      ${photos.length > 1 ? `<span class="lightbox-count">${index + 1} / ${photos.length}</span>` : ""}
    </div>
  `;
}

function renderSettings() {
  const entryCount = state.entries.length;
  const used = usedPhotoIds();
  const activePhotos = [...state.photos.values()].filter((photo) => used.has(photo.id));
  const photoCount = activePhotos.length;
  const bytes = activePhotos.reduce((total, photo) => total + photoSize(photo), 0);
  const quota = state.usage.quota || 0;
  const percent = quota ? Math.min(100, Math.round((bytes / quota) * 1000) / 10) : 0;

  return `
    <div class="modal" data-modal="settings">
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        ${sheetHead("设置", "这本册子只属于这台设备")}
        <div class="sheet-body">
          <section class="settings-section">
            <h3>称呼</h3>
            <p>册子的名字和写旁注时的署名。</p>
            <div class="settings-grid">
              <label class="field" style="margin:0">
                <span class="field-label">册子名字</span>
                <input class="input" type="text" name="signature" maxlength="12" value="${esc(state.settings.signature)}" />
              </label>
              <label class="field" style="margin:0">
                <span class="field-label">署名</span>
                <input class="input" type="text" name="penName" maxlength="12" value="${esc(state.settings.penName)}" />
              </label>
            </div>
          </section>

          <section class="settings-section">
            <h3>这本册子</h3>
            <div class="storage-line"><span>页数</span><strong>${entryCount} 页</strong></div>
            <div class="storage-line"><span>照片</span><strong>${photoCount} 张 · ${formatBytes(bytes)}</strong></div>
            <div class="storage-line"><span>浏览器占用</span><strong>${state.usage.used ? formatBytes(state.usage.used) : "—"}</strong></div>
            ${quota ? `<div class="storage-bar"><i style="width:${percent}%"></i></div>` : ""}
          </section>

          <section class="settings-section">
            <h3>备份与迁移</h3>
            <p>导出一个 JSON 文件，里面包含文字、旁注和照片。换浏览器或清缓存之前，记得先备份。</p>
            <div class="settings-actions">
              <button class="btn btn-sm" type="button" data-action="export">导出全部</button>
              <button class="btn btn-sm" type="button" data-action="import">导入备份</button>
              <input id="import-input" type="file" accept="application/json,.json" hidden />
            </div>
          </section>

          <section class="settings-section">
            <h3>清空</h3>
            <p>删除这台设备上的全部日记、旁注和照片。导出的文件不会被删除。</p>
            <button class="btn btn-danger btn-sm" type="button" data-action="clear-all">清空这本册子</button>
          </section>

          <section class="settings-section">
            <h3>关于</h3>
            <p>余温是一个本地优先的日记本。没有账号，没有服务器，没有上传。照片会在浏览器里压缩到最长边 1600 像素，再存进 IndexedDB。清除浏览器数据会一起清掉，请定期导出备份。</p>
          </section>
        </div>
        <div class="sheet-actions">
          <button class="btn btn-ghost" type="button" data-action="close-modal">关闭</button>
          <button class="btn btn-primary" type="button" data-action="save-settings">保存称呼</button>
        </div>
      </div>
    </div>
  `;
}

/* ── composer ──────────────────────────────────────────── */

function openComposer(entry = null, intent = "text") {
  if (entry && !isEditable(entry.date)) {
    showToast("这一页已经封存，不能再改了", "error");
    return;
  }

  if (entry) {
    state.entryFrom = state.view === "entry" ? state.entryFrom : "today";
    state.draft = {
      entryId: entry.id,
      date: entry.date,
      time: entry.time,
      word: entry.word,
      body: entry.body,
      photos: (entry.photos || [])
        .filter((id) => state.photos.has(id))
        .map((id) => ({ id, new: false })),
      removedIds: []
    };
  } else {
    state.entryFrom = "today";
    state.draft = {
      entryId: null,
      date: todayKey(),
      time: guessTime(),
      word: "",
      body: "",
      photos: [],
      removedIds: []
    };
  }

  state.modal = { type: "composer", entryId: state.draft.entryId, error: "" };
  state.processingPhotos = false;
  renderModal();
  updateDateHint();

  if (intent === "photo") {
    document.getElementById("camera-input")?.click();
  } else {
    const body = document.querySelector('#modal-root textarea[name="body"]');
    if (body) {
      body.focus();
      body.setSelectionRange(body.value.length, body.value.length);
    }
  }
}

function updateDateHint() {
  const hint = document.getElementById("date-hint");
  if (!hint || !state.draft) return;
  const existing = byDate(state.draft.date);
  if (existing && existing.id !== state.draft.entryId) {
    hint.textContent = "这一天已经有记录了";
    hint.style.color = "var(--ember)";
  } else if (isEditable(state.draft.date)) {
    hint.textContent = "今天 · 可以修改";
    hint.style.color = "var(--sage)";
  } else {
    hint.textContent = "保存后会封存";
    hint.style.color = "var(--faint)";
  }
}

function syncDraftFromForm() {
  const root = modalRoot.querySelector('[data-modal="composer"]');
  if (!root || !state.draft) return;
  state.draft.date = root.querySelector('input[name="date"]').value;
  state.draft.word = root.querySelector('input[name="word"]').value;
  state.draft.body = root.querySelector('textarea[name="body"]').value;
}

async function saveEntry() {
  if (!state.draft) return;
  if (state.processingPhotos) {
    setModalError("照片还在处理中，稍等一下再收进柜子。");
    return;
  }
  syncDraftFromForm();
  const draft = state.draft;
  const editing = draft.entryId ? byId(draft.entryId) : null;
  const existing = byDate(draft.date);

  if (editing && !isEditable(editing.date)) {
    setModalError("这一页已经封存，不能再改了。");
    return;
  }
  if (existing && (!editing || existing.id !== editing.id)) {
    setModalError("这一天已经有记录了。一天只留一页。");
    return;
  }

  const checked = validateEntry(
    {
      ...draft,
      author: editing?.author || state.settings.penName || "我"
    },
    { today: todayKey() }
  );

  if (!checked.ok) {
    setModalError(checked.errors[0]);
    return;
  }

  const now = new Date().toISOString();
  const entry = {
    id: editing?.id || uid("entry"),
    date: checked.value.date,
    time: checked.value.time,
    word: checked.value.word,
    body: checked.value.body,
    photos: draft.photos.map((photo) => photo.id),
    author: checked.value.author,
    createdAt: editing?.createdAt || now,
    updatedAt: now
  };

  const newPhotoRecords = draft.photos
    .filter((photo) => photo.new)
    .map((photo) => ({
      id: photo.id,
      blob: photo.blob,
      type: photo.type,
      width: photo.width,
      height: photo.height,
      name: photo.name || "photo",
      createdAt: photo.createdAt || now
    }));

  try {
    if (state.storageOk) {
      await db.putEntry(entry, newPhotoRecords, draft.removedIds);
    }

    if (state.storageOk && editing && editing.body !== entry.body) {
      const notes = state.annotations.filter((annotation) => annotation.entryId === editing.id);
      const repaired = remapAnnotations(notes, editing.body, entry.body);
      if (notes.length) {
        await db.putMany("annotations", repaired);
        const repairedMap = new Map(repaired.map((note) => [note.id, note]));
        state.annotations = state.annotations.map((note) => repairedMap.get(note.id) || note);
      }
    }

    state.entries = sortEntries([...state.entries.filter((item) => item.id !== entry.id && item.date !== entry.date), entry]);
    for (const photo of newPhotoRecords) state.photos.set(photo.id, photo);
    for (const photoId of draft.removedIds) {
      state.photos.delete(photoId);
      revokePhotoUrl(photoId);
    }

    state.draft = null;
    state.modal = null;
    renderModal();
    state.entryFrom = state.entryFrom || "today";
    routeTo(`#/entry/${encodeURIComponent(entry.id)}`);
    showToast("这一页收好了");
  } catch (error) {
    setModalError(friendlyStorageError(error));
  }
}

function setModalError(message) {
  if (!state.modal) return;
  state.modal.error = message;
  const current = modalRoot.querySelector(".form-error");
  if (current) {
    current.textContent = message;
  } else {
    renderModal();
  }
}

/* ── photos in composer ────────────────────────────────── */

async function addPhotos(fileList) {
  if (!state.draft) return;
  const room = MAX_PHOTOS - state.draft.photos.length;
  if (room <= 0) {
    showToast(`一页最多放 ${MAX_PHOTOS} 张照片`, "error");
    return;
  }

  const files = [...fileList].filter(isImageFile).slice(0, room);
  if (!files.length) {
    showToast("没有找到可以用的图片", "error");
    return;
  }

  state.processingPhotos = true;
  renderPhotoPicker();

  for (const file of files) {
    try {
      const compressed = await compressPhoto(file);
      if (!state.draft) return;
      const record = makePhoto(compressed);
      state.draft.photos.push({
        ...record,
        new: true,
        url: URL.createObjectURL(record.blob)
      });
    } catch (error) {
      showToast(error.message || "这张照片没有加上", "error");
    }
  }

  state.processingPhotos = false;
  renderPhotoPicker();
}

function renderPhotoPicker() {
  const picker = document.getElementById("photo-picker");
  if (!picker || !state.draft) return;
  const draft = state.draft;
  picker.innerHTML = `
    ${draft.photos
      .map((photo) => {
        const url = photo.new ? photo.url : photoUrl(photo.id);
        if (!url) return "";
        return `
          <div class="photo-tile">
            <img src="${url}" alt="" />
            <button class="photo-remove" type="button" data-action="remove-photo" data-photo="${esc(photo.id)}" aria-label="移除照片">×</button>
          </div>`;
      })
      .join("")}
    ${
      state.processingPhotos
        ? `<div class="photo-tile" style="display:grid;place-items:center;font-size:10px;color:var(--muted)">处理中…</div>`
        : ""
    }
    ${
      draft.photos.length < MAX_PHOTOS
        ? `<button class="photo-add" type="button" data-action="add-photo"><span>＋</span>选照片</button>
           <button class="photo-add" type="button" data-action="take-photo"><span>◎</span>拍一张</button>`
        : ""
    }
  `;
}

function removePhoto(photoId) {
  if (!state.draft) return;
  const photo = state.draft.photos.find((item) => item.id === photoId);
  if (!photo) return;
  if (photo.new) {
    if (photo.url) URL.revokeObjectURL(photo.url);
  } else {
    state.draft.removedIds.push(photo.id);
  }
  state.draft.photos = state.draft.photos.filter((item) => item.id !== photoId);
  renderPhotoPicker();
}

/* ── annotations ───────────────────────────────────────── */

function selectionOffsets(bodyElement, bodyText) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!bodyElement.contains(range.commonAncestorContainer)) return null;

  const before = range.cloneRange();
  before.selectNodeContents(bodyElement);
  before.setEnd(range.startContainer, range.startOffset);
  let start = before.toString().length;
  let text = range.toString();
  let end = start + text.length;

  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  start += lead;
  end -= trail;
  text = text.slice(lead, text.length - trail);

  if (text.length < 2) return null;
  if (bodyText.slice(start, end) !== text) {
    const fallback = bodyText.indexOf(text);
    if (fallback < 0) return null;
    start = fallback;
    end = fallback + text.length;
  }

  return { quote: text, start, end };
}

function updateSelectionPill() {
  if (state.modal) {
    hideSelectionPill();
    return;
  }
  const entry = currentEntry();
  const bodyElement = document.getElementById("entry-body");
  if (!entry || !bodyElement) {
    hideSelectionPill();
    return;
  }

  const offsets = selectionOffsets(bodyElement, entry.body);
  if (!offsets) {
    hideSelectionPill();
    return;
  }

  state.selection = { ...offsets, entryId: entry.id };
  pill.innerHTML = `
    <span class="pill-quote">「${esc(offsets.quote.length > 26 ? `${offsets.quote.slice(0, 26)}…` : offsets.quote)}」</span>
    <button class="btn" type="button" data-action="annotate-selection">写旁注</button>
  `;
  pill.hidden = false;
}

function hideSelectionPill() {
  pill.hidden = true;
  pill.innerHTML = "";
  state.selection = null;
}

function openAnnotation() {
  if (!state.selection) return;
  state.modal = {
    type: "annotation",
    entryId: state.selection.entryId,
    quote: state.selection.quote,
    start: state.selection.start,
    end: state.selection.end,
    error: ""
  };
  renderModal();
  document.getElementById("annotation-note")?.focus();
}

async function saveAnnotation() {
  const modal = state.modal;
  if (!modal || modal.type !== "annotation") return;
  const entry = byId(modal.entryId);
  const textarea = document.getElementById("annotation-note");
  const note = textarea?.value || "";

  const checked = validateAnnotation(
    {
      entryId: modal.entryId,
      quote: modal.quote,
      start: modal.start,
      end: modal.end,
      note
    },
    entry
  );

  if (!checked.ok) {
    modal.error = checked.errors[0];
    renderModal();
    document.getElementById("annotation-note").value = note;
    return;
  }

  const annotation = {
    id: uid("note"),
    ...checked.value,
    createdAt: new Date().toISOString(),
    orphan: false
  };

  try {
    if (state.storageOk) await db.putAnnotation(annotation);
    state.annotations.push(annotation);
    state.annotations = sortAnnotations(state.annotations);
    state.modal = null;
    renderModal();
    hideSelectionPill();
    window.getSelection()?.removeAllRanges();
    render();
    showToast("旁注留下了");
  } catch (error) {
    modal.error = friendlyStorageError(error);
    renderModal();
    document.getElementById("annotation-note").value = note;
  }
}

/* ── settings / data ───────────────────────────────────── */

async function openSettings() {
  state.modal = { type: "settings" };
  state.usage = await db.usage().catch(() => ({ used: 0, quota: 0 }));
  renderModal();
}

function saveSettings() {
  const root = modalRoot.querySelector('[data-modal="settings"]');
  if (!root) return;
  const signature = root.querySelector('input[name="signature"]').value.trim() || "余温";
  const penName = root.querySelector('input[name="penName"]').value.trim() || "我";
  state.settings = { signature, penName };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // Settings are cosmetic; ignore storage failures.
  }
  updateBrand();
  closeModal();
  render();
  showToast("称呼已保存");
}

function usedPhotoIds() {
  return new Set(state.entries.flatMap((entry) => entry.photos || []));
}

async function exportEverything() {
  showToast("正在打包，照片多的话会慢一点");
  try {
    const used = usedPhotoIds();
    const photoPayload = [];
    for (const [id, photo] of state.photos) {
      if (!used.has(id) || !photo.blob) continue;
      photoPayload.push({
        id,
        type: photo.type || photo.blob.type,
        dataUrl: await blobToDataUrl(photo.blob)
      });
    }

    const payload = {
      app: "afterglow",
      version: 1,
      exportedAt: new Date().toISOString(),
      signature: state.settings.signature,
      entries: state.entries,
      annotations: state.annotations,
      photos: photoPayload
    };

    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `余温备份-${todayKey()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast(`已导出 ${state.entries.length} 页、${photoPayload.length} 张照片`);
  } catch (error) {
    showToast(error.message || "导出失败", "error");
  }
}

function openImportPicker() {
  document.getElementById("import-input")?.click();
}

async function importFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const incoming = normalizeImport(payload);
    if (!incoming.entries.length) throw new Error("这个文件里没有找到日记");

    const merged = mergeData(
      { entries: state.entries, annotations: state.annotations },
      incoming
    );

    const newPhotos = [];
    for (const item of incoming.photos) {
      try {
        const blob = dataUrlToBlob(item.dataUrl);
        newPhotos.push({
          id: item.id,
          blob,
          type: item.type || blob.type,
          name: "imported",
          createdAt: new Date().toISOString()
        });
      } catch {
        // A broken photo should not block the rest of the import.
      }
    }

    if (state.storageOk) {
      await db.replaceData(merged.data.entries, merged.data.annotations, newPhotos);
    }

    for (const photo of newPhotos) state.photos.set(photo.id, photo);
    state.entries = sortEntries(merged.data.entries);
    state.annotations = sortAnnotations(merged.data.annotations);
    localStorage.setItem(SEEDED_KEY, "1");
    closeModal();
    render();
    showToast(
      `导入完成：${merged.stats.added} 页新增，${merged.stats.updated} 页更新，${merged.stats.notesAdded} 条旁注`
    );
  } catch (error) {
    showToast(
      error?.name === "SyntaxError" ? "导入失败，请确认文件是余温导出的 JSON。" : friendlyStorageError(error),
      "error"
    );
  }
}

function askClearAll() {
  state.modal = {
    type: "confirm",
    title: "清空这本册子？",
    message: "这台设备上的全部日记、旁注和照片都会被删除，无法恢复。已经导出的备份文件不受影响。",
    confirmLabel: "确定清空",
    action: "clear"
  };
  renderModal();
}

async function clearAll() {
  try {
    if (state.storageOk) await db.clearEverything();
    for (const id of [...state.photoUrls.keys()]) revokePhotoUrl(id);
    state.entries = [];
    state.annotations = [];
    state.photos.clear();
    state.photoUrls.clear();
    localStorage.setItem(SEEDED_KEY, "1");
    state.modal = null;
    renderModal();
    navigate("today");
    showToast("册子已经清空");
  } catch (error) {
    showToast(friendlyStorageError(error), "error");
  }
}

/* ── modal helpers ─────────────────────────────────────── */

function closeModal(options = {}) {
  if (state.draft) {
    for (const photo of state.draft.photos) {
      if (photo.new && photo.url) URL.revokeObjectURL(photo.url);
    }
  }
  state.draft = null;
  state.processingPhotos = false;
  state.modal = null;
  if (!options.silent) renderModal();
}

/* ── events ────────────────────────────────────────────── */

document.addEventListener("click", (event) => {
  const actionElement = event.target.closest("[data-action]");
  if (actionElement) {
    const action = actionElement.dataset.action;

    if (action === "nav") {
      navigate(actionElement.dataset.view);
      return;
    }
    if (action === "compose") {
      openComposer();
      return;
    }
    if (action === "compose-photo") {
      openComposer(null, "photo");
      return;
    }
    if (action === "settings") {
      openSettings();
      return;
    }
    if (action === "open-entry") {
      openEntry(actionElement.dataset.id, actionElement.dataset.from);
      return;
    }
    if (action === "back") {
      navigate(state.entryFrom || "log");
      return;
    }
    if (action === "edit-entry") {
      const entry = byId(actionElement.dataset.id);
      if (entry) openComposer(entry);
      return;
    }
    if (action === "pick-time") {
      if (state.draft) {
        state.draft.time = actionElement.dataset.time;
        modalRoot.querySelectorAll("[data-action='pick-time']").forEach((button) => {
          button.classList.toggle("is-active", button.dataset.time === state.draft.time);
        });
      }
      return;
    }
    if (action === "add-photo") {
      document.getElementById("photo-input")?.click();
      return;
    }
    if (action === "take-photo") {
      document.getElementById("camera-input")?.click();
      return;
    }
    if (action === "remove-photo") {
      removePhoto(actionElement.dataset.photo);
      return;
    }
    if (action === "save-entry") {
      saveEntry();
      return;
    }
    if (action === "annotate-selection") {
      openAnnotation();
      return;
    }
    if (action === "save-annotation") {
      saveAnnotation();
      return;
    }
    if (action === "close-modal") {
      closeModal();
      return;
    }
    if (action === "lightbox") {
      state.modal = {
        type: "lightbox",
        entryId: actionElement.dataset.entry,
        photoId: actionElement.dataset.photo
      };
      renderModal();
      return;
    }
    if (action === "cal-prev" || action === "cal-next") {
      const delta = action === "cal-prev" ? -1 : 1;
      state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + delta, 1);
      renderView();
      return;
    }
    if (action === "export") {
      exportEverything();
      return;
    }
    if (action === "import") {
      openImportPicker();
      return;
    }
    if (action === "clear-all") {
      askClearAll();
      return;
    }
    if (action === "confirm-action") {
      if (state.modal?.action === "clear") clearAll();
      return;
    }
    if (action === "save-settings") {
      saveSettings();
      return;
    }
  }

  const modal = event.target.closest(".modal, .lightbox");
  if (modal && event.target === modal) closeModal();
});

document.addEventListener("input", (event) => {
  if (state.draft && event.target.name === "date") {
    state.draft.date = event.target.value;
    updateDateHint();
  }
  if (state.draft && event.target.name === "word") {
    state.draft.word = event.target.value;
  }
  if (state.draft && event.target.name === "body") {
    state.draft.body = event.target.value;
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "photo-input" || event.target.id === "camera-input") {
    const files = event.target.files;
    addPhotos(files || []);
    event.target.value = "";
  }
  if (event.target.id === "import-input") {
    const file = event.target.files?.[0];
    event.target.value = "";
    importFile(file);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (state.modal) closeModal();
    else hideSelectionPill();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    if (state.modal?.type === "composer") saveEntry();
    if (state.modal?.type === "annotation") saveAnnotation();
  }
});

document.addEventListener("mouseup", (event) => {
  if (event.target.closest("#modal-root")) return;
  window.setTimeout(updateSelectionPill, 0);
});

document.addEventListener("touchend", (event) => {
  if (event.target.closest("#modal-root")) return;
  window.setTimeout(updateSelectionPill, 30);
});

document.addEventListener("selectionchange", () => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    hideSelectionPill();
    return;
  }
  if (state.modal) return;
  window.clearTimeout(document.selectionPillTimer);
  document.selectionPillTimer = window.setTimeout(updateSelectionPill, 120);
});

document.addEventListener(
  "scroll",
  () => {
    if (!pill.hidden) hideSelectionPill();
  },
  true
);

pill.addEventListener("mousedown", (event) => event.preventDefault());

viewEl.addEventListener("pointerover", (event) => {
  const note = event.target.closest(".note");
  if (!note) return;
  const from = event.relatedTarget?.closest?.(".note");
  if (from === note) return;
  document.querySelectorAll(".mark.is-hot").forEach((mark) => mark.classList.remove("is-hot"));
  document.querySelectorAll(`.mark[data-ids~="${CSS.escape(note.dataset.noteId)}"]`).forEach((mark) => {
    mark.classList.add("is-hot");
  });
});

viewEl.addEventListener("pointerout", (event) => {
  const note = event.target.closest(".note");
  if (!note) return;
  const to = event.relatedTarget?.closest?.(".note");
  if (to === note) return;
  document.querySelectorAll(".mark.is-hot").forEach((mark) => mark.classList.remove("is-hot"));
});

viewEl.addEventListener("focusin", (event) => {
  const note = event.target.closest(".note");
  if (!note) return;
  document.querySelectorAll(`.mark[data-ids~="${CSS.escape(note.dataset.noteId)}"]`).forEach((mark) => {
    mark.classList.add("is-hot");
  });
});

viewEl.addEventListener("focusout", () => {
  document.querySelectorAll(".mark.is-hot").forEach((mark) => mark.classList.remove("is-hot"));
});

window.addEventListener("hashchange", () => {
  applyRoute();
  render();
});

window.addEventListener("beforeunload", () => {
  for (const url of state.photoUrls.values()) URL.revokeObjectURL(url);
});

boot();
