// Тесты настроек (Фаза 1): создание контейнера, мердж недостающих ключей и стойкость
// к битым значениям из руками поправленного settings.json. Чистый node, браузер не нужен.
// Запуск: node tests/shell/settings.test.mjs

import { assert, assertEqual, report, test } from '../_harness.mjs';
import { DEFAULTS, MODULE_NAME, getSettings, saveSettings } from '../../src/settings.js';

// Заглушка контекста: getCtx() из src/ctx.js зовёт глобальный SillyTavern в каждой
// точке использования, поэтому достаточно подменить его перед вызовом.
function stubContext(extensionSettings, save = () => {}) {
    const context = { extensionSettings, saveSettingsDebounced: save };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

console.log('settings');

test('пустые настройки заполняются дефолтами', () => {
    const root = {};
    stubContext(root);
    const settings = getSettings();

    assertEqual(settings.cycles, 20000, 'циклы');
    assertEqual(settings.sound, true, 'звук');
    assertEqual(settings.mouseSensitivity, 1, 'чувствительность мыши');
    assertEqual(settings.debugOverlay, false, 'отладочный оверлей');
    assert(settings.touchLayout && typeof settings.touchLayout === 'object', 'раскладка тача — объект');
    assert(root[MODULE_NAME] === settings, 'настройки живут прямо в extensionSettings');
});

test('чужие значения не затираются, недостающие ключи дописываются', () => {
    const root = { [MODULE_NAME]: { cycles: 30000 } };
    stubContext(root);
    const settings = getSettings();

    assertEqual(settings.cycles, 30000, 'сохранённое значение уцелело');
    assertEqual(settings.sound, true, 'недостающий ключ дописан из дефолтов');
    assertEqual(settings.version, DEFAULTS.version, 'версия схемы дописана');
});

test('битый контейнер заменяется свежим', () => {
    for (const broken of [null, 42, 'нет', []]) {
        const root = { [MODULE_NAME]: broken };
        stubContext(root);
        assertEqual(getSettings().cycles, 20000, `битое значение ${JSON.stringify(broken)}`);
    }
});

test('дефолты не расшариваются между инсталляциями', () => {
    const first = {};
    stubContext(first);
    getSettings().touchLayout.zone = 'left';

    const second = {};
    stubContext(second);
    assert(!Object.hasOwn(getSettings().touchLayout, 'zone'), 'вложенный объект склонирован, а не общий');
});

test('saveSettings зовёт saveSettingsDebounced таверны', () => {
    let calls = 0;
    stubContext({}, () => { calls++; });
    saveSettings();
    assertEqual(calls, 1, 'вызовов сохранения');
});

report('settings');
