// Тесты WebGL-рендерера. WebGL в jsdom нет — контекст подменён объектом-шпионом
// через canvas.getContext, а requestAnimationFrame сделан ручной очередью, чтобы
// коалесценция кадров проверялась детерминированно.
//
// Требуется jsdom: npm install --no-save jsdom
// Запуск: node tests/dos/render.test.mjs

import { JSDOM } from 'jsdom';
import { assert, assertEqual, report, test } from '../_harness.mjs';

const dom = new JSDOM('<!doctype html><html><body><div id="box"></div></body></html>');

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

// --- Ручной requestAnimationFrame ---------------------------------------------
// Живые таймеры в тестах недопустимы: кадр «браузера» наступает только тогда,
// когда его позовёт flushFrame().
let rafQueue = [];
let rafSeq = 0;
globalThis.requestAnimationFrame = (cb) => {
    const id = ++rafSeq;
    rafQueue.push({ id, cb });
    return id;
};
globalThis.cancelAnimationFrame = (id) => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
};
/** Один «кадр браузера»: выполняет всё, что было запланировано к этому моменту. */
function flushFrame() {
    const queue = rafQueue;
    rafQueue = [];
    for (const entry of queue) entry.cb();
    return queue.length;
}

const { createRenderer } = await import('../../src/dos/render.js');

console.log('dos render');

/** Шпион вместо WebGLRenderingContext: пишет все вызовы, отвечает «всё хорошо». */
function makeGl() {
    const calls = [];
    const record = (name) => (...args) => { calls.push({ name, args }); };
    const gl = {
        calls,
        // Константы — уникальные строки, чтобы перепутанный аргумент был виден в тесте.
        VERTEX_SHADER: 'VERTEX_SHADER',
        FRAGMENT_SHADER: 'FRAGMENT_SHADER',
        COMPILE_STATUS: 'COMPILE_STATUS',
        LINK_STATUS: 'LINK_STATUS',
        ARRAY_BUFFER: 'ARRAY_BUFFER',
        STATIC_DRAW: 'STATIC_DRAW',
        FLOAT: 'FLOAT',
        TEXTURE_2D: 'TEXTURE_2D',
        TEXTURE_MIN_FILTER: 'TEXTURE_MIN_FILTER',
        TEXTURE_MAG_FILTER: 'TEXTURE_MAG_FILTER',
        TEXTURE_WRAP_S: 'TEXTURE_WRAP_S',
        TEXTURE_WRAP_T: 'TEXTURE_WRAP_T',
        LINEAR: 'LINEAR',
        CLAMP_TO_EDGE: 'CLAMP_TO_EDGE',
        UNPACK_ALIGNMENT: 'UNPACK_ALIGNMENT',
        RGB: 'RGB',
        RGBA: 'RGBA',
        UNSIGNED_BYTE: 'UNSIGNED_BYTE',
        TRIANGLE_STRIP: 'TRIANGLE_STRIP',

        createShader: () => ({}),
        shaderSource: record('shaderSource'),
        compileShader: record('compileShader'),
        getShaderParameter: () => true,
        getShaderInfoLog: () => '',
        deleteShader: record('deleteShader'),
        createProgram: () => ({}),
        attachShader: record('attachShader'),
        linkProgram: record('linkProgram'),
        getProgramParameter: () => true,
        getProgramInfoLog: () => '',
        useProgram: record('useProgram'),
        createBuffer: () => ({}),
        bindBuffer: record('bindBuffer'),
        bufferData: record('bufferData'),
        getAttribLocation: () => 0,
        enableVertexAttribArray: record('enableVertexAttribArray'),
        vertexAttribPointer: record('vertexAttribPointer'),
        createTexture: () => ({}),
        bindTexture: record('bindTexture'),
        texParameteri: record('texParameteri'),
        getUniformLocation: () => ({}),
        uniform1i: record('uniform1i'),
        pixelStorei: record('pixelStorei'),
        viewport: record('viewport'),
        texImage2D: record('texImage2D'),
        texSubImage2D: record('texSubImage2D'),
        drawArrays: record('drawArrays'),
        deleteTexture: record('deleteTexture'),
        deleteBuffer: record('deleteBuffer'),
        deleteProgram: record('deleteProgram'),
        getExtension: () => null,
    };
    gl.of = (name) => calls.filter((c) => c.name === name);
    return gl;
}

function setup({ gl = makeGl() } = {}) {
    const box = document.createElement('div');
    document.body.appendChild(box);
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    canvas.getContext = () => gl;
    const renderer = createRenderer(canvas, { box });
    return { renderer, gl, canvas, box };
}

/** Кадр 320x200 в RGB: 3 байта на пиксель, первый пиксель помечен маркером. */
function frame(width, height, marker) {
    const bytes = new Uint8Array(width * height * 3);
    bytes[0] = marker;
    return bytes;
}

// --- RGB и только RGB ---------------------------------------------------------

test('текстура выделяется как RGB, ветки RGBA нет', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);
    const alloc = gl.of('texImage2D');
    assertEqual(alloc.length, 1, 'одно выделение текстуры');
    const [target, level, internal, w, h, border, format, type, data] = alloc[0].args;
    assertEqual(target, gl.TEXTURE_2D, 'цель');
    assertEqual(level, 0, 'уровень мипа');
    assertEqual(internal, gl.RGB, 'внутренний формат RGB');
    assertEqual(format, gl.RGB, 'формат RGB');
    assertEqual(type, gl.UNSIGNED_BYTE, 'тип байтовый');
    assertEqual(w, 320, 'ширина');
    assertEqual(h, 200, 'высота');
    assertEqual(border, 0, 'без рамки');
    assertEqual(data, null, 'содержимое зальётся ближайшим кадром');
    assert(!gl.calls.some((c) => c.args.includes(gl.RGBA)), 'RGBA не упоминается нигде');
    renderer.dispose();
});

test('кадр заливается тремя байтами на пиксель', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);
    const rgb = frame(320, 200, 7);
    renderer.pushFrame(rgb);
    flushFrame();

    const sub = gl.of('texSubImage2D');
    assertEqual(sub.length, 1, 'одна заливка');
    const [, , x, y, w, h, format, type, data] = sub[0].args;
    assertEqual(x, 0, 'смещение X');
    assertEqual(y, 0, 'смещение Y');
    assertEqual(w, 320, 'ширина');
    assertEqual(h, 200, 'высота');
    assertEqual(format, gl.RGB, 'формат RGB');
    assertEqual(type, gl.UNSIGNED_BYTE, 'тип байтовый');
    assertEqual(data.length, 320 * 200 * 3, 'ровно 3 байта на пиксель');
    assertEqual(renderer.framesDrawn, 1, 'кадр отрисован');
    renderer.dispose();
});

test('выравнивание распаковки 1: строка 320*3 = 960 байт не кратна 4', () => {
    const { renderer, gl } = setup();
    const store = gl.of('pixelStorei');
    assertEqual(store.length, 1, 'вызвано один раз при создании');
    assertEqual(store[0].args[0], gl.UNPACK_ALIGNMENT, 'параметр');
    assertEqual(store[0].args[1], 1, 'значение 1');
    renderer.dispose();
});

test('кадр длиннее ожидаемого обрезается, короче — пропускается молча', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);

    renderer.pushFrame(frame(320, 200, 1).subarray(0, 100));
    flushFrame();
    assertEqual(gl.of('texSubImage2D').length, 0, 'короткий кадр пропущен');
    assertEqual(renderer.framesDrawn, 0, 'ничего не нарисовано');

    const long = new Uint8Array(320 * 200 * 3 + 999);
    renderer.pushFrame(long);
    flushFrame();
    const sub = gl.of('texSubImage2D');
    assertEqual(sub.length, 1, 'длинный кадр отрисован');
    assertEqual(sub[0].args[8].length, 320 * 200 * 3, 'обрезан до ожидаемой длины');
    renderer.dispose();
});

test('без известного размера кадр не рисуется', () => {
    const { renderer, gl } = setup();
    renderer.pushFrame(frame(320, 200, 1));
    flushFrame();
    assertEqual(gl.of('texSubImage2D').length, 0, 'размер не известен — молчим');
    renderer.dispose();
});

// --- Коалесценция через rAF ---------------------------------------------------

test('два pushFrame между кадрами браузера дают ровно одну отрисовку', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);
    renderer.pushFrame(frame(320, 200, 1));
    renderer.pushFrame(frame(320, 200, 2));
    renderer.pushFrame(frame(320, 200, 3));
    assertEqual(rafQueue.length, 1, 'запланирован один rAF');

    flushFrame();
    assertEqual(renderer.framesDrawn, 1, 'одна отрисовка на три кадра');
    const drawn = gl.of('texSubImage2D')[0].args[8];
    assertEqual(drawn[0], 3, 'нарисован ПОСЛЕДНИЙ кадр');
    renderer.dispose();
});

test('следующий кадр планирует новый rAF, лишних отрисовок нет', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);
    renderer.pushFrame(frame(320, 200, 1));
    flushFrame();
    renderer.pushFrame(frame(320, 200, 2));
    flushFrame();
    assertEqual(renderer.framesDrawn, 2, 'два кадра — две отрисовки');
    assertEqual(gl.of('texSubImage2D')[1].args[8][0], 2, 'во втором кадре второй буфер');

    // Кадр браузера без новых кадров DOSBox ничего не рисует.
    flushFrame();
    assertEqual(renderer.framesDrawn, 2, 'холостой кадр не рисует');
    renderer.dispose();
});

// --- Ссылка на буфер эмулятора не хранится -------------------------
//
// emulators@8.4.1 держит ОДИН массив `this.rgb` на видеорежим и патчит его строками
// из воркера (onFrameLines), отдавая в onFrame одну и ту же ссылку. Отложенная до rAF
// заливка обязана поэтому работать с копией, иначе нарисуется буфер, уже затёртый
// следующими кадрами.

test('кадр копируется при push — правка буфера эмулятора не влияет на отрисовку', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);

    // Ровно то, что делает js-dos: один буфер, который патчится на месте.
    const shared = frame(320, 200, 1);
    renderer.pushFrame(shared);
    shared[0] = 99;          // эмулятор перепатчил свой буфер ДО кадра браузера
    flushFrame();

    const drawn = gl.of('texSubImage2D')[0].args[8];
    assertEqual(drawn[0], 1, 'нарисовано то, что было на момент push');
    assert(drawn.buffer !== shared.buffer, 'заливается своя память, не память эмулятора');
    renderer.dispose();
});

test('коалесценция с одним буфером эмулятора берёт последний push', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);

    const shared = frame(320, 200, 1);
    renderer.pushFrame(shared);
    shared[0] = 2;
    renderer.pushFrame(shared);
    shared[0] = 3;
    renderer.pushFrame(shared);
    shared[0] = 0;           // а это уже кадр, которого мы не видели
    flushFrame();

    assertEqual(renderer.framesDrawn, 1, 'одна отрисовка на три кадра');
    assertEqual(gl.of('texSubImage2D')[0].args[8][0], 3, 'нарисован последний ЗАПУШЕННЫЙ кадр');
    renderer.dispose();
});

test('приёмный буфер переиспользуется — аллокации на кадр нет', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);
    for (let i = 1; i <= 4; i++) {
        renderer.pushFrame(frame(320, 200, i));
        flushFrame();
    }
    const subs = gl.of('texSubImage2D');
    assertEqual(subs.length, 4, 'четыре заливки');
    const first = subs[0].args[8].buffer;
    for (const sub of subs) {
        assert(sub.args[8].buffer === first, 'все кадры залиты из одной и той же памяти');
    }
    renderer.dispose();
});

test('drawArrays зовётся ровно раз на отрисованный кадр', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);
    renderer.pushFrame(frame(320, 200, 1));
    renderer.pushFrame(frame(320, 200, 2));
    flushFrame();
    const draws = gl.of('drawArrays');
    assertEqual(draws.length, 1, 'один вызов');
    assertEqual(draws[0].args[0], gl.TRIANGLE_STRIP, 'полноэкранный quad');
    assertEqual(draws[0].args[2], 4, 'четыре вершины');
    renderer.dispose();
});

// --- resize -------------------------------------------------------------------

test('resize перевыделяет текстуру только при реальном изменении размера', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);
    renderer.resize(320, 200);
    renderer.resize(320, 200);
    assertEqual(gl.of('texImage2D').length, 1, 'повтор того же размера — без перевыделения');

    renderer.resize(640, 400);
    assertEqual(gl.of('texImage2D').length, 2, 'новый размер — перевыделение');
    assertEqual(renderer.size.width, 640, 'ширина обновлена');
    assertEqual(renderer.size.height, 400, 'высота обновлена');
    renderer.dispose();
});

test('resize с нулевым или отсутствующим размером игнорируется', () => {
    const { renderer, gl } = setup();
    renderer.resize(0, 200);
    renderer.resize(320, 0);
    renderer.resize(undefined, undefined);
    assertEqual(gl.of('texImage2D').length, 0, 'мусорный размер не трогает текстуру');
    assertEqual(renderer.size.width, 0, 'размер не менялся');
    renderer.dispose();
});

test('resize задаёт backing store канваса и viewport', () => {
    const { renderer, gl, canvas } = setup();
    renderer.resize(320, 200);
    assertEqual(canvas.width, 320, 'нативная ширина');
    assertEqual(canvas.height, 200, 'нативная высота');
    const viewport = gl.of('viewport');
    assertEqual(viewport.length, 1, 'viewport выставлен');
    assertEqual(viewport[0].args.join(','), '0,0,320,200', 'на весь кадр');
    renderer.dispose();
});

test('леттербокс: CSS-размер держит 4:3 внутри контейнера', () => {
    const gl = makeGl();
    const box = document.createElement('div');
    document.body.appendChild(box);
    // clientWidth/clientHeight в jsdom всегда 0 — подменяем.
    Object.defineProperty(box, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 300 });
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    canvas.getContext = () => gl;
    const renderer = createRenderer(canvas, { box });

    renderer.resize(320, 200);
    // 800 по ширине дало бы 600 по высоте — не влезает, значит упираемся в высоту.
    assertEqual(canvas.style.height, '300px', 'высота по контейнеру');
    assertEqual(canvas.style.width, '400px', 'ширина = высота * 4/3');
    renderer.dispose();
    box.remove();
});

// --- Устойчивость к ошибкам ---------------------------------------------------

test('исключение внутри отрисовки не убивает цикл', () => {
    const gl = makeGl();
    let boom = true;
    const original = gl.texSubImage2D;
    gl.texSubImage2D = (...args) => {
        if (boom) throw new Error('контекст потерян');
        return original(...args);
    };
    const { renderer } = setup({ gl });
    renderer.resize(320, 200);

    renderer.pushFrame(frame(320, 200, 1));
    flushFrame();
    assertEqual(renderer.errorsInRow, 1, 'ошибка посчитана, наружу не вылетела');

    // Главное: следующий кадр по-прежнему планирует rAF.
    boom = false;
    renderer.pushFrame(frame(320, 200, 2));
    assertEqual(rafQueue.length, 1, 'rAF снова запланирован');
    flushFrame();
    assertEqual(renderer.framesDrawn, 1, 'кадр отрисован после сбоя');
    assertEqual(renderer.errorsInRow, 0, 'счётчик ошибок сброшен');
    renderer.dispose();
});

// --- Экран отказа ------------------------------------------------------
//
// Порог берём маленький: смысл проверок в самом правиле «ровно один раз на серию»,
// а не в числе 30.

/** Рендерер, у которого отрисовка ломается по флагу. Возвращает ручку на этот флаг. */
function brokenSetup({ errorLimit = 3, onFailure } = {}) {
    const gl = makeGl();
    const state = { boom: true };
    const original = gl.texSubImage2D;
    gl.texSubImage2D = (...args) => {
        if (state.boom) throw new Error('контекст потерян');
        return original(...args);
    };
    const box = document.createElement('div');
    document.body.appendChild(box);
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    canvas.getContext = () => gl;
    const renderer = createRenderer(canvas, { box, errorLimit, onFailure });
    renderer.resize(320, 200);
    return { renderer, gl, state, box };
}

/** Один сломанный (или починенный) кадр: push + кадр браузера. */
function tick(renderer, marker = 1) {
    renderer.pushFrame(frame(320, 200, marker));
    flushFrame();
}

test('onFailure зовётся ровно один раз — на пороге, не раньше', () => {
    const seen = [];
    const { renderer, box } = brokenSetup({ errorLimit: 3, onFailure: (err) => seen.push(err) });

    tick(renderer, 1);
    tick(renderer, 2);
    assertEqual(seen.length, 0, 'до порога экран отказа не показывается');
    assertEqual(renderer.errorsInRow, 2, 'ошибки считаются');

    tick(renderer, 3);
    assertEqual(seen.length, 1, 'на пороге колбэк вызван');
    assert(seen[0] instanceof Error, 'в аргументе последняя ошибка');
    assert(/контекст потерян/.test(seen[0].message), 'именно та ошибка, что бросил gl');

    // Серия продолжается — второй раз тот же экран не показываем.
    tick(renderer, 4);
    tick(renderer, 5);
    assertEqual(seen.length, 1, 'на продолжении серии колбэк молчит');

    renderer.dispose();
    box.remove();
});

test('успешный кадр сбрасывает счётчик, и отказ может сработать снова', () => {
    const seen = [];
    const { renderer, state, box } = brokenSetup({ errorLimit: 3, onFailure: () => seen.push(1) });

    for (let i = 0; i < 3; i++) tick(renderer, i);
    assertEqual(seen.length, 1, 'первый отказ');

    // Сессия оправилась.
    state.boom = false;
    tick(renderer, 9);
    assertEqual(renderer.errorsInRow, 0, 'счётчик сброшен успешным кадром');
    assertEqual(renderer.framesDrawn, 1, 'кадр действительно нарисован');

    // И сломалась снова: нужен НОВЫЙ полный набор порога.
    state.boom = true;
    tick(renderer, 10);
    tick(renderer, 11);
    assertEqual(seen.length, 1, 'частичная серия отказ не поднимает');
    tick(renderer, 12);
    assertEqual(seen.length, 2, 'новый полный набор порога — новый отказ');

    renderer.dispose();
    box.remove();
});

test('resetErrors() снимает защёлку — иначе второго экрана не будет никогда', () => {
    const seen = [];
    const { renderer, box } = brokenSetup({ errorLimit: 2, onFailure: () => seen.push(1) });

    tick(renderer, 1);
    tick(renderer, 2);
    assertEqual(seen.length, 1, 'первый отказ');

    // Игрок нажал «Продолжить», а рендер так и не оправился: успешного кадра, который
    // снял бы защёлку, не будет — снимаем её вручную.
    renderer.resetErrors();
    assertEqual(renderer.errorsInRow, 0, 'счётчик обнулён');

    tick(renderer, 3);
    assertEqual(seen.length, 1, 'частичная серия отказ не поднимает');
    tick(renderer, 4);
    assertEqual(seen.length, 2, 'после сброса отказ приходит снова');

    renderer.dispose();
    box.remove();
});

test('бросающий onFailure не ломает цикл кадров', () => {
    let calls = 0;
    const { renderer, state, box } = brokenSetup({
        errorLimit: 2,
        onFailure: () => { calls++; throw new Error('экран отказа сам упал'); },
    });

    tick(renderer, 1);
    tick(renderer, 2);
    assertEqual(calls, 1, 'колбэк вызван');

    // Главное: rAF по-прежнему планируется, и починенный рендер снова рисует.
    state.boom = false;
    renderer.pushFrame(frame(320, 200, 3));
    assertEqual(rafQueue.length, 1, 'rAF запланирован после падения колбэка');
    flushFrame();
    assertEqual(renderer.framesDrawn, 1, 'кадр отрисован');

    renderer.dispose();
    box.remove();
});

test('порог по умолчанию — 30 ошибок подряд', () => {
    const { renderer } = setup();
    assertEqual(renderer.errorLimit, 30, 'значение по умолчанию из ');
    renderer.dispose();
});

test('без onFailure рендерер ведёт себя как раньше: считает и не падает', () => {
    const { renderer, box } = brokenSetup({ errorLimit: 2 });
    tick(renderer, 1);
    tick(renderer, 2);
    tick(renderer, 3);
    assertEqual(renderer.errorsInRow, 3, 'счётчик работает и без колбэка');
    renderer.dispose();
    box.remove();
});

test('createRenderer падает внятно, если WebGL недоступен', () => {
    const canvas = document.createElement('canvas');
    canvas.getContext = () => null;
    let message = '';
    try {
        createRenderer(canvas, { box: document.getElementById('box') });
    } catch (err) {
        message = err.message;
    }
    assert(/WebGL/.test(message), `сообщение про WebGL, получено «${message}»`);
});

// --- dispose ------------------------------------------------------------------

test('dispose() отменяет запланированный кадр и глушит дальнейшие push', () => {
    const { renderer, gl } = setup();
    renderer.resize(320, 200);
    renderer.pushFrame(frame(320, 200, 1));
    assertEqual(rafQueue.length, 1, 'кадр запланирован');

    renderer.dispose();
    assertEqual(rafQueue.length, 0, 'rAF отменён');

    renderer.pushFrame(frame(320, 200, 2));
    assertEqual(rafQueue.length, 0, 'после dispose ничего не планируется');
    flushFrame();
    assertEqual(renderer.framesDrawn, 0, 'ничего не нарисовано');
    assertEqual(gl.of('deleteTexture').length, 1, 'текстура освобождена');
    assertEqual(gl.of('deleteProgram').length, 1, 'программа освобождена');

    // Повторный dispose безопасен.
    renderer.dispose();
    assertEqual(gl.of('deleteTexture').length, 1, 'второй раз ресурсы не освобождаем');
});


// --- Потеря контекста WebGL ---------------------------------------------
//
// Ровно тот отказ, который назван в тексте экрана. До появления этих проверок он был
// ЕДИНСТВЕННЫМ, который экран не ловил: после потери контекста вызовы gl не бросают,
// а молча становятся пустышками, — счётчик ошибок не набирался никогда, картинка
// замирала навсегда и без единого слова. Мок здесь намеренно НЕ бросает: настоящий
// WebGLRenderingContext тоже не бросает, и тест, где он бросал бы, проверял бы не то.

await test('потеря контекста поднимает экран отказа сразу, без набора порога', () => {
    let failure = null;
    const gl = makeGl();
    const box = document.createElement('div');
    document.body.appendChild(box);
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    canvas.getContext = () => gl;
    const renderer = createRenderer(canvas, { box, onFailure: (err) => { failure = err; } });
    renderer.resize(320, 200);

    const event = new dom.window.Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(event);

    assert(failure instanceof Error, 'экран отказа поднят');
    assertEqual(renderer.contextLost, true, 'рендерер знает, что контекста нет');
    assertEqual(renderer.errorsInRow, 0, 'и это НЕ поток ошибок кадра');
    assert(event.defaultPrevented, 'preventDefault обязателен — иначе восстановления не будет');

    box.remove();
});

await test('пока контекста нет, кадры не рисуются и не копятся', () => {
    const gl = makeGl();
    const box = document.createElement('div');
    document.body.appendChild(box);
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    canvas.getContext = () => gl;
    const renderer = createRenderer(canvas, { box, onFailure: () => {} });
    renderer.resize(320, 200);
    canvas.dispatchEvent(new dom.window.Event('webglcontextlost', { cancelable: true }));

    const drawn = gl.of('drawArrays').length;
    renderer.pushFrame(frame(320, 200, 7));
    flushFrame();
    assertEqual(gl.of('drawArrays').length, drawn, 'ничего не нарисовано');

    box.remove();
});

await test('восстановление контекста пересобирает ресурсы и снимает защёлку', () => {
    let failures = 0;
    const gl = makeGl();
    const box = document.createElement('div');
    document.body.appendChild(box);
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    canvas.getContext = () => gl;
    const renderer = createRenderer(canvas, { box, onFailure: () => { failures++; } });
    renderer.resize(320, 200);
    canvas.dispatchEvent(new dom.window.Event('webglcontextlost', { cancelable: true }));
    assertEqual(failures, 1, 'отказ показан один раз');

    const programsBefore = gl.of('linkProgram').length;
    canvas.dispatchEvent(new dom.window.Event('webglcontextrestored'));

    assertEqual(renderer.contextLost, false, 'контекст вернулся');
    assert(gl.of('linkProgram').length > programsBefore, 'программа собрана заново');
    assert(gl.of('texImage2D').length > 0, 'текстура перевыделена под текущий размер');

    // И рисование снова работает.
    renderer.pushFrame(frame(320, 200, 9));
    flushFrame();
    assert(gl.of('drawArrays').length > 0, 'кадр нарисован');

    // Защёлка снята: следующая потеря снова поднимет экран.
    canvas.dispatchEvent(new dom.window.Event('webglcontextlost', { cancelable: true }));
    assertEqual(failures, 2, 'второй отказ показан');

    box.remove();
});

await test('recoverContext() просит вернуть контекст, потерянный вручную', () => {
    let restored = 0;
    const gl = makeGl();
    gl.getExtension = () => ({ restoreContext: () => { restored++; }, loseContext: () => {} });
    const box = document.createElement('div');
    document.body.appendChild(box);
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    canvas.getContext = () => gl;
    const renderer = createRenderer(canvas, { box, onFailure: () => {} });
    renderer.resize(320, 200);

    // Контекста ещё не теряли — просить нечего.
    assertEqual(renderer.recoverContext(), false, 'восстанавливать нечего');
    assertEqual(restored, 0, 'и restoreContext() не звался');

    canvas.dispatchEvent(new dom.window.Event('webglcontextlost', { cancelable: true }));
    assertEqual(renderer.recoverContext(), true, 'было что восстанавливать');
    assertEqual(restored, 1, 'restoreContext() позван — сам такой контекст не вернётся');

    box.remove();
});

// --- Защёлка снимается только НАСТОЯЩИМ кадром ---------------------------------

await test('холостая отрисовка не снимает счётчик ошибок', () => {
    const gl = makeGl();
    const box = document.createElement('div');
    document.body.appendChild(box);
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    canvas.getContext = () => gl;
    const renderer = createRenderer(canvas, { box, onFailure: () => {} });
    renderer.resize(320, 200);

    // Ошибка приёма кадра: счётчик пошёл.
    gl.texSubImage2D = () => { throw new Error('сломано'); };
    renderer.pushFrame(frame(320, 200, 1));
    flushFrame();
    const after = renderer.errorsInRow;
    assert(after > 0, 'ошибка засчитана');

    // Теперь кадр приходит, а размер вырос: draw() выйдет вхолостую, ничего не
    // нарисовав. Рендер живым это не доказывает — счётчик обязан устоять.
    gl.texSubImage2D = () => {};
    renderer.pushFrame(frame(320, 200, 2));
    renderer.resize(640, 400);
    flushFrame();
    assertEqual(renderer.errorsInRow, after, 'холостой кадр счётчик не сбросил');

    box.remove();
});

report('dos render');
