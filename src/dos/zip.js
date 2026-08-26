// Минимальный ZIP-писатель для браузера (Фаза 6, «свой IWAD»).
//
// Зачем он вообще: элементом `InitFs` js-dos принимает ZIP, а не отдельный файл.
// Чтобы подложить пользовательский WAD в /home/web_user, его надо завернуть в архив
// прямо в браузере.
//
// Почему только STORE (метод 0, без сжатия):
//   * `CompressionStream('deflate-raw')` есть не везде и работает потоково-асинхронно,
//     а тащить свой deflate ради этого — сотни строк;
//   * IWAD и так почти не жмётся: это упакованные графика и звук. Экономия единицы
//     процентов не стоит ни кода, ни времени распаковки;
//   * распаковка STORE в wasm — это memcpy, то есть самый быстрый вариант старта.
//
// Формат — тот же, что пишет `tools/build-bundle.mjs` (тот кладёт deflate там, где он
// помогает, и STORE там, где нет; читатель у обоих один и тот же). Никакого zip64:
// пользовательские IWAD измеряются мегабайтами, до 4 ГБ там далеко.
//
// Модуль чистый: ни DOM, ни js-dos. Гоняется под node без jsdom.

/**
 * Фиксированная метка времени всех записей: 1995-02-01 00:00:00, дата дистрибутива
 * DOOM 1.9 — та же константа, что в tools/build-bundle.mjs. Важна только тем, что она
 * константа: архив, собранный из тех же байтов, обязан получиться тем же байт-в-байт.
 */
export const DOS_DATE = ((1995 - 1980) << 9) | (2 << 5) | 1;
export const DOS_TIME = 0;

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

/** CRC-32 (полином IEEE 802.3), как того требует формат ZIP. */
export function crc32(bytes) {
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/**
 * Собирает ZIP из записей методом STORE.
 *
 * Имена — только ASCII (нам нужны DOOM.WAD, DOOM2.WAD, DOOM1.WAD, DOOM.EXE): DOS-имена
 * иными и не бывают, а флаг UTF-8 в заголовке пришлось бы поднимать отдельно.
 *
 * @param {{name: string, data: Uint8Array}[]} entries
 * @returns {Uint8Array}
 */
export function makeStoreZip(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('makeStoreZip: нечего упаковывать');
    }

    const prepared = entries.map(({ name, data }) => {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? 0);
        return { nameBytes: asciiBytes(name), data: bytes, crc: crc32(bytes) };
    });

    let localSize = 0;
    let centralSize = 0;
    for (const entry of prepared) {
        localSize += 30 + entry.nameBytes.length + entry.data.length;
        centralSize += 46 + entry.nameBytes.length;
    }

    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);

    let offset = 0;
    const offsets = [];

    for (const { nameBytes, data, crc } of prepared) {
        offsets.push(offset);
        view.setUint32(offset, 0x04034b50, true);
        view.setUint16(offset + 4, 20, true);       // версия для распаковки: 2.0
        view.setUint16(offset + 6, 0, true);        // флаги
        view.setUint16(offset + 8, 0, true);        // метод: 0 = STORE
        view.setUint16(offset + 10, DOS_TIME, true);
        view.setUint16(offset + 12, DOS_DATE, true);
        view.setUint32(offset + 14, crc, true);
        view.setUint32(offset + 18, data.length, true); // сжатый размер = исходному
        view.setUint32(offset + 22, data.length, true);
        view.setUint16(offset + 26, nameBytes.length, true);
        view.setUint16(offset + 28, 0, true);       // extra
        out.set(nameBytes, offset + 30);
        out.set(data, offset + 30 + nameBytes.length);
        offset += 30 + nameBytes.length + data.length;
    }

    const centralStart = offset;

    prepared.forEach(({ nameBytes, data, crc }, index) => {
        view.setUint32(offset, 0x02014b50, true);
        view.setUint16(offset + 4, 0x0014, true);   // version made by: 2.0, MS-DOS
        view.setUint16(offset + 6, 20, true);
        view.setUint16(offset + 8, 0, true);
        view.setUint16(offset + 10, 0, true);       // метод: STORE
        view.setUint16(offset + 12, DOS_TIME, true);
        view.setUint16(offset + 14, DOS_DATE, true);
        view.setUint32(offset + 16, crc, true);
        view.setUint32(offset + 20, data.length, true);
        view.setUint32(offset + 24, data.length, true);
        view.setUint16(offset + 28, nameBytes.length, true);
        view.setUint16(offset + 30, 0, true);       // extra
        view.setUint16(offset + 32, 0, true);       // comment
        view.setUint16(offset + 34, 0, true);       // disk
        view.setUint16(offset + 36, 0, true);       // internal attrs
        view.setUint32(offset + 38, 0, true);       // external attrs
        view.setUint32(offset + 42, offsets[index], true);
        out.set(nameBytes, offset + 46);
        offset += 46 + nameBytes.length;
    });

    view.setUint32(offset, 0x06054b50, true);
    view.setUint16(offset + 4, 0, true);
    view.setUint16(offset + 6, 0, true);
    view.setUint16(offset + 8, prepared.length, true);
    view.setUint16(offset + 10, prepared.length, true);
    view.setUint32(offset + 12, offset - centralStart, true);
    view.setUint32(offset + 16, centralStart, true);
    view.setUint16(offset + 20, 0, true);

    return out;
}

function asciiBytes(name) {
    const text = String(name ?? '');
    if (!text || !/^[\x20-\x7e]+$/.test(text)) {
        throw new Error(`makeStoreZip: недопустимое имя записи «${text}»`);
    }
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0x7f;
    return bytes;
}
