// Тесты тач-управления под jsdom, с моком CommandInterface.
//
// Главный тест здесь — «стрелять во время поворота ВОЗМОЖНО». Это анти-паттерн,
// на котором провалился официальный порт Bethesda 2019: там поворот и
// стрельба висели на одной поверхности, и попытка выстрелить уводила прицел.
// Остальные проверки стерегут те же инварианты, что и мышь с клавиатурой: второй
// аргумент sendMouseRelativeMotion всегда 0, ничего не залипает после отмены.
//
// Требуется jsdom: npm install --no-save jsdom
// Запуск: node tests/input/touch.test.mjs

import { JSDOM } from 'jsdom';
import { assert, assertEqual, report, test } from '../_harness.mjs';
import { createKeyBus } from '../../src/input/key-bus.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
// navigator в node уже есть и переопределению не поддаётся; detectTouch() здесь не
// проверяется — он про железо, а не про контракт вызовов.
globalThis.getComputedStyle = dom.window.getComputedStyle;

const { createTouch, DOUBLE_CLICK_STEP } = await import('../../src/input/touch.js');
const { GLFW } = await import('../../src/dos/keys.js');
const { createTouchOverlay } = await import('../../src/shell/touch-overlay.js');

console.log('input touch (jsdom)');

const STAGE = { width: 1024, height: 768 };

function makeCi() {
    const keys = [];
    const buttons = [];
    const motions = [];
    return {
        keys,
        buttons,
        motions,
        sendKeyEvent: (code, down) => keys.push({ code, down }),
        sendMouseButton: (button, down) => buttons.push({ button, down }),
        sendMouseRelativeMotion: (x, y) => motions.push({ x, y }),
    };
}

function setup({ overlay = null } = {}) {
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    // jsdom не раскладывает элементы: размеры сцены подставляем руками, иначе
    // раскладка посчиталась бы на нулевом прямоугольнике.
    surface.getBoundingClientRect = () => ({
        left: 0, top: 0, right: STAGE.width, bottom: STAGE.height, ...STAGE,
    });
    const ci = makeCi();
    const touch = createTouch({ ci, keys: createKeyBus({ ci }).owner('touch'), surface, overlay });
    touch.attach();
    return { surface, ci, touch };
}

/** Событие указателя: jsdom не строит PointerEvent, поэтому собираем вручную. */
function pointer(type, { id = 1, x = 0, y = 0, kind = 'touch' } = {}) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        pointerId: { value: id },
        pointerType: { value: kind },
        clientX: { value: x },
        clientY: { value: y },
    });
    return event;
}

const down = (target, opts) => { const e = pointer('pointerdown', opts); target.dispatchEvent(e); return e; };
const move = (opts) => { const e = pointer('pointermove', opts); window.dispatchEvent(e); return e; };
const up = (opts) => { const e = pointer('pointerup', opts); window.dispatchEvent(e); return e; };
const cancel = (opts) => { const e = pointer('pointercancel', opts); window.dispatchEvent(e); return e; };

/** Точка в центре нарисованного контрола. */
function at(touch, id) {
    const c = touch.layout.controls[id];
    return c.shape === 'circle'
        ? { x: c.visual.x, y: c.visual.y }
        : { x: c.visual.x + c.visual.w / 2, y: c.visual.y + c.visual.h / 2 };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Огонь ---------------------------------------------------------------------

await test('тап по кнопке огня жмёт и отпускает левую кнопку мыши', () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'fire');
    down(surface, { id: 1, ...p });
    assertEqual(ci.buttons.length, 1, 'одно нажатие');
    assertEqual(ci.buttons[0].button, 0, 'кнопка огня DOOM — 0');
    assertEqual(ci.buttons[0].down, true, 'нажата');

    up({ id: 1, ...p });
    assertEqual(ci.buttons.at(-1).down, false, 'отпущена');
    touch.detach();
    surface.remove();
});

await test('огонь дублирован — отпускание одной кнопки не гасит очередь', () => {
    const { surface, ci, touch } = setup();
    down(surface, { id: 1, ...at(touch, 'fire') });
    down(surface, { id: 2, ...at(touch, 'fireLeft') });
    assertEqual(ci.buttons.length, 1, 'вторая кнопка не шлёт повторное нажатие');

    up({ id: 1, ...at(touch, 'fire') });
    assertEqual(ci.buttons.length, 1, 'пока держат левую — огонь не гаснет');
    assertEqual(touch.firingCount, 1, 'один палец на огне остался');

    up({ id: 2, ...at(touch, 'fireLeft') });
    assertEqual(ci.buttons.at(-1).down, false, 'последний палец гасит огонь');
    touch.detach();
    surface.remove();
});

// --- Движение ------------------------------------------------------------------

await test('стик двигает и стрейфит, поворота не даёт', () => {
    const { surface, ci, touch } = setup();
    const start = { x: 120, y: 620 };
    assertEqual(touch.layout.controls.stick.id, 'stick', 'зона стика есть');

    down(surface, { id: 1, ...start });
    move({ id: 1, x: start.x, y: start.y - 120 });
    assert(ci.keys.some((k) => k.code === GLFW.W && k.down), 'вперёд — KeyW');

    move({ id: 1, x: start.x + 120, y: start.y });
    assert(ci.keys.some((k) => k.code === GLFW.D && k.down), 'вбок — стрейф KeyD');
    assert(!ci.keys.some((k) => k.code === GLFW.RIGHT || k.code === GLFW.LEFT),
        'стрелок поворота стик не шлёт');
    assertEqual(ci.motions.length, 0, 'и мышиных дельт тоже');

    up({ id: 1, x: start.x + 120, y: start.y });
    assert(ci.keys.at(-1).down === false, 'палец убрали — клавиши отпущены');
    touch.detach();
    surface.remove();
});

// --- Поворот -------------------------------------------------------------------

await test('свайп поворачивает по X, второй аргумент ВСЕГДА 0', () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'look');
    down(surface, { id: 1, ...p });
    move({ id: 1, x: p.x + 40, y: p.y + 90 });
    move({ id: 1, x: p.x - 30, y: p.y - 200 });

    assert(ci.motions.length >= 2, 'дельты дошли');
    for (const m of ci.motions) assertEqual(m.y, 0, 'вертикаль всегда ноль — браузерный novert');
    assert(ci.motions[0].x > 0, 'вправо');
    assert(ci.motions[1].x < 0, 'влево');
    touch.detach();
    surface.remove();
});

await test('чисто вертикальный свайп не даёт ничего', () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'look');
    down(surface, { id: 1, ...p });
    move({ id: 1, x: p.x, y: p.y - 300 });
    move({ id: 1, x: p.x, y: p.y + 300 });
    assertEqual(ci.motions.length, 0, 'вертикаль выброшена целиком');
    touch.detach();
    surface.remove();
});

// --- Главный анти-паттерн --------------------------------------------------

await test('стрелять во время поворота ВОЗМОЖНО — оба пальца работают сразу', () => {
    const { surface, ci, touch } = setup();
    const look = at(touch, 'look');

    // Правый палец тянет камеру.
    down(surface, { id: 1, ...look });
    move({ id: 1, x: look.x + 60, y: look.y });
    const turnsBefore = ci.motions.length;
    assert(turnsBefore > 0, 'поворот пошёл');

    // Левый палец в это же время жмёт дублирующую кнопку огня.
    down(surface, { id: 2, ...at(touch, 'fireLeft') });
    assert(ci.buttons.some((b) => b.button === 0 && b.down), 'выстрел состоялся');

    // И камера продолжает ехать, не прерываясь на выстрел.
    move({ id: 1, x: look.x + 120, y: look.y });
    assert(ci.motions.length > turnsBefore, 'поворот не прервался');

    // Обратный порядок тоже обязан работать: держим огонь и начинаем крутить.
    const motionsBefore = ci.motions.length;
    move({ id: 1, x: look.x + 180, y: look.y });
    assert(ci.motions.length > motionsBefore, 'вращение при зажатом огне продолжается');
    assertEqual(touch.firingCount, 1, 'огонь всё ещё зажат');

    touch.detach();
    surface.remove();
});

await test('тап по огню не считается свайпом — камера стоит', () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'fire');
    // Кнопка огня физически лежит внутри правой половины: именно на этом
    // провалился порт 2019 года.
    assert(p.x > touch.layout.controls.look.visual.x, 'кнопка внутри зоны свайпа');
    down(surface, { id: 1, ...p });
    move({ id: 1, x: p.x + 80, y: p.y });
    assertEqual(ci.motions.length, 0, 'палец на кнопке камеру не крутит');
    touch.detach();
    surface.remove();
});

// --- Use ------------------------------------------------------------------------

await test('кнопка Use шлёт Space (key_use 57 в DEFAULT.CFG)', () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'use');
    down(surface, { id: 1, ...p });
    assertEqual(ci.keys[0].code, GLFW.SPACE, 'код Space');
    assertEqual(ci.keys[0].down, true, 'нажата');
    up({ id: 1, ...p });
    assertEqual(ci.keys.at(-1).down, false, 'отпущена');
    touch.detach();
    surface.remove();
});

await test('двойной тап по look-зоне = двойной клик forward = Use', async () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'look');

    down(surface, { id: 1, ...p });
    up({ id: 1, ...p });
    assertEqual(ci.buttons.length, 0, 'одиночный тап вперёд НЕ двигает');

    down(surface, { id: 1, x: p.x + 3, y: p.y + 3 });
    up({ id: 1, x: p.x + 3, y: p.y + 3 });
    await wait(DOUBLE_CLICK_STEP * 5);

    const forward = ci.buttons.filter((b) => b.button === 2);
    assertEqual(forward.length, 4, 'два полных клика кнопки forward');
    assertEqual(forward.map((b) => b.down).join(','), 'true,false,true,false', 'порядок down/up');
    touch.detach();
    surface.remove();
});

await test('два тапа с длинной паузой двойным не считаются', async () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'look');
    down(surface, { id: 1, ...p });
    up({ id: 1, ...p });
    await wait(360);
    down(surface, { id: 1, ...p });
    up({ id: 1, ...p });
    await wait(DOUBLE_CLICK_STEP * 5);
    assertEqual(ci.buttons.filter((b) => b.button === 2).length, 0, 'дверь не открылась');
    touch.detach();
    surface.remove();
});

await test('свайп с возвратом в ту же точку за тап не считается', async () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'look');
    down(surface, { id: 1, ...p });
    up({ id: 1, ...p });
    // Второе касание — уже свайп: палец уехал далеко и вернулся.
    down(surface, { id: 1, ...p });
    move({ id: 1, x: p.x + 200, y: p.y });
    up({ id: 1, x: p.x + 200, y: p.y });
    await wait(DOUBLE_CLICK_STEP * 5);
    assertEqual(ci.buttons.filter((b) => b.button === 2).length, 0, 'поворот дверей не открывает');
    touch.detach();
    surface.remove();
});

// --- Оружие ---------------------------------------------------------------------

await test('кнопки полоски шлют Digit1…Digit7', () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'weapon3');
    down(surface, { id: 1, ...p });
    assertEqual(ci.keys[0].code, GLFW.D3, 'третья кнопка — Digit3');
    up({ id: 1, ...p });
    assertEqual(ci.keys.at(-1).down, false, 'отпущена');

    const seventh = at(touch, 'weapon7');
    down(surface, { id: 2, ...seventh });
    assertEqual(ci.keys.at(-1).code, GLFW.D7, 'седьмая — Digit7');
    touch.detach();
    surface.remove();
});

// --- Сброс залипшего -------------------------------------------------------------

await test('pointercancel отпускает ОТМЕНЁННЫЙ палец, а не всех подряд', () => {
    const { surface, ci, touch } = setup();
    down(surface, { id: 1, ...at(touch, 'fire') });
    down(surface, { id: 2, x: 120, y: 620 });
    move({ id: 2, x: 120, y: 480 });
    assert(ci.keys.some((k) => k.down), 'клавиша зажата');
    ci.buttons.length = 0;
    ci.keys.length = 0;

    // Отмена приходит ПО ПАЛЬЦАМ: система отобрала палец стика, палец на огне
    // остался лежать на кнопке. Гасить из-за первого второй — значит терять
    // стрельбу на ровном месте, а вернуть её нечем: собственный pointerup пальца
    // огня своей записи уже не нашёл бы.
    cancel({ id: 2 });

    assert(ci.keys.length > 0 && ci.keys.every((k) => k.down === false), 'клавиши стика отпущены');
    assert(!ci.buttons.some((b) => b.button === 0 && b.down === false), 'огонь НЕ погашен');
    assertEqual(touch.firingCount, 1, 'палец на огне остался');

    // И честное отпускание этого пальца по-прежнему доходит.
    up({ id: 1, ...at(touch, 'fire') });
    assert(ci.buttons.some((b) => b.button === 0 && b.down === false), 'огонь погашен своим pointerup');
    assertEqual(touch.firingCount, 0, 'пальцев на огне не осталось');
    touch.detach();
    surface.remove();
});

// --- Второй палец в той же зоне (владение трекерами) ---------------------------

await test('второй палец в look-зоне не рвёт камеру владельцу', () => {
    const { surface, ci, touch } = setup();
    const look = at(touch, 'look');

    down(surface, { id: 1, x: look.x, y: look.y });
    move({ id: 1, x: look.x + 10, y: look.y });
    ci.motions.length = 0;

    // Второй палец ложится в ту же зону на 300 px правее — ладонь, тап по Use-жесту.
    // Раньше он забирал трекер себе, и следующее движение ПЕРВОГО давало дельту в
    // сотни пикселей: камеру швыряло на полный кламп, и дальше пальцы «пилили» её.
    down(surface, { id: 2, x: look.x - 150, y: look.y - 100 });
    assertEqual(ci.motions.length, 0, 'касание второго пальца камеру не двигает');

    move({ id: 1, x: look.x + 15, y: look.y });
    assertEqual(ci.motions.length, 1, 'поворот ровно один');
    assert(ci.motions[0].x > 0 && ci.motions[0].x < 20, `дельта соразмерна свайпу, а не ${ci.motions[0].x}`);

    touch.detach();
    surface.remove();
});

await test('уход владельца передаёт поворот оставшемуся пальцу', () => {
    const { surface, ci, touch } = setup();
    const look = at(touch, 'look');

    down(surface, { id: 1, x: look.x, y: look.y });
    down(surface, { id: 2, x: look.x - 150, y: look.y - 100 });
    move({ id: 2, x: look.x - 130, y: look.y - 100 });   // не владелец: камера стоит
    assertEqual(ci.motions.length, 0, 'не владелец камеру не ведёт');

    up({ id: 1, x: look.x, y: look.y });           // владелец ушёл
    ci.motions.length = 0;

    // Оставшийся палец подхватывает поворот с ТОЙ точки, где он сейчас, а не с той,
    // где коснулся экрана: иначе игрок получил бы рывок на 20 пикселей.
    move({ id: 2, x: look.x - 125, y: look.y - 100 });
    assertEqual(ci.motions.length, 1, 'оставшийся палец ведёт камеру');
    assert(ci.motions[0].x > 0 && ci.motions[0].x < 20, `без рывка, а не ${ci.motions[0].x}`);

    touch.detach();
    surface.remove();
});

await test('второй палец в зоне стика не отбирает движение у первого', () => {
    const { surface, ci, touch } = setup();
    const stickPoint = { x: 120, y: 620 };

    down(surface, { id: 1, ...stickPoint });
    move({ id: 1, x: stickPoint.x, y: stickPoint.y - 140 });
    assert(ci.keys.some((k) => k.down), 'первый палец ведёт вперёд');
    ci.keys.length = 0;

    // Второй палец в левой половине — ладонь. Раньше его begin() отпускал WASD и
    // переносил origin, а его же pointerup звал end(): первый палец оставался лежать
    // на экране, но не давал уже НИЧЕГО, пока его не поднимут и не поставят заново.
    down(surface, { id: 2, x: 200, y: 700 });
    assertEqual(ci.keys.length, 0, 'касание второго пальца движение не гасит');
    up({ id: 2, x: 200, y: 700 });
    assertEqual(ci.keys.length, 0, 'и его отпускание — тоже');

    move({ id: 1, x: stickPoint.x, y: stickPoint.y - 160 });
    up({ id: 1, x: stickPoint.x, y: stickPoint.y - 160 });
    assert(ci.keys.some((k) => k.down === false), 'первый палец по-прежнему управляет стиком');

    touch.detach();
    surface.remove();
});

await test('уход владельца стика передаёт его оставшемуся пальцу', () => {
    const { surface, ci, touch } = setup();

    down(surface, { id: 1, x: 120, y: 620 });
    down(surface, { id: 2, x: 200, y: 700 });
    move({ id: 1, x: 120, y: 480 });
    ci.keys.length = 0;

    up({ id: 1, x: 120, y: 480 });   // владелец ушёл, наследник уже лежит в зоне
    ci.keys.length = 0;

    move({ id: 2, x: 200, y: 560 });
    assert(ci.keys.some((k) => k.down), 'наследник ведёт стик');

    touch.detach();
    surface.remove();
});

await test('два пальца на одной кнопке Use — отпускание первого её не гасит', () => {
    const { surface, ci, touch } = setup();
    const use = at(touch, 'use');

    down(surface, { id: 1, x: use.x, y: use.y });
    down(surface, { id: 2, x: use.x + 2, y: use.y + 2 });
    ci.keys.length = 0;

    up({ id: 1, x: use.x, y: use.y });
    assertEqual(ci.keys.length, 0, 'второй палец держит — клавиша не отпущена');

    up({ id: 2, x: use.x + 2, y: use.y + 2 });
    assert(ci.keys.some((k) => k.down === false), 'отпущена по последнему пальцу');

    touch.detach();
    surface.remove();
});

await test('уход со вкладки и потеря фокуса отпускают всё', () => {
    const { surface, ci, touch } = setup();
    down(surface, { id: 1, ...at(touch, 'fire') });
    ci.buttons.length = 0;

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert(ci.buttons.some((b) => b.button === 0 && b.down === false), 'вкладка ушла — огонь погашен');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

    down(surface, { id: 2, ...at(touch, 'fire') });
    ci.buttons.length = 0;
    window.dispatchEvent(new dom.window.Event('blur'));
    assert(ci.buttons.some((b) => b.button === 0 && b.down === false), 'потеря фокуса — тоже');
    touch.detach();
    surface.remove();
});

// --- Границы ответственности ------------------------------------------------------

await test('мышь тач не трогает: pointerType «mouse» игнорируется целиком', () => {
    const { surface, ci, touch } = setup();
    const p = at(touch, 'fire');
    const event = down(surface, { id: 1, kind: 'mouse', ...p });
    move({ id: 1, kind: 'mouse', x: p.x + 100, y: p.y });
    assertEqual(ci.buttons.length, 0, 'мышь идёт своим путём — через mouse.js');
    assertEqual(ci.motions.length, 0, 'и дельт отсюда не шлёт');
    assert(!event.defaultPrevented, 'событие мыши не тронуто');
    touch.detach();
    surface.remove();
});

await test('тач до канваса не доходит — иначе mouse.js запросит Pointer Lock', () => {
    const { surface, touch } = setup();
    const canvas = document.createElement('canvas');
    surface.appendChild(canvas);
    let sawTouch = 0;
    canvas.addEventListener('pointerdown', () => { sawTouch++; });

    const event = pointer('pointerdown', { id: 1, ...at(touch, 'fire') });
    canvas.dispatchEvent(event);
    assertEqual(sawTouch, 0, 'фаза перехвата на сцене остановила событие');
    assert(event.defaultPrevented, 'скролл и синтетическая мышь подавлены');
    touch.detach();
    surface.remove();
});

await test('касание мимо всех зон ничего не шлёт и событие не съедает', () => {
    const { surface, ci, touch } = setup();
    // Верхняя полоса над зонами и мимо полоски оружия.
    const event = down(surface, { id: 1, x: 5, y: 5 });
    assertEqual(ci.buttons.length + ci.keys.length + ci.motions.length, 0, 'тишина');
    assert(!event.defaultPrevented, 'чужой жест не блокируем');
    touch.detach();
    surface.remove();
});

// --- Жизненный цикл ---------------------------------------------------------------

await test('detach() снимает обработчики и отпускает зажатое', () => {
    const { surface, ci, touch } = setup();
    down(surface, { id: 1, ...at(touch, 'fire') });
    ci.buttons.length = 0;

    touch.detach();
    assertEqual(touch.attached, false, 'снят');
    assert(ci.buttons.some((b) => b.button === 0 && b.down === false), 'огонь погашен при снятии');

    ci.buttons.length = 0;
    ci.motions.length = 0;
    down(surface, { id: 2, x: 889, y: 633 });
    move({ id: 2, x: 700, y: 400 });
    assertEqual(ci.buttons.length + ci.motions.length, 0, 'после detach событий не слушаем');
    surface.remove();
});

await test('повторный attach() не дублирует обработчики', () => {
    const { surface, ci, touch } = setup();
    touch.attach();
    down(surface, { id: 1, ...at(touch, 'fire') });
    assertEqual(ci.buttons.length, 1, 'ровно одно нажатие');
    touch.detach();
    surface.remove();
});

await test('падение ci не роняет обработчик — сессия могла закрыться', () => {
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1024, bottom: 768, ...STAGE });
    const ci = {
        sendKeyEvent: () => { throw new Error('сессия закрыта'); },
        sendMouseButton: () => { throw new Error('сессия закрыта'); },
        sendMouseRelativeMotion: () => { throw new Error('сессия закрыта'); },
    };
    const touch = createTouch({ ci, keys: createKeyBus({ ci }).owner('touch'), surface });
    touch.attach();
    down(surface, { id: 1, ...at(touch, 'fire') });
    down(surface, { id: 2, x: 120, y: 620 });
    move({ id: 2, x: 120, y: 480 });
    down(surface, { id: 3, ...at(touch, 'look') });
    move({ id: 3, x: 900, y: 300 });
    touch.detach();
    surface.remove();
});

await test('isActive() === false: до старта игры пальцы в эмулятор не идут', () => {
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1024, bottom: 768, ...STAGE });
    const ci = makeCi();
    let live = false;
    const touch = createTouch({ ci, keys: createKeyBus({ ci }).owner('touch'), surface, isActive: () => live });
    touch.attach();

    down(surface, { id: 1, ...at(touch, 'fire') });
    assertEqual(ci.buttons.length, 0, 'игра не идёт — молчим');

    live = true;
    down(surface, { id: 2, ...at(touch, 'fire') });
    assertEqual(ci.buttons.length, 1, 'игра пошла — стреляем');
    touch.detach();
    surface.remove();
});

await test('relayout() пересчитывает раскладку под новый размер сцены', () => {
    const { surface, touch } = setup();
    const wide = touch.layout.controls.fire.visual.x;
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 });
    touch.relayout();
    assert(touch.layout.controls.fire.visual.x < wide, 'кнопка переехала вместе с углом');
    assertEqual(touch.layout.width, 500, 'раскладка знает новый размер');
    touch.detach();
    surface.remove();
});

// --- Оверлей ------------------------------------------------------------------------

await test('оверлей рисует кнопки поверх сцены и подсвечивает нажатую', () => {
    const stage = document.createElement('div');
    document.body.appendChild(stage);
    const overlay = createTouchOverlay({ box: stage });
    const { surface, touch } = setup({ overlay });

    assert(stage.querySelector('.stdoom-touch'), 'оверлей вставлен в сцену, а не в канвас');
    assertEqual(overlay.visible, true, 'показан при подключённом тач-вводе');
    assert(overlay.nodeOf('fire'), 'кнопка огня нарисована');
    assert(overlay.nodeOf('weapon5'), 'полоска оружия нарисована');
    assert(!overlay.nodeOf('look'), 'зона свайпа невидима — рисовать её нечем и незачем');

    const p = at(touch, 'fire');
    down(surface, { id: 1, ...p });
    assert(overlay.nodeOf('fire').classList.contains('stdoom-touch-active'), 'нажатие подсвечено');
    up({ id: 1, ...p });
    assert(!overlay.nodeOf('fire').classList.contains('stdoom-touch-active'), 'подсветка снята');

    touch.detach();
    assertEqual(overlay.visible, false, 'после detach оверлей спрятан');
    overlay.destroy();
    surface.remove();
    stage.remove();
});

await test('оверлей: кольцо плавающего стика уезжает под палец и возвращается домой', () => {
    const stage = document.createElement('div');
    document.body.appendChild(stage);
    const overlay = createTouchOverlay({ box: stage });
    const { surface, touch } = setup({ overlay });

    const ring = stage.querySelector('.stdoom-touch-stick');
    assert(ring, 'кольцо есть');
    const home = ring.style.left;

    down(surface, { id: 1, x: 300, y: 700 });
    assert(ring.style.left !== home, 'кольцо переехало под палец (стик плавающий)');
    up({ id: 1, x: 300, y: 700 });
    assertEqual(ring.style.left, home, 'палец убрали — кольцо вернулось домой');

    touch.detach();
    overlay.destroy();
    surface.remove();
    stage.remove();
});

report('input touch');
