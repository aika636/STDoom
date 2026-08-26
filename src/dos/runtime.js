// Жизненный цикл сессии DOSBox (план §4.3, §4.9, §4.10).
//
// Бэкенд — `dosboxWorker`: эмуляция уходит в Web Worker, кадры и звук передаются
// zero-copy. Вариант `dosboxDirect` отвергнут (эмуляция конкурировала бы с UI таверны
// за главный поток), вариант с OffscreenCanvas — аварийный рычаг производительности:
// он быстрее, но тогда onFrame не вызывается вовсе и своего рендерера у нас нет.

import { logInfo, logWarn, logError } from '../log.js';
import { loadEmulators } from './loader.js';
import { buildDosboxConf, clampCycles } from './config.js';
import { createRenderer } from './render.js';
import { createAudioControl, probeSampleRate } from './audio.js';
import { loadChanges, loadUserFile, saveChanges } from './storage.js';
import { makeStoreZip } from './zip.js';
import { DOS_NAMES } from './iwad.js';

function doomBundleUrl() {
    return new URL('../../assets/doom/doom.zip', import.meta.url).href;
}

async function fetchBundle(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`не удалось загрузить ${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

/**
 * Собирает ZIP с файлами, принесёнными игроком (Фаза 6): своим IWAD и, если он его
 * загрузил, своим DOOM.EXE.
 *
 * ⚠ Флага `-iwad` в ванильном DOOM нет (§5.3): движок сам ищет в текущем каталоге
 * doom2.wad → doom.wad → doom1.wad. Поэтому WAD кладётся ФАЙЛОМ под именем,
 * выведенным из его содержимого при загрузке (src/dos/iwad.js), а параметров запуска
 * мы не трогаем вовсе.
 *
 * @returns {Promise<Uint8Array|null>} null, если игрок ничего не загружал
 */
async function buildUserFilesZip(report) {
    const entries = [];
    try {
        const iwad = await loadUserFile('iwad');
        if (iwad) {
            // Стадию показываем ТОЛЬКО когда игроку действительно что-то готовят:
            // иначе строка «подготовка своего IWAD…» мигала бы у всех, включая тех,
            // кто никогда ничего не загружал.
            report?.('loading-iwad');
            // Имя из метаданных: оно посчитано при загрузке файла. Если метаданные
            // потерялись, DOOM.WAD — наименее рискованный вариант из трёх.
            const name = DOS_NAMES[iwad.meta?.kind] ?? iwad.meta?.dosName ?? 'DOOM.WAD';
            entries.push({ name, data: iwad.bytes });
            logInfo(`свой IWAD: ${name}, ${iwad.bytes.length} байт, md5 ${iwad.meta?.md5 ?? '?'}`);
        }

        const exe = await loadUserFile('exe');
        if (exe) {
            report?.('loading-iwad');
            entries.push({ name: 'DOOM.EXE', data: exe.bytes });
            logInfo(`свой DOOM.EXE: ${exe.bytes.length} байт, md5 ${exe.meta?.md5 ?? '?'}`);
        }

        if (entries.length === 0) return null;
        return makeStoreZip(entries);
    } catch (err) {
        // Fail soft: не собрался архив — играем на штатном shareware, а не падаем.
        logWarn('не удалось подготовить пользовательские файлы, играем на штатных', err);
        return null;
    }
}

/**
 * Запускает DOOM и возвращает управляющий объект сессии.
 *
 * @param {object} params
 * @param {HTMLCanvasElement} params.canvas
 * @param {HTMLElement} [params.box] контейнер для леттербокса
 * @param {object} [params.settings] настройки расширения (cycles, muted, ...)
 * @param {(stage: string, detail?: any) => void} [params.onProgress] прогресс загрузки
 * @param {() => void} [params.onExit] эмулятор завершился сам
 * @param {(err: Error) => void} [params.onRenderFailure] отрисовка сломалась N раз подряд;
 *   зовётся один раз на серию (см. render.js), сессия при этом продолжает жить.
 */
export async function startDoom({
    canvas, box, settings = {}, onProgress, onExit, onRenderFailure,
} = {}) {
    if (!canvas) throw new Error('startDoom: не передан канвас');

    const report = (stage, detail) => {
        try { onProgress?.(stage, detail); } catch (err) { logWarn('onProgress упал', err); }
    };

    // Частоту проверяем ДО старта: если она не 44100, звука, скорее всего, не будет,
    // и знать об этом надо из лога, а не по тишине (см. audio.js).
    probeSampleRate();

    report('loading-api');
    const emulators = await loadEmulators();

    report('loading-bundle');
    const bundle = await fetchBundle(doomBundleUrl());

    const userFiles = await buildUserFilesZip(report);

    report('loading-saves');
    const changes = await loadChanges();

    const cycles = clampCycles(settings.cycles);
    const dosboxConf = buildDosboxConf({ cycles });

    // Порядок элементов важен: сначала игра, поверх — пользовательский WAD/EXE,
    // затем сейвы, последней строкой конфиг.
    //   * пользовательские файлы идут ПОСЛЕ бандла — иначе штатный DOOM.EXE из
    //     бандла затёр бы принесённый игроком;
    //   * и ДО сейвов — сейвы правит сама игра, и они должны ложиться последними
    //     из архивов;
    //   * строковый элемент js-dos кладёт в .jsdos/dosbox.conf, поэтому он идёт
    //     последним — так его гарантированно не перекроет содержимое архивов (§5.1).
    const init = [bundle];
    if (userFiles) init.push(userFiles);
    if (changes) init.push(changes);
    init.push(dosboxConf);

    report('booting');
    const ci = await emulators.dosboxWorker(init, {
        audioWorklet: true,
        onExtractProgress: (index, file, extracted, total) => {
            report('extracting', { index, file, extracted, total });
        },
    });

    // Эмулятор уже живой, а `createRenderer()` бросает штатно — на машине без WebGL
    // или при сбое компиляции шейдера (`render.js`). Без этой обёртки исключение
    // ушло бы наверх, оставив за собой работающий воркер, wasm и AudioContext:
    // DOOM продолжал бы крутиться и звучать в фоне, а каждое повторное нажатие
    // «Играть» добавляло бы ещё один осиротевший эмулятор. Путь этот ожидаемый —
    // `session.js` специально распознаёт «WebGL недоступен» в тексте отказа.
    let renderer;
    let audio;
    try {
        renderer = createRenderer(canvas, { box, onFailure: onRenderFailure });
        audio = createAudioControl(ci, Boolean(settings.muted));
    } catch (err) {
        try { await ci.exit(); } catch (exitErr) { logWarn('ci.exit() после сбоя рендера', exitErr); }
        throw err;
    }

    let exited = false;
    let disposed = false;
    // Отдельный флаг от disposed: остановка начинается ДО того, как сессия считается
    // закрытой, иначе persist() внутри stop() отказался бы работать (см. stop()).
    let stopping = false;

    const events = ci.events();
    events.onFrameSize((width, height) => renderer.resize(width, height));
    events.onFrame((rgb) => { if (rgb) renderer.pushFrame(rgb); });
    events.onStdout((message) => logInfo('dosbox:', message.trimEnd()));
    events.onMessage((type, ...args) => {
        // ⚠ Свой отладочный лог DOSBox отдаёт уровнем error, хотя это обычная болтовня
        // работающего эмулятора: «[LOG_SB]DSP:Reset», «INT15:Unknown call BFDE»,
        // «Keyboard layout file auto not found». На исправном запуске DOOM таких строк
        // десятки. Если их пропускать как есть, консоль таверны краснеет на каждом
        // старте, игрок читает это как поломку расширения, а мы теряем возможность
        // требовать от себя тишины в консоли (e2e именно это и проверяет).
        // Поэтому всё, помеченное самим DOSBox как [LOG_*], уходит уровнем info —
        // ровно туда же, куда onStdout. Ошибкой остаётся то, что к нему не относится:
        // сбои самого js-dos.
        const text = args.map((arg) => String(arg)).join(' ');
        if (/^\s*\[LOG_/.test(text)) logInfo('dosbox:', ...args);
        else if (type === 'error') logError('dosbox:', ...args);
        else if (type === 'warn') logWarn('dosbox:', ...args);
        else logInfo('dosbox:', ...args);
    });
    events.onExit(() => {
        exited = true;
        logInfo('эмулятор завершился');
        try { onExit?.(); } catch (err) { logWarn('onExit упал', err); }
    });

    // onFrameSize мог сработать между await dosboxWorker() и подпиской выше —
    // поэтому размер подхватываем вручную сразу же (план §4.4, п.3).
    renderer.resize(ci.width(), ci.height());

    logInfo(`DOOM запущен: ${ci.width()}x${ci.height()}, cycles=${cycles}`);

    /**
     * Сохранение прогресса. persist() не бесплатен — по таймеру его не зовём.
     *
     * Вызовы сериализованы намеренно. Поводов сохраниться три, и они умеют совпасть:
     * закрытие окна (`stop()`), уход со вкладки (`visibilitychange`) и отказ
     * отрисовки. Два `ci.persist()` в полёте одновременно дают две записи в
     * IndexedDB, и в базе останется та, что вернулась последней, — а вернуться
     * последней может более ранняя. Поэтому новый вызов ждёт предыдущий и работает
     * уже с актуальным состоянием файловой системы.
     */
    let persisting = null;
    function persist() {
        const run = (persisting ?? Promise.resolve()).then(async () => {
            // Проверка внутри цепочки, а не снаружи: пока мы ждали предыдущий
            // persist(), сессию могли закрыть.
            if (exited || disposed) return false;
            try {
                const zip = await ci.persist(true);
                return await saveChanges(zip);
            } catch (err) {
                logWarn('persist() не удался', err);
                return false;
            }
        });
        // Хвост цепочки не должен накапливать отказы: run уже ничего не бросает,
        // но пусть звено остаётся нейтральным и после смены реализации.
        persisting = run.catch(() => false);
        return run;
    }

    /** Смена циклов на лету, без перезапуска (план §4.9, рычаг 1). */
    function setCycles(value) {
        const next = clampCycles(value);
        try {
            ci.sendBackendEvent({ type: 'wc-trigger-event', event: `cycles:${next}` });
            logInfo('циклы изменены на', next);
        } catch (err) {
            logWarn('смена циклов не удалась', err);
        }
        return next;
    }

    /**
     * Пропуск кадров эмулятором (план §4.9, рычаг 2).
     *
     * Рычаг заряжен, но ручки к нему в UI нет — и это осознанно. По §4.9 рычаги идут
     * по возрастанию потери качества, а замеры на стенде показали, что рычаг 1
     * (циклы, `setCycles`) до потолка DOOM в 35 тиков/с добирает сам: 35 000 циклов
     * дают 41 кадр/с. Пока циклов хватает, платить за плавность выброшенными кадрами
     * незачем, поэтому в панели настроек выведен только рычаг 1.
     *
     * Экспортируется потому, что это единственный способ дотянуться до `frame_skip`
     * на живой сессии: если на слабой машине циклов не хватит, ручку в панель
     * добавляют здесь же, без раскопок в `sendBackendEvent`. Диапазон 0…10 зажат
     * тут, а не в UI, — по той же причине, что и у циклов.
     */
    function setFrameSkip(value) {
        const next = Math.max(0, Math.min(10, Math.trunc(value) || 0));
        try {
            ci.sendBackendEvent({ type: 'wc-trigger-event', event: `frame_skip:${next}` });
        } catch (err) {
            logWarn('смена frame_skip не удалась', err);
        }
        return next;
    }

    /** Отладочная статистика для оверлея (план §4.9). */
    async function stats() {
        try {
            return await ci.asyncifyStats();
        } catch (err) {
            logWarn('asyncifyStats() недоступен', err);
            return null;
        }
    }

    /** Завершение сессии: сначала сохранить прогресс, потом гасить эмулятор. */
    async function stop() {
        if (disposed || stopping) return;
        stopping = true;
        // Сохраняем ДО того, как поднять disposed: иначе persist() увидит закрытую
        // сессию и молча вернёт false, а прогресс игрока потеряется.
        await persist();
        disposed = true;
        try {
            if (!exited) await ci.exit();
        } catch (err) {
            logWarn('ci.exit() завершился ошибкой', err);
        }
        renderer.dispose();
        logInfo('сессия закрыта');
    }

    return {
        ci,
        renderer,
        audio,
        persist,
        setCycles,
        setFrameSkip,
        stats,
        stop,
        pause: () => { try { ci.pause(); } catch (err) { logWarn('pause() не удался', err); } },
        resume: () => { try { ci.resume(); } catch (err) { logWarn('resume() не удался', err); } },
        get exited() { return exited; },
        get disposed() { return disposed; },
    };
}

// Реэкспорт для тех, кто уже импортирует его отсюда: сама функция переехала в
// config.js, к границам, которые она и стережёт.
export { clampCycles };
