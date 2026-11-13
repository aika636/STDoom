// Чистая математика геймпада. Здесь нет ни опроса Gamepad API, ни синтеза
// событий — только числа. Так эту логику можно гонять под node без DOM, а
// `src/input/gamepad.js` остаётся тонким слоем «опросил → посчитал → отправил».
//
// Напоминание, почему мы вообще считаем это сами: пробрасывать стик в виртуальный
// джойстик DOSBox бесполезно — ввод с джойстика в DOOM цифровой, движок смотрит
// только на знак (`if (joyxmove > 0) side += sidemove[speed]`), а амплитуду
// выбрасывает. Плавный поворот возможен только через относительные дельты мыши.

// --- Мёртвая зона -------------------------------------------------------------

export const DEFAULT_DEADZONE = 0.15;

/**
 * Мёртвая зона одной оси с перенормировкой остатка: сразу за границей значение
 * начинается с нуля, а не прыгает на `deadzone`.
 * @returns {number} в диапазоне [-1, 1]
 */
export function deadzoneAxis(value, deadzone = DEFAULT_DEADZONE) {
    const v = Number(value);
    if (!Number.isFinite(v)) return 0;
    const dz = clamp01(deadzone);
    const abs = Math.abs(v);
    if (abs <= dz) return 0;
    if (dz >= 1) return 0;
    const scaled = (abs - dz) / (1 - dz);
    return Math.sign(v) * Math.min(1, scaled);
}

/**
 * Радиальная мёртвая зона для стика целиком. Покомпонентная зона даёт «крест»:
 * по диагонали стик оживает раньше, чем по осям, и в покое дрожит. Здесь порог
 * считается по длине вектора, а остаток нормируется так, чтобы на упоре
 * получалась ровно единица.
 *
 * @returns {{x: number, y: number, magnitude: number}} длина ≤ 1
 */
export function deadzoneStick(x, y, deadzone = DEFAULT_DEADZONE) {
    const ax = Number.isFinite(Number(x)) ? Number(x) : 0;
    const ay = Number.isFinite(Number(y)) ? Number(y) : 0;
    const dz = clamp01(deadzone);
    const raw = Math.hypot(ax, ay);
    if (raw <= dz || dz >= 1) return { x: 0, y: 0, magnitude: 0 };

    // Клампим сырую длину: некоторые геймпады отдают по диагонали длину >1.
    const magnitude = Math.min(1, (Math.min(raw, 1) - dz) / (1 - dz));
    const k = magnitude / raw;
    return { x: ax * k, y: ay * k, magnitude };
}

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

// --- Интегрирование дельт правого стика ---------------------------------------

export const DEFAULT_SENSITIVITY = 900;   // «пикселей мыши» в секунду на упоре
export const MAX_DELTA_PER_FRAME = 50;    // тот же кламп, что и для настоящей мыши

/**
 * Накопитель дельт мыши по кадрам: `delta = stickX × sens × dt`.
 *
 * Дробная часть переносится в следующий кадр. Без этого медленное отклонение
 * стика теряется целиком: при 0.2 × 900 × 0.016 ≈ 2.9 округление вниз каждый
 * кадр съедало бы почти треть движения, а при совсем малом отклонении дельта
 * всегда была бы нулём и поворот просто не начинался бы.
 *
 * Ось Y правого стика сюда не попадает вообще — см. `rightStickToMouseDelta`.
 */
export function createDeltaIntegrator({
    sensitivity = DEFAULT_SENSITIVITY,
    maxPerFrame = MAX_DELTA_PER_FRAME,
} = {}) {
    let remainder = 0;

    return {
        /**
         * @param {number} axis значение оси после мёртвой зоны, [-1, 1]
         * @param {number} dt время кадра в секундах
         * @returns {number} целая дельта для `ci.sendMouseRelativeMotion()`
         */
        step(axis, dt) {
            const a = Number(axis);
            const d = Number(dt);
            if (!Number.isFinite(a) || !Number.isFinite(d) || d <= 0) return 0;

            remainder += a * sensitivity * d;

            // Округление к нулю: иначе накопитель уезжает в сторону минус
            // бесконечности и стик в покое медленно тянет камеру влево.
            const whole = Math.trunc(remainder);
            remainder -= whole;

            if (whole > maxPerFrame) return maxPerFrame;
            if (whole < -maxPerFrame) return -maxPerFrame;
            return whole;
        },

        /** Сброс накопленного (смена геймпада, потеря фокуса, пауза). */
        reset() {
            remainder = 0;
        },

        /** Только для тестов и отладки. */
        get pending() {
            return remainder;
        },
    };
}

/**
 * Правый стик → дельта мыши. Ось Y ВЫБРАСЫВАЕТСЯ: свободного взгляда
 * в DOOM нет, вертикальная ось мыши двигает вперёд/назад (`forward += mousey` в
 * `g_game.c`). Проброс Y означал бы, что игрок, пытаясь прицелиться выше, уезжает
 * вперёд. Это браузерный эквивалент DOS-утилиты `novert`.
 *
 * Параметр `y` принимается только для симметрии вызова и осознанно игнорируется:
 * пусть попытка «а давайте вернём» упирается в подпись функции, а не в тихое
 * отсутствие строки.
 *
 * @returns {{x: number, y: 0}} y всегда ровно 0
 */
export function rightStickToMouseDelta(integrator, x, y, dt, deadzone = DEFAULT_DEADZONE) {
    void y; // намеренно не используется
    const ax = deadzoneAxis(x, deadzone);
    return { x: integrator.step(ax, dt), y: 0 };
}

// --- Левый стик → клавиши WASD ------------------------------------------------

// Порог включения выше порога выключения: между ними — «зона молчания», в которой
// состояние не меняется. Без гистерезиса стик, лежащий ровно на границе, дребезжит
// и шлёт по паре keydown/keyup за кадр.
export const DEFAULT_HYSTERESIS = Object.freeze({ on: 0.5, off: 0.35 });

// Раскладка по умолчанию: W вперёд, S назад, A/D — стрейф.
export const STICK_KEYS = Object.freeze({
    up: 'KeyW',
    down: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
});

/**
 * Перевод положения левого стика в набор «нажатых» клавиш с гистерезисом.
 *
 * Ось Y геймпада направлена вниз (вверх = отрицательные значения), как и в DOM.
 *
 * `update()` возвращает не только текущий набор, но и разницу с предыдущим —
 * вызывающему остаётся разослать `pressed`/`released` в эмулятор, ничего не
 * сравнивая самому.
 */
export function createStickKeys({
    on = DEFAULT_HYSTERESIS.on,
    off = DEFAULT_HYSTERESIS.off,
    deadzone = DEFAULT_DEADZONE,
    keys = STICK_KEYS,
} = {}) {
    // Порог выключения не может быть выше порога включения — иначе гистерезис
    // вырождается в дребезг с обратным знаком.
    const onT = clamp01(on);
    const offT = Math.min(clamp01(off), onT);

    /** @type {Set<string>} */
    let active = new Set();

    // Одна ось даёт пару взаимоисключающих направлений: одновременное «вперёд и
    // назад» в DOOM гасит само себя, но лишние события в воркер всё равно ни к чему.
    function axisState(value, negKey, posKey) {
        const wasNeg = active.has(negKey);
        const wasPos = active.has(posKey);
        if (value <= -onT) return negKey;
        if (value >= onT) return posKey;
        if (wasNeg && value <= -offT) return negKey;
        if (wasPos && value >= offT) return posKey;
        return null;
    }

    return {
        /**
         * @returns {{keys: string[], pressed: string[], released: string[]}}
         */
        update(x, y) {
            const s = deadzoneStick(x, y, deadzone);
            const next = new Set();

            const horiz = axisState(s.x, keys.left, keys.right);
            if (horiz) next.add(horiz);
            const vert = axisState(s.y, keys.up, keys.down);
            if (vert) next.add(vert);

            const pressed = [...next].filter((k) => !active.has(k));
            const released = [...active].filter((k) => !next.has(k));
            active = next;
            return { keys: [...next], pressed, released };
        },

        /** Текущий набор без пересчёта. */
        list() {
            return [...active];
        },

        /**
         * Отпустить всё (потеря фокуса, отключение геймпада).
         * @returns {string[]} что надо отпустить
         */
        releaseAll() {
            const released = [...active];
            active = new Set();
            return released;
        },
    };
}
