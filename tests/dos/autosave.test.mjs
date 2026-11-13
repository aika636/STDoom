// Сохранение по факту сохранения в игре. Модуль чистый: ни DOM, ни jsdom,
// таймеры и часы подменяются через параметры — иначе тест ждал бы секундами.
//
// Запуск: node tests/dos/autosave.test.mjs

import { assert, assertEqual, report, test } from '../_harness.mjs';
import { MAX_MS, QUIET_MS, SAVE_KEYS, createAutosave } from '../../src/dos/autosave.js';

console.log('dos autosave');

/** Управляемые часы и таймеры: время двигаем сами, вызовы считаем. */
function clock() {
    let time = 0;
    let next = 1;
    const timers = new Map();
    return {
        now: () => time,
        setTimer(fn, ms) {
            const id = next++;
            timers.set(id, { fn, at: time + ms });
            return id;
        },
        clearTimer(id) { timers.delete(id); },
        get pending() { return timers.size; },
        /** Двигает время вперёд, выполняя всё, чему срок пришёл. */
        advance(ms) {
            const target = time + ms;
            for (;;) {
                let due = null;
                for (const [id, timer] of timers) {
                    if (timer.at <= target && (due === null || timer.at < timers.get(due).at)) due = id;
                }
                if (due === null) break;
                const timer = timers.get(due);
                timers.delete(due);
                time = timer.at;
                timer.fn();
            }
            time = target;
        },
    };
}

function harness() {
    const c = clock();
    const calls = [];
    const autosave = createAutosave({
        persist: () => { calls.push(c.now()); return true; },
        setTimer: c.setTimer,
        clearTimer: c.clearTimer,
        now: c.now,
    });
    return { autosave, calls, clock: c };
}

test('F2 и F6 — клавиши сохранения ванильного DOOM', () => {
    assert(SAVE_KEYS.has('F2'), 'F2 — Save Game');
    assert(SAVE_KEYS.has('F6'), 'F6 — быстрое сохранение');
    assertEqual(SAVE_KEYS.size, 2, 'больше клавиш сохранения у DOOM нет');
    // F3/F9 — загрузка, а не запись: взводить по ним нечего.
    assert(!SAVE_KEYS.has('F3'), 'F3 — загрузка, не сохранение');
    assert(!SAVE_KEYS.has('F9'), 'F9 — быстрая загрузка, не сохранение');
});

test('обычная игра ничего не планирует: без клавиши сохранения таймеров нет', () => {
    const { autosave, calls, clock: c } = harness();
    for (const code of ['KeyW', 'KeyA', 'Space', 'ControlLeft', 'Escape']) autosave.noteKey(code);
    assertEqual(c.pending, 0, 'ни одного таймера');
    assert(!autosave.armed, 'не взведены');
    c.advance(MAX_MS * 2);
    assertEqual(calls.length, 0, 'persist() не звался');
});

test('F2 взводит, но сохраняет не сразу — файл пишется в конце меню', () => {
    const { autosave, calls, clock: c } = harness();
    autosave.noteKey('F2');
    assert(autosave.armed, 'взведены');
    assertEqual(calls.length, 0, 'по самой F2 не сохраняем: меню только открылось');

    c.advance(QUIET_MS - 1);
    assertEqual(calls.length, 0, 'до конца тишины не сохраняем');
    c.advance(1);
    assertEqual(calls.length, 1, 'после тишины сохранение ушло');
    assert(!autosave.armed, 'взвод снят');
});

test('набор имени сейва продлевает тишину, а не срывает сохранение', () => {
    const { autosave, calls, clock: c } = harness();
    autosave.noteKey('F2');
    // Игрок выбирает слот и набирает имя: каждое нажатие отодвигает срок.
    for (const code of ['ArrowDown', 'KeyD', 'KeyO', 'KeyO', 'KeyM', 'Enter']) {
        c.advance(QUIET_MS - 100);
        autosave.noteKey(code);
        assertEqual(calls.length, 0, `после ${code} ещё не сохраняли`);
    }
    c.advance(QUIET_MS);
    assertEqual(calls.length, 1, 'сохранение ушло один раз, после тишины');
});

test('потолок: непрерывный ввод не откладывает сохранение бесконечно', () => {
    const { autosave, calls, clock: c } = harness();
    autosave.noteKey('F2');
    const armedAt = c.now();
    // Клавиша каждые полсекунды — по одной тишине сохранение не наступило бы никогда.
    for (let i = 0; i < 40 && calls.length === 0; i++) {
        c.advance(500);
        autosave.noteKey('KeyW');
    }
    assertEqual(calls.length, 1, 'сохранение всё-таки состоялось');
    assert(calls[0] - armedAt <= MAX_MS, `не позже потолка: ${calls[0] - armedAt} мс`);
});

test('вторая F2 в той же сессии сохраняет второй раз', () => {
    const { autosave, calls, clock: c } = harness();
    autosave.noteKey('F2');
    c.advance(QUIET_MS);
    autosave.noteKey('F6');
    c.advance(QUIET_MS);
    assertEqual(calls.length, 2, 'два сохранения — два persist()');
    assertEqual(autosave.saves, 2, 'счётчик сходится');
});

test('cancel() снимает взвод без сохранения', () => {
    const { autosave, calls, clock: c } = harness();
    autosave.noteKey('F2');
    autosave.cancel();
    assert(!autosave.armed, 'взвод снят');
    assertEqual(c.pending, 0, 'таймер убран, а не оставлен висеть');
    c.advance(MAX_MS * 2);
    assertEqual(calls.length, 0, 'persist() не звался');
});

test('flush() сохраняет немедленно, но только если взведены', () => {
    const { autosave, calls } = harness();
    autosave.flush();
    assertEqual(calls.length, 0, 'без взвода flush() ничего не делает');
    autosave.noteKey('F2');
    autosave.flush();
    assertEqual(calls.length, 1, 'взведённый flush() сохранил сразу');
    autosave.flush();
    assertEqual(calls.length, 1, 'повторный flush() не сохраняет второй раз');
});

test('упавший persist() не роняет ввод и не оставляет вечный взвод', () => {
    const c = clock();
    const autosave = createAutosave({
        persist: () => { throw new Error('хранилище недоступно'); },
        setTimer: c.setTimer,
        clearTimer: c.clearTimer,
        now: c.now,
    });
    autosave.noteKey('F2');
    c.advance(QUIET_MS);
    assert(!autosave.armed, 'взвод снят даже после отказа');
    // Следующее сохранение по-прежнему возможно.
    autosave.noteKey('F2');
    assert(autosave.armed, 'взводится снова');
});

test('отказ асинхронного persist() не уходит в необработанный промис', async () => {
    const c = clock();
    const autosave = createAutosave({
        persist: () => Promise.reject(new Error('IndexedDB недоступен')),
        setTimer: c.setTimer,
        clearTimer: c.clearTimer,
        now: c.now,
    });
    autosave.noteKey('F2');
    c.advance(QUIET_MS);
    // Если бы отказ не ловился, здесь бы сработал unhandledRejection и уронил процесс.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEqual(autosave.saves, 1, 'попытка засчитана');
});


// --- Выход из игры её собственным меню (F10 → y) --------------------------------

test('F10 сохраняет немедленно — ждать уже некогда', () => {
    const { autosave, calls: saved, clock } = harness();
    autosave.noteKey('F6');
    assertEqual(autosave.armed, true, 'взведены');
    assertEqual(saved.length, 0, 'но ещё не писали');

    // Игрок сохранился и тут же решил выйти. F10 открывает «Quit Game? (y/n)» — это
    // последний момент, когда эмулятор ещё отвечает.
    clock.advance(200);
    autosave.noteKey('F10');

    assertEqual(saved.length, 1, 'сохранение ушло сразу');
    assertEqual(autosave.armed, false, 'взвод снят');
});

test('F10 не продлевает ожидание, как прочие клавиши', () => {
    const { autosave, calls: saved, clock } = harness();
    autosave.noteKey('F6');

    // Обычная клавиша продлевает паузу тишины — и вот это на пути F10 → y работало
    // против себя: чем больше игрок нажимал, тем позже писали, а DOOM успевал
    // завершиться раньше таймера и уносил прогресс молча.
    clock.advance(1000);
    autosave.noteKey('KeyW');
    clock.advance(1000);
    assertEqual(saved.length, 0, 'обычная клавиша сдвинула запись');

    autosave.noteKey('F10');
    assertEqual(saved.length, 1, 'а F10 её оборвал и записал');
});

test('F10 без взвода ничего не сохраняет', () => {
    const { autosave, calls: saved } = harness();
    // Игрок просто вышел из игры, ничего за сессию не сохранив: persist() не
    // бесплатен, и вслепую его звать незачем.
    autosave.noteKey('F10');
    assertEqual(saved.length, 0, 'тишина');
});

report('dos autosave');
