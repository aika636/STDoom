# Бандл, конфиги, запуск

Конфиги собирает `src/dos/config.js` из одного источника правды (тесты сверяют результат с эталонами
`assets/doom/dosbox.conf` и `assets/doom/DEFAULT.CFG` по ключам и значениям). Эталон `dosbox.conf` в
рантайме не используется. Бандл `assets/doom/doom.zip` собирает `node tools/build-bundle.mjs` (`DOOM.EXE`,
`DOOM1.WAD`, `DEFAULT.CFG`, проверка MD5); `dosbox.conf` в архив не кладётся.

## dosbox.conf (строка в `InitFs`, последним элементом)

Строковый элемент `InitFs` раскладывается в `.jsdos/dosbox.conf`; элементы применяются по порядку, поэтому
строка идёт последней и её не перекрыть содержимым архивов.

| Секция | Значения |
|---|---|
| `[sdl]` | `autolock=false` (Pointer Lock берём сами), `usescancodes=true` |
| `[dosbox]` | `machine=svga_s3`, `memsize=16` (больше 64 ломает DOS/4GW) |
| `[render]` | `frameskip=0`, `aspect=false` (4:3 делает рендерер), `scaler=none` |
| `[cpu]` | `core=normal`, `cputype=auto`, `cycles=20000` |
| `[mixer]` | `rate=49716`, `blocksize=1024`, `prebuffer=20` |
| `[midi]` | `mpu401=none`, `mididevice=none` |
| `[sblaster]` | `sbtype=sbpro2`, `sbbase=220`, `irq=7`, `dma=1`, `hdma=5`, `oplmode=opl3`, `oplemu=default`, `oplrate=49716` |
| `[joystick]` | `joysticktype=none` (геймпад разбираем сами) |
| `[dos]` | `xms/ems/umb=true` |
| `[autoexec]` | `SET DMXOPTION=-opl3` (регистр важен), `mount c .`, `c:`, `DOOM.EXE` |

`sbbase`/`irq`/`dma` обязаны совпадать с `snd_sbport`/`snd_sbirq`/`snd_sbdma` в `DEFAULT.CFG`, иначе тишина
без сообщения об ошибке.

## DEFAULT.CFG

Парсер DOOM (`M_LoadDefaults`, `sscanf "%79s %[^\n]"`) не понимает комментариев: файл собирается только
парами «ключ значение». Поля `key_*` — скан-коды IBM PC set-1 (десятичные): Esc 1, Ctrl 29, LShift 42,
Alt 56, Space 57, `,` 51, `.` 52, стрелки ↑72 ←75 →77 ↓80, W 17, A 30, S 31, D 32, E 18, Tab 15, Enter 28.

Раскладка по умолчанию: W/S/A/D — движение и стрейф, ←/→ — поворот, Ctrl — огонь, Space — use, Alt —
модификатор «поворот → стрейф», Shift — бег. Мышь: `use_mouse 1`, `mouseb_fire 0`, `mouseb_strafe 1`,
`mouseb_forward 2`, `mouse_sensitivity 5` (≥31 роняет игру), `joyb_speed 29` (вечный бег, правило 11),
`screenblocks 10`, `detaillevel 0` (0 = высокая), `snd_musicdevice 3`, `snd_sfxdevice 3`,
`snd_sbport 544` (=0x220, десятичное), `snd_sbirq 7`, `snd_sbdma 1`, `sfx_volume 8`, `music_volume 8`.

Игра перезаписывает `DEFAULT.CFG` при выходе, и это нужно (настройки из меню переживают перезапуск
через `persist()`): наши значения стартовые, а не принудительные.

## Параметры запуска

`DOOM.EXE` запускается без параметров (титры и демки). Для отладки: `-warp 1 1 -skill 3`, `-nomusic`,
`-config MY.CFG`. `-iwad`, `-width`, `-height` в ванили нет; `-nomonsters`, `-fast`, `-respawn` работают
только вместе с варпом. Свой IWAD подкладывается файлом под именем, выведенным из содержимого WAD
(`src/dos/iwad.js`, правило 31).
