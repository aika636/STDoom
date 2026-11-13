// Отладочный оверлей поверх картинки (ключ настроек debugOverlay).
//
// Показывает то, что отдаёт ci.asyncifyStats() — прежде всего cpuMetrics
// (cpuUsed, emulatorSpeed, frameSkip и прочее). Это единственный способ увидеть,
// упирается ли эмулятор в циклы, не полагаясь на слух.
//
// Оверлей опрашивает статистику по таймеру, а не по кадрам: asyncifyStats()
// асинхронен и ходит в воркер, дёргать его каждый кадр — самому же портить замер.
// Пока предыдущий запрос не вернулся, новый не отправляется.
//
// Модуль ничего не знает про эмулятор: ему передают getStats(), который может
// вернуть что угодно плоское. Так его можно проверить под jsdom, где wasm нет.

import { logWarn } from '../log.js';

/** Интервал опроса по умолчанию, мс. */
export const DEFAULT_INTERVAL = 1000;

/**
 * @param {object} params
 * @param {HTMLElement} [params.box] контейнер, поверх которого лечь (обычно .stdoom-stage)
 * @param {() => (object|Promise<object|null>|null)} params.getStats источник цифр
 * @param {number} [params.interval] период опроса, мс
 */
export function createDebugOverlay({ box = null, getStats = null, interval = DEFAULT_INTERVAL } = {}) {
    const element = document.createElement('div');
    element.className = 'stdoom-debug';
    element.hidden = true;

    let timer = null;
    let busy = false;
    let destroyed = false;

    /** Раскладывает статистику в плоский список пар. cpuMetrics вкладывается внутрь. */
    function rows(stats) {
        if (!stats || typeof stats !== 'object') return [];
        const flat = { ...stats, ...(stats.cpuMetrics ?? {}) };
        delete flat.cpuMetrics;
        const result = [];
        for (const [key, value] of Object.entries(flat)) {
            if (typeof value === 'number') {
                result.push([key, String(Math.round(value * 100) / 100)]);
            } else if (typeof value === 'string' || typeof value === 'boolean') {
                result.push([key, String(value)]);
            }
            // Объекты и массивы пропускаем: оверлей маленький, а вложенное дерево
            // в нём всё равно нечитаемо.
        }
        return result;
    }

    function render(stats) {
        const list = rows(stats);
        if (list.length === 0) {
            element.textContent = 'статистика недоступна';
            return;
        }
        const nodes = [];
        for (const [key, value] of list) {
            const row = document.createElement('div');
            row.className = 'stdoom-debug-row';

            const name = document.createElement('span');
            name.className = 'stdoom-debug-key';
            name.textContent = key;

            const number = document.createElement('span');
            number.className = 'stdoom-debug-value';
            number.textContent = value;

            row.append(name, number);
            nodes.push(row);
        }
        element.replaceChildren(...nodes);
    }

    /** Один опрос. Возвращает промис — тестам так удобнее, чем ждать таймер. */
    async function refresh() {
        if (busy || destroyed) return;
        busy = true;
        try {
            render(await getStats?.());
        } catch (err) {
            logWarn('отладочная статистика недоступна', err);
            element.textContent = 'статистика недоступна';
        } finally {
            busy = false;
        }
    }

    function start() {
        if (destroyed || timer !== null) return;
        if (box && element.parentNode !== box) box.appendChild(element);
        element.hidden = false;
        refresh();
        timer = setInterval(() => {
            refresh().catch((err) => logWarn('опрос статистики упал', err));
        }, interval);
    }

    function stop() {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        element.hidden = true;
    }

    function destroy() {
        stop();
        destroyed = true;
        element.remove();
    }

    return {
        element,
        start,
        stop,
        refresh,
        destroy,
        get running() { return timer !== null; },
    };
}
