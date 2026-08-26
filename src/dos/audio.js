// Звук (план §4.5).
//
// Мы запускаем эмулятор с `options.audioWorklet: true`: тогда `emulators` сам
// создаёт AudioContext на 44100 Гц и гонит сэмплы напрямую из wasm в AudioWorklet,
// минуя главный поток. Своего кода отрисовки звука здесь поэтому нет — модуль
// тонкий и занимается тремя вещами:
//
//   1. проверкой, что режим worklet действительно включился;
//   2. mute/unmute (единственное доступное управление громкостью — слайдера не будет,
//      громкость живёт в sfx_volume/music_volume внутри DEFAULT.CFG);
//   3. диагностикой типовой поломки «музыки нет, ошибок нет».
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

/**
 * Обёртка управления звуком запущенной сессии.
 * @param {object} ci CommandInterface
 * @param {boolean} [startMuted=false]
 */
export function createAudioControl(ci, startMuted = false) {
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

    return {
        get muted() { return muted; },
        /** true, если сработал аварийный откат и звука, скорее всего, нет. */
        get degraded() { return frequency !== 0; },
        setMuted,
        toggle: () => setMuted(!muted),
    };
}
