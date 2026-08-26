// Тесты склейки окна и эмулятора (§4.5, §4.7, §4.10). Проверяется порядок событий:
// автостарта нет, неудачный старт возвращает оверлей «Играть», teardown снимает ввод
// и гасит сессию — в том числе осиротевшую, если окно закрыли во время загрузки wasm.
//
// Требуется jsdom: npm install --no-save jsdom
// Запуск: node tests/dos/session.test.mjs

import { JSDOM } from 'jsdom';
import { assert, assertEqual, report, test } from '../_harness.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>');

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

// Контекст таверны: нужен только настройкам расширения.
const context = {
    extensionSettings: {},
    saveSettingsDebounced: () => {},
};
globalThis.SillyTavern = { getContext: () => context };

// WebGL в jsdom нет; сессия сама создаёт канвас, поэтому подменяем getContext
// на прототипе, а не на конкретном элементе.
const noop = () => {};
const glStub = new Proxy({}, {
    get(target, prop) {
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
        if (prop === 'getExtension') return () => null;
        if (typeof prop === 'string' && prop.toUpperCase() === prop) return prop;
        return noop;
    },
});
dom.window.HTMLCanvasElement.prototype.getContext = () => glStub;

// loadEmulators() кеширует промис — объекты ставим один раз, меняя лишь сценарий.
let scenario = null;
globalThis.emulators = { dosboxWorker: (init, options) => scenario.boot(init, options) };
globalThis.fetch = (url) => scenario.fetch(url);
globalThis.indexedDB = undefined;   // сейвов нет — storage.js уходит в fail-soft

const { createDoomSession } = await import('../../src/dos/session.js');
const { QUIET_MS } = await import('../../src/dos/autosave.js');
const { getMasterVolume } = await import('../../src/dos/audio.js');

console.log('dos session');

function makeCi(log) {
    const handlers = {};
    return {
        handlers,
        width: () => 640,
        height: () => 400,
        events: () => ({
            onFrameSize: (fn) => { handlers.frameSize = fn; },
            onFrame: (fn) => { handlers.frame = fn; },
            onStdout: (fn) => { handlers.stdout = fn; },
            onMessage: (fn) => { handlers.message = fn; },
            onExit: (fn) => { handlers.exit = fn; },
        }),
        soundFrequency: () => (scenario.degraded ? 22050 : 0),
        mute: () => log.push('mute'),
        unmute: () => log.push('unmute'),
        pause: () => log.push('pause'),
        resume: () => log.push('resume'),
        sendKeyEvent: () => log.push('key'),
        sendMouseButton: () => log.push('mouse-button'),
        sendMouseRelativeMotion: () => log.push('mouse-motion'),
        sendBackendEvent: (event) => log.push(`backend:${event?.event}`),
        asyncifyStats: async () => ({ cpuMetrics: { cpuUsed: 42 } }),
        persist: async () => { log.push('persist'); return new Uint8Array([1]); },
        exit: async () => { log.push('exit'); },
    };
}

/** Событие указателя: jsdom не строит PointerEvent, собираем вручную. */
function pointerEvent(type, button) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        button: { value: button },
        pointerId: { value: 1 },
        pointerType: { value: 'mouse' },
        clientX: { value: 0 },
        clientY: { value: 0 },
    });
    return event;
}

/** Заглушка refs из shell/modal.js: ровно те поля, которыми пользуется session.js. */
function makeRefs() {
    const stage = document.createElement('div');
    const screen = document.createElement('div');
    const startOverlay = document.createElement('div');
    const sound = document.createElement('button');
    stage.append(screen, startOverlay);
    document.body.append(stage, sound);
    const statuses = [];
    const running = [];
    // Экран отказа (§3.3): окно рисует его само, сюда приходят только текст и кнопки.
    const failure = { shown: false, last: null, hides: 0 };
    const closeRequests = [];
    // Панель настроек живёт в окне и сообщает об изменениях сюда (Фаза 4): содержимое
    // применяет их к живой сессии само.
    const settingsListeners = new Set();
    return {
        stage,
        screen,
        startOverlay,
        buttons: { sound },
        setStatus: (text) => statuses.push(text ?? ''),
        setRunning: (value) => running.push(Boolean(value)),
        showFailure: (options) => { failure.shown = true; failure.last = options; },
        hideFailure: () => { failure.shown = false; failure.hides++; },
        requestClose: () => closeRequests.push(1),
        failure,
        closeRequests,
        onSettingsChange: (fn) => { settingsListeners.add(fn); return () => settingsListeners.delete(fn); },
        emitSettingsChange: (key, value) => { for (const fn of settingsListeners) fn(key, value); },
        settingsListeners,
        statuses,
        running,
        cleanup: () => { stage.remove(); sound.remove(); },
    };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.bundleOk] отдавать ли doom.zip
 * @param {boolean} [opts.deferBoot] не резолвить dosboxWorker сразу (эмуляция долгого wasm)
 */
function setupScenario({ bundleOk = true, deferBoot = false, degraded = false } = {}) {
    const log = [];
    const ci = makeCi(log);
    let releaseBoot = null;
    const booted = new Promise((resolve) => { releaseBoot = () => resolve(ci); });

    context.extensionSettings = {};      // настройки пересоздаются на каждый тест
    scenario = {
        degraded,
        fetch: async () => (bundleOk
            ? { ok: true, arrayBuffer: async () => new Uint8Array([0x50, 0x4b]).buffer }
            : { ok: false, status: 404 }),
        boot: async () => {
            if (deferBoot) return booted;
            return ci;
        },
    };
    return { log, ci, releaseBoot };
}

/** Дать промисам внутри onStart докрутиться: живых таймеров не используем. */
async function settle(times = 12) {
    for (let i = 0; i < times; i++) await Promise.resolve();
    // Считать обороты микрозадач вручную стало ненадёжно: цепочка старта удлиняется
    // (Фаза 6 добавила в неё чтение своих файлов из IndexedDB). Один оборот
    // макрозадач в конце спускает всё, что осталось, сколько бы await там ни было.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
}

function keyEvent() {
    return new dom.window.KeyboardEvent('keydown', {
        code: 'KeyW', key: 'w', bubbles: true, cancelable: true,
    });
}

// --- Автостарта нет -----------------------------------------------------------

await test('§4.5: init() не запускает эмулятор — автостарта нет', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();

    const teardown = session.init(refs);
    await settle();

    assertEqual(log.length, 0, 'эмулятор не тронут');
    assert(refs.screen.querySelector('canvas'), 'игровое поле собрано');
    assertEqual(refs.statuses.at(-1), 'готово к запуску', 'внятный статус ожидания');

    const canvas = refs.screen.querySelector('canvas');
    assertEqual(canvas.width, 320, 'нативная ширина VGA');
    assertEqual(canvas.height, 200, 'нативная высота VGA');
    assertEqual(canvas.tabIndex, 0, 'без tabindex фокуса не будет, а от него зависит §4.7');

    teardown();
    refs.cleanup();
});

await test('§4.5: эмулятор стартует только после onStart (жест игрока нужен звуку)', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);

    session.onStart(refs);
    await settle();

    assertEqual(refs.running.at(-1), true, 'окно перешло в режим «идёт игра»');
    assertEqual(refs.statuses.at(-1), '', 'строка состояния очищена');
    assert(refs.statuses.includes('загрузка эмулятора…'), 'стадии показаны игроку');
    assertEqual(log.filter((l) => l === 'exit').length, 0, 'сессия жива');

    teardown();
    await settle();
    refs.cleanup();
});

await test('§4.7: после успешного старта ввод подключён к игровому полю', async () => {
    setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    const canvas = refs.screen.querySelector('canvas');
    canvas.focus();
    const event = keyEvent();
    window.dispatchEvent(event);
    assert(event.defaultPrevented, 'клавиатура перехвачена');

    const menu = new dom.window.Event('contextmenu', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(menu);
    assert(menu.defaultPrevented, 'правая кнопка не открывает меню браузера (§4.8)');

    teardown();
    await settle();
    refs.cleanup();
});

await test('повторный onStart во время загрузки второй эмулятор не поднимает', async () => {
    const { releaseBoot } = setupScenario({ deferBoot: true });
    let boots = 0;
    const originalBoot = scenario.boot;
    scenario.boot = (...args) => { boots++; return originalBoot(...args); };

    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);

    session.onStart(refs);
    session.onStart(refs);
    await settle();
    session.onStart(refs);
    releaseBoot();
    await settle();

    assertEqual(boots, 1, 'ровно один запуск');
    teardown();
    await settle();
    refs.cleanup();
});

// --- Неудачный старт ----------------------------------------------------------

await test('неудачный старт возвращает оверлей «Играть» и пишет причину', async () => {
    setupScenario({ bundleOk: false });
    const refs = makeRefs();
    refs.startOverlay.hidden = true;    // окно уже спрятало оверлей по клику
    const session = createDoomSession();
    const teardown = session.init(refs);

    session.onStart(refs);
    await settle();

    assertEqual(refs.startOverlay.hidden, false, 'оверлей вернулся — можно попробовать снова');
    assertEqual(refs.running.at(-1), false, 'режим игры выключен');
    const status = refs.statuses.at(-1);
    assert(status && status.length > 0, 'строка состояния не пустая — пустой экран читается как зависание');
    assert(/doom\.zip/.test(status), `внятный текст про бандл, получено «${status}»`);
    assert(/build-bundle/.test(status), 'подсказано, чем чинить');

    teardown();
    refs.cleanup();
});

await test('после неудачи повторный onStart снова пробует запуститься', async () => {
    setupScenario({ bundleOk: false });
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);

    session.onStart(refs);
    await settle();
    let boots = 0;
    const originalBoot = scenario.boot;
    scenario.boot = (...args) => { boots++; return originalBoot(...args); };
    scenario.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });

    session.onStart(refs);
    await settle();
    assertEqual(boots, 1, 'вторая попытка дошла до эмулятора');

    teardown();
    await settle();
    refs.cleanup();
});

// --- Закрытие окна ------------------------------------------------------------

await test('teardown снимает ввод и останавливает сессию', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    const canvas = refs.screen.querySelector('canvas');
    canvas.focus();

    teardown();
    await settle();

    assert(log.includes('persist'), 'прогресс сохранён (§4.10)');
    assert(log.includes('exit'), 'эмулятор погашен');

    const event = keyEvent();
    window.dispatchEvent(event);
    assert(!event.defaultPrevented, 'перехват клавиатуры снят — таверна получила хоткеи обратно');

    const menu = new dom.window.Event('contextmenu', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(menu);
    assert(!menu.defaultPrevented, 'мышь отпущена');

    refs.cleanup();
});

await test('закрытие окна во время загрузки wasm гасит осиротевшую сессию', async () => {
    const { log, releaseBoot } = setupScenario({ deferBoot: true });
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);

    session.onStart(refs);
    await settle();
    assertEqual(log.length, 0, 'эмулятор ещё грузится');

    // Игрок закрыл окно, не дождавшись загрузки.
    teardown();
    releaseBoot();
    await settle();

    assert(log.includes('exit'), 'осиротевшая сессия погашена');
    assert(!refs.running.includes(true), 'режим игры так и не включился');
    refs.cleanup();
});

await test('teardown снимает подписки окна: resize и visibilitychange', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    teardown();
    await settle();
    log.length = 0;

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    window.dispatchEvent(new dom.window.Event('resize'));
    await settle();
    assertEqual(log.length, 0, 'после закрытия окна обработчики молчат');

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    refs.cleanup();
});

// --- Уход со вкладки ----------------------------------------------------------

await test('§4.10: уход со вкладки ставит паузу и сохраняет прогресс', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();
    log.length = 0;

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await settle();
    assert(log.includes('pause'), 'эмулятор на паузе');
    assert(log.includes('persist'), 'прогресс сохранён');

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await settle();
    assert(log.includes('resume'), 'возврат на вкладку снимает паузу');

    teardown();
    await settle();
    refs.cleanup();
});

// --- Звук ---------------------------------------------------------------------

await test('§4.5: кнопка звука применяет настройку к живой сессии', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();
    log.length = 0;

    // Кнопка окна уже переключила настройку — нам остаётся её применить.
    context.extensionSettings.STDoom.sound = false;
    refs.buttons.sound.dispatchEvent(new dom.window.Event('click'));
    assert(log.includes('mute'), 'звук заглушён');

    log.length = 0;
    context.extensionSettings.STDoom.sound = true;
    refs.buttons.sound.dispatchEvent(new dom.window.Event('click'));
    assert(log.includes('unmute'), 'звук возвращён');

    teardown();
    await settle();
    refs.cleanup();
});

await test('§4.5: настройка «звук выключен» глушит эмулятор сразу при старте', async () => {
    const { log } = setupScenario();
    context.extensionSettings.STDoom = { sound: false };
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    assert(log.includes('mute'), 'стартовали без звука');
    teardown();
    await settle();
    refs.cleanup();
});

// --- Самостоятельный выход игры -----------------------------------------------

await test('выход из DOOM через меню сообщается игроку, а не молча', async () => {
    const { ci } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    ci.handlers.exit();
    assertEqual(refs.statuses.at(-1), 'игра завершена', 'статус объясняет, что произошло');
    assertEqual(refs.running.at(-1), false, 'режим игры выключен');

    teardown();
    await settle();
    refs.cleanup();
});

// --- Настройки на лету (Фаза 4) -----------------------------------------------
//
// Смысл панели настроек в том, что её изменения применяются к УЖЕ ЗАПУЩЕННОЙ игре:
// перезапуск DOOM стоил бы игроку партии. Проверяем, что сигнал из окна доезжает
// до нужного рычага рантайма.

await test('§4.9: изменение циклов уходит в эмулятор без перезапуска', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    const bootsBefore = log.filter((l) => l === 'exit').length;
    refs.emitSettingsChange('cycles', 35000);
    assert(log.includes('backend:cycles:35000'), 'циклы отправлены событием wc-trigger-event');
    assertEqual(log.filter((l) => l === 'exit').length, bootsBefore, 'эмулятор при этом не перезапускался');

    teardown();
    await settle();
    refs.cleanup();
});

await test('§4.5: изменение звука в панели глушит и возвращает звук на лету', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    context.extensionSettings.STDoom.sound = false;
    refs.emitSettingsChange('sound', false);
    assert(log.includes('mute'), 'звук выключен');

    log.length = 0;
    context.extensionSettings.STDoom.sound = true;
    refs.emitSettingsChange('sound', true);
    assert(log.includes('unmute'), 'звук включён обратно');

    teardown();
    await settle();
    refs.cleanup();
});

await test('§4.9: отладочный оверлей появляется поверх сцены и убирается', async () => {
    setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    assert(!refs.stage.querySelector('.stdoom-debug'), 'по умолчанию оверлея нет');

    context.extensionSettings.STDoom.debugOverlay = true;
    refs.emitSettingsChange('debugOverlay', true);
    await settle();
    const overlay = refs.stage.querySelector('.stdoom-debug');
    assert(overlay, 'оверлей вставлен в сцену, а не в поле — иначе поехал бы с леттербоксом');
    assertEqual(overlay.hidden, false, 'оверлей виден');
    assert(/cpuUsed/.test(overlay.textContent), 'цифры из asyncifyStats() показаны');

    context.extensionSettings.STDoom.debugOverlay = false;
    refs.emitSettingsChange('debugOverlay', false);
    assertEqual(overlay.hidden, true, 'оверлей убран');

    teardown();
    await settle();
    assert(!overlay.isConnected, 'после закрытия окна оверлея не осталось');
    refs.cleanup();
});

// --- Тач-контролы (Фаза 5) ----------------------------------------------------
//
// Под jsdom сенсора нет (navigator.maxTouchPoints = 0), поэтому авто-режим здесь
// тач не включает — это и проверяем заодно: на десктопе кнопки поверх картинки
// были бы чистой помехой.

await test('§6: на устройстве без сенсора авто-режим тач не включает', async () => {
    setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    assert(!refs.stage.querySelector('.stdoom-touch'), 'оверлея тача нет');
    teardown();
    await settle();
    refs.cleanup();
});

await test('§6: режим «всегда включены» кладёт тач-оверлей поверх сцены', async () => {
    setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    context.extensionSettings.STDoom.touchControls = 'on';
    refs.emitSettingsChange('touchControls', 'on');
    await settle();

    const overlay = refs.stage.querySelector('.stdoom-touch');
    assert(overlay, 'оверлей в сцене, а не в игровом поле — иначе поехал бы с леттербоксом');
    assertEqual(overlay.hidden, false, 'контролы видны');

    // Обратно: игрок передумал.
    context.extensionSettings.STDoom.touchControls = 'off';
    refs.emitSettingsChange('touchControls', 'off');
    await settle();
    assert(!refs.stage.querySelector('.stdoom-touch'), 'оверлей убран целиком');

    teardown();
    await settle();
    refs.cleanup();
});

await test('§6: teardown уносит тач-оверлей вместе с окном', async () => {
    setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    context.extensionSettings.STDoom.touchControls = 'on';
    refs.emitSettingsChange('touchControls', 'on');
    await settle();
    const overlay = refs.stage.querySelector('.stdoom-touch');
    assert(overlay, 'оверлей есть');

    teardown();
    await settle();
    assert(!overlay.isConnected, 'после закрытия окна разметки не осталось');
    refs.cleanup();
});

await test('teardown отписывается от настроек: закрытое окно ничего не применяет', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    teardown();
    await settle();
    assertEqual(refs.settingsListeners.size, 0, 'подписчик снят');

    log.length = 0;
    refs.emitSettingsChange('cycles', 60000);
    assertEqual(log.length, 0, 'в мёртвую сессию ничего не ушло');
    refs.cleanup();
});

// --- Экран отказа при повторяющихся ошибках кадра (§3.3) ----------------------
//
// Кадр «ломается» самым дешёвым способом: он длиннее ожидаемого, а его subarray()
// бросает — draw() падает ровно там, где в жизни падает потерянный контекст WebGL.
// Порог рендерера — 30 ошибок подряд.

/** Гоняет `count` сломанных кадров через ci, прокручивая rAF вручную. */
function pumpBrokenFrames(ci, queue, count) {
    const broken = new Uint8Array(640 * 400 * 3 + 1);
    Object.defineProperty(broken, 'subarray', {
        value: () => { throw new Error('контекст потерян'); },
    });
    for (let i = 0; i < count; i++) {
        ci.handlers.frame(broken);
        for (const fn of queue.splice(0)) fn();
    }
}

/** Тело теста с ручным rAF: без него кадры не сдвинутся с места. */
async function withManualRaf(body) {
    const savedRaf = globalThis.requestAnimationFrame;
    const savedCancel = globalThis.cancelAnimationFrame;
    const queue = [];
    globalThis.requestAnimationFrame = (fn) => queue.push(fn);
    globalThis.cancelAnimationFrame = () => {};
    try {
        await body(queue);
    } finally {
        globalThis.requestAnimationFrame = savedRaf;
        globalThis.cancelAnimationFrame = savedCancel;
    }
}

await test('§3.3: отказ отрисовки ставит паузу, сохраняет прогресс и объясняет игроку', async () => {
    await withManualRaf(async (queue) => {
        const { log, ci } = setupScenario();
        const refs = makeRefs();
        const session = createDoomSession();
        const teardown = session.init(refs);
        session.onStart(refs);
        await settle();
        log.length = 0;

        pumpBrokenFrames(ci, queue, 29);
        assertEqual(refs.failure.shown, false, 'до порога экрана нет');

        pumpBrokenFrames(ci, queue, 1);
        await settle();

        assert(refs.failure.shown, 'экран отказа показан — замерший кадр читается как зависание');
        assert(log.includes('pause'), 'эмулятор на паузе: крутить его вслепую незачем');
        assert(log.includes('persist'), 'прогресс сохранён');

        const { title, text, actions } = refs.failure.last;
        assert(title && title.length > 0, 'заголовок есть');
        assert(/30/.test(text), 'сказано, сколько раз сломалось');
        assert(/сохранён/.test(text), 'сказано, что прогресс цел');
        assert(/консол/i.test(text), 'сказано, где искать подробности');
        assertEqual(actions.length, 2, 'два выхода: продолжить и закрыть');
        assertEqual(actions[0].label, 'Продолжить', 'первая кнопка');
        assertEqual(actions[1].label, 'Закрыть', 'вторая кнопка');

        // Серия продолжается — второй раз экран не переоткрываем.
        refs.failure.shown = false;
        pumpBrokenFrames(ci, queue, 10);
        assertEqual(refs.failure.shown, false, 'на продолжении серии экран не мигает');

        teardown();
        await settle();
        refs.cleanup();
    });
});

await test('§3.3: «Продолжить» убирает экран и снимает паузу', async () => {
    await withManualRaf(async (queue) => {
        const { log, ci } = setupScenario();
        const refs = makeRefs();
        const session = createDoomSession();
        const teardown = session.init(refs);
        session.onStart(refs);
        await settle();

        pumpBrokenFrames(ci, queue, 30);
        await settle();
        assert(refs.failure.shown, 'экран показан');

        log.length = 0;
        refs.failure.last.actions[0].onClick();
        assertEqual(refs.failure.shown, false, 'экран убран');
        assert(log.includes('resume'), 'эмулятор снова считает');
        assertEqual(refs.statuses.at(-1), '', 'строка состояния очищена');

        // Рендеру дан ещё шанс, и счётчик ошибок сброшен вместе с защёлкой: успешного
        // кадра, который снял бы её сам, на сломанном рендере может не случиться
        // никогда — тогда игрок остался бы с замершей картинкой и без единого слова.
        pumpBrokenFrames(ci, queue, 29);
        assertEqual(refs.failure.shown, false, 'частичная серия экран не поднимает');
        pumpBrokenFrames(ci, queue, 1);
        await settle();
        assert(refs.failure.shown, 'новый набор порога — новый экран, а не тишина');

        teardown();
        await settle();
        refs.cleanup();
    });
});

await test('§3.3: «Закрыть» просит окно закрыться', async () => {
    await withManualRaf(async (queue) => {
        const { ci } = setupScenario();
        const refs = makeRefs();
        const session = createDoomSession();
        const teardown = session.init(refs);
        session.onStart(refs);
        await settle();

        pumpBrokenFrames(ci, queue, 30);
        await settle();
        refs.failure.last.actions[1].onClick();
        assertEqual(refs.closeRequests.length, 1, 'запрошено закрытие окна');

        teardown();
        await settle();
        refs.cleanup();
    });
});



await test('падение проводки ввода не запирает кнопку «Играть» навсегда', async () => {
    const { log } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);

    // Ломаем то, что делается ПОСЛЕ присвоения сессии: раньше такой бросок уходил в
    // общий catch, тот возвращал оверлей «Играть», а гвард `if (starting || doom)`
    // навсегда запрещал повторный запуск — игрок получал кнопку, которая молча не
    // делает ничего, и наполовину подключённый ввод.
    // Ломаем ровно один раз: тот же setRunning(false) зовётся и на пути отката,
    // а падать там — значит проверять не то.
    let broken = false;
    const brokenRefs = {
        ...refs,
        setRunning: (value) => {
            if (!broken) { broken = true; throw new Error('проводка сломалась'); }
            refs.setRunning(value);
        },
    };
    session.onStart(brokenRefs);
    await settle();

    assertEqual(refs.startOverlay.hidden, false, 'оверлей «Играть» возвращён');
    assert(log.includes('exit'), 'недособранная сессия погашена, а не брошена жить');

    // И вторая попытка действительно стартует.
    refs.running.length = 0;
    session.onStart(refs);
    await settle();
    assertEqual(refs.running.at(-1), true, 'повторный запуск прошёл, игра идёт');

    teardown();
    await settle();
    refs.cleanup();
});

await test('§3.3: экран отказа снимает ввод — иначе до его кнопок не добраться', async () => {
    await withManualRaf(async (queue) => {
        const { log, ci } = setupScenario();
        const refs = makeRefs();
        const session = createDoomSession();
        const teardown = session.init(refs);
        session.onStart(refs);
        await settle();

        const canvas = refs.screen.querySelector('canvas');
        // Мышь на месте: клик по полю доходит до эмулятора.
        document.body.focus();
        Object.defineProperty(document, 'pointerLockElement', {
            configurable: true, get: () => canvas,
        });
        canvas.dispatchEvent(pointerEvent('pointerdown', 0));
        assert(log.includes('mouse-button'), 'до отказа ввод работает');

        // Экран отказа лежит ВНУТРИ сцены, а ввод перехватывает события раньше, чем
        // они дойдут до его кнопок: тач глушит касание на самой сцене (правило 18),
        // а при активном Pointer Lock курсора на экране нет вовсе. Пауза сама по себе
        // ввод не снимает — isActive() смотрит только на disposed.
        pumpBrokenFrames(ci, queue, 30);
        await settle();
        assert(refs.failure.shown, 'экран показан');

        log.length = 0;
        canvas.dispatchEvent(pointerEvent('pointerdown', 0));
        assert(!log.includes('mouse-button'), 'пока экран висит, клики в игру не идут');

        // «Продолжить» возвращает ввод обратно.
        refs.failure.last.actions[0].onClick();
        log.length = 0;
        canvas.dispatchEvent(pointerEvent('pointerdown', 0));
        assert(log.includes('mouse-button'), 'после «Продолжить» ввод вернулся');

        delete document.pointerLockElement;
        teardown();
        await settle();
        refs.cleanup();
    });
});

await test('§3.3: после закрытия окна экран отказа убран и больше не показывается', async () => {
    await withManualRaf(async (queue) => {
        const { ci, log } = setupScenario();
        const refs = makeRefs();
        const session = createDoomSession();
        const teardown = session.init(refs);
        session.onStart(refs);
        await settle();

        pumpBrokenFrames(ci, queue, 30);
        await settle();
        assert(refs.failure.shown, 'экран показан на живом окне');

        teardown();
        await settle();
        assertEqual(refs.failure.shown, false, 'закрытие окна унесло экран с собой');
        assert(refs.failure.hides > 0, 'hideFailure вызван уборкой');

        // Кадры после закрытия окна: ни экрана, ни обращений к мёртвой сессии.
        log.length = 0;
        pumpBrokenFrames(ci, queue, 60);
        await settle();
        assertEqual(refs.failure.shown, false, 'в закрытое окно ничего не показываем');
        assertEqual(log.filter((l) => l === 'pause' || l === 'persist').length, 0,
            'мёртвую сессию не трогаем');

        refs.cleanup();
    });
});

// --- Геймпад (Фаза 6) ---------------------------------------------------------
//
// Здесь проверяется только ПРОВОДКА: что сессия подключает опрос и снимает его при
// закрытии окна. Сама математика и слой опроса покрыты в tests/input/gamepad*.
// Кадр rAF на время теста делаем ручным — иначе цикл опроса не сдвинется с места.

await test('§7: сессия подключает опрос геймпада, teardown его снимает', async () => {
    const { log } = setupScenario();

    const frames = [];
    const savedRaf = globalThis.requestAnimationFrame;
    const savedCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => frames.push(fn);
    globalThis.cancelAnimationFrame = () => {};

    // Правый стик отклонён вправо: единственная ось, которая доезжает до игры (§7).
    const pad = { index: 0, connected: true, mapping: 'standard', axes: [0, 0, 1, 0], buttons: [] };
    // gamepad.js обращается к голому navigator, то есть к глобальному объекту node,
    // а не к navigator из jsdom: getGamepads вешаем именно туда.
    Object.defineProperty(globalThis.navigator, 'getGamepads', {
        value: () => [pad],
        configurable: true,
    });

    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    log.length = 0;
    // Два кадра: первому не с чем сравнить время, дельту даёт только второй.
    pumpFrames(frames, 2);
    assert(log.includes('mouse-motion'), 'отклонённый стик доехал до sendMouseRelativeMotion');

    teardown();
    await settle();

    log.length = 0;
    pumpFrames(frames, 2);
    assertEqual(log.filter((e) => e === 'mouse-motion').length, 0,
        'после закрытия окна опрос не шлёт в мёртвую сессию');

    globalThis.requestAnimationFrame = savedRaf;
    globalThis.cancelAnimationFrame = savedCancel;
    delete globalThis.navigator.getGamepads;
    refs.cleanup();
});

// Ручная прокрутка кадров: очередь, а не рекурсия, — цикл ставит следующий кадр
// прямо изнутри текущего, и без снятия очереди получилась бы бесконечная петля.
function pumpFrames(frames, count) {
    let time = 1000;
    for (let i = 0; i < count; i++) {
        const queued = frames.splice(0);
        time += 16;
        for (const fn of queued) fn(time);
    }
}

// --- Сохранение по факту сохранения в игре (§4.10) ----------------------------

await test('§4.10: F2 доводит прогресс до хранилища, не дожидаясь закрытия окна', async () => {
    const { log, ci } = setupScenario();
    const refs = makeRefs();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    const canvas = refs.screen.querySelector('canvas');
    canvas.focus();

    // Обычная игра ничего не сохраняет: persist() не бесплатен (§4.10).
    window.dispatchEvent(keyEvent());
    await settle();
    assertEqual(log.filter((l) => l === 'persist').length, 0, 'по игровым клавишам не сохраняем');

    // F2 открыла меню сохранения — сама по себе она ещё ничего не значит: файл
    // пишется в конце цепочки «слот → имя → Enter».
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        code: 'F2', key: 'F2', bubbles: true, cancelable: true,
    }));
    await settle();
    assertEqual(log.filter((l) => l === 'persist').length, 0, 'по самой F2 ещё не сохраняем');

    // Тишина после последнего нажатия — считаем, что запись состоялась. Ждём событие,
    // а не «столько-то миллисекунд»: часы под нагрузкой врут, а фиксированная пауза
    // превратила бы этот тест в мигающий.
    for (let waited = 0; waited < 5000 && !log.includes('persist'); waited += 50) {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        await settle();
    }
    assertEqual(log.filter((l) => l === 'persist').length, 1, 'прогресс уехал в хранилище');

    // Это и есть смысл механизма: сейв доехал ДО того, как игрок вышел из DOOM его
    // собственным меню. После выхода эмулятор мёртв и persist() бессмысленен.
    const before = log.filter((l) => l === 'persist').length;
    ci.handlers.exit();
    await settle();
    teardown();
    await settle();
    assert(log.filter((l) => l === 'persist').length >= before, 'сохранённое не потеряно');

    refs.cleanup();
});

await test('громкость применяется к живой сессии и не требует перезапуска', async () => {
    const refs = makeRefs();
    setupScenario();
    const session = createDoomSession();
    const teardown = session.init(refs);
    session.onStart(refs);
    await settle();

    // Регулятора громкости у эмулятора нет — это наш GainNode, и настройка обязана
    // доезжать до него на лету, как чувствительность мыши, а не при следующем запуске.
    context.extensionSettings.STDoom.volume = 30;
    refs.emitSettingsChange('volume', 30);
    assertEqual(getMasterVolume(), 0.3, 'проценты переведены в долю и применены');

    context.extensionSettings.STDoom.volume = 0;
    refs.emitSettingsChange('volume', 0);
    assertEqual(getMasterVolume(), 0, 'тишина — тоже допустимое значение');

    teardown();
    await settle();
    refs.cleanup();
});


report('dos session');
