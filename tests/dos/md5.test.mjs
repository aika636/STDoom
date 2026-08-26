// Тесты MD5 (Фаза 6, «свой IWAD с проверкой MD5»).
//
// Чистый node, без jsdom: модуль не знает ни про DOM, ни про таверну.
// Эталон — node:crypto. Он же делает проверку честной: наш код сверяется не сам с
// собой, а с независимой реализацией на всех длинах вокруг границ блоков.
//
// Запуск: node tests/dos/md5.test.mjs

import { createHash } from 'node:crypto';
import { md5 } from '../../src/dos/md5.js';
import { assert, assertEqual, report, test } from '../_harness.mjs';

console.log('dos md5');

const bytesOf = (text) => new Uint8Array(Buffer.from(text, 'utf8'));
const reference = (bytes) => createHash('md5').update(Buffer.from(bytes)).digest('hex');

// --- Канонические векторы RFC 1321 --------------------------------------------

test('векторы RFC 1321', () => {
    const vectors = [
        ['', 'd41d8cd98f00b204e9800998ecf8427e'],
        ['a', '0cc175b9c0f1b6a831c399e269772661'],
        ['abc', '900150983cd24fb0d6963f7d28e17f72'],
        ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
        ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
        [
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
            'd174ab98d277d9f5a5611c2c9f419d9f',
        ],
        [
            '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
            '57edf4a22be3c955ac49da2e2107b67a',
        ],
    ];
    for (const [input, expected] of vectors) {
        assertEqual(md5(bytesOf(input)), expected, `md5("${input.slice(0, 20)}…")`);
    }
});

test('результат — 32 символа в нижнем регистре', () => {
    const digest = md5(bytesOf('abc'));
    assertEqual(digest.length, 32, 'длина');
    assert(/^[0-9a-f]{32}$/.test(digest), `формат: ${digest}`);
});

// --- Границы блоков ------------------------------------------------------------
//
// Самое хрупкое место реализации — набивка хвоста: при остатке 56…63 байт длина
// сообщения не помещается в тот же блок, и хвостовых блоков должно стать два.

test('длины 0…200 совпадают с node:crypto (границы 55/56/63/64/119/120 внутри)', () => {
    for (let length = 0; length <= 200; length++) {
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) & 0xff;
        assertEqual(md5(bytes), reference(bytes), `длина ${length}`);
    }
});

test('все 256 значений байта переживают хеширование', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    assertEqual(md5(bytes), reference(bytes), 'полный алфавит байтов');
});

// --- Большие буферы ------------------------------------------------------------

test('буфер размером с настоящий IWAD (≈14 МБ) считается верно', () => {
    // Размер выбран по DOOM2.WAD — самому толстому ванильному IWAD.
    const bytes = new Uint8Array(14_604_584);
    let seed = 12345;
    for (let i = 0; i < bytes.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        bytes[i] = seed & 0xff;
    }
    const started = Date.now();
    assertEqual(md5(bytes), reference(bytes), 'хеш совпал с node:crypto');
    // Не бенчмарк, а страховка от квадратичной реализации: если 14 МБ считаются
    // дольше десяти секунд, загрузка WAD в браузере повесит вкладку.
    assert(Date.now() - started < 10000, 'уложились в десять секунд');
});

test('одинокий нулевой байт и мегабайт нулей', () => {
    assertEqual(md5(new Uint8Array(1)), reference(new Uint8Array(1)), 'один нулевой байт');
    const zeros = new Uint8Array(1024 * 1024);
    assertEqual(md5(zeros), reference(zeros), 'мегабайт нулей');
});

// --- Формы входа ---------------------------------------------------------------

test('принимаются ArrayBuffer и подмассив (byteOffset не игнорируется)', () => {
    const source = new Uint8Array([9, 9, 9, ...bytesOf('abc'), 9]);
    const view = source.subarray(3, 6);
    assertEqual(md5(view), '900150983cd24fb0d6963f7d28e17f72', 'подмассив «abc»');

    const buffer = bytesOf('abc').buffer;
    assertEqual(md5(buffer), '900150983cd24fb0d6963f7d28e17f72', 'ArrayBuffer «abc»');
});

test('мусор на входе — внятная ошибка, а не тихий неверный хеш', () => {
    let message = '';
    try {
        md5('abc');
    } catch (err) {
        message = err.message;
    }
    assert(/Uint8Array/.test(message), `сообщение про тип, получено «${message}»`);
});

report('dos md5');
