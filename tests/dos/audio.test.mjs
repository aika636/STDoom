// Тесты обёртки звука (§4.5). Главный инвариант: soundFrequency() === 0 — это НОРМА
// (режим AudioWorklet), а ненулевая частота означает тихий откат в устаревший режим.
// DOM здесь не нужен, только подмена AudioContext.
//
// Запуск: node tests/dos/audio.test.mjs

import {
    EXPECTED_SAMPLE_RATE, createAudioControl, probeSampleRate,
} from '../../src/dos/audio.js';
import { assert, assertEqual, report, test } from '../_harness.mjs';

console.log('dos audio');

/** Перехват console.warn: предупреждение о деградации — часть контракта модуля. */
function captureWarnings(fn) {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        return { result: fn(), warnings };
    } finally {
        console.warn = original;
    }
}

function makeCi({ frequency = 0 } = {}) {
    const calls = [];
    return {
        calls,
        soundFrequency: () => frequency,
        mute: () => calls.push('mute'),
        unmute: () => calls.push('unmute'),
    };
}

// --- Частота 0 — это норма ----------------------------------------------------

test('§4.5: soundFrequency() === 0 — норма, режим AudioWorklet', () => {
    const { result: audio, warnings } = captureWarnings(
        () => createAudioControl(makeCi({ frequency: 0 })),
    );
    assertEqual(audio.degraded, false, 'деградации нет');
    assertEqual(warnings.length, 0, 'предупреждений нет');
});

test('§4.5: ненулевая частота — деградация с предупреждением', () => {
    const { result: audio, warnings } = captureWarnings(
        () => createAudioControl(makeCi({ frequency: 44100 })),
    );
    assertEqual(audio.degraded, true, 'откат в onSoundPush распознан');
    assertEqual(warnings.length, 1, 'предупреждение выдано ровно одно');
    assert(warnings[0].includes('44100'), 'в предупреждении указана частота');
    assert(/onSoundPush/.test(warnings[0]), 'названа причина — устаревший режим');
});

test('§4.5: недоступный soundFrequency() не роняет создание обёртки', () => {
    const { result: audio, warnings } = captureWarnings(() => createAudioControl({
        soundFrequency: () => { throw new Error('нет такого метода'); },
        mute: () => {},
        unmute: () => {},
    }));
    assertEqual(audio.degraded, false, 'частота осталась нулевой — считаем нормой');
    assertEqual(warnings.length, 1, 'о недоступности предупредили');
});

// --- mute / unmute ------------------------------------------------------------

test('setMuted зовёт mute/unmute и не дёргает их повторно на том же значении', () => {
    const ci = makeCi();
    const audio = createAudioControl(ci);
    assertEqual(audio.muted, false, 'стартуем со звуком');

    audio.setMuted(false);
    assertEqual(ci.calls.length, 0, 'значение не изменилось — эмулятор не трогаем');

    audio.setMuted(true);
    assertEqual(ci.calls.join(','), 'mute', 'один mute');
    audio.setMuted(true);
    audio.setMuted(true);
    assertEqual(ci.calls.join(','), 'mute', 'повторы не проходят');

    audio.setMuted(false);
    assertEqual(ci.calls.join(','), 'mute,unmute', 'снятие — один unmute');
    assertEqual(audio.muted, false, 'состояние обновлено');
});

test('setMuted приводит аргумент к булеву', () => {
    const ci = makeCi();
    const audio = createAudioControl(ci);
    audio.setMuted(1);
    assertEqual(audio.muted, true, 'истинное значение включает mute');
    audio.setMuted('');
    assertEqual(audio.muted, false, 'ложное — unmute');
    assertEqual(ci.calls.join(','), 'mute,unmute', 'по одному вызову на переход');
});

test('startMuted = true глушит звук сразу при создании', () => {
    const ci = makeCi();
    const audio = createAudioControl(ci, true);
    assertEqual(audio.muted, true, 'стартуем без звука');
    assertEqual(ci.calls.join(','), 'mute', 'ровно один mute');
});

test('toggle() переключает состояние', () => {
    const ci = makeCi();
    const audio = createAudioControl(ci);
    assertEqual(audio.toggle(), true, 'первый переключатель глушит');
    assertEqual(audio.toggle(), false, 'второй возвращает звук');
    assertEqual(ci.calls.join(','), 'mute,unmute', 'по вызову на переключение');
});

test('падение ci.mute() не меняет состояние и не выбрасывает наружу', () => {
    const ci = {
        soundFrequency: () => 0,
        mute: () => { throw new Error('сессия закрыта'); },
        unmute: () => {},
    };
    const { result: audio, warnings } = captureWarnings(() => {
        const control = createAudioControl(ci);
        control.setMuted(true);
        return control;
    });
    assertEqual(audio.muted, false, 'состояние не съехало');
    assertEqual(warnings.length, 1, 'о неудаче предупредили');
});

// --- probeSampleRate ----------------------------------------------------------

test('probeSampleRate: 44100 Гц — молча, контекст закрывается', () => {
    let closed = false;
    globalThis.AudioContext = class { constructor() { this.sampleRate = 44100; } close() { closed = true; } };
    const { result, warnings } = captureWarnings(() => probeSampleRate());
    assertEqual(result, EXPECTED_SAMPLE_RATE, 'частота возвращена');
    assertEqual(warnings.length, 0, 'ожидаемая частота — без предупреждений');
    assert(closed, 'пробный контекст закрыт');
    delete globalThis.AudioContext;
});

test('probeSampleRate: 48000 Гц — предупреждение о вероятном откате', () => {
    globalThis.AudioContext = class { constructor() { this.sampleRate = 48000; } close() {} };
    const { result, warnings } = captureWarnings(() => probeSampleRate());
    assertEqual(result, 48000, 'фактическая частота возвращена как есть');
    assertEqual(warnings.length, 1, 'предупредили');
    assert(warnings[0].includes('48000'), 'указана фактическая частота');
    delete globalThis.AudioContext;
});

test('probeSampleRate: без AudioContext возвращает 0 с предупреждением', () => {
    const saved = globalThis.AudioContext;
    delete globalThis.AudioContext;
    delete globalThis.webkitAudioContext;
    const { result, warnings } = captureWarnings(() => probeSampleRate());
    assertEqual(result, 0, 'ноль');
    assertEqual(warnings.length, 1, 'предупредили');
    if (saved) globalThis.AudioContext = saved;
});

test('probeSampleRate: конструктор бросил — возвращаем 0, не падаем', () => {
    globalThis.AudioContext = class { constructor() { throw new Error('нет аудиоустройства'); } };
    const { result, warnings } = captureWarnings(() => probeSampleRate());
    assertEqual(result, 0, 'ноль');
    assertEqual(warnings.length, 1, 'предупредили');
    delete globalThis.AudioContext;
});

report('dos audio');
