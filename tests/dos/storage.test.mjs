// Тесты хранилища сейвов (§4.10). fake-indexeddb в node_modules нет и заводить его
// ради тестов нельзя (расширение живёт без зависимостей), поэтому здесь — минимальная
// заглушка globalThis.indexedDB в памяти. Она же позволяет по команде ломать
// хранилище и проверять fail-soft: игра должна запускаться даже с битой базой.
//
// Запуск: node tests/dos/storage.test.mjs

import {
    clearChanges, clearUserFile, loadChanges, loadUserFile, loadUserFileMeta,
    saveChanges, saveUserFile,
} from '../../src/dos/storage.js';
import { assert, assertEqual, report, test } from '../_harness.mjs';

console.log('dos storage');

// --- Заглушка IndexedDB -------------------------------------------------------
// Асинхронность имитируем queueMicrotask: настоящие таймеры в тестах не гоняем,
// а await в самих тестах спускает микрозадачи сам.

class FakeRequest {
    constructor() {
        this.result = undefined;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
        this.onupgradeneeded = null;
        this.onblocked = null;
    }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.failOn] что сломать: 'open' | 'transaction' | 'put' | 'get'
 */
function makeIndexedDb(opts = {}) {
    const data = new Map();
    const stores = new Set();

    const api = {
        data,
        open(name, version) {
            const request = new FakeRequest();
            queueMicrotask(() => {
                if (opts.failOn === 'open') {
                    request.error = new Error('база повреждена');
                    request.onerror?.();
                    return;
                }
                request.result = makeDb();
                if (!stores.has('saves')) request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        },
    };

    function makeDb() {
        return {
            objectStoreNames: { contains: (n) => stores.has(n) },
            createObjectStore: (n) => { stores.add(n); },
            close: () => {},
            transaction(name, mode) {
                if (opts.failOn === 'transaction') throw new Error('транзакция не открылась');
                const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
                tx.objectStore = () => ({
                    get(key) {
                        const request = new FakeRequest();
                        if (opts.failOn === 'get') {
                            queueMicrotask(() => {
                                tx.error = new Error('чтение не удалось');
                                tx.onerror?.();
                            });
                            return request;
                        }
                        request.result = data.get(key);
                        queueMicrotask(() => tx.oncomplete?.());
                        return request;
                    },
                    put(value, key) {
                        const request = new FakeRequest();
                        if (opts.failOn === 'put') {
                            queueMicrotask(() => {
                                tx.error = new Error('запись не удалась');
                                tx.onabort?.();
                            });
                            return request;
                        }
                        if (mode !== 'readwrite') throw new Error('запись в readonly-транзакции');
                        data.set(key, value);
                        queueMicrotask(() => tx.oncomplete?.());
                        return request;
                    },
                    delete(key) {
                        const request = new FakeRequest();
                        data.delete(key);
                        queueMicrotask(() => tx.oncomplete?.());
                        return request;
                    },
                });
                return tx;
            },
        };
    }

    return api;
}

function install(opts) {
    const db = makeIndexedDb(opts);
    globalThis.indexedDB = db;
    return db;
}

// --- Круг «сохранил → прочитал» -----------------------------------------------

await test('§4.10: цикл сохранение → чтение возвращает те же байты', async () => {
    install();
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 42]);
    assertEqual(await saveChanges(zip), true, 'сохранение удалось');

    const loaded = await loadChanges();
    assert(loaded instanceof Uint8Array, 'вернулся Uint8Array');
    assertEqual(loaded.length, 5, 'длина совпала');
    assertEqual(Array.from(loaded).join(','), '80,75,3,4,42', 'содержимое совпало');
});

await test('сохраняется копия: буфер эмулятора переиспользуется', async () => {
    install();
    const zip = new Uint8Array([1, 2, 3]);
    await saveChanges(zip);
    // Воркер js-dos может переиспользовать тот же буфер под следующий кадр.
    zip[0] = 99;

    const loaded = await loadChanges();
    assertEqual(loaded[0], 1, 'в базе лежит снимок, а не живая ссылка');
});

await test('первый запуск: сейва нет — это норма, а не ошибка', async () => {
    install();
    assertEqual(await loadChanges(), null, 'null вместо исключения');
});

await test('пустой или отсутствующий ZIP не сохраняем', async () => {
    const db = install();
    assertEqual(await saveChanges(null), false, 'null');
    assertEqual(await saveChanges(new Uint8Array(0)), false, 'пустой массив');
    assertEqual(db.data.size, 0, 'в базу ничего не легло');
});

await test('clearChanges удаляет сейвы («сбросить прогресс»)', async () => {
    install();
    await saveChanges(new Uint8Array([7, 7, 7]));
    assertEqual(await clearChanges(), true, 'удаление удалось');
    assertEqual(await loadChanges(), null, 'после сброса сейва нет');
});

await test('objectStore создаётся при первом открытии базы', async () => {
    const db = install();
    // Два круга подряд: второй должен пройти уже без onupgradeneeded и не потерять данные.
    await saveChanges(new Uint8Array([1]));
    await saveChanges(new Uint8Array([2]));
    const loaded = await loadChanges();
    assertEqual(loaded[0], 2, 'вторая запись перекрыла первую');
    assertEqual(db.data.size, 1, 'ключ один');
});

// --- Fail-soft ----------------------------------------------------------------
// Сломанное хранилище не должно мешать играть: наружу летит null/false, а не
// исключение.

await test('fail-soft: IndexedDB недоступен вообще', async () => {
    const saved = globalThis.indexedDB;
    delete globalThis.indexedDB;
    assertEqual(await loadChanges(), null, 'чтение → null');
    assertEqual(await saveChanges(new Uint8Array([1])), false, 'запись → false');
    assertEqual(await clearChanges(), false, 'удаление → false');
    if (saved) globalThis.indexedDB = saved;
});

await test('fail-soft: open() завершается ошибкой', async () => {
    install({ failOn: 'open' });
    assertEqual(await loadChanges(), null, 'чтение → null');
    assertEqual(await saveChanges(new Uint8Array([1])), false, 'запись → false');
    assertEqual(await clearChanges(), false, 'удаление → false');
});

await test('fail-soft: transaction() бросает синхронно', async () => {
    install({ failOn: 'transaction' });
    assertEqual(await loadChanges(), null, 'чтение → null');
    assertEqual(await saveChanges(new Uint8Array([1])), false, 'запись → false');
});

await test('fail-soft: транзакция чтения свалилась в onerror', async () => {
    install({ failOn: 'get' });
    assertEqual(await loadChanges(), null, 'чтение → null');
});

await test('fail-soft: транзакция записи прервана (onabort)', async () => {
    install({ failOn: 'put' });
    assertEqual(await saveChanges(new Uint8Array([1, 2, 3])), false, 'запись → false');
});

await test('fail-soft: indexedDB.open() бросает синхронно', async () => {
    globalThis.indexedDB = { open() { throw new Error('доступ запрещён (приватный режим)'); } };
    assertEqual(await loadChanges(), null, 'чтение → null');
    assertEqual(await saveChanges(new Uint8Array([1])), false, 'запись → false');
});

await test('прочитанный ArrayBuffer оборачивается в Uint8Array', async () => {
    const db = install();
    // Некоторые реализации отдают обратно ArrayBuffer, а не типизированный массив.
    await saveChanges(new Uint8Array([1, 2, 3]));
    db.data.set('changes', new Uint8Array([9, 8, 7]).buffer);
    const loaded = await loadChanges();
    assert(loaded instanceof Uint8Array, 'тип нормализован');
    assertEqual(loaded[0], 9, 'содержимое на месте');
});

// --- Пользовательские файлы игры (Фаза 6) --------------------------------------
// Свой IWAD весит мегабайты, поэтому живёт там же, где сейвы, и по той же причине
// (§4.10): в settings.json таверны ему делать нечего.

const IWAD_META = {
    fileName: 'doom2.wad',
    dosName: 'DOOM2.WAD',
    kind: 'doom2',
    md5: '25e1459ca71d7730acd36a18e5be1904',
    size: 3,
    versionName: 'Doom II 1.9',
};

await test('свой IWAD сохраняется вместе с метаданными и читается обратно', async () => {
    install();
    assertEqual(await saveUserFile('iwad', new Uint8Array([1, 2, 3]), IWAD_META), true, 'сохранение');

    const loaded = await loadUserFile('iwad');
    assert(loaded, 'файл найден');
    assert(loaded.bytes instanceof Uint8Array, 'байты');
    assertEqual(loaded.bytes.length, 3, 'длина');
    assertEqual(loaded.meta.dosName, 'DOOM2.WAD', 'имя файла в DOS');
    assertEqual(loaded.meta.md5, IWAD_META.md5, 'MD5');
    assert(typeof loaded.meta.savedAt === 'number', 'дата загрузки проставлена');
});

await test('метаданные читаются отдельно, без чтения мегабайтов', async () => {
    // Панели настроек нужна только подпись — тянуть ради неё весь WAD из базы нельзя.
    install();
    await saveUserFile('iwad', new Uint8Array([1, 2, 3]), IWAD_META);
    const meta = await loadUserFileMeta('iwad');
    assertEqual(meta.versionName, 'Doom II 1.9', 'подпись версии');
    assertEqual(await loadUserFileMeta('exe'), null, 'пустой слот — null');
});

await test('слоты iwad и exe не мешают друг другу', async () => {
    install();
    await saveUserFile('iwad', new Uint8Array([1, 1]), { dosName: 'DOOM.WAD' });
    await saveUserFile('exe', new Uint8Array([0x4d, 0x5a, 7]), { dosName: 'DOOM.EXE' });

    assertEqual((await loadUserFile('iwad')).bytes.length, 2, 'IWAD на месте');
    assertEqual((await loadUserFile('exe')).bytes.length, 3, 'EXE на месте');

    await clearUserFile('exe');
    assert(await loadUserFile('iwad'), 'IWAD пережил удаление EXE');
    assertEqual(await loadUserFile('exe'), null, 'EXE удалён');
});

await test('свои файлы не трогают сейвы, и наоборот', async () => {
    install();
    await saveChanges(new Uint8Array([5, 5, 5]));
    await saveUserFile('iwad', new Uint8Array([1]), IWAD_META);

    await clearUserFile('iwad');
    assertEqual((await loadChanges()).length, 3, 'сейвы уцелели');

    await saveUserFile('iwad', new Uint8Array([1]), IWAD_META);
    await clearChanges();
    assert(await loadUserFile('iwad'), 'IWAD уцелел после сброса прогресса');
});

await test('удаление уносит и файл, и метаданные', async () => {
    install();
    await saveUserFile('iwad', new Uint8Array([1]), IWAD_META);
    assertEqual(await clearUserFile('iwad'), true, 'удаление удалось');
    assertEqual(await loadUserFile('iwad'), null, 'файла нет');
    assertEqual(await loadUserFileMeta('iwad'), null, 'метаданных тоже');
});

await test('пустой файл не сохраняем', async () => {
    const db = install();
    assertEqual(await saveUserFile('iwad', new Uint8Array(0), IWAD_META), false, 'пустой массив');
    assertEqual(await saveUserFile('iwad', null, IWAD_META), false, 'null');
    assertEqual(db.data.size, 0, 'в базу ничего не легло');
});

await test('сохраняется копия байтов, а не ссылка на буфер File', async () => {
    install();
    const bytes = new Uint8Array([1, 2, 3]);
    await saveUserFile('iwad', bytes, IWAD_META);
    bytes[0] = 99;
    assertEqual((await loadUserFile('iwad')).bytes[0], 1, 'в базе снимок');
});

await test('неизвестный слот — отказ, а не запись в случайный ключ', async () => {
    const db = install();
    assertEqual(await saveUserFile('привет', new Uint8Array([1]), {}), false, 'запись');
    assertEqual(await loadUserFile('привет'), null, 'чтение');
    assertEqual(await clearUserFile('привет'), false, 'удаление');
    assertEqual(db.data.size, 0, 'база пуста');
});

await test('fail-soft: битое хранилище не мешает играть на штатном WAD', async () => {
    install({ failOn: 'open' });
    assertEqual(await loadUserFile('iwad'), null, 'чтение → null');
    assertEqual(await loadUserFileMeta('iwad'), null, 'метаданные → null');
    assertEqual(await saveUserFile('iwad', new Uint8Array([1]), IWAD_META), false, 'запись → false');
    assertEqual(await clearUserFile('iwad'), false, 'удаление → false');
});

await test('потерянные метаданные не мешают отдать байты', async () => {
    // Ключей два, и теоретически можно остаться с одним. Файл важнее подписи.
    const db = install();
    await saveUserFile('iwad', new Uint8Array([1, 2]), IWAD_META);
    db.data.delete('user-iwad-meta');
    const loaded = await loadUserFile('iwad');
    assert(loaded, 'файл прочитан');
    assertEqual(Object.keys(loaded.meta).length, 0, 'метаданные пусты, но это не ошибка');
});

report('dos storage');
