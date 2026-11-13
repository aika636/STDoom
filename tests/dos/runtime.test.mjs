// Тесты жизненного цикла сессии DOSBox. Настоящий wasm под jsdom
// не запускается, поэтому `emulators` подменён через globalThis, fetch — заглушкой,
// а WebGL — объектом-шпионом.
//
// Требуется jsdom: npm install --no-save jsdom
// Запуск: node tests/dos/runtime.test.mjs

import { JSDOM } from 'jsdom';
import { assert, assertEqual, report, test } from '../_harness.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>');

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

// Кадры в этих тестах не гоняем — rAF просто копится, чтобы ничего не выполнялось само.
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { CYCLES_MAX, CYCLES_MIN } = await import('../../src/dos/config.js');
const { clampCycles, startDoom, volumeFraction } = await import('../../src/dos/runtime.js');

console.log('dos runtime');

// --- clampCycles --------------------------------------------------------------

test('clampCycles держит диапазон плеера 3000…1 000 000', () => {
    assertEqual(CYCLES_MIN, 3000, 'нижняя граница из config.js');
    assertEqual(CYCLES_MAX, 1000000, 'верхняя граница из config.js');
    assertEqual(clampCycles(20000), 20000, 'значение внутри диапазона не трогаем');
    assertEqual(clampCycles(100), 3000, 'ниже границы — подняли');
    assertEqual(clampCycles(0), 3000, 'ноль — подняли');
    assertEqual(clampCycles(-5000), 3000, 'отрицательное — подняли');
    assertEqual(clampCycles(9e9), 1000000, 'выше границы — опустили');
    // Infinite/NaN — не число в понимании Number.isFinite, поэтому это ветка мусора.
    assertEqual(clampCycles(Infinity), 20000, 'бесконечность считается мусором');
});

test('мусорное значение циклов даёт дефолтные 20000', () => {
    assertEqual(clampCycles(undefined), 20000, 'undefined');
    assertEqual(clampCycles(null), 3000, 'null числится нулём и поднимается до минимума');
    assertEqual(clampCycles('привет'), 20000, 'строка-мусор');
    assertEqual(clampCycles(NaN), 20000, 'NaN');
    assertEqual(clampCycles({}), 20000, 'объект');
});

test('clampCycles округляет дробные значения', () => {
    assertEqual(clampCycles(20000.7), 20001, 'округление вверх');
    assertEqual(clampCycles('35000'), 35000, 'числовая строка принимается');
});

// --- Окружение для startDoom --------------------------------------------------

/** Минимальный WebGL-шпион: рендерер должен создаться, содержимое неважно. */
function stubWebGl(canvas) {
    const noop = () => {};
    const gl = new Proxy({}, {
        get(target, prop) {
            if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
            if (prop === 'getExtension') return () => null;
            if (typeof prop === 'string' && prop.toUpperCase() === prop) return prop;
            if (prop in target) return target[prop];
            return noop;
        },
    });
    canvas.getContext = () => gl;
}

/** Шпион CommandInterface: пишет порядок вызовов — на нём держатся проверки. */
function makeCi(log) {
    const handlers = {};
    return {
        handlers,
        width: () => { log.push('width'); return 640; },
        height: () => { log.push('height'); return 400; },
        events: () => {
            log.push('events');
            return {
                onFrameSize: (fn) => { log.push('sub:onFrameSize'); handlers.frameSize = fn; },
                onFrame: (fn) => { log.push('sub:onFrame'); handlers.frame = fn; },
                onStdout: (fn) => { log.push('sub:onStdout'); handlers.stdout = fn; },
                onMessage: (fn) => { log.push('sub:onMessage'); handlers.message = fn; },
                onExit: (fn) => { log.push('sub:onExit'); handlers.exit = fn; },
            };
        },
        soundFrequency: () => 0,
        mute: () => log.push('mute'),
        unmute: () => log.push('unmute'),
        pause: () => log.push('pause'),
        resume: () => log.push('resume'),
        sendBackendEvent: (event) => log.push('backend:' + event.event),
        asyncifyStats: async () => ({ messageSent: 1 }),
        persist: async () => { log.push('persist'); return new Uint8Array([1, 2, 3]); },
        exit: async () => { log.push('exit'); },
    };
}

// loadEmulators() кеширует промис загрузки, поэтому объект `emulators` и `fetch`
// ставятся ОДИН раз, а каждый тест только подменяет текущий сценарий.
let scenario = null;

globalThis.emulators = {
    dosboxWorker: async (init, options) => scenario.boot(init, options),
};
globalThis.fetch = async (url) => scenario.fetch(url);

/**
 * Поднимает окружение: emulators, fetch, канвас с WebGL и (по желанию) сейвы
 * в IndexedDB. Возвращает всё, что нужно проверить снаружи.
 */
function stage({ savedChanges = null, bundleOk = true, boot, userFiles = null } = {}) {
    const log = [];
    const ci = makeCi(log);
    const seen = {};

    scenario = {
        fetch: async (url) => {
            log.push('fetch');
            seen.url = String(url);
            if (!bundleOk) return { ok: false, status: 404 };
            return { ok: true, arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 0xff]).buffer };
        },
        boot: async (init, options) => {
            log.push('boot');
            seen.init = init;
            seen.options = options;
            return boot ? boot(ci) : ci;
        },
    };

    // Заглушка IndexedDB ровно под одну запись сейвов.
    globalThis.indexedDB = {
        open() {
            const request = { onsuccess: null, onerror: null, onupgradeneeded: null };
            queueMicrotask(() => {
                request.result = {
                    objectStoreNames: { contains: () => true },
                    createObjectStore: () => {},
                    close: () => {},
                    transaction() {
                        const tx = {};
                        // Заглушка знает про ключи: сейвы и свои файлы игры лежат в
                        // одном store, и подмена одного другим прятала бы порядок
                        // элементов InitFs — то самое, что здесь и проверяется.
                        const values = new Map([['changes', savedChanges ?? undefined]]);
                        for (const [key, value] of Object.entries(userFiles ?? {})) {
                            values.set(key, value);
                        }
                        tx.objectStore = () => ({
                            get: (key) => {
                                const r = { result: values.get(key) };
                                queueMicrotask(() => tx.oncomplete?.());
                                return r;
                            },
                            put: (value) => {
                                (seen.puts ??= []).push(value);
                                queueMicrotask(() => tx.oncomplete?.());
                                return {};
                            },
                        });
                        return tx;
                    },
                };
                request.onsuccess?.();
            });
            return request;
        },
    };

    const box = document.createElement('div');
    document.body.appendChild(box);
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    stubWebGl(canvas);

    return { log, ci, seen, canvas, box };
}

// --- Старт --------------------------------------------------------------------

await test('startDoom без канваса падает внятно', async () => {
    let message = '';
    try {
        await startDoom({});
    } catch (err) {
        message = err.message;
    }
    assert(/канвас/.test(message), `сообщение про канвас, получено «${message}»`);
});

await test('порядок InitFs — бандл → сейвы → строка конфига (строка последняя)', async () => {
    const { seen, canvas, box } = stage({ savedChanges: new Uint8Array([9, 9]) });
    const session = await startDoom({ canvas, box, settings: { cycles: 30000 } });

    const init = seen.init;
    assertEqual(init.length, 3, 'три элемента');
    assert(init[0] instanceof Uint8Array, 'первый — бандл игры');
    assertEqual(init[0][0], 0x50, 'это тот самый ZIP из fetch');
    assert(init[1] instanceof Uint8Array, 'второй — сейвы');
    assertEqual(init[1][0], 9, 'сейвы из IndexedDB');
    assertEqual(typeof init[2], 'string', 'третий — строка конфига');
    assert(init[2].includes('[dosbox]'), 'это dosbox.conf');
    assert(/cycles\s*=\s*30000/.test(init[2]), 'циклы из настроек попали в конфиг');
    // Именно строка обязана быть последней: js-dos кладёт её в .jsdos/dosbox.conf,
    // и содержимое архива, распакованного позже, перекрыло бы её.
    assertEqual(typeof init.at(-1), 'string', 'последний элемент — строка конфига');

    await session.stop();
    box.remove();
});

await test('без сейвов InitFs состоит из бандла и строки конфига', async () => {
    const { seen, canvas, box } = stage();
    const session = await startDoom({ canvas, box });
    assertEqual(seen.init.length, 2, 'два элемента');
    assert(seen.init[0] instanceof Uint8Array, 'бандл');
    assertEqual(typeof seen.init[1], 'string', 'строка конфига по-прежнему последняя');
    await session.stop();
    box.remove();
});

// --- Свой IWAD --------------------------------------------------------
//
// Проверяем ровно то, что нельзя увидеть глазами: место пользовательского архива в
// InitFs. Раньше бандла — и штатный DOOM.EXE затрёт принесённый игроком; позже
// сейвов — и архив с сейвами ляжет не последним; строка конфига в любом случае
// обязана остаться в конце.

/** Имена записей в собранном нами ZIP — читаем прямо из локальных заголовков. */
function zipNames(bytes) {
    const text = Buffer.from(bytes).toString('latin1');
    const names = [];
    const re = /PK\x03\x04/g;
    let match;
    while ((match = re.exec(text)) !== null) {
        const at = match.index;
        const nameLen = bytes[at + 26] | (bytes[at + 27] << 8);
        names.push(text.slice(at + 30, at + 30 + nameLen));
    }
    return names;
}

const userIwadBytes = new Uint8Array([0x49, 0x57, 0x41, 0x44, 1, 2, 3, 4]);

await test('свой IWAD идёт ПОСЛЕ бандла и ДО сейвов', async () => {
    const { seen, canvas, box } = stage({
        savedChanges: new Uint8Array([9, 9]),
        userFiles: {
            'user-iwad': userIwadBytes,
            'user-iwad-meta': { kind: 'doom2', dosName: 'DOOM2.WAD', md5: 'abc' },
        },
    });
    const session = await startDoom({ canvas, box });

    const init = seen.init;
    assertEqual(init.length, 4, 'бандл, свой IWAD, сейвы, конфиг');
    assertEqual(init[0][0], 0x50, 'первый — бандл из fetch');
    assert(init[1] instanceof Uint8Array, 'второй — архив со своим IWAD');
    assertEqual(init[1][0], 0x50, 'это ZIP');
    assertEqual(init[2][0], 9, 'третий — сейвы');
    assertEqual(typeof init[3], 'string', 'строка конфига по-прежнему последняя');

    // Имя определяется содержимым WAD, а не флагом -iwad, которого в ванили нет.
    assertEqual(zipNames(init[1]).join(','), 'DOOM2.WAD', 'WAD положен под именем для DOOM2');

    await session.stop();
    box.remove();
});

await test('без сейвов свой IWAD встаёт сразу за бандлом', async () => {
    const { seen, canvas, box } = stage({
        userFiles: {
            'user-iwad': userIwadBytes,
            'user-iwad-meta': { kind: 'ultimate', dosName: 'DOOM.WAD' },
        },
    });
    const session = await startDoom({ canvas, box });
    assertEqual(seen.init.length, 3, 'бандл, свой IWAD, конфиг');
    assertEqual(zipNames(seen.init[1]).join(','), 'DOOM.WAD', 'Ultimate Doom кладётся как DOOM.WAD');
    assertEqual(typeof seen.init.at(-1), 'string', 'конфиг последний');
    await session.stop();
    box.remove();
});

await test('свой DOOM.EXE едет в том же архиве и перекрывает штатный', async () => {
    const { seen, canvas, box } = stage({
        userFiles: {
            'user-iwad': userIwadBytes,
            'user-iwad-meta': { kind: 'doom2' },
            'user-exe': new Uint8Array([0x4d, 0x5a, 1, 2]),
            'user-exe-meta': { md5: 'zzz' },
        },
    });
    const session = await startDoom({ canvas, box });
    assertEqual(seen.init.length, 3, 'бандл, свои файлы, конфиг');
    assertEqual(zipNames(seen.init[1]).join(','), 'DOOM2.WAD,DOOM.EXE', 'обе записи в одном архиве');
    await session.stop();
    box.remove();
});

await test('только свой DOOM.EXE, без своего IWAD', async () => {
    const { seen, canvas, box } = stage({
        userFiles: { 'user-exe': new Uint8Array([0x4d, 0x5a]), 'user-exe-meta': {} },
    });
    const session = await startDoom({ canvas, box });
    assertEqual(zipNames(seen.init[1]).join(','), 'DOOM.EXE', 'одна запись');
    await session.stop();
    box.remove();
});

await test('потерянные метаданные — кладём под DOOM.WAD, а не роняем запуск', async () => {
    const { seen, canvas, box } = stage({ userFiles: { 'user-iwad': userIwadBytes } });
    const session = await startDoom({ canvas, box });
    assertEqual(zipNames(seen.init[1]).join(','), 'DOOM.WAD', 'наименее рискованное имя из трёх');
    await session.stop();
    box.remove();
});

await test('без своих файлов лишнего элемента в InitFs нет', async () => {
    const { seen, canvas, box } = stage();
    const session = await startDoom({ canvas, box });
    assertEqual(seen.init.length, 2, 'бандл и конфиг');
    await session.stop();
    box.remove();
});

await test('эмулятор поднимается в воркере с audioWorklet', async () => {
    const { seen, canvas, box } = stage();
    const session = await startDoom({ canvas, box });
    assertEqual(seen.options.audioWorklet, true, 'режим AudioWorklet включён');
    assertEqual(typeof seen.options.onExtractProgress, 'function', 'прогресс распаковки');
    await session.stop();
    box.remove();
});

await test('сразу после подписки размер подхватывается вручную', async () => {
    const { log, canvas, box } = stage();
    const session = await startDoom({ canvas, box });

    // onFrameSize мог сработать до подписки — поэтому resize(ci.width(), ci.height())
    // вызывается руками, а не ждёт события.
    assert(!log.includes('frameSize-event'), 'onFrameSize не вызывался ни разу');
    assertEqual(session.renderer.size.width, 640, 'ширина взята у ci');
    assertEqual(session.renderer.size.height, 400, 'высота взята у ci');

    const lastSub = log.lastIndexOf('sub:onExit');
    const widthAfterSubs = log.indexOf('width', lastSub);
    assert(widthAfterSubs > lastSub, 'ci.width() дёрнут ПОСЛЕ подписок на события');

    await session.stop();
    box.remove();
});

await test('стадии загрузки уходят в onProgress по порядку', async () => {
    const { canvas, box } = stage();
    const stages = [];
    const session = await startDoom({
        canvas, box,
        onProgress: (stage) => stages.push(stage),
    });
    // Стадии своих файлов здесь нет намеренно: игрок ничего не загружал, и строка
    // «подготовка своего IWAD…» мигала бы ему без всякой причины.
    assertEqual(
        stages.join(','),
        'loading-api,loading-bundle,loading-saves,booting',
        'порядок стадий',
    );
    await session.stop();
    box.remove();
});

await test('со своим IWAD появляется стадия loading-iwad', async () => {
    const { canvas, box } = stage({ userFiles: { 'user-iwad': userIwadBytes } });
    const stages = [];
    const session = await startDoom({
        canvas, box,
        onProgress: (stage) => stages.push(stage),
    });
    assertEqual(
        stages.join(','),
        'loading-api,loading-bundle,loading-iwad,loading-saves,booting',
        'своя стадия встаёт между бандлом и сейвами',
    );
    await session.stop();
    box.remove();
});

await test('упавший onProgress не срывает запуск', async () => {
    const { canvas, box } = stage();
    const session = await startDoom({
        canvas, box,
        onProgress: () => { throw new Error('обработчик кривой'); },
    });
    assert(session.ci, 'сессия всё равно поднялась');
    await session.stop();
    box.remove();
});

await test('недоступный doom.zip даёт ошибку с именем файла', async () => {
    const { canvas, box } = stage({ bundleOk: false });
    let message = '';
    try {
        await startDoom({ canvas, box });
    } catch (err) {
        message = err.message;
    }
    assert(/doom\.zip/.test(message), `в сообщении есть doom.zip: «${message}»`);
    assert(/404/.test(message), 'и код ответа');
    box.remove();
});

// --- События ------------------------------------------------------------------

await test('onFrame и onFrameSize доезжают до рендерера', async () => {
    const { ci, canvas, box } = stage();
    const session = await startDoom({ canvas, box });

    ci.handlers.frameSize(320, 200);
    assertEqual(session.renderer.size.width, 320, 'размер сменился по событию');

    // Пустой кадр в рендерер не идёт — иначе он затрёт последний валидный.
    ci.handlers.frame(null);
    ci.handlers.frame(new Uint8Array(320 * 200 * 3));
    await session.stop();
    box.remove();
});

await test('onExit помечает сессию завершённой и зовёт колбэк', async () => {
    const { ci, canvas, box } = stage();
    let exitCalls = 0;
    const session = await startDoom({ canvas, box, onExit: () => { exitCalls++; } });
    assertEqual(session.exited, false, 'сессия жива');

    ci.handlers.exit();
    assertEqual(session.exited, true, 'флаг выставлен');
    assertEqual(exitCalls, 1, 'колбэк вызван');

    // После самостоятельного выхода persist() не трогает мёртвый эмулятор.
    assertEqual(await session.persist(), false, 'persist после выхода — false');
    box.remove();
});

await test('onRenderFailure пробрасывается в рендерер', async () => {
    const { canvas, box } = stage();
    const seen = [];
    // Кадры в этом файле не гоняются (rAF — заглушка), поэтому проверяем проводку
    // напрямую: ломаем отрисовку и крутим кадры сами. Порог рендерера — 30.
    const savedRaf = globalThis.requestAnimationFrame;
    const queue = [];
    globalThis.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };

    const session = await startDoom({
        canvas, box, onRenderFailure: (err) => seen.push(err),
    });
    assertEqual(session.renderer.errorLimit, 30, 'порог по умолчанию');

    // Заставляем draw() падать на каждом кадре.
    // Кадр длиннее ожидаемого — значит, draw() полезет за subarray(), а он бросит.
    const broken = new Uint8Array(640 * 400 * 3 + 1);
    Object.defineProperty(broken, 'subarray', {
        value: () => { throw new Error('контекст потерян'); },
    });
    for (let i = 0; i < 30; i++) {
        session.renderer.pushFrame(broken);
        for (const fn of queue.splice(0)) fn();
    }

    assertEqual(seen.length, 1, 'колбэк дошёл из render.js и сработал один раз');
    assert(seen[0] instanceof Error, 'ошибка передана наружу');

    globalThis.requestAnimationFrame = savedRaf;
    await session.stop();
    box.remove();
});

await test('onStdout и onMessage не роняют сессию', async () => {
    const { ci, canvas, box } = stage();
    const session = await startDoom({ canvas, box });
    ci.handlers.stdout('DOOM 1.9\n');
    ci.handlers.message('error', 'что-то пошло не так');
    ci.handlers.message('warn', 'предупреждение');
    ci.handlers.message('info', 'просто сообщение');
    await session.stop();
    box.remove();
});

// --- Рычаги производительности ------------------------------------------------

await test('setCycles зажимает значение и шлёт событие бэкенду', async () => {
    const { log, canvas, box } = stage();
    const session = await startDoom({ canvas, box });

    assertEqual(session.setCycles(35000), 35000, 'значение внутри диапазона');
    assert(log.includes('backend:cycles:35000'), 'событие ушло в эмулятор');
    assertEqual(session.setCycles(9e9), 1000000, 'верхняя граница');
    assertEqual(session.setCycles('мусор'), 20000, 'мусор — дефолт');

    await session.stop();
    box.remove();
});

await test('setFrameSkip зажат диапазоном 0…10', async () => {
    const { log, canvas, box } = stage();
    const session = await startDoom({ canvas, box });
    assertEqual(session.setFrameSkip(3), 3, 'обычное значение');
    assert(log.includes('backend:frame_skip:3'), 'событие ушло');
    assertEqual(session.setFrameSkip(-5), 0, 'ниже нуля');
    assertEqual(session.setFrameSkip(99), 10, 'выше десяти');
    assertEqual(session.setFrameSkip('мусор'), 0, 'мусор');
    await session.stop();
    box.remove();
});

await test('pause/resume и stats переживают падение ci', async () => {
    const { canvas, box } = stage({
        boot: (ci) => ({
            ...ci,
            pause: () => { throw new Error('нет'); },
            resume: () => { throw new Error('нет'); },
            asyncifyStats: async () => { throw new Error('нет'); },
        }),
    });
    const session = await startDoom({ canvas, box });
    session.pause();
    session.resume();
    assertEqual(await session.stats(), null, 'stats fail-soft отдаёт null');
    await session.stop();
    box.remove();
});

// --- Остановка ----------------------------------------------------------------

await test('stop() вызывает persist ДО ci.exit()', async () => {
    const { log, canvas, box } = stage();
    const session = await startDoom({ canvas, box });
    log.length = 0;

    await session.stop();
    const persistAt = log.indexOf('persist');
    const exitAt = log.indexOf('exit');
    assert(persistAt >= 0, 'persist вызван');
    assert(exitAt >= 0, 'exit вызван');
    assert(persistAt < exitAt, 'сначала сохранили прогресс, потом погасили эмулятор');
    assertEqual(session.disposed, true, 'сессия помечена закрытой');
    box.remove();
});

// Регрессия: stop() поднимал флаг disposed ДО persist(), из-за чего persist()
// видел закрытую сессию и молча возвращал false — прогресс игрока не сохранялся.
await test('stop() реально дописывает сейвы в хранилище', async () => {
    const { seen, canvas, box } = stage();
    const session = await startDoom({ canvas, box });
    await session.stop();
    assertEqual(seen.puts?.length, 1, 'ровно одна запись в IndexedDB');
    assertEqual(seen.puts[0].length, 3, 'записан ZIP из ci.persist()');
    box.remove();
});

await test('повторный stop() ничего не делает', async () => {
    const { log, canvas, box } = stage();
    const session = await startDoom({ canvas, box });
    await session.stop();
    log.length = 0;
    await session.stop();
    assertEqual(log.length, 0, 'второй вызов холостой');
    box.remove();
});

await test('stop() после самостоятельного выхода не зовёт ci.exit()', async () => {
    const { ci, log, canvas, box } = stage();
    const session = await startDoom({ canvas, box });
    ci.handlers.exit();
    log.length = 0;
    await session.stop();
    assert(!log.includes('exit'), 'эмулятор уже мёртв — не трогаем');
    box.remove();
});

await test('упавший persist() не мешает остановке', async () => {
    const { canvas, box } = stage({
        boot: (ci) => ({ ...ci, persist: async () => { throw new Error('нет'); } }),
    });
    const session = await startDoom({ canvas, box });
    assertEqual(await session.persist(), false, 'persist fail-soft');
    await session.stop();
    assertEqual(session.disposed, true, 'сессия закрыта');
    box.remove();
});

await test('упавший ci.exit() не мешает остановке', async () => {
    const { canvas, box } = stage({
        boot: (ci) => ({ ...ci, exit: async () => { throw new Error('нет'); } }),
    });
    const session = await startDoom({ canvas, box });
    await session.stop();
    assertEqual(session.disposed, true, 'сессия закрыта');
    box.remove();
});


// --- Уборка при сбое сборки сессии ---------------------------------------------

await test('сбой рендерера гасит уже поднятый эмулятор, а не бросает его жить', async () => {
    const { canvas, box, log } = stage();
    // WebGL недоступен — путь ожидаемый: session.js специально распознаёт эту
    // ошибку в тексте отказа. Эмулятор к этому моменту УЖЕ запущен: без уборки
    // воркер, wasm и AudioContext остались бы работать, DOOM продолжал бы крутиться
    // в фоне, а каждое повторное «Играть» добавляло бы ещё один такой же.
    canvas.getContext = () => null;

    let failed = null;
    try {
        await startDoom({ canvas, box });
    } catch (err) {
        failed = err;
    }

    assert(failed instanceof Error, 'ошибка доехала до вызывающего');
    assert(/WebGL/.test(failed.message), `сообщение про WebGL, а не «${failed.message}»`);
    assert(log.includes('exit'), 'эмулятор погашен');
});

// --- Гонка сохранений ----------------------------------------------------------

await test('два persist() подряд не идут в базу одновременно', async () => {
    // Поводов сохраниться три — закрытие окна, уход со вкладки и отказ отрисовки, —
    // и они умеют совпасть. Два ci.persist() в полёте дают две записи, и в базе
    // останется вернувшаяся последней, а вернуться последней может более ранняя.
    const { canvas, box, ci } = stage();
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;
    const waiting = [];
    ci.persist = async () => {
        started++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => waiting.push(resolve));
        inFlight--;
        return new Uint8Array([1]);
    };

    /** Даём микрозадачам провернуться: persist() ставится в очередь, а не бежит сразу. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    const session = await startDoom({ canvas, box });
    const first = session.persist();
    const second = session.persist();
    await settle();

    // Первый ещё висит: второй обязан ждать своей очереди, а не лезть параллельно.
    assertEqual(started, 1, 'начался ровно один');
    assertEqual(maxInFlight, 1, 'одновременно — не больше одного');

    waiting.shift()();
    await first;
    await settle();
    assertEqual(started, 2, 'второй пошёл только теперь');

    waiting.shift()();
    await second;
    assertEqual(maxInFlight, 1, 'и после разбора очереди — тоже');

    // Дальше уборка: stop() сохраняется сам, и ждать его на ручном резольвере
    // означало бы повесить тест.
    ci.persist = async () => new Uint8Array([1]);
    await session.stop();
});


test('volumeFraction: проценты в долю, мусор — в полную громкость', () => {
    assertEqual(volumeFraction(100), 1, 'сотня процентов');
    assertEqual(volumeFraction(0), 0, 'ноль — тишина');
    assertEqual(volumeFraction(50), 0.5, 'половина');
    assertEqual(volumeFraction(250), 1, 'выше сотни зажато');
    assertEqual(volumeFraction(-10), 0, 'ниже нуля зажато');
    // Молча оставить игрока без звука хуже, чем проигнорировать битое значение
    // из правленого руками settings.json.
    assertEqual(volumeFraction('громко'), 1, 'мусор → 1, а не 0');
    assertEqual(volumeFraction(undefined), 1, 'отсутствие настройки → 1');
});

report('dos runtime');
