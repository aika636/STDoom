// Тесты распознавания IWAD.
//
// Чистый node, без jsdom. Настоящих коммерческих WAD в репозитории нет и не будет
//, поэтому все образцы здесь синтетические: заголовок + директория лампов,
// собранные руками. Этого достаточно — распознавание смотрит ровно на них.
//
// Главное, что здесь проверяется, — ИМЯ ФАЙЛА В DOS. Флага `-iwad` в ванили нет
//, движок ищет doom2.wad → doom.wad → doom1.wad, и ошибка в имени означает
// «игра не увидела WAD игрока» без единого сообщения.
//
// Запуск: node tests/dos/iwad.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    DOS_NAMES, KNOWN_IWADS, MAX_IWAD_SIZE, formatSize, inspectExe, inspectIwad,
} from '../../src/dos/iwad.js';
import { md5 } from '../../src/dos/md5.js';
import { assert, assertEqual, report, test } from '../_harness.mjs';

console.log('dos iwad');

/**
 * Собирает синтетический WAD: заголовок, пустые данные лампов и директория.
 * @param {string} magic 'IWAD' или 'PWAD'
 * @param {string[]} lumps имена лампов
 */
function makeWad(magic, lumps, { lumpCountOverride = null, dirOffsetOverride = null } = {}) {
    const dirOffset = 12;
    const size = dirOffset + lumps.length * 16;
    const bytes = new Uint8Array(size);

    for (let i = 0; i < 4; i++) bytes[i] = magic.charCodeAt(i);
    writeInt32(bytes, 4, lumpCountOverride ?? lumps.length);
    writeInt32(bytes, 8, dirOffsetOverride ?? dirOffset);

    lumps.forEach((name, index) => {
        const at = dirOffset + index * 16;
        writeInt32(bytes, at, 12);      // filepos, содержимое нам неважно
        writeInt32(bytes, at + 4, 0);   // size
        for (let i = 0; i < 8 && i < name.length; i++) bytes[at + 8 + i] = name.charCodeAt(i);
    });

    return bytes;
}

function writeInt32(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
}

const episodeLumps = (episodes) => episodes.flatMap(
    (e) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => `E${e}M${m}`),
);

// --- Определение имени файла ---------------------------------------------------

test('MAP01… → DOOM2.WAD', () => {
    const wad = makeWad('IWAD', ['PLAYPAL', 'MAP01', 'THINGS', 'MAP02', 'MAP32']);
    const info = inspectIwad(wad, 'doom2.wad');
    assert(info.ok, `распознан: ${info.error ?? ''}`);
    assertEqual(info.kind, 'doom2', 'тип');
    assertEqual(info.dosName, 'DOOM2.WAD', 'имя файла в DOS');
});

test('четыре эпизода → Ultimate Doom, имя DOOM.WAD', () => {
    const info = inspectIwad(makeWad('IWAD', ['PLAYPAL', ...episodeLumps([1, 2, 3, 4])]));
    assert(info.ok, 'распознан');
    assertEqual(info.kind, 'ultimate', 'тип');
    assertEqual(info.dosName, 'DOOM.WAD', 'имя файла в DOS');
    assertEqual(info.episodes.join(','), '1,2,3,4', 'эпизоды');
});

test('три эпизода → registered, имя тоже DOOM.WAD', () => {
    const info = inspectIwad(makeWad('IWAD', [...episodeLumps([1, 2, 3])]));
    assert(info.ok, 'распознан');
    assertEqual(info.kind, 'registered', 'тип');
    assertEqual(info.dosName, 'DOOM.WAD', 'имя файла в DOS');
});

test('только первый эпизод → shareware, имя DOOM1.WAD', () => {
    const info = inspectIwad(makeWad('IWAD', ['PLAYPAL', ...episodeLumps([1])]));
    assert(info.ok, 'распознан');
    assertEqual(info.kind, 'shareware', 'тип');
    assertEqual(info.dosName, 'DOOM1.WAD', 'имя файла в DOS');
});

test('MAP01 перевешивает эпизоды: смешанный WAD всё равно DOOM2.WAD', () => {
    // Так устроены сборники: карты MAP01… плюс остатки ресурсов первой части.
    const info = inspectIwad(makeWad('IWAD', ['E1M1', 'MAP01', 'MAP02']));
    assertEqual(info.dosName, 'DOOM2.WAD', 'doom2-подобный');
});

test('эпизод 4 без второго и третьего всё равно Ultimate', () => {
    const info = inspectIwad(makeWad('IWAD', [...episodeLumps([1]), 'E4M1']));
    assertEqual(info.kind, 'ultimate', 'наличие E4M1 решает');
});

test('таблица DOS_NAMES покрывает все типы', () => {
    for (const kind of ['doom2', 'ultimate', 'registered', 'shareware']) {
        assert(DOS_NAMES[kind], `имя для ${kind}`);
    }
    assertEqual(DOS_NAMES.registered, DOS_NAMES.ultimate, 'обе полные версии зовутся DOOM.WAD');
});

// --- MD5: информационный, а не запрещающий ------------------------------------

test('MD5 считается и попадает в результат', () => {
    const wad = makeWad('IWAD', ['MAP01']);
    const info = inspectIwad(wad);
    assertEqual(info.md5, md5(wad), 'тот же хеш, что у md5.js');
    assertEqual(info.size, wad.length, 'размер');
});

test('неизвестный MD5 — предупреждение, а НЕ отказ', () => {
    // Легальных изданий больше, чем в любой таблице: BFG, GOG, языковые версии.
    const info = inspectIwad(makeWad('IWAD', ['MAP01']));
    assertEqual(info.ok, true, 'файл принят');
    assertEqual(info.known, false, 'в таблице его нет');
    assertEqual(info.versionName, null, 'подписи версии нет');
    assert(info.warning && /MD5/.test(info.warning), 'но предупреждение есть');
});

test('таблица известных хешей: формат строк и отсутствие дублей', () => {
    const seen = new Set();
    for (const entry of KNOWN_IWADS) {
        assert(/^[0-9a-f]{32}$/.test(entry.md5), `хеш ${entry.md5} в нижнем регистре`);
        assert(entry.name && entry.name.length > 0, 'у строки есть человеческое имя');
        assert(!seen.has(entry.md5), `дубль хеша ${entry.md5}`);
        seen.add(entry.md5);
    }
    // Единственный по-настоящему проверенный хеш — shareware из репозитория.
    const shareware = KNOWN_IWADS.find((e) => e.md5 === 'f0cefca49926d00903cf57551d901abe');
    assert(shareware?.verified === true, 'shareware DOOM1.WAD помечен как сверенный');
});

// --- Отказы --------------------------------------------------------------------

test('PWAD отвергается с объяснением, что это набор карт', () => {
    const info = inspectIwad(makeWad('PWAD', ['MAP01']), 'mymaps.wad');
    assertEqual(info.ok, false, 'отказ');
    assert(/PWAD/.test(info.error), `в тексте есть слово PWAD: «${info.error}»`);
    assert(/IWAD/.test(info.error), 'и объяснение, что нужно');
});

test('мусор вместо WAD: видно, что нашли в начале файла', () => {
    const info = inspectIwad(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]));
    assertEqual(info.ok, false, 'отказ');
    assert(/не WAD/.test(info.error), `внятный текст: «${info.error}»`);
});

test('ZIP по расширению подсказывает распаковать', () => {
    const zip = new Uint8Array(64);
    zip[0] = 0x50; zip[1] = 0x4b; zip[2] = 0x03; zip[3] = 0x04;
    const info = inspectIwad(zip, 'doom2.zip');
    assert(/распаков/.test(info.error), `подсказка про архив: «${info.error}»`);
});

test('обрезанный файл: директория уходит за конец', () => {
    const wad = makeWad('IWAD', ['MAP01', 'MAP02', 'MAP03']);
    const truncated = wad.subarray(0, wad.length - 20);
    const info = inspectIwad(new Uint8Array(truncated));
    assertEqual(info.ok, false, 'отказ');
    assert(/обрезан/.test(info.error), `внятный текст: «${info.error}»`);
});

test('битый заголовок: ноль лампов и уехавшее смещение', () => {
    const zero = inspectIwad(makeWad('IWAD', ['MAP01'], { lumpCountOverride: 0 }));
    assertEqual(zero.ok, false, 'ноль лампов — отказ');

    const badOffset = inspectIwad(makeWad('IWAD', ['MAP01'], { dirOffsetOverride: 4 }));
    assertEqual(badOffset.ok, false, 'смещение внутрь заголовка — отказ');

    const negative = inspectIwad(makeWad('IWAD', ['MAP01'], { lumpCountOverride: -1 }));
    assertEqual(negative.ok, false, 'отрицательное число лампов — отказ');
});

test('слишком короткий и пустой файл', () => {
    assertEqual(inspectIwad(new Uint8Array(0)).ok, false, 'пустой');
    assertEqual(inspectIwad(new Uint8Array([0x49, 0x57, 0x41, 0x44])).ok, false, 'четыре байта');
});

test('IWAD без единой карты — не IWAD', () => {
    const info = inspectIwad(makeWad('IWAD', ['PLAYPAL', 'COLORMAP', 'ENDOOM']));
    assertEqual(info.ok, false, 'отказ');
    assert(/карт/.test(info.error), `текст про карты: «${info.error}»`);
});

test('потолок размера файла соблюдается', () => {
    assert(MAX_IWAD_SIZE >= 16 * 1024 * 1024, 'настоящий DOOM2.WAD (~14 МБ) проходит');
    // Сам файл-переросток не создаём: 65 МБ мусора в тестах ни к чему. Проверяем
    // границу через подделку длины.
    const fake = { length: MAX_IWAD_SIZE + 1 };
    Object.setPrototypeOf(fake, Uint8Array.prototype);
    const info = inspectIwad(fake);
    assertEqual(info.ok, false, 'отказ по размеру');
    assert(/слишком большой/.test(info.error), `внятный текст: «${info.error}»`);
});

// --- Свой DOOM.EXE -------------------------------------------------------------

test('DOOM.EXE опознаётся по сигнатуре MZ, shareware — по хешу', () => {
    const path = fileURLToPath(new URL('../../assets/doom/DOOM.EXE', import.meta.url));
    const info = inspectExe(new Uint8Array(readFileSync(path)));

    assert(info.ok, `штатный DOOM.EXE принят: ${info.error ?? ''}`);
    assertEqual(info.md5, 'e2382b7dc47ae2433d26b6e6bc312999', 'MD5 из ');
    assertEqual(info.known, true, 'он есть в таблице');
    assert(/shareware/i.test(info.versionName), `подпись версии: ${info.versionName}`);
});

test('в поле DOOM.EXE не примут WAD и не примут мусор', () => {
    const wad = inspectExe(makeWad('IWAD', ['MAP01']));
    assertEqual(wad.ok, false, 'WAD отвергнут');
    assert(/IWAD/.test(wad.error), `подсказка, куда его нести: «${wad.error}»`);

    const junk = inspectExe(new Uint8Array([1, 2, 3, 4, 5]));
    assertEqual(junk.ok, false, 'мусор отвергнут');
    assert(/MZ/.test(junk.error), `текст про MZ: «${junk.error}»`);

    assertEqual(inspectExe(new Uint8Array(0)).ok, false, 'пустой файл');
});

test('незнакомый DOOM.EXE принимается с предупреждением', () => {
    const exe = new Uint8Array(1024);
    exe[0] = 0x4d; exe[1] = 0x5a;
    const info = inspectExe(exe);
    assertEqual(info.ok, true, 'принят');
    assertEqual(info.known, false, 'в таблице его нет');
    assert(info.warning, 'но с предупреждением');
});

// --- Мелочи --------------------------------------------------------------------

test('formatSize даёт человеческие подписи', () => {
    assertEqual(formatSize(512), '512 Б', 'байты');
    assertEqual(formatSize(4096), '4.0 КБ', 'килобайты');
    assertEqual(formatSize(4196020), '4.0 МБ', 'мегабайты (shareware DOOM1.WAD)');
    assertEqual(formatSize(undefined), '0 Б', 'мусор не роняет подпись');
});

report('dos iwad');
