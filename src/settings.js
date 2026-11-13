// Настройки расширения: extensionSettings.STDoom (camelCase-поле контекста ST),
// с мержем недостающих ключей при апгрейде. Миграций со старых ключей здесь нет —
// расширение новое, переносить не с чего.
//
// В settings.json живут ТОЛЬКО настройки. Сейвы DOOM (бинарь на десятки килобайт)
// сюда не кладём: settings.json читается и пишется целиком при каждом
// saveSettingsDebounced(). Для них будет IndexedDB — см. docs/architecture.md.

import { getCtx } from './ctx.js';

export const MODULE_NAME = 'STDoom';
export const SETTINGS_VERSION = 1;

// version      — номер схемы (задел под будущие миграции);
// cycles       — циклы DOSBox, старт 20000;
// sound        — звук включён (mute/unmute);
// volume       — громкость 0…100 %. Регулятора у эмулятора нет вовсе, это наш
//                собственный GainNode в графе js-dos (см. `dos/audio.js`);
// mouseSensitivity — наш собственный множитель дельт мыши; крутим только его,
//                множители в DEFAULT.CFG и dosbox.conf держим нейтральными;
// touchControls — тач-контролы: 'auto' (по наличию сенсора), 'on', 'off';
// touchLayout  — оверрайды раскладки тач-контролов: сдвиги и масштабы;
// debugOverlay — оверлей с cpuMetrics из asyncifyStats(), по умолчанию выключен.
export const DEFAULTS = Object.freeze({
    version: SETTINGS_VERSION,
    cycles: 20000,
    sound: true,
    volume: 100,
    mouseSensitivity: 1,
    touchControls: 'auto',
    touchLayout: {},
    debugOverlay: false,
});

/** Допустимые значения touchControls. Мусор из правленого руками settings.json → 'auto'. */
export const TOUCH_MODES = Object.freeze(['auto', 'on', 'off']);

export function normalizeTouchMode(value) {
    return TOUCH_MODES.includes(value) ? value : DEFAULTS.touchControls;
}

function isPlainObject(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// Возвращает живой (не клонированный) объект настроек, создавая его при первом
// обращении и добавляя недостающие ключи после апгрейдов, чтобы никогда не остаться
// с undefined-полями.
export function getSettings() {
    const root = getCtx().extensionSettings;

    // settings.json игрок может править руками, поэтому любой битый контейнер
    // (null, массив, скаляр) заменяется свежим — иначе мердж полей упал бы.
    if (!isPlainObject(root[MODULE_NAME])) {
        root[MODULE_NAME] = structuredClone(DEFAULTS);
    }
    const settings = root[MODULE_NAME];
    for (const key of Object.keys(DEFAULTS)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = structuredClone(DEFAULTS[key]);
        }
    }
    return settings;
}

export function saveSettings() {
    getCtx().saveSettingsDebounced();
}
