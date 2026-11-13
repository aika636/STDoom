// Звук.
//
// Мы запускаем эмулятор с `options.audioWorklet: true`: тогда `emulators` сам
// создаёт AudioContext на 44100 Гц и гонит сэмплы напрямую из wasm в AudioWorklet,
// минуя главный поток. Своего кода отрисовки звука здесь поэтому нет — модуль
// тонкий и занимается тремя вещами:
//
//   1. проверкой, что режим worklet действительно включился;
//   2. mute/unmute и ГРОМКОСТЬЮ (см. ниже — она стоит отдельного объяснения);
//   3. диагностикой типовой поломки «музыки нет, ошибок нет».
//
// ПРО ГРОМКОСТЬ. Громкость нельзя отдать полям sfx_volume/music_volume в DEFAULT.CFG:
// те поля читаются ОДИН раз, при запуске игры, и крутить их на лету нельзя, а менять громкость
// хочется во время игры. Со стороны эмулятора рычага нет вовсе — весь его словарь
// команд это `wc-mute` и `wc-unmute` (проверено по `assets/jsdos/wdosbox.js`), никакого
// уровня там не предусмотрено.
//
// Поэтому регулятор наш собственный и живёт в Web Audio: между узлом js-dos и выходом
// вставляется GainNode. Сложность в том, что весь аудиограф js-dos строит внутри себя
// и наружу не отдаёт ничего: он создаёт свой AudioContext и делает
// `node.connect(context.destination)` — ни контекста, ни узла в API нет. Единственная
// зацепка — ИМЯ процессора, `jsdos-audio`: по нему свой узел узнаётся однозначно.
// Отсюда `installGainHook()` — он подменяет глобальный AudioWorkletNode подклассом,
// помечает узлы с этим именем и на их `connect(destination)` вставляет GainNode.
//
// Хук намеренно узкий: для всех ЧУЖИХ узлов (у таверны и других расширений может быть
// свой звук) поведение остаётся ровно прежним, ветка с подменой до них не доходит.
//
// Важное следствие режима worklet: ci.soundFrequency() вернёт 0, а onSoundPush
// не вызовется НИКОГДА. Это не баг, а признак того, что всё работает правильно.
// Если частота ненулевая — `emulators` тихо откатился в устаревший режим
// ScriptProcessorNode, и об этом надо узнать из лога, а не по тишине в наушниках.

import { logInfo, logWarn } from '../log.js';

/** Частота, которую ожидает worklet-путь js-dos. */
export const EXPECTED_SAMPLE_RATE = 44100;

/**
 * Проверяет, отдаст ли браузер AudioContext на 44100 Гц.
 * Если нет — worklet-путь js-dos не заведётся и произойдёт тихий откат.
 *
 * Пробуем ровно так же, как это делает сам js-dos: `new AudioContext({sampleRate: 44100})`.
 * Проверять контекст по умолчанию бессмысленно — устройство почти всегда работает на
 * 48000, но явно запрошенную частоту браузер выдаёт, ресемплируя сам.
 * Пробный контекст сразу закрываем.
 *
 * @returns {number} фактическая частота или 0, если проверить не удалось
 */
export function probeSampleRate() {
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) {
        logWarn('AudioContext недоступен — звука не будет');
        return 0;
    }
    let probe = null;
    try {
        probe = new Ctor({ sampleRate: EXPECTED_SAMPLE_RATE, latencyHint: 'interactive' });
        const rate = probe.sampleRate;
        if (rate !== EXPECTED_SAMPLE_RATE) {
            logWarn(
                `частота аудиоустройства ${rate} Гц вместо ${EXPECTED_SAMPLE_RATE} — ` +
                'js-dos откатится в режим onSoundPush, звук может пропасть',
            );
        }
        return rate;
    } catch (err) {
        logWarn('не удалось проверить частоту AudioContext', err);
        return 0;
    } finally {
        try { probe?.close(); } catch { /* закрытие пробного контекста не критично */ }
    }
}

/** Имя процессора, под которым js-dos регистрирует свой AudioWorklet. */
const JSDOS_PROCESSOR = 'jsdos-audio';

/** Громкость 0…1. Живёт на уровне модуля: узел появляется позже, чем её задают. */
let masterVolume = 1;
/** Текущий регулятор. null — если хук не встал или worklet ещё не собрался. */
let gainNode = null;
let hookInstalled = false;

function clampVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 1;
    return Math.max(0, Math.min(1, number));
}

/**
 * Вставляет GainNode между узлом js-dos и выходом звуковой карты.
 *
 * Зовётся ДО запуска эмулятора: граф собирается во время загрузки, и опоздавший хук
 * не увидит `connect()`. Повторные вызовы безвредны.
 *
 * @returns {boolean} удалось ли поставить хук
 */
export function installGainHook() {
    if (hookInstalled) return true;
    const Base = globalThis.AudioWorkletNode;
    if (typeof Base !== 'function') {
        logWarn('AudioWorkletNode недоступен — регулятор громкости не встанет');
        return false;
    }

    // WeakSet, а не свойство на узле: чужой объект метить своими полями незачем,
    // а держать его от сборки мусора — тем более.
    const ours = new WeakSet();
    const baseConnect = Base.prototype.connect;

    class StdoomAudioWorkletNode extends Base {
        constructor(context, name, options) {
            super(context, name, options);
            if (name === JSDOS_PROCESSOR) ours.add(this);
        }
    }

    Base.prototype.connect = function connect(destination, ...rest) {
        // Чужие узлы и любые соединения, кроме «прямо на выход», идут как раньше:
        // хук обязан быть невидимым для всех, кроме одного конкретного случая.
        if (!ours.has(this) || !this.context || destination !== this.context.destination) {
            return baseConnect.call(this, destination, ...rest);
        }
        try {
            const gain = this.context.createGain();
            gain.gain.value = masterVolume;
            baseConnect.call(this, gain);
            const result = gain.connect(destination);
            gainNode = gain;
            logInfo('регулятор громкости подключён');
            return result;
        } catch (err) {
            // Не смогли — звук важнее громкости: соединяем напрямую, как без хука.
            logWarn('не удалось вставить регулятор громкости', err);
            return baseConnect.call(this, destination, ...rest);
        }
    };

    globalThis.AudioWorkletNode = StdoomAudioWorkletNode;
    hookInstalled = true;
    return true;
}

/**
 * Ставит громкость. Значение запоминается, даже если узла ещё нет: граф js-dos
 * собирается асинхронно, и настройка почти всегда приходит раньше него.
 *
 * @param {number} value 0…1
 * @returns {number} применённое значение
 */
export function setMasterVolume(value) {
    masterVolume = clampVolume(value);
    if (gainNode) {
        try {
            gainNode.gain.value = masterVolume;
        } catch (err) {
            logWarn('не удалось применить громкость', err);
        }
    }
    return masterVolume;
}

export function getMasterVolume() {
    return masterVolume;
}

/** Есть ли живой регулятор. false означает, что ползунок ни на что не влияет. */
export function hasGainNode() {
    return gainNode !== null;
}

/** Только для тестов: вернуть модуль в исходное состояние. */
export function resetGainHookForTests() {
    gainNode = null;
    hookInstalled = false;
    masterVolume = 1;
}

/**
 * Обёртка управления звуком запущенной сессии.
 * @param {object} ci CommandInterface
 * @param {boolean} [startMuted=false]
 * @param {number} [startVolume=1] громкость 0…1
 */
export function createAudioControl(ci, startMuted = false, startVolume = 1) {
    let muted = false;

    // В worklet-режиме частота 0 — это норма. Ненулевая означает откат.
    let frequency = 0;
    try {
        frequency = ci.soundFrequency();
    } catch (err) {
        logWarn('ci.soundFrequency() недоступен', err);
    }
    if (frequency === 0) {
        logInfo('звук: режим AudioWorklet (soundFrequency = 0, это ожидаемо)');
    } else {
        logWarn(
            `звук: js-dos откатился в режим onSoundPush (soundFrequency = ${frequency}). ` +
            'Скорее всего, AudioContext не дал 44100 Гц. Звука, вероятно, не будет.',
        );
    }

    function setMuted(next) {
        const value = Boolean(next);
        if (value === muted) return muted;
        try {
            if (value) ci.mute(); else ci.unmute();
            muted = value;
        } catch (err) {
            logWarn('переключение звука не удалось', err);
        }
        return muted;
    }

    if (startMuted) setMuted(true);
    setMasterVolume(startVolume);

    return {
        get muted() { return muted; },
        /** true, если сработал аварийный откат и звука, скорее всего, нет. */
        get degraded() { return frequency !== 0; },
        get volume() { return getMasterVolume(); },
        /** true, если регулятор реально встал в граф. */
        get hasVolumeControl() { return hasGainNode(); },
        setMuted,
        setVolume: setMasterVolume,
        toggle: () => setMuted(!muted),
    };
}
