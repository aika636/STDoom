// Тесты каркаса под jsdom: кнопка в wand-меню, слэш-команда, гвард одной
// сессии, опции попапа (в первую очередь allowEscapeClose: false) и жизненный цикл
// содержимого окна.
//
// Требуется jsdom: npm install --no-save jsdom
// Запуск: node tests/shell/shell.test.mjs

import { JSDOM } from 'jsdom';
import { assert, assertEqual, report, test } from '../_harness.mjs';

const dom = new JSDOM(
    '<!doctype html><html><body><div id="extensionsMenu"></div><textarea id="send_textarea"></textarea></body></html>',
    { pretendToBeVisual: true },
);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

const slashCommands = [];
// Каждый показ окна: тип попапа, содержимое и опции — на них и держатся проверки.
const popupCalls = [];

// Заглушка класса Popup таверны: вставляет содержимое в документ (настоящий попап
// делает то же самое) и даёт ручку на программное закрытие.
let livePopup = null;
class PopupStub {
    constructor(content, type, value, options) {
        popupCalls.push({ content, type, options, via: 'Popup' });
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

const context = {
    extensionSettings: {},
    saveSettingsDebounced: () => {},
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2, DISPLAY: 4 },
    Popup: PopupStub,
    callGenericPopup: null,
    SlashCommandParser: {
        addCommandObject: (command) => slashCommands.push(command),
    },
    SlashCommand: { fromProps: (props) => props },
};

globalThis.SillyTavern = { getContext: () => context };

const { isOpen, openShell } = await import('../../src/shell/modal.js');
const { initSlashCommands, initWandButton } = await import('../../src/shell/launcher.js');

// Промисы внутри openShell рвутся на несколько тиков (showPopup — async), поэтому
// ждём макрозадачу, а не один микротик.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Одна сессия: открываем окно, отдаём тело теста, затем закрываем — как игрок кнопкой.
async function session(options, body) {
    livePopup = null;
    const opened = openShell(options);
    await flush();
    const root = document.querySelector('.stdoom-root');
    try {
        await body(root);
    } finally {
        livePopup?.completeCancelled();
        await opened;
    }
}

console.log('shell (jsdom)');

// --- Точки запуска

await test('кнопка в wand-меню вставляется идемпотентно', () => {
    const menu = document.getElementById('extensionsMenu');

    assertEqual(initWandButton(), true, 'первая вставка');
    assertEqual(menu.querySelectorAll('#stdoom_wand_button').length, 1, 'кнопок после первой вставки');

    assertEqual(initWandButton(), true, 'повторная вставка');
    assertEqual(initWandButton(), true, 'третья вставка');
    assertEqual(menu.querySelectorAll('#stdoom_wand_button').length, 1, 'кнопок после повторов');

    const button = document.getElementById('stdoom_wand_button');
    assertEqual(button.textContent, 'STDoom', 'подпись кнопки');
});

await test('слэш-команда /doom регистрируется', () => {
    assertEqual(initSlashCommands(), true, 'регистрация');
    assertEqual(slashCommands.length, 1, 'команд зарегистрировано');
    assertEqual(slashCommands[0].name, 'doom', 'имя команды');
    assertEqual(typeof slashCommands[0].callback, 'function', 'колбэк команды');
});

await test('клик по кнопке в меню открывает окно', async () => {
    document.getElementById('stdoom_wand_button').click();
    await flush();
    assert(isOpen(), 'сессия открыта');
    assert(document.querySelector('.stdoom-root'), 'корень окна в документе');

    livePopup.completeCancelled();
    await flush();
    assert(!isOpen(), 'сессия закрыта');
});

// --- Попап

await test('попап открывается с allowEscapeClose: false', async () => {
    popupCalls.length = 0;
    await session({}, () => {
        assertEqual(popupCalls.length, 1, 'показов попапа');
        const { type, options } = popupCalls[0];
        assertEqual(type, context.POPUP_TYPE.DISPLAY, 'тип попапа — DISPLAY');
        // Esc принадлежит DOOM. Если этот тест покраснел — правило сломали.
        assertEqual(options.allowEscapeClose, false, 'allowEscapeClose');
        assertEqual(options.wider, true, 'wider');
        // large даёт попапу высоту 90% экрана. Без него wider тянул только ширину,
        // высота оставалась по содержимому, и игровое поле выходило крошечным —
        // при том что DOOM растягивается как угодно.
        assertEqual(options.large, true, 'large — иначе окно съёживается по содержимому');
    });
});

await test('callGenericPopup получает те же опции, а закрытие идёт через крестик ST', async () => {
    popupCalls.length = 0;
    const savedPopup = context.Popup;
    context.Popup = undefined;

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    // Повторяем разметку попапа ST: содержимое внутри <dialog>, крестик рядом.
    const dialog = document.createElement('dialog');
    const cross = document.createElement('div');
    cross.className = 'popup-button-close';
    cross.addEventListener('click', () => {
        dialog.remove();
        release();
    });
    dialog.appendChild(cross);
    document.body.appendChild(dialog);

    context.callGenericPopup = (content, type, value, options) => {
        popupCalls.push({ content, type, options, via: 'callGenericPopup' });
        dialog.appendChild(content);
        return held;
    };

    const opened = openShell();
    await flush();

    assertEqual(popupCalls.length, 1, 'показов попапа');
    assertEqual(popupCalls[0].via, 'callGenericPopup', 'путь показа');
    assertEqual(popupCalls[0].options.allowEscapeClose, false, 'allowEscapeClose');

    // Ручки на закрытие callGenericPopup не даёт — жмём крестик самой таверны.
    document.querySelector('.stdoom-close').click();
    await opened;
    assert(!isOpen(), 'сессия закрыта крестиком ST');

    context.Popup = savedPopup;
    context.callGenericPopup = null;
});

await test('гвард одной сессии: второе окно не открывается', async () => {
    popupCalls.length = 0;
    await session({}, async () => {
        assert(isOpen(), 'первая сессия открыта');
        await openShell();
        await flush();
        assertEqual(popupCalls.length, 1, 'показов попапа после второй попытки');
        assertEqual(document.querySelectorAll('.stdoom-root').length, 1, 'корней окна в документе');
    });
    assert(!isOpen(), 'сессия закрыта');
});

// --- Разметка и жизненный цикл содержимого

await test('окно собирает рамку, поле и кнопки', async () => {
    await session({}, (root) => {
        assert(root.querySelector('.stdoom-frame'), 'рамка');
        assert(root.querySelector('.stdoom-toolbar'), 'панель кнопок');
        assert(root.querySelector('.stdoom-stage .stdoom-screen'), 'поле под канвас внутри сцены');
        assert(root.querySelector('.stdoom-close'), 'кнопка закрытия');
        assert(root.querySelector('.stdoom-sound'), 'кнопка звука');
        assert(root.querySelector('.stdoom-settings'), 'кнопка настроек');
        assert(root.querySelector('.stdoom-start .stdoom-play'), 'кнопка «Играть» поверх поля');
        // Без init поле пустое: содержимое всегда приходит извне (dos/session.js),
        // своего запасного наполнения окно не рисует.
        assertEqual(root.querySelector('.stdoom-screen').children.length, 0, 'поле пустое без init');
    });
});

// --- Экран отказа

await test('экран отказа есть в разметке и по умолчанию скрыт', async () => {
    await session({}, (root) => {
        const failure = root.querySelector('.stdoom-stage > .stdoom-failure');
        assert(failure, 'оверлей лежит поверх сцены, а не внутри игрового поля');
        assertEqual(failure.hidden, true, 'пока ничего не сломалось — скрыт');
        assertEqual(failure.querySelectorAll('button').length, 0, 'кнопок нет');
    });
});

await test('showFailure показывает текст и кнопки, hideFailure убирает всё', async () => {
    let refs = null;
    const clicks = [];

    await session({ init: (r) => { refs = r; } }, (root) => {
        const failure = root.querySelector('.stdoom-failure');

        refs.showFailure({
            title: 'Картинка перестала обновляться',
            text: 'Отрисовка сломалась 30 раз подряд, прогресс сохранён.',
            actions: [
                { label: 'Продолжить', primary: true, onClick: () => clicks.push('go') },
                { label: 'Закрыть', onClick: () => clicks.push('close') },
            ],
        });

        assertEqual(failure.hidden, false, 'экран показан');
        assert(/перестала обновляться/.test(failure.textContent), 'заголовок на экране');
        assert(/прогресс сохранён/.test(failure.textContent),
            'пустой экран читается как зависание — текст обязателен');

        const buttons = failure.querySelectorAll('button');
        assertEqual(buttons.length, 2, 'обе кнопки');
        assertEqual(buttons[0].textContent, 'Продолжить', 'первая кнопка');
        buttons[0].click();
        buttons[1].click();
        assertEqual(clicks.join(','), 'go,close', 'обработчики привязаны');

        refs.hideFailure();
        assertEqual(failure.hidden, true, 'экран убран');
        assertEqual(failure.querySelectorAll('button').length, 0,
            'кнопки уехали вместе с ним — скрытый экран не держит ссылок на сессию');
        assertEqual(failure.textContent, '', 'текста тоже не осталось');
    });
});

await test('упавшая кнопка экрана отказа не роняет окно', async () => {
    let refs = null;
    await session({ init: (r) => { refs = r; } }, (root) => {
        refs.showFailure({
            title: 'Поломка',
            text: 'текст',
            actions: [{ label: 'Кнопка', onClick: () => { throw new Error('тестовая поломка'); } }],
        });
        root.querySelector('.stdoom-failure button').click();
        assert(isOpen(), 'окно живо, причина уехала в консоль');
    });
});

await test('init получает ссылки на элементы, teardown зовётся при закрытии', async () => {
    let refs = null;
    let torn = 0;

    await session({
        init: (r) => {
            refs = r;
            const canvas = document.createElement('canvas');
            r.screen.appendChild(canvas);
            return () => { torn++; canvas.remove(); };
        },
    }, (root) => {
        assert(refs, 'init вызван');
        assertEqual(refs.screen, root.querySelector('.stdoom-screen'), 'ссылка на поле');
        assert(root.querySelector('.stdoom-screen canvas'), 'канвас вставлен в поле');
        assertEqual(refs.screen.children.length, 1, 'в поле только то, что положил init');
        assertEqual(torn, 0, 'teardown до закрытия не зовётся');
    });

    assertEqual(torn, 1, 'teardown после закрытия');
});

await test('«Играть» убирает оверлей, помечает сессию запущенной и зовёт onStart', async () => {
    let started = 0;
    let refs = null;

    await session({
        init: (r) => { refs = r; },
        onStart: () => { started++; },
    }, (root) => {
        const overlay = root.querySelector('.stdoom-start');
        assertEqual(overlay.hidden, false, 'до старта оверлей виден');
        assertEqual(refs.isRunning(), false, 'до старта сессия не запущена');

        root.querySelector('.stdoom-play').click();

        assertEqual(overlay.hidden, true, 'после старта оверлей скрыт');
        assertEqual(started, 1, 'onStart вызван');
        assertEqual(refs.isRunning(), true, 'сессия помечена запущенной');
    });
});

await test('сломанный init не мешает окну открыться и закрыться', async () => {
    await session({
        init: () => { throw new Error('тестовая поломка'); },
    }, (root) => {
        assert(root.querySelector('.stdoom-frame'), 'рамка на месте');
        assert(isOpen(), 'сессия открыта');
    });
    assert(!isOpen(), 'сессия закрыта');
});

// --- Закрытие

await test('кнопка закрытия закрывает окно без подтверждения, пока игра не запущена', async () => {
    const opened = openShell();
    await flush();

    const root = document.querySelector('.stdoom-root');
    root.querySelector('.stdoom-close').click();
    await opened;

    assert(!isOpen(), 'сессия закрыта');
    assert(!document.querySelector('.stdoom-root'), 'разметка убрана');
});

await test('на запущенной игре закрытие спрашивает подтверждение', async () => {
    const asked = [];
    let answer = false;
    context.callGenericPopup = (message, type) => {
        asked.push({ message, type });
        return Promise.resolve(answer);
    };

    const opened = openShell();
    await flush();

    const root = document.querySelector('.stdoom-root');
    root.querySelector('.stdoom-play').click();

    // Отказ: окно остаётся открытым.
    root.querySelector('.stdoom-close').click();
    await flush();
    assertEqual(asked.length, 1, 'подтверждение запрошено');
    assertEqual(asked[0].type, context.POPUP_TYPE.CONFIRM, 'тип подтверждения');
    assert(isOpen(), 'после отказа окно живо');

    // Согласие: окно закрывается.
    answer = true;
    root.querySelector('.stdoom-close').click();
    await opened;
    assertEqual(asked.length, 2, 'подтверждение запрошено второй раз');
    assert(!isOpen(), 'после согласия окно закрыто');

    context.callGenericPopup = null;
});

await test('без попапа ST окно показывается своим оверлеем', async () => {
    const savedPopup = context.Popup;
    context.Popup = undefined;
    context.callGenericPopup = null;

    const opened = openShell();
    await flush();

    const overlay = document.querySelector('.stdoom-overlay');
    assert(overlay, 'свой оверлей показан');
    assert(overlay.querySelector('.stdoom-dialog .stdoom-root'), 'окно внутри оверлея');

    overlay.querySelector('.stdoom-close').click();
    await opened;

    assert(!document.querySelector('.stdoom-overlay'), 'оверлей убран');
    assert(!isOpen(), 'сессия закрыта');

    context.Popup = savedPopup;
});

// --- Звук

await test('кнопка звука переключает настройку', async () => {
    await session({}, (root) => {
        const button = root.querySelector('.stdoom-sound');
        assertEqual(button.textContent, 'Звук: вкл', 'подпись по умолчанию');

        button.click();
        assertEqual(context.extensionSettings.STDoom.sound, false, 'настройка выключена');
        assertEqual(button.textContent, 'Звук: выкл', 'подпись после выключения');

        button.click();
        assertEqual(context.extensionSettings.STDoom.sound, true, 'настройка включена обратно');
    });
});

report('shell');
