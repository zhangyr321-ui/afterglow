import test from "node:test";
import assert from "node:assert/strict";

import {
  addDays,
  dateKey,
  formatMonthDay,
  mergeData,
  monthCells,
  normalizeImport,
  remapAnnotations,
  segmentBody,
  todayKey,
  validateAnnotation,
  validateEntry,
  weekdayCN
} from "../assets/model.js";

test("date helpers stay on the local calendar day", () => {
  const date = new Date(2026, 0, 1, 0, 30);
  assert.equal(dateKey(date), "2026-01-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(weekdayCN("2026-10-20"), "周二");
  assert.equal(formatMonthDay("2026-10-05"), "10.05");
});

test("monthCells starts on the right weekday", () => {
  const cells = monthCells(2026, 9);
  assert.equal(cells.filter(Boolean).length, 31);
  assert.equal(cells.filter(Boolean)[0].key, "2026-10-01");
});

test("an entry can be text, photos, or both", () => {
  const today = todayKey();
  const text = validateEntry(
    { date: today, time: "night", word: "缓", body: "今天很慢。", photos: [] },
    { today }
  );
  assert.equal(text.ok, true);

  const photoOnly = validateEntry(
    { date: today, time: "dusk", word: "光", body: "", photos: ["photo-1"] },
    { today }
  );
  assert.equal(photoOnly.ok, true);

  const empty = validateEntry(
    { date: today, time: "dusk", word: "光", body: "   ", photos: [] },
    { today }
  );
  assert.equal(empty.ok, false);
});

test("future entries and unknown time feels are rejected", () => {
  const today = todayKey();
  const result = validateEntry(
    { date: addDays(today, 1), time: "tomorrow", word: "", body: "x" },
    { today }
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
});

test("photo count is capped", () => {
  const result = validateEntry(
    {
      date: todayKey(),
      time: "morning",
      word: "满",
      body: "",
      photos: ["1", "2", "3", "4", "5", "6", "7"]
    },
    { today: todayKey() }
  );
  assert.equal(result.ok, false);
});

test("segments handle repeated text and overlapping notes", () => {
  const body = "abcabc";
  const segments = segmentBody(body, [
    { id: "a", start: 0, end: 4 },
    { id: "b", start: 2, end: 6 }
  ]);

  assert.deepEqual(
    segments.map((segment) => [segment.text, segment.ids]),
    [
      ["ab", ["a"]],
      ["ca", ["a", "b"]],
      ["bc", ["b"]]
    ]
  );

  const adjacent = segmentBody(body, [
    { id: "a", start: 0, end: 3 },
    { id: "b", start: 3, end: 6 }
  ]);
  assert.equal(adjacent.length, 2);
});

test("annotation validation checks the quote against the body", () => {
  const entry = { id: "e1", body: "风把桌上的纸吹起一角" };
  const ok = validateAnnotation(
    { entryId: "e1", quote: "桌上的纸", start: 2, end: 6, note: "想起窗台" },
    entry
  );
  assert.equal(ok.ok, true);

  const bad = validateAnnotation(
    { entryId: "e1", quote: "桌上的纸", start: 0, end: 4, note: "想起窗台" },
    entry
  );
  assert.equal(bad.ok, false);
});

test("editing a body remaps surviving notes and marks lost ones", () => {
  const notes = [
    { id: "a", quote: "world", start: 6, end: 11 },
    { id: "b", quote: "gone", start: 0, end: 4 }
  ];
  const result = remapAnnotations(notes, "hello world", "well hello world");
  assert.equal(result[0].start, 11);
  assert.equal(result[0].orphan, false);
  assert.equal(result[1].orphan, true);
});

test("Ember exports can be imported and their offsets repaired", () => {
  const incoming = normalizeImport({
    entries: [
      {
        id: "e1",
        entry_date: "2026-10-19",
        time_of_day: "night",
        word_of_day: "缓",
        body: "有些日子不是被记住的，是被夹在什么地方。"
      }
    ],
    annotations: [
      {
        id: "a1",
        entry_id: "e1",
        quote: "被夹在什么地方",
        quote_start: 0,
        quote_end: 0,
        note: "像一张旧车票。"
      }
    ]
  });

  const merged = mergeData({ entries: [], annotations: [] }, incoming);
  const note = merged.data.annotations[0];
  assert.equal(note.orphan, false);
  assert.equal(note.start, 12);
  assert.equal(note.end, 19);
  assert.equal(merged.stats.added, 1);
  assert.equal(merged.stats.notesAdded, 1);
});

test("merging by date replaces the page instead of duplicating it", () => {
  const current = {
    entries: [{ id: "e1", date: "2026-10-19", body: "old", photos: [] }],
    annotations: []
  };
  const incoming = normalizeImport({
    entries: [{ id: "e2", date: "2026-10-19", body: "new", photos: [] }]
  });
  const merged = mergeData(current, incoming);
  assert.equal(merged.data.entries.length, 1);
  assert.equal(merged.data.entries[0].id, "e2");
  assert.equal(merged.stats.updated, 1);
});
