// Опрос Gamepad API (план §7). Вся математика живёт в `gamepad-math.js` и покрыта
// тестами под node; здесь — только «опросил → посчитал → отправил».
//
// Решения, которые выглядят как недоделки, но являются решениями:
//
// 1. В виртуальный джойстик DOSBox мы не пробрасываем ничего. Ввод с джойстика в DOOM
//    цифровой (движок смотрит только на знак `joyxmove`), у DOS game port четыре кнопки
//    и нет выбора оружия. Поэтому геймпад разбирается сами и синтезируется в мышь и
//    клавиатуру.
// 2. Ось Y правого стика выбрасывается целиком — второй аргумент
//    `sendMouseRelativeMotion` ВСЕГДА 0 (§4.8, тот же браузерный `novert`, что и у мыши).
// 3. Клавиши отдаются строками `e.code` и проходят через тот же `codeToGlfw`, что и
//    настоящая клавиатура: раскладка не двоится.
// 4. Пока геймпада нет (или сессия неактивна), цикл rAF не крутится вообще — каждый
//    кадр опроса стоит денег даже в простое. Перезапуск цикла вешается на события,
//    после которых геймпад мог появиться: `gamepadconnected`, фокус окна, возврат
//    вкладки.
//
// Залипшая клавиша здесь опаснее, чем на клавиатуре: у геймпада нет «keyup при потере
// фокуса», отпускать всё приходится руками при любом обрыве — detach, blur, скрытая
// вкладка, отключение устройства.

import { logInfo, logWarn } from '../log.js';
import {
    DEFAULT_SENSITIVITY,
    createDeltaIntegrator,
    createStickKeys,
    rightStickToMouseDelta,
} from './gamepad-math.js';

/**
 * Кламп времени кадра. Вкладка в фоне, точка останова в отладчике или просто просадка
 * дают dt в секунды: без клампа накопленная дельта развернула бы игрока волчком в тот
 * момент, когда игрок к экрану даже не притрагивался.
 */
export const MAX_DT = 0.1;

/** Индексы осей стандартной раскладки Gamepad API («standard mapping»). */
export const AXES = Object.freeze({
    leftX: 0, leftY: 1,
    rightX: 2, rightY: 3,
});

/**
 * Кнопки → строки `e.code` (дальше их переводит `codeToGlfw`).
 *
 * Индексы — «standard mapping» Gamepad API, названия кнопок — по Xbox-раскладке.
 * Раскладка вынесена в экспортируемую таблицу, чтобы её можно было проверять тестом
 * под node, не поднимая ни DOM, ни настоящий геймпад.
 *
 * Почему оружие разложено именно так: в ванильном DOOM нет клавиш «следующее/предыдущее
 * оружие» — только семь прямых `1`…`7`. Значит, семь физических кнопок надо найти, и
 * ходовые стволы (дробовик и чейнган) уезжают на горизонталь крестовины, где до них
 * дотягиваются не глядя.
 *
 * Бег на кнопку не вешается сознательно: в `DEFAULT.CFG` стоит `joyb_speed 29` — вечный
 * бег (§5.2), кнопка-модификатор не нужна.
 */
export const BUTTON_KEYS = Object.freeze({
    0: 'Space',        // A — use / открыть дверь
    1: 'ControlLeft',  // B — огонь (дубль под большой палец)
    2: 'Tab',          // X — карта
    3: 'Escape',       // Y — меню
    4: 'Digit5',       // LB — ракетница
    5: 'Digit6',       // RB — плазма
    6: 'Digit7',       // LT — BFG
    7: 'ControlLeft',  // RT — основной огонь
    8: 'Escape',       // Back / Select — меню
    9: 'Escape',       // Start — меню
    12: 'Digit2',      // крестовина ↑ — пистолет
    13: 'Digit1',      // крестовина ↓ — кулак / бензопила
    14: 'Digit3',      // крестовина ← — дробовик
    15: 'Digit4',      // крестовина → — чейнган
});

/** Порог для аналоговых курков: `pressed` у них есть не во всех браузерах. */
const TRIGGER_THRESHOLD = 0.5;

/**
 * @param {object} params
 * @param {object} params.ci CommandInterface
 * @param {object} params.keys владелец на общей шине клавиш (`input/key-bus.js`)
 * @param {() => boolean} [params.isActive] «сессия жива» — при ложном цикл встаёт
 * @param {() => number} [params.getSensitivity] множитель чувствительности поворота
 */
export function createGamepad({ ci, keys, isActive, getSensitivity }) {
    let attached = false;
    let rafId = 0;
    // null означает «предыдущего кадра не было»: нулём это выразить нельзя — метка
    // времени rAF вполне может оказаться нулевой, и dt тогда навсегда остался бы нулём.
    let lastTime = null;
    let padIndex = null;

    const integrator = createDeltaIntegrator({ sensitivity: DEFAULT_SENSITIVITY });
    const stickKeys = createStickKeys();

    /** @type {Set<number>} индексы кнопок, которые сейчас считаются нажатыми */
    const downButtons = new Set();

    function active() {
        return isActive ? Boolean(isActive()) : true;
    }

    // Счёт источников на клавишу ведёт общая шина (`input/key-bus.js`, правило 22),
    // а не геймпад в одиночку: Ctrl держат и B, и правый курок, и кнопка «ОГОНЬ» на
    // тач-раскладке, и физический Ctrl — отпускать его можно только последнему.
    // Токен обязан быть разным у разных держателей: у кнопок это их индекс (B и RT
    // шлют один и тот же Ctrl), у направлений стика хватает одного токена — коды
    // WASD у них и так не пересекаются.
    /** @param {string} code строка вида `e.code` */
    function pressCode(code, token) {
        keys.pressCode(code, token);
    }

    function releaseCode(code, token) {
        keys.releaseCode(code, token);
    }

    /**
     * Отпускает вообще всё и обнуляет накопители. Вызывается при любом обрыве: без
     * этого персонаж останется бежать в стену, а накопленный остаток дельты «выстрелит»
     * поворотом при следующем подключении.
     */
    function releaseAll() {
        keys.releaseAll();
        downButtons.clear();
        stickKeys.releaseAll();
        integrator.reset();
        lastTime = null;
    }

    function currentPad() {
        let pads;
        try {
            pads = navigator.getGamepads?.() ?? [];
        } catch (err) {
            // Gamepad API закрыт политикой разрешений — это не повод ронять сессию.
            logWarn('navigator.getGamepads недоступен', err);
            return null;
        }
        for (const pad of pads) {
            if (pad && pad.connected !== false) return pad;
        }
        return null;
    }

    function axis(pad, index) {
        const value = pad.axes?.[index];
        return Number.isFinite(value) ? value : 0;
    }

    function buttonDown(pad, index) {
        const button = pad.buttons?.[index];
        if (!button) return false;
        if (typeof button === 'number') return button > TRIGGER_THRESHOLD;
        return Boolean(button.pressed) || Number(button.value) > TRIGGER_THRESHOLD;
    }

    function applyRightStick(pad, dt) {
        const sensitivity = Number(getSensitivity?.()) || 1;
        // Множитель игрока прикручивается к оси, а не к чувствительности интегратора:
        // так остаётся один накопитель дроби на всю сессию и он переживает смену
        // настройки без рывка. Обёртка нужна, чтобы дельта всё равно шла через
        // rightStickToMouseDelta — единственное место, где гарантирован y === 0.
        const scaled = { step: (a, d) => integrator.step(a * sensitivity, d) };
        const delta = rightStickToMouseDelta(scaled, axis(pad, AXES.rightX), axis(pad, AXES.rightY), dt);
        if (delta.x === 0) return;
        try {
            ci.sendMouseRelativeMotion(delta.x, delta.y);
        } catch (err) {
            logWarn('sendMouseRelativeMotion от геймпада не удался', err);
        }
    }

    function applyLeftStick(pad) {
        const { pressed, released } = stickKeys.update(axis(pad, AXES.leftX), axis(pad, AXES.leftY));
        // Сначала отпускания: иначе на резком развороте стика вперёд-назад в игру
        // уходит кадр, где зажаты обе противоположные клавиши.
        for (const code of released) releaseCode(code, 'stick');
        for (const code of pressed) pressCode(code, 'stick');
    }

    function applyButtons(pad) {
        for (const key of Object.keys(BUTTON_KEYS)) {
            const index = Number(key);
            const code = BUTTON_KEYS[key];
            const down = buttonDown(pad, index);
            const was = downButtons.has(index);
            if (down === was) continue;
            if (down) {
                downButtons.add(index);
                pressCode(code, `b${index}`);
            } else {
                downButtons.delete(index);
                releaseCode(code, `b${index}`);
            }
        }
    }

    function frame(now) {
        rafId = 0;
        if (!attached) return;

        if (!active()) {
            // Сессия на паузе или уже мертва: гасим нажатое и останавливаем цикл.
            // Он поднимется обратно по фокусу/подключению — см. шапку файла.
            releaseAll();
            return;
        }

        const pad = currentPad();
        if (!pad) {
            releaseAll();
            padIndex = null;
            return;
        }

        if (pad.index !== padIndex) {
            // Сменилось устройство: состояние старого к новому не относится.
            releaseAll();
            padIndex = pad.index;
        }

        const time = Number.isFinite(now) ? now : 0;
        // Первый кадр даёт dt = 0: интегратор его игнорирует, и стик, уже отклонённый
        // к моменту подключения, не выдаёт скачок на всю паузу.
        const dt = lastTime === null ? 0 : Math.min((time - lastTime) / 1000, MAX_DT);
        lastTime = time;

        applyRightStick(pad, dt);
        applyLeftStick(pad);
        applyButtons(pad);

        schedule();
    }

    /** Ставит следующий кадр опроса, если он вообще нужен. */
    function schedule() {
        if (!attached || rafId) return;
        if (!active()) return;
        if (!currentPad()) return;
        rafId = requestAnimationFrame(frame);
    }

    function stopLoop() {
        if (!rafId) return;
        cancelAnimationFrame(rafId);
        rafId = 0;
    }

    function onConnected(event) {
        logInfo('геймпад подключён', event?.gamepad?.id ?? '');
        lastTime = null;
        schedule();
    }

    function onDisconnected(event) {
        logInfo('геймпад отключён', event?.gamepad?.id ?? '');
        // Нажатое этим устройством обязано быть отпущено: опрос его больше не увидит,
        // а в эмуляторе оно останется зажатым.
        releaseAll();
        padIndex = null;
        // Цикл гасим, только если опрашивать больше НЕКОГО. Безусловный stop здесь
        // был бы неверен: геймпадов могло быть два, и отключение одного глушило бы
        // опрос второго — тот ожил бы лишь к ближайшему focus'у или подключению.
        if (currentPad()) schedule();
        else stopLoop();
    }

    // Уход фокуса и сворачивание вкладки: rAF в фоне всё равно не тикает, но клавиши
    // при этом обязаны быть отпущены — иначе игрок вернётся к бегущему в стену бойцу.
    function onBlur() {
        stopLoop();
        releaseAll();
    }

    function onFocus() {
        schedule();
    }

    function onVisibility() {
        if (document.hidden) {
            stopLoop();
            releaseAll();
        } else {
            schedule();
        }
    }

    function attach() {
        if (attached) return;
        attached = true;
        window.addEventListener('gamepadconnected', onConnected);
        window.addEventListener('gamepaddisconnected', onDisconnected);
        window.addEventListener('blur', onBlur);
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibility);
        schedule();
    }

    function detach() {
        if (!attached) return;
        attached = false;
        stopLoop();
        window.removeEventListener('gamepadconnected', onConnected);
        window.removeEventListener('gamepaddisconnected', onDisconnected);
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisibility);
        releaseAll();
        padIndex = null;
    }

    return {
        attach,
        detach,
        releaseAll,
        get attached() { return attached; },
        get polling() { return rafId !== 0; },
        get heldCount() { return keys.heldCount; },
    };
}
