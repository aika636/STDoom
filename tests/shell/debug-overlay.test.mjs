// Тесты отладочного оверлея (ключ debugOverlay) под jsdom.
//
// Оверлей — единственный способ увидеть cpuMetrics эмулятора, не имея слуха и
// секундомера. Проверяем не картинку, а контракт: cpuMetrics разворачиваются в
// строки, опрос идёт по таймеру и не накладывается сам на себя, а сломанный
// asyncifyStats() не роняет окно.
//
// Требуется jsdom: npm install --no-save jsdom
// Запуск: node tests/shell/debug-overlay.test.mjs

import { JSDOM } from 'jsdom';
import { assert, assertEqual, report, test } from '../_harness.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const { createDebugOverlay } = await import('../../src/shell/debug-overlay.js');

const rowsOf = (overlay) => Array.from(overlay.element.querySelectorAll('.stdoom-debug-row'))
    .map((row) => [
        row.querySelector('.stdoom-debug-key').textContent,
        row.querySelector('.stdoom-debug-value').textContent,
    ]);

console.log('debug-overlay (jsdom)');

await test('cpuMetrics разворачиваются в строки рядом с нашими цифрами', async () => {
    const overlay = createDebugOverlay({
        getStats: () => ({ отрисовано: 120, cpuMetrics: { cpuUsed: 12.3456, frameSkip: 0 } }),
    });
    await overlay.refresh();

    const rows = Object.fromEntries(rowsOf(overlay));
    assertEqual(rows['отрисовано'], '120', 'наша цифра');
    assertEqual(rows.cpuUsed, '12.35', 'дробное округлено до сотых');
    assertEqual(rows.frameSkip, '0', 'ноль показывается, а не прячется');
    assert(!('cpuMetrics' in rows), 'вложенный объект отдельной строкой не выводится');
    overlay.destroy();
});

await test('пустая или отсутствующая статистика не даёт пустого окошка', async () => {
    const overlay = createDebugOverlay({ getStats: () => null });
    await overlay.refresh();
    assertEqual(overlay.element.textContent, 'статистика недоступна', 'внятная надпись вместо пустоты');
    overlay.destroy();
});

await test('упавший asyncifyStats() не роняет оверлей', async () => {
    const overlay = createDebugOverlay({
        getStats: () => { throw new Error('воркер закрылся'); },
    });
    await overlay.refresh();
    assertEqual(overlay.element.textContent, 'статистика недоступна', 'сообщение вместо исключения');
    overlay.destroy();
});

await test('start вставляет оверлей в контейнер и показывает его, stop — прячет', async () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    const overlay = createDebugOverlay({ box, getStats: () => ({ cpuUsed: 1 }), interval: 10 });

    assertEqual(overlay.element.hidden, true, 'до старта скрыт');
    overlay.start();
    assertEqual(overlay.element.parentElement, box, 'вставлен в контейнер');
    assertEqual(overlay.element.hidden, false, 'показан');
    assertEqual(overlay.running, true, 'опрос идёт');

    overlay.stop();
    assertEqual(overlay.element.hidden, true, 'скрыт');
    assertEqual(overlay.running, false, 'опрос остановлен');
    // Повторный stop безопасен: настройку можно щёлкать сколько угодно.
    overlay.stop();

    overlay.destroy();
    assert(!overlay.element.isConnected, 'разметка убрана');
    box.remove();
});

await test('пока прошлый запрос не вернулся, новый не отправляется', async () => {
    let calls = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const overlay = createDebugOverlay({
        getStats: () => { calls++; return held; },
    });

    const first = overlay.refresh();
    await overlay.refresh();
    assertEqual(calls, 1, 'второй запрос не ушёл');

    release({ cpuUsed: 2 });
    await first;
    await overlay.refresh();
    assertEqual(calls, 2, 'после ответа опрос возобновился');
    overlay.destroy();
});

await test('destroy глушит таймер: после него опросов больше нет', async () => {
    let calls = 0;
    const overlay = createDebugOverlay({ getStats: () => { calls++; return { cpuUsed: 1 }; }, interval: 5 });
    overlay.start();
    const afterStart = calls;
    overlay.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEqual(calls, afterStart, 'новых опросов не было');
});

report('debug-overlay');
