// Тесты чистой математики геймпада (§7). Ни Gamepad API, ни DOM здесь нет.
// Запуск: node tests/input/gamepad-math.test.mjs

import {
    DEFAULT_HYSTERESIS, STICK_KEYS,
    createDeltaIntegrator, createStickKeys,
    deadzoneAxis, deadzoneStick, rightStickToMouseDelta,
} from '../../src/input/gamepad-math.js';
import { assert, assertEqual, report, test } from '../_harness.mjs';

console.log('input gamepad-math');

function near(actual, expected, eps, message) {
    assert(Math.abs(actual - expected) <= eps,
        `${message}: получено ${actual}, ожидалось ~${expected}`);
}

// --- Мёртвая зона -------------------------------------------------------------

test('мёртвая зона гасит дрейф в покое', () => {
    assertEqual(deadzoneAxis(0, 0.15), 0, 'ровный ноль');
    assertEqual(deadzoneAxis(0.1, 0.15), 0, 'дрожь внутри зоны');
    assertEqual(deadzoneAxis(-0.15, 0.15), 0, 'ровно на границе — ещё ноль');
    assert(deadzoneAxis(0.2, 0.15) > 0, 'за границей ось оживает');
});

test('за границей зоны значение стартует с нуля, а не прыгает', () => {
    // Без перенормировки первое же значение за порогом дало бы скачок на 0.15.
    near(deadzoneAxis(0.1501, 0.15), 0, 1e-3, 'сразу за порогом почти ноль');
    near(deadzoneAxis(1, 0.15), 1, 1e-9, 'на упоре ровно единица');
    near(deadzoneAxis(-1, 0.15), -1, 1e-9, 'на упоре в минус ровно минус единица');
    near(deadzoneAxis(0.575, 0.15), 0.5, 1e-9, 'середина остатка');
});

test('радиальный кламп: порог одинаков по осям и по диагонали', () => {
    // Покомпонентная зона дала бы «крест»: по диагонали стик оживал бы раньше.
    const d = 0.15;
    const diagInside = deadzoneStick(0.1, 0.1, d); // длина ≈0.141 < 0.15
    assertEqual(diagInside.magnitude, 0, 'диагональ внутри радиуса — молчит');

    const diagOutside = deadzoneStick(0.2, 0.2, d); // длина ≈0.283
    assert(diagOutside.magnitude > 0, 'диагональ за радиусом — оживает');

    // Направление сохраняется.
    near(diagOutside.x, diagOutside.y, 1e-12, 'диагональ осталась диагональю');
});

test('радиальный кламп не выпускает длину больше единицы', () => {
    for (const [x, y] of [[1, 1], [1, 0], [-1, -1], [0.9, 0.9], [2, 2]]) {
        const s = deadzoneStick(x, y, 0.15);
        assert(Math.hypot(s.x, s.y) <= 1 + 1e-9, `длина для (${x},${y})`);
        assert(s.magnitude <= 1 + 1e-9, `magnitude для (${x},${y})`);
    }
});

test('мусорные значения осей не ломают математику', () => {
    assertEqual(deadzoneAxis(NaN), 0, 'NaN');
    assertEqual(deadzoneAxis(undefined), 0, 'undefined');
    const s = deadzoneStick(NaN, undefined, 0.15);
    assertEqual(s.x, 0, 'x');
    assertEqual(s.y, 0, 'y');
    assertEqual(s.magnitude, 0, 'magnitude');
});

// --- Интегрирование дельт -----------------------------------------------------

test('дельта считается как stick × sens × dt', () => {
    const it = createDeltaIntegrator({ sensitivity: 100 });
    assertEqual(it.step(1, 0.1), 10, '1 × 100 × 0.1');
    assertEqual(it.step(-0.5, 0.2), -10, '-0.5 × 100 × 0.2');
});

test('дробная часть копится между кадрами и не теряется', () => {
    // 0.5 «пикселя» за кадр: без накопления это был бы вечный ноль и поворот
    // просто не начинался бы.
    const it = createDeltaIntegrator({ sensitivity: 10 });
    assertEqual(it.step(0.5, 0.1), 0, 'кадр 1: 0.5 → 0, остаток отложен');
    near(it.pending, 0.5, 1e-9, 'остаток сохранён');
    assertEqual(it.step(0.5, 0.1), 1, 'кадр 2: накопилась целая единица');
    near(it.pending, 0, 1e-9, 'остаток израсходован');

    // За 10 кадров по 0.5 должно набежать ровно 5, а не 0.
    const it2 = createDeltaIntegrator({ sensitivity: 10 });
    let total = 0;
    for (let i = 0; i < 10; i++) total += it2.step(0.5, 0.1);
    assertEqual(total, 5, 'сумма за 10 кадров');
});

test('округление к нулю: в покое камеру никуда не тянет', () => {
    // Math.floor вместо trunc дал бы -1 на любой отрицательной дробной части и
    // медленный дрейф влево.
    const it = createDeltaIntegrator({ sensitivity: 10 });
    assertEqual(it.step(-0.5, 0.1), 0, 'кадр 1 отрицательный: ноль, не -1');
    assertEqual(it.step(-0.5, 0.1), -1, 'кадр 2: целая единица влево');

    const idle = createDeltaIntegrator({ sensitivity: 900 });
    let sum = 0;
    for (let i = 0; i < 600; i++) sum += idle.step(0, 1 / 60);
    assertEqual(sum, 0, 'десять секунд покоя — ноль дельт');
});

test('дельта зажата тем же пределом, что и настоящая мышь', () => {
    const it = createDeltaIntegrator({ sensitivity: 100000 });
    assertEqual(it.step(1, 1), 50, 'верхний кламп');
    assertEqual(it.step(-1, 1), -50, 'нижний кламп');
});

test('reset выбрасывает накопленное', () => {
    const it = createDeltaIntegrator({ sensitivity: 10 });
    it.step(0.5, 0.1);
    it.reset();
    near(it.pending, 0, 1e-12, 'остаток обнулён');
    assertEqual(it.step(0.5, 0.1), 0, 'счёт начался заново');
});

test('нулевой или мусорный dt не двигает камеру', () => {
    const it = createDeltaIntegrator({ sensitivity: 100 });
    assertEqual(it.step(1, 0), 0, 'dt = 0');
    assertEqual(it.step(1, -0.5), 0, 'отрицательный dt');
    assertEqual(it.step(1, NaN), 0, 'dt = NaN');
    assertEqual(it.step(NaN, 0.1), 0, 'ось = NaN');
    near(it.pending, 0, 1e-12, 'мусор не осел в накопителе');
});

// --- Правый стик → мышь -------------------------------------------------------

test('ось Y правого стика выбрасывается', () => {
    const it = createDeltaIntegrator({ sensitivity: 100 });
    const out = rightStickToMouseDelta(it, 0, 1, 1);
    assertEqual(out.y, 0, 'вертикаль всегда 0');
    assertEqual(out.x, 0, 'горизонталь не наведена вертикалью');

    // Даже на упоре вниз/вверх вертикаль остаётся нулевой: в DOOM mousey двигает
    // вперёд/назад, и проброс Y увозил бы игрока при попытке прицелиться.
    for (const y of [-1, -0.5, 0, 0.5, 1]) {
        assertEqual(rightStickToMouseDelta(it, 0, y, 1).y, 0, `y = ${y}`);
    }
});

test('правый стик по X даёт дельту с учётом мёртвой зоны', () => {
    const it = createDeltaIntegrator({ sensitivity: 100 });
    assertEqual(rightStickToMouseDelta(it, 0.1, 0, 1, 0.15).x, 0, 'внутри зоны — ноль');
    it.reset();
    assertEqual(rightStickToMouseDelta(it, 1, 0, 0.1, 0.15).x, 10, 'на упоре — полная дельта');
    it.reset();
    assertEqual(rightStickToMouseDelta(it, -1, 0, 0.1, 0.15).x, -10, 'влево');
});

// --- Левый стик → WASD --------------------------------------------------------

test('левый стик даёт W/S/A/D по раскладке §5.2', () => {
    const keys = createStickKeys({ deadzone: 0 });
    // Ось Y направлена вниз, как в DOM: вверх — отрицательные значения.
    assertEqual(keys.update(0, -1).keys.join(), STICK_KEYS.up, 'вперёд — W');
    assertEqual(keys.update(0, 1).keys.join(), STICK_KEYS.down, 'назад — S');
    assertEqual(keys.update(-1, 0).keys.join(), STICK_KEYS.left, 'влево — A');
    assertEqual(keys.update(1, 0).keys.join(), STICK_KEYS.right, 'вправо — D');
});

test('диагональ даёт две клавиши сразу', () => {
    const keys = createStickKeys({ deadzone: 0 });
    const out = keys.update(0.9, -0.9);
    assertEqual(out.keys.length, 2, 'две клавиши');
    assert(out.keys.includes(STICK_KEYS.up), 'W');
    assert(out.keys.includes(STICK_KEYS.right), 'D');
});

test('одна ось не выдаёт противоположные клавиши одновременно', () => {
    const keys = createStickKeys({ deadzone: 0 });
    const out = keys.update(1, -1);
    assert(!(out.keys.includes(STICK_KEYS.left) && out.keys.includes(STICK_KEYS.right)),
        'A и D вместе быть не могут');
    assert(!(out.keys.includes(STICK_KEYS.up) && out.keys.includes(STICK_KEYS.down)),
        'W и S вместе быть не могут');
});

test('гистерезис: на границе нет дребезга', () => {
    const { on, off } = DEFAULT_HYSTERESIS; // 0.5 / 0.35
    const keys = createStickKeys({ deadzone: 0, on, off });

    assertEqual(keys.update(0, -0.6).pressed.join(), STICK_KEYS.up, 'нажали за порогом включения');

    // Между порогами состояние держится — именно это и убирает дребезг.
    for (const y of [-0.45, -0.4, -0.36]) {
        const out = keys.update(0, y);
        assertEqual(out.keys.join(), STICK_KEYS.up, `y=${y}: клавиша ещё держится`);
        assertEqual(out.pressed.length, 0, `y=${y}: без повторного нажатия`);
        assertEqual(out.released.length, 0, `y=${y}: без отпускания`);
    }

    assertEqual(keys.update(0, -0.3).released.join(), STICK_KEYS.up, 'ниже порога выключения — отпустили');

    // И обратно: 0.45 уже недостаточно, чтобы нажать заново.
    assertEqual(keys.update(0, -0.45).keys.length, 0, 'между порогами не нажимается заново');
    assertEqual(keys.update(0, -0.55).pressed.join(), STICK_KEYS.up, 'выше порога включения — нажали');
});

test('дрожание вокруг порога не порождает потока событий', () => {
    const keys = createStickKeys({ deadzone: 0 });
    keys.update(0, -0.6);
    let events = 0;
    // Стик лежит около 0.42 и дрожит на ±0.03 — это ровно тот случай, ради
    // которого гистерезис и заведён.
    for (let i = 0; i < 100; i++) {
        const out = keys.update(0, -(0.42 + (i % 2 ? 0.03 : -0.03)));
        events += out.pressed.length + out.released.length;
    }
    assertEqual(events, 0, 'ни одного лишнего события');
});

test('пороги нормализуются: off не может быть выше on', () => {
    const keys = createStickKeys({ deadzone: 0, on: 0.5, off: 0.9 });
    keys.update(0, -0.6);
    // Если бы off остался 0.9, клавиша отпустилась бы сразу на 0.6.
    assertEqual(keys.update(0, -0.6).keys.join(), STICK_KEYS.up, 'клавиша держится');
});

test('releaseAll отпускает всё разом', () => {
    const keys = createStickKeys({ deadzone: 0 });
    keys.update(0.9, -0.9);
    const released = keys.releaseAll();
    assertEqual(released.length, 2, 'обе клавиши');
    assertEqual(keys.list().length, 0, 'состояние пустое');
    assertEqual(keys.releaseAll().length, 0, 'повторный вызов ничего не даёт');
    // После сброса первое же обновление снова считается нажатием.
    assertEqual(keys.update(0, -1).pressed.join(), STICK_KEYS.up, 'нажатие заново');
});

test('мёртвая зона левого стика: покой не даёт клавиш', () => {
    const keys = createStickKeys({ deadzone: 0.15 });
    const out = keys.update(0.05, -0.05);
    assertEqual(out.keys.length, 0, 'дрожь в покое игнорируется');
});

report('input gamepad-math');
