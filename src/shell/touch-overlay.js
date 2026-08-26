// Видимые тач-контролы поверх сцены (план §6).
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ РИСОВАНИЕ ВНУТРИ touch.js. Ввод и картинка здесь
// живут в разных системах координат и в разных жизненных циклах: `touch.js` знает
// про CommandInterface и обязан работать даже тогда, когда рисовать нечем (тесты,
// отключённый оверлей), а этот файл не знает про эмулятор вообще и умеет только
// «положить кружки по координатам». Разделение повторяет пару
// `gamepad-math.js` / `gamepad.js` и по той же причине.
//
// ПОЧЕМУ ПОВЕРХ СЦЕНЫ (refs.stage), А НЕ ВНУТРИ КАНВАСА. Канвас растягивается
// леттербоксом: его инлайновые размеры считает renderer.layout(), и всё, что
// положено внутрь поля, поехало бы вместе с картинкой. Ровно та же причина, по
// которой в сцене живёт отладочный оверлей (см. debug-overlay.js). Побочная выгода:
// контролы могут лежать в чёрных полосах леттербокса, не перекрывая картинку.
//
// ⚠ Оверлей НЕ ловит события: у него `pointer-events: none`. Это не упущение —
// иначе он отобрал бы у канваса клики мыши и Pointer Lock (§4.8), а тач всё равно
// слушается на сцене целиком (см. touch.js). Не «чинить».

/**
 * @param {object} params
 * @param {HTMLElement} [params.box] контейнер (обычно .stdoom-stage)
 */
export function createTouchOverlay({ box = null } = {}) {
    const element = document.createElement('div');
    element.className = 'stdoom-touch';
    element.hidden = true;
    // Оверлей чисто декоративный: скринридеру в нём делать нечего, а кнопок,
    // доступных с клавиатуры, здесь нет намеренно — клавиатура и так вся у DOOM.
    element.setAttribute('aria-hidden', 'true');

    // Зонд safe-area: посчитать env() из JS нельзя, но можно спросить у браузера
    // готовые отступы через computed style реального элемента.
    const probe = document.createElement('div');
    probe.className = 'stdoom-touch-probe';
    element.appendChild(probe);

    const layer = document.createElement('div');
    layer.className = 'stdoom-touch-layer';
    element.appendChild(layer);

    /** @type {Map<string, HTMLElement>} */
    const nodes = new Map();
    let stickRing = null;
    let destroyed = false;

    function px(value) {
        return `${Math.round(value * 100) / 100}px`;
    }

    /** Отрисовывает кнопки по готовой раскладке. Зоны не рисуются — они невидимые. */
    function render(layout) {
        if (destroyed || !layout) return;
        nodes.clear();
        const created = [];

        for (const control of layout.order) {
            if (control.action === 'stick' || control.action === 'look') continue;
            const node = document.createElement('div');
            node.className = `stdoom-touch-btn stdoom-touch-${control.id.replace(/\d+$/, '')}`;
            node.dataset.control = control.id;
            node.textContent = control.label ?? '';
            const v = control.visual;
            if (control.shape === 'circle') {
                node.classList.add('stdoom-touch-round');
                node.style.left = px(v.x - v.r);
                node.style.top = px(v.y - v.r);
                node.style.width = px(v.r * 2);
                node.style.height = px(v.r * 2);
                node.style.fontSize = px(Math.max(9, v.r * 0.34));
            } else {
                node.style.left = px(v.x);
                node.style.top = px(v.y);
                node.style.width = px(v.w);
                node.style.height = px(v.h);
                node.style.fontSize = px(Math.max(9, v.h * 0.5));
            }
            nodes.set(control.id, node);
            created.push(node);
        }

        // Кольцо стика: в покое стоит в «домашней» точке, при касании уезжает под
        // палец (стик плавающий, §6.2 п.5).
        stickRing = document.createElement('div');
        stickRing.className = 'stdoom-touch-btn stdoom-touch-round stdoom-touch-stick';
        const home = layout.controls.stick?.home;
        if (home) {
            stickRing.style.left = px(home.x - home.r);
            stickRing.style.top = px(home.y - home.r);
            stickRing.style.width = px(home.r * 2);
            stickRing.style.height = px(home.r * 2);
            stickRing.dataset.homeX = String(home.x);
            stickRing.dataset.homeY = String(home.y);
            stickRing.dataset.radius = String(home.r);
        }
        created.push(stickRing);

        layer.replaceChildren(...created);
    }

    /**
     * Двигает кольцо стика под палец. `null` возвращает его домой.
     */
    function setStickOrigin(point) {
        if (!stickRing) return;
        const r = Number(stickRing.dataset.radius) || 0;
        const x = point ? Number(point.x) : Number(stickRing.dataset.homeX);
        const y = point ? Number(point.y) : Number(stickRing.dataset.homeY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        stickRing.style.left = px(x - r);
        stickRing.style.top = px(y - r);
        stickRing.classList.toggle('stdoom-touch-active', Boolean(point));
    }

    /** Подсветка нажатой кнопки: без обратной связи игрок не понимает, попал ли он. */
    function setPressed(id, on) {
        nodes.get(id)?.classList.toggle('stdoom-touch-active', Boolean(on));
    }

    /** Гасит подсветку у всех — на случай сброса всего нажатого. */
    function clearPressed() {
        for (const node of nodes.values()) node.classList.remove('stdoom-touch-active');
        stickRing?.classList.remove('stdoom-touch-active');
        setStickOrigin(null);
    }

    /**
     * Инсеты safe-area в CSS-пикселях. В jsdom и в браузерах без выреза вернёт нули —
     * это нормально, раскладка тогда просто прижмётся к краям.
     */
    function insets() {
        try {
            const style = getComputedStyle(probe);
            const one = (value) => {
                const n = Number.parseFloat(value);
                return Number.isFinite(n) && n > 0 ? n : 0;
            };
            return {
                top: one(style.paddingTop),
                right: one(style.paddingRight),
                bottom: one(style.paddingBottom),
                left: one(style.paddingLeft),
            };
        } catch {
            return { top: 0, right: 0, bottom: 0, left: 0 };
        }
    }

    function setVisible(on) {
        if (destroyed) return;
        if (on) {
            if (box && element.parentNode !== box) box.appendChild(element);
            element.hidden = false;
        } else {
            clearPressed();
            element.hidden = true;
        }
    }

    function destroy() {
        destroyed = true;
        nodes.clear();
        stickRing = null;
        element.remove();
    }

    return {
        element,
        render,
        setStickOrigin,
        setPressed,
        clearPressed,
        insets,
        setVisible,
        destroy,
        get visible() { return !element.hidden; },
        /** Только для тестов: узел конкретного контрола. */
        nodeOf(id) { return nodes.get(id) ?? null; },
    };
}
