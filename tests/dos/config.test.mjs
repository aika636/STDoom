// Тесты генераторов dosbox.conf и DEFAULT.CFG. Без DOM и wasm.
// Запуск: node tests/dos/config.test.mjs
//
// Отдельная группа в конце файла — тесты-стражи против расхождения конфигов
// «Расхождение эталонного dosbox.conf и генератора». Эталоны в `assets/doom/` и
// генераторы в `src/dos/config.js` описывают одно и то же, но живут порознь и в
// рантайм идут РАЗНЫМИ путями:
//   • dosbox.conf строит генератор (src/dos/runtime.js), эталон не читает никто —
//     он остаётся документацией и справочником, отставать он не имеет права;
//   • DEFAULT.CFG, наоборот, едет в doom.zip файлом с диска (tools/build-bundle.mjs),
//     а buildDefaultCfg() вне тестов не вызывается вообще. Поэтому при расхождении
//     здесь отстающей стороной, скорее всего, окажется КОД: в игру попал файл, а
//     не вывод генератора. Чинить надо, разобравшись, какая сторона права, а не
//     подгонкой одной под другую.
// Сравниваем разобранное, а не байты: переводы строк (CRLF/LF), выравнивание
// пробелами и табами и `;`-комментарии в ini на смысл не влияют.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    MEMSIZE_MAX, MOUSE_SENSITIVITY_MAX, SCAN, SOUND_BLASTER,
    buildDefaultCfg, buildDosboxConf, parseDoomCfg, parseIni,
} from '../../src/dos/config.js';
import { assert, assertEqual, report, test } from '../_harness.mjs';

/** Чтение эталона из assets/doom/ — путь от файла теста, а не от cwd. */
const readAsset = (name) => readFileSync(
    fileURLToPath(new URL(`../../assets/doom/${name}`, import.meta.url)),
    'utf8',
);

/**
 * Сверка двух разобранных карт ключ→значение. Сообщение обязано называть
 * конкретный ключ и обе стороны — иначе страж бесполезен: «файлы разошлись»
 * не подсказывает, где смотреть.
 */
function assertSameMap(actual, expected, whatActual, whatExpected) {
    const problems = [];
    for (const key of Object.keys(expected)) {
        if (!(key in actual)) {
            problems.push(`${key}: есть в «${whatExpected}» (${expected[key]}), нет в «${whatActual}»`);
        } else if (actual[key] !== expected[key]) {
            problems.push(`${key}: «${whatActual}» = ${actual[key]}, «${whatExpected}» = ${expected[key]}`);
        }
    }
    for (const key of Object.keys(actual)) {
        if (!(key in expected)) {
            problems.push(`${key}: есть в «${whatActual}» (${actual[key]}), нет в «${whatExpected}»`);
        }
    }
    assert(problems.length === 0, `расхождений: ${problems.length}\n${problems.join('\n')}`);
}

console.log('dos config');

test('dosbox.conf: ключевые поля', () => {
    const ini = parseIni(buildDosboxConf());
    const expected = {
        'sdl.autolock': 'false',
        'sdl.usescancodes': 'true',
        'dosbox.machine': 'svga_s3',
        'dosbox.memsize': '16',
        'render.frameskip': '0',
        'render.aspect': 'false',
        'render.scaler': 'none',
        'cpu.core': 'normal',
        'cpu.cputype': 'auto',
        'cpu.cycles': '20000',
        'mixer.rate': '49716',
        'mixer.blocksize': '1024',
        'mixer.prebuffer': '20',
        'midi.mpu401': 'none',
        'midi.mididevice': 'none',
        'sblaster.sbtype': 'sbpro2',
        'sblaster.oplmode': 'opl3',
        'sblaster.oplemu': 'default',
        'sblaster.oplrate': '49716',
        'joystick.joysticktype': 'none',
        'dos.xms': 'true',
        'dos.ems': 'true',
        'dos.umb': 'true',
    };
    for (const [key, value] of Object.entries(expected)) {
        assertEqual(ini[key], value, key);
    }
});

test('dosbox.conf: autoexec монтирует диск и запускает DOOM', () => {
    const text = buildDosboxConf();
    const tail = text.slice(text.indexOf('[autoexec]'));
    assert(tail.includes('SET DMXOPTION=-opl3'), 'стерео-OPL3, регистр важен');
    assert(tail.includes('mount c .'), 'монтирование');
    assert(tail.includes('\nc:\n'), 'переход на диск C');
    assert(tail.includes('DOOM.EXE'), 'запуск игры');
    // core=dynamic в js-dos-форке недоступен — попасть в конфиг он не должен.
    assert(!text.includes('dynamic'), 'никакого core=dynamic');
});

test('dosbox.conf: переопределение рычагов производительности', () => {
    const ini = parseIni(buildDosboxConf({ cycles: 35000, frameskip: 1 }));
    assertEqual(ini['cpu.cycles'], '35000', 'cycles');
    assertEqual(ini['render.frameskip'], '1', 'frameskip');
});

test('dosbox.conf: cycles зажат диапазоном плеера 3000…1000000', () => {
    const warnings = [];
    const low = parseIni(buildDosboxConf({ cycles: 100 }, (m) => warnings.push(m)));
    assertEqual(low['cpu.cycles'], '3000', 'нижняя граница');
    const high = parseIni(buildDosboxConf({ cycles: 9e9 }, (m) => warnings.push(m)));
    assertEqual(high['cpu.cycles'], '1000000', 'верхняя граница');
    assertEqual(warnings.length, 2, 'о зажатии предупредили дважды');
});

test('memsize нельзя поднять выше 64 — иначе ломается DOS/4GW', () => {
    const warnings = [];
    const ini = parseIni(buildDosboxConf({ memsize: 256 }, (m) => warnings.push(m)));
    assertEqual(ini['dosbox.memsize'], String(MEMSIZE_MAX), 'зажато до 64');
    assertEqual(warnings.length, 1, 'предупреждение выдано');
    assert(warnings[0].includes('memsize'), 'предупреждение про memsize');
});

test('DEFAULT.CFG: раскладка задана скан-кодами set-1, а не константами KEY_*', () => {
    const cfg = parseDoomCfg(buildDefaultCfg());
    const expected = {
        key_up: '17',           // W
        key_down: '31',         // S
        key_strafeleft: '30',   // A
        key_straferight: '32',  // D
        key_left: '75',         // ←
        key_right: '77',        // →
        key_fire: '29',         // Ctrl
        key_use: '57',          // Space
        key_strafe: '56',       // Alt
        key_speed: '42',        // Shift
    };
    for (const [key, value] of Object.entries(expected)) {
        assertEqual(cfg[key], value, key);
    }
    // Константы KEY_* из doomdef.h (0xac…0xae и т.п.) сюда попасть не должны:
    // все скан-коды set-1 помещаются в один байт и меньше 90.
    for (const key of Object.keys(cfg)) {
        if (!key.startsWith('key_')) continue;
        const n = Number(cfg[key]);
        assert(n > 0 && n <= 88, `${key}=${n} не похож на скан-код set-1`);
    }
});

test('DEFAULT.CFG: таблица SCAN согласована с раскладкой', () => {
    assertEqual(SCAN.W, 17, 'W');
    assertEqual(SCAN.A, 30, 'A');
    assertEqual(SCAN.S, 31, 'S');
    assertEqual(SCAN.D, 32, 'D');
    assertEqual(SCAN.ESCAPE, 1, 'Esc');
    assertEqual(SCAN.CTRL, 29, 'Ctrl');
    assertEqual(SCAN.LSHIFT, 42, 'LShift');
    assertEqual(SCAN.ALT, 56, 'Alt');
    assertEqual(SCAN.SPACE, 57, 'Space');
    assertEqual(SCAN.COMMA, 51, '«,»');
    assertEqual(SCAN.PERIOD, 52, '«.»');
    assertEqual(SCAN.UP, 72, '↑');
    assertEqual(SCAN.LEFT, 75, '←');
    assertEqual(SCAN.RIGHT, 77, '→');
    assertEqual(SCAN.DOWN, 80, '↓');
    assertEqual(SCAN.E, 18, 'E');
    assertEqual(SCAN.TAB, 15, 'Tab');
    assertEqual(SCAN.ENTER, 28, 'Enter');
});

test('DEFAULT.CFG: мышь, вечный бег и звук', () => {
    const cfg = parseDoomCfg(buildDefaultCfg());
    assertEqual(cfg.use_mouse, '1', 'мышь включена');
    assertEqual(cfg.mouseb_fire, '0', 'ЛКМ — огонь');
    assertEqual(cfg.mouseb_strafe, '1', 'ПКМ — стрейф');
    assertEqual(cfg.mouseb_forward, '2', 'СКМ — вперёд');
    assertEqual(cfg.joyb_speed, '29', 'вечный бег (не 31 — ломается на Final Doom)');
    assertEqual(cfg.snd_musicdevice, '3', 'музыка через Sound Blaster/OPL');
    assertEqual(cfg.snd_sfxdevice, '3', 'звук через Sound Blaster');
    assertEqual(cfg.screenblocks, '10', 'размер окна');
    assertEqual(cfg.detaillevel, '0', '0 = высокая детализация, значение инвертировано');
});

test('DEFAULT.CFG не содержит комментариев — движок их не парсит', () => {
    // Формат читается как sscanf("%79s %[^\n]"), поэтому «; …» после значения
    // уехало бы прямо в значение.
    const text = buildDefaultCfg();
    assert(!text.includes(';'), 'нет точек с запятой');
    assert(!text.includes('#'), 'нет решёток');
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const m = /^(\S+)\s+(\S+)$/.exec(line.trim());
        assert(m, `строка не в формате «ключ значение»: ${JSON.stringify(line)}`);
        assert(/^-?\d+$/.test(m[2]), `значение не число: ${line}`);
    }
});

test('mouse_sensitivity ≥31 роняет игру — клампим и предупреждаем', () => {
    const warnings = [];
    const cfg = parseDoomCfg(buildDefaultCfg({ mouse_sensitivity: 40 }, (m) => warnings.push(m)));
    assertEqual(cfg.mouse_sensitivity, String(MOUSE_SENSITIVITY_MAX), 'зажато до 30');
    assertEqual(warnings.length, 1, 'предупреждение выдано');
    assert(warnings[0].includes('mouse_sensitivity'), 'предупреждение по делу');

    // Ровно 30 — ещё допустимо и проходит молча.
    const quiet = [];
    const ok = parseDoomCfg(buildDefaultCfg({ mouse_sensitivity: 30 }, (m) => quiet.push(m)));
    assertEqual(ok.mouse_sensitivity, '30', '30 разрешено');
    assertEqual(quiet.length, 0, 'без предупреждений');
});

test('DEFAULT.CFG: остальные переопределения', () => {
    const cfg = parseDoomCfg(buildDefaultCfg({
        sfx_volume: 15, music_volume: 0, screenblocks: 11, detaillevel: 1,
    }));
    assertEqual(cfg.sfx_volume, '15', 'sfx');
    assertEqual(cfg.music_volume, '0', 'music');
    assertEqual(cfg.screenblocks, '11', 'screenblocks');
    assertEqual(cfg.detaillevel, '1', 'detaillevel');
});

test('параметры Sound Blaster в двух конфигах обязаны совпадать', () => {
    // Рассинхрон даёт тишину без единого сообщения об ошибке — поэтому
    // источник правды один, а тест страхует от «оптимизации» руками.
    const ini = parseIni(buildDosboxConf());
    const cfg = parseDoomCfg(buildDefaultCfg());

    // Порт: DOSBox ждёт hex без префикса, DOOM — десятичное число.
    assertEqual(parseInt(ini['sblaster.sbbase'], 16), Number(cfg.snd_sbport), 'порт');
    assertEqual(ini['sblaster.sbbase'], '220', 'sbbase = 220 (hex)');
    assertEqual(cfg.snd_sbport, '544', 'snd_sbport = 544 (dec)');

    assertEqual(ini['sblaster.irq'], cfg.snd_sbirq, 'IRQ');
    assertEqual(ini['sblaster.dma'], cfg.snd_sbdma, 'DMA');

    assertEqual(Number(cfg.snd_sbport), SOUND_BLASTER.port, 'порт из источника правды');
    assertEqual(Number(cfg.snd_sbirq), SOUND_BLASTER.irq, 'IRQ из источника правды');
    assertEqual(Number(cfg.snd_sbdma), SOUND_BLASTER.dma, 'DMA из источника правды');
    assertEqual(Number(ini['sblaster.hdma']), SOUND_BLASTER.hdma, 'HDMA');
});

test('генераторы детерминированы и не портят defaults', () => {
    assertEqual(buildDosboxConf(), buildDosboxConf(), 'dosbox.conf стабилен');
    assertEqual(buildDefaultCfg(), buildDefaultCfg(), 'DEFAULT.CFG стабилен');
    buildDosboxConf({ cycles: 55555 });
    buildDefaultCfg({ mouse_sensitivity: 1 });
    assertEqual(parseIni(buildDosboxConf())['cpu.cycles'], '20000', 'defaults не мутировали');
    assertEqual(parseDoomCfg(buildDefaultCfg()).mouse_sensitivity, '5', 'defaults не мутировали');
});

// --- Стражи «эталон vs генератор» ---------------------------------------

/** Команды из [autoexec]: parseIni их не видит — там не пары «ключ = значение». */
function autoexecCommands(text) {
    const out = [];
    let inside = false;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '').replace(/;.*$/, '').trim();
        if (!line) continue;
        const sec = /^\[(.+)\]$/.exec(line);
        if (sec) {
            inside = sec[1] === 'autoexec';
            continue;
        }
        if (inside) out.push(line);
    }
    return out;
}

test('эталон assets/doom/dosbox.conf не разошёлся с buildDosboxConf()', () => {
    // Эталон никто не читает в рантайме — конфиг строит генератор. Значит эталон
    // обязан быть его точным слепком, иначе он тихо превращается во вредную
    // документацию.
    const asset = readAsset('dosbox.conf');
    assertSameMap(parseIni(asset), parseIni(buildDosboxConf()), 'assets/doom/dosbox.conf', 'buildDosboxConf()');

    // [autoexec] сравниваем отдельно: там команды, а не пары.
    const fromAsset = autoexecCommands(asset);
    const fromCode = autoexecCommands(buildDosboxConf());
    const max = Math.max(fromAsset.length, fromCode.length);
    for (let i = 0; i < max; i++) {
        assertEqual(
            fromAsset[i], fromCode[i],
            `[autoexec] строка ${i + 1}: assets/doom/dosbox.conf vs buildDosboxConf()`,
        );
    }
});

test('эталон assets/doom/DEFAULT.CFG не разошёлся с buildDefaultCfg()', () => {
    // ВНИМАНИЕ: в игру едет именно этот файл (tools/build-bundle.mjs), генератор вне
    // тестов не зовут. Если тест упал — сначала проверь, не отстал ли КОД.
    // Файл лежит с CRLF — parseDoomCfg режет по '\n', поэтому '\r' снимаем сами.
    const asset = readAsset('DEFAULT.CFG').replace(/\r\n/g, '\n');
    assertSameMap(parseDoomCfg(asset), parseDoomCfg(buildDefaultCfg()), 'assets/doom/DEFAULT.CFG', 'buildDefaultCfg()');
});

report('dos config');
