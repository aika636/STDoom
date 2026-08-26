// Тесты слоя опроса Gamepad API (§7). Математика проверяется отдельно, в
// gamepad-math.test.mjs; здесь стерегутся инварианты склейки:
//
//   — второй аргумент sendMouseRelativeMotion ВСЕГДА 0 (§4.8, браузерный novert);
//   — клавиши уходят кодами GLFW через тот же codeToGlfw, что и клавиатура (§4.6);
//   — при любом обрыве (отключение геймпада, blur, detach) нажатое отпускается;
//   — без геймпада цикл rAF не крутится и ничего не падает.
//
// jsdom не нужен: Gamepad API он всё равно не реализует, а requestAnimationFrame нам
// нужен управляемый вручную — иначе тест зависит от таймеров.
// Запуск: node tests/input/gamepad.test.mjs

import { assert, assertEqual, report, test } from '../_harness.mjs';
import { createKeyBus } from '../../src/input/key-bus.js';
import { GLFW, codeToGlfw } from '../../src/dos/keys.js';

// --- Поддельное окружение ------------------------------------------------------

class FakeTarget {
    constructor() {
        this.listeners = new Map();
    }

    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
    }

    removeEventListener(type, fn) {
        this.listeners.get(type)?.delete(fn);
    }

    dispatch(type, event = {}) {
        // Копия набора: обработчик вправе отписаться прямо во время вызова.
        for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    }

    count(type) {
        return this.listeners.get(type)?.size ?? 0;
    }
}

const fakeWindow = new FakeTarget();
const fakeDocument = new FakeTarget();
fakeDocument.hidden = false;

/** Очередь кадров: тест сам решает, когда наступил следующий кадр и с какой меткой. */
const frames = new Map();
let nextFrameId = 1;
let cancelled = 0;

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
globalThis.requestAnimationFrame = (cb) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
};
globalThis.cancelAnimationFrame = (id) => {
    cancelled++;
    frames.delete(id);
};

/** @type {Array<object|null>} что вернёт navigator.getGamepads() */
let pads = [];
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { getGamepads: () => pads },
});

const { createGamepad, AXES, BUTTON_KEYS, MAX_DT } = await import('../../src/input/gamepad.js');

console.log('input gamepad');

/** Выполняет все запланированные кадры с указанной меткой времени. */
function tick(now) {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, cb] of pending) cb(now);
}

function pendingFrames() {
    return frames.size;
}

/**
 * @param {object} opts
 * @param {number[]} [opts.axes] [leftX, leftY, rightX, rightY]
 * @param {number[]} [opts.buttons] значения кнопок 0..1
 */
function makePad({ axes = [0, 0, 0, 0], buttons = [], index = 0 } = {}) {
    const size = Math.max(buttons.length, 16);
    return {
        index,
        id: 'тестовый геймпад',
        connected: true,
        axes: axes.slice(),
        buttons: Array.from({ length: size }, (_, i) => ({
            pressed: (buttons[i] ?? 0) > 0.5,
            value: buttons[i] ?? 0,
        })),
    };
}

function makeCi() {
    const motions = [];
    const keys = [];
    return {
        motions,
        keys,
        sendMouseRelativeMotion: (x, y) => motions.push({ x, y }),
        sendKeyEvent: (code, down) => keys.push({ code, down }),
        down(code) {
            return keys.filter((k) => k.code === code && k.down === true).length;
        },
        up(code) {
            return keys.filter((k) => k.code === code && k.down === false).length;
        },
    };
}

function setup({ pad = makePad(), isActive = () => true, sensitivity = 1 } = {}) {
    frames.clear();
    cancelled = 0;
    fakeDocument.hidden = false;
    pads = pad ? [pad] : [];
    const ci = makeCi();
    const gamepad = createGamepad({ ci, keys: createKeyBus({ ci }).owner('gamepad'), isActive, getSensitivity: () => sensitivity });
    gamepad.attach();
    return { ci, gamepad, pad };
}

/** Первый кадр всегда даёт dt = 0 — прогоняем его, чтобы дальше время было настоящим. */
function warmup() {
    tick(1000);
}

// --- Раскладка кнопок ----------------------------------------------------------

test('§7: все кнопки маппятся в известные коды GLFW — раскладка не двоится', () => {
    for (const [index, code] of Object.entries(BUTTON_KEYS)) {
        assert(codeToGlfw(code) != null, `кнопка ${index} → неизвестный код ${code}`);
    }
});

test('§7: в раскладке есть огонь, use, карта, меню и все семь стволов', () => {
    const codes = new Set(Object.values(BUTTON_KEYS));
    assert(codes.has('ControlLeft'), 'огонь (Ctrl)');
    assert(codes.has('Space'), 'use / дверь (Space)');
    assert(codes.has('Tab'), 'карта (Tab)');
    assert(codes.has('Escape'), 'меню (Esc)');
    for (let i = 1; i <= 7; i++) {
        assert(codes.has(`Digit${i}`), `оружие ${i} — у джойстика DOS его нет вообще`);
    }
});

// --- Правый стик: главный инвариант --------------------------------------------

test('§4.8/§7: правый стик шлёт поворот со вторым аргументом РОВНО 0', () => {
    const { ci, gamepad, pad } = setup();
    pad.axes[AXES.rightX] = 1;
    pad.axes[AXES.rightY] = 1;   // вертикаль отклонена на упор — и всё равно выбрасывается
    warmup();
    tick(1016);
    tick(1032);

    assert(ci.motions.length >= 2, 'повороты пошли');
    for (const m of ci.motions) {
        assertEqual(m.y, 0, 'вертикаль всегда ноль (браузерный novert)');
        assert(m.x > 0, 'поворот направо');
    }
    gamepad.detach();
});

test('§7: отклонение только по Y правого стика не даёт вообще ничего', () => {
    const { ci, gamepad, pad } = setup();
    pad.axes[AXES.rightY] = -1;
    warmup();
    tick(1016);
    tick(1032);
    assertEqual(ci.motions.length, 0, 'свободного взгляда нет — движения нет');
    gamepad.detach();
});

test('§7: мёртвая зона — стик в покое не даёт дрейфа', () => {
    const { ci, gamepad, pad } = setup();
    pad.axes[AXES.rightX] = 0.05;
    warmup();
    for (let i = 1; i <= 30; i++) tick(1000 + i * 16);
    assertEqual(ci.motions.length, 0, 'дрожь стика в игру не уходит');
    gamepad.detach();
});

test('§7: дельта пропорциональна времени кадра — интегрирование идёт по dt', () => {
    const { ci, gamepad, pad } = setup();
    pad.axes[AXES.rightX] = 1;
    warmup();
    tick(1100);   // dt зажат MAX_DT
    const big = ci.motions.at(-1).x;
    ci.motions.length = 0;
    tick(1105);   // dt = 5 мс
    const small = ci.motions.length ? ci.motions.at(-1).x : 0;
    assert(big > small, `длинный кадр поворачивает сильнее: ${big} против ${small}`);
    assert(big <= MAX_DT * 900 + 1, 'dt зажат сверху — фон не превращается в рывок');
    gamepad.detach();
});

test('§7: множитель чувствительности масштабирует поворот', () => {
    const slow = setup({ sensitivity: 0.25 });
    slow.pad.axes[AXES.rightX] = 1;
    tick(1000);
    tick(1016);
    const slowX = slow.ci.motions.at(-1)?.x ?? 0;
    slow.gamepad.detach();

    const fast = setup({ sensitivity: 2 });
    fast.pad.axes[AXES.rightX] = 1;
    tick(1000);
    tick(1016);
    const fastX = fast.ci.motions.at(-1)?.x ?? 0;
    fast.gamepad.detach();

    assert(fastX > slowX, `чувствительнее — быстрее: ${fastX} против ${slowX}`);
});

// --- Левый стик → клавиши ------------------------------------------------------

test('§7: левый стик вперёд даёт GLFW-код W, возврат в центр — отпускание', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.axes[AXES.leftY] = -1;   // ось Y геймпада направлена вниз, вверх — минус
    tick(1016);
    assertEqual(ci.down(GLFW.W), 1, 'W нажата ровно один раз');
    assertEqual(ci.up(GLFW.W), 0, 'и пока не отпущена');

    pad.axes[AXES.leftY] = 0;
    tick(1032);
    assertEqual(ci.up(GLFW.W), 1, 'вернули стик — отпустили W');
    gamepad.detach();
});

test('§7: диагональ влево-назад даёт сразу A и S', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.axes[AXES.leftX] = -1;
    pad.axes[AXES.leftY] = 1;
    tick(1016);
    assertEqual(ci.down(GLFW.A), 1, 'стрейф влево');
    assertEqual(ci.down(GLFW.S), 1, 'назад');
    assertEqual(ci.down(GLFW.D), 0, 'вправо не жмём');
    gamepad.detach();
});

test('§7: удержание стика не сыплет повторными нажатиями каждый кадр', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.axes[AXES.leftY] = -1;
    for (let i = 1; i <= 10; i++) tick(1000 + i * 16);
    assertEqual(ci.down(GLFW.W), 1, 'одно нажатие на всё удержание');
    gamepad.detach();
});

// --- Кнопки --------------------------------------------------------------------

test('§7: правый курок — огонь (левый Ctrl), отпускание доходит', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.buttons[7] = { pressed: true, value: 1 };
    tick(1016);
    assertEqual(ci.down(GLFW.LEFT_CONTROL), 1, 'огонь пошёл');

    pad.buttons[7] = { pressed: false, value: 0 };
    tick(1032);
    assertEqual(ci.up(GLFW.LEFT_CONTROL), 1, 'огонь прекращён');
    gamepad.detach();
});

test('§7: A — use/дверь (Space), крестовина влево — дробовик (клавиша 3)', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.buttons[0] = { pressed: true, value: 1 };
    pad.buttons[14] = { pressed: true, value: 1 };
    tick(1016);
    assertEqual(ci.down(GLFW.SPACE), 1, 'дверь открывается Space');
    assertEqual(ci.down(GLFW.D3), 1, 'оружие выбирается цифрой');
    gamepad.detach();
});

test('§7: две кнопки на одну клавишу — отпускание одной огонь не гасит', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.buttons[7] = { pressed: true, value: 1 };   // RT — огонь
    tick(1016);
    pad.buttons[1] = { pressed: true, value: 1 };   // B — дубль огня
    tick(1032);
    assertEqual(ci.down(GLFW.LEFT_CONTROL), 1, 'второй источник лишнего нажатия не шлёт');

    pad.buttons[7] = { pressed: false, value: 0 };
    tick(1048);
    assertEqual(ci.up(GLFW.LEFT_CONTROL), 0, 'вторая кнопка ещё держит огонь');

    pad.buttons[1] = { pressed: false, value: 0 };
    tick(1064);
    assertEqual(ci.up(GLFW.LEFT_CONTROL), 1, 'отпустили обе — огонь прекращён');
    gamepad.detach();
});

test('§7: аналоговый курок без флага pressed считывается по значению', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.buttons[6] = { pressed: false, value: 0.9 };
    tick(1016);
    assertEqual(ci.down(GLFW.D7), 1, 'курок нажат по величине');
    gamepad.detach();
});

// --- Обрывы: залипшая клавиша страшнее всего ------------------------------------

test('§7: отключение геймпада отпускает ВСЁ нажатое и останавливает цикл', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.axes[AXES.leftY] = -1;
    pad.buttons[7] = { pressed: true, value: 1 };
    tick(1016);
    assertEqual(ci.down(GLFW.W) + ci.down(GLFW.LEFT_CONTROL), 2, 'зажали движение и огонь');

    pads = [];
    fakeWindow.dispatch('gamepaddisconnected', { gamepad: pad });

    assertEqual(ci.up(GLFW.W), 1, 'W отпущена — иначе бежит в стену');
    assertEqual(ci.up(GLFW.LEFT_CONTROL), 1, 'огонь отпущен');
    assertEqual(gamepad.heldCount, 0, 'ничего не осталось зажатым');
    assertEqual(gamepad.polling, false, 'цикл встал — опрашивать некого');
    gamepad.detach();
});

test('§7: исчезнувший из getGamepads() геймпад тоже отпускает всё', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.buttons[0] = { pressed: true, value: 1 };
    tick(1016);
    assertEqual(ci.down(GLFW.SPACE), 1, 'кнопка нажата');

    pads = [];   // событие не пришло (бывает), но опрос уже пустой
    tick(1032);
    assertEqual(ci.up(GLFW.SPACE), 1, 'кнопка отпущена');
    assertEqual(pendingFrames(), 0, 'цикл не крутится без геймпада');
    gamepad.detach();
});

test('§7: уход фокуса окна отпускает всё и гасит опрос', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.axes[AXES.leftY] = -1;
    tick(1016);
    fakeWindow.dispatch('blur');
    assertEqual(ci.up(GLFW.W), 1, 'клавиша отпущена при потере фокуса');
    assertEqual(pendingFrames(), 0, 'кадры больше не планируются');

    // Фокус вернулся — опрос поднимается сам, руками ничего дёргать не надо.
    fakeWindow.dispatch('focus');
    assertEqual(pendingFrames(), 1, 'цикл восстановлен');
    gamepad.detach();
});

test('§7: скрытая вкладка отпускает всё, возврат вкладки поднимает опрос', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.buttons[7] = { pressed: true, value: 1 };
    tick(1016);

    fakeDocument.hidden = true;
    fakeDocument.dispatch('visibilitychange');
    assertEqual(ci.up(GLFW.LEFT_CONTROL), 1, 'огонь не остаётся зажатым в фоне');
    assertEqual(pendingFrames(), 0, 'опрос остановлен');

    fakeDocument.hidden = false;
    fakeDocument.dispatch('visibilitychange');
    assertEqual(pendingFrames(), 1, 'опрос возобновлён');
    gamepad.detach();
});

test('смена устройства сбрасывает состояние прежнего', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.axes[AXES.leftY] = -1;
    tick(1016);
    assertEqual(ci.down(GLFW.W), 1, 'первый геймпад ведёт вперёд');

    pads = [makePad({ index: 3 })];
    tick(1032);
    assertEqual(ci.up(GLFW.W), 1, 'состояние старого устройства снято');
    gamepad.detach();
});

// --- Жизненный цикл ------------------------------------------------------------

test('§7: без геймпада цикл не крутится и ничего не падает', () => {
    const { ci, gamepad } = setup({ pad: null });
    assertEqual(pendingFrames(), 0, 'ни одного кадра не запланировано');
    assertEqual(ci.keys.length, 0, 'в игру ничего не ушло');
    assertEqual(ci.motions.length, 0, 'поворотов нет');

    // Подключение геймпада поднимает опрос.
    pads = [makePad()];
    fakeWindow.dispatch('gamepadconnected', { gamepad: pads[0] });
    assertEqual(pendingFrames(), 1, 'цикл стартовал по событию');
    gamepad.detach();
});

test('§7: getGamepads(), которого нет или который бросает, не роняет опрос', () => {
    const saved = navigator.getGamepads;
    navigator.getGamepads = () => { throw new Error('Gamepad API запрещён политикой'); };
    const { ci, gamepad } = setup();
    tick(1000);
    assertEqual(ci.keys.length, 0, 'молчим, но живём');
    gamepad.detach();

    delete navigator.getGamepads;
    const secondCi = makeCi();
    const second = createGamepad({ ci: secondCi, keys: createKeyBus({ ci: secondCi }).owner('gamepad'), isActive: () => true });
    second.attach();
    tick(1000);
    second.detach();
    navigator.getGamepads = saved;
});

test('§7: неактивная сессия останавливает цикл и отпускает нажатое', () => {
    let alive = true;
    const { ci, gamepad, pad } = setup({ isActive: () => alive });
    warmup();
    pad.axes[AXES.leftY] = -1;
    tick(1016);
    assertEqual(ci.down(GLFW.W), 1, 'пока сессия жива — управляем');

    alive = false;
    tick(1032);
    assertEqual(ci.up(GLFW.W), 1, 'сессия умерла — клавиши отпущены');
    assertEqual(pendingFrames(), 0, 'цикл встал');
    gamepad.detach();
});

test('detach() останавливает цикл, снимает обработчики и отпускает всё', () => {
    const { ci, gamepad, pad } = setup();
    warmup();
    pad.axes[AXES.leftY] = -1;
    pad.buttons[7] = { pressed: true, value: 1 };
    tick(1016);
    ci.keys.length = 0;
    ci.motions.length = 0;

    const before = cancelled;
    gamepad.detach();
    assertEqual(gamepad.attached, false, 'снят');
    assert(cancelled > before, 'запланированный кадр отменён');
    assertEqual(pendingFrames(), 0, 'кадров не осталось');
    assert(ci.keys.every((k) => k.down === false), 'все события — отпускания');
    assertEqual(gamepad.heldCount, 0, 'ничего не зажато');

    // Обработчики сняты: событий больше не слушаем, цикл не воскресает.
    fakeWindow.dispatch('gamepadconnected', { gamepad: pad });
    fakeWindow.dispatch('focus');
    fakeDocument.dispatch('visibilitychange');
    assertEqual(pendingFrames(), 0, 'после detach цикл не поднимается');
    assertEqual(fakeWindow.count('blur'), 0, 'обработчик blur снят');
    assertEqual(fakeDocument.count('visibilitychange'), 0, 'обработчик вкладки снят');
});

test('повторный attach() не дублирует ни обработчики, ни кадры', () => {
    const { gamepad } = setup();
    gamepad.attach();
    assertEqual(pendingFrames(), 1, 'ровно один запланированный кадр');
    assertEqual(fakeWindow.count('blur'), 1, 'один обработчик blur');
    gamepad.detach();
});

test('падение вызовов ci не роняет кадр опроса', () => {
    frames.clear();
    pads = [makePad({ axes: [0, -1, 1, 0], buttons: [1] })];
    const ci = {
        sendMouseRelativeMotion: () => { throw new Error('сессия закрыта'); },
        sendKeyEvent: () => { throw new Error('сессия закрыта'); },
    };
    const gamepad = createGamepad({ ci, keys: createKeyBus({ ci }).owner('gamepad'), isActive: () => true, getSensitivity: () => 1 });
    gamepad.attach();
    tick(1000);
    tick(1016);
    assertEqual(pendingFrames(), 1, 'опрос продолжается несмотря на ошибки');
    gamepad.detach();
});

report('input gamepad');
