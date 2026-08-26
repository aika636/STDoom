// Обвязка e2e: поднимает отдельный SillyTavern, цепляет к нему рабочее дерево
// расширения и даёт хелперы поверх Playwright.
//
// Зачем отдельный инстанс: тесты чистят настройки и жмут на всё подряд, а личная
// таверна разработчика — не полигон. Данные лежат в системном temp (не в репозитории:
// каталог расширения — симлинк на корень репозитория, и data-root внутри него дал бы
// рекурсию при обходе каталогов).
//
// Путь к SillyTavern берётся из переменной окружения STDOOM_ST_DIR — в репозиторий
// локальные пути не попадают.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, lstatSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from '../_harness.mjs';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const ARTIFACTS = fileURLToPath(new URL('./.artifacts', import.meta.url));

const DEFAULT_PORT = 8123;
const READY_LINE = /SillyTavern is listening/;
const START_TIMEOUT_MS = 180_000; // первый запуск на пустом data-root собирает фронтенд

// --- SillyTavern

function resolveTavernDir() {
    const dir = process.env.STDOOM_ST_DIR;
    if (!dir) {
        throw new Error(
            'не задана переменная окружения STDOOM_ST_DIR — укажите каталог установленного SillyTavern\n'
            + 'например: STDOOM_ST_DIR=/c/SillyTavern node tests/e2e/run.mjs',
        );
    }
    if (!existsSync(join(dir, 'server.js'))) {
        throw new Error(`в STDOOM_ST_DIR (${dir}) нет server.js — это не каталог SillyTavern`);
    }
    return dir;
}

// Каталог расширения внутри data-root — ссылка на репозиторий, а не копия: тесты
// обязаны гонять ровно тот код, что сейчас в рабочем дереве, без промежуточного деплоя.
function linkExtension(dataRoot) {
    const dir = join(dataRoot, 'default-user', 'extensions');
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'STDoom');
    let existing = null;
    try {
        existing = lstatSync(link);
    } catch { /* ссылки ещё нет */ }
    if (existing) {
        if (existing.isSymbolicLink()) return link;
        // Обычный каталог на этом месте — чей-то старый деплой; сносим, иначе тесты
        // молча проверяли бы вчерашнюю копию.
        rmSync(link, { recursive: true, force: true });
    }
    // junction на Windows не требует прав администратора, в отличие от symlink.
    symlinkSync(REPO, link, process.platform === 'win32' ? 'junction' : 'dir');
    return link;
}

// Каталог public/scripts/extensions/third-party грузится таверной независимо от
// data-root, поэтому лежащая там копия STDoom перебивает junction, который прогон
// делает во временный data-root, — и тесты молча проверяют вчерашний код (грабли,
// стоившие целого дня проверок впустую). Падаем внятно.
function assertNoRivalCopies(stDir) {
    const dir = join(stDir, 'public', 'scripts', 'extensions', 'third-party');
    if (!existsSync(dir)) return;
    const rivals = readdirSync(dir).filter((name) => /^STDoom/i.test(name));
    if (rivals.length === 0) return;
    throw new Error(
        `в таверне лежит своя копия расширения: ${rivals.map((n) => `third-party/${n}`).join(', ')}\n`
        + 'Этот каталог грузится мимо data-root и перебивает ссылку на рабочее дерево — '
        + 'прогон проверял бы не тот код.\n'
        + 'Уберите или временно переименуйте эти каталоги и запустите прогон снова.',
    );
}

/**
 * Запускает изолированный SillyTavern и ждёт готовности.
 * @param {{ port?: number, fresh?: boolean, dataRoot?: string }} options
 * @returns {Promise<{ url: string, dataRoot: string, stop: () => void }>}
 */
export async function startTavern({ port = DEFAULT_PORT, fresh = false, dataRoot } = {}) {
    const stDir = resolveTavernDir();
    assertNoRivalCopies(stDir);
    const root = dataRoot ?? join(tmpdir(), 'stdoom-e2e', 'data');

    // По умолчанию data-root переживает прогоны: на нём кэш сборки фронтенда, и
    // повторный старт занимает секунды вместо полуминуты. Состояние расширения
    // тесты обнуляют сами (resetSettings), так что накопленный мусор им не мешает.
    if (fresh) rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    linkExtension(root);

    const child = spawn(process.execPath, [
        'server.js',
        '--port', String(port),
        '--dataRoot', root,
        '--listen', 'false',
        '--browserLaunchEnabled', 'false',
    ], { cwd: stDir, stdio: ['ignore', 'pipe', 'pipe'] });

    let log = '';
    const collect = (chunk) => { log += chunk.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        // child.kill() на Windows убивает только сам node, оставляя дочерние процессы.
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            child.kill('SIGTERM');
        }
    };

    try {
        await waitFor(() => {
            if (child.exitCode !== null) {
                throw new Error(`SillyTavern завершился с кодом ${child.exitCode}:\n${tail(log)}`);
            }
            if (/EADDRINUSE/.test(log)) {
                throw new Error(`порт ${port} занят — закройте другой SillyTavern или задайте STDOOM_E2E_PORT`);
            }
            return READY_LINE.test(log);
        }, START_TIMEOUT_MS, () => `SillyTavern не поднялся за ${START_TIMEOUT_MS / 1000} с:\n${tail(log)}`);
    } catch (err) {
        stop();
        throw err;
    }

    return { url: `http://127.0.0.1:${port}`, dataRoot: root, stop };
}

function tail(text, lines = 15) {
    return text.trim().split('\n').slice(-lines).join('\n');
}

async function waitFor(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() > deadline) throw new Error(typeof message === 'function' ? message() : message);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

// --- Страница таверны

/**
 * Открывает таверну и дожидается, пока расширение объявится в wand-меню.
 * Возвращает страницу, живой список всех строк консоли и отдельно — ошибок:
 * тесты проверяют, что ошибок нет, а по логам ловят стадии загрузки DOOM.
 *
 * `options` уходят в newContext как есть: так набор мобильной вёрстки поднимает свой
 * контекст с узким экраном и hasTouch, не трогая основной прогон.
 */
export async function openTavern(browser, url, options = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
    const page = await context.newPage();

    // Консоль пишем целиком и с самого начала: половина признаков жизни расширения —
    // это его собственные logInfo (регистрация /doom, stdout DOSBox), и они успевают
    // случиться до того, как тест начнёт слушать.
    const logs = [];
    const errors = [];
    page.on('console', (msg) => {
        logs.push(msg.text());
        if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => {
        logs.push(`pageerror: ${err.message}`);
        errors.push(`pageerror: ${err.message}`);
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Кнопка расширения появляется по APP_READY (или по 3-секундной страховке в
    // index.js) — это и есть признак того, что таверна догрузилась, а STDoom в ней жив.
    await page.waitForSelector('#stdoom_wand_button', { state: 'attached', timeout: 90_000 });
    await dismissPopups(page);

    return { context, page, errors, logs };
}

// Попапы чужих расширений (у разработчика в таверне их обычно десяток) всплывают
// когда угодно — в том числе посреди уже идущего теста, поверх открытого окна DOOM, —
// и перехватывают клики. Ждать «спокойного момента» бесполезно, поэтому просто сносим
// каждый чужой попап: тест жмёт на DOOM, а не на чужие уведомления.
//
// Своё окно узнаём по .stdoom-root и не трогаем.
export async function dismissPopups(page) {
    return page.evaluate(() => {
        let removed = 0;
        for (const dialog of document.querySelectorAll('dialog.popup')) {
            if (dialog.querySelector('.stdoom-root')) continue;
            // Подтверждение выхода — тоже наш попап, но своей разметки в нём нет,
            // только текст. Снести его — значит сломать тест закрытия.
            if (/DOOM/.test(dialog.textContent ?? '')) continue;
            try { dialog.close(); } catch { /* уже закрыт */ }
            dialog.remove();
            removed++;
        }
        return removed;
    }).catch(() => 0);
}

/**
 * Держит страницу свободной от чужих попапов на всё время прогона.
 * Разовый dismissPopups() не спасает: STMemoryBooks и подобные показывают своё
 * уведомление по событиям чата, то есть в произвольный момент между кликами теста.
 * @returns {() => void} остановить сторожа
 */
export function guardPopups(page, intervalMs = 500) {
    const timer = setInterval(() => { dismissPopups(page); }, intervalMs);
    return () => clearInterval(timer);
}

// --- Окно STDoom

/** Открывает окно DOOM из wand-меню и дожидается появления рамки. */
export async function openDoom(page) {
    await dismissPopups(page);
    await page.click('#extensionsMenuButton');
    await page.click('#stdoom_wand_button');
    await page.waitForSelector('.stdoom-root .stdoom-frame');
}

// Esc окно НЕ закрывает (§4.7 плана: клавиша принадлежит DOOM) — только своя кнопка
// в рамке. Если однажды этот хелпер начнёт жать Escape, значит правило сломали.
export async function closeDoom(page) {
    await page.click('.stdoom-close');
    await page.waitForSelector('.stdoom-root', { state: 'detached' });
}

/** Живые настройки расширения глазами самой таверны. */
export function readSettings(page) {
    return page.evaluate(() => SillyTavern.getContext().extensionSettings.STDoom ?? null);
}

/** Обнуляет настройки расширения и дожидается записи на диск. */
export async function resetSettings(page) {
    await page.evaluate(() => {
        const ctx = SillyTavern.getContext();
        delete ctx.extensionSettings.STDoom;
    });
    await flushSettings(page);
}

/**
 * Дожидается, пока настройки реально доедут до диска.
 *
 * Синхронного saveSettings в контексте ST 1.18 нет — только saveSettingsDebounced,
 * поэтому «сохранил» здесь означает «дождался ответа сервера на POST /api/settings/save».
 * Без этого reload() успевает случиться раньше записи, и тест ловит пустые настройки.
 */
export async function flushSettings(page) {
    const saved = page.waitForResponse(
        (res) => res.url().includes('/api/settings/save') && res.status() === 200,
        { timeout: 20_000 },
    );
    await page.evaluate(() => SillyTavern.getContext().saveSettingsDebounced());
    await saved;
}

// --- Тесты

/**
 * Тест e2e: то же, что test() из _harness.mjs, но на падении кладёт скриншот
 * в tests/e2e/.artifacts и дописывает путь к нему в сообщение об ошибке.
 */
export function e2eTest(env, name, fn) {
    return test(name, async () => {
        try {
            await fn();
        } catch (err) {
            const file = join(ARTIFACTS, `${name.replace(/[^\wа-яА-ЯёЁ]+/g, '-').slice(0, 60)}.png`);
            try {
                mkdirSync(ARTIFACTS, { recursive: true });
                await env.page.screenshot({ path: file, fullPage: true });
                err.message += `\nскриншот: ${file}`;
            } catch { /* скриншот — приятный бонус, а не причина потерять исходную ошибку */ }
            throw err;
        }
    });
}

/** Ошибки консоли, кроме шума самой таверны: расширение обязано молчать. */
export function stdoomErrors(env) {
    return env.errors.filter((line) => /STDoom/i.test(line));
}
