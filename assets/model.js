export const TIME_FEELS = [
  { key: "dawn", label: "黎明", color: "#8fa3ad" },
  { key: "morning", label: "清晨", color: "#c9a227" },
  { key: "afternoon", label: "午后", color: "#c1743a" },
  { key: "dusk", label: "黄昏", color: "#a64b35" },
  { key: "night", label: "夜色", color: "#565573" },
  { key: "latenight", label: "深夜", color: "#2f2b38" }
];

export const TIME_MAP = Object.fromEntries(TIME_FEELS.map((item) => [item.key, item]));
export const MAX_PHOTOS = 6;
export const MAX_BODY = 12000;
export const SETTINGS_KEY = "afterglow.settings.v1";
export const SEEDED_KEY = "afterglow.seeded.v1";

export function pad2(value) {
  return String(value).padStart(2, "0");
}

export function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function isValidDateKey(key) {
  return Boolean(parseDateKey(key));
}

export function todayKey(now = new Date()) {
  return dateKey(now);
}

export function addDays(key, amount) {
  const date = parseDateKey(key);
  if (!date) return key;
  date.setDate(date.getDate() + amount);
  return dateKey(date);
}

export function weekdayCN(key) {
  const date = parseDateKey(key);
  if (!date) return "";
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
}

export function formatMonthDay(key) {
  const date = parseDateKey(key);
  if (!date) return "";
  return `${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

export function formatFullDate(key) {
  const date = parseDateKey(key);
  if (!date) return "";
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

export function formatMonthYear(key) {
  const date = parseDateKey(key);
  if (!date) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function monthCells(year, monthIndex) {
  const first = new Date(year, monthIndex, 1, 12);
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first.getDay(); i += 1) cells.push(null);
  for (let day = 1; day <= days; day += 1) {
    cells.push({
      day,
      key: `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`
    });
  }
  return cells;
}

export function isEditable(entryDate, today = todayKey()) {
  return entryDate === today;
}

export function uid(prefix = "id") {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

export function normalizeBody(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function charLength(value) {
  return Array.from(String(value || "")).length;
}

export function entryHasContent(entry) {
  return Boolean(normalizeBody(entry?.body) || (entry?.photos || []).length);
}

export function validateEntry(raw, options = {}) {
  const errors = [];
  const date = String(raw?.date || "").trim();
  const time = String(raw?.time || "").trim();
  const word = String(raw?.word || "").trim();
  const body = normalizeBody(raw?.body);
  const photos = Array.isArray(raw?.photos) ? raw.photos.filter(Boolean) : [];
  const today = options.today || todayKey();

  if (!isValidDateKey(date)) errors.push("日期格式不正确。");
  if (isValidDateKey(date) && date > today) errors.push("还不能写未来的日子。");
  if (!TIME_MAP[time]) errors.push("请选择这段时间的感觉。");
  if (!word) errors.push("留一个字，给这一天。");
  if (charLength(word) > 6) errors.push("每日之字最多六个字。");
  if (charLength(body) > MAX_BODY) errors.push("正文太长了，最多一万两千字。");
  if (!body && photos.length === 0) errors.push("写几句话，或者放一张照片。");
  if (photos.length > MAX_PHOTOS) errors.push(`一页最多放 ${MAX_PHOTOS} 张照片。`);

  return {
    ok: errors.length === 0,
    errors,
    value: {
      date,
      time,
      word,
      body,
      photos,
      author: String(raw?.author || "").trim() || "我"
    }
  };
}

export function validateAnnotation(raw, entry) {
  const errors = [];
  const start = Number(raw?.start);
  const end = Number(raw?.end);
  const note = String(raw?.note || "").trim();
  const quote = String(raw?.quote || "");
  const body = String(entry?.body || "");

  if (!entry) errors.push("这一页不存在。");
  if (!Number.isInteger(start) || !Number.isInteger(end)) errors.push("引用位置无效。");
  if (Number.isInteger(start) && Number.isInteger(end)) {
    if (start < 0 || end > body.length || start >= end) errors.push("引用位置无效。");
    else if (body.slice(start, end) !== quote) errors.push("引用文字和正文对不上，请重新选择。");
  }
  if (!note) errors.push("旁注还是空的。");
  if (charLength(note) > 2000) errors.push("旁注太长了。");

  return {
    ok: errors.length === 0,
    errors,
    value: {
      entryId: entry?.id || "",
      quote,
      start,
      end,
      note
    }
  };
}

export function segmentBody(body, annotations = []) {
  const text = String(body || "");
  const valid = annotations.filter((annotation) => {
    return (
      annotation &&
      Number.isInteger(annotation.start) &&
      Number.isInteger(annotation.end) &&
      annotation.start >= 0 &&
      annotation.end <= text.length &&
      annotation.start < annotation.end
    );
  });

  if (!text) return [];
  if (valid.length === 0) return [{ text, ids: [] }];

  const points = new Set([0, text.length]);
  for (const annotation of valid) {
    points.add(annotation.start);
    points.add(annotation.end);
  }

  const sorted = [...points].sort((a, b) => a - b);
  const segments = [];

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index];
    const end = sorted[index + 1];
    if (end <= start) continue;
    const ids = valid
      .filter((annotation) => annotation.start <= start && annotation.end >= end)
      .map((annotation) => annotation.id);
    const key = ids.join("|");
    const previous = segments[segments.length - 1];
    if (previous && previous.key === key) {
      previous.text += text.slice(start, end);
    } else {
      segments.push({ text: text.slice(start, end), ids, key });
    }
  }

  return segments.map(({ text: segmentText, ids }) => ({ text: segmentText, ids }));
}

export function remapAnnotations(annotations, oldBody, newBody) {
  const body = String(newBody || "");
  return annotations.map((annotation) => {
    const quote = String(annotation.quote || "");
    if (!quote) return { ...annotation, orphan: true };

    const exact = body.slice(annotation.start, annotation.end);
    if (exact === quote) return { ...annotation, orphan: false };

    const found = body.indexOf(quote);
    if (found >= 0) {
      return { ...annotation, start: found, end: found + quote.length, orphan: false };
    }

    return { ...annotation, orphan: true };
  });
}

export function repairAnnotation(annotation, entry) {
  const body = String(entry?.body || "");
  const quote = String(annotation?.quote || "");
  const start = Number(annotation?.start);
  const end = Number(annotation?.end);

  if (quote && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start) {
    if (body.slice(start, end) === quote) {
      return { ...annotation, start, end, orphan: false };
    }
  }

  if (quote) {
    const found = body.indexOf(quote);
    if (found >= 0) {
      return { ...annotation, start: found, end: found + quote.length, orphan: false };
    }
  }

  return { ...annotation, orphan: true };
}

export function normalizeEntry(raw, today = todayKey()) {
  const photos = Array.isArray(raw?.photos) ? raw.photos.filter(Boolean) : [];
  return {
    id: String(raw?.id || uid("entry")),
    date: String(raw?.date || raw?.entry_date || today),
    time: String(raw?.time || raw?.time_of_day || "night"),
    word: String(raw?.word || raw?.word_of_day || "日").slice(0, 12),
    body: normalizeBody(raw?.body),
    photos,
    author: String(raw?.author || "我"),
    createdAt: String(raw?.createdAt || raw?.created_at || new Date().toISOString()),
    updatedAt: String(raw?.updatedAt || raw?.updated_at || raw?.createdAt || new Date().toISOString())
  };
}

export function normalizeAnnotation(raw) {
  return {
    id: String(raw?.id || uid("note")),
    entryId: String(raw?.entryId || raw?.entry_id || ""),
    quote: String(raw?.quote || ""),
    start: Number.isInteger(raw?.start) ? raw.start : Number(raw?.quote_start || 0),
    end: Number.isInteger(raw?.end) ? raw.end : Number(raw?.quote_end || 0),
    note: String(raw?.note || raw?.text || ""),
    createdAt: String(raw?.createdAt || raw?.created_at || new Date().toISOString()),
    orphan: Boolean(raw?.orphan)
  };
}

export function normalizeImport(payload) {
  const entriesSource = Array.isArray(payload) ? payload : payload?.entries || [];
  const annotationsSource = Array.isArray(payload?.annotations) ? payload.annotations : [];
  const photosSource = Array.isArray(payload?.photos) ? payload.photos : [];

  return {
    entries: entriesSource.map((entry) => normalizeEntry(entry)),
    annotations: annotationsSource.map((annotation) => normalizeAnnotation(annotation)).filter((annotation) => annotation.entryId),
    photos: photosSource
      .filter((photo) => photo && photo.id && typeof photo.dataUrl === "string")
      .map((photo) => ({
        id: String(photo.id),
        type: String(photo.type || "image/jpeg"),
        dataUrl: photo.dataUrl
      }))
  };
}

export function mergeData(current, incoming) {
  const entries = new Map((current?.entries || []).map((entry) => [entry.date, entry]));
  const annotations = new Map((current?.annotations || []).map((annotation) => [annotation.id, annotation]));
  let added = 0;
  let updated = 0;

  for (const entry of incoming?.entries || []) {
    if (!isValidDateKey(entry.date) || !entryHasContent(entry)) continue;
    if (entries.has(entry.date)) updated += 1;
    else added += 1;
    entries.set(entry.date, entry);
  }

  const validEntryIds = new Set([...entries.values()].map((entry) => entry.id));
  let notesAdded = 0;

  for (const annotation of incoming?.annotations || []) {
    const entry = [...entries.values()].find((item) => item.id === annotation.entryId);
    if (!entry) continue;
    const repaired = repairAnnotation(annotation, entry);
    if (!annotations.has(repaired.id)) notesAdded += 1;
    annotations.set(repaired.id, repaired);
  }

  const notes = [...annotations.values()].filter((annotation) => validEntryIds.has(annotation.entryId));

  return {
    data: {
      entries: [...entries.values()].sort((a, b) => b.date.localeCompare(a.date)),
      annotations: notes
    },
    stats: { added, updated, notesAdded }
  };
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date));
}

export function sortAnnotations(annotations) {
  return [...annotations].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
