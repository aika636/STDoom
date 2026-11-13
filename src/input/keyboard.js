// Перехват клавиатуры.
//
// ПРАВИЛО ЗДЕСЬ ОБРАТНОЕ привычному для расширений таверны. Обычно перехват делают
// выборочным: гасят только реально съеденные клавиши, остальное уходит в таверну. DOOM
// же забирает почти всю клавиатуру, поэтому:
//
//   пока игровое поле в фокусе — глушим ВСЁ;
//   ушёл фокус — перехват снимается целиком, таверна получает свои хоткеи обратно.
//
// Escape тоже уходит в игру (код 256): это клавиша меню DOOM, без неё игра
// неуправляема. Поэтому попап открывается с allowEscapeClose: false, а закрывается
// экранной кнопкой. Если кто-то однажды «починит» это обратно — сломается игра.
//
// Браузер снимет Pointer Lock по Escape, и отменить это невозможно. Здесь это даже
// удобно: игрок открывает меню и одновременно получает обратно курсор.

import { logWarn } from '../log.js';
import { codeToGlfw } from '../dos/keys.js';

/** Комбинации, которые браузер всё равно не отдаёт; отбирать их бессмысленно. */
const NEVER_SWALLOW = new Set(['F5', 'F11', 'F12']);

/**
 * @param {object} params
 * @param {HTMLElement} params.surface элемент, фокус на котором включает перехват
 * @param {object} params.keys владелец на общей шине клавиш (`input/key-bus.js`)
 * @param {() => boolean} [params.isActive] дополнительное условие (например, «игра идёт»)
 * @param {(code: string) => void} [params.onKey] наблюдатель нажатий (см. ниже)
 */
export function createKeyboard({ surface, keys, isActive, onKey }) {
    if (!surface.hasAttribute('tabindex')) surface.tabIndex = 0;

    // Клавиши уходят не прямо в ci, а через общую шину: ту же клавишу могут держать
    // геймпад и тач, и отпускать её можно только последнему держателю (правило 22,
    // `input/key-bus.js`). Физическая клавиша — один источник, поэтому токен здесь
    // не нужен: на каждый код держатель ровно один.
    /** @type {Set<number>} коды GLFW, зажатые именно клавиатурой */
    const pressed = new Set();
    let attached = false;

    function focused() {
        if (isActive && !isActive()) return false;
        const active = document.activeElement;
        return active === surface || (active !== null && surface.contains(active));
    }

    /**
     * Отпускает всё нажатое. Без этого при потере фокуса персонаж останется
     * бежать в стену — классическая болезнь браузерных эмуляторов.
     */
    function releaseAll() {
        pressed.clear();
        keys.releaseAll();
    }

    function onKeyDown(event) {
        if (!focused()) return;
        if (NEVER_SWALLOW.has(event.key)) return;

        // Глушим всё, что не отдаёт браузер сам, — включая Escape и Tab, иначе
        // фокус уедет из игры, а таверна получит хоткей в неподходящий момент.
        event.preventDefault();
        event.stopPropagation();

        // Наблюдатель нажатий: клавиатура сама ни о чём, кроме ввода, не знает, но
        // по нажатиям видно то, что больше не видно ниоткуда, — например момент
        // сохранения внутри игры (dos/autosave.js). Зовётся ДО маппинга: код
        // здесь браузерный (`event.code`), а не GLFW, и клавиши без пары в таблице GLFW
        // наблюдателю тоже интересны. Упасть он права не имеет — иначе унесёт с собой
        // нажатие игрока.
        if (onKey) {
            try { onKey(event.code); } catch (err) { logWarn('наблюдатель клавиш упал', err); }
        }

        const code = codeToGlfw(event.code);
        if (code == null) return;
        // Автоповтор браузера безопасен: CommandInterface дедуплицирует нажатия
        // внутренней keyMatrix, лишние down отсекаются там.
        pressed.add(code);
        keys.press(code);
    }

    function onKeyUp(event) {
        if (NEVER_SWALLOW.has(event.key)) return;

        const code = codeToGlfw(event.code);
        if (code == null) return;

        // Отпускание обрабатывается ДАЖЕ когда перехват уже не наш. Проверка
        // focused() здесь была бы симметрична onKeyDown и именно поэтому опасна:
        // между нажатием и отпусканием фокус успевает уйти, а isActive() —
        // погаснуть (сессия закрывается, пока клавиша зажата). Тогда down ушёл, а
        // up не ушёл бы — ровно то залипание, от которого бережётся весь модуль.
        // Отпускаем только то, что сами же и нажали: чужих клавиш это не касается.
        if (!pressed.has(code)) return;
        pressed.delete(code);
        keys.release(code);

        // Глушим событие только пока перехват действительно наш — иначе отберём у
        // таверны клавишу, которую ей уже вернули.
        if (focused()) {
            event.preventDefault();
            event.stopPropagation();
        }
    }

    // Уход фокуса, сворачивание вкладки, переключение окна — всё это одинаково
    // опасно залипшими клавишами.
    function onBlur() { releaseAll(); }
    function onVisibility() { if (document.hidden) releaseAll(); }

    function attach() {
        if (attached) return;
        attached = true;
        // Фаза перехвата (capture): нам нужно опередить обработчики таверны.
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur);
        surface.addEventListener('blur', onBlur);
        document.addEventListener('visibilitychange', onVisibility);
    }

    function detach() {
        if (!attached) return;
        attached = false;
        releaseAll();
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
        window.removeEventListener('blur', onBlur);
        surface.removeEventListener('blur', onBlur);
        document.removeEventListener('visibilitychange', onVisibility);
    }

    return {
        attach,
        detach,
        releaseAll,
        get attached() { return attached; },
        get pressedCount() { return pressed.size; },
    };
}
