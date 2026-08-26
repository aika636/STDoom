// Набор e2e «дым»: расширение в живой SillyTavern.
//
// Ради этого набора вообще писалась обвязка e2e — он закрывает главный риск §10 плана:
// CSP таверны. Всё, что делает загрузчик js-dos (вставка <script>, eval внутри бандла,
// Worker из blob:, wasm), в jsdom не проверяется никак, а на голом стенде Фазы 0 CSP
// нет вовсе. Проверить это можно только здесь.

import { strict as assert } from 'node:assert';

import { closeDoom, dismissPopups, e2eTest, openDoom, stdoomErrors } from './_st.mjs';

// DOOM грузит wasm, распаковывает бандл и поднимает DOSBox — на холодном кеше это
// заметно дольше обычного ожидания Playwright.
const BOOT_TIMEOUT_MS = 120_000;

export default async function suite(env) {
    // Логи собирает openTavern с момента создания страницы: часть признаков жизни
    // (регистрация /doom) случается на загрузке, до первого теста.
    const { page, logs } = env;
    const logged = (re) => logs.some((line) => re.test(line));
    const waitLogged = (re, timeout = BOOT_TIMEOUT_MS) => waitFor(
        () => logged(re),
        timeout,
        () => [`в консоли не появилось ${re}`, 'последние строки:', ...logs.slice(-25)].join('\n'),
    );

    await e2eTest(env, 'расширение загрузилось без ошибок в консоли', async () => {
        assert.deepEqual(stdoomErrors(env), []);
        assert.equal(await page.locator('#stdoom_wand_button').count(), 1);
    });

    await e2eTest(env, 'слэш-команда /doom зарегистрирована', async () => {
        // Спрашиваем сам парсер, а не лог: лог — свидетельство, реестр команд — факт.
        const known = await page.evaluate(() => {
            const parser = SillyTavern.getContext().SlashCommandParser;
            return Boolean(parser?.commands?.doom);
        });
        assert.ok(known, 'SlashCommandParser не знает команду doom');
    });

    await e2eTest(env, 'окно открывается из wand-меню и закрывается своей кнопкой', async () => {
        await openDoom(page);
        assert.equal(await page.locator('.stdoom-canvas').count(), 1, 'канвас не создан');
        await closeDoom(page);
    });

    await e2eTest(env, 'Escape не закрывает окно (клавиша принадлежит DOOM)', async () => {
        await openDoom(page);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        assert.equal(await page.locator('.stdoom-root').count(), 1, 'окно закрылось по Escape');
        await closeDoom(page);
    });

    await e2eTest(env, 'второе окно не открывается', async () => {
        await openDoom(page);
        // Через wand-меню сюда не добраться — своё же модальное окно перехватывает
        // клики. Зовём вторую точку входа, /doom: она и повторный запуск проверяет,
        // и саму команду заодно.
        await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/doom'));
        await page.waitForTimeout(1000);
        assert.equal(await page.locator('.stdoom-root').count(), 1, 'открылось второе окно');
        assert.ok(logs.some((line) => /окно уже открыто/.test(line)), 'нет записи о повторном открытии');
        await closeDoom(page);
    });

    // --- Главное: CSP таверны и живой DOOM

    await e2eTest(env, 'CSP таверны не мешает: DOOM загружается и рисует кадры', async () => {
        await openDoom(page);

        // Счётчик кадров: рендерер не отдаёт наружу framesDrawn, а прочитать пиксели
        // из WebGL-канваса нельзя (preserveDrawingBuffer: false). Поэтому считаем
        // сами вызовы отрисовки — это ровно тот сигнал, что кадры доехали до экрана.
        await page.evaluate(() => {
            window.__stdoomDraws = 0;
            const proto = WebGLRenderingContext.prototype;
            const original = proto.drawArrays;
            proto.drawArrays = function (...args) {
                window.__stdoomDraws++;
                return original.apply(this, args);
            };
        });

        await page.click('.stdoom-play');

        // Каждая строка ниже — отдельный барьер CSP: <script src> загрузчика,
        // eval+blob:Worker внутри бандла, wasm и, наконец, сам движок DOOM.
        await waitLogged(/js-dos API загружен/);
        await waitLogged(/DOOM запущен/);
        await waitLogged(/shareware version/i);

        // Размер кадра приходит отдельным событием onFrameSize, а не сразу после
        // dosboxWorker(), — поэтому размер из строки «DOOM запущен» не проверяем,
        // а спрашиваем сам канвас.
        // Кадр приходит НЕ 320x200: DOSBox отдаёт удвоенный по строкам VGA-режим,
        // то есть 640x400 (масштабирование делает CSS). Проверяем именно его — если
        // однажды станет 320x200, это смена поведения эмулятора, а не мелочь.
        const size = await page.evaluate(() => {
            const canvas = document.querySelector('.stdoom-canvas');
            return { w: canvas.width, h: canvas.height };
        });
        assert.deepEqual(size, { w: 640, h: 400 }, 'неожиданный размер кадра от DOSBox');

        await waitFor(
            async () => await page.evaluate(() => window.__stdoomDraws) > 30,
            30_000,
            async () => `кадры не рисуются: drawArrays вызван ${await page.evaluate(() => window.__stdoomDraws)} раз`,
        );

        assert.deepEqual(stdoomErrors(env), [], 'расширение ругалось в консоль во время запуска');
    });

    await e2eTest(env, 'первый клик по полю захватывает мышь', async () => {
        await page.locator('.stdoom-canvas').click();
        await waitFor(
            () => page.evaluate(() => document.pointerLockElement?.classList.contains('stdoom-canvas') === true),
            10_000,
            'Pointer Lock не захвачен кликом по канвасу',
        );
    });

    await e2eTest(env, 'клавиши не утекают в поле ввода таверны, пока канвас в фокусе', async () => {
        await page.keyboard.press('KeyW');
        await page.keyboard.press('Space');
        await page.keyboard.press('Slash');
        await page.waitForTimeout(300);
        const text = await page.inputValue('#send_textarea');
        assert.equal(text, '', `в поле ввода утекло: ${JSON.stringify(text)}`);
    });

    await e2eTest(env, 'после ухода фокуса с канваса перехват клавиатуры снимается', async () => {
        // Пока мышь захвачена, до тулбара не докликаться: курсора нет, все клики уходят
        // в захваченный элемент. Живой игрок отпускает мышь клавишей Escape (её съедает
        // сам браузер, до DOOM она не доходит) — из теста делаем это явно.
        await releasePointerLock(page);
        await page.locator('.stdoom-toolbar').click();

        // Поле ввода таверны для проверки не годится: окно DOOM — модальный <dialog>,
        // и всё за его пределами для кликов недоступно по определению. Смотрим на сам
        // признак перехвата: пока канвас в фокусе, keyboard.js гасит событие
        // (preventDefault), а после ухода фокуса обязан пропускать его дальше.
        // Перехватчик висит на window в фазе захвата и, гася событие, зовёт ещё и
        // stopPropagation — до слушателя ниже оно тогда не доходит вовсе. Поэтому
        // «не дошло за 500 мс» здесь равносильно «перехвачено».
        const verdict = await page.evaluate(() => new Promise((resolve) => {
            const timer = setTimeout(() => resolve('проглочено перехватчиком'), 500);
            document.addEventListener('keydown', (e) => {
                clearTimeout(timer);
                resolve(e.defaultPrevented ? 'preventDefault' : 'пропущено');
            }, { once: true });
            // Диспатчим на body, а не на window: событие должно пройти фазу захвата
            // на window (там сидит перехватчик) и всплыть обратно до document.
            document.body.dispatchEvent(new KeyboardEvent('keydown', {
                code: 'KeyW', key: 'w', bubbles: true, cancelable: true,
            }));
        }));
        assert.equal(verdict, 'пропущено', 'клавиша всё ещё перехватывается, хотя канвас не в фокусе');
    });

    await e2eTest(env, 'закрытие запущенной игры спрашивает подтверждение', async () => {
        await releasePointerLock(page);
        await page.click('.stdoom-close');
        // На запущенной игре modal.js показывает CONFIRM таверны (§4.7).
        const confirm = page.locator('dialog.popup[open]').last();
        await confirm.waitFor({ state: 'visible', timeout: 10_000 });
        await confirm.getByRole('button', { name: 'Выйти' }).click();
        await page.waitForSelector('.stdoom-root', { state: 'detached', timeout: 30_000 });

        // «сессия закрыта» пишется последней строкой stop(), уже после persist(),
        // — значит остановка прошла весь путь, а не оборвалась на середине.
        await waitLogged(/сессия закрыта/, 30_000);
        assert.deepEqual(stdoomErrors(env), [], 'расширение ругалось в консоль при закрытии');
    });

    await e2eTest(env, 'settings.json остаётся маленьким: сейвам там не место', async () => {
        // §4.10: settings.json таверна читает и пишет целиком при каждом сохранении,
        // поэтому в extensionSettings живут только настройки. Сам факт сохранения
        // прогресса проверяет отдельный набор saves.e2e.mjs — здесь важно обратное:
        // что в настройках НЕ появилось ничего тяжёлого.
        const settings = await page.evaluate(() => SillyTavern.getContext().extensionSettings.STDoom);
        assert.ok(settings, 'настройки расширения не созданы');
        const size = JSON.stringify(settings).length;
        assert.ok(size < 4096, `в settings.json уехало ${size} байт — похоже на сейв`);
    });

    await dismissPopups(page);
}

// Отпускает мышь и ждёт, пока браузер это подтвердит: exitPointerLock асинхронен,
// и клик сразу после него ещё улетает в захваченный элемент.
async function releasePointerLock(page) {
    await page.evaluate(() => document.exitPointerLock?.());
    await waitFor(
        () => page.evaluate(() => document.pointerLockElement === null),
        5_000,
        'мышь осталась захваченной',
    );
}

async function waitFor(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() > deadline) {
            throw new Error(typeof message === 'function' ? await message() : message);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}
