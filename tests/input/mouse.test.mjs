// Тесты мыши и Pointer Lock. Главный инвариант: movementY не пробрасывается
// ВООБЩЕ — второй аргумент sendMouseRelativeMotion всегда 0 (браузерный novert).
//
// Требуется jsdom: npm install --no-save jsdom
// Запуск: node tests/input/mouse.test.mjs

import { JSDOM } from 'jsdom';
import { assert, assertEqual, report, test } from '../_harness.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const { createMouse, MAX_DELTA } = await import('../../src/input/mouse.js');

console.log('input mouse');

// Pointer Lock в jsdom не реализован: подменяем document.pointerLockElement и
// element.requestPointerLock вручную — так тест остаётся детерминированным.
let lockElement = null;
Object.defineProperty(document, 'pointerLockElement', {
    configurable: true,
    get: () => lockElement,
});
document.exitPointerLock = () => { lockElement = null; };

function makeCi() {
    const motions = [];
    const buttons = [];
    return {
        motions,
        buttons,
        sendMouseRelativeMotion: (x, y) => motions.push({ x, y }),
        sendMouseButton: (button, down) => buttons.push({ button, down }),
    };
}

function setup({ sensitivity = 1, locked = true } = {}) {
    const surface = document.createElement('canvas');
    document.body.appendChild(surface);
    surface.requestPointerLock = () => { lockElement = surface; return Promise.resolve(); };
    const ci = makeCi();
    const mouse = createMouse({ ci, surface, getSensitivity: () => sensitivity });
    mouse.attach();
    lockElement = locked ? surface : null;
    return { surface, ci, mouse };
}

function move(movementX, movementY) {
    const event = new dom.window.Event('mousemove', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        movementX: { value: movementX },
        movementY: { value: movementY },
    });
    document.dispatchEvent(event);
    return event;
}

function pointer(type, button, target) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'button', { value: button });
    target.dispatchEvent(event);
    return event;
}

// --- Главное правило: никакого Y ---------------------------------------------

test('movementY не пробрасывается — второй аргумент всегда 0', () => {
    const { ci, mouse } = setup();
    move(10, 40);
    move(-7, -100);
    move(3, 0);
    assertEqual(ci.motions.length, 3, 'три поворота');
    for (const m of ci.motions) {
        assertEqual(m.y, 0, 'вертикаль всегда ноль (браузерный novert)');
    }
    assertEqual(ci.motions[0].x, 10, 'X пробрасывается как есть');
    assertEqual(ci.motions[1].x, -7, 'отрицательный X тоже');
    mouse.detach();
});

test('чистое вертикальное движение не даёт вообще ничего', () => {
    const { ci, mouse } = setup();
    move(0, 200);
    move(0, -200);
    assertEqual(ci.motions.length, 0, 'вертикаль игнорируется целиком');
    mouse.detach();
});

// --- Кламп и накопление дроби -------------------------------------------------

test('дельта зажата до ±50 — рывок не закручивает игрока волчком', () => {
    const { ci, mouse } = setup();
    move(5000, 0);
    move(-5000, 0);
    assertEqual(MAX_DELTA, 50, 'константа клампа');
    assertEqual(ci.motions[0].x, 50, 'верхняя граница');
    assertEqual(ci.motions[1].x, -50, 'нижняя граница');
    mouse.detach();
});

test('остаток дроби накапливается — медленное ведение в итоге поворачивает', () => {
    const { ci, mouse } = setup({ sensitivity: 0.25 });
    // Четыре шага по 0.25 = ровно 1 пиксель, но первые три сами по себе — нули.
    for (let i = 0; i < 3; i++) move(1, 0);
    assertEqual(ci.motions.length, 0, 'дробь пока копится, событий нет');
    move(1, 0);
    assertEqual(ci.motions.length, 1, 'накопленный пиксель уехал в игру');
    assertEqual(ci.motions[0].x, 1, 'ровно один пиксель');
    mouse.detach();
});

test('в покое дрейфа нет — накопленный остаток не «стреляет» сам', () => {
    const { ci, mouse } = setup({ sensitivity: 0.5 });
    move(1, 0);              // carry = 0.5
    assertEqual(ci.motions.length, 0, 'полпикселя не отправляем');
    for (let i = 0; i < 20; i++) move(0, 0);
    assertEqual(ci.motions.length, 0, 'нулевые движения ничего не порождают');
    mouse.detach();
});

test('без Pointer Lock движения мыши в игру не идут', () => {
    const { ci, mouse } = setup({ locked: false });
    move(30, 30);
    assertEqual(ci.motions.length, 0, 'мышь не захвачена — молчим');
    mouse.detach();
});

// --- Кнопки -------------------------------------------------------------------

test('первый клик по полю захватывает мышь и в игру не идёт', () => {
    const { surface, ci, mouse } = setup({ locked: false });
    pointer('pointerdown', 0, surface);
    assertEqual(ci.buttons.length, 0, 'клик захвата не стреляет');
    assertEqual(mouse.locked, true, 'Pointer Lock запрошен');
    mouse.detach();
});

test('раскладка кнопок: левая — огонь, правая — стрейф, средняя — вперёд', () => {
    const { surface, ci, mouse } = setup();
    pointer('pointerdown', 0, surface);
    pointer('pointerdown', 2, surface);
    pointer('pointerdown', 1, surface);
    assertEqual(ci.buttons[0].button, 0, 'левая → 0 (огонь)');
    assertEqual(ci.buttons[1].button, 1, 'правая → 1 (стрейф)');
    assertEqual(ci.buttons[2].button, 2, 'средняя → 2 (вперёд)');
    assert(ci.buttons.every((b) => b.down === true), 'все нажатия');

    pointer('pointerup', 0, window);
    assertEqual(ci.buttons.at(-1).down, false, 'отпускание доходит');
    mouse.detach();
});

test('неизвестная кнопка (боковая) игнорируется', () => {
    const { surface, ci, mouse } = setup();
    pointer('pointerdown', 3, surface);
    assertEqual(ci.buttons.length, 0, 'кнопки 3 в раскладке нет');
    mouse.detach();
});

test('contextmenu глушится — правая кнопка стрейфит, а не открывает меню', () => {
    const { surface, mouse } = setup();
    const event = new dom.window.Event('contextmenu', { bubbles: true, cancelable: true });
    surface.dispatchEvent(event);
    assert(event.defaultPrevented, 'меню браузера подавлено');
    mouse.detach();
});

// --- Потеря захвата -----------------------------------------------------------

test('потеря Pointer Lock отпускает все зажатые кнопки', () => {
    const { surface, ci, mouse } = setup();
    pointer('pointerdown', 0, surface);
    ci.buttons.length = 0;

    lockElement = null;
    document.dispatchEvent(new dom.window.Event('pointerlockchange'));

    assertEqual(ci.buttons.length, 3, 'отпущены все три кнопки раскладки');
    assert(ci.buttons.every((b) => b.down === false), 'все — отпускания');
    mouse.detach();
});

test('потеря Pointer Lock сбрасывает накопленный остаток', () => {
    const { surface, ci, mouse } = setup({ sensitivity: 0.5 });
    move(1, 0);                       // carry = 0.5
    lockElement = null;
    document.dispatchEvent(new dom.window.Event('pointerlockchange'));
    lockElement = surface;

    // Возвращаем захват и делаем ещё полпикселя: без сброса carry получился бы
    // мгновенный поворот на пиксель.
    ci.motions.length = 0;
    move(1, 0);
    assertEqual(ci.motions.length, 0, 'остаток обнулён, поворота нет');
    mouse.detach();
});

test('восстановление захвата не порождает лишних отпусканий', () => {
    const { surface, ci, mouse } = setup();
    lockElement = surface;
    document.dispatchEvent(new dom.window.Event('pointerlockchange'));
    assertEqual(ci.buttons.length, 0, 'захват есть — ничего не отпускаем');
    mouse.detach();
});

// --- Уборка -------------------------------------------------------------------

test('detach() снимает все обработчики и отпускает захват', () => {
    const { surface, ci, mouse } = setup();
    mouse.detach();
    assertEqual(mouse.attached, false, 'снят');
    assertEqual(lockElement, null, 'Pointer Lock отпущен');

    // detach() гасит кнопки — как это делают keyboard.detach() и touch.detach().
    // Проверяется здесь же, отдельным тестом ниже; тут важно, что ПОСЛЕ него не
    // приходит уже ничего.
    const sentOnDetach = ci.buttons.length;
    lockElement = surface;
    move(20, 20);
    pointer('pointerdown', 0, surface);
    const menu = new dom.window.Event('contextmenu', { bubbles: true, cancelable: true });
    surface.dispatchEvent(menu);
    assertEqual(ci.motions.length, 0, 'движения больше не слушаем');
    assertEqual(ci.buttons.length, sentOnDetach, 'кнопки больше не слушаем');
    assert(!menu.defaultPrevented, 'contextmenu снова доступен браузеру');
    lockElement = null;
});

test('detach() отпускает зажатую кнопку — иначе персонаж стреляет после закрытия окна', () => {
    const { surface, ci, mouse } = setup();
    lockElement = surface;
    pointer('pointerdown', 0, surface);
    assert(ci.buttons.some((b) => b.down === true), 'кнопка зажата');

    ci.buttons.length = 0;
    mouse.detach();

    // Полагаться на onLockChange здесь нельзя: слушатель снимается раньше выхода из
    // Pointer Lock, то есть отпускание не ушло бы никуда вообще.
    const released = ci.buttons.filter((b) => b.down === false).map((b) => b.button);
    assert(released.includes(0), 'левая кнопка отпущена');
    lockElement = null;
});

test('повторный attach() не дублирует обработчики', () => {
    const { ci, mouse } = setup();
    mouse.attach();
    move(10, 0);
    assertEqual(ci.motions.length, 1, 'ровно один вызов');
    mouse.detach();
});

test('падение ci.sendMouseRelativeMotion не роняет обработчик', () => {
    const surface = document.createElement('canvas');
    document.body.appendChild(surface);
    surface.requestPointerLock = () => { lockElement = surface; return Promise.resolve(); };
    const ci = {
        sendMouseRelativeMotion: () => { throw new Error('сессия закрыта'); },
        sendMouseButton: () => { throw new Error('сессия закрыта'); },
    };
    const mouse = createMouse({ ci, surface, getSensitivity: () => 1 });
    mouse.attach();
    lockElement = surface;
    move(10, 0);
    pointer('pointerdown', 0, surface);
    lockElement = null;
    document.dispatchEvent(new dom.window.Event('pointerlockchange'));
    mouse.detach();
    surface.remove();
});

report('input mouse');
