// Склейка окна и эмулятора.
//
// Модуль знает и про DOM окна (refs из shell/modal.js), и про рантайм DOSBox, но
// сам не содержит ни того, ни другого: окно рисует modal.js, эмулятор ведёт
// dos/runtime.js. Здесь — только порядок событий и уборка за собой.

import { logError, logInfo, logWarn } from '../log.js';
import { toast } from '../ctx.js';
import { getSettings, normalizeTouchMode } from '../settings.js';
import { startDoom, volumeFraction } from './runtime.js';
import { createAutosave } from './autosave.js';
import { createKeyBus } from '../input/key-bus.js';
import { createKeyboard } from '../input/keyboard.js';
import { createMouse } from '../input/mouse.js';
import { createTouch, detectTouch } from '../input/touch.js';
import { createGamepad } from '../input/gamepad.js';
import { DEFAULT_TURN_SENSITIVITY } from '../input/touch-layout.js';
import { createDebugOverlay } from '../shell/debug-overlay.js';
import { createTouchOverlay } from '../shell/touch-overlay.js';

/** Человеческие подписи стадий загрузки для строки состояния. */
const STAGE_TEXT = {
    'loading-api': 'загрузка эмулятора…',
    'loading-bundle': 'загрузка DOOM…',
    'loading-iwad': 'подготовка своего IWAD…',
    'loading-saves': 'восстановление сейвов…',
    booting: 'запуск DOSBox…',
    extracting: 'распаковка…',
};

/**
 * Создаёт пару обработчиков для openShell({ init, onStart }).
 * Отдельная фабрика нужна, чтобы состояние сессии не жило в модуле:
 * каждое открытие окна получает своё.
 */
export function createDoomSession() {
    let canvas = null;
    let stage = null;       // refs.stage: сцена, поверх которой ложатся оверлеи
    let shell = null;       // refs окна целиком: нужны уборке (экран отказа)
    let doom = null;        // результат startDoom()
    let keyboard = null;
    let mouse = null;
    let touch = null;
    let gamepad = null;
    let autosave = null;   // сохранение по факту сохранения в игре
    let keyBus = null;     // общий счётчик источников на клавишу
    let touchOverlay = null;
    let overlay = null;
    let starting = false;
    let closed = false;
    // Экран отказа показан и ещё не убран. Рендерер и так зовёт колбэк один раз на
    // серию, но игрок мог нажать «Продолжить» — тогда всё начинается заново.
    let failureShown = false;
    const cleanups = [];

    /** Собирает игровое поле. Вызывается до показа окна, эмулятор ещё не тронут. */
    function init(refs) {
        canvas = document.createElement('canvas');
        // Нативный размер VGA; CSS растянет его до 4:3.
        canvas.width = 320;
        canvas.height = 200;
        canvas.className = 'stdoom-canvas';
        // Без tabindex канвас не может получить фокус, а от фокуса зависит, глушим ли
        // мы клавиатуру.
        canvas.tabIndex = 0;
        refs.screen.appendChild(canvas);
        refs.setStatus('готово к запуску');

        stage = refs.stage;
        shell = refs;

        // Пересчёт леттербокса при изменении размеров окна браузера.
        const onResize = () => doom?.renderer.layout();
        window.addEventListener('resize', onResize);
        cleanups.push(() => window.removeEventListener('resize', onResize));

        // Кнопка звука в рамке переключает настройку; нам остаётся применить её к
        // живой сессии. Наш обработчик добавлен позже, поэтому настройка уже обновлена.
        const onSound = () => applySound();
        refs.buttons.sound.addEventListener('click', onSound);
        cleanups.push(() => refs.buttons.sound.removeEventListener('click', onSound));

        // Отладочный оверлей лежит поверх сцены, а не внутри поля: канвас растягивается
        // леттербоксом, и всё, что положено внутрь него, поехало бы вместе с ним.
        overlay = createDebugOverlay({
            box: refs.stage,
            getStats: async () => {
                if (!doom || doom.disposed) return null;
                const stats = await doom.stats();
                // Своя пара цифр рядом с cpuMetrics: без них непонятно, кто отстаёт —
                // эмулятор или отрисовка.
                return {
                    отрисовано: doom.renderer.framesDrawn,
                    'ошибок подряд': doom.renderer.errorsInRow,
                    ...(stats ?? {}),
                };
            },
        });
        cleanups.push(() => { overlay?.destroy(); overlay = null; });

        // Панель настроек правит extensionSettings и сообщает сюда — применяем к
        // живой сессии, без перезапуска DOOM.
        const offSettings = refs.onSettingsChange?.(applySetting);
        if (offSettings) cleanups.push(offSettings);

        // Уход со вкладки: ставим на паузу и сохраняем прогресс. По таймеру
        // не сохраняем — persist() не бесплатен.
        const onVisibility = () => {
            if (!doom || doom.disposed) return;
            if (document.hidden) {
                doom.pause();
                // Взвод по F2 здесь снимаем: persist() ниже сохранит то же самое,
                // а взведённый таймер сделал бы ту же работу второй раз.
                autosave?.cancel();
                doom.persist().catch((err) => logWarn('автосохранение не удалось', err));
            } else {
                doom.resume();
            }
        };
        document.addEventListener('visibilitychange', onVisibility);
        cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

        return teardown;
    }

    /** Нажата «Играть»: только отсюда можно стартовать — звуку нужен жест игрока. */
    function onStart(refs) {
        if (starting || doom) return;
        starting = true;
        refs.setStatus(STAGE_TEXT['loading-api']);

        const settings = readSettings();

        startDoom({
            canvas,
            box: refs.screen,
            settings: {
                cycles: settings.cycles,
                muted: settings.sound === false,
                volume: settings.volume,
            },
            onProgress: (stage, detail) => {
                if (closed) return;
                const text = STAGE_TEXT[stage] ?? stage;
                refs.setStatus(stage === 'extracting' && detail?.file
                    ? `${text} ${detail.file}`
                    : text);
            },
            onExit: () => {
                // DOOM завершился сам (выход из игры через меню). Окно не закрываем
                // молча: игрок должен понимать, что произошло.
                // Эмулятора больше нет: persist() к мёртвой сессии не пойдёт
                // (runtime.js, флаг exited), поэтому взвод снимаем — сохранение
                // за эту сессию уже должно было уехать по F2/F6.
                autosave?.cancel();
                if (closed) return;
                refs.setStatus('игра завершена');
                refs.setRunning(false);
            },
            onRenderFailure: (err) => showRenderFailure(refs, err),
        }).then((session) => {
            if (closed) {
                // Окно успели закрыть, пока грузился wasm, — гасим сразу.
                session.stop().catch((err) => logWarn('остановка осиротевшей сессии', err));
                return;
            }
            doom = session;
            // Проводка после присвоения обязана быть обёрнута: `doom` уже выставлен,
            // и любой бросок внутри (тач, геймпад, автосейв) ушёл бы в общий catch
            // ниже — тот вернул бы оверлей «Играть», а гвард `if (starting || doom)`
            // навсегда запретил бы повторный запуск. Игрок получил бы кнопку,
            // которая молча не делает ничего, и наполовину подключённый ввод.
            try {
                attachInput(refs);
                applySound();
                applyVolume();
                applyDebugOverlay();
            } catch (err) {
                doom = null;
                session.stop().catch((e) => logWarn('остановка недособранной сессии', e));
                throw err;
            }
            refs.setStatus('');
            canvas.focus({ preventScroll: true });
            logInfo('сессия готова');
        }).catch((err) => {
            logError('запуск DOOM не удался', err);
            if (closed) return;
            refs.setRunning(false);
            refs.setStatus(startFailureText(err));
            // Оверлей возвращаем: игрок должен иметь возможность попробовать снова.
            refs.startOverlay.hidden = false;
            toast('error', 'Не удалось запустить DOOM — подробности в консоли');
        }).finally(() => {
            starting = false;
        });
    }

    /**
     * Отрисовка сломалась подряд столько раз, что считать это случайностью нельзя
     *. Замерший кадр без единого слова игрок читает как зависание, поэтому:
     * пауза (крутить эмулятор вслепую незачем), сохранение прогресса и внятный экран
     * с двумя выходами — попробовать дальше или закрыть окно.
     */
    function showRenderFailure(refs, err) {
        // Окно могли уже закрыть: колбэк прилетает из rAF, а он на кадр отстаёт.
        if (closed || failureShown) return;
        if (!doom || doom.disposed) return;
        failureShown = true;

        const limit = doom.renderer.errorLimit ?? 30;
        const lost = Boolean(doom.renderer.contextLost);
        logError(lost ? 'контекст WebGL потерян' : `отрисовка сломалась ${limit} раз подряд`, err);

        doom.pause();
        doom.persist().catch((e) => logWarn('сохранение при отказе отрисовки не удалось', e));

        // Ввод отцепляем, иначе до кнопок экрана отказа не добраться. Экран лежит
        // ВНУТРИ сцены, а тач слушает сцену в фазе перехвата и глушит касание раньше,
        // чем оно дойдёт до кнопки: тап по «Продолжить» ушёл бы в игру
        // поворотом камеры, а сама кнопка не нажалась бы никогда. У мыши то же самое
        // другим путём: при активном Pointer Lock курсора на экране нет вовсе.
        // Пауза сама по себе ввод не снимает — `isActive()` смотрит только на
        // `disposed`, — поэтому снимаем явно и возвращаем в resumeAfterFailure().
        touch?.detach();
        mouse?.detach();

        refs.setStatus('отрисовка сломалась — игра на паузе');
        // Причину называем ту, которая есть на самом деле: потерю контекста мы теперь
        // узнаём событием, а не угадываем по потоку ошибок.
        refs.showFailure?.({
            title: 'Картинка перестала обновляться',
            text: lost
                ? 'Браузер потерял контекст WebGL — рисовать кадры стало нечем. Игра '
                    + 'поставлена на паузу, прогресс сохранён. «Продолжить» попробует '
                    + 'вернуть картинку.'
                : `Отрисовка кадров сломалась ${limit} раз подряд. Игра поставлена на `
                    + 'паузу, прогресс сохранён. Подробности — в консоли браузера.',
            actions: [
                { label: 'Продолжить', primary: true, onClick: () => resumeAfterFailure(refs) },
                { label: 'Закрыть', onClick: () => refs.requestClose?.() },
            ],
        });
    }

    /** «Продолжить»: убрать экран и дать рендеру ещё один шанс — вдруг оправится. */
    function resumeAfterFailure(refs) {
        failureShown = false;
        refs.hideFailure?.();
        if (closed || !doom || doom.disposed) return;
        // Защёлка отказа в рендерере снимается только успешным кадром, а его на
        // сломанном рендере может и не случиться — тогда второй раз экран не пришёл бы
        // вообще. Сбрасываем счётчик сами: следующий отказ снова наберёт свой порог.
        doom.renderer.resetErrors?.();
        // Контекст, потерянный вручную (так эта дорожка и проверяется в чеклисте),
        // сам не вернётся никогда — его надо попросить.
        doom.renderer.recoverContext?.();
        refs.setStatus('');
        // Ввод, снятый на время экрана отказа, возвращаем. attach() идемпотентен:
        // если снимать было нечего, повторный вызов ничего не делает.
        touch?.attach();
        mouse?.attach();
        doom.resume();
        canvas?.focus({ preventScroll: true });
    }

    function attachInput(refs) {
        const settings = readSettings();

        // Один счётчик источников на всю сессию: Ctrl держат и геймпад, и тач, и
        // клавиатура сразу, и отпускать его можно только последнему держателю
        // (правило 22, `input/key-bus.js`). Пока счётчик жил внутри каждого модуля,
        // клавиатурный Ctrl гасил огонь, зажатый на курке геймпада.
        keyBus = createKeyBus({ ci: doom.ci });

        // Сохранение по F2/F6 (dos/autosave.js). Заводится до клавиатуры: она
        // отдаёт ему нажатия наблюдателем и без него не имеет смысла.
        autosave = createAutosave({
            persist: () => (doom && !doom.disposed ? doom.persist() : false),
        });

        keyboard = createKeyboard({
            keys: keyBus.owner('keyboard'),
            surface: canvas,
            isActive: () => Boolean(doom) && !doom.disposed,
            onKey: (code) => autosave?.noteKey(code),
        });
        keyboard.attach();

        mouse = createMouse({
            ci: doom.ci,
            surface: canvas,
            getSensitivity: () => readSettings().mouseSensitivity ?? 1,
        });
        mouse.attach();

        applyTouch();

        // Геймпад. attach() дешёвый и зовётся всегда: пока устройство не
        // подключено, цикл опроса не крутится, а поднимется сам по gamepadconnected.
        // Ждать «а вдруг геймпад есть» здесь нельзя — Chrome не отдаёт его до первого
        // нажатия кнопки.
        gamepad = createGamepad({
            ci: doom.ci,
            keys: keyBus.owner('gamepad'),
            isActive: () => Boolean(doom) && !doom.disposed,
            getSensitivity: () => readSettings().mouseSensitivity ?? 1,
        });
        gamepad.attach();

        refs.setRunning(true);
        logInfo('ввод подключён, чувствительность мыши', settings.mouseSensitivity);
    }

    /**
     * Тач-ввод. Создаётся только когда он уместен: на десктопе с мышью кнопки
     * поверх картинки — это чистая помеха. Режим 'auto' смотрит на само устройство,
     * 'on'/'off' — ручной обход авто-детекта, потому что он ошибается в обе стороны
     * (планшет с клавиатурой, десктоп с сенсорным монитором).
     */
    function applyTouch() {
        if (closed || !doom || !stage) return;
        const mode = normalizeTouchMode(readSettings().touchControls);
        const wanted = mode === 'on' || (mode === 'auto' && detectTouch());

        if (!wanted) {
            touch?.detach();
            touch = null;
            touchOverlay?.destroy();
            touchOverlay = null;
            return;
        }
        if (touch) {
            // Уже подключён — могла поехать только чувствительность/раскладка.
            touch.setTurnSensitivity(turnSensitivity());
            touch.relayout();
            return;
        }

        // Оверлей лежит поверх сцены, а не внутри игрового поля: канвас растягивается
        // леттербоксом, и всё, что положено внутрь него, поехало бы вместе с ним —
        // та же причина, что у отладочного оверлея выше.
        touchOverlay = createTouchOverlay({ box: stage });
        touch = createTouch({
            ci: doom.ci,
            keys: keyBus.owner('touch'),
            surface: stage,
            overlay: touchOverlay,
            getLayout: () => readSettings().touchLayout ?? null,
            isActive: () => Boolean(doom) && !doom.disposed,
            turnSensitivity: turnSensitivity(),
        });
        touch.attach();
        logInfo('тач-контролы подключены, режим', mode);
    }

    /** Свайп-поворот масштабируется той же настройкой, что и мышь: рычаг один. */
    function turnSensitivity() {
        const base = Number(readSettings().mouseSensitivity);
        return (Number.isFinite(base) && base > 0 ? base : 1) * DEFAULT_TURN_SENSITIVITY;
    }

    /**
     * Применение одной настройки к живой сессии. Всё, что здесь не перечислено,
     * применения не требует: обычную мышь `mouseSensitivity` читает сама на каждом
     * движении (getSensitivity), а progressCleared трогает только хранилище сейвов.
     */
    function applySetting(key, value) {
        if (closed) return;
        switch (key) {
            case 'cycles':
                doom?.setCycles(value);
                break;
            case 'sound':
                applySound();
                break;
            case 'volume':
                applyVolume();
                break;
            case 'debugOverlay':
                applyDebugOverlay();
                break;
            case 'touchControls':
            case 'touchLayout':
            // Свайп-поворот, в отличие от мыши, держит чувствительность внутри
            // накопителя дельт и сам её не перечитывает — пересоздаём трекер.
            case 'mouseSensitivity':
                applyTouch();
                break;
            default:
                break;
        }
    }

    function applyDebugOverlay() {
        if (!overlay) return;
        const on = readSettings().debugOverlay === true;
        // Без запущенного эмулятора показывать нечего — цифры берутся из него.
        if (on && doom) overlay.start();
        else overlay.stop();
    }

    /**
     * Громкость (0…100 в настройках, 0…1 в графе). Отдельно от applySound: звук —
     * это mute/unmute у эмулятора, а громкость — наш GainNode, и один другого не
     * заменяет (`dos/audio.js`).
     */
    function applyVolume() {
        if (!doom) return;
        doom.audio.setVolume(volumeFraction(readSettings().volume));
    }

    function applySound() {
        if (!doom) return;
        const on = readSettings().sound !== false;
        doom.audio.setMuted(!on);
        if (doom.audio.degraded && on) {
            // Звук включён, но js-dos откатился в устаревший режим — игрок иначе решит,
            // что сломано именно расширение.
            toast('warning', 'Звук недоступен: браузер не дал 44100 Гц');
        }
    }

    /** Закрытие окна: сначала снять ввод, потом сохранить и погасить эмулятор. */
    function teardown() {
        closed = true;
        // Экран отказа мог остаться на сцене: убираем сами, чтобы он не пережил окно
        // и не удержал ссылки на мёртвую сессию через свои кнопки.
        try { shell?.hideFailure?.(); } catch (err) { logWarn('уборка экрана отказа упала', err); }
        shell = null;
        failureShown = false;
        for (const fn of cleanups.splice(0)) {
            try { fn(); } catch (err) { logWarn('уборка упала', err); }
        }
        keyboard?.detach();
        // Взведённое автосохранение снимаем без записи: прогресс всё равно уедет
        // ниже, в stop(), и делать ту же работу дважды незачем.
        autosave?.cancel();
        autosave = null;
        mouse?.detach();
        // detach() тача обязателен: он отпускает всё зажатое пальцами и гасит
        // таймеры синтетического двойного клика.
        touch?.detach();
        touchOverlay?.destroy();
        // Геймпад держит цикл rAF и подписки на gamepadconnected/focus — без detach()
        // они пережили бы закрытие окна.
        gamepad?.detach();
        keyboard = null;
        mouse = null;
        touch = null;
        touchOverlay = null;
        gamepad = null;

        const session = doom;
        doom = null;
        canvas = null;
        stage = null;
        if (!session) return;
        // Асинхронную остановку не ждём: окно уже закрывается, а прогресс
        // сохраняется внутри stop() до выхода из эмулятора.
        session.stop().catch((err) => logError('остановка сессии упала', err));
    }

    return { init, onStart };
}

function readSettings() {
    try {
        return getSettings();
    } catch (err) {
        logError('не удалось прочитать настройки', err);
        return { cycles: 20000, sound: true, mouseSensitivity: 1 };
    }
}

// Отдельный текст на самую вероятную поломку: экран, на котором ничего не написано,
// игрок читает как зависание.
function startFailureText(err) {
    const message = String(err?.message ?? err);
    if (/doom\.zip/i.test(message)) return 'нет doom.zip — соберите бандл: node tools/build-bundle.mjs';
    if (/emulators\.js|window\.emulators/i.test(message)) return 'не загрузился эмулятор (возможно, CSP таверны)';
    if (/WebGL/i.test(message)) return 'WebGL недоступен в этом браузере';
    return 'ошибка запуска: ' + message;
}
