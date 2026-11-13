// MD5 над Uint8Array («свой IWAD с проверкой MD5»).
//
// Почему своя реализация, а не SubtleCrypto: `crypto.subtle.digest` умеет только
// SHA-1/SHA-256/SHA-384/SHA-512 — MD5 из веб-крипто выкинут намеренно, как
// небезопасный. Нам он нужен не для безопасности, а для опознания файла: все
// таблицы хешей IWAD в мире (DoomWiki, порты, idgames) ведутся именно в MD5, и
// поменять алгоритм в одностороннем порядке значит потерять возможность сверяться
// с ними. Внешних зависимостей у расширения нет (правило проекта), поэтому —
// сорок строк своего кода.
//
// Модуль чистый: ни DOM, ни IndexedDB, ни таверны. Гоняется под node без jsdom.

/** Сдвиги по раундам, таблица из RFC 1321. */
const SHIFTS = new Uint8Array([
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

/** K[i] = floor(|sin(i+1)| * 2^32). Считаем, а не выписываем: короче и не опечатаешься. */
const K = (() => {
    const table = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
        table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    }
    return table;
})();

const HEX = (() => {
    const table = new Array(256);
    for (let i = 0; i < 256; i++) table[i] = i.toString(16).padStart(2, '0');
    return table;
})();

/**
 * MD5 буфера.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {string} 32 шестнадцатеричных символа в нижнем регистре
 */
export function md5(input) {
    const bytes = toBytes(input);
    const length = bytes.length;

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    const block = new Uint32Array(16);

    // Полные 64-байтовые блоки читаем прямо из входного буфера — копий не делаем,
    // иначе 20-мегабайтный WAD удвоился бы в памяти на ровном месте.
    const fullBlocks = Math.floor(length / 64);
    for (let i = 0; i < fullBlocks; i++) {
        loadBlock(bytes, i * 64, block);
        [a0, b0, c0, d0] = mix(a0, b0, c0, d0, block);
    }

    // Хвост: остаток + байт 0x80 + длина в битах (64 бита LE). Если остаток длиннее
    // 55 байт, длина не помещается — тогда хвостовых блоков два.
    const rest = length - fullBlocks * 64;
    const tail = new Uint8Array(rest <= 55 ? 64 : 128);
    tail.set(bytes.subarray(fullBlocks * 64), 0);
    tail[rest] = 0x80;

    // Умножение на 8 держим в double, а не в 32-битном сдвиге: `length << 3`
    // переполняется уже на 512 МБ и молча даёт неверный хеш.
    const bits = length * 8;
    const low = bits % 4294967296;
    const high = Math.floor(bits / 4294967296);
    writeUint32Le(tail, tail.length - 8, low >>> 0);
    writeUint32Le(tail, tail.length - 4, high >>> 0);

    for (let offset = 0; offset < tail.length; offset += 64) {
        loadBlock(tail, offset, block);
        [a0, b0, c0, d0] = mix(a0, b0, c0, d0, block);
    }

    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/** Один проход из 64 операций над блоком. Возвращает новые A/B/C/D. */
function mix(a0, b0, c0, d0, m) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
        let f;
        let g;
        if (i < 16) {
            f = (b & c) | (~b & d);
            g = i;
        } else if (i < 32) {
            f = (d & b) | (~d & c);
            g = (5 * i + 1) & 15;
        } else if (i < 48) {
            f = b ^ c ^ d;
            g = (3 * i + 5) & 15;
        } else {
            f = c ^ (b | ~d);
            g = (7 * i) & 15;
        }

        // Складываем через |0: иначе сумма уезжает за 2^32 и теряет младшие биты.
        f = (f + a + K[i] + m[g]) | 0;
        a = d;
        d = c;
        c = b;
        const s = SHIFTS[i];
        b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }

    return [(a0 + a) | 0, (b0 + b) | 0, (c0 + c) | 0, (d0 + d) | 0];
}

function loadBlock(src, offset, out) {
    for (let j = 0; j < 16; j++) {
        const o = offset + j * 4;
        out[j] = (src[o] | (src[o + 1] << 8) | (src[o + 2] << 16) | (src[o + 3] << 24)) >>> 0;
    }
}

function writeUint32Le(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
}

/** Слово A/B/C/D в hex: MD5 выводится little-endian побайтно, а не как число. */
function hex(word) {
    return HEX[word & 0xff]
        + HEX[(word >>> 8) & 0xff]
        + HEX[(word >>> 16) & 0xff]
        + HEX[(word >>> 24) & 0xff];
}

function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new TypeError('md5: ожидался Uint8Array или ArrayBuffer');
}
