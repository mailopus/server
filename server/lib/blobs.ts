// JMAP blobs: uploads (RFC 8620 §6.1) and parts of stored mail, so a draft can attach either one.
import PostalMime from "postal-mime";

export type Blob = { content: Uint8Array; type: string; name: string | null };

/** Uploads are "u" + 32 hex; mail is an email id, or "<emailId>_<n>" for its nth attachment. */
export const UPLOAD_ID = /^u[0-9a-f]{32}$/;
export const uploadKey = (account: string, blobId: string) => `upload/${account}/${blobId}`;

export async function readBlob(db: D1Database, mail: R2Bucket, account: string, blobId: string): Promise<Blob | null> {
	if (UPLOAD_ID.test(blobId)) {
		const obj = await mail.get(uploadKey(account, blobId));
		if (!obj) return null;
		return { content: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType ?? "application/octet-stream", name: obj.customMetadata?.name ?? null };
	}
	const [emailId, part] = blobId.split("_");
	const row = await db.prepare("SELECT blob_key FROM emails WHERE id = ? AND account_id = ? AND destroyed_modseq IS NULL").bind(emailId, account).first<{ blob_key: string }>();
	const obj = row && (await mail.get(row.blob_key));
	if (!obj) return null;
	const raw = new Uint8Array(await obj.arrayBuffer());
	if (part === undefined) return { content: raw, type: "message/rfc822", name: null };
	const att = (await PostalMime.parse(raw)).attachments[Number(part)];
	if (!att) return null;
	const content = typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
	return { content, type: att.mimeType, name: att.filename ?? null };
}
