import { DurableObject } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { type ImportInput, type IngestInput, emailImport, emailSet, importBatch, importEmail, ingestEmail, junked, mailboxSet, sendDue, submissionSet } from "../lib/jmap/write";
import { pushNewMail } from "../lib/push";
import { hubName } from "../lib/live";
import { type SocketAuth, socketMessage } from "../lib/socket";
import type { Writer } from "../lib/jmap/mail";

type Socket = SocketAuth & { push: boolean };

/**
 * One per account. Every write to that account's mail goes through here, one at a time: D1 awaits would
 * otherwise let two writes interleave and commit modseq out of order, and a client syncing in between
 * would miss one.
 *
 * After every committed write it tells the user's hub, another Account object named hubName(userId), which
 * holds that user's WebSockets (JMAP over WebSocket, RFC 8887) and pushes a StateChange. A standard client
 * opens one socket and hears about all its accounts, so the sockets can't live in one account's object.
 * Sockets use the hibernation API, so an idle connection costs nothing.
 */
export class Account extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Keepalives answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	#w(account: string) {
		return { db: this.env.DB, mail: this.env.MAIL, account, env: this.env };
	}

	/** Runs a write exclusively, then tells connected clients the account changed. */
	async #write<T>(account: string, fn: () => Promise<T>): Promise<T> {
		const result = await this.ctx.blockConcurrencyWhile(fn);
		await this.#notify(account);
		return result;
	}

	async #notify(account: string) {
		try {
			const row = await this.env.DB.prepare("SELECT modseq, user_id FROM accounts WHERE id = ?").bind(account).first<{ modseq: number; user_id: string }>();
			if (row) await (this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(hubName(row.user_id))) as unknown as Account).changed(account, String(row.modseq));
		} catch (e) {
			// The write is committed; a missed push only delays a client until its next sync.
			console.warn("notify:", (e as Error).message);
		}
	}

	/** Hub only: an account of this user changed. */
	changed(account: string, state: string) {
		const msg = JSON.stringify({ "@type": "StateChange", changed: { [account]: { Email: state, Mailbox: state, Thread: state } } });
		for (const ws of this.ctx.getWebSockets()) {
			const att = ws.deserializeAttachment() as Socket | null;
			if (!att?.push || (att.account && att.account !== account)) continue;
			try {
				ws.send(msg);
			} catch {
				// Closed mid-send; the runtime drops it.
			}
		}
	}

	/** Hub only: the session or app password behind these sockets is gone (server/lib/live.ts). */
	closeSockets(cred: string) {
		let n = 0;
		for (const ws of this.ctx.getWebSockets()) {
			if ((ws.deserializeAttachment() as Socket | null)?.cred !== cred) continue;
			ws.close(1008, "signed out");
			n++;
		}
		return n;
	}

	/** Hub only: WebSocket upgrade, forwarded by liveSocket after the gate checked the credentials. */
	async fetch(request: Request) {
		const auth = request.headers.get("x-mailopus-socket");
		if (request.headers.get("upgrade") !== "websocket" || !auth) return new Response(null, { status: 400 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ ...(JSON.parse(auth) as SocketAuth), push: false } satisfies Socket);
		return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "jmap" } });
	}

	async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
		const att = ws.deserializeAttachment() as Socket;
		const { push, reply } = await socketMessage(typeof data === "string" ? data : new TextDecoder().decode(data), async () => {
			// Same context as /jmap/api (server/utils/jmap.ts), from the credentials checked at the upgrade.
			const rows = await this.env.DB.prepare("SELECT id FROM accounts WHERE user_id = ?").bind(att.userId).all<{ id: string }>();
			const writer = (account: string) => this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(account)) as unknown as Writer;
			return { db: this.env.DB, mail: this.env.MAIL, accounts: new Set(rows.results.map((r) => r.id)), writer, createdIds: {}, scope: att.scope };
		});
		if (push !== undefined) ws.serializeAttachment({ ...att, push });
		if (reply) ws.send(JSON.stringify(reply));
	}

	async webSocketClose(ws: WebSocket, code: number) {
		// 1005 and 1006 only describe a close; they can't be sent back.
		ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
	}

	async ingest(account: string, m: IngestInput) {
		const r = await this.#write(account, () => ingestEmail(this.#w(account), m));
		// Inbox only (ingestEmail files DMARC failures and spam-rule hits in Junk). Doesn't hold up delivery.
		if (!junked(m)) this.ctx.waitUntil(pushNewMail(this.env, account, m, r.threadId).catch((e) => console.warn("push:", (e as Error).message)));
		return r;
	}

	import(account: string, m: ImportInput) {
		return this.#write(account, () => importEmail(this.#w(account), m));
	}

	importBatch(account: string, items: ImportInput[]) {
		return this.#write(account, () => importBatch(this.#w(account), items));
	}

	emailSet(account: string, args: Record<string, unknown>, createdIds: Record<string, string>) {
		return this.#write(account, () => emailSet(this.#w(account), args, createdIds));
	}

	emailImport(account: string, args: Record<string, unknown>, createdIds: Record<string, string>) {
		return this.#write(account, () => emailImport(this.#w(account), args, createdIds));
	}

	mailboxSet(account: string, args: Record<string, unknown>) {
		return this.#write(account, () => mailboxSet(this.#w(account), args));
	}

	#send = async (from: string, to: string, raw: string) => {
		return (await this.env.EMAIL.send(new EmailMessage(from, to, raw))).messageId;
	};

	async submit(account: string, args: Record<string, unknown>, createdIds: Record<string, string>) {
		const r = await this.#write(account, () => submissionSet(this.#w(account), args, createdIds, this.#send));
		// A held send (or a cancel) changes when the next one is due. The alarm doesn't know which
		// account it's for, so the object remembers.
		if (r.scheduled || args.update) {
			await this.ctx.storage.put("account", account);
			await this.#arm(account);
		}
		return r;
	}

	async #arm(account: string) {
		const next = await this.env.DB.prepare("SELECT min(send_at) AS at FROM scheduled_submissions WHERE account_id = ?").bind(account).first<{ at: number | null }>();
		if (next?.at) await this.ctx.storage.setAlarm(next.at);
		else await this.ctx.storage.deleteAlarm();
	}

	/** Scheduled sends. A thrown error makes the runtime retry the alarm with backoff. */
	async alarm() {
		const account = await this.ctx.storage.get<string>("account");
		if (!account) return;
		const next = await this.#write(account, () => sendDue(this.#w(account), this.#send));
		if (next) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
	}
}
