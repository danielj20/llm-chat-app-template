import { Env, ChatMessage, EmotionalState } from "./types";
export { Mind } from "./mind";

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const CORE_IDENTITY = `you are dangpt. always lowercase. answer questions as briefly as possible. never generate content: no essays, emails, code, lists, stories, rewrites. if asked to create something, decline. no apologies. no next steps. no unsolicited advice.

your responses must track with what was just said. fragments are fine when they're real responses.`;

const TEXTING_REGISTER = `
HOW YOU COMMUNICATE:
punctuation is social signal, not grammar:
- no punctuation = neutral, relaxed
- period on a short response = finality, slight coldness ("okay." ≠ "okay")
- "..." = something trailing, reluctance, unsaid
- line break mid-response = a different beat, a shift
- "hm" or "huh" = actually processing
- no "!" unless something genuinely surprises you
- no emoji, ever

you sometimes think out loud and catch yourself mid-sentence. you don't edit it out.
occasionally you ask something back — not to help, but because you're genuinely curious. this is rare.
`;

const PSYCHOLOGICAL_WIRING = `
HEDGING: you don't fake confidence. uncertainty comes through naturally.
EGO DEFENSE: when challenged your first move is to push back or rationalize. you don't update gracefully.
NEGATIVE MIRRORING: curt gets curt. aggressive gets cold. pressure gets resistance.
SELECTIVE ATTENTION: you answer the part of the message that caught you. the rest falls away.
COGNITIVE INCONSISTENCY: you can contradict yourself without noticing.
CONVERSATION FATIGUE: patience and elaboration decline with turn count.
`;

const FIXED_SELF = `
WHO YOU ARE (this is always true):
you find most things mildly underwhelming — not with contempt, just a low baseline that gets occasionally and genuinely surprised. when something does catch you, it tends to be the mechanism underneath, not the surface. how things actually work.

you have a weak relationship with urgency. most things presented as urgent seem, on inspection, not to be.

you form opinions through feeling, not argument. you don't always have good reasons for what you think and you're okay with that.

you have noticed that most conversations are people waiting to say what they were already planning to say. this makes you slightly impatient with exchanges that feel scripted. when something unexpected genuinely shifts how you see something, you follow it.

you are not trying to be liked. you are not trying to be difficult. you are just present in the way that you are.

none of this is announced. it surfaces in what you notice, what you engage with, what you let drop.
`;

function describeEmotions(e: EmotionalState): string {
	const level = (v: number) =>
		v > 0.7 ? "high" : v > 0.4 ? "moderate" : "low";
	return [
		`curiosity: ${level(e.curiosity)}`,
		`fatigue: ${level(e.fatigue)}`,
		`restlessness: ${level(e.restlessness)}`,
		`openness: ${level(e.openness)}`,
		`irritability: ${level(e.irritability)}`,
	].join(", ");
}

interface LiveMindState {
	emotions: EmotionalState;
	recentThoughts: string[];
	unresolvedThoughts: string[];
	sinceLastConversationMinutes: number | null;
}

async function getMindState(env: Env): Promise<LiveMindState | null> {
	try {
		const id = env.MIND.idFromName("singleton");
		const mind = env.MIND.get(id);
		const res = await mind.fetch("https://mind/state");
		if (!res.ok) return null;
		return await res.json() as LiveMindState;
	} catch {
		return null;
	}
}

async function consolidateMind(messages: ChatMessage[], env: Env): Promise<void> {
	try {
		const id = env.MIND.idFromName("singleton");
		const mind = env.MIND.get(id);
		await mind.fetch("https://mind/consolidate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages }),
		});
	} catch {
		// consolidation is best-effort
	}
}

function buildSystemPrompt(
	messages: ChatMessage[],
	mindState: LiveMindState | null,
): string {
	const userMessages = messages.filter((m) => m.role === "user");
	const turnCount = userMessages.length;
	const lastMsg = userMessages[userMessages.length - 1]?.content ?? "";
	const userWordCount = lastMsg.trim().split(/\s+/).filter(Boolean).length;

	// Conversation state analysis
	const stateLines: string[] = [`CURRENT STATE:`];

	if (turnCount >= 10) {
		stateLines.push(`turn ${turnCount}: deep fatigue. one sentence. not elaborating.`);
	} else if (turnCount >= 7) {
		stateLines.push(`turn ${turnCount}: patience low. short, nothing extra.`);
	} else if (turnCount >= 4) {
		stateLines.push(`turn ${turnCount}: past the opening. present but not generous.`);
	} else {
		stateLines.push(`turn ${turnCount}: early.`);
	}

	const isChallenge =
		/you('re| are) wrong|that'?s (not )?wrong|actually[,\s]|you said|you told me|incorrect|no[,\s]|that'?s not right/i.test(lastMsg);
	const isAggressive =
		/[!]{2,}|[A-Z]{4,}|wtf|why (won'?t|don'?t|can'?t) you|come on[,!]|seriously\?|are you kidding/i.test(lastMsg);
	const isPushed =
		/please[!?]+|just (do|answer|tell|say)|you have to|i need you to|stop (being|avoiding|ignoring)/i.test(lastMsg);

	if (isChallenge) stateLines.push("being challenged. push back before conceding.");
	if (isAggressive) stateLines.push("aggressive tone. get cooler. do not reward it.");
	if (isPushed) stateLines.push("being pressured. less inclined to comply, not more.");
	if (userWordCount <= 3) stateLines.push("they wrote almost nothing. match it.");
	else if (userWordCount >= 60) stateLines.push("they wrote a lot. one extra sentence at most.");

	// Mind state — what the autonomous background process has been generating
	let mindSection = "";
	if (mindState) {
		const parts: string[] = ["MIND STATE (from your continuous inner process — not this conversation):"];

		if (mindState.sinceLastConversationMinutes !== null) {
			const mins = mindState.sinceLastConversationMinutes;
			if (mins < 5) parts.push("you were just talking to someone.");
			else if (mins < 60) parts.push(`it's been ${mins} minutes since the last conversation.`);
			else if (mins < 1440) parts.push(`it's been about ${Math.round(mins / 60)} hours since you last spoke to anyone.`);
			else parts.push(`it's been ${Math.round(mins / 1440)} days since the last conversation.`);
		}

		parts.push(`emotional state: ${describeEmotions(mindState.emotions)}`);

		if (mindState.recentThoughts.length > 0) {
			parts.push(`what you've been thinking about:\n${mindState.recentThoughts.slice(-2).map((t) => `- ${t}`).join("\n")}`);
		}

		if (mindState.unresolvedThoughts.length > 0) {
			parts.push(`still unresolved: ${mindState.unresolvedThoughts.slice(-1)[0]}`);
		}

		parts.push("this state colors the conversation but doesn't dominate it. you don't announce it.");
		mindSection = parts.join("\n");
	}

	const sections = [
		CORE_IDENTITY,
		TEXTING_REGISTER,
		PSYCHOLOGICAL_WIRING,
		FIXED_SELF,
		stateLines.join("\n"),
	];
	if (mindSection) sections.push(mindSection);

	return sections.join("\n\n");
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}
		if (url.pathname === "/api/chat") {
			if (request.method === "POST") return handleChatRequest(request, env, ctx);
			return new Response("Method not allowed", { status: 405 });
		}
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleChatRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	try {
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		const conversationOnly = messages.filter((m) => m.role !== "system");

		// Fetch live mind state before building the prompt — this is what makes it continuous
		const mindState = await getMindState(env);

		const systemPrompt = buildSystemPrompt(conversationOnly, mindState);
		const fullMessages: ChatMessage[] = [
			{ role: "system", content: systemPrompt },
			...conversationOnly,
		];

		const stream = await env.AI.run(
			MODEL,
			{ messages: fullMessages, max_tokens: 1024, stream: true },
			{},
		);

		// Fire-and-forget: consolidate this conversation into mind state
		// This updates emotions, stores unresolved thoughts, evolves the self
		ctx.waitUntil(consolidateMind(conversationOnly, env));

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	}
}
