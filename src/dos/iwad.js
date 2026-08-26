// Распознавание пользовательских файлов игры: IWAD и (по желанию) свой DOOM.EXE.
// Фаза 6 плана, §1.2 (коммерческих IWAD в репозитории нет и не будет), §5.3.
//
// ⚠ Ключевой факт из §5.3: флага `-iwad` в ванильном DOOM НЕТ, это выдумка портов.
// `DOOM.EXE` сам ищет в текущем каталоге `doom2.wad`, затем `doom.wad`, затем
// `doom1.wad` и по найденному определяет режим игры. Значит, единственный способ
// подсунуть свой IWAD — положить его файлом под ПРАВИЛЬНЫМ ИМЕНЕМ. Отсюда вся эта
// возня с разбором директории лампов: имя файла выводится из содержимого WAD, а не
// из того, как файл назывался у игрока (он мог назвать его `мой досс.wad`).
//
// MD5 здесь — ИНФОРМАЦИОННЫЙ. Совпадение с таблицей даёт человеческое название
// версии; несовпадение — предупреждение, но НЕ отказ. Легальных вариантов IWAD
// больше, чем в любой таблице: разные языковые издания, разные сборники, патчи
// 1.666/1.8/1.9, BFG Edition, переупакованные GOG- и Steam-версии. Отказывать по
// хешу значило бы не пустить в игру человека с честно купленным диском.
//
// ⚠ Про хеши в KNOWN_IWADS: они взяты из открытых списков (DoomWiki и таблицы
// портов) и на живых файлах ЗДЕСЬ НЕ ПРОВЕРЯЛИСЬ — коммерческих IWAD в репозитории
// нет (§1.2), проверить их нечем. Единственный сверенный по-настоящему — shareware
// `DOOM1.WAD` 1.9, он же зафиксирован в tools/build-bundle.mjs. Ошибка в остальных
// строках даст неверную подпись версии в интерфейсе и ничего больше: запуск от неё
// не зависит.

import { md5 } from './md5.js';

/** Потолок размера: самый толстый ванильный IWAD — DOOM2.WAD (~14 МБ). */
export const MAX_IWAD_SIZE = 64 * 1024 * 1024;

/** Потолок для DOOM.EXE: ванильный — 715 КБ вместе с зашитым DOS/4GW. */
export const MAX_EXE_SIZE = 8 * 1024 * 1024;

/** Имена, под которыми DOOM.EXE ищет IWAD, в порядке своего поиска (§5.3). */
export const DOS_NAMES = Object.freeze({
    doom2: 'DOOM2.WAD',
    ultimate: 'DOOM.WAD',
    registered: 'DOOM.WAD',
    shareware: 'DOOM1.WAD',
});

const KIND_TITLE = Object.freeze({
    doom2: 'Doom II / Final Doom (карты MAP01…)',
    ultimate: 'Ultimate Doom (четыре эпизода)',
    registered: 'Doom registered (три эпизода)',
    shareware: 'Doom shareware (эпизод 1)',
});

/**
 * Известные IWAD. Источник — открытые списки; по живому файлу сверен только
 * shareware из комплекта (см. шапку модуля), остальные взяты как есть.
 */
export const KNOWN_IWADS = Object.freeze([
    // Единственный проверенный: лежит в репозитории, хеш совпадает с build-bundle.mjs.
    { md5: 'f0cefca49926d00903cf57551d901abe', name: 'Doom shareware 1.9', verified: true },
    { md5: '981b03e6d1dc033301aa3095acc437ce', name: 'Doom shareware 1.666' },
    { md5: '90facab21eede7981be10790e3f82da2', name: 'Doom shareware 1.2' },
    { md5: '54978d12de87f162b9bcc011676cb3c0', name: 'Doom registered 1.666' },
    { md5: '11e1cd216801ea2657723abc86ecb01f', name: 'Doom registered 1.8' },
    { md5: '1cd63c5ddff1bf8ce844237f580e9cf8', name: 'Doom registered 1.9' },
    { md5: 'c4fe9fd920207691a9f493668e0a2083', name: 'Ultimate Doom 1.9' },
    { md5: 'fb35c4a5a9fd49ec29ab6e900572c524', name: 'Doom BFG Edition' },
    { md5: '30e3c2d0350b67bfbf47271970b74b2f', name: 'Doom II 1.666' },
    { md5: 'c236745bb01d89bbb866c8fed81b6f8c', name: 'Doom II 1.8' },
    { md5: '25e1459ca71d7730acd36a18e5be1904', name: 'Doom II 1.9' },
    { md5: 'c3bea40570c23e511a7ed3ebcd9865f7', name: 'Doom II BFG Edition' },
    { md5: '3cb02349b3df649c86290907eed64e7b', name: 'Doom II 1.9, французское издание' },
    { md5: '75c8cf89566741fa9d22447604053bd7', name: 'Final Doom: The Plutonia Experiment 1.9' },
    { md5: '4e158d9953c79ccf97bd0663244cc6b6', name: 'Final Doom: TNT Evilution 1.9' },
]);

/** Известные DOOM.EXE. Проверен только shareware — он лежит в репозитории. */
export const KNOWN_EXES = Object.freeze([
    { md5: 'e2382b7dc47ae2433d26b6e6bc312999', name: 'DOOM.EXE shareware 1.9', verified: true },
]);

/**
 * Разбирает WAD и решает, под каким именем его класть.
 *
 * @param {Uint8Array} bytes содержимое файла
 * @param {string} [fileName] исходное имя — только для сообщений
 * @returns {{
 *   ok: boolean, error?: string,
 *   magic?: string, size?: number, md5?: string, lumpCount?: number,
 *   kind?: string, dosName?: string, title?: string,
 *   episodes?: number[], mapCount?: number,
 *   versionName?: string|null, known?: boolean, warning?: string|null,
 * }}
 */
export function inspectIwad(bytes, fileName = '') {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? 0);

    if (data.length === 0) return fail('файл пустой');
    if (data.length > MAX_IWAD_SIZE) {
        return fail(`файл слишком большой (${formatSize(data.length)}), потолок — `
            + `${formatSize(MAX_IWAD_SIZE)}`);
    }
    if (data.length < 12) return fail('файл слишком мал: в нём нет даже заголовка WAD');

    const magic = ascii(data, 0, 4);
    if (magic === 'PWAD') {
        return fail('это PWAD — набор дополнительных карт, а не полноценная игра. '
            + 'Нужен IWAD: DOOM.WAD, DOOM2.WAD или DOOM1.WAD');
    }
    if (magic !== 'IWAD') {
        return fail(`это не WAD: в начале файла «${printable(magic)}» вместо «IWAD»`
            + (/\.zip$/i.test(fileName) ? '. Архив надо сначала распаковать' : ''));
    }

    const lumpCount = readInt32(data, 4);
    const dirOffset = readInt32(data, 8);

    if (lumpCount <= 0) return fail('в заголовке WAD указано ноль лампов — файл битый');
    if (dirOffset < 12) return fail('в заголовке WAD битое смещение директории лампов');
    // 16 байт на запись директории: смещение, размер, имя из восьми символов.
    const dirEnd = dirOffset + lumpCount * 16;
    if (dirEnd > data.length) {
        return fail('файл обрезан: директория лампов уходит за конец файла '
            + `(нужно ${dirEnd} байт, есть ${data.length})`);
    }

    const episodes = new Set();
    let mapCount = 0;
    let doom2Maps = false;
    for (let i = 0; i < lumpCount; i++) {
        const name = lumpName(data, dirOffset + i * 16 + 8);
        if (/^MAP\d\d$/.test(name)) {
            doom2Maps = true;
            mapCount++;
            continue;
        }
        const doom1 = /^E(\d)M(\d)$/.exec(name);
        if (doom1) {
            episodes.add(Number(doom1[1]));
            mapCount++;
        }
    }

    // Карты MAP01… перевешивают: так устроены Doom II, TNT и Plutonia, и все они
    // ищутся движком под именем DOOM2.WAD.
    let kind;
    if (doom2Maps) kind = 'doom2';
    else if (episodes.size === 0) {
        return fail('в WAD нет ни одной карты (ни MAP01…, ни E1M1…) — '
            + 'это не IWAD, а вспомогательный набор ресурсов');
    } else if (episodes.has(4)) kind = 'ultimate';
    else if (episodes.has(2) || episodes.has(3)) kind = 'registered';
    else kind = 'shareware';

    const digest = md5(data);
    const known = KNOWN_IWADS.find((entry) => entry.md5 === digest) ?? null;

    return {
        ok: true,
        magic,
        size: data.length,
        md5: digest,
        lumpCount,
        kind,
        dosName: DOS_NAMES[kind],
        title: KIND_TITLE[kind],
        episodes: [...episodes].sort((a, b) => a - b),
        mapCount,
        versionName: known?.name ?? null,
        known: Boolean(known),
        warning: known
            ? null
            : 'MD5 не совпал ни с одной известной версией. Это не запрет: у разных '
              + 'изданий (BFG, GOG, языковые версии, патчи) хеши свои. Если игра '
              + 'запустится — всё в порядке.',
    };
}

/**
 * Проверяет пользовательский DOOM.EXE. Проверка нарочно поверхностная: наша задача —
 * не пустить внутрь заведомо не то (архив, WAD, картинку), а не аттестовать движок.
 *
 * @param {Uint8Array} bytes
 * @returns {{ok: boolean, error?: string, size?: number, md5?: string,
 *            versionName?: string|null, known?: boolean, warning?: string|null}}
 */
export function inspectExe(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? 0);

    if (data.length === 0) return fail('файл пустой');
    if (data.length > MAX_EXE_SIZE) {
        return fail(`файл слишком большой (${formatSize(data.length)}) для DOS-программы`);
    }
    // 'MZ' — сигнатура любого DOS-исполняемого файла. Всё, что можно проверить, не
    // разбирая DOS/4GW-стаб внутри.
    if (data[0] !== 0x4d || data[1] !== 0x5a) {
        return fail(ascii(data, 0, 4) === 'IWAD' || ascii(data, 0, 4) === 'PWAD'
            ? 'это WAD, а не программа: его место в поле «Свой IWAD»'
            : 'это не DOS-программа: файл не начинается с «MZ»');
    }

    const digest = md5(data);
    const known = KNOWN_EXES.find((entry) => entry.md5 === digest) ?? null;

    return {
        ok: true,
        size: data.length,
        md5: digest,
        versionName: known?.name ?? null,
        known: Boolean(known),
        warning: known
            ? null
            : 'MD5 не совпал с известным DOOM.EXE. Проверить, что это рабочий движок, '
              + 'можно только запуском.',
    };
}

/** Человеческий размер файла — для подписей в интерфейсе. */
export function formatSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} Б`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
    return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

// --- Мелочи разбора ------------------------------------------------------------

/** Имя лампа: восемь байт ASCII, добитых нулями. Регистр приводим к верхнему. */
function lumpName(data, offset) {
    let name = '';
    for (let i = 0; i < 8; i++) {
        const code = data[offset + i];
        if (code === 0) break;
        name += String.fromCharCode(code);
    }
    return name.toUpperCase();
}

function ascii(data, offset, length) {
    let text = '';
    for (let i = 0; i < length && offset + i < data.length; i++) {
        text += String.fromCharCode(data[offset + i]);
    }
    return text;
}

function printable(text) {
    return text.replace(/[^\x20-\x7e]/g, '·');
}

function readInt32(data, offset) {
    return (data[offset]
        | (data[offset + 1] << 8)
        | (data[offset + 2] << 16)
        | (data[offset + 3] << 24));
}

function fail(error) {
    return { ok: false, error };
}
