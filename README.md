# Vault S3 Sync — Obsidian Plugin

Upload vault attachments (images, video, audio, PDF, docs) to any S3-compatible storage  
(cloud.ru / SberCloud / MinIO / AWS) and replace local links with proper embeds/links in notes.

## Features

| Command | Description |
|---|---|
| **Sync** | Scan notes, upload attachments, replace local links |
| **Cleanup** | Move local orphan files to trash folder |
| **Cleanup S3** | Move S3 orphan objects to quarantine prefix |
| **Status** | Show vault & bucket statistics |

## Installation (development)

```bash
cd D:\Plugin_S3
npm install
npm run dev
```

Copy `main.js`, `manifest.json`, `styles.css` to  
`<vault>/.obsidian/plugins/vault-s3-sync/` and enable in Obsidian settings.

## PDF++ compatibility

PDF files are uploaded to S3. A small dummy `.pdf` file (containing only the S3 URL)  
is created in the configured dummy folder. PDF++ reads it and opens the PDF from S3.
