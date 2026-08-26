#!/usr/bin/env node
// Офлайн-сборка `assets/doom/doom.zip` — бандла, который отдаётся js-dos как InitFs.
//
// Почему свой ZIP-писатель, а не архиватор из системы:
//   * нулевые внешние зависимости (правило проекта — no build step, no deps);
//   * детерминизм — фиксированные mtime и порядок записей, поэтому пересборка
//     даёт байт-в-байт тот же файл, и его хеш можно держать в документации.
//
// Что НЕ кладём в архив: `dosbox.conf`. Он передаётся отдельной строкой
// при запуске — файл `.jsdos/dosbox.conf` внутри zip перезаписал бы её.
//
// Запуск: node tools/build-bundle.mjs
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOOM_DIR = join(ROOT, 'assets', 'doom');
const OUT = join(DOOM_DIR, 'doom.zip');

/** Исходники бандла. MD5/размер зафиксированы в assets/README.md; расхождение = чужой файл. */
export const SOURCES = [
    {
        name: 'DOOM.EXE',
        size: 709905,
        md5: 'e2382b7dc47ae2433d26b6e6bc312999',
        note: 'shareware 1.9, байт-в-байт из дистрибутива id Software',
    },
    {
        name: 'DOOM1.WAD',
        size: 4196020,
        md5: 'f0cefca49926d00903cf57551d901abe',
        note: 'shareware 1.9, НЕ модифицировать и НЕ пережимать',
    },
    {
        name: 'DEFAULT.CFG',
        size: null, // наш файл, содержимое может меняться — хеш не фиксируем
        md5: null,
        note: 'наш стартовый конфиг, генератор в src/dos/config.js',
    },
];

/**
 * Фиксированная метка времени для всех записей архива: 1995-02-01 00:00:00.
 * Дата дистрибутива DOOM 1.9. Значение важно только тем, что оно константа.
 */
const DOS_DATE = ((1995 - 1980) << 9) | (2 << 5) | 1;
const DOS_TIME = 0;

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Собирает обычный ZIP (deflate, без zip64, без записей-каталогов).
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
export function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'latin1');
        const crc = crc32(data);
        const deflated = deflateRawSync(data, { level: 9 });
        // Если сжатие не помогло (бывает на уже сжатых данных) — кладём как есть.
        const useStore = deflated.length >= data.length;
        const payload = useStore ? data : deflated;
        const method = useStore ? 0 : 8;

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28); // extra len
        nameBuf.copy(local, 30);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(0x0014, 4); // version made by: 2.0, MS-DOS
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(0, 38); // external attrs
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);

        locals.push(local, payload);
        centrals.push(central);
        offset += local.length + payload.length;
    }

    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, cd, eocd]);
}

function fail(msg) {
    console.error(`[build-bundle] ОШИБКА: ${msg}`);
    process.exit(1);
}

function main() {
    const entries = [];

    for (const src of SOURCES) {
        const path = join(DOOM_DIR, src.name);
        let data;
        try {
            data = readFileSync(path);
        } catch {
            fail(
                `нет файла ${path}\n` +
                    `  Ассеты в репозиторий кладутся вручную, см. assets/README.md (${src.note}).`
            );
        }
        if (src.size !== null && data.length !== src.size) {
            fail(
                `${src.name}: размер ${data.length} B, ожидался ${src.size} B.\n` +
                    `  Это другой файл/версия. Подменять его нельзя — ${src.note}.`
            );
        }
        if (src.md5 !== null) {
            const actual = md5(data);
            if (actual !== src.md5) {
                fail(
                    `${src.name}: MD5 ${actual}, ожидался ${src.md5}.\n` +
                        `  Файл модифицирован или взят из другой версии. ${src.note}.`
                );
            }
        }
        entries.push({ name: src.name, data });
    }

    const zip = makeZip(entries);
    writeFileSync(OUT, zip);

    console.log('[build-bundle] содержимое бандла:');
    for (const e of entries) {
        console.log(`  ${e.name.padEnd(12)} ${String(e.data.length).padStart(8)} B  md5 ${md5(e.data)}`);
    }
    console.log('[build-bundle] dosbox.conf в архив НЕ кладётся, он передаётся строкой');
    console.log(`[build-bundle] записан ${OUT}`);
    console.log(`  размер  ${statSync(OUT).size} B`);
    console.log(`  md5     ${md5(zip)}`);
    console.log(`  sha256  ${sha256(zip)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    main();
}
