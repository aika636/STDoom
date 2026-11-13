// Хранилище сейвов и пользовательских файлов игры.
//
// `ci.persist(true)` отдаёт ZIP с изменёнными файлами /home/web_user — это сейвы DOOM
// и перезаписанный движком DEFAULT.CFG. Складывать такой блоб в
// ctx.extensionSettings нельзя: settings.json таверны читается и пишется ЦЕЛИКОМ при
// каждом saveSettingsDebounced(), а сейвы бинарные и весят десятки килобайт.
// Поэтому — IndexedDB, а в extensionSettings живут только настройки.
//
// Тем же правилом закрыт и свой IWAD: он весит мегабайты, то есть в
// settings.json ему нечего делать тем более. Лежит здесь же, отдельными ключами.
//
// ⚠ DB_VERSION намеренно оставлен единицей, а пользовательские файлы положены в тот
// же objectStore под своими ключами, а не в новый store. Смена версии базы включает
// путь `onblocked`: пока другая вкладка таверны держит базу открытой, апгрейд
// повисает, и вместе с ним повисло бы чтение сейвов при старте — то есть открытие
// окна. Ключи и так дают всю нужную изоляцию, а имя store — деталь, которую никто,
// кроме этого файла, не видит.

import { logInfo, logWarn } from '../log.js';

const DB_NAME = 'STDoom';
const DB_VERSION = 1;
const STORE = 'saves';
const KEY_CHANGES = 'changes';

/**
 * Слоты пользовательских файлов. `iwad` — свой WAD (подкладывается файлом под
 * именем, которое ищет DOOM.EXE), `exe` — свой DOOM.EXE для коммерческих IWAD.
 */
export const USER_SLOTS = Object.freeze(['iwad', 'exe']);

const slotDataKey = (slot) => `user-${slot}`;
const slotMetaKey = (slot) => `user-${slot}-meta`;

function assertSlot(slot) {
    if (!USER_SLOTS.includes(slot)) throw new Error(`неизвестный слот файла: ${slot}`);
}

function openDb() {
    return new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error('IndexedDB недоступен'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('не удалось открыть IndexedDB'));
        request.onblocked = () => logWarn('открытие IndexedDB заблокировано другой вкладкой');
    });
}

function withStore(mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
        // Синхронный бросок здесь — не теория: `db.transaction()` кидает
        // NotFoundError, если store в базе нет (её мог создать кто-то другой), а
        // fn() работает с чужим объектом. Без catch промис отклонялся бы, а
        // СОЕДИНЕНИЕ оставалось бы открытым — по одному на каждый такой вызов.
        // Открытые соединения — это ровно то, что включает `onblocked` у соседней
        // вкладки, от которого бережётся правило 33.
        let tx;
        try {
            tx = db.transaction(STORE, mode);
            const request = fn(tx.objectStore(STORE));
            tx.oncomplete = () => { db.close(); resolve(readResult(request)); };
            tx.onerror = () => { db.close(); reject(tx.error); };
            tx.onabort = () => { db.close(); reject(tx.error ?? new Error('транзакция прервана')); };
        } catch (err) {
            try { tx?.abort(); } catch { /* уже мертва */ }
            db.close();
            reject(err);
        }
    }));
}

// fn может вернуть один запрос или массив запросов: одна транзакция на несколько
// ключей нужна, чтобы файл и его метаданные читались и писались вместе, а не
// разъезжались при обрыве посередине.
function readResult(request) {
    if (Array.isArray(request)) return request.map((item) => item?.result ?? null);
    return request?.result ?? null;
}

/**
 * Читает сохранённый ZIP изменений.
 * Отсутствие сейва — это норма (первый запуск), а не ошибка.
 * @returns {Promise<Uint8Array|null>}
 */
export async function loadChanges() {
    try {
        const value = await withStore('readonly', (store) => store.get(KEY_CHANGES));
        if (!value) return null;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        logInfo(`сейвы восстановлены (${bytes.length} байт)`);
        return bytes;
    } catch (err) {
        // Fail soft: сломанное хранилище не должно мешать запустить игру заново.
        logWarn('не удалось прочитать сейвы, играем с чистого листа', err);
        return null;
    }
}

/**
 * Пишет ZIP изменений.
 * @param {Uint8Array|null} bytes
 * @returns {Promise<boolean>} удалось ли сохранить
 */
export async function saveChanges(bytes) {
    if (!bytes || bytes.length === 0) return false;
    try {
        // Кладём копию: буфер мог прийти из воркера и быть переиспользован.
        await withStore('readwrite', (store) => store.put(new Uint8Array(bytes), KEY_CHANGES));
        logInfo(`сейвы сохранены (${bytes.length} байт)`);
        return true;
    } catch (err) {
        logWarn('не удалось сохранить сейвы', err);
        return false;
    }
}

/** Удаляет сейвы (кнопка «сбросить прогресс»). */
export async function clearChanges() {
    try {
        await withStore('readwrite', (store) => store.delete(KEY_CHANGES));
        logInfo('сейвы удалены');
        return true;
    } catch (err) {
        logWarn('не удалось удалить сейвы', err);
        return false;
    }
}

// --- Пользовательские файлы игры --------------------------------------

/**
 * Кладёт пользовательский файл вместе с метаданными.
 *
 * @param {'iwad'|'exe'} slot
 * @param {Uint8Array} bytes содержимое файла
 * @param {object} meta {dosName, fileName, md5, size, versionName, kind, savedAt}
 * @returns {Promise<boolean>}
 */
export async function saveUserFile(slot, bytes, meta = {}) {
    try {
        assertSlot(slot);
        if (!bytes || bytes.length === 0) return false;
        const record = { ...meta, size: meta.size ?? bytes.length, savedAt: meta.savedAt ?? Date.now() };
        await withStore('readwrite', (store) => [
            // Копия обязательна: буфер мог прийти из File.arrayBuffer() и жить
            // на общем ArrayBuffer с чем-то ещё.
            store.put(new Uint8Array(bytes), slotDataKey(slot)),
            store.put(record, slotMetaKey(slot)),
        ]);
        logInfo(`пользовательский файл (${slot}) сохранён: ${record.dosName ?? '?'}, ${bytes.length} байт`);
        return true;
    } catch (err) {
        logWarn(`не удалось сохранить пользовательский файл (${slot})`, err);
        return false;
    }
}

/**
 * Читает пользовательский файл вместе с метаданными.
 * Отсутствие файла — норма, а не ошибка.
 *
 * @param {'iwad'|'exe'} slot
 * @returns {Promise<{bytes: Uint8Array, meta: object}|null>}
 */
export async function loadUserFile(slot) {
    try {
        assertSlot(slot);
        const [data, meta] = await withStore('readonly', (store) => [
            store.get(slotDataKey(slot)),
            store.get(slotMetaKey(slot)),
        ]);
        if (!data) return null;
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.length === 0) return null;
        return { bytes, meta: meta && typeof meta === 'object' ? meta : {} };
    } catch (err) {
        // Fail soft: битое хранилище не должно мешать запустить игру со штатным WAD.
        logWarn(`не удалось прочитать пользовательский файл (${slot})`, err);
        return null;
    }
}

/**
 * Читает ТОЛЬКО метаданные. Отдельная функция нужна панели настроек: показать «что
 * загружено» надо, а тянуть ради подписи четырнадцать мегабайт из базы — нет.
 *
 * @param {'iwad'|'exe'} slot
 * @returns {Promise<object|null>}
 */
export async function loadUserFileMeta(slot) {
    try {
        assertSlot(slot);
        const meta = await withStore('readonly', (store) => store.get(slotMetaKey(slot)));
        return meta && typeof meta === 'object' ? meta : null;
    } catch (err) {
        logWarn(`не удалось прочитать сведения о файле (${slot})`, err);
        return null;
    }
}

/**
 * Удаляет пользовательский файл (кнопка «Убрать»).
 * @param {'iwad'|'exe'} slot
 * @returns {Promise<boolean>}
 */
export async function clearUserFile(slot) {
    try {
        assertSlot(slot);
        await withStore('readwrite', (store) => [
            store.delete(slotDataKey(slot)),
            store.delete(slotMetaKey(slot)),
        ]);
        logInfo(`пользовательский файл (${slot}) удалён`);
        return true;
    } catch (err) {
        logWarn(`не удалось удалить пользовательский файл (${slot})`, err);
        return false;
    }
}
