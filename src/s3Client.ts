import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
  type ListObjectsV2CommandOutput,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import type { S3Config } from "./settings";

export function createS3Client(cfg: S3Config): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
    forcePathStyle: false,
  });
}

/**
 * Шифрование на стороне провайдера.
 *
 * `SSE-S3` = `AES256`: хранилище шифрует объект у себя и расшифровывает при
 * чтении, поэтому публичные ссылки и рендер в заметках продолжают работать.
 *
 * KMS намеренно не поддерживается: с ключом KMS анонимный `GET` обычно получает
 * 403 (нужен `kms:Decrypt`), то есть картинки в заметках перестанут открываться.
 */
export type S3Encryption = "none" | "SSE-S3";

/** Значение заголовка `x-amz-server-side-encryption` (undefined — не задавать). */
export function serverSideEncryption(cfg: S3Config): "AES256" | undefined {
  return cfg.encryption === "SSE-S3" ? "AES256" : undefined;
}

/**
 * Хранилище отказалось принимать шифрование объекта.
 *
 * cloud.ru, например, отвечает `400 InvalidArgument` с текстом про
 * «Customer provided keys» — то есть не поддерживает SSE-S3 через этот
 * заголовок. В таком случае загружать файл всё равно нужно: без шифрования.
 */
export function isEncryptionRejected(err: unknown): boolean {
  const e = err as any;
  const status = e?.$metadata?.httpStatusCode;
  const text = `${e?.name ?? ""} ${e?.code ?? ""} ${e?.message ?? ""}`;
  return status === 400 && /InvalidArgument|encryption/i.test(text) && /encrypt/i.test(text);
}

export async function uploadBuffer(
  client: S3Client,
  cfg: S3Config,
  key: string,
  body: Uint8Array,
  contentType: string,
  metadata: Record<string, string> = {}
): Promise<{ encryptionApplied: boolean }> {
  const send = async (serverSide?: "AES256"): Promise<void> => {
    await client.send(new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: metadata,
      ...(serverSide ? { ServerSideEncryption: serverSide } : {}),
    }));
  };

  const encryption = serverSideEncryption(cfg);
  if (!encryption) {
    await send();
    return { encryptionApplied: false };
  }

  try {
    await send(encryption);
    return { encryptionApplied: true };
  } catch (err) {
    if (!isEncryptionRejected(err)) throw err;
    // Откатываемся на загрузку без шифрования, но громко сообщаем об этом:
    // молча понижать защиту нельзя.
    console.warn(
      `[S3] Storage rejected server-side encryption for "${key}" ` +
      `(${(err as any)?.message ?? err}); uploaded without encryption. ` +
      `Set "Server-side encryption" to None to avoid the extra request.`
    );
    await send();
    return { encryptionApplied: false };
  }
}

export function publicUrl(cfg: S3Config, key: string): string {
  const base = cfg.publicEndpoint.replace(/\/+$/, "");
  if (cfg.publicUrlStyle === "virtual-host") {
    return `${base}/${key}`;
  }
  return `${base}/${cfg.bucket}/${key}`;
}

export async function headObject(
  client: S3Client,
  cfg: S3Config,
  key: string
): Promise<HeadObjectCommandOutput | null> {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  } catch (err: any) {
    // AWS SDK v3 throws NoSuchKey / NotFound variants. Normalize by status code / error name.
    if (
      err?.$metadata?.httpStatusCode === 404 ||
      err?.name === "NotFound" ||
      err?.Code === "NoSuchKey" ||
      err?.Code === "404"
    ) {
      return null;
    }
    throw err;
  }
}

export async function listAllObjects(
  client: S3Client,
  bucket: string,
  prefix = ""
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  const items: Array<{ key: string; size: number; lastModified: Date }> = [];
  let token: string | undefined;
  do {
    const res: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) items.push({ key: obj.Key, size: obj.Size ?? 0, lastModified: obj.LastModified ?? new Date() });
    }
    token = res.NextContinuationToken;
  } while (token);
  return items;
}

export async function moveObject(
  client: S3Client,
  bucket: string,
  fromKey: string,
  toKey: string,
  encryption?: "AES256"
): Promise<void> {
  await client.send(new CopyObjectCommand({
    Bucket: bucket, CopySource: `${bucket}/${fromKey}`, Key: toKey, MetadataDirective: "COPY",
    ...(encryption ? { ServerSideEncryption: encryption } : {}),
  }));
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
}

export async function deleteObject(
  client: S3Client,
  bucket: string,
  key: string
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Скачивает объект целиком в память вместе с метаданными.
 *
 * Используется командой Restore: это вложения заметок, они и так грузятся в
 * память при загрузке, поэтому потоковая запись здесь не нужна. Метаданные
 * нужны, чтобы восстановить исходное имя файла (`original-name`).
 */
export interface DownloadedObject {
  bytes: Uint8Array;
  contentType?: string;
  etag?: string;
  metadata: Record<string, string>;
}

export async function downloadObject(
  client: S3Client,
  bucket: string,
  key: string
): Promise<DownloadedObject> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Empty response body for key "${key}"`);
  const bytes = await res.Body.transformToByteArray();
  if (bytes.byteLength === 0) throw new Error(`Object "${key}" is empty`);
  return {
    bytes,
    contentType: res.ContentType,
    etag: res.ETag,
    metadata: res.Metadata ?? {},
  };
}
