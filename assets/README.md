# Происхождение бинарных ассетов

Документ фиксирует, откуда взят каждый бинарник в `assets/`, каким хешем он проверяется и
под какой лицензией распространяется. Это не формальность: shareware-DOOM разрешено
раздавать только в немодифицированном виде и вместе с лицензионным текстом,
а значит происхождение и неизменность файлов надо уметь доказать.

Проверка: `node tools/verify-assets.mjs` — размер, MD5 и SHA-256 всех 11 файлов по
таблицам ниже. Двенадцатый файл, `doom/dosbox.conf`, в проверку не входит намеренно —
почему, сказано в разделе «Файлы, которые мы делаем сами».
Сборка бандла: `node tools/build-bundle.mjs`.

## js-dos / DOSBox — `assets/jsdos/`

Все три файла извлечены из npm-пакета `emulators@8.4.1`
(`npm pack emulators@8.4.1`, каталог `package/dist/`), скопированы байт-в-байт.
Взят классический DOSBox (`wdosbox.*`); `wdosbox-x.*` (7.9 МБ) и `wlibzip.*` не нужны —
См. раздел «Лицензии» в README.

| Файл | Размер, B | MD5 | SHA-256 | Источник | Лицензия |
|---|---:|---|---|---|---|
| `emulators.js` | 83 916 | `f9449e21abbf315f1a40251ce206cc45` | `5d9ca14da8fe75d2f1abb5a374aee14774fafd9f87c159cbcc411ca80c51c645` | `emulators@8.4.1` → `dist/emulators.js` | GPL-2.0 |
| `wdosbox.js` | 111 939 | `cefeaf1f206a276d7d0ce0468cfd958f` | `71397a28a933269e9e3f2e91fd917c0ec05958adf3b2052574fc57eb6b1ee5e1` | `emulators@8.4.1` → `dist/wdosbox.js` | GPL-2.0 |
| `wdosbox.wasm` | 1 459 705 | `56089e077329d509f1e18e09378d5013` | `aea62e7ea836424ce912728692d3168df63828b5fabfebc2b18cd1d2b19beda2` | `emulators@8.4.1` → `dist/wdosbox.wasm` | GPL-2.0 |
| `LICENSE-jsdos.txt` | 18 092 | `b234ee4d69f5fce4486a80fdaf4a4263` | `8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643` | `emulators@8.4.1` → `LICENSE` | GPL-2.0 (полный текст) |

Пакет на npm: <https://registry.npmjs.org/emulators/-/emulators-8.4.1.tgz>
(tarball shasum `62d994b0f13c0ff71f382b139cf427d5b86f9124`).

## DOOM shareware 1.9 — `assets/doom/`

| Файл | Размер, B | MD5 | SHA-256 | Источник | Лицензия |
|---|---:|---|---|---|---|
| `DOOM.EXE` | 709 905 | `e2382b7dc47ae2433d26b6e6bc312999` | `b8020523561a5ad9706e009a52d61c578f37faafd85ac471962308406292ce27` | `doom19s.zip` → `DOOMS_19.EXE` (см. ниже) | id Software Limited Use Software License |
| `DOOM1.WAD` | 4 196 020 | `f0cefca49926d00903cf57551d901abe` | `1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771` | Debian `doom-wad-shareware_1.9.fixed.orig.tar.gz` | id Software Limited Use Software License |
| `README-id.TXT` | 21 631 | `3ff8dbf9a2d717162ae2fb585e5728dc` | `17878ebe5ca179de7ec2cc90bbabbc922ab69924118be168a25f8d317f65a2ff` | `doom19s.zip` → `README.TXT` | id Software |
| `LICENSE-id.txt` | 6 689 | `07417cc3ee387db3e846129e6a1b1c2d` | `1a23ab70fdc2adb910d07a7350f4f657426539f176fc8e447439acb05cbe7b16` | shareware-дистрибутив DOOM → `LICENSE.DOC` | id Software (сам текст лицензии) |
| `VENDOR-id.txt` | 396 | `516492c9f5dc97e23217a0514d16517e` | `e190e875e07b4767f403d7475dc4a60a6fbfe1fbb5fce5de0c0d400331200e7e` | shareware-дистрибутив DOOM → `VENDOR.DOC` | id Software (на него ссылается §2 лицензии) |

Все пять файлов лежат **байт-в-байт как в оригинальном дистрибутиве**, переименован только
регистр/расширение двух текстовых файлов (`LICENSE.DOC` → `LICENSE-id.txt`,
`VENDOR.DOC` → `VENDOR-id.txt`, `README.TXT` → `README-id.TXT`, чтобы не путать с этим
README и с `README.TXT` расширения). Содержимое не редактировалось.

### Как именно добыты файлы DOOM

`DOOM1.WAD` — orig-тарбол Debian-пакета `doom-wad-shareware` (в нём ровно один уже
распакованный файл):

```
https://deb.debian.org/debian/pool/non-free/d/doom-wad-shareware/doom-wad-shareware_1.9.fixed.orig.tar.gz
  → doom-wad-shareware-1.9.fixed/doom1.wad
```

`DOOM.EXE` в Debian-пакете нет, поэтому он взят из канонического
дистрибутива `doom19s.zip` (id Software, февраль 1995), зеркало Internet Archive:

```
https://archive.org/download/doom19s_202607/doom19s.zip
  md5 244d181457c9be5f28b91b488e67e042, 2 450 688 B
```

Внутри — DEICE-набор (`DOOMS_19.DAT`, `DOOMS_19.1`, `DOOMS_19.2`, `DEICE.EXE`,
`INSTALL.BAT`). DOS для распаковки **не нужен**: `DEICE.EXE` всего лишь склеивает
пронумерованные куски в один файл, а результат — обычный PKZIP-самораспаковывающийся архив.

```sh
unzip doom19s.zip                      # достаём куски
cat DOOMS_19.1 DOOMS_19.2 > DOOMS_19.EXE   # 2 433 820 B == SIZE= из DOOMS_19.DAT
unzip DOOMS_19.EXE                     # обычный ZIP со стабом: 20 файлов, 5 515 076 B
```

Из полученных 20 файлов взяты `DOOM.EXE` и `README.TXT`. Лежащий там же `DOOM1.WAD`
**побайтно совпадает** с Debian-версией (проверено по SHA-256) — то есть оба источника
подтверждают друг друга.

`LICENSE.DOC` и `VENDOR.DOC` в набор `doom19s.zip` не входят (id перестала класть их в
инсталлятор 1.9), поэтому они взяты из shareware-дистрибутива DOOM предыдущей версии,
где текст лицензии тот же:

```
https://archive.org/download/doom1-sw1/doom-sw.zip
  md5 03af3d6d8dfc2f009233ad3c520a614d → license.doc, vendor.doc
```

## Файлы, которые мы делаем сами

| Файл | Размер, B | MD5 | SHA-256 | Что это |
|---|---:|---|---|---|
| `doom/DEFAULT.CFG` | 539 | `0c6780ed1dca05264ffc0e8298612648` | `a10bb533578572f753474978057940d744eb8cec4b8a78bf96638181721ed02f` | стартовый конфиг DOOM, генерируется `src/dos/config.js` |
| `doom/doom.zip` | 2 165 756 | `42328d22ed9d06352f47140e0dc20d42` | `719c9391ff9a496772b81e4fd20989a6b82f788a9788bb82b36145510a421931` | бандл для js-dos |
| `doom/dosbox.conf` | — | — | — | конфиг DOSBox, генерируется `src/dos/config.js`; **хешем не сверяется**, см. ниже |

- **`DEFAULT.CFG`.** `key_*` — скан-коды IBM PC set-1, а не константы движка. Игра
  перезапишет этот файл при выходе; наши значения — стартовые, не принудительные.
- **`doom.zip`.** Собирается `node tools/build-bundle.mjs` из `DOOM.EXE` + `DOOM1.WAD` +
  `DEFAULT.CFG`. Сборка детерминирована (фиксированные mtime), поэтому хеш производного
  файла имеет смысл фиксировать наравне с исходными.
- **`dosbox.conf` в проверку не входит намеренно.** В `doom.zip` он **не кладётся** и в
  рантайме не читается: настоящий конфиг собирается строкой в `src/dos/config.js` и
  передаётся отдельным элементом `InitFs`, иначе файл в архиве перезаписал бы переданную
  строку. Файл в `assets/` — читаемый эталон, и стережёт его не хеш, а
  `tests/dos/config.test.mjs`: он сверяет эталон с выводом генератора по ключам и
  значениям, так что правка одной стороны без другой роняет тесты.

## Условия распространения, которые обязаны соблюдаться

Из `LICENSE-id.txt` (и практики Debian с 1999 года):

1. **Не брать денег** за раздачу — ни прямо, ни за «премиум-доступ» к расширению.
2. **Не модифицировать** `DOOM1.WAD` и `DOOM.EXE` — не пережимать, не патчить, не вырезать.
   Именно это проверяет `tools/verify-assets.mjs` и, при сборке бандла,
   `tools/build-bundle.mjs`.
3. **Приложить текст лицензии** — `LICENSE-id.txt` и `VENDOR-id.txt` рядом с файлами.

Коммерческие IWAD (`DOOM.WAD`, `DOOM2.WAD` и прочие) в репозиторий не кладутся никогда.

Код самого расширения — GPL-2.0 (см. `LICENSE` в корне): мы распространяем
скомпилированный DOSBox, а он GPL-2.0.
