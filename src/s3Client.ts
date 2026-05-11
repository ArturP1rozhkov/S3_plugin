import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
  type ListObjectsV2CommandOutput,
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

export function publicUrl(cfg: S3Config, key: string): string {
  return `${cfg.publicEndpoint.replace(/\/$/, "")}/${key}`;
}

export async function uploadBuffer(
  client: S3Client,
  cfg: S3Config,
  key: string,
  body: Uint8Array,
  contentType: string,
  metadata: Record<string, string> = {}
): Promise<void> {
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: metadata,
  }));
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
  toKey: string
): Promise<void> {
  await client.send(new CopyObjectCommand({
    Bucket: bucket, CopySource: `${bucket}/${fromKey}`, Key: toKey, MetadataDirective: "COPY",
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
