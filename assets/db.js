const DB_NAME = "afterglow-diary";
const DB_VERSION = 1;
let databasePromise = null;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB 操作失败"));
  });
}

export function openDb() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不支持本地数据库"));
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error("本地数据库响应超时"));
    }, 2200);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries")) {
        const store = db.createObjectStore("entries", { keyPath: "id" });
        store.createIndex("date", "date", { unique: true });
      }
      if (!db.objectStoreNames.contains("annotations")) {
        const store = db.createObjectStore("annotations", { keyPath: "id" });
        store.createIndex("entryId", "entryId", { unique: false });
      }
      if (!db.objectStoreNames.contains("photos")) {
        db.createObjectStore("photos", { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error || new Error("无法打开本地数据库"));
    };
    request.onblocked = () => {
      clearTimeout(timer);
      reject(new Error("本地数据库被其他页面占用"));
    };
  });
  return databasePromise;
}

async function withStore(storeName, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;

    try {
      result = action(store);
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("本地数据库写入失败"));
    transaction.onabort = () => reject(transaction.error || new Error("本地数据库写入已取消"));
  });
}

export async function getAll(storeName) {
  const db = await openDb();
  const transaction = db.transaction(storeName, "readonly");
  return requestResult(transaction.objectStore(storeName).getAll());
}

export async function getOne(storeName, key) {
  const db = await openDb();
  const transaction = db.transaction(storeName, "readonly");
  return requestResult(transaction.objectStore(storeName).get(key));
}

export function putOne(storeName, value) {
  return withStore(storeName, "readwrite", (store) => store.put(value));
}

export function putMany(storeName, values) {
  return withStore(storeName, "readwrite", (store) => {
    for (const value of values) store.put(value);
  });
}

export function deleteOne(storeName, key) {
  return withStore(storeName, "readwrite", (store) => store.delete(key));
}

export function deleteMany(storeName, keys) {
  return withStore(storeName, "readwrite", (store) => {
    for (const key of keys) store.delete(key);
  });
}

export async function putEntry(entry, newPhotos = [], removedPhotoIds = []) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["entries", "photos"], "readwrite");
    transaction.objectStore("entries").put(entry);
    for (const photo of newPhotos) transaction.objectStore("photos").put(photo);
    for (const photoId of removedPhotoIds) transaction.objectStore("photos").delete(photoId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("这一页没有保存成功"));
    transaction.onabort = () => reject(transaction.error || new Error("保存已取消"));
  });
}

export async function putAnnotation(annotation) {
  return putOne("annotations", annotation);
}

export async function replaceData(entries, annotations, photos = []) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["entries", "annotations", "photos"], "readwrite");
    const entryStore = transaction.objectStore("entries");
    const annotationStore = transaction.objectStore("annotations");
    const photoStore = transaction.objectStore("photos");
    entryStore.clear();
    annotationStore.clear();
    for (const entry of entries) entryStore.put(entry);
    for (const annotation of annotations) annotationStore.put(annotation);
    for (const photo of photos) photoStore.put(photo);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("导入写入失败"));
    transaction.onabort = () => reject(transaction.error || new Error("导入已取消"));
  });
}

export async function removeAnnotation(annotationId) {
  return deleteOne("annotations", annotationId);
}

export async function clearEverything() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(["entries", "annotations", "photos"], "readwrite");
    for (const name of ["entries", "annotations", "photos"]) {
      transaction.objectStore(name).clear();
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("清空失败"));
  });
}

export async function usage() {
  if (navigator.storage && typeof navigator.storage.estimate === "function") {
    try {
      const info = await navigator.storage.estimate();
      return { used: info.usage || 0, quota: info.quota || 0 };
    } catch {
      return { used: 0, quota: 0 };
    }
  }
  return { used: 0, quota: 0 };
}
