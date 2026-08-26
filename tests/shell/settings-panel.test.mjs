// Тесты панели настроек (Фаза 4) под jsdom.
//
// Проверяем ровно то, что легко сломать:
//   — панель живёт ВНУТРИ рамки окна, а не вторым попапом таверны (§10 плана);
//   — значения клампятся границами из config.js/runtime.js, а не своими копиями;
//   — изменение уезжает подписчику (это и есть «применить без перезапуска», §4.9);
//   — сброс прогресса без подтверждения не трогает хранилище;
//   — фокус в поле панели снимает перехват клавиатуры (§4.7), иначе в поле нельзя
//     было бы напечатать ни цифры.
//
// Требуется jsdom: npm install --no-save jsdom
// Запуск: node tests/shell/settings-panel.test.mjs

import { JSDOM } from 'jsdom';
import { assert, assertEqual, report, test } from '../_harness.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.Event = dom.window.Event;

// --- Заглушка контекста таверны

let confirmAnswer = false;
const confirmCalls = [];

let livePopup = null;
class PopupStub {
    constructor(content) {
        this.content = content;
        this.promise = new Promise((resolve) => { this.resolve = resolve; });
        livePopup = this;
    }

    show() {
        document.body.appendChild(this.content);
        return this.promise;
    }

    completeCancelled() {
        this.content.remove();
        this.resolve();
    }
}

let saves = 0;
const context = {
    extensionSettings: {},
    saveSettingsDebounced: () => { saves++; },
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2, DISPLAY: 4 },
    Popup: PopupStub,
    callGenericPopup: (message, type) => {
        confirmCalls.push({ message, type });
        return Promise.resolve(confirmAnswer);
    },
};
globalThis.SillyTavern = { getContext: () => context };

// --- Заглушка IndexedDB: сейвы живут там, а не в extensionSettings (§4.10),
// поэтому «сбросить прогресс» проверяется именно через неё.

function installIndexedDb() {
    const data = new Map();
    const stores = new Set();

    function makeRequest() {
        return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    }

    globalThis.indexedDB = {
        data,
        open() {
            const request = makeRequest();
            queueMicrotask(() => {
                request.result = {
                    objectStoreNames: { contains: (n) => stores.has(n) },
                    createObjectStore: (n) => { stores.add(n); },
                    close: () => {},
                    transaction(name, mode) {
                        const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
                        tx.objectStore = () => ({
                            get(key) {
                                const r = makeRequest();
                                r.result = data.get(key);
                                queueMicrotask(() => tx.oncomplete?.());
                                return r;
                            },
                            put(value, key) {
                                const r = makeRequest();
                                if (mode !== 'readwrite') throw new Error('запись в readonly-транзакции');
                                data.set(key, value);
                                queueMicrotask(() => tx.oncomplete?.());
                                return r;
                            },
                            delete(key) {
                                const r = makeRequest();
                                data.delete(key);
                                queueMicrotask(() => tx.oncomplete?.());
                                return r;
                            },
                        });
                        return tx;
                    },
                };
                if (!stores.has('saves')) request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        },
    };
    return data;
}

const savesDb = installIndexedDb();

const { CYCLES_MAX, CYCLES_MIN } = await import('../../src/dos/config.js');
const {
    SENSITIVITY_MAX, SENSITIVITY_MIN, clampSensitivity, createSettingsPanel,
} = await import('../../src/shell/settings-panel.js');
const { getSettings } = await import('../../src/settings.js');
const { openShell } = await import('../../src/shell/modal.js');
const { createKeyboard } = await import('../../src/input/keyboard.js');
const { createKeyBus } = await import('../../src/input/key-bus.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Свежие настройки перед каждым тестом: панель читает живой объект контекста. */
function resetSettings(overrides = {}) {
    context.extensionSettings = {};
    Object.assign(getSettings(), overrides);
    return getSettings();
}

/** Панель сама по себе, без окна: так проверяется её собственное поведение. */
function makePanel(overrides = {}) {
    const settings = resetSettings(overrides);
    const changes = [];
    const panel = createSettingsPanel({ onChange: (key, value) => changes.push([key, value]) });
    document.body.appendChild(panel.element);
    const field = (cls) => panel.element.querySelector(`.${cls}`);
    return { panel, settings, changes, field };
}

function fire(element, type) {
    element.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
}

console.log('settings-panel (jsdom)');

// --- Поля и значения

await test('панель заполняется текущими настройками', () => {
    const { panel, field } = makePanel({ cycles: 35000, sound: false, mouseSensitivity: 1.5, debugOverlay: true });
    panel.open();

    assertEqual(field('stdoom-field-cycles').value, '35000', 'циклы');
    assertEqual(field('stdoom-field-sound').checked, false, 'звук');
    assertEqual(field('stdoom-field-sensitivity').value, '1.5', 'чувствительность');
    assertEqual(field('stdoom-field-debug').checked, true, 'оверлей');
    assertEqual(field('stdoom-sensitivity-value').textContent, '×1.5', 'подпись чувствительности');
    panel.destroy();
});

await test('циклы клампятся границами из config.js, а не своими копиями', () => {
    const { panel, settings, changes, field } = makePanel();
    const input = field('stdoom-field-cycles');

    input.value = '1';
    fire(input, 'change');
    assertEqual(settings.cycles, CYCLES_MIN, 'ниже минимума зажато до CYCLES_MIN');
    assertEqual(input.value, String(CYCLES_MIN), 'поле показывает зажатое значение');

    input.value = String(CYCLES_MAX * 10);
    fire(input, 'change');
    assertEqual(settings.cycles, CYCLES_MAX, 'выше максимума зажато до CYCLES_MAX');

    input.value = '35000';
    fire(input, 'change');
    assertEqual(settings.cycles, 35000, 'значение из диапазона');
    assertEqual(changes.length, 3, 'каждое изменение ушло подписчику');
    assertEqual(changes[2][0], 'cycles', 'ключ последнего изменения');
    assertEqual(changes[2][1], 35000, 'значение последнего изменения');
    panel.destroy();
});

await test('циклы не шлются посимвольно: событие input игнорируется', () => {
    const { panel, changes, field } = makePanel();
    const input = field('stdoom-field-cycles');
    input.value = '4000';
    fire(input, 'input');
    assertEqual(changes.length, 0, 'изменений до change нет');
    panel.destroy();
});

await test('звук пишется в настройки и сохраняется', () => {
    const { panel, settings, changes, field } = makePanel();
    const before = saves;
    const box = field('stdoom-field-sound');

    box.checked = false;
    fire(box, 'change');
    assertEqual(settings.sound, false, 'настройка выключена');
    assertEqual(changes[0][0], 'sound', 'ключ изменения');
    assert(saves > before, 'saveSettingsDebounced вызван');
    panel.destroy();
});

await test('чувствительность клампится и применяется по input', () => {
    const { panel, settings, changes, field } = makePanel();
    const slider = field('stdoom-field-sensitivity');

    slider.value = '2.5';
    fire(slider, 'input');
    assertEqual(settings.mouseSensitivity, 2.5, 'значение записано');
    assertEqual(field('stdoom-sensitivity-value').textContent, '×2.5', 'подпись обновлена');

    assertEqual(clampSensitivity(99), SENSITIVITY_MAX, 'верхняя граница');
    assertEqual(clampSensitivity(0), SENSITIVITY_MIN, 'нижняя граница');
    assertEqual(clampSensitivity('чепуха'), 1, 'мусор → дефолт');
    assertEqual(changes[0][0], 'mouseSensitivity', 'ключ изменения');
    panel.destroy();
});

await test('отладочный оверлей переключается и уходит подписчику', () => {
    const { panel, settings, changes, field } = makePanel();
    const box = field('stdoom-field-debug');
    box.checked = true;
    fire(box, 'change');
    assertEqual(settings.debugOverlay, true, 'настройка включена');
    assertEqual(changes[0][0], 'debugOverlay', 'ключ изменения');
    panel.destroy();
});

await test('тач-контролы переключаются тремя режимами и уходят подписчику', () => {
    const { panel, settings, changes, field } = makePanel();
    const select = field('stdoom-field-touch');
    assertEqual(select.value, 'auto', 'по умолчанию — авто-детект устройства');
    assertEqual(select.options.length, 3, 'авто, всегда, выключено');

    select.value = 'off';
    fire(select, 'change');
    assertEqual(settings.touchControls, 'off', 'настройка записана');
    assertEqual(changes[0][0], 'touchControls', 'ключ изменения');
    panel.destroy();
});

await test('мусор в touchControls не ломает панель — режим откатывается в auto', () => {
    const { panel, settings, field } = makePanel();
    settings.touchControls = 'чепуха';
    panel.refresh();
    assertEqual(field('stdoom-field-touch').value, 'auto', 'битое значение из settings.json');
    panel.destroy();
});

await test('touchLayout панель по-прежнему не трогает — это дело редактора раскладки', () => {
    // Тумблер «тач-контролы вкл/выкл» и оверрайды раскладки (сдвиги, масштабы) —
    // разные вещи: первое есть, второе появится вместе с редактором (§6.1, Delta Touch).
    const { panel, settings, field } = makePanel();
    field('stdoom-field-sound').checked = false;
    fire(field('stdoom-field-sound'), 'change');
    assertEqual(Object.keys(settings.touchLayout).length, 0, 'раскладка тача пуста');
    panel.destroy();
});

// --- Открытие и закрытие

await test('панель скрыта по умолчанию, toggle открывает и закрывает', () => {
    const { panel } = makePanel();
    assertEqual(panel.isOpen, false, 'скрыта при создании');
    assertEqual(panel.toggle(), true, 'toggle вернул «открыта»');
    assertEqual(panel.isOpen, true, 'открыта');
    assertEqual(panel.element.hidden, false, 'hidden снят');
    assertEqual(panel.toggle(), false, 'toggle вернул «закрыта»');
    assertEqual(panel.element.hidden, true, 'hidden выставлен обратно');
    panel.destroy();
});

await test('кнопка «Готово» закрывает панель, но не окно', () => {
    const { panel } = makePanel();
    panel.open();
    panel.element.querySelector('.stdoom-panel-done').click();
    assertEqual(panel.isOpen, false, 'панель закрыта');
    assert(panel.element.isConnected, 'разметка панели осталась в документе');
    panel.destroy();
});

// --- Сброс прогресса

await test('сброс прогресса без подтверждения не трогает хранилище', async () => {
    const { panel } = makePanel();
    savesDb.set('changes', new Uint8Array([1, 2, 3]));
    confirmCalls.length = 0;
    confirmAnswer = false;

    panel.element.querySelector('.stdoom-reset').click();
    await flush();

    assertEqual(confirmCalls.length, 1, 'подтверждение запрошено');
    assertEqual(confirmCalls[0].type, context.POPUP_TYPE.CONFIRM, 'тип попапа — CONFIRM');
    assert(savesDb.has('changes'), 'сейвы на месте');
    panel.destroy();
});

await test('сброс прогресса с подтверждением удаляет сейвы из IndexedDB', async () => {
    const { panel, changes } = makePanel();
    savesDb.set('changes', new Uint8Array([1, 2, 3]));
    confirmCalls.length = 0;
    confirmAnswer = true;

    panel.element.querySelector('.stdoom-reset').click();
    await flush();

    assertEqual(confirmCalls.length, 1, 'подтверждение запрошено');
    assert(!savesDb.has('changes'), 'сейвы удалены');
    assertEqual(changes[0]?.[0], 'progressCleared', 'подписчику сообщено о сбросе');
    // Настройки при этом остаются на месте: сейвы и настройки не смешиваются (§4.10).
    assertEqual(getSettings().cycles, 20000, 'настройки уцелели');
    panel.destroy();
});

// --- Интеграция с окном

await test('панель — секция внутри рамки, а не второй попап ST', async () => {
    resetSettings();
    const opened = openShell();
    await flush();

    const root = document.querySelector('.stdoom-root');
    const panelEl = root.querySelector('.stdoom-settings-panel');
    assert(panelEl, 'панель есть в окне');
    assertEqual(panelEl.parentElement, root.querySelector('.stdoom-frame'), 'панель лежит в рамке');
    assertEqual(panelEl.nextElementSibling, root.querySelector('.stdoom-stage'), 'панель стоит перед полем');
    assertEqual(panelEl.hidden, true, 'по умолчанию скрыта');
    assertEqual(document.querySelectorAll('.stdoom-root').length, 1, 'второго окна не появилось');

    const button = root.querySelector('.stdoom-settings');
    button.click();
    assertEqual(panelEl.hidden, false, 'кнопка открыла панель');
    assertEqual(button.getAttribute('aria-expanded'), 'true', 'aria-expanded открыто');
    button.click();
    assertEqual(panelEl.hidden, true, 'кнопка закрыла панель');
    assertEqual(button.getAttribute('aria-expanded'), 'false', 'aria-expanded закрыто');

    livePopup.completeCancelled();
    await opened;
});

await test('refs.onSettingsChange доставляет изменения содержимому окна', async () => {
    resetSettings();
    const seen = [];
    let refs = null;
    const opened = openShell({ init: (r) => { refs = r; r.onSettingsChange((k, v) => seen.push([k, v])); } });
    await flush();

    const root = document.querySelector('.stdoom-root');
    root.querySelector('.stdoom-settings').click();
    const input = root.querySelector('.stdoom-field-cycles');
    input.value = '35000';
    fire(input, 'change');

    assert(refs, 'init получил refs');
    assertEqual(seen.length, 1, 'изменение доставлено');
    assertEqual(seen[0][0], 'cycles', 'ключ');
    assertEqual(seen[0][1], 35000, 'значение');

    livePopup.completeCancelled();
    await opened;
});

await test('кнопка «Звук» в рамке и галочка панели не разъезжаются', async () => {
    resetSettings();
    const opened = openShell();
    await flush();

    const root = document.querySelector('.stdoom-root');
    root.querySelector('.stdoom-settings').click();
    const box = root.querySelector('.stdoom-field-sound');
    const soundBtn = root.querySelector('.stdoom-sound');

    // Кнопка в рамке → галочка панели.
    soundBtn.click();
    assertEqual(getSettings().sound, false, 'настройка выключена кнопкой');
    assertEqual(box.checked, false, 'галочка поехала следом');

    // Галочка панели → подпись кнопки.
    box.checked = true;
    fire(box, 'change');
    assertEqual(getSettings().sound, true, 'настройка включена галочкой');
    assertEqual(soundBtn.textContent, 'Звук: вкл', 'подпись кнопки обновилась');

    livePopup.completeCancelled();
    await opened;
});

await test('после закрытия окна подписчики настроек не остаются висеть', async () => {
    resetSettings();
    const seen = [];
    const opened = openShell({ init: (r) => { r.onSettingsChange((k, v) => seen.push([k, v])); } });
    await flush();
    const root = document.querySelector('.stdoom-root');
    const panelEl = root.querySelector('.stdoom-settings-panel');
    livePopup.completeCancelled();
    await opened;

    assert(!panelEl.isConnected, 'разметка панели убрана вместе с окном');
    assertEqual(seen.length, 0, 'изменений не было');
});

// --- Клавиатура (§4.7)

await test('ввод в поле панели не перехватывается клавиатурой DOOM', () => {
    const sent = [];
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.appendChild(canvas);

    const { panel, field } = makePanel();
    const keyboard = createKeyboard({
        keys: createKeyBus({
            ci: { sendKeyEvent: (code, down) => sent.push([code, down]) },
        }).owner('keyboard'),
        surface: canvas,
        isActive: () => true,
    });
    keyboard.attach();
    panel.open();

    // Контрольный выстрел: с фокусом на поле перехват обязан молчать.
    const input = field('stdoom-field-cycles');
    input.focus();
    assertEqual(document.activeElement, input, 'фокус в поле панели');
    const toPanel = new dom.window.KeyboardEvent('keydown', { code: 'Digit5', bubbles: true, cancelable: true });
    input.dispatchEvent(toPanel);
    assertEqual(sent.length, 0, 'в DOOM ничего не ушло');
    assertEqual(toPanel.defaultPrevented, false, 'событие не проглочено — цифра дойдёт до поля');

    // А с фокусом на канвасе перехват работает как обычно.
    canvas.focus();
    const toGame = new dom.window.KeyboardEvent('keydown', { code: 'Digit5', bubbles: true, cancelable: true });
    canvas.dispatchEvent(toGame);
    assertEqual(sent.length, 1, 'клавиша ушла в DOOM');
    assertEqual(toGame.defaultPrevented, true, 'событие проглочено');

    keyboard.detach();
    panel.destroy();
    canvas.remove();
});

// --- Свой IWAD (Фаза 6)
//
// Файл игрока весит мегабайты и живёт в IndexedDB рядом с сейвами (§4.10), а не в
// settings.json. Панель обязана: распознать файл, положить его в хранилище, показать
// человеку, что именно загружено, и внятно отказать, если файл не тот.

/** Синтетический IWAD: заголовок + директория из одного лампа. */
function makeWad(magic, lumps) {
    const bytes = new Uint8Array(12 + lumps.length * 16);
    for (let i = 0; i < 4; i++) bytes[i] = magic.charCodeAt(i);
    bytes[4] = lumps.length;
    bytes[8] = 12;
    lumps.forEach((name, index) => {
        const at = 12 + index * 16;
        for (let i = 0; i < 8 && i < name.length; i++) bytes[at + 8 + i] = name.charCodeAt(i);
    });
    return bytes;
}

/** Заглушка File: jsdom-овский конструктор нам не нужен, хватает двух полей. */
function fakeFile(name, bytes) {
    return {
        name,
        size: bytes.length,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

/** Выбор файла в поле: FileList в jsdom только для чтения, поэтому подменяем свойство. */
function pickFile(input, file) {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fire(input, 'change');
}

const doom2Wad = makeWad('IWAD', ['MAP01']);

await test('свой IWAD загружается, распознаётся и ложится в IndexedDB', async () => {
    const { panel, field, changes } = makePanel();
    savesDb.clear();
    panel.open();

    pickFile(field('stdoom-field-iwad'), fakeFile('мой досс.wad', doom2Wad));
    await flush();

    assert(savesDb.has('user-iwad'), 'байты легли в хранилище');
    const meta = savesDb.get('user-iwad-meta');
    // §5.3: имя выводится из СОДЕРЖИМОГО, а не из имени файла на диске — флага
    // -iwad в ванильном DOOM нет, WAD ищется по имени.
    assertEqual(meta.dosName, 'DOOM2.WAD', 'имя в DOS выведено из карт MAP01…');
    assertEqual(meta.fileName, 'мой досс.wad', 'исходное имя сохранено для подписи');
    assert(/^[0-9a-f]{32}$/.test(meta.md5), `MD5 посчитан: ${meta.md5}`);

    const status = field('stdoom-iwad-status').textContent;
    assert(status.includes('DOOM2.WAD'), `в подписи имя файла: «${status}»`);
    assert(status.includes(meta.md5), 'и MD5');
    assertEqual(changes.at(-1)?.[0], 'userIwad', 'подписчику сообщено');
    panel.destroy();
});

await test('незнакомый MD5 не мешает загрузке — это предупреждение, а не запрет', async () => {
    const { panel, field } = makePanel();
    savesDb.clear();
    pickFile(field('stdoom-field-iwad'), fakeFile('doom2.wad', doom2Wad));
    await flush();

    assert(savesDb.has('user-iwad'), 'файл принят');
    assertEqual(savesDb.get('user-iwad-meta').known, false, 'в таблице его нет');
    assert(field('stdoom-iwad-status').textContent.includes('версия не опознана'), 'честная подпись');
    panel.destroy();
});

await test('PWAD отвергается: в хранилище ничего не легло, в подписи — причина', async () => {
    const { panel, field, changes } = makePanel();
    savesDb.clear();
    pickFile(field('stdoom-field-iwad'), fakeFile('mymaps.wad', makeWad('PWAD', ['MAP01'])));
    await flush();

    assertEqual(savesDb.size, 0, 'хранилище не тронуто');
    const status = field('stdoom-iwad-status');
    assert(/PWAD/.test(status.textContent), `видна причина отказа: «${status.textContent}»`);
    assert(status.classList.contains('stdoom-file-status-error'), 'подпись помечена ошибкой');
    assertEqual(changes.length, 0, 'подписчику сообщать нечего');
    panel.destroy();
});

await test('кнопка «Убрать» неактивна, пока файла нет, и удаляет его, когда есть', async () => {
    const { panel, field } = makePanel();
    savesDb.clear();
    panel.open();
    await flush();

    const clear = field('stdoom-iwad-clear');
    assertEqual(clear.disabled, true, 'без файла убирать нечего');

    pickFile(field('stdoom-field-iwad'), fakeFile('doom2.wad', doom2Wad));
    await flush();
    assertEqual(clear.disabled, false, 'файл есть — кнопка ожила');

    clear.click();
    await flush();
    assert(!savesDb.has('user-iwad'), 'байты удалены');
    assert(!savesDb.has('user-iwad-meta'), 'метаданные тоже');
    assertEqual(clear.disabled, true, 'кнопка снова неактивна');
    assert(/штатн/.test(field('stdoom-iwad-status').textContent), 'подпись вернулась к штатному WAD');
    panel.destroy();
});

await test('свой DOOM.EXE — отдельный слот, WAD в него не принимают', async () => {
    const { panel, field } = makePanel();
    savesDb.clear();

    const exeInput = field('stdoom-field-exe');
    pickFile(exeInput, fakeFile('doom2.wad', doom2Wad));
    await flush();
    assertEqual(savesDb.size, 0, 'WAD в поле программы отвергнут');
    assert(/IWAD/.test(field('stdoom-exe-status').textContent), 'подсказка, куда его нести');

    const exe = new Uint8Array([0x4d, 0x5a, 1, 2, 3]);
    pickFile(exeInput, fakeFile('DOOM.EXE', exe));
    await flush();
    assert(savesDb.has('user-exe'), 'программа принята');
    assert(!savesDb.has('user-iwad'), 'слот IWAD не затронут');
    panel.destroy();
});

await test('поле очищается после выбора: тот же файл можно выбрать повторно', async () => {
    const { panel, field } = makePanel();
    savesDb.clear();
    const input = field('stdoom-field-iwad');
    pickFile(input, fakeFile('doom2.wad', doom2Wad));
    await flush();
    assertEqual(input.value, '', 'поле сброшено');
    panel.destroy();
});

await test('панель открывается сразу, а подпись догоняет из хранилища', async () => {
    // refresh() синхронный, а IndexedDB — нет. Ждать базу при открытии панели
    // нельзя: игрок нажал кнопку и должен увидеть панель немедленно.
    savesDb.clear();
    savesDb.set('user-iwad', new Uint8Array([1, 2, 3]));
    savesDb.set('user-iwad-meta', {
        dosName: 'DOOM.WAD', md5: 'c4fe9fd920207691a9f493668e0a2083',
        size: 12408292, versionName: 'Ultimate Doom 1.9', fileName: 'doom.wad',
    });

    const { panel, field } = makePanel();
    panel.open();
    assertEqual(panel.isOpen, true, 'панель открыта немедленно');

    await flush();
    const status = field('stdoom-iwad-status').textContent;
    assert(status.includes('Ultimate Doom 1.9'), `подпись догнала: «${status}»`);
    assert(status.includes('11.8 МБ'), 'с человеческим размером');
    panel.destroy();
});

await test('ответ хранилища, опоздавший к выбору файла, подпись не откатывает', async () => {
    // Регрессия: чтение метаданных асинхронно, и его ответ приходил ПОСЛЕ того, как
    // игрок уже выбрал новый файл, — подпись откатывалась к старой.
    savesDb.clear();
    savesDb.set('user-iwad', new Uint8Array([1]));
    savesDb.set('user-iwad-meta', { dosName: 'DOOM.WAD', versionName: 'Ultimate Doom 1.9' });

    const { panel, field } = makePanel();  // refresh() уже пошёл в базу
    pickFile(field('stdoom-field-iwad'), fakeFile('doom2.wad', doom2Wad));
    await flush();

    const status = field('stdoom-iwad-status').textContent;
    assert(status.includes('DOOM2.WAD'), `видна свежая подпись: «${status}»`);
    assert(!status.includes('Ultimate'), 'а не старая');
    panel.destroy();
});

await test('§4.10: свой IWAD не просачивается в settings.json таверны', async () => {
    const { panel, settings, field } = makePanel();
    savesDb.clear();
    pickFile(field('stdoom-field-iwad'), fakeFile('doom2.wad', doom2Wad));
    await flush();

    const dump = JSON.stringify(settings);
    assert(!/IWAD|user-iwad|DOOM2\.WAD/.test(dump), `в настройках файла нет: ${dump}`);
    assert(dump.length < 400, 'настройки остались крошечными');
    panel.destroy();
});

// --- Громкость

await test('ползунок громкости правит настройку и сохраняется', () => {
    const { panel, settings, changes, field } = makePanel();
    const slider = field('stdoom-field-volume');
    assert(slider, 'ползунок есть');
    assertEqual(slider.type, 'range', 'именно ползунок');
    assertEqual(slider.min, '0', 'от нуля');
    assertEqual(slider.max, '100', 'до сотни процентов');

    slider.value = '40';
    fire(slider, 'input');

    assertEqual(settings.volume, 40, 'настройка изменилась');
    assertEqual(JSON.stringify(changes.at(-1)), JSON.stringify(['volume', 40]), 'изменение ушло наружу');
    assertEqual(field('stdoom-volume-value').textContent, '40%', 'подпись');
    panel.destroy();
});

await test('громкость подтягивается из настроек при открытии панели', () => {
    const { panel, field } = makePanel({ volume: 15 });
    panel.open();
    // То же место, где живёт чувствительность мыши: extensionSettings, а значит
    // значение переживает перезагрузку страницы.
    assertEqual(field('stdoom-field-volume').value, '15', 'значение восстановлено');
    assertEqual(field('stdoom-volume-value').textContent, '15%', 'подпись тоже');
    panel.destroy();
});

await test('битая громкость из правленого руками settings.json не даёт тишины', () => {
    const { panel, field } = makePanel({ volume: 'погромче' });
    panel.open();
    // Мусор → полная громкость: молча оставить игрока без звука хуже, чем
    // проигнорировать неверное значение.
    assertEqual(field('stdoom-field-volume').value, '100', 'откат на 100%');
    panel.destroy();
});

await test('громкость зажимается границами 0…100', () => {
    const { panel, settings, field } = makePanel();
    const slider = field('stdoom-field-volume');

    slider.value = '999';
    fire(slider, 'input');
    assertEqual(settings.volume, 100, 'выше сотни не пускаем');

    slider.value = '-40';
    fire(slider, 'input');
    assertEqual(settings.volume, 0, 'ниже нуля тоже');
    panel.destroy();
});

// --- Справка по управлению
//
// Причина, по которой она вообще есть: раскладка не оригинальная — стрелки крутят
// камеру и НЕ ходят (§5.2), а в ванильном DOOM одна клавиша на действие, так что
// «и WASD, и стрелки на движение» выразить нечем. Игрок, жмущий стрелки по привычке,
// поворачивается на месте и решает, что застрял. Так и вышло на живой проверке.

await test('панель показывает раскладку — иначе игрок остаётся с догадками', () => {
    const { panel } = makePanel();
    const box = panel.element.querySelector('.stdoom-panel-controls');
    assert(box, 'блок справки есть');

    const keys = [...box.querySelectorAll('.stdoom-controls-keys')].map((el) => el.textContent);
    const text = box.textContent;

    assert(keys.some((k) => k.includes('W')), 'движение на WASD названо');
    assert(keys.some((k) => k.includes('←')), 'поворот стрелками назван');
    assert(text.includes('Пробел'), 'Use назван — им открываются двери');
    assert(/Ctrl/.test(text), 'огонь назван');

    panel.destroy();
});

await test('справка прямо предупреждает, что стрелки не ходят', () => {
    const { panel } = makePanel();
    const rows = [...panel.element.querySelectorAll('.stdoom-controls-keys')];
    const arrows = rows.find((el) => el.textContent.includes('←'));
    const what = arrows.nextElementSibling.textContent;
    // Это и есть та самая ловушка: без явной оговорки строка «поворот» читается как
    // «стрелки — управление», и игрок не догадывается нажать W.
    assert(/НЕ идут|не идут/.test(what), `оговорка про движение есть, а не «${what}»`);
    panel.destroy();
});

await test('справка не мешает настройкам: поля и слоты файлов на месте', () => {
    const { panel, field } = makePanel();
    assert(field('stdoom-field-cycles'), 'поле циклов на месте');
    assert(panel.element.querySelector('.stdoom-panel-controls'), 'и справка рядом');
    // Порядок важен для чтения: справка после настроек, но до кнопок действий.
    const children = [...panel.element.children].map((el) => el.className);
    const help = children.findIndex((c) => c.includes('stdoom-panel-controls'));
    const actions = children.findIndex((c) => c.includes('stdoom-panel-actions'));
    assert(help > 0 && actions > help, `справка перед кнопками: ${children.join(' | ')}`);
    panel.destroy();
});


report('settings-panel');
