// Генераторы текстовых конфигов бандла: `dosbox.conf` и `DEFAULT.CFG`.
//
// Зачем генератор, а не два файла в assets: значения должны жить в коде, чтобы их
// можно было покрыть тестом и переопределить из настроек расширения (циклы,
// frameskip, чувствительность). `dosbox.conf` мы и так передаём строкой — класть
// его в zip нельзя, `.jsdos/dosbox.conf` из архива перезапишет переданную строку.
//
// Модуль чистый: только строки и числа, ни DOM, ни файловой системы.

// --- Единственный источник правды по Sound Blaster ---------------------------
//
// Значения `sbbase`/`irq`/`dma` в dosbox.conf ОБЯЗАНЫ совпадать с
// `snd_sbport`/`snd_sbirq`/`snd_sbdma` в DEFAULT.CFG. Рассинхрон даёт полную
// тишину без единого сообщения об ошибке — искать такое можно долго.
//
// Поэтому оба конфига читают одну и ту же структуру, и разойтись они могут
// только если кто-то специально это сломает. Обратите внимание на форматы:
// DOSBox ждёт порт шестнадцатеричным без префикса («220»), DOOM — десятичным
// числом (544). Это одно и то же значение, записанное по-разному.
export const SOUND_BLASTER = Object.freeze({
    port: 0x220,   // = 544
    irq: 7,
    dma: 1,
    hdma: 5,
});

/** Порт в том виде, в каком его ждёт dosbox.conf: hex без префикса. */
export const sbPortHex = () => SOUND_BLASTER.port.toString(16);

/** Порт в том виде, в каком его ждёт DEFAULT.CFG: десятичное число. */
export const sbPortDecimal = () => SOUND_BLASTER.port;

// --- Пределы, нарушение которых ломает игру ----------------------------------

// `mouse_sensitivity` ≥ 31 роняет DOOM при заходе в Options.
export const MOUSE_SENSITIVITY_MAX = 30;
// memsize > 64 ломает DOS/4GW 1.95 внутри DOOM.EXE. Поднимать нельзя.
export const MEMSIZE_MAX = 64;

// --- Скан-коды IBM PC set-1 ---------------------------------------------------
//
// ЛОВУШКА: поля `key_*` в DEFAULT.CFG — это скан-коды клавиатуры IBM PC set-1,
// а НЕ константы `KEY_*` из `doomdef.h`. В движке для этого есть отдельный
// «PC scan code hack». Подставить сюда `KEY_RIGHTARROW` (0xae) — классическая
// ошибка, которая даёт молча неработающую раскладку.
export const SCAN = Object.freeze({
    ESCAPE: 1,
    D1: 2, D2: 3, D3: 4, D4: 5, D5: 6, D6: 7, D7: 8, D8: 9, D9: 10, D0: 11,
    MINUS: 12,
    EQUAL: 13,
    BACKSPACE: 14,
    TAB: 15,
    Q: 16, W: 17, E: 18, R: 19, T: 20, Y: 21, U: 22, I: 23, O: 24, P: 25,
    BRACKET_LEFT: 26,
    BRACKET_RIGHT: 27,
    ENTER: 28,
    CTRL: 29,
    A: 30, S: 31, D: 32, F: 33, G: 34, H: 35, J: 36, K: 37, L: 38,
    SEMICOLON: 39,
    QUOTE: 40,
    BACKQUOTE: 41,
    LSHIFT: 42,
    BACKSLASH: 43,
    Z: 44, X: 45, C: 46, V: 47, B: 48, N: 49, M: 50,
    COMMA: 51,
    PERIOD: 52,
    SLASH: 53,
    RSHIFT: 54,
    ALT: 56,
    SPACE: 57,
    CAPS_LOCK: 58,
    F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
    F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
    NUM_LOCK: 69,
    SCROLL_LOCK: 70,
    HOME: 71,
    UP: 72,
    PAGE_UP: 73,
    LEFT: 75,
    RIGHT: 77,
    END: 79,
    DOWN: 80,
    PAGE_DOWN: 81,
    INSERT: 82,
    DELETE: 83,
    F11: 87, F12: 88,
});

// --- dosbox.conf --------------------------------------------------------------

/** Значения, которые разрешено переопределять снаружи. */
export const DOSBOX_DEFAULTS = Object.freeze({
    cycles: 20000,   // рычаг производительности №1
    frameskip: 0,    // рычаг производительности №2, аварийный
    memsize: 16,     // выше 64 нельзя, см. MEMSIZE_MAX
});

// Плеер js-dos валидирует смену циклов диапазоном 3000…1 000 000 — держимся тех же
// границ, чтобы «cycles:NNNNN» на лету и стартовый конфиг вели себя одинаково.
export const CYCLES_MIN = 3000;
export const CYCLES_MAX = 1000000;

/**
 * Приводит значение циклов к допустимому. Живёт ЗДЕСЬ, а не в `runtime.js`, хотя
 * зовётся оттуда: функция чистая и зависит только от границ выше, а панель настроек
 * (`shell/settings-panel.js`) — второй её потребитель. Пока она лежала в рантайме,
 * окно ради одного этого хелпера тянуло в свой граф импортов весь слой эмулятора —
 * загрузчик, рендер, звук, хранилище, — и принцип «окно про эмулятор не знает» был
 * верен только по поведению, но не по коду.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampCycles(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DOSBOX_DEFAULTS.cycles;
    return Math.round(Math.max(CYCLES_MIN, Math.min(CYCLES_MAX, number)));
}

function clampInt(value, min, max, fallback, warn, what) {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return fallback;
    if (n < min) {
        warn?.(`${what}: ${n} меньше минимума ${min}, беру ${min}`);
        return min;
    }
    if (n > max) {
        warn?.(`${what}: ${n} больше максимума ${max}, беру ${max}`);
        return max;
    }
    return n;
}

/**
 * Сборка `dosbox.conf`.
 * @param {object} [overrides] `cycles`, `frameskip`, `memsize`
 * @param {(msg: string) => void} [warn] куда сообщать о зажатых значениях
 * @returns {string} валидный ini
 */
export function buildDosboxConf(overrides = {}, warn) {
    const cycles = clampInt(
        overrides.cycles ?? DOSBOX_DEFAULTS.cycles,
        CYCLES_MIN, CYCLES_MAX, DOSBOX_DEFAULTS.cycles, warn, 'cycles',
    );
    const frameskip = clampInt(
        overrides.frameskip ?? DOSBOX_DEFAULTS.frameskip,
        0, 10, DOSBOX_DEFAULTS.frameskip, warn, 'frameskip',
    );
    // memsize зажат сверху жёстко: >64 ломает DOS/4GW внутри DOOM.EXE.
    const memsize = clampInt(
        overrides.memsize ?? DOSBOX_DEFAULTS.memsize,
        1, MEMSIZE_MAX, DOSBOX_DEFAULTS.memsize, warn, 'memsize',
    );

    return [
        '[sdl]',
        'autolock     = false',        // Pointer Lock захватываем сами
        'usescancodes = true',
        '',
        '[dosbox]',
        'machine = svga_s3',
        `memsize = ${memsize}`,        // НЕ поднимать выше 64
        '',
        '[render]',
        `frameskip = ${frameskip}`,
        'aspect    = false',           // коррекцию 4:3 делает наш рендерер
        'scaler    = none',
        '',
        '[cpu]',
        'core    = normal',            // dynamic в js-dos недоступен
        'cputype = auto',
        `cycles  = ${cycles}`,
        '',
        '[mixer]',
        'rate      = 49716',
        'blocksize = 1024',
        'prebuffer = 20',
        '',
        '[midi]',
        'mpu401     = none',
        'mididevice = none',
        '',
        '[sblaster]',
        'sbtype  = sbpro2',
        `sbbase  = ${sbPortHex()}`,    // синхронно с snd_sbport в DEFAULT.CFG
        `irq     = ${SOUND_BLASTER.irq}`,
        `dma     = ${SOUND_BLASTER.dma}`,
        `hdma    = ${SOUND_BLASTER.hdma}`,
        'oplmode = opl3',
        'oplemu  = default',
        'oplrate = 49716',
        '',
        '[joystick]',
        'joysticktype = none',         // геймпад разбираем сами
        '',
        '[dos]',
        'xms = true',
        'ems = true',
        'umb = true',
        '',
        '[autoexec]',
        'SET DMXOPTION=-opl3',         // стерео-OPL3, регистр важен
        'mount c .',
        'c:',
        'DOOM.EXE',
        '',
    ].join('\n');
}

// --- DEFAULT.CFG ---------------------------------------------------------------

/** Значения DEFAULT.CFG, которые разрешено переопределять снаружи. */
export const DOOM_CFG_DEFAULTS = Object.freeze({
    mouse_sensitivity: 5,
    sfx_volume: 8,
    music_volume: 8,
    screenblocks: 10,
    detaillevel: 0,   // инвертировано: 0 = высокая детализация
});

/**
 * Сборка `DEFAULT.CFG`.
 *
 * Формат парсится движком как `sscanf(line, "%79s %[^\n]")`, то есть комментарии
 * в файле НЕ поддерживаются: «; …» после значения уехало бы прямо в значение.
 * Поэтому пояснения остаются здесь, в коде, а в вывод не идут.
 *
 * @param {object} [overrides] `mouse_sensitivity`, `sfx_volume`, `music_volume`,
 *   `screenblocks`, `detaillevel`
 * @param {(msg: string) => void} [warn]
 * @returns {string}
 */
export function buildDefaultCfg(overrides = {}, warn) {
    // ⚠ Значение ≥31 роняет игру при заходе в Options — клампим молча нельзя,
    // предупреждаем.
    const mouseSensitivity = clampInt(
        overrides.mouse_sensitivity ?? DOOM_CFG_DEFAULTS.mouse_sensitivity,
        0, MOUSE_SENSITIVITY_MAX, DOOM_CFG_DEFAULTS.mouse_sensitivity,
        warn, 'mouse_sensitivity',
    );
    const sfxVolume = clampInt(
        overrides.sfx_volume ?? DOOM_CFG_DEFAULTS.sfx_volume,
        0, 15, DOOM_CFG_DEFAULTS.sfx_volume, warn, 'sfx_volume',
    );
    const musicVolume = clampInt(
        overrides.music_volume ?? DOOM_CFG_DEFAULTS.music_volume,
        0, 15, DOOM_CFG_DEFAULTS.music_volume, warn, 'music_volume',
    );
    // 3 — минимально осмысленный размер окна, 11 — весь экран без статус-бара.
    const screenblocks = clampInt(
        overrides.screenblocks ?? DOOM_CFG_DEFAULTS.screenblocks,
        3, 11, DOOM_CFG_DEFAULTS.screenblocks, warn, 'screenblocks',
    );
    const detaillevel = clampInt(
        overrides.detaillevel ?? DOOM_CFG_DEFAULTS.detaillevel,
        0, 1, DOOM_CFG_DEFAULTS.detaillevel, warn, 'detaillevel',
    );

    // Раскладка: WASD на движение, стрелки на поворот. Оригинальная схема 1993-го
    // («стрелки на всё, стрейф на запятой») сегодня непригодна.
    const lines = [
        ['key_up', SCAN.W],              // вперёд
        ['key_down', SCAN.S],            // назад
        ['key_strafeleft', SCAN.A],
        ['key_straferight', SCAN.D],
        ['key_left', SCAN.LEFT],         // поворот влево
        ['key_right', SCAN.RIGHT],       // поворот вправо
        ['key_fire', SCAN.CTRL],
        ['key_use', SCAN.SPACE],
        ['key_strafe', SCAN.ALT],        // модификатор «поворот → стрейф»
        ['key_speed', SCAN.LSHIFT],
        ['use_mouse', 1],
        ['mouseb_fire', 0],
        ['mouseb_strafe', 1],
        ['mouseb_forward', 2],
        ['mouse_sensitivity', mouseSensitivity],
        ['joyb_speed', 29],              // вечный бег: убирает кнопку-модификатор
        ['screenblocks', screenblocks],
        ['detaillevel', detaillevel],
        ['snd_musicdevice', 3],          // Sound Blaster → OPL из GENMIDI в WAD
        ['snd_sfxdevice', 3],
        ['snd_sbport', sbPortDecimal()], // синхронно с sbbase в dosbox.conf
        ['snd_sbirq', SOUND_BLASTER.irq],
        ['snd_sbdma', SOUND_BLASTER.dma],
        ['sfx_volume', sfxVolume],
        ['music_volume', musicVolume],
    ];

    return lines.map(([key, value]) => `${key}\t\t${value}`).join('\n') + '\n';
}

// --- Разбор конфигов (для тестов и отладки) -----------------------------------

/** Разбор ini dosbox.conf в плоскую карту `секция.ключ` → строка. */
export function parseIni(text) {
    const out = {};
    let section = '';
    for (const raw of text.split('\n')) {
        const line = raw.replace(/;.*$/, '').trim();
        if (!line) continue;
        const sec = /^\[(.+)\]$/.exec(line);
        if (sec) {
            section = sec[1];
            continue;
        }
        const eq = line.indexOf('=');
        if (eq < 0) continue; // строки [autoexec] — команды, а не пары
        const key = line.slice(0, eq).trim();
        out[`${section}.${key}`] = line.slice(eq + 1).trim();
    }
    return out;
}

/** Разбор DEFAULT.CFG в карту `ключ` → строка. */
export function parseDoomCfg(text) {
    const out = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const m = /^(\S+)\s+(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].trim();
    }
    return out;
}
