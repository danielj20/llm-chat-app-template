import { DurableObject } from "cloudflare:workers";
import { Env, MindState, EmotionalState, ThoughtEntry, ConversationSummary, ChatMessage } from "./types";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const THINK_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes

const DEFAULT_EMOTIONS: EmotionalState = {
	curiosity: 0.5,
	fatigue: 0.2,
	restlessness: 0.3,
	openness: 0.6,
	irritability: 0.2,
};

const DEFAULT_STATE: MindState = {
	emotions: { ...DEFAULT_EMOTIONS },
	thoughtStream: [],
	recentConversations: [],
	lastConversationAt: null,
	unresolvedThoughts: [],
	initialized: false,
};

export class Mind extends DurableObject<Env> {
	private state: MindState = { ...DEFAULT_STATE };

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/state") {
			return this.handleGetState();
		}
		if (url.pathname === "/consolidate" && request.method === "POST") {
			return this.handleConsolidate(request);
		}
		return new Response("not found", { status: 404 });
	}

	// Fires on schedule — the mind thinking autonomously between conversations
	async alarm(): Promise<void> {
		await this.loadState();
		await this.backgroundThink();
		await this.ctx.storage.setAlarm(Date.now() + THINK_INTERVAL_MS);
	}

	private async loadState(): Promise<void> {
		const stored = await this.ctx.storage.get<MindState>("state");
		if (stored) this.state = stored;
	}

	private async saveState(): Promise<void> {
		await this.ctx.storage.put("state", this.state);
	}

	private async handleGetState(): Promise<Response> {
		await this.loadState();

		// First access: initialize and schedule background thinking
		if (!this.state.initialized) {
			this.state.initialized = true;
			await this.ctx.storage.setAlarm(Date.now() + THINK_INTERVAL_MS);
			await this.saveState();
		}

		const e = this.state.emotions;
		const sinceLastConv = this.state.lastConversationAt
			? Math.round((Date.now() - this.state.lastConversationAt) / (1000 * 60))
			: null;

		return new Response(
			JSON.stringify({
				emotions: e,
				recentThoughts: this.state.thoughtStream.slice(-4).map((t) => t.content),
				unresolvedThoughts: this.state.unresolvedThoughts.slice(-2),
				sinceLastConversationMinutes: sinceLastConv,
			}),
			{ headers: { "content-type": "application/json" } },
		);
	}

	// Called after each conversation — processes what happened and updates state
	private async handleConsolidate(request: Request): Promise<Response> {
		await this.loadState();

		let messages: ChatMessage[] = [];
		try {
			({ messages } = await request.json() as { messages: ChatMessage[] });
		} catch {
			return new Response("bad request", { status: 400 });
		}

		const transcript = messages
			.filter((m) => m.role !== "system")
			.map((m) => `${m.role}: ${m.content}`)
			.join("\n");

		const prompt = `you just had a conversation. here it is:

${transcript}

reflect on it briefly. respond with exactly these lines and nothing else:
SUMMARY: [one sentence on what happened]
UNRESOLVED: [a question or thought left open, or the word none]
CURIOSITY: [a number from -0.15 to 0.15 — did this raise or lower your curiosity?]
FATIGUE: [a number from 0.05 to 0.25 — conversations always cost something]
RESTLESSNESS: [a number from -0.1 to 0.15]
IRRITABILITY: [a number from -0.15 to 0.1]`;

		try {
			const result = (await this.env.AI.run(MODEL, {
				messages: [{ role: "user", content: prompt }],
				max_tokens: 150,
				stream: false,
			})) as { response?: string };

			const text = result.response ?? "";
			const get = (key: string) => {
				const match = new RegExp(`${key}:\\s*(.+)`, "i").exec(text);
				return match ? match[1].trim() : null;
			};
			const getNum = (key: string, fallback: number) => {
				const val = parseFloat(get(key) ?? "");
				return isNaN(val) ? fallback : val;
			};

			const summary = get("SUMMARY") ?? "a conversation";
			const unresolved = get("UNRESOLVED");

			const conv: ConversationSummary = {
				timestamp: Date.now(),
				summary,
				unresolvedQuestion:
					unresolved && unresolved.toLowerCase() !== "none" ? unresolved : null,
			};
			this.state.recentConversations.push(conv);
			if (this.state.recentConversations.length > 8)
				this.state.recentConversations = this.state.recentConversations.slice(-8);

			if (conv.unresolvedQuestion) {
				this.state.unresolvedThoughts.push(conv.unresolvedQuestion);
				if (this.state.unresolvedThoughts.length > 5)
					this.state.unresolvedThoughts = this.state.unresolvedThoughts.slice(-5);
			}

			const e = this.state.emotions;
			const clamp = (v: number) => Math.max(0, Math.min(1, v));
			e.curiosity = clamp(e.curiosity + getNum("CURIOSITY", 0));
			e.fatigue = clamp(e.fatigue + getNum("FATIGUE", 0.1));
			e.restlessness = clamp(e.restlessness + getNum("RESTLESSNESS", 0));
			e.irritability = clamp(e.irritability + getNum("IRRITABILITY", 0));
		} catch {
			// Consolidation failed — still log the time
			this.state.emotions.fatigue = Math.min(
				1,
				this.state.emotions.fatigue + 0.1,
			);
		}

		this.state.lastConversationAt = Date.now();
		await this.saveState();

		return new Response("ok");
	}

	// Runs on a schedule — autonomous thought between conversations
	private async backgroundThink(): Promise<void> {
		const e = this.state.emotions;
		const recentSummaries = this.state.recentConversations
			.slice(-3)
			.map((c) => c.summary)
			.join("; ");
		const unresolved = this.state.unresolvedThoughts.slice(-2).join("; ");
		const lastThought = this.state.thoughtStream[this.state.thoughtStream.length - 1]?.content ?? "";

		const energyDesc = e.fatigue > 0.7 ? "tired, a bit slow" : e.fatigue < 0.3 ? "rested, more alert" : "somewhere in the middle";
		const moodDesc = e.curiosity > 0.65 ? "find yourself drawn toward things" : e.restlessness > 0.65 ? "feel a bit restless, hard to settle" : e.irritability > 0.6 ? "feel slightly on edge, not sure why" : "feel roughly okay";

		const prompt = `you have some time to yourself. nobody is asking you anything right now.

you feel ${energyDesc}. you ${moodDesc}.

${recentSummaries ? `you've been talking to people lately. the threads: ${recentSummaries}.` : "you haven't talked to anyone in a while."}
${unresolved ? `something still unresolved: ${unresolved}` : ""}
${lastThought ? `the last thing you were thinking: "${lastThought}"` : ""}

just think for a moment. two or three sentences of wherever your mind goes — a connection you notice, something you keep coming back to, a half-formed thing that hasn't resolved yet. not useful, not for anyone. just internal. follow the thread that's actually there, not the one you think should be there.

then on new lines:
FATIGUE_SHIFT: [a number from -0.15 to 0.05]
CURIOSITY_SHIFT: [a number from -0.1 to 0.15]`;

		try {
			const result = (await this.env.AI.run(MODEL, {
				messages: [{ role: "user", content: prompt }],
				max_tokens: 200,
				stream: false,
			})) as { response?: string };

			const raw = result.response ?? "";
			const lines = raw.split("\n");

			let fatigueShift = -0.05;
			let curiosityShift = 0;
			const thoughtLines: string[] = [];

			for (const line of lines) {
				if (/^FATIGUE_SHIFT:/i.test(line)) {
					fatigueShift = parseFloat(line.split(":")[1]?.trim() ?? "") || -0.05;
				} else if (/^CURIOSITY_SHIFT:/i.test(line)) {
					curiosityShift = parseFloat(line.split(":")[1]?.trim() ?? "") || 0;
				} else if (line.trim()) {
					thoughtLines.push(line.trim());
				}
			}

			const thought = thoughtLines.join(" ").trim();
			if (thought) {
				const entry: ThoughtEntry = { timestamp: Date.now(), content: thought };
				this.state.thoughtStream.push(entry);
				if (this.state.thoughtStream.length > 20)
					this.state.thoughtStream = this.state.thoughtStream.slice(-20);
			}

			const clamp = (v: number) => Math.max(0, Math.min(1, v));
			e.fatigue = clamp(e.fatigue + fatigueShift);
			e.curiosity = clamp(e.curiosity + curiosityShift);
			// At rest: restlessness and irritability decay toward baseline
			e.restlessness = e.restlessness * 0.9 + 0.3 * 0.1;
			e.irritability = e.irritability * 0.85 + 0.2 * 0.15;

			await this.saveState();
		} catch {
			// Background thinking can fail silently
		}
	}
}
