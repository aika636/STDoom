// Тесты перехвата клавиатуры — правило здесь обратное обычному: пока игровое поле
// в фокусе, глушится ВСЁ, включая Escape и Tab; ушёл фокус — перехвата нет вовсе.
//
// Требуется jsdom: npm install --no-save jsdom
// Запуск: node tests/input/keyboard.test.mjs

import { JSDOM } from 'jsdom';
import { assert, assertEqual, report, test } from '../_harness.mjs';
import { createKeyBus } from '../../src/input/key-bus.js';

const dom = new JSDOM(
    '<!doctype html><html><body><canvas id="screen"></canvas><textarea id="send_textarea"></textarea></body></html>',
    { pretendToBeVisual: true },
);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const { createKeyboard } = await import('../../src/input/keyboard.js');
const { GLFW } = await import('../../src/dos/keys.js');

console.log('input keyboard');

/** Шпион вместо CommandInterface: интересуют только вызовы sendKeyEvent. */
function makeCi() {
    const calls = [];
    return {
        calls,
        sendKeyEvent: (code, down) => calls.push({ code, down }),
    };
}

/** Свежая пара «канвас + перехватчик» на каждый тест; фокус ставим явно. */
function setup({ isActive } = {}) {
    const surface = document.createElement('canvas');
    document.body.appendChild(surface);
    const ci = makeCi();
    const keyboard = createKeyboard({ keys: createKeyBus({ ci }).owner('keyboard'), surface, isActive });
    keyboard.attach();
    surface.focus();
    return { surface, ci, keyboard };
}

function key(type, init) {
    return new dom.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
}

// --- Фокус на поле: глушится всё ---------------------------------------------

test('при фокусе на поле глушится ВСЁ, включая Escape и Tab', () => {
    const { ci, keyboard } = setup();
    // Клавиши намеренно разные: игровая, «браузерная» Tab и Escape меню DOOM.
    const cases = ['KeyW', 'Tab', 'Escape'];
    for (const code of cases) {
        const event = key('keydown', { code, key: code === 'KeyW' ? 'w' : code });
        window.dispatchEvent(event);
        assert(event.defaultPrevented, `preventDefault для ${code}`);
    }
    assertEqual(ci.calls.length, 3, 'все три клавиши уехали в эмулятор');
    keyboard.detach();
});

test('Escape доезжает до ci.sendKeyEvent кодом 256, а не закрывает окно', () => {
    const { ci, keyboard } = setup();
    window.dispatchEvent(key('keydown', { code: 'Escape', key: 'Escape' }));
    assertEqual(ci.calls[0].code, 256, 'код GLFW Escape');
    assertEqual(ci.calls[0].code, GLFW.ESCAPE, 'он же через константу');
    assertEqual(ci.calls[0].down, true, 'нажатие');
    window.dispatchEvent(key('keyup', { code: 'Escape', key: 'Escape' }));
    assertEqual(ci.calls[1].down, false, 'отпускание');
    keyboard.detach();
});

test('клавиша без записи в таблице всё равно глушится', () => {
    const { ci, keyboard } = setup();
    // MediaPlayPause в CODE_TO_GLFW нет, но утечь в таверну она не должна.
    const event = key('keydown', { code: 'MediaPlayPause', key: 'MediaPlayPause' });
    window.dispatchEvent(event);
    assert(event.defaultPrevented, 'перехвачена');
    assertEqual(ci.calls.length, 0, 'в эмулятор не ушла');
    keyboard.detach();
});

test('F5/F11/F12 не отбираем — браузер их всё равно не отдаёт', () => {
    const { ci, keyboard } = setup();
    for (const k of ['F5', 'F11', 'F12']) {
        const event = key('keydown', { code: k, key: k });
        window.dispatchEvent(event);
        assert(!event.defaultPrevented, `${k} уходит браузеру`);
    }
    assertEqual(ci.calls.length, 0, 'ничего не отправлено');
    keyboard.detach();
});

// --- Фокус ушёл: перехвата нет -----------------------------------------------

test('ушёл фокус — событие не перехватывается и уходит дальше', () => {
    const { ci, keyboard } = setup();
    const textarea = document.getElementById('send_textarea');
    textarea.focus();

    let reachedTavern = false;
    const listener = () => { reachedTavern = true; };
    window.addEventListener('keydown', listener);

    const event = key('keydown', { code: 'KeyW', key: 'w' });
    textarea.dispatchEvent(event);

    window.removeEventListener('keydown', listener);
    assert(!event.defaultPrevented, 'preventDefault не вызван');
    assert(reachedTavern, 'событие доехало до обработчика таверны');
    assertEqual(ci.calls.length, 0, 'в эмулятор ничего не ушло');
    keyboard.detach();
});

test('isActive() === false снимает перехват даже при фокусе на поле', () => {
    let active = true;
    const { ci, keyboard } = setup({ isActive: () => active });
    active = false;
    const event = key('keydown', { code: 'KeyW', key: 'w' });
    window.dispatchEvent(event);
    assert(!event.defaultPrevented, 'сессия мертва — не перехватываем');
    assertEqual(ci.calls.length, 0, 'ничего не отправлено');
    keyboard.detach();
});

test('фокус на потомке поля считается фокусом на поле', () => {
    const surface = document.createElement('div');
    const child = document.createElement('button');
    surface.appendChild(child);
    document.body.appendChild(surface);
    const ci = makeCi();
    const keyboard = createKeyboard({ keys: createKeyBus({ ci }).owner('keyboard'), surface });
    keyboard.attach();
    child.focus();

    const event = key('keydown', { code: 'KeyW', key: 'w' });
    window.dispatchEvent(event);
    assert(event.defaultPrevented, 'перехвачено');
    assertEqual(ci.calls.length, 1, 'ушло в эмулятор');
    keyboard.detach();
    surface.remove();
});

// --- Залипшие клавиши ---------------------------------------------------------

test('blur отпускает все залипшие клавиши', () => {
    const { ci, keyboard } = setup();
    window.dispatchEvent(key('keydown', { code: 'KeyW', key: 'w' }));
    window.dispatchEvent(key('keydown', { code: 'ShiftLeft', key: 'Shift' }));
    assertEqual(keyboard.pressedCount, 2, 'две клавиши зажаты');

    window.dispatchEvent(new dom.window.Event('blur'));
    assertEqual(keyboard.pressedCount, 0, 'всё отпущено');
    const ups = ci.calls.filter((c) => c.down === false);
    assertEqual(ups.length, 2, 'обе клавиши отпущены явным событием');
    keyboard.detach();
});

test('visibilitychange при скрытой вкладке отпускает клавиши (Alt-Tab)', () => {
    const { ci, keyboard } = setup();
    window.dispatchEvent(key('keydown', { code: 'KeyW', key: 'w' }));
    assertEqual(keyboard.pressedCount, 1, 'клавиша зажата');

    // document.hidden в jsdom только для чтения — подменяем свойство.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assertEqual(keyboard.pressedCount, 0, 'клавиша отпущена');
    assertEqual(ci.calls.at(-1).down, false, 'последним ушёл keyup');

    // Возврат на вкладку ничего не отпускает повторно.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    const before = ci.calls.length;
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assertEqual(ci.calls.length, before, 'на возврате лишних событий нет');
    keyboard.detach();
});

test('отпускание доходит, даже если isActive() погас между down и up', () => {
    let live = true;
    const { ci, keyboard } = setup({ isActive: () => live });

    window.dispatchEvent(key('keydown', { code: 'KeyW', key: 'w' }));
    assertEqual(keyboard.pressedCount, 1, 'клавиша зажата');
    ci.calls.length = 0;

    // Сессия гаснет, пока палец на клавише: закрытие окна, отказ отрисовки.
    // Симметричная проверка focused() в onKeyUp была бы здесь ловушкой — down ушёл,
    // а up не ушёл бы, и персонаж остался бы бежать в стену.
    live = false;
    window.dispatchEvent(key('keyup', { code: 'KeyW', key: 'w' }));

    assert(ci.calls.some((k) => k.down === false), 'отпускание всё равно ушло в игру');
    assertEqual(keyboard.pressedCount, 0, 'учёт пуст');
    keyboard.detach();
});

test('чужую клавишу, которую мы не нажимали, отпускание не трогает', () => {
    const { surface, ci, keyboard } = setup();
    // Фокус ушёл в таверну, игрок печатает — её keyup нас не касается.
    surface.blur();
    ci.calls.length = 0;
    const event = key('keyup', { code: 'KeyW', key: 'w' });
    window.dispatchEvent(event);
    assertEqual(ci.calls.length, 0, 'в игру ничего не ушло');
    assert(!event.defaultPrevented, 'и событие не проглочено');
    keyboard.detach();
});

test('detach() снимает перехват полностью и отпускает зажатое', () => {
    const { ci, keyboard } = setup();
    window.dispatchEvent(key('keydown', { code: 'KeyW', key: 'w' }));
    const beforeDetach = ci.calls.length;

    keyboard.detach();
    assertEqual(keyboard.attached, false, 'перехват снят');
    assertEqual(keyboard.pressedCount, 0, 'зажатое отпущено при detach');
    assertEqual(ci.calls.length, beforeDetach + 1, 'ровно один keyup на отпускание');

    const event = key('keydown', { code: 'KeyW', key: 'w' });
    window.dispatchEvent(event);
    assert(!event.defaultPrevented, 'после detach ничего не глушим');
    assertEqual(ci.calls.length, beforeDetach + 1, 'после detach в эмулятор не шлём');
});

test('повторный attach()/detach() идемпотентен', () => {
    const { ci, keyboard } = setup();
    keyboard.attach();
    keyboard.attach();
    window.dispatchEvent(key('keydown', { code: 'KeyW', key: 'w' }));
    assertEqual(ci.calls.length, 1, 'обработчик не продублирован');
    keyboard.detach();
    keyboard.detach();
    assertEqual(keyboard.attached, false, 'снято');
});

test('sendKeyEvent, бросивший исключение, не роняет перехват', () => {
    const surface = document.createElement('canvas');
    document.body.appendChild(surface);
    const ci = { sendKeyEvent: () => { throw new Error('сессия закрыта'); } };
    const keyboard = createKeyboard({ keys: createKeyBus({ ci }).owner('keyboard'), surface });
    keyboard.attach();
    surface.focus();
    const event = key('keydown', { code: 'KeyW', key: 'w' });
    window.dispatchEvent(event);
    assert(event.defaultPrevented, 'событие всё равно проглочено');
    keyboard.detach();
    surface.remove();
});

// --- Наблюдатель нажатий ----------------------------------------------

test('onKey получает браузерный код каждой нажатой клавиши', () => {
    const surface = document.createElement('canvas');
    document.body.appendChild(surface);
    const ci = { sendKeyEvent: () => {} };
    const seen = [];
    const keyboard = createKeyboard({ keys: createKeyBus({ ci }).owner('keyboard'), surface, onKey: (code) => seen.push(code) });
    keyboard.attach();
    surface.focus();

    window.dispatchEvent(key('keydown', { code: 'F2', key: 'F2' }));
    window.dispatchEvent(key('keydown', { code: 'KeyW', key: 'w' }));
    // Отпускание наблюдателю не интересно: сохранение в игре — это нажатие.
    window.dispatchEvent(key('keyup', { code: 'KeyW', key: 'w' }));
    assertEqual(seen.join(','), 'F2,KeyW', 'коды пришли в порядке нажатий, без keyup');

    // Клавиша без пары в таблице GLFW до эмулятора не доходит, а наблюдателя касается:
    // по ней всё равно видно, что игрок что-то делает (продление тишины автосохранения).
    seen.length = 0;
    window.dispatchEvent(key('keydown', { code: 'Lang1', key: 'Lang1' }));
    assertEqual(seen.join(','), 'Lang1', 'незамаппленная клавиша тоже видна наблюдателю');

    // Чужой фокус — не наше дело: перехвата нет, наблюдателя тоже.
    seen.length = 0;
    surface.blur();
    window.dispatchEvent(key('keydown', { code: 'F2', key: 'F2' }));
    assertEqual(seen.length, 0, 'без фокуса наблюдатель молчит');

    keyboard.detach();
    surface.remove();
});

test('упавший onKey не съедает нажатие игрока', () => {
    const surface = document.createElement('canvas');
    document.body.appendChild(surface);
    const ci = { calls: [], sendKeyEvent(...args) { this.calls.push(args); } };
    const keyboard = createKeyboard({ keys: createKeyBus({ ci }).owner('keyboard'), surface, onKey: () => { throw new Error('кривой наблюдатель'); } });
    keyboard.attach();
    surface.focus();

    const event = key('keydown', { code: 'KeyW', key: 'w' });
    window.dispatchEvent(event);
    assert(event.defaultPrevented, 'событие всё равно проглочено');
    assertEqual(ci.calls.length, 1, 'нажатие всё равно уехало в эмулятор');

    keyboard.detach();
    surface.remove();
});

report('input keyboard');
