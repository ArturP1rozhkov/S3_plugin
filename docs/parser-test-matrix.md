# Parser test matrix

Цель: зафиксировать, какие форматы ссылок обязан понимать `linkParser.ts`, как они нормализуются и как используются в `sync`, `cleanup`, `cleanupS3`.

## Нормализация

Для каждой ссылки ожидаем:
- `rawRef` — исходное значение ссылки
- `path` — путь без `?query` и `#anchor`
- `filename` — имя файла
- `query` — query без `?`
- `anchor` — fragment без `#`
- `kind` — тип ссылки
- `isExternal` — внешний URL
- `isS3` — ссылка уже на наш S3

## Поддерживаемые кейсы

| Input | kind | path | filename | query | anchor | should sync | protects from cleanup | expected replacement |
|---|---|---|---|---|---|---|---|---|
| `![[img.jpg]]` | `wiki-embed` | `img.jpg` | `img.jpg` | `` | `` | yes | yes | image embed `![|W](url)` |
| `[[img.jpg]]` | `wiki-link` | `img.jpg` | `img.jpg` | `` | `` | yes | yes | image embed `![|W](url)` (как embed — иначе картинка не рендерится) |
| `![[Folder/img.jpg]]` | `wiki-embed` | `Folder/img.jpg` | `img.jpg` | `` | `` | yes | yes | image embed `![|W](url)` |
| `[[Folder/img.jpg|alias]]` | `wiki-link` | `Folder/img.jpg` | `img.jpg` | `` | `` | yes | yes | image embed `![|W](url)` |
| `![[file.pdf]]` | `wiki-embed` | `file.pdf` | `file.pdf` | `` | `` | yes | yes | `![[file.pdf]]` dummy |
| `[[file.pdf#page=3]]` | `wiki-link` | `file.pdf` | `file.pdf` | `` | `page=3` | yes | yes | pdf dummy |
| `![alt](img.jpg)` | `md-embed` | `img.jpg` | `img.jpg` | `` | `` | yes | yes | image embed `![|W](url)` |
| `[doc](file.pdf)` | `md-link` | `file.pdf` | `file.pdf` | `` | `` | yes | yes | pdf dummy (а для остальных типов — markdown link) |
| `[img](img.jpg)` | `md-link` | `img.jpg` | `img.jpg` | `` | `` | yes | yes | image embed `![|W](url)` (принудительный `!`) |
| `[clip](clip.mp4)` | `md-link` | `clip.mp4` | `clip.mp4` | `` | `` | yes | yes | `<video>`-плеер (как `![[clip.mp4]]`) |
| `![alt](img.jpg?ver=2)` | `md-embed` | `img.jpg` | `img.jpg` | `ver=2` | `` | yes | yes | image embed `![|W](url)` |
| `[doc](file.pdf#page=2)` | `md-link` | `file.pdf` | `file.pdf` | `` | `page=2` | yes | yes | pdf dummy (anchor теряется — dummy локальный) |
| `![alt](Folder/photo%20one.jpg)` | `md-embed` | `Folder/photo one.jpg` | `photo one.jpg` | `` | `` | yes | yes | image embed `![|W](url)` (путь декодируется) |
| `[](Folder/cold%20one.jpg)` | `md-link` | `Folder/cold one.jpg` | `cold one.jpg` | `` | `` | yes | yes | image embed `![|W](url)` |
| `<img src="img.jpg">` | `html-img` | `img.jpg` | `img.jpg` | `` | `` | yes | yes | html image src replaced |
| `<video src="video.mp4">` | `html-video` | `video.mp4` | `video.mp4` | `` | `` | yes | yes | html video src replaced |
| `<audio src="audio.mp3">` | `html-audio` | `audio.mp3` | `audio.mp3` | `` | `` | yes | yes | html audio src replaced |
| `![x](https://example.com/a.jpg)` | `md-embed` | `https://example.com/a.jpg` | `a.jpg` | `` | `` | **no** | no | unchanged (внешние ссылки не скачиваем) |
| `[x](https://example.com/a.pdf)` | `md-link` | `https://example.com/a.pdf` | `a.pdf` | `` | `` | **no** | no | unchanged |
| `<img src="https://example.com/a.jpg">` | `html-img` | `https://example.com/a.jpg` | `a.jpg` | `` | `` | **no** | no | unchanged |
| `![x](https://my-bucket.s3.cloud.ru/media/a.jpg)` | `md-embed` | `https://my-bucket.s3.cloud.ru/media/a.jpg` | `a.jpg` | `` | `` | no | n/a | unchanged |
| `[[файл с кириллицей.png]]` | `wiki-link` | `файл с кириллицей.png` | `файл с кириллицей.png` | `` | `` | yes | yes | image embed `![|W](url)` |
| `[[folder/file name with spaces.jpg]]` | `wiki-link` | `folder/file name with spaces.jpg` | `file name with spaces.jpg` | `` | `` | yes | yes | image embed `![|W](url)` |

## Неподдерживаемые или игнорируемые формы

| Input | Reason | Expected behavior |
|---|---|---|
| `[↩︎](#fnref-1)` | чистый внутридокументный anchor | ignore for attachment pipeline |
| `[[1]](#fn-1)` | ссылка-сноска, не attachment | ignore for attachment pipeline |
| `[[note]]` | wiki link на заметку без attachment extension | ignore for attachment pipeline |
| `![text](#anchor)` | fragment-only markdown link | ignore for attachment pipeline |
| `![[https://my-bucket.s3.cloud.ru/media/a.jpg]]` | wiki embed с внешним URL невалиден как output | never generate |
| `![[https://my-bucket.s3.cloud.ru/docs/a.pdf]]` | wiki embed с внешним URL невалиден как output | never generate |

## Канонические выходные форматы

| File type | Canonical replacement |
|---|---|
| Image | `![|width](https://s3...)` |
| Video | `<video src="https://s3..." controls></video>` |
| Audio | `<audio src="https://s3..." controls></audio>` |
| PDF | `![[file.pdf]]` with local dummy containing S3 URL |
| Document / archive | `[file.ext](https://s3...)` |

## Инварианты

1. Всё, что видит `sync`, обязаны видеть `cleanup` и `cleanupS3`.
2. `[[file.jpg]]` и `![[file.jpg]]` оба защищают файл от orphan-детекта.
3. Для резолвинга локального файла используются только `path` и `filename`, без `query` и `anchor`.
4. Already-S3 ссылки никогда не должны повторно обрабатываться.
5. Dummy PDF не должен повторно загружаться.
6. Чистые anchors и note-links без attachment extension не должны участвовать в attachment pipeline.
7. Для внешних S3 изображений плагин никогда не должен генерировать `![[https://...]]`; канонический формат — markdown image `![|width](https://...)`.
8. Результат sync не зависит от режима ссылок Obsidian и от способа вставки: `![[x]]`/`[[x]]` и `![alt](x)`/`[alt](x)` дают одинаковый output. Картинки, видео и аудио всегда приводятся к рендерящейся форме (`![|W]`, `<video>`, `<audio>`), для документов/архивов `!` определяет embed или ссылку.
9. Внешние `http(s)`-ссылки никогда не участвуют в pipeline: не скачиваются, не загружаются в бакет и не переписываются.
10. Пути в markdown-ссылках декодируются (`%20` → пробел) до поиска файла в vault — и в `sync`, и в защите от orphan-детекта.
