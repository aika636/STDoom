// Чистая математика тач-раскладки. Ни DOM, ни CommandInterface, ни
// глобалей — только числа, поэтому модуль гоняется под node без jsdom, а
// `src/input/touch.js` остаётся тонким слоем «палец приехал → посчитали → отправили».
//
// Раскладка собрана из чужих провалов, и каждое решение здесь оплачено
// чьим-то плохим релизом. Три из них выглядят как избыточность, но ею не являются:
//
// 1. Огонь ДУБЛИРУЕТСЯ: основная кнопка в правом нижнем углу и вторая слева НАД
//    стиком. Официальный порт Bethesda 2019 повесил поворот и стрельбу на одну и ту
//    же правую треть — стрелять во время поворота стало невозможно. Ревамп 2020
//    починил это именно левой дублирующей кнопкой: правый палец не отрывается от
//    прицеливания. Убирать «лишнюю» кнопку нельзя.
// 2. Хит-зона БОЛЬШЕ рисунка (поля `visual` и `hit` раздельны). Урок оверлеев
//    RetroArch: по кнопке огня промахиваются чаще всего, потому что палец приходит
//    к ней из вращения, а не стоит на месте.
// 3. Поворот НЕ висит на стике. Стик даёт цифровой сигнал, а поворот обязан быть
//    аналоговым, поэтому он живёт на свайпе по правой половине.
//
// Ось Y свайпа выбрасывается здесь так же, как в мыши и геймпаде: свободного взгляда
// в DOOM нет, вертикаль мыши двигает вперёд/назад. См. `createTurnTracker`.

import {
    DEFAULT_DEADZONE,
    MAX_DELTA_PER_FRAME,
    createDeltaIntegrator,
    createStickKeys,
} from './gamepad-math.js';

// --- Геометрия ----------------------------------------------------------------

// Все размеры — доли `unit = min(width, height)`, а не пиксели. Палец не
// масштабируется вместе с экраном, но и «14 мм от края» в CSS-пикселях мы посчитать
// не можем: DPI устройства нам неизвестен. Доля короткой стороны — компромисс,
// который на планшете даёт крупные кнопки, а на телефоне хотя бы не вылезает за край.
export const GEOM = Object.freeze({
    /** Отступ контролов от края безопасной области. */
    margin: 0.04,
    /** База плавающего стика: кольцо рисуется, зона захвата — вся левая половина.
        Запаса хит-зоны у него нет и быть не может: зона стика — прямоугольник во всю
        левую половину сцены, а не круг вокруг рисунка, и множитель к ней неприменим. */
    stick: Object.freeze({ radius: 0.16 }),
    /** Дублирующая кнопка огня слева, НАД стиком. */
    fireLeft: Object.freeze({ radius: 0.1, hit: 1.35 }),
    /** Основной огонь: увеличен намеренно — по нему промахиваются чаще всего. */
    fire: Object.freeze({ radius: 0.135, hit: 1.4 }),
    // Use рядом с огнём, над ним. Запас хит-зоны здесь меньше, чем у огня, и это
    // осознанно: зоны соседей всё равно перекрываются, а приоритет в `order` отдан
    // Use — значит, разросшийся Use откусывал бы верх нарисованной кнопки огня.
    // Промахнуться по огню страшнее, чем по двери.
    use: Object.freeze({ radius: 0.095, hit: 1.25 }),
    /** Полоска выбора оружия 1–7 сверху; прячется, чтобы не занимать поле. */
    weapon: Object.freeze({ size: 0.075, gap: 0.02, hitPad: 0.022 }),
});

/** Доля ширины, отданная зоне свайпа-поворота. Правая половина по умолчанию. */
export const DEFAULT_LOOK_RATIO = 0.5;

/** Радиус стика в долях unit, за который отклонение считается полным. */
export const STICK_TRAVEL = 0.13;

/** Оружие 1–7: в shareware больше и нет, восьмая кнопка была бы мёртвой. */
export const WEAPON_CODES = Object.freeze([
    'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7',
]);

/** Инсеты safe-area приходят снаружи: посчитать env() без DOM невозможно. */
export function normalizeInsets(insets) {
    const one = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return {
        top: one(insets?.top),
        right: one(insets?.right),
        bottom: one(insets?.bottom),
        left: one(insets?.left),
    };
}

function positive(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Оверрайды из настроек (`touchLayout`). Формат заложен под будущий редактор
 * раскладки — «двигать и масштабировать» именно этим и отличается Delta Touch от
 * провалившегося официального порта. Самого редактора пока нет, но структура
 * уже боевая: когда он появится, миграции настроек не потребуется.
 *
 * @typedef {{
 *   scale?: number,
 *   lookRatio?: number,
 *   weapons?: boolean,
 *   controls?: Record<string, {dx?: number, dy?: number, scale?: number}>,
 * }} TouchLayoutOverrides
 */
function controlOverride(layout, id) {
    const raw = layout?.controls?.[id];
    if (!raw || typeof raw !== 'object') return { dx: 0, dy: 0, scale: 1 };
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
        dx: num(raw.dx, 0),
        dy: num(raw.dy, 0),
        // Ноль и отрицательный масштаб схлопнули бы кнопку в точку — молча
        // потерянный контрол хуже кривого.
        scale: Math.max(0.4, Math.min(2.5, num(raw.scale, 1))),
    };
}

function circle(id, action, params) {
    const { x, y, radius, hitFactor, label, code } = params;
    return {
        id,
        action,
        shape: 'circle',
        label,
        code,
        visual: { x, y, r: radius },
        // Хит-зона больше рисунка — урок RetroArch.
        hit: { x, y, r: radius * hitFactor },
    };
}

function rect(id, action, params) {
    const { x, y, w, h, label, code, pad = 0 } = params;
    return {
        id,
        action,
        shape: 'rect',
        label,
        code,
        visual: { x, y, w, h },
        hit: { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 },
    };
}

/**
 * Считает раскладку под конкретный размер сцены.
 *
 * Контролы привязаны к УГЛАМ и safe-area, а не к пиксельным отступам от края
 *: на планшете большие пальцы лежат в дальних нижних углах, а середина
 * экрана для них недосягаема.
 *
 * @param {object} params
 * @param {number} params.width ширина сцены, CSS-пиксели
 * @param {number} params.height высота сцены
 * @param {{top?: number, right?: number, bottom?: number, left?: number}} [params.insets]
 * @param {TouchLayoutOverrides} [params.layout] оверрайды из настроек
 * @returns {{
 *   width: number, height: number, unit: number,
 *   insets: object, safe: {x: number, y: number, w: number, h: number},
 *   controls: object, order: object[], weaponsVisible: boolean,
 * }}
 */
export function computeTouchLayout({ width, height, insets = null, layout = null } = {}) {
    const W = positive(width, 0);
    const H = positive(height, 0);
    const pad = normalizeInsets(insets);

    // Безопасный прямоугольник: всё считается внутри него, поэтому вырез и
    // «подбородок» телефона в раскладку не попадают вообще.
    const safe = {
        x: pad.left,
        y: pad.top,
        w: Math.max(0, W - pad.left - pad.right),
        h: Math.max(0, H - pad.top - pad.bottom),
    };

    const unit = Math.min(W, H);
    const globalScale = Math.max(0.4, Math.min(2.5, positive(layout?.scale, 1)));
    const px = (fraction) => fraction * unit * globalScale;
    const margin = px(GEOM.margin);

    const weaponsVisible = layout?.weapons !== false;
    const lookRatio = Math.min(0.9, Math.max(0.25, positive(layout?.lookRatio, DEFAULT_LOOK_RATIO)));

    const controls = {};

    // --- Полоска оружия: сверху по центру -------------------------------------
    const weaponSize = px(GEOM.weapon.size);
    const weaponGap = px(GEOM.weapon.gap);
    const stripWidth = WEAPON_CODES.length * weaponSize + (WEAPON_CODES.length - 1) * weaponGap;
    const stripX = safe.x + (safe.w - stripWidth) / 2;
    const stripY = safe.y + margin;
    WEAPON_CODES.forEach((code, index) => {
        const over = controlOverride(layout, `weapon${index + 1}`);
        const size = weaponSize * over.scale;
        controls[`weapon${index + 1}`] = rect(`weapon${index + 1}`, 'weapon', {
            x: stripX + index * (weaponSize + weaponGap) + px(over.dx),
            y: stripY + px(over.dy),
            w: size,
            h: size,
            pad: px(GEOM.weapon.hitPad),
            label: String(index + 1),
            code,
        });
    });
    // Полоска съедает верх сцены: зоны стика и свайпа начинаются под ней, иначе
    // тап по «двойке» уводил бы камеру.
    const zoneTop = safe.y + (weaponsVisible ? margin + weaponSize + margin : 0);

    // --- Правый нижний угол: огонь, над ним Use --------------------------------
    const fireOver = controlOverride(layout, 'fire');
    const fireR = px(GEOM.fire.radius) * fireOver.scale;
    const fire = circle('fire', 'fire', {
        x: safe.x + safe.w - margin - fireR + px(fireOver.dx),
        y: safe.y + safe.h - margin - fireR + px(fireOver.dy),
        radius: fireR,
        hitFactor: GEOM.fire.hit,
        label: 'ОГОНЬ',
    });
    controls.fire = fire;

    const useOver = controlOverride(layout, 'use');
    const useR = px(GEOM.use.radius) * useOver.scale;
    controls.use = circle('use', 'use', {
        x: fire.visual.x + px(useOver.dx),
        y: fire.visual.y - fireR - margin - useR + px(useOver.dy),
        radius: useR,
        hitFactor: GEOM.use.hit,
        label: 'USE',
    });

    // --- Левый нижний угол: база стика, над ней дублирующий огонь --------------
    const stickOver = controlOverride(layout, 'stick');
    const stickR = px(GEOM.stick.radius) * stickOver.scale;
    const stickHome = {
        x: safe.x + margin + stickR + px(stickOver.dx),
        y: safe.y + safe.h - margin - stickR + px(stickOver.dy),
    };

    const fireLeftOver = controlOverride(layout, 'fireLeft');
    const fireLeftR = px(GEOM.fireLeft.radius) * fireLeftOver.scale;
    controls.fireLeft = circle('fireLeft', 'fire', {
        x: stickHome.x + px(fireLeftOver.dx),
        y: stickHome.y - stickR - margin - fireLeftR + px(fireLeftOver.dy),
        radius: fireLeftR,
        hitFactor: GEOM.fireLeft.hit,
        label: 'ОГОНЬ',
    });

    // --- Зоны ------------------------------------------------------------------
    // Граница между стиком и свайпом: слева движение, справа поворот.
    const splitX = safe.x + safe.w * (1 - lookRatio);
    const zoneHeight = Math.max(0, safe.y + safe.h - zoneTop);

    controls.stick = rect('stick', 'stick', {
        x: safe.x,
        y: zoneTop,
        w: Math.max(0, splitX - safe.x),
        h: zoneHeight,
        label: '',
    });
    // Кольцо стика рисуется в «домашней» точке, но при касании уезжает под палец:
    // стик ПЛАВАЮЩИЙ. Фиксированная точка заставляла бы игрока смотреть
    // на свои руки.
    controls.stick.home = { x: stickHome.x, y: stickHome.y, r: stickR };

    controls.look = rect('look', 'look', {
        x: splitX,
        y: zoneTop,
        w: Math.max(0, safe.x + safe.w - splitX),
        h: zoneHeight,
        label: '',
    });

    // Порядок хит-теста: кнопки раньше зон. Иначе тап по огню, лежащему внутри
    // look-зоны, уводил бы камеру вместо выстрела — ровно тот анти-паттерн, из-за
    // которого провалился порт 2019 года.
    const order = [
        ...(weaponsVisible ? WEAPON_CODES.map((_, i) => controls[`weapon${i + 1}`]) : []),
        controls.use,
        controls.fire,
        controls.fireLeft,
        controls.stick,
        controls.look,
    ];

    return { width: W, height: H, unit, insets: pad, safe, controls, order, weaponsVisible };
}

// --- Хит-тест -----------------------------------------------------------------

function inside(control, x, y) {
    const h = control.hit;
    if (control.shape === 'circle') {
        return Math.hypot(x - h.x, y - h.y) <= h.r;
    }
    return x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
}

/**
 * Какой контрол под пальцем. Возвращает сам контрол или `null`, если палец лёг
 * мимо всего (например, в полосу леттербокса выше зон).
 *
 * @param {object} layout результат computeTouchLayout()
 */
export function hitTest(layout, x, y) {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    for (const control of layout?.order ?? []) {
        if (inside(control, px, py)) return control;
    }
    return null;
}

// --- Плавающий стик -----------------------------------------------------------

/**
 * Плавающий стик: база встаёт туда, куда лёг палец, вектор считается от неё.
 *
 * Гистерезис и мёртвая зона не пишутся заново — берутся у геймпада
 * (`createStickKeys`): математика там ровно та же, а два расходящихся набора
 * порогов означали бы, что стик и геймпад ощущаются по-разному без всякой причины.
 *
 * Поворот сюда НЕ входит: стик цифровой, а поворот обязан быть аналоговым.
 * Горизонталь стика — это СТРЕЙФ (KeyA/KeyD), и подменять его поворотом нельзя.
 */
export function createStickTracker({
    travel = STICK_TRAVEL,
    deadzone = DEFAULT_DEADZONE,
    unit = 1,
} = {}) {
    const keys = createStickKeys({ deadzone });
    let origin = null;
    // Радиус полного отклонения в пикселях: доля unit, как и вся остальная геометрия.
    let radius = Math.max(1, positive(travel, STICK_TRAVEL) * positive(unit, 1));

    return {
        /** Палец лёг: здесь и появляется база стика. */
        begin(x, y) {
            origin = { x: Number(x) || 0, y: Number(y) || 0 };
            return keys.update(0, 0);
        },

        /**
         * Палец поехал.
         * @returns {{keys: string[], pressed: string[], released: string[]}}
         *   наборы `e.code` — их переводит в GLFW тот же `codeToGlfw`, что и
         *   клавиатуру, поэтому раскладка не двоится.
         */
        move(x, y) {
            if (!origin) return { keys: keys.list(), pressed: [], released: [] };
            const dx = (Number(x) || 0) - origin.x;
            const dy = (Number(y) || 0) - origin.y;
            // Нормируем к [-1, 1]: дальше всё считает геймпадная математика.
            return keys.update(
                Math.max(-1, Math.min(1, dx / radius)),
                Math.max(-1, Math.min(1, dy / radius)),
            );
        },

        /** Палец убрали или сессия кончилась. Возвращает, что надо отпустить. */
        end() {
            origin = null;
            return keys.releaseAll();
        },

        /** Пересчёт под новый размер сцены: раскладка резиновая, стик тоже. */
        resize(nextUnit) {
            radius = Math.max(1, positive(travel, STICK_TRAVEL) * positive(nextUnit, 1));
        },

        /** База стика под пальцем — оверлею, чтобы нарисовать кольцо на месте. */
        get origin() { return origin ? { ...origin } : null; },
        get radius() { return radius; },
        list() { return keys.list(); },
    };
}

// --- Аналоговый поворот свайпом ------------------------------------------------

/** Чувствительность свайпа: «пикселей мыши» на пиксель проведённого пальца. */
export const DEFAULT_TURN_SENSITIVITY = 1.6;

/**
 * Свайп по правой половине → относительные дельты мыши.
 *
 * Интегратор взят у геймпада (`createDeltaIntegrator`) и вызывается с `dt = 1`:
 * там `remainder += axis × sens × dt`, то есть при единичном dt это ровно
 * «пиксели пальца × чувствительность». Своя копия накопителя означала бы третью
 * реализацию одного и того же округления — а округлять надо `Math.trunc`, и это
 * не украшение: `Math.floor` на любой отрицательной дроби устойчиво тянет камеру
 * влево.
 *
 * Кламп — тот же MAX_DELTA_PER_FRAME (=50), что у мыши и геймпада: рывок
 * пальцем не должен закручивать игрока волчком.
 *
 * Ось Y не принимается вообще. Это не упущение: вертикаль мыши в DOOM двигает
 * вперёд/назад, и проброс Y означал бы, что игрок, ведя палец вверх, уезжает
 * вперёд.
 */
export function createTurnTracker({ sensitivity = DEFAULT_TURN_SENSITIVITY } = {}) {
    const integrator = createDeltaIntegrator({
        sensitivity: positive(sensitivity, DEFAULT_TURN_SENSITIVITY),
        maxPerFrame: MAX_DELTA_PER_FRAME,
    });
    let last = null;

    return {
        begin(x) {
            last = Number(x) || 0;
            integrator.reset();
        },

        /**
         * @param {number} x текущая координата пальца по X
         * @returns {number} целая дельта для `ci.sendMouseRelativeMotion(delta, 0)`
         */
        move(x) {
            const px = Number(x);
            if (!Number.isFinite(px)) return 0;
            if (last === null) { last = px; return 0; }
            const dx = px - last;
            last = px;
            return integrator.step(dx, 1);
        },

        end() {
            last = null;
            integrator.reset();
        },

        /** Только для тестов и отладки: накопленная дробь. */
        get pending() { return integrator.pending; },
    };
}
