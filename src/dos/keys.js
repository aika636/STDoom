// Таблица кодов клавиш GLFW3 и маппинг от `e.code`.
//
// Два принципиальных момента, которые легко потерять при правках:
//
// 1. Коды — GLFW3, а НЕ SDL. Пакет `emulators` ждёт именно их, но своей таблицы
//    констант не экспортирует (она живёт в плеере js-dos, который мы не берём),
//    поэтому таблица объявлена здесь целиком.
// 2. Маппим от `e.code`, а не от `e.keyCode`. Штатный `domToKeyCode` js-dos работает
//    от устаревшего `keyCode`, который зависит от раскладки: на кириллице «W» придёт
//    с другим `keyCode`, и управление сломается. `e.code` — физическая позиция
//    клавиши, от раскладки не зависит вообще.
//
// Модуль чистый: ни DOM, ни wasm, ни глобалей.

// --- Константы GLFW3 (`GLFW_KEY_*`) ------------------------------------------
// Значения по спецификации GLFW 3; подмножество из таблицы в docs/input.md совпадает.

export const GLFW = {
    SPACE: 32,
    APOSTROPHE: 39,
    COMMA: 44,
    MINUS: 45,
    PERIOD: 46,
    SLASH: 47,
    D0: 48, D1: 49, D2: 50, D3: 51, D4: 52,
    D5: 53, D6: 54, D7: 55, D8: 56, D9: 57,
    SEMICOLON: 59,
    EQUAL: 61,
    A: 65, B: 66, C: 67, D: 68, E: 69, F: 70, G: 71, H: 72, I: 73,
    J: 74, K: 75, L: 76, M: 77, N: 78, O: 79, P: 80, Q: 81, R: 82,
    S: 83, T: 84, U: 85, V: 86, W: 87, X: 88, Y: 89, Z: 90,
    LEFT_BRACKET: 91,
    BACKSLASH: 92,
    RIGHT_BRACKET: 93,
    GRAVE_ACCENT: 96,
    ESCAPE: 256,
    ENTER: 257,
    TAB: 258,
    BACKSPACE: 259,
    INSERT: 260,
    DELETE: 261,
    RIGHT: 262,
    LEFT: 263,
    DOWN: 264,
    UP: 265,
    PAGE_UP: 266,
    PAGE_DOWN: 267,
    HOME: 268,
    END: 269,
    CAPS_LOCK: 280,
    SCROLL_LOCK: 281,
    NUM_LOCK: 282,
    PRINT_SCREEN: 283,
    PAUSE: 284,
    // F1..F25 идут подряд от 290; в браузере реально доходят до F24, нам хватает F12.
    F1: 290, F2: 291, F3: 292, F4: 293, F5: 294, F6: 295,
    F7: 296, F8: 297, F9: 298, F10: 299, F11: 300, F12: 301,
    KP_0: 320, KP_1: 321, KP_2: 322, KP_3: 323, KP_4: 324,
    KP_5: 325, KP_6: 326, KP_7: 327, KP_8: 328, KP_9: 329,
    KP_DECIMAL: 330,
    KP_DIVIDE: 331,
    KP_MULTIPLY: 332,
    KP_SUBTRACT: 333,
    KP_ADD: 334,
    KP_ENTER: 335,
    KP_EQUAL: 336,
    LEFT_SHIFT: 340,
    LEFT_CONTROL: 341,
    LEFT_ALT: 342,
    LEFT_SUPER: 343,
    RIGHT_SHIFT: 344,
    RIGHT_CONTROL: 345,
    RIGHT_ALT: 346,
    RIGHT_SUPER: 347,
    MENU: 348,
};

// --- Карта `e.code` → код GLFW3 ----------------------------------------------

/** @type {Readonly<Record<string, number>>} */
export const CODE_TO_GLFW = Object.freeze({
    // Буквы. В GLFW коды букв совпадают с ASCII заглавных, но полагаться на это
    // в вызывающем коде не надо — таблица явная.
    KeyA: GLFW.A, KeyB: GLFW.B, KeyC: GLFW.C, KeyD: GLFW.D, KeyE: GLFW.E,
    KeyF: GLFW.F, KeyG: GLFW.G, KeyH: GLFW.H, KeyI: GLFW.I, KeyJ: GLFW.J,
    KeyK: GLFW.K, KeyL: GLFW.L, KeyM: GLFW.M, KeyN: GLFW.N, KeyO: GLFW.O,
    KeyP: GLFW.P, KeyQ: GLFW.Q, KeyR: GLFW.R, KeyS: GLFW.S, KeyT: GLFW.T,
    KeyU: GLFW.U, KeyV: GLFW.V, KeyW: GLFW.W, KeyX: GLFW.X, KeyY: GLFW.Y,
    KeyZ: GLFW.Z,

    // Цифровой ряд.
    Digit0: GLFW.D0, Digit1: GLFW.D1, Digit2: GLFW.D2, Digit3: GLFW.D3,
    Digit4: GLFW.D4, Digit5: GLFW.D5, Digit6: GLFW.D6, Digit7: GLFW.D7,
    Digit8: GLFW.D8, Digit9: GLFW.D9,

    // Функциональные.
    F1: GLFW.F1, F2: GLFW.F2, F3: GLFW.F3, F4: GLFW.F4, F5: GLFW.F5, F6: GLFW.F6,
    F7: GLFW.F7, F8: GLFW.F8, F9: GLFW.F9, F10: GLFW.F10, F11: GLFW.F11, F12: GLFW.F12,

    // Стрелки.
    ArrowUp: GLFW.UP,
    ArrowDown: GLFW.DOWN,
    ArrowLeft: GLFW.LEFT,
    ArrowRight: GLFW.RIGHT,

    // Основные управляющие.
    Space: GLFW.SPACE,
    Enter: GLFW.ENTER,
    Escape: GLFW.ESCAPE,
    Tab: GLFW.TAB,
    Backspace: GLFW.BACKSPACE,

    // Модификаторы. Левый и правый различаются: DOOM ждёт именно левые
    // (см. DEFAULT.CFG), но правые тоже пробрасываем — играть левой
    // рукой на ноутбуке никто не запрещал.
    ControlLeft: GLFW.LEFT_CONTROL,
    ControlRight: GLFW.RIGHT_CONTROL,
    AltLeft: GLFW.LEFT_ALT,
    AltRight: GLFW.RIGHT_ALT,
    ShiftLeft: GLFW.LEFT_SHIFT,
    ShiftRight: GLFW.RIGHT_SHIFT,
    MetaLeft: GLFW.LEFT_SUPER,
    MetaRight: GLFW.RIGHT_SUPER,
    ContextMenu: GLFW.MENU,

    // Пунктуация основного блока.
    Comma: GLFW.COMMA,
    Period: GLFW.PERIOD,
    Slash: GLFW.SLASH,
    Minus: GLFW.MINUS,
    Equal: GLFW.EQUAL,
    BracketLeft: GLFW.LEFT_BRACKET,
    BracketRight: GLFW.RIGHT_BRACKET,
    Semicolon: GLFW.SEMICOLON,
    Quote: GLFW.APOSTROPHE,
    Backquote: GLFW.GRAVE_ACCENT,
    Backslash: GLFW.BACKSLASH,

    // Цифровой блок.
    Numpad0: GLFW.KP_0, Numpad1: GLFW.KP_1, Numpad2: GLFW.KP_2,
    Numpad3: GLFW.KP_3, Numpad4: GLFW.KP_4, Numpad5: GLFW.KP_5,
    Numpad6: GLFW.KP_6, Numpad7: GLFW.KP_7, Numpad8: GLFW.KP_8,
    Numpad9: GLFW.KP_9,
    NumpadDecimal: GLFW.KP_DECIMAL,
    NumpadDivide: GLFW.KP_DIVIDE,
    NumpadMultiply: GLFW.KP_MULTIPLY,
    NumpadSubtract: GLFW.KP_SUBTRACT,
    NumpadAdd: GLFW.KP_ADD,
    NumpadEnter: GLFW.KP_ENTER,
    NumpadEqual: GLFW.KP_EQUAL,
    NumLock: GLFW.NUM_LOCK,

    // Навигационный блок.
    Home: GLFW.HOME,
    End: GLFW.END,
    PageUp: GLFW.PAGE_UP,
    PageDown: GLFW.PAGE_DOWN,
    Insert: GLFW.INSERT,
    Delete: GLFW.DELETE,

    // Прочее.
    CapsLock: GLFW.CAPS_LOCK,
    Pause: GLFW.PAUSE,
    PrintScreen: GLFW.PRINT_SCREEN,
    ScrollLock: GLFW.SCROLL_LOCK,
});

/**
 * Перевод `e.code` в код GLFW3.
 * @param {string} code значение `KeyboardEvent.code`
 * @returns {number|null} код GLFW или `null` для клавиш, которых нет в таблице
 */
export function codeToGlfw(code) {
    if (typeof code !== 'string') return null;
    // Прямое обращение к литералу опасно наследованными свойствами Object
    // («constructor», «toString» и прочий мусор из прототипа), поэтому проверяем
    // собственные ключи.
    if (!Object.prototype.hasOwnProperty.call(CODE_TO_GLFW, code)) return null;
    return CODE_TO_GLFW[code];
}

// --- Что реально использует DOOM ---------------------------------------------

// Клавиши, задействованные ванильным DOOM при раскладке по умолчанию. Список — не рычаг,
// а документация с проверкой: тест `tests/dos/keys.test.mjs` гоняет по нему codeToGlfw()
// и падает, если из CODE_TO_GLFW выпала нужная DOOM клавиша. Перехват клавиатуры на
// список НЕ опирается — при фокусе на канвасе глушится всё подряд, а не
// избранное; отладочный оверлей показывает cpuMetrics и клавиш не рисует.
export const DOOM_KEY_CODES = Object.freeze([
    // Движение и поворот.
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    // Действия.
    'ControlLeft', 'Space', 'AltLeft', 'ShiftLeft',
    // Меню и системное.
    'Escape', 'Enter', 'Tab', 'Backspace',
    // Ответы «да/нет» в диалогах меню.
    'KeyY', 'KeyN',
    // Выбор оружия 1–7 (в shareware больше и нет).
    'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7',
    // Оригинальный стрейф на запятой/точке — раскладку можно вернуть в меню игры.
    'Comma', 'Period',
    // Служебные функции движка: F1 помощь, F2/F3 сейв/лоад, F4 звук, F5 детализация,
    // F6 quicksave, F7 конец игры, F8 сообщения, F9 quickload, F10 выход,
    // F11 гамма, F12 spy-камера.
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    // Размер экрана (screenblocks) и пауза.
    'Minus', 'Equal', 'Pause',
]);
