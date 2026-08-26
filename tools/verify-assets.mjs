#!/usr/bin/env node
// Проверка целостности бинарных ассетов: размер + MD5 + SHA-256.
//
// Зачем это отдельно от сборщика: условия распространения shareware требуют,
// чтобы `DOOM1.WAD` и `DOOM.EXE` лежали немодифицированными (plan.md §1.2),
// а wasm-эмулятор — чтобы `wdosbox.wasm` соответствовал `wdosbox.js` из того же
// пакета `emulators@8.4.1`. И то, и другое ломается тихо, поэтому проверяется тестом.
//
// Запуск: node tools/verify-assets.mjs   (exit 0 — всё сошлось, 1 — нет)
// Из тестов: import { verifyAssets, ASSETS } from '../tools/verify-assets.mjs'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ожидаемое состояние ассетов. Источники и лицензии — в assets/README.md.
 * `optional: true` — файл собирается `tools/build-bundle.mjs`, в чистом
 * клоне его может не быть; отсутствие не ошибка, а вот расхождение — ошибка.
 */
export const ASSETS = [
    {
        path: 'assets/jsdos/emulators.js',
        size: 83916,
        md5: 'f9449e21abbf315f1a40251ce206cc45',
        sha256: '5d9ca14da8fe75d2f1abb5a374aee14774fafd9f87c159cbcc411ca80c51c645',
    },
    {
        path: 'assets/jsdos/wdosbox.js',
        size: 111939,
        md5: 'cefeaf1f206a276d7d0ce0468cfd958f',
        sha256: '71397a28a933269e9e3f2e91fd917c0ec05958adf3b2052574fc57eb6b1ee5e1',
    },
    {
        path: 'assets/jsdos/wdosbox.wasm',
        size: 1459705,
        md5: '56089e077329d509f1e18e09378d5013',
        sha256: 'aea62e7ea836424ce912728692d3168df63828b5fabfebc2b18cd1d2b19beda2',
    },
    {
        path: 'assets/jsdos/LICENSE-jsdos.txt',
        size: 18092,
        md5: 'b234ee4d69f5fce4486a80fdaf4a4263',
        sha256: '8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643',
    },
    {
        path: 'assets/doom/DOOM.EXE',
        size: 709905,
        md5: 'e2382b7dc47ae2433d26b6e6bc312999',
        sha256: 'b8020523561a5ad9706e009a52d61c578f37faafd85ac471962308406292ce27',
    },
    {
        path: 'assets/doom/DOOM1.WAD',
        size: 4196020,
        md5: 'f0cefca49926d00903cf57551d901abe',
        sha256: '1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771',
    },
    {
        path: 'assets/doom/LICENSE-id.txt',
        size: 6689,
        md5: '07417cc3ee387db3e846129e6a1b1c2d',
        sha256: '1a23ab70fdc2adb910d07a7350f4f657426539f176fc8e447439acb05cbe7b16',
    },
    {
        path: 'assets/doom/VENDOR-id.txt',
        size: 396,
        md5: '516492c9f5dc97e23217a0514d16517e',
        sha256: 'e190e875e07b4767f403d7475dc4a60a6fbfe1fbb5fce5de0c0d400331200e7e',
    },
    {
        path: 'assets/doom/README-id.TXT',
        size: 21631,
        md5: '3ff8dbf9a2d717162ae2fb585e5728dc',
        sha256: '17878ebe5ca179de7ec2cc90bbabbc922ab69924118be168a25f8d317f65a2ff',
    },
    {
        path: 'assets/doom/DEFAULT.CFG',
        size: 539,
        md5: '0c6780ed1dca05264ffc0e8298612648',
        sha256: 'a10bb533578572f753474978057940d744eb8cec4b8a78bf96638181721ed02f',
    },
    {
        path: 'assets/doom/doom.zip',
        size: 2165756,
        md5: '42328d22ed9d06352f47140e0dc20d42',
        sha256: '719c9391ff9a496772b81e4fd20989a6b82f788a9788bb82b36145510a421931',
        optional: true,
        note: 'собирается `node tools/build-bundle.mjs`, детерминированно',
    },
];

/**
 * @param {string} [root] корень репозитория
 * @returns {{ok: boolean, checked: number, skipped: string[], errors: string[]}}
 */
export function verifyAssets(root = ROOT) {
    const errors = [];
    const skipped = [];
    let checked = 0;

    for (const a of ASSETS) {
        const full = join(root, a.path);
        let data;
        try {
            data = readFileSync(full);
        } catch {
            if (a.optional) {
                skipped.push(a.path);
                continue;
            }
            errors.push(`${a.path}: файла нет`);
            continue;
        }
        checked++;
        if (data.length !== a.size) {
            errors.push(`${a.path}: размер ${data.length} B, ожидался ${a.size} B`);
            continue; // хеши считать бессмысленно, сообщение только запутает
        }
        const actualMd5 = createHash('md5').update(data).digest('hex');
        if (actualMd5 !== a.md5) {
            errors.push(`${a.path}: MD5 ${actualMd5}, ожидался ${a.md5}`);
            continue;
        }
        const actualSha = createHash('sha256').update(data).digest('hex');
        if (actualSha !== a.sha256) {
            errors.push(`${a.path}: SHA-256 ${actualSha}, ожидался ${a.sha256}`);
        }
    }

    return { ok: errors.length === 0, checked, skipped, errors };
}

function main() {
    const r = verifyAssets();
    for (const s of r.skipped) console.log(`[verify-assets] пропущен (нет файла): ${s}`);
    for (const e of r.errors) console.error(`[verify-assets] ${e}`);
    if (r.ok) {
        console.log(`[verify-assets] OK: ${r.checked} файл(ов) совпали по размеру, MD5 и SHA-256`);
    } else {
        console.error('[verify-assets] ПРОВАЛ: ассеты не совпадают с зафиксированными в assets/README.md');
    }
    process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    main();
}
