// Тесты общей шины клавиш.
//
// Стережётся ровно одно правило, но с двух сторон: клавиша отпускается тогда и только
// тогда, когда её отпустил ПОСЛЕДНИЙ держатель — неважно, на каком устройстве он сидит.
// До шины счётчик источников жил внутри каждого модуля, и клавиатурный Ctrl гасил
// огонь, зажатый на курке геймпада, — повторного нажатия при этом не приходило
// никогда, потому что опрос геймпада шлёт события только по СМЕНЕ состояния кнопки.
//
// jsdom не нужен: модуль чистый, из окружения ему нужен только CommandInterface.
// Запуск: node tests/input/key-bus.test.mjs

import { assert, assertEqual, report, test } from '../_harness.mjs';
import { createKeyBus } from '../../src/input/key-bus.js';
import { GLFW } from '../../src/dos/keys.js';


function makeCi() {
    const keys = [];
    return {
        keys,
        sendKeyEvent: (code, down) => keys.push({ code, down }),
        /** Только нажатия/отпускания одного кода — так удобнее читать ожидания. */
        of: (code) => keys.filter((k) => k.code === code).map((k) => k.down),
    };
}

const CTRL = GLFW.LEFT_CONTROL;

// --- Один источник -------------------------------------------------------------

test('одиночное нажатие и отпускание доходят как есть', () => {
    const ci = makeCi();
    const kb = createKeyBus({ ci }).owner('keyboard');
    kb.press(CTRL);
    kb.release(CTRL);
    assertEqual(JSON.stringify(ci.of(CTRL)), JSON.stringify([true, false]), 'ровно down и up');
});

test('повтор от того же источника вторым держателем не считается', () => {
    const ci = makeCi();
    const bus = createKeyBus({ ci });
    const kb = bus.owner('keyboard');
    // Автоповтор браузера и опрос геймпада шлют одно и то же нажатие много раз.
    kb.press(CTRL);
    kb.press(CTRL);
    kb.press(CTRL);
    assertEqual(bus.countOf(CTRL), 1, 'держатель по-прежнему один');
    kb.release(CTRL);
    assertEqual(JSON.stringify(ci.of(CTRL)), JSON.stringify([true, false]), 'лишних событий нет');
    assertEqual(bus.isDown(CTRL), false, 'клавиша отпущена');
});

test('отпускание того, чего не держали, не шлёт ничего', () => {
    const ci = makeCi();
    const kb = createKeyBus({ ci }).owner('keyboard');
    kb.release(CTRL);
    assertEqual(ci.keys.length, 0, 'тишина');
});

// --- Главное: несколько устройств ----------------------------------------------

test('правило 22: клавиатурный Ctrl НЕ гасит огонь, зажатый на геймпаде', () => {
    const ci = makeCi();
    const bus = createKeyBus({ ci });
    const pad = bus.owner('gamepad');
    const kb = bus.owner('keyboard');

    pad.press(CTRL, 'b7');            // правый курок зажат
    assertEqual(JSON.stringify(ci.of(CTRL)), JSON.stringify([true]), 'огонь пошёл');

    kb.press(CTRL);                   // игрок вдобавок нажал Ctrl на клавиатуре
    kb.release(CTRL);                 // и отпустил

    assertEqual(JSON.stringify(ci.of(CTRL)), JSON.stringify([true]), 'отпускания не было');
    assertEqual(bus.countOf(CTRL), 1, 'держит только курок');

    pad.release(CTRL, 'b7');          // курок отпущен — вот теперь гаснет
    assertEqual(JSON.stringify(ci.of(CTRL)), JSON.stringify([true, false]), 'погас по последнему');
});

test('B и правый курок геймпада — два разных источника одной клавиши', () => {
    const ci = makeCi();
    const bus = createKeyBus({ ci });
    const pad = bus.owner('gamepad');
    pad.press(CTRL, 'b1');
    pad.press(CTRL, 'b7');
    assertEqual(bus.countOf(CTRL), 2, 'держателей двое');
    pad.release(CTRL, 'b1');
    assertEqual(JSON.stringify(ci.of(CTRL)), JSON.stringify([true]), 'первая кнопка очередь не гасит');
    pad.release(CTRL, 'b7');
    assertEqual(JSON.stringify(ci.of(CTRL)), JSON.stringify([true, false]), 'погасла вторая');
});

test('два пальца на одной кнопке Use считаются раздельно', () => {
    const ci = makeCi();
    const bus = createKeyBus({ ci });
    const touch = bus.owner('touch');
    touch.pressCode('Space', 'p1');
    touch.pressCode('Space', 'p2');
    assertEqual(bus.countOf(GLFW.SPACE), 2, 'держат оба пальца');
    touch.releaseCode('Space', 'p1');
    assertEqual(bus.isDown(GLFW.SPACE), true, 'второй палец держит');
    touch.releaseCode('Space', 'p2');
    assertEqual(bus.isDown(GLFW.SPACE), false, 'отпущено по последнему');
});

// --- Уборка ---------------------------------------------------------------------

test('releaseAll() владельца не трогает чужих держателей', () => {
    const ci = makeCi();
    const bus = createKeyBus({ ci });
    const pad = bus.owner('gamepad');
    const kb = bus.owner('keyboard');

    pad.press(CTRL, 'b7');
    kb.press(CTRL);
    ci.keys.length = 0;

    // Потеря фокуса клавиатурой не должна ронять зажатый курок геймпада.
    kb.releaseAll();
    assertEqual(ci.keys.length, 0, 'в игру ничего не ушло');
    assertEqual(bus.isDown(CTRL), true, 'клавиша всё ещё зажата геймпадом');

    pad.releaseAll();
    assertEqual(JSON.stringify(ci.of(CTRL)), JSON.stringify([false]), 'теперь отпущена');
});

test('releaseAll() отпускает все клавиши владельца и обнуляет учёт', () => {
    const ci = makeCi();
    const bus = createKeyBus({ ci });
    const touch = bus.owner('touch');
    touch.pressCode('KeyW', 'stick');
    touch.pressCode('KeyD', 'stick');
    touch.pressCode('Space', 'p1');
    assertEqual(touch.heldCount, 3, 'три источника');

    touch.releaseAll();
    assertEqual(touch.heldCount, 0, 'учёт пуст');
    assertEqual(bus.downCount, 0, 'нажатых клавиш не осталось');
    const ups = ci.keys.filter((k) => k.down === false).length;
    assertEqual(ups, 3, 'отпущены все три');

    // Повторный вызов ничего не шлёт: отпускать больше нечего.
    ci.keys.length = 0;
    touch.releaseAll();
    assertEqual(ci.keys.length, 0, 'повторная уборка молчит');
});

test('holds() отвечает про СВОЕГО владельца, isDown() — про всех', () => {
    const ci = makeCi();
    const bus = createKeyBus({ ci });
    const pad = bus.owner('gamepad');
    const kb = bus.owner('keyboard');
    pad.press(CTRL, 'b7');
    assertEqual(pad.holds(CTRL), true, 'геймпад держит');
    assertEqual(kb.holds(CTRL), false, 'клавиатура — нет');
    assertEqual(bus.isDown(CTRL), true, 'а клавиша нажата');
});

// --- Стойкость ------------------------------------------------------------------

test('падение ci не роняет шину — сессия могла закрыться', () => {
    const ci = {
        sendKeyEvent: () => { throw new Error('сессия закрыта'); },
    };
    const bus = createKeyBus({ ci });
    const kb = bus.owner('keyboard');
    kb.press(CTRL);
    kb.releaseAll();
    assertEqual(kb.heldCount, 0, 'учёт всё равно убран');
});

test('неизвестный e.code просто игнорируется', () => {
    const ci = makeCi();
    const bus = createKeyBus({ ci });
    const touch = bus.owner('touch');
    touch.pressCode('MediaPlayPause', 'p1');
    assertEqual(ci.keys.length, 0, 'пары в  нет — молчим');
    assertEqual(touch.heldCount, 0, 'и в учёт не попало');
});

test('нечисловой код клавиши не попадает в учёт', () => {
    const ci = makeCi();
    const bus = createKeyBus({ ci });
    const kb = bus.owner('keyboard');
    kb.press(undefined);
    kb.press(null);
    assertEqual(ci.keys.length, 0, 'в игру ничего не ушло');
    assertEqual(kb.heldCount, 0, 'учёт пуст');
});

report('input key-bus');
