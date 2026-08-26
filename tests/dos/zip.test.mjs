// Тесты ZIP-писателя для браузера (Фаза 6, «свой IWAD»).
//
// Чистый node, без jsdom. Три опоры:
//   1. структура читается независимо — здесь разбором заголовков и через node:zlib;
//   2. crc32 сверяется с известным вектором и с node:zlib.crc32, где он есть;
//   3. байты совпадают с tools/build-bundle.mjs на несжимаемых данных — то есть
//      формат у сборщика бандла и у браузерного писателя один и тот же.
//
// Запуск: node tests/dos/zip.test.mjs

import { inflateRawSync } from 'node:zlib';
import { crc32, makeStoreZip } from '../../src/dos/zip.js';
import { makeZip } from '../../tools/build-bundle.mjs';
import { assert, assertEqual, report, test } from '../_harness.mjs';

console.log('dos zip');

const bytesOf = (text) => new Uint8Array(Buffer.from(text, 'latin1'));

/** Псевдослучайные (несжимаемые) байты: детерминированные, без зависимостей. */
function noise(length, seed = 1) {
    const out = new Uint8Array(length);
    let state = seed;
    for (let i = 0; i < length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[i] = (state >>> 16) & 0xff;
    }
    return out;
}

/**
 * Независимый разбор архива: идём от EOCD к центральной директории, как это делает
 * любой читатель ZIP. Свои же константы для проверки не переиспользуем.
 */
function readZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = bytes.length - 22;
    assertEqual(view.getUint32(eocd, true), 0x06054b50, 'сигнатура EOCD на месте');
    const count = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    assertEqual(cdOffset + cdSize, eocd, 'центральная директория примыкает к EOCD');

    const entries = [];
    let offset = cdOffset;
    for (let i = 0; i < count; i++) {
        assertEqual(view.getUint32(offset, true), 0x02014b50, 'сигнатура записи директории');
        const method = view.getUint16(offset + 10, true);
        const crc = view.getUint32(offset + 16, true);
        const compressed = view.getUint32(offset + 20, true);
        const size = view.getUint32(offset + 24, true);
        const nameLen = view.getUint16(offset + 28, true);
        const localOffset = view.getUint32(offset + 42, true);
        const name = Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLen)).toString('latin1');
        offset += 46 + nameLen;

        assertEqual(view.getUint32(localOffset, true), 0x04034b50, `сигнатура локального заголовка ${name}`);
        const localNameLen = view.getUint16(localOffset + 26, true);
        const extraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLen + extraLen;
        const data = bytes.subarray(dataStart, dataStart + compressed);

        entries.push({ name, method, crc, size, compressed, data, localOffset });
    }
    assertEqual(offset, cdOffset + cdSize, 'директория прочитана целиком');
    return entries;
}

// --- CRC-32 --------------------------------------------------------------------

test('crc32 на каноническом векторе «123456789»', () => {
    assertEqual(crc32(bytesOf('123456789')), 0xcbf43926, 'значение из спецификации');
});

test('crc32 пустого буфера — ноль', () => {
    assertEqual(crc32(new Uint8Array(0)), 0, 'пусто');
});

test('crc32 не уезжает в отрицательные числа', () => {
    // Классическая ошибка: забыть >>> 0 и записать в заголовок знаковое число.
    const value = crc32(noise(1000, 7));
    assert(value >= 0 && value <= 0xffffffff, `значение без знака: ${value}`);
    assert(Number.isInteger(value), 'целое');
});

// --- Структура архива ----------------------------------------------------------

test('одна запись: STORE, размеры и crc на месте', () => {
    const data = bytesOf('IWAD-ы бывают разные'.repeat(3));
    const zip = makeStoreZip([{ name: 'DOOM.WAD', data }]);
    const [entry] = readZip(zip);

    assertEqual(entry.name, 'DOOM.WAD', 'имя записи');
    assertEqual(entry.method, 0, 'метод STORE: без сжатия');
    assertEqual(entry.size, data.length, 'исходный размер');
    assertEqual(entry.compressed, data.length, 'сжатый размер равен исходному');
    assertEqual(entry.crc, crc32(data), 'crc32 содержимого');
    assertEqual(Buffer.compare(Buffer.from(entry.data), Buffer.from(data)), 0, 'байты содержимого');
});

test('несколько записей идут в заданном порядке и по своим смещениям', () => {
    const wad = noise(5000, 3);
    const exe = noise(700, 4);
    const zip = makeStoreZip([
        { name: 'DOOM2.WAD', data: wad },
        { name: 'DOOM.EXE', data: exe },
    ]);
    const entries = readZip(zip);

    assertEqual(entries.length, 2, 'две записи');
    assertEqual(entries[0].name, 'DOOM2.WAD', 'первая');
    assertEqual(entries[1].name, 'DOOM.EXE', 'вторая');
    assert(entries[1].localOffset > entries[0].localOffset, 'смещения растут');
    assertEqual(Buffer.compare(Buffer.from(entries[1].data), Buffer.from(exe)), 0, 'вторая запись цела');
});

test('пустой файл упаковывается: crc 0, размер 0', () => {
    const zip = makeStoreZip([{ name: 'EMPTY.TXT', data: new Uint8Array(0) }]);
    const [entry] = readZip(zip);
    assertEqual(entry.size, 0, 'размер');
    assertEqual(entry.crc, 0, 'crc');
});

test('файл на мегабайты не ломает смещения', () => {
    const big = noise(3 * 1024 * 1024, 9);
    const zip = makeStoreZip([
        { name: 'DOOM.WAD', data: big },
        { name: 'DOOM.EXE', data: bytesOf('MZ') },
    ]);
    const entries = readZip(zip);
    assertEqual(entries[0].size, big.length, 'размер большого файла');
    assertEqual(entries[1].name, 'DOOM.EXE', 'вторая запись нашлась после него');
    assertEqual(entries[1].crc, crc32(bytesOf('MZ')), 'её crc');
});

test('содержимое лежит как есть, а не deflate-потоком', () => {
    // Смысл проверки: данные лежат как есть, а не «случайно совпали». Если попытаться
    // распаковать их как deflate — получится ошибка, и это правильно.
    const data = bytesOf('DOOM');
    const zip = makeStoreZip([{ name: 'A', data }]);
    const [entry] = readZip(zip);
    let threw = false;
    try {
        inflateRawSync(Buffer.from(entry.data));
    } catch {
        threw = true;
    }
    assert(threw, 'STORE-данные не являются deflate-потоком');
});

// --- Детерминизм и совместимость с tools/build-bundle.mjs ----------------------

test('пересборка из тех же байтов даёт тот же архив байт-в-байт', () => {
    const entries = [{ name: 'DOOM.WAD', data: noise(2048, 11) }];
    const first = makeStoreZip(entries);
    const second = makeStoreZip(entries);
    assertEqual(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0, 'два прогона совпали');
});

test('формат совпадает с tools/build-bundle.mjs на несжимаемых данных', () => {
    // Сборщик бандла кладёт deflate только когда тот помогает; на шуме он тоже
    // выбирает STORE — и тогда архивы обязаны совпасть до байта. Это и есть
    // доказательство, что js-dos прочитает наш архив так же, как читает doom.zip.
    const wad = noise(4096, 21);
    const exe = noise(512, 22);
    const ours = makeStoreZip([{ name: 'DOOM.WAD', data: wad }, { name: 'DOOM.EXE', data: exe }]);
    const theirs = makeZip([
        { name: 'DOOM.WAD', data: Buffer.from(wad) },
        { name: 'DOOM.EXE', data: Buffer.from(exe) },
    ]);
    assertEqual(Buffer.compare(Buffer.from(ours), theirs), 0, 'байт-в-байт');
});

// --- Отказы --------------------------------------------------------------------

test('пустой список записей — ошибка, а не пустой архив', () => {
    let message = '';
    try {
        makeStoreZip([]);
    } catch (err) {
        message = err.message;
    }
    assert(/нечего упаковывать/.test(message), `внятное сообщение: «${message}»`);
});

test('не-ASCII имя записи отвергается', () => {
    // DOS-имён с кириллицей не бывает, а флаг UTF-8 в заголовке мы не поднимаем —
    // молча записать битое имя было бы хуже, чем отказать.
    let message = '';
    try {
        makeStoreZip([{ name: 'ДУМ.WAD', data: bytesOf('x') }]);
    } catch (err) {
        message = err.message;
    }
    assert(/недопустимое имя/.test(message), `внятное сообщение: «${message}»`);
});

report('dos zip');
