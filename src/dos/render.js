// WebGL-рендерер кадров DOSBox (план §4.4).
//
// Три вещи, которые легко забыть и которые здесь зафиксированы намеренно:
//   1. Кадр приходит как RGB, 3 байта на пиксель. Поле `rgba` в emulators@8.4.1
//      всегда null — ветки под RGBA здесь нет и быть не должно.
//   2. Буфер кадра переиспользуется эмулятором между кадрами. Ссылку не храним:
//      либо заливаем в текстуру сразу, либо копируем.
//      Доказательство — сам бандл emulators@8.4.1 (assets/jsdos/emulators.js, строка 1,
//      минифицировано): воркер шлёт не кадр целиком, а сообщение `ws-update-lines`
//      с ИЗМЕНИВШИМИСЯ строками, и главный поток патчит ими один и тот же массив:
//          onFrameSize(w,h){...this.rgb=new Uint8Array(w*h*3)...}
//          onFrameLines(lines){for(const l of lines) this.rgb.set(l.heapu8, ...);
//                              this.eventsImpl.fireFrame(this.rgb, this.rgba)}
//      То есть `this.rgb` выделяется ОДИН раз на видеорежим, а в onFrame каждый кадр
//      приходит одна и та же ссылка. Никакого transferable здесь нет: zero-copy из
//      §4.3 — это про heapu8 изменившихся строк, а не про кадр, который видим мы.
//      Поэтому pushFrame копирует пришедшее в свой приёмный буфер (recvBuf), а не
//      кладёт ссылку в pending: отложенная до rAF заливка иначе рисовала бы буфер,
//      уже перепатченный следующими кадрами, а при смене видеорежима — и вовсе чужой
//      массив другого размера. Приёмный буфер переиспользуется: 320*200*3 = 192 КБ
//      35 раз в секунду — не та цена, которую можно платить аллокацией на кадр.
//   3. onFrameSize мог сработать до того, как мы подписались, поэтому вызывающий
//      код обязан сразу после подписки дёрнуть resize() с ci.width()/ci.height().
//
// Кадры коалесцируются через requestAnimationFrame: если DOSBox выдал два кадра
// между кадрами браузера, рисуется только последний. Это же наш единственный
// FPS-лимитер.

import { logWarn, logError } from '../log.js';

const VERTEX_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    // Полноэкранный quad из координат клип-пространства; UV получаем из позиции,
    // по вертикали переворачиваем — DOSBox отдаёт кадр сверху вниз.
    v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() {
    gl_FragColor = texture2D(u_tex, v_uv);
}`;

function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error('компиляция шейдера не удалась: ' + info);
    }
    return shader;
}

/**
 * Создаёт рендерер поверх канваса.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} [opts]
 * @param {number} [opts.forceAspect=4/3] Пиксели VGA 320x200 неквадратные; без
 *   коррекции картинка заметно сплюснута по вертикали.
 * @param {HTMLElement} [opts.box] Контейнер, внутри которого канвас леттербоксится.
 * @param {number} [opts.errorLimit=30] Сколько ошибок отрисовки ПОДРЯД считать отказом.
 * @param {(err: Error) => void} [opts.onFailure] Зовётся РОВНО ОДИН РАЗ при достижении
 *   порога. Успешный кадр сбрасывает и счётчик, и право сработать снова: если сессия
 *   оправилась, отказ повторится только после нового набора порога.
 */
export function createRenderer(canvas, opts = {}) {
    const forceAspect = opts.forceAspect ?? 4 / 3;
    const box = opts.box ?? canvas.parentElement;
    const errorLimit = Number.isFinite(opts.errorLimit) && opts.errorLimit > 0
        ? Math.trunc(opts.errorLimit)
        : 30;
    const onFailure = typeof opts.onFailure === 'function' ? opts.onFailure : null;

    const gl = canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL недоступен');

    // Ресурсы GL собраны в функцию, а не разложены по константам: после потери
    // контекста ВСЕ они становятся недействительными, и восстановление — это ровно
    // повторный вызов setupGl() (см. onContextRestored ниже).
    let program = null;
    let vs = null;
    let fs = null;
    let buffer = null;
    let texture = null;

    function setupGl() {
        program = gl.createProgram();
        vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
        fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error('линковка программы не удалась: ' + gl.getProgramInfoLog(program));
        }
        gl.useProgram(program);

        buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(program, 'a_pos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
        // Строки кадра 320*3 = 960 байт — кратно 4 не всегда, поэтому выравнивание 1.
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    }

    setupGl();

    let width = 0;
    let height = 0;
    // Приёмный буфер: сюда копируется кадр эмулятора (см. п.2 в шапке). Растёт по
    // необходимости и переиспользуется — аллокации на кадр здесь недопустимы.
    let recvBuf = null;
    // Длина последнего непоказанного кадра; 0 — показывать нечего.
    let pendingLen = 0;
    let rafId = 0;
    let disposed = false;
    let errorsInRow = 0;
    let framesDrawn = 0;
    // Отказ показывается один раз на серию: без флага экран отказа переоткрывался бы
    // на каждом следующем сломанном кадре, то есть 35 раз в секунду.
    let failureReported = false;
    // Контекст потерян. Отдельный флаг от ошибок кадра, потому что это отказ ДРУГОЙ
    // природы: не поток исключений, а одно событие — см. onContextLost.
    let contextLost = false;

    /** Леттербокс: backing store канваса — нативные 320x200, а CSS тянет до 4:3. */
    function layout() {
        if (!box) return;
        const boxW = box.clientWidth;
        const boxH = box.clientHeight;
        if (!boxW || !boxH) return;
        let w = boxW;
        let h = Math.round(w / forceAspect);
        if (h > boxH) {
            h = boxH;
            w = Math.round(h * forceAspect);
        }
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
    }

    /** Смена разрешения эмулируемого видеорежима. */
    function resize(w, h) {
        if (!w || !h || (w === width && h === height)) return;
        width = w;
        height = h;
        canvas.width = w;
        canvas.height = h;
        allocTexture();
        layout();
    }

    /**
     * Виewport и текстура под текущий размер. Отдельно от resize() потому, что
     * восстановленному контексту нужно ровно это, а resize() на неизменившемся
     * размере выходит сразу.
     */
    function allocTexture() {
        if (!width || !height) return;
        gl.viewport(0, 0, width, height);
        // Перевыделяем текстуру под новый размер; содержимое зальётся ближайшим кадром.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, width, height, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
    }

    /**
     * @returns {boolean} нарисовали ли кадр на самом деле. Ответ важен: счётчик
     *   ошибок сбрасывает только НАСТОЯЩАЯ отрисовка. Холостой выход отсюда —
     *   ещё не признак того, что рендер жив, а именно им когда-то и снималась
     *   защёлка отказа (§3.3).
     */
    function draw() {
        rafId = 0;
        const length = pendingLen;
        pendingLen = 0;
        if (disposed || contextLost || !length || !width || !height) return false;

        const expected = width * height * 3;
        if (length < expected) {
            // Кадр пришёл раньше, чем мы узнали новый размер, — пропускаем молча
            // до первого onFrameSize, иначе завалим консоль на каждом ресайзе.
            return false;
        }

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texSubImage2D(
            gl.TEXTURE_2D, 0, 0, 0, width, height,
            gl.RGB, gl.UNSIGNED_BYTE,
            // Всегда вид ровно на ожидаемую длину: recvBuf мог остаться от режима
            // покрупнее и быть длиннее кадра.
            recvBuf.subarray(0, expected),
        );
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        framesDrawn++;
        return true;
    }

    /**
     * Учёт сломанного кадра: и приём (копирование), и сама отрисовка ведут счёт в
     * один счётчик. Для игрока это одно и то же — картинка не обновляется, — и экран
     * отказа §3.3 должен подниматься независимо от того, на каком из двух шагов
     * рендер сломался.
     */
    function noteError(err) {
        errorsInRow++;
        if (errorsInRow === 1) logError('ошибка отрисовки кадра', err);
        if (errorsInRow >= errorLimit) {
            logWarn(`${errorLimit} ошибок отрисовки подряд — рендер, похоже, сломан`);
            reportFailure(err);
        }
    }

    /** Поднять экран отказа — один раз на серию (защёлка `failureReported`). */
    function reportFailure(err) {
        if (failureReported) return;
        failureReported = true;
        // Колбэк защищён: экран отказа, упавший сам, не должен добить
        // ещё и цикл кадров.
        try {
            onFailure?.(err);
        } catch (failErr) {
            logWarn('обработчик отказа отрисовки упал', failErr);
        }
    }

    // --- Потеря и восстановление контекста ------------------------------------
    //
    // ЗАЧЕМ ЭТО ЕСТЬ. Экран отказа §3.3 держался на том, что сломанный рендер БРОСАЕТ
    // исключение: счётчик ошибок ведётся только из catch вокруг draw() и копирования
    // кадра. Но потеря контекста WebGL — не исключение: после неё вызовы gl молча
    // становятся пустышками. То есть при том самом отказе, который назван в тексте
    // экрана («браузер потерял контекст WebGL»), ошибок не набиралось НИ ОДНОЙ,
    // картинка замирала навсегда, и игрок не получал ни экрана, ни слова в консоли.
    // Узнать о потере можно только отсюда — из события.

    function onContextLost(event) {
        // preventDefault обязателен: без него браузер не пришлёт webglcontextrestored
        // вовсе, и восстанавливаться будет нечему.
        event.preventDefault?.();
        contextLost = true;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        pendingLen = 0;
        logError('контекст WebGL потерян');
        reportFailure(new Error('контекст WebGL потерян'));
    }

    function onContextRestored() {
        contextLost = false;
        try {
            // Все объекты GL после потери недействительны — собираем заново.
            setupGl();
            allocTexture();
            layout();
        } catch (err) {
            contextLost = true;
            logError('восстановить контекст WebGL не удалось', err);
            return;
        }
        errorsInRow = 0;
        failureReported = false;
        logWarn('контекст WebGL восстановлен');
    }

    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);

    /**
     * Обработчик onFrame: копирует кадр в свой буфер, рисование — в rAF.
     *
     * Копия делается ЗДЕСЬ, а не в draw(): к моменту rAF массив эмулятора уже
     * перепатчен следующими кадрами (см. п.2 в шапке). Берём ровно width*height*3
     * байт — хвост длинного кадра всё равно не рисуется.
     */
    function pushFrame(rgb) {
        // Пока контекста нет, кадры копить бессмысленно: рисовать их нечем, а
        // ошибками они не являются — отказ уже поднят по самому событию потери.
        if (disposed || contextLost) return;
        const need = width * height * 3;
        // Размер ещё не известен или кадр короче него — пропускаем молча: до первого
        // onFrameSize это норма, а не ошибка (иначе завалим консоль на ресайзе).
        if (!need || rgb.length < need) return;
        try {
            if (!recvBuf || recvBuf.length < need) {
                // Перевыделяем только при росте: смена видеорежима — событие редкое,
                // а лишние килобайты от прошлого режима дешевле аллокации на кадр.
                recvBuf = new Uint8Array(need);
            }
            recvBuf.set(rgb.length === need ? rgb : rgb.subarray(0, need));
            pendingLen = need;
        } catch (err) {
            // Кадр, который не удалось даже принять, рисовать нечем — rAF не планируем,
            // иначе холостая отрисовка сбросила бы счётчик и экран отказа не пришёл бы
            // никогда.
            noteError(err);
            return;
        }
        if (rafId) return;
        // rAF планируется ВНЕ try/catch вокруг draw(): исключение внутри отрисовки
        // не должно молча убивать цикл (урок STGames).
        rafId = requestAnimationFrame(() => {
            try {
                // Сбрасываем ТОЛЬКО по нарисованному кадру. Холостой выход из draw()
                // (кадр короче ожидаемого — так бывает между pushFrame и rAF, если
                // между ними пришёл onFrameSize покрупнее) рендер живым не
                // доказывает, а защёлку снимал бы. Ровно от этого бережётся
                // комментарий в pushFrame выше — здесь та же защита.
                if (draw()) {
                    errorsInRow = 0;
                    failureReported = false;
                }
            } catch (err) {
                noteError(err);
            }
        });
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        canvas.removeEventListener('webglcontextlost', onContextLost, false);
        canvas.removeEventListener('webglcontextrestored', onContextRestored, false);
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        pendingLen = 0;
        recvBuf = null;
        try {
            gl.deleteTexture(texture);
            gl.deleteBuffer(buffer);
            gl.deleteProgram(program);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch (err) {
            logWarn('ошибка освобождения WebGL-ресурсов', err);
        }
    }

    /**
     * Снимает защёлку отказа и счётчик ошибок. Зовётся, когда игрок нажал
     * «Продолжить»: без этого экран отказа больше не показался бы никогда — защёлка
     * снимается только успешным кадром, а его на сломанном рендере не будет.
     * Повторный экран при этом не спамит: чтобы он появился снова, нужно заново
     * набрать errorLimit ошибок подряд.
     */
    function resetErrors() {
        errorsInRow = 0;
        failureReported = false;
    }

    /**
     * Попытка вернуть потерянный контекст. Нужна кнопке «Продолжить» на экране
     * отказа: контекст, потерянный ВРУЧНУЮ (`WEBGL_lose_context.loseContext()` —
     * тот самый способ, которым эта дорожка проверяется в чеклисте), сам не
     * восстанавливается никогда, его обязан вернуть `restoreContext()`. Настоящую
     * потерю драйвера браузер восстанавливает сам, и тогда вызов просто ничего не
     * меняет.
     *
     * @returns {boolean} было ли что восстанавливать
     */
    function recoverContext() {
        if (!contextLost) return false;
        try {
            gl.getExtension('WEBGL_lose_context')?.restoreContext();
        } catch (err) {
            logWarn('restoreContext() не удался', err);
        }
        return true;
    }

    return {
        pushFrame,
        resize,
        layout,
        dispose,
        resetErrors,
        recoverContext,
        get contextLost() { return contextLost; },
        get size() { return { width, height }; },
        get framesDrawn() { return framesDrawn; },
        get errorsInRow() { return errorsInRow; },
        get errorLimit() { return errorLimit; },
    };
}
