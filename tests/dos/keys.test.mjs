// Тесты таблицы GLFW-кодов. Чистое ядро, без DOM.
// Учёт удерживаемых клавиш живёт в src/input/keyboard.js и проверяется своим тестом.
// Запуск: node tests/dos/keys.test.mjs

import {
    CODE_TO_GLFW, DOOM_KEY_CODES, GLFW,
    codeToGlfw,
} from '../../src/dos/keys.js';
import { assert, assertEqual, report, test } from '../_harness.mjs';

console.log('dos keys');

test('коды из таблицы в docs/input.md совпадают со спецификацией GLFW3', () => {
    const expected = {
        ArrowUp: 265, ArrowDown: 264, ArrowLeft: 263, ArrowRight: 262,
        ControlLeft: 341, AltLeft: 342, ShiftLeft: 340,
        KeyY: 89, KeyN: 78,
        Space: 32, Enter: 257, Escape: 256, Tab: 258,
        Comma: 44, Period: 46,
        Digit1: 49, Digit9: 57,
        F1: 290, F12: 301,
    };
    for (const [code, glfw] of Object.entries(expected)) {
        assertEqual(codeToGlfw(code), glfw, `${code}`);
    }
});

test('базовые диапазоны GLFW3 идут подряд без дыр', () => {
    for (let i = 0; i < 26; i++) {
        const code = `Key${String.fromCharCode(65 + i)}`;
        assertEqual(codeToGlfw(code), 65 + i, code);
    }
    for (let i = 0; i <= 9; i++) {
        assertEqual(codeToGlfw(`Digit${i}`), 48 + i, `Digit${i}`);
    }
    for (let i = 1; i <= 12; i++) {
        assertEqual(codeToGlfw(`F${i}`), 289 + i, `F${i}`);
    }
    for (let i = 0; i <= 9; i++) {
        assertEqual(codeToGlfw(`Numpad${i}`), 320 + i, `Numpad${i}`);
    }
});

test('пунктуация, цифровой блок и навигация на месте', () => {
    const expected = {
        Quote: 39, Minus: 45, Slash: 47, Semicolon: 59, Equal: 61,
        BracketLeft: 91, Backslash: 92, BracketRight: 93, Backquote: 96,
        Backspace: 259, Insert: 260, Delete: 261,
        PageUp: 266, PageDown: 267, Home: 268, End: 269,
        CapsLock: 280, ScrollLock: 281, NumLock: 282, PrintScreen: 283, Pause: 284,
        NumpadDecimal: 330, NumpadDivide: 331, NumpadMultiply: 332,
        NumpadSubtract: 333, NumpadAdd: 334, NumpadEnter: 335, NumpadEqual: 336,
        ControlRight: 345, AltRight: 346, ShiftRight: 344,
        MetaLeft: 343, MetaRight: 347, ContextMenu: 348,
    };
    for (const [code, glfw] of Object.entries(expected)) {
        assertEqual(codeToGlfw(code), glfw, `${code}`);
    }
});

test('маппинг идёт от e.code и потому не зависит от раскладки', () => {
    // Физическая клавиша «W» на кириллице даёт e.key === 'ц' и другой e.keyCode,
    // но e.code остаётся 'KeyW'. Если бы мы маппили от keyCode, движение вперёд
    // на русской раскладке отвалилось бы.
    assertEqual(codeToGlfw('KeyW'), GLFW.W, 'KeyW');
    // Ни одного ключа вида 'ц'/'w'/числа в таблице быть не должно.
    for (const key of Object.keys(CODE_TO_GLFW)) {
        assert(/^[A-Za-z][A-Za-z0-9]*$/.test(key), `подозрительный ключ таблицы: ${key}`);
        assert(Number.isNaN(Number(key)), `ключ-число в таблице: ${key}`);
    }
});

test('неизвестный код не даёт мусора', () => {
    for (const bad of ['Unidentified', 'KeyЦ', '', 'F99', 'Numpad10', 'w']) {
        assertEqual(codeToGlfw(bad), null, `неизвестный код ${JSON.stringify(bad)}`);
    }
    // Наследованные свойства Object не должны просочиться как коды.
    for (const proto of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
        assertEqual(codeToGlfw(proto), null, `свойство прототипа ${proto}`);
    }
    // Не-строки тоже.
    for (const bad of [undefined, null, 87, {}, []]) {
        assertEqual(codeToGlfw(bad), null, `не-строка ${String(bad)}`);
    }
});

test('все значения таблицы — целые числа в допустимом диапазоне GLFW', () => {
    for (const [code, value] of Object.entries(CODE_TO_GLFW)) {
        assert(Number.isInteger(value), `${code}: не целое`);
        assert(value >= 32 && value <= 348, `${code}: ${value} вне диапазона GLFW3`);
    }
});

test('список клавиш DOOM целиком покрыт таблицей', () => {
    for (const code of DOOM_KEY_CODES) {
        assert(codeToGlfw(code) !== null, `клавиша DOOM без маппинга: ${code}`);
    }
    assertEqual(new Set(DOOM_KEY_CODES).size, DOOM_KEY_CODES.length, 'без дублей');
});

report('dos keys');
