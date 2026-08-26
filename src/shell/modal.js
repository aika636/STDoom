// Попап и жизненный цикл сессии: одно открытое окно на всё расширение.
//
// Разметка окна собирается здесь целиком, а содержимое игрового поля отдаётся наружу:
// openShell({ init }) зовёт init(refs) со ссылками на готовые элементы и ждёт от него
// функцию teardown. Содержимое приходит извне (dos/session.js): окно про эмулятор не
// знает и знать не должно. Без init окно откроется с пустым полем — это нормальный
// режим для тестов разметки, в проде оба входа (shell/launcher.js) init передают.
//
// ⚠ ИНВЕРСИЯ ПРАВИЛА STGames (§4.7 плана): попап открывается с allowEscapeClose: false.
// Esc — клавиша меню DOOM, без неё игра неуправляема, поэтому закрывать окно им нельзя.
// Закрытие — только своей экранной кнопкой в рамке вокруг поля. Не «чинить» обратно.

import { getCtx } from '../ctx.js';
import { logError, logInfo } from '../log.js';
import { getSettings, saveSettings } from '../settings.js';
import { createSettingsPanel } from './settings-panel.js';

// Открытая сессия. Второй попап не открываем: два эмулятора с одним набором сейвов
// разъехались бы, а игроку и одного окна достаточно.
let session = null;

export function isOpen() {
    return session !== null;
}

/**
 * Открывает окно DOOM.
 *
 * @param {object} [options]
 * @param {(refs: object) => (Function|{destroy: Function}|void)} [options.init]
 *        Инициализатор содержимого. Получает ссылки на элементы окна, возвращает
 *        teardown (функцию или объект с destroy) — он будет вызван при закрытии.
 *        Без него игровое поле остаётся пустым.
 * @param {(refs: object) => void} [options.onStart]
 *        Вызывается по нажатию «Играть», после того как оверлей старта убран, а сессия
 *        помечена запущенной. Автостарта нет намеренно (§4.5): звук в браузере требует
 *        пользовательского жеста, и без явной кнопки игрок увидел бы немое кино.
 * @returns {Promise<void>} завершается, когда окно закрыто и teardown отработал.
 */
export async function openShell({ init = null, onStart = null } = {}) {
    if (session) {
        logInfo('окно уже открыто');
        return;
    }

    const settings = readSettings();
    const ui = buildUi(settings);
    const { root } = ui;

    session = { root, running: false, close: null, teardown: null };

    // Слушатели изменений настроек. Окно само настройки не применяет — оно не знает
    // про эмулятор; применяет содержимое (dos/session.js), подписавшись через
    // refs.onSettingsChange.
    const settingsListeners = new Set();
    const emitSettingsChange = (key, value) => {
        for (const listener of settingsListeners) {
            try {
                listener(key, value);
            } catch (err) {
                logError('обработчик настройки упал', err);
            }
        }
    };

    // Панель — секция внутри рамки, а не второй попап ST: попап поверх нашего
    // перехватил бы клики и сломал бы игру (§10 плана).
    const panel = createSettingsPanel({
        onChange: (key, value) => {
            // Звук панель и кнопка в рамке меняют одинаково, поэтому подпись кнопки
            // обновляем здесь же — иначе они разъедутся.
            if (key === 'sound') applySoundLabel(ui, value !== false);
            emitSettingsChange(key, value);
        },
    });
    ui.frame.insertBefore(panel.element, ui.stage);

    const refs = {
        root,
        frame: ui.frame,
        toolbar: ui.toolbar,
        stage: ui.stage,
        // Сюда Фаза 2 вставит канвас: контейнер уже держит letterbox 4:3.
        screen: ui.screen,
        startOverlay: ui.startOverlay,
        failureOverlay: ui.failureOverlay,
        // Экран отказа. Окно не знает, что именно сломалось, — текст и кнопки приходят
        // снаружи (dos/session.js), окно лишь рисует их поверх сцены.
        showFailure: (options) => showFailure(ui, options),
        hideFailure: () => hideFailure(ui),
        buttons: ui.buttons,
        status: ui.status,
        setStatus: (text) => { ui.status.textContent = text ?? ''; },
        isRunning: () => Boolean(session?.running),
        // Позволяет содержимому пометить сессию запущенной/остановленной: от этого
        // зависит подтверждение при закрытии.
        setRunning: (value) => { if (session) session.running = Boolean(value); },
        requestClose: () => { requestClose().catch((err) => logError('закрытие упало', err)); },
        // Панель настроек: содержимое окна подписывается сюда, чтобы применять
        // изменения к живой сессии (циклы, звук, оверлей) без перезапуска DOOM.
        onSettingsChange: (listener) => {
            settingsListeners.add(listener);
            return () => settingsListeners.delete(listener);
        },
        settingsPanel: panel,
    };

    // Кнопки рамки. Всё, что здесь может упасть, ловится: сломанный обработчик не
    // должен оставить окно без возможности закрыться.
    ui.buttons.close.addEventListener('click', refs.requestClose);
    ui.buttons.sound.addEventListener('click', () => {
        toggleSound(ui);
        // Кнопка и панель правят одну и ту же настройку: если панель открыта,
        // её галочка обязана поехать следом. Обновляем ТОЛЬКО её: полный refresh()
        // лезет в IndexedDB за сведениями о своих файлах и стирает текст отказа
        // («файл не подошёл: …») — от нажатия на несвязанную кнопку.
        panel.refreshSound();
    });
    ui.buttons.settings.addEventListener('click', () => {
        const opened = panel.toggle();
        ui.buttons.settings.setAttribute('aria-expanded', String(opened));
    });

    ui.buttons.play.addEventListener('click', () => {
        try {
            ui.startOverlay.hidden = true;
            if (session) session.running = true;
            onStart?.(refs);
        } catch (err) {
            logError('старт игры упал', err);
        }
    });

    try {
        if (init) session.teardown = normalizeTeardown(init(refs));
    } catch (err) {
        // Сломанное содержимое не должно убить окно: игрок увидит пустую рамку и
        // сможет её закрыть, а причина уедет в консоль.
        logError('init содержимого упал', err);
    }

    let popup;
    try {
        popup = await showPopup(root);
    } catch (err) {
        logError('не удалось показать попап', err);
        // Уборка та же, что и на нормальном пути ниже: панель и подписчики созданы
        // ДО showPopup(), и расходиться этим двум веткам не с чего.
        runTeardown();
        settingsListeners.clear();
        panel.destroy();
        session = null;
        return;
    }

    if (session) session.close = popup.close;

    try {
        await popup.promise;
    } catch (err) {
        logError('попап завершился ошибкой', err);
    } finally {
        runTeardown();
        settingsListeners.clear();
        panel.destroy();
        session = null;
    }
}

function runTeardown() {
    const teardown = session?.teardown;
    if (!teardown) return;
    session.teardown = null;
    try {
        teardown();
    } catch (err) {
        logError('teardown содержимого упал', err);
    }
}

// Закрытие с подтверждением: случайно потерять прогресс запущенной игры обидно
// (§4.7 плана). Если подтверждения показать нечем — закрываем без него, лишь бы окно
// не оказалось незакрываемым.
async function requestClose() {
    if (!session) return;
    if (session.running && !(await confirmClose())) return;
    const close = session.close;
    if (typeof close === 'function') close();
}

async function confirmClose() {
    const message = 'Выйти из DOOM? Несохранённый прогресс будет потерян.';
    try {
        const ctx = getCtx();
        if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE?.CONFIRM) {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM, '', {
                okButton: 'Выйти',
                cancelButton: 'Остаться',
            });
            return Boolean(result);
        }
        if (typeof globalThis.confirm === 'function') return globalThis.confirm(message);
    } catch (err) {
        logError('не удалось показать подтверждение выхода', err);
    }
    return true;
}

// --- Разметка

function buildUi(settings) {
    const root = document.createElement('div');
    root.className = 'stdoom-root';
    // Фокусируемый корень: попап ST при открытии сам ставит фокус на первый подходящий
    // элемент внутри, и без этого им оказалась бы кнопка закрытия.
    root.tabIndex = -1;

    const frame = document.createElement('div');
    frame.className = 'stdoom-frame';

    const toolbar = document.createElement('div');
    toolbar.className = 'stdoom-toolbar';

    const title = document.createElement('span');
    title.className = 'stdoom-brand';
    title.textContent = 'DOOM';

    const spacer = document.createElement('span');
    spacer.className = 'stdoom-spacer';

    const soundBtn = makeButton('stdoom-sound', 'Звук');
    const settingsBtn = makeButton('stdoom-settings', 'Настройки');
    // Панель вставляется в рамку снаружи (openShell), поэтому здесь только состояние
    // кнопки: закрыта.
    settingsBtn.setAttribute('aria-expanded', 'false');
    // Кнопка закрытия всегда видима и лежит в рамке, вне игрового поля: Esc уходит
    // в DOOM, и другого способа выйти у игрока нет.
    const closeBtn = makeButton('stdoom-close', 'Закрыть');

    toolbar.append(title, spacer, soundBtn, settingsBtn, closeBtn);

    const stage = document.createElement('div');
    stage.className = 'stdoom-stage';

    // Игровое поле: letterbox 4:3 считает JS — `renderer.layout()` выставляет
    // канвасу инлайновые размеры от размера сцены (правило 17). `aspect-ratio` в
    // style.css — страховка на тот случай, когда канваса ещё нет. На vw не
    // полагаемся ни там, ни там: попап ST на узком экране даёт содержимому куда
    // меньше, чем ширина окна (§4.4 плана).
    const screen = document.createElement('div');
    screen.className = 'stdoom-screen';

    const startOverlay = document.createElement('div');
    startOverlay.className = 'stdoom-start';

    // Экран отказа (§3.3): пока он скрыт, его в разметке как бы нет — ни кликов, ни
    // фокуса он не отбирает, иначе мешал бы игре всё остальное время.
    const failureOverlay = document.createElement('div');
    failureOverlay.className = 'stdoom-failure';
    failureOverlay.hidden = true;
    failureOverlay.setAttribute('role', 'alertdialog');

    const failureTitle = document.createElement('p');
    failureTitle.className = 'stdoom-failure-title';

    const failureText = document.createElement('p');
    failureText.className = 'stdoom-failure-text';

    const failureActions = document.createElement('div');
    failureActions.className = 'stdoom-failure-actions';

    failureOverlay.append(failureTitle, failureText, failureActions);

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'stdoom-play';
    playBtn.textContent = 'Играть';

    const hint = document.createElement('p');
    hint.className = 'stdoom-hint';
    hint.textContent = 'Звук включится после первого нажатия — так требует браузер.';

    startOverlay.append(playBtn, hint);
    stage.append(screen, startOverlay, failureOverlay);

    const status = document.createElement('div');
    status.className = 'stdoom-status';
    status.textContent = '';

    frame.append(toolbar, stage, status);
    root.appendChild(frame);

    const ui = {
        root,
        frame,
        toolbar,
        stage,
        screen,
        startOverlay,
        failureOverlay,
        failureTitle,
        failureText,
        failureActions,
        status,
        buttons: { close: closeBtn, sound: soundBtn, settings: settingsBtn, play: playBtn },
    };
    applySoundLabel(ui, settings.sound !== false);
    return ui;
}

// --- Экран отказа

/**
 * Показывает экран отказа поверх сцены.
 *
 * @param {object} ui
 * @param {object} [options]
 * @param {string} [options.title] заголовок
 * @param {string} [options.text] что случилось и что с этим делать
 * @param {Array<{label: string, onClick?: Function, primary?: boolean}>} [options.actions]
 *        кнопки; пустой список допустим, но тогда игроку остаётся только рамка окна.
 */
function showFailure(ui, { title = 'Что-то сломалось', text = '', actions = [] } = {}) {
    ui.failureTitle.textContent = title;
    ui.failureText.textContent = text;

    const buttons = [];
    for (const action of actions) {
        if (!action || !action.label) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'stdoom-btn stdoom-failure-btn'
            + (action.primary ? ' stdoom-failure-primary' : '');
        button.textContent = action.label;
        button.addEventListener('click', () => {
            // Сломанная кнопка на экране поломки — худшее, что тут может случиться:
            // игрок останется без единого работающего выхода.
            try {
                action.onClick?.();
            } catch (err) {
                logError('кнопка экрана отказа упала', err);
            }
        });
        buttons.push(button);
    }
    ui.failureActions.replaceChildren(...buttons);
    ui.failureOverlay.hidden = false;
    buttons[0]?.focus?.({ preventScroll: true });
}

function hideFailure(ui) {
    ui.failureOverlay.hidden = true;
    // Обработчики уезжают вместе с кнопками: скрытый экран не должен держать ссылки
    // на закрытую сессию.
    ui.failureActions.replaceChildren();
    ui.failureTitle.textContent = '';
    ui.failureText.textContent = '';
}

function makeButton(className, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `stdoom-btn ${className}`;
    button.textContent = label;
    button.title = label;
    return button;
}

function normalizeTeardown(value) {
    if (typeof value === 'function') return value;
    if (value && typeof value.destroy === 'function') return () => value.destroy();
    return null;
}

// --- Звук

function toggleSound(ui) {
    try {
        const settings = getSettings();
        settings.sound = !settings.sound;
        saveSettings();
        applySoundLabel(ui, settings.sound);
    } catch (err) {
        logError('не удалось переключить звук', err);
    }
}

function applySoundLabel(ui, on) {
    const button = ui.buttons.sound;
    button.textContent = on ? 'Звук: вкл' : 'Звук: выкл';
    button.title = on ? 'Выключить звук' : 'Включить звук';
    button.setAttribute('aria-pressed', String(Boolean(on)));
}

// Настройки читаем защищённо: до полной загрузки ST контекста может не быть, а окно
// должно открываться в любом случае.
function readSettings() {
    try {
        return getSettings();
    } catch (err) {
        logError('не удалось прочитать настройки', err);
        return { sound: true };
    }
}

// --- Попап

/**
 * Показывает окно и возвращает { promise, close }: promise завершается при закрытии,
 * close() закрывает окно программно (у нас нет Esc, всё держится на своей кнопке).
 */
async function showPopup(content) {
    const ctx = getCtx();

    // DISPLAY — попап без кнопок; числовое значение на случай, если POPUP_TYPE в этой
    // версии ST не экспортирован.
    const DISPLAY = ctx.POPUP_TYPE?.DISPLAY ?? 4;
    const options = {
        // wider тянет ТОЛЬКО ширину (min-width 750px), а высоту попап оставляет по
        // содержимому — и окно выходило заметно меньше экрана, хотя DOOM растягивается
        // как угодно: он рисует 320x200, а до размера сцены картинку тянет CSS
        // (правило 17). Высоту даёт large: 90% экрана. Без него игровое поле упиралось
        // в высоту тулбара со строкой состояния и получалось «марочным».
        wider: true,
        large: true,
        // Скролл выключен: поле и так вписано в окно, а прокрутка под пальцем на
        // планшете уводила бы картинку во время игры.
        allowVerticalScrolling: false,
        // ⚠ §4.7: Esc принадлежит DOOM, попапом он не закрывается.
        allowEscapeClose: false,
        animation: 'fast',
    };

    // Класс Popup даёт ручку на закрытие — с ним кнопка «Закрыть» работает напрямую.
    if (typeof ctx.Popup === 'function') {
        const popup = new ctx.Popup(content, DISPLAY, '', options);
        return {
            promise: Promise.resolve(popup.show()),
            close: () => {
                try {
                    popup.completeCancelled();
                } catch (err) {
                    logError('не удалось закрыть попап', err);
                }
            },
        };
    }

    if (typeof ctx.callGenericPopup === 'function') {
        const promise = Promise.resolve(ctx.callGenericPopup(content, DISPLAY, '', options));
        return { promise, close: () => closeHostPopup(content) };
    }

    return showFallbackOverlay(content);
}

// callGenericPopup ручки на закрытие не отдаёт, поэтому жмём на крестик самого ST,
// а если его нет — закрываем <dialog> напрямую.
function closeHostPopup(content) {
    try {
        const dialog = content.closest?.('dialog');
        if (!dialog) return;
        const cross = dialog.querySelector('.popup-button-close');
        if (cross) {
            cross.click();
            return;
        }
        dialog.close?.();
    } catch (err) {
        logError('не удалось закрыть попап', err);
    }
}

// Свой оверлей на случай, когда попапа ST нет. Умеет ровно то, что нужно: закрытие
// программное, из нашей кнопки. Ни Esc, ни клик мимо окна не закрывают — то и другое
// стоило бы игроку партии (§4.7).
function showFallbackOverlay(content) {
    const previousActive = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'stdoom-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'stdoom-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'STDoom');

    dialog.appendChild(content);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let resolve;
    const promise = new Promise((r) => { resolve = r; });

    const close = () => {
        overlay.remove();
        previousActive?.focus?.({ preventScroll: true });
        resolve();
    };

    return { promise, close };
}
