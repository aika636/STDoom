// Тесты чистой математики тач-раскладки. Ни DOM, ни jsdom здесь нет.
// Запуск: node tests/input/touch-layout.test.mjs
//
// Тесты стерегут не пиксели, а инварианты раскладки: огонь дублирован и никогда не
// лежит на look-поверхности, хит-зона больше рисунка, поворот на стик не повешен,
// привязка идёт к углам и safe-area.

import {
    DEFAULT_LOOK_RATIO, GEOM, WEAPON_CODES,
    computeTouchLayout, createStickTracker, createTurnTracker,
    hitTest, normalizeInsets,
} from '../../src/input/touch-layout.js';
import { assert, assertEqual, report, test } from '../_harness.mjs';

console.log('input touch-layout');

/** Планшет в альбомной ориентации — основной сценарий (приоритет платформ). */
const TABLET = { width: 1024, height: 768 };

function layoutOf(extra = {}) {
    return computeTouchLayout({ ...TABLET, ...extra });
}

function near(actual, expected, eps, message) {
    assert(Math.abs(actual - expected) <= eps,
        `${message}: получено ${actual}, ожидалось ~${expected}`);
}

// --- Раскладка ----------------------------------------------------------------

test('огонь — в правом нижнем углу, стик — в левом нижнем', () => {
    const l = layoutOf();
    const { fire, stick } = l.controls;

    assert(fire.visual.x > l.width * 0.6, 'огонь справа');
    assert(fire.visual.y > l.height * 0.6, 'огонь внизу');
    assert(stick.home.x < l.width * 0.4, 'база стика слева');
    assert(stick.home.y > l.height * 0.6, 'база стика внизу');
});

test('огонь дублирован, и левая кнопка лежит НАД стиком', () => {
    const l = layoutOf();
    const { fire, fireLeft, stick } = l.controls;

    assertEqual(fire.action, 'fire', 'основная кнопка — огонь');
    assertEqual(fireLeft.action, 'fire', 'левая кнопка — тоже огонь');
    // Ревамп 2020 чинил провал официального порта именно этим: правый палец не
    // отрывается от прицеливания, стрелять помогает левый.
    assert(fireLeft.visual.y < stick.home.y - stick.home.r,
        'дублирующая кнопка выше базы стика, а не поверх неё');
    assert(fireLeft.visual.x < l.width / 2, 'она слева, под левым большим пальцем');
});

test('основная кнопка огня крупнее дублирующей — по ней промахиваются чаще', () => {
    const l = layoutOf();
    assert(l.controls.fire.visual.r > l.controls.fireLeft.visual.r, 'основной огонь больше');
    assert(l.controls.fire.visual.r > l.controls.use.visual.r, 'огонь больше Use');
});

test('хит-зона больше нарисованной графики у каждой кнопки', () => {
    const l = layoutOf();
    for (const id of ['fire', 'fireLeft', 'use']) {
        const c = l.controls[id];
        assert(c.hit.r > c.visual.r, `${id}: хит-круг больше рисунка`);
    }
    const weapon = l.controls.weapon1;
    assert(weapon.hit.w > weapon.visual.w, 'оружие: хит-прямоугольник шире рисунка');
    assert(weapon.hit.h > weapon.visual.h, 'оружие: и выше');
});

test('нарисованную кнопку не отбирает хит-зона соседа', () => {
    // Хит-зоны намеренно больше рисунка и потому перекрываются — это нормально.
    // Ненормально другое: если бы разросшийся сосед накрыл ПИКСЕЛИ кнопки, игрок
    // жал бы ровно в её центр и получал чужое действие.
    const l = layoutOf();
    for (const id of ['fire', 'fireLeft', 'use']) {
        const c = l.controls[id];
        const probes = [
            [c.visual.x, c.visual.y],
            [c.visual.x, c.visual.y - c.visual.r + 1],
            [c.visual.x, c.visual.y + c.visual.r - 1],
            [c.visual.x - c.visual.r + 1, c.visual.y],
            [c.visual.x + c.visual.r - 1, c.visual.y],
        ];
        for (const [x, y] of probes) {
            assertEqual(hitTest(l, x, y)?.id, id, `${id}: тап в (${Math.round(x)}, ${Math.round(y)})`);
        }
    }
});

test('Use стоит рядом с огнём, а не через полэкрана', () => {
    const l = layoutOf();
    const { fire, use } = l.controls;
    const distance = Math.hypot(fire.visual.x - use.visual.x, fire.visual.y - use.visual.y);
    assert(distance < fire.visual.r * 4, 'дотянуться можно тем же пальцем');
    assert(use.visual.y < fire.visual.y, 'Use выше огня — палец приходит к огню снизу');
});

test('swipe-to-turn занимает правую половину, стик — левую', () => {
    const l = layoutOf();
    const { look, stick } = l.controls;
    assertEqual(DEFAULT_LOOK_RATIO, 0.5, 'по умолчанию — половина');
    near(look.visual.x, l.width / 2, 1, 'граница посередине');
    near(stick.visual.x + stick.visual.w, look.visual.x, 1, 'зоны стыкуются без щели');
    assert(look.visual.w > 0 && stick.visual.w > 0, 'обе зоны непустые');
});

test('полоска оружия — семь кнопок 1–7 с кодами Digit', () => {
    const l = layoutOf();
    assertEqual(WEAPON_CODES.length, 7, 'в shareware больше и нет');
    for (let i = 1; i <= 7; i++) {
        const c = l.controls[`weapon${i}`];
        assertEqual(c.action, 'weapon', `weapon${i}: действие`);
        assertEqual(c.code, `Digit${i}`, `weapon${i}: код клавиши`);
        assertEqual(c.label, String(i), `weapon${i}: подпись`);
    }
    // Полоска сверху: внизу лежат пальцы, там ей не место.
    assert(l.controls.weapon1.visual.y < l.height / 3, 'полоска сверху');
});

test('скрытая полоска оружия отдаёт свою высоту зонам', () => {
    const shown = layoutOf();
    const hidden = layoutOf({ layout: { weapons: false } });

    assertEqual(hidden.weaponsVisible, false, 'полоска скрыта');
    assert(hidden.controls.look.visual.y < shown.controls.look.visual.y,
        'зона свайпа начинается выше');
    assert(hidden.order.every((c) => c.action !== 'weapon'),
        'скрытые кнопки не участвуют в хит-тесте');
});

// --- Safe-area ----------------------------------------------------------------

test('normalizeInsets: мусор и отрицательные значения превращаются в нули', () => {
    assertEqual(normalizeInsets(null).top, 0, 'нет инсетов вовсе');
    assertEqual(normalizeInsets({ top: -10 }).top, 0, 'отрицательный');
    assertEqual(normalizeInsets({ left: 'чепуха' }).left, 0, 'нечисло');
    assertEqual(normalizeInsets({ bottom: 34 }).bottom, 34, 'нормальное значение проходит');
});

test('контролы привязаны к safe-area, а не к пиксельному краю', () => {
    const insets = { top: 20, right: 44, bottom: 34, left: 44 };
    const plain = layoutOf();
    const safe = layoutOf({ insets });

    // Огонь обязан уехать внутрь ровно настолько, насколько велики инсеты.
    near(plain.controls.fire.visual.x - safe.controls.fire.visual.x, insets.right, 0.01,
        'огонь ушёл от правого выреза');
    near(safe.controls.fire.visual.y - plain.controls.fire.visual.y, -insets.bottom, 0.01,
        'и от нижнего «подбородка»');
    near(safe.controls.stick.home.x - plain.controls.stick.home.x, insets.left, 0.01,
        'стик ушёл от левого выреза');
    assert(safe.controls.weapon1.visual.y > plain.controls.weapon1.visual.y,
        'полоска оружия опустилась под чёлку');
});

// --- Хит-тест -----------------------------------------------------------------

test('кнопка огня выигрывает у look-зоны, в которой лежит', () => {
    const l = layoutOf();
    const { fire, look } = l.controls;

    // Огонь физически внутри правой половины — и это главный анти-паттерн порта
    // 2019 года: если бы тап туда уводил камеру, стрелять было бы невозможно.
    assert(fire.visual.x > look.visual.x, 'кнопка лежит внутри зоны свайпа');
    assertEqual(hitTest(l, fire.visual.x, fire.visual.y).id, 'fire', 'под пальцем — огонь');
    assertEqual(hitTest(l, look.visual.x + look.visual.w / 2, look.visual.y + 10).id, 'look',
        'а середина зоны — по-прежнему поворот');
});

test('хит-тест ловит палец за пределами рисунка, но внутри хит-зоны', () => {
    const l = layoutOf();
    const { fire } = l.controls;
    const between = (fire.visual.r + fire.hit.r) / 2;
    assertEqual(hitTest(l, fire.visual.x - between, fire.visual.y).id, 'fire',
        'промах по рисунку всё равно попадает по кнопке');
});

test('хит-тест: левая половина — стик, кнопки оружия — оружие', () => {
    const l = layoutOf();
    assertEqual(hitTest(l, 60, l.height - 200).id, 'stick', 'низ слева — стик');
    const w3 = l.controls.weapon3;
    assertEqual(hitTest(l, w3.visual.x + w3.visual.w / 2, w3.visual.y + w3.visual.h / 2).id,
        'weapon3', 'тап по третьей кнопке');
});

test('хит-тест на мусоре и вне сцены возвращает null, а не падает', () => {
    const l = layoutOf();
    assertEqual(hitTest(l, NaN, 10), null, 'NaN');
    assertEqual(hitTest(l, -100, -100), null, 'выше и левее сцены');
    assertEqual(hitTest(null, 10, 10), null, 'раскладки нет вовсе');
});

// --- Оверрайды из настроек ----------------------------------------------------

test('touchLayout: общий масштаб увеличивает кнопки, не ломая привязку к углу', () => {
    const plain = layoutOf();
    const big = layoutOf({ layout: { scale: 1.5 } });

    assert(big.controls.fire.visual.r > plain.controls.fire.visual.r, 'кнопка крупнее');
    // Привязка к углу сохраняется: правый край кнопки остаётся на отступе от края.
    const plainGap = plain.width - (plain.controls.fire.visual.x + plain.controls.fire.visual.r);
    const bigGap = big.width - (big.controls.fire.visual.x + big.controls.fire.visual.r);
    assert(bigGap > plainGap, 'отступ масштабируется вместе с кнопкой, кнопка не вылезла');
    assert(bigGap > 0, 'кнопка внутри сцены');
});

test('touchLayout: сдвиг и масштаб отдельного контрола — задел под редактор раскладки', () => {
    const plain = layoutOf();
    const moved = layoutOf({ layout: { controls: { fire: { dx: -0.1, dy: -0.05, scale: 1.2 } } } });

    const unit = plain.unit;
    near(moved.controls.fire.visual.x - plain.controls.fire.visual.x,
        -0.1 * unit - (moved.controls.fire.visual.r - plain.controls.fire.visual.r), 0.01,
        'сдвиг по X в долях unit (с поправкой на выросший радиус)');
    assert(moved.controls.fire.visual.r > plain.controls.fire.visual.r, 'масштаб применён');
    assertEqual(moved.controls.use.visual.r, plain.controls.use.visual.r,
        'соседние контролы не тронуты');
});

test('touchLayout: битые значения не схлопывают контрол в точку', () => {
    const broken = layoutOf({ layout: { scale: 0, controls: { fire: { scale: -5, dx: 'чепуха' } } } });
    assert(broken.controls.fire.visual.r > 0, 'кнопка осталась осязаемой');
    assert(Number.isFinite(broken.controls.fire.visual.x), 'координата — число');
});

test('touchLayout: lookRatio сужает зону свайпа до правой трети (планшет)', () => {
    const l = layoutOf({ layout: { lookRatio: 1 / 3 } });
    near(l.controls.look.visual.w / l.width, 1 / 3, 0.01, 'треть ширины');
    assert(l.controls.stick.visual.w > l.controls.look.visual.w, 'зона стика стала шире');
});

// --- Плавающий стик -----------------------------------------------------------

test('стик плавающий — база встаёт туда, куда лёг палец', () => {
    const stick = createStickTracker({ unit: 1000 });
    assertEqual(stick.origin, null, 'до касания базы нет');
    stick.begin(300, 600);
    assertEqual(stick.origin.x, 300, 'база под пальцем по X');
    assertEqual(stick.origin.y, 600, 'и по Y');
    stick.end();
    assertEqual(stick.origin, null, 'палец убрали — базы снова нет');
});

test('стик даёт движение и СТРЕЙФ, но не поворот', () => {
    const stick = createStickTracker({ unit: 1000 });
    stick.begin(300, 600);

    const up = stick.move(300, 500);
    assert(up.keys.includes('KeyW'), 'вперёд');
    const right = stick.move(430, 600);
    assert(right.keys.includes('KeyD'), 'стрейф вправо');
    const left = stick.move(170, 600);
    assert(left.keys.includes('KeyA'), 'стрейф влево');
    const down = stick.move(300, 730);
    assert(down.keys.includes('KeyS'), 'назад');

    // Поворот на стик не вешаем: он цифровой и ощущается плохо.
    for (const result of [up, right, left, down]) {
        assert(!result.keys.some((k) => k.startsWith('Arrow')),
            `стрелок поворота среди ${result.keys.join(',')} быть не должно`);
    }
    stick.end();
});

test('стик: мёртвая зона гасит дрожь пальца', () => {
    const stick = createStickTracker({ unit: 1000 });
    stick.begin(300, 600);
    const tiny = stick.move(305, 604);
    assertEqual(tiny.keys.length, 0, 'микросдвиг ничего не нажимает');
    stick.end();
});

test('стик: гистерезис — на границе клавиша не дребезжит', () => {
    const stick = createStickTracker({ unit: 1000 });
    stick.begin(300, 600);
    assert(stick.move(300, 500).keys.includes('KeyW'), 'нажали');
    // Возврат в «зону молчания» между порогами включения и выключения.
    assert(stick.move(300, 536).keys.includes('KeyW'), 'на полпути назад клавиша держится');
    assert(!stick.move(300, 555).keys.includes('KeyW'), 'ниже порога выключения — отпущена');
    stick.end();
});

test('стик: end() возвращает всё, что надо отпустить', () => {
    const stick = createStickTracker({ unit: 1000 });
    stick.begin(300, 600);
    stick.move(430, 500);
    const released = stick.end();
    assert(released.includes('KeyW') && released.includes('KeyD'),
        `отпускаются обе клавиши, получено ${released.join(',')}`);
    assertEqual(stick.list().length, 0, 'внутри ничего не осталось');
});

test('стик: resize() пересчитывает ход под новый размер сцены', () => {
    const stick = createStickTracker({ unit: 1000 });
    const before = stick.radius;
    stick.resize(500);
    assert(stick.radius < before, 'на меньшей сцене ход стика короче');
    assert(stick.radius > 0, 'но не нулевой');
});

test('стик: move() без begin() ничего не нажимает', () => {
    const stick = createStickTracker({ unit: 1000 });
    const result = stick.move(999, 999);
    assertEqual(result.pressed.length, 0, 'палец не лежал — движения нет');
});

// --- Поворот свайпом ----------------------------------------------------------

test('поворот считает только X — оси Y в API нет вообще', () => {
    const turn = createTurnTracker({ sensitivity: 1 });
    assertEqual(turn.move.length, 1, 'move() принимает ровно одну координату');
    turn.begin(100);
    assertEqual(turn.move(120), 20, 'дельта по X');
});

test('поворот: дробный остаток накапливается, медленный свайп доезжает', () => {
    const turn = createTurnTracker({ sensitivity: 0.5 });
    turn.begin(0);
    assertEqual(turn.move(1), 0, 'полпикселя не отправляем');
    assertEqual(turn.move(2), 1, 'вторая половина — накопленный пиксель');
});

test('округление к нулю, а не вниз — иначе камера дрейфует влево', () => {
    const turn = createTurnTracker({ sensitivity: 0.5 });
    turn.begin(0);
    // Math.floor(-0.5) = -1: без Math.trunc любое отрицательное дрожание давало бы
    // устойчивый поворот влево.
    assertEqual(turn.move(-1), 0, 'минус полпикселя — это ноль, а не минус один');
    assertEqual(turn.move(-2), -1, 'а вот накопленный пиксель уходит');
});

test('дельта зажата до ±50 — рывок пальцем не крутит игрока волчком', () => {
    const turn = createTurnTracker({ sensitivity: 1 });
    turn.begin(0);
    assertEqual(turn.move(5000), 50, 'верхняя граница');
    turn.begin(0);
    assertEqual(turn.move(-5000), -50, 'нижняя граница');
});

test('поворот: end() сбрасывает накопленное — новый свайп начинается с нуля', () => {
    const turn = createTurnTracker({ sensitivity: 0.5 });
    turn.begin(0);
    turn.move(1);                       // накоплено 0.5
    turn.end();
    turn.begin(0);
    assertEqual(turn.move(1), 0, 'остаток не «выстрелил» в начале следующего свайпа');
});

test('поворот: мусор в координате не порождает движения', () => {
    const turn = createTurnTracker({ sensitivity: 1 });
    turn.begin(0);
    assertEqual(turn.move(NaN), 0, 'NaN');
    assertEqual(turn.move(undefined), 0, 'undefined');
});

// --- Вырожденные размеры -------------------------------------------------------

test('нулевая сцена не роняет расчёт (окно ещё не разложилось)', () => {
    const l = computeTouchLayout({ width: 0, height: 0 });
    assertEqual(l.unit, 0, 'единица масштаба нулевая');
    assert(Array.isArray(l.order) && l.order.length > 0, 'контролы всё равно перечислены');
    assertEqual(hitTest(l, 10, 10), null, 'попасть некуда');
});

test('телефон в портрете: контролы не вылезают за сцену', () => {
    const l = computeTouchLayout({ width: 390, height: 700 });
    for (const id of ['fire', 'fireLeft', 'use']) {
        const c = l.controls[id];
        assert(c.visual.x - c.visual.r >= -1, `${id}: не вылез влево`);
        assert(c.visual.x + c.visual.r <= l.width + 1, `${id}: не вылез вправо`);
        assert(c.visual.y + c.visual.r <= l.height + 1, `${id}: не вылез вниз`);
        assert(c.visual.y - c.visual.r >= -1, `${id}: не вылез вверх`);
    }
    // На телефоне unit — это ширина, и от неё же считается margin.
    assertEqual(l.unit, 390, 'единица масштаба — короткая сторона');
    assertEqual(GEOM.margin, 0.04, 'отступ задан долей, а не пикселями');
});

report('input touch-layout');
