// Тач-управление: привязка пальцев к CommandInterface (план §6).
//
// Вся математика — в `touch-layout.js` (там нет DOM), здесь только события и
// отправка в эмулятор. Рисование — в `shell/touch-overlay.js` (оверлей лежит поверх
// сцены и событий не ловит вообще).
//
// Решения, которые выглядят как ошибка, но ею не являются:
//
// 1. Слушаем ТОЛЬКО `pointerType === 'touch'`. Мышь живёт в mouse.js со своим
//    Pointer Lock, и дублировать её здесь означало бы два выстрела на один клик.
// 2. Слушаем на СЦЕНЕ и в ФАЗЕ ПЕРЕХВАТА, а тач-события до канваса не пускаем.
//    Иначе `mouse.js` увидит их как обычный pointerdown и запросит Pointer Lock,
//    которого на планшете не бывает, — игрок получит предупреждение в консоли
//    вместо выстрела.
// 3. Огонь считается ПО ПАЛЬЦАМ (refcount). Кнопки огня две (§6.1), и отпускание
//    одной не должно гасить очередь, пока держат вторую.
// 4. Второй аргумент `sendMouseRelativeMotion` ВСЕГДА 0 (§4.8): вертикаль мыши в
//    DOOM двигает вперёд/назад, свободного взгляда нет. Свайп по Y выбрасывается.
// 5. Кнопка Use шлёт КЛАВИШУ Space, а двойной тап по look-зоне — двойной клик
//    мышиной кнопки forward. Это не разнобой: в `DEFAULT.CFG` `key_use 57` — это
//    Space, и кнопке незачем ходить кругом; а вот жест «двойной тап» иначе не
//    выразить — двойной клик forward/strafe в ванили и есть Use (§6.3), и работает
//    он без единой правки конфига.
// 6. Сброс всего нажатого на pointercancel/blur/visibilitychange/detach обязателен.
//    Залипший палец здесь так же смертелен, как залипшая клавиша в keyboard.js:
//    системный жест (шторка, переключение приложений) отменяет касание молча, и
//    без сброса персонаж останется бежать в стену и стрелять.

import { logWarn } from '../log.js';
import {
    DEFAULT_TURN_SENSITIVITY,
    computeTouchLayout,
    createStickTracker,
    createTurnTracker,
    hitTest,
} from './touch-layout.js';

/** Кнопки DOOM: 0 — огонь, 2 — «вперёд», её двойной клик = Use (см. BUTTON_MAP в mouse.js). */
const BUTTON_FIRE = 0;
const BUTTON_FORWARD = 2;

/** Клавиша Use из §5.2 (`key_use 57` — это Space). */
const USE_CODE = 'Space';

/** Максимальная пауза между тапами, при которой это ещё двойной тап, мс. */
export const DOUBLE_TAP_MS = 300;

/** Насколько палец может съехать, чтобы тап всё ещё считался тапом, а не свайпом. */
export const TAP_SLOP = 24;

/**
 * Шаг синтетического двойного клика forward, мс. Мгновенная серия down/up/down/up
 * бесполезна: DOOM ловит двойной клик по СМЕНЕ состояния между тиками (35 тиков/с),
 * а не по факту вызова, — четыре события в одном кадре он увидит как одно.
 */
export const DOUBLE_CLICK_STEP = 45;

/**
 * @param {object} params
 * @param {object} params.ci CommandInterface
 * @param {object} params.keys владелец на общей шине клавиш (`input/key-bus.js`)
 * @param {HTMLElement} params.surface сцена (.stdoom-stage), поверх которой лежит оверлей
 * @param {object} [params.overlay] результат createTouchOverlay(); без него ввод работает вслепую
 * @param {() => object} [params.getLayout] оверрайды раскладки из настроек (touchLayout)
 * @param {() => boolean} [params.isActive] «игра идёт» — то же условие, что у keyboard.js
 * @param {number} [params.turnSensitivity] чувствительность свайпа-поворота
 */
export function createTouch({
    ci,
    keys,
    surface,
    overlay = null,
    getLayout = null,
    isActive = null,
    turnSensitivity = DEFAULT_TURN_SENSITIVITY,
}) {
    let attached = false;
    let layout = null;
    let turn = createTurnTracker({ sensitivity: turnSensitivity });
    const stick = createStickTracker();

    /** Активные пальцы: pointerId → что он держит. */
    const pointers = new Map();
    /** Пальцы, держащие огонь: кнопок огня две, гасим по последнему (§6.1). */
    const firing = new Set();

    // Трекеры поворота и стика — по одному на модуль, и владеть ими может только
    // ОДИН палец. Второй палец, попавший в ту же зону, раньше молча забирал трекер
    // себе: он переставлял `last` на свою координату, и следующее движение первого
    // давало дельту в сотни пикселей — камеру рвало на полный кламп. У стика было
    // хуже: `begin()` второго пальца отпускал WASD и переносил origin, а его
    // `pointerup` звал `end()` — первый палец оставался лежать на экране, но его
    // движения уже не давали ничего вовсе, пока его не поднимут и не поставят
    // заново. Зоны эти большие (половина сцены каждая, §6.2), так что второй палец
    // там — не экзотика, а ладонь и обычный тап по Use-жесту.
    //
    // Поэтому владение явное: трекер ведёт первый палец, остальные копятся молча, а
    // когда владелец уходит — владение ПЕРЕДАЁТСЯ оставшемуся, с его последней
    // известной точки. Без передачи игрок, переставивший пальцы местами, потерял бы
    // управление до следующего касания.
    /** @type {number|null} */
    let turnOwner = null;
    /** @type {number|null} */
    let stickOwner = null;
    /** Таймеры синтетического двойного клика — их обязательно гасить в detach. */
    const timers = new Set();
    /** Последний тап по look-зоне: время и точка. */
    let lastTap = null;

    // --- Отправка в эмулятор ---------------------------------------------------

    // Клавиши уходят через общую шину (`input/key-bus.js`, правило 22): те же Ctrl,
    // Space и Escape держат геймпад и клавиатура, и отпускать их можно только
    // последнему держателю. Токен здесь — палец: два пальца на одной кнопке Use или
    // на одной цифре оружия иначе считались бы одним источником, и отпускание
    // первого гасило бы клавишу под вторым.
    function pressCode(code, token) {
        keys.pressCode(code, token);
    }

    function releaseCode(code, token) {
        keys.releaseCode(code, token);
    }

    function sendButton(button, down) {
        try { ci.sendMouseButton(button, down); } catch (err) { logWarn('sendMouseButton (тач)', err); }
    }

    function sendTurn(delta) {
        if (!delta) return;
        // Второй аргумент — всегда 0. Это браузерный novert (§4.8), а не заглушка.
        try { ci.sendMouseRelativeMotion(delta, 0); } catch (err) { logWarn('sendMouseRelativeMotion (тач)', err); }
    }

    // --- Раскладка -------------------------------------------------------------

    /** Пересчёт под текущий размер сцены. Зовётся при attach и на resize окна. */
    function relayout() {
        const rect = surface.getBoundingClientRect?.() ?? { width: 0, height: 0 };
        layout = computeTouchLayout({
            width: rect.width,
            height: rect.height,
            insets: overlay?.insets?.() ?? null,
            layout: getLayout?.() ?? null,
        });
        stick.resize(layout.unit);
        overlay?.render(layout);
        return layout;
    }

    /** Координаты пальца в системе сцены: раскладка считалась в ней же. */
    function point(event) {
        const rect = surface.getBoundingClientRect?.() ?? { left: 0, top: 0 };
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    // --- Жесты ------------------------------------------------------------------

    /** Источник на шине клавиш — конкретный палец. */
    const token = (pointerId) => `p${pointerId}`;

    function beginFire(id, control) {
        firing.add(id);
        if (firing.size === 1) sendButton(BUTTON_FIRE, true);
        overlay?.setPressed(control.id, true);
    }

    function endFire(id, control) {
        firing.delete(id);
        if (firing.size === 0) sendButton(BUTTON_FIRE, false);
        overlay?.setPressed(control.id, false);
    }

    /**
     * Синтетический двойной клик кнопки forward = Use (§6.3). Оба клика шлём здесь,
     * на ВТОРОМ тапе: одиночный тап по look-зоне не должен дёргать игрока вперёд.
     */
    function sendUseDoubleClick() {
        const steps = [
            [0, true], [1, false], [2, true], [3, false],
        ];
        for (const [index, down] of steps) {
            const timer = setTimeout(() => {
                timers.delete(timer);
                sendButton(BUTTON_FORWARD, down);
            }, index * DOUBLE_CLICK_STEP);
            timers.add(timer);
        }
    }

    function finishLookTap(record, p) {
        const moved = Math.hypot(p.x - record.startX, p.y - record.startY);
        if (moved > TAP_SLOP) { lastTap = null; return; }
        const now = Date.now();
        if (lastTap
            && now - lastTap.at <= DOUBLE_TAP_MS
            && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) <= TAP_SLOP * 2) {
            lastTap = null;
            sendUseDoubleClick();
            return;
        }
        lastTap = { at: now, x: p.x, y: p.y };
    }

    // Направления стика — один источник на всех: коды WASD между собой не
    // пересекаются, а держит их всегда один палец-владелец.
    function applyStick(result) {
        for (const code of result.released) releaseCode(code, 'stick');
        for (const code of result.pressed) pressCode(code, 'stick');
    }

    // --- События ----------------------------------------------------------------

    function onPointerDown(event) {
        if (event.pointerType !== 'touch') return;
        // Тач до канваса не доходит: там его ждёт mouse.js со своим Pointer Lock.
        event.stopPropagation();
        if (isActive && !isActive()) return;
        if (!layout) relayout();

        const p = point(event);
        const control = hitTest(layout, p.x, p.y);
        if (!control) return;
        // Гасим скролл, зум и синтетическую мышь браузера. Без этого свайп-поворот
        // уводил бы страницу таверны, а не камеру.
        if (event.cancelable) event.preventDefault();

        const record = { control, startX: p.x, startY: p.y };
        pointers.set(event.pointerId, record);

        switch (control.action) {
            case 'fire':
                beginFire(event.pointerId, control);
                break;
            case 'use':
                pressCode(USE_CODE, token(event.pointerId));
                overlay?.setPressed(control.id, true);
                break;
            case 'weapon':
                pressCode(control.code, token(event.pointerId));
                overlay?.setPressed(control.id, true);
                break;
            case 'stick':
                // Владельца не перебиваем: второй палец в зоне стика лежит молча и
                // ждёт своей очереди (см. про владение выше).
                if (stickOwner === null) {
                    stickOwner = event.pointerId;
                    applyStick(stick.begin(p.x, p.y));
                    overlay?.setStickOrigin(p);
                }
                break;
            case 'look':
                if (turnOwner === null) {
                    turnOwner = event.pointerId;
                    turn.begin(p.x);
                }
                break;
            default:
                break;
        }
    }

    function onPointerMove(event) {
        if (event.pointerType !== 'touch') return;
        const record = pointers.get(event.pointerId);
        if (!record) return;
        if (event.cancelable) event.preventDefault();
        const p = point(event);

        // Последняя точка нужна не только владельцу: если владелец уйдёт, трекер
        // подхватит оставшийся палец с ЭТОЙ координаты, а не с той, где он коснулся
        // экрана минуту назад.
        record.lastX = p.x;
        record.lastY = p.y;

        if (record.control.action === 'stick') {
            if (event.pointerId === stickOwner) applyStick(stick.move(p.x, p.y));
        } else if (record.control.action === 'look') {
            // Только X. Y не участвует вообще — см. шапку файла, п.4.
            if (event.pointerId === turnOwner) sendTurn(turn.move(p.x));
        }
    }

    /** Ищет другой палец, лежащий в той же зоне, — кандидата в новые владельцы. */
    function nextOwner(action, exceptId) {
        for (const [id, record] of pointers) {
            if (id === exceptId) continue;
            if (record.control.action === action) return { id, record };
        }
        return null;
    }

    /**
     * Отпускает ОДИН палец. Общая часть для честного `pointerup` и для отмены:
     * `pointercancel` приходит по пальцам, а не на всю сцену сразу, и гасить из-за
     * одного отменённого пальца все остальные — значит терять стрельбу на ровном
     * месте (их `pointerup` потом не найдёт своей записи и не сделает ничего).
     *
     * @param {number} pointerId
     * @param {{x: number, y: number}|null} p точка отпускания; null — если её нет
     * @param {boolean} tap считать ли это тапом (двойной тап = Use, §6.3)
     */
    function releasePointer(pointerId, p, tap) {
        const record = pointers.get(pointerId);
        if (!record) return;
        pointers.delete(pointerId);
        const control = record.control;

        switch (control.action) {
            case 'fire':
                endFire(pointerId, control);
                break;
            case 'use':
                releaseCode(USE_CODE, token(pointerId));
                overlay?.setPressed(control.id, false);
                break;
            case 'weapon':
                releaseCode(control.code, token(pointerId));
                overlay?.setPressed(control.id, false);
                break;
            case 'stick': {
                if (pointerId !== stickOwner) break;
                for (const code of stick.end()) releaseCode(code, 'stick');
                stickOwner = null;
                overlay?.setStickOrigin(null);
                // Передаём стик оставшемуся пальцу: он уже лежит в зоне, и для
                // игрока это продолжение того же движения, а не новое касание.
                const heir = nextOwner('stick', pointerId);
                if (heir) {
                    const x = heir.record.lastX ?? heir.record.startX;
                    const y = heir.record.lastY ?? heir.record.startY;
                    stickOwner = heir.id;
                    applyStick(stick.begin(x, y));
                    overlay?.setStickOrigin({ x, y });
                }
                break;
            }
            case 'look': {
                if (pointerId === turnOwner) {
                    turn.end();
                    turnOwner = null;
                    const heir = nextOwner('look', pointerId);
                    if (heir) {
                        turnOwner = heir.id;
                        turn.begin(heir.record.lastX ?? heir.record.startX);
                    }
                }
                // Тапом считается любой палец, даже не владевший поворотом: жест
                // двойного тапа — про касание, а не про то, кто вёл камеру.
                // Отмену (pointercancel) за тап не считаем: системный жест — это не
                // намерение игрока открыть дверь.
                if (tap && p) finishLookTap(record, p);
                break;
            }
            default:
                break;
        }
    }

    function onPointerUp(event) {
        if (event.pointerType !== 'touch') return;
        if (!pointers.has(event.pointerId)) return;
        releasePointer(event.pointerId, point(event), true);
    }

    /**
     * Отпускает всё: кнопки, клавиши, стик, накопленную дробь поворота.
     * Единственная защита от залипания при системном жесте (§6, п.6 шапки).
     */
    function releaseAll() {
        pointers.clear();
        if (firing.size > 0) sendButton(BUTTON_FIRE, false);
        firing.clear();
        stick.end();
        stickOwner = null;
        turnOwner = null;
        // Клавиши снимает шина: она отпустит ровно то, что держал тач, и не тронет
        // того же Ctrl, зажатого сейчас на геймпаде.
        keys.releaseAll();
        // Forward-кнопку гасим безусловно: её мог оставить нажатой недоигранный
        // двойной клик, чьи таймеры мы сейчас снимаем.
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        sendButton(BUTTON_FORWARD, false);
        turn.end();
        lastTap = null;
        overlay?.clearPressed();
    }

    /**
     * Отмена жеста системой (шторка, свайп «назад»). Приходит ПО ПАЛЬЦАМ, поэтому и
     * гасим по пальцам: полный сброс из-за одного отменённого пальца отбирал бы
     * стрельбу у второго, который в этот момент честно лежит на кнопке, — и вернуть
     * её было бы нечем, его собственный `pointerup` уже не нашёл бы своей записи.
     * Сброс целиком остаётся там, где он и уместен: потеря фокуса, уход со вкладки,
     * снятие тача.
     */
    function onCancel(event) {
        if (event?.pointerType && event.pointerType !== 'touch') return;
        if (event && pointers.has(event.pointerId)) {
            releasePointer(event.pointerId, null, false);
            return;
        }
        releaseAll();
    }

    function onBlur() { releaseAll(); }
    function onVisibility() { if (document.hidden) releaseAll(); }
    function onResize() { relayout(); }

    // --- Жизненный цикл ---------------------------------------------------------

    function attach() {
        if (attached) return;
        attached = true;
        // Фаза перехвата: до канваса, где сидит мышь.
        surface.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', onPointerUp, true);
        window.addEventListener('pointercancel', onCancel, true);
        window.addEventListener('blur', onBlur);
        window.addEventListener('resize', onResize);
        document.addEventListener('visibilitychange', onVisibility);
        relayout();
        overlay?.setVisible(true);
    }

    function detach() {
        if (!attached) return;
        attached = false;
        releaseAll();
        surface.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('pointermove', onPointerMove, true);
        window.removeEventListener('pointerup', onPointerUp, true);
        window.removeEventListener('pointercancel', onCancel, true);
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('resize', onResize);
        document.removeEventListener('visibilitychange', onVisibility);
        overlay?.setVisible(false);
    }

    /** Смена чувствительности на лету: накопитель при этом честно обнуляется. */
    function setTurnSensitivity(value) {
        turn.end();
        turn = createTurnTracker({ sensitivity: value });
        // Палец мог лежать на экране в момент правки ползунка: новый накопитель про
        // него не знает, и без этого его следующее движение ушло бы в никуда, а
        // владение осталось бы за пальцем, которого трекер не видит.
        if (turnOwner !== null) {
            const record = pointers.get(turnOwner);
            if (record) turn.begin(record.lastX ?? record.startX);
            else turnOwner = null;
        }
    }

    return {
        attach,
        detach,
        relayout,
        releaseAll,
        setTurnSensitivity,
        get attached() { return attached; },
        get layout() { return layout; },
        get firingCount() { return firing.size; },
    };
}

/**
 * Есть ли на устройстве тач вообще.
 *
 * Проверяются оба признака: `maxTouchPoints` врёт на части десктопных сборок
 * Chrome (там он 256 при отсутствии сенсора), а `pointer: coarse` не отличает
 * планшет от телевизора с пультом. Совпадение обоих — достаточно надёжный
 * признак, а ручной тумблер в настройках закрывает остаток случаев.
 */
export function detectTouch() {
    try {
        const points = Number(navigator?.maxTouchPoints ?? 0) > 0;
        const coarse = typeof window.matchMedia === 'function'
            ? Boolean(window.matchMedia('(pointer: coarse)').matches)
            : false;
        return points && coarse;
    } catch {
        return false;
    }
}
