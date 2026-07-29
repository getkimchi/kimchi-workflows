import { describe, expect, it } from "vitest"
import {
	matchRunId,
	mintRunId,
	resumeSessionFile,
	runIdHash,
	sanitizeNodePath,
	sanitizeSegment,
	sanitizeWorkflowName,
	stepSessionName,
	traceSessionFile,
} from "../src/host/naming.ts"

/** Never taken — the overwhelmingly common case for a freshly minted id. */
const free = async () => false

describe("sanitizing author-controlled names into path segments", () => {
	it("lowercases, replaces anything outside [a-z0-9._-], collapses runs and trims", () => {
		expect(sanitizeSegment("Deploy To Prod!")).toBe("deploy-to-prod")
		expect(sanitizeSegment("a//b c")).toBe("a-b-c")
		expect(sanitizeSegment("--edges--")).toBe("edges")
		expect(sanitizeSegment("keep.dots_and-dashes")).toBe("keep.dots_and-dashes")
	})

	it("hashes a name that sanitizes to nothing, so two such names stay distinct files", () => {
		const first = sanitizeWorkflowName("日本語")
		const second = sanitizeWorkflowName("한국어")
		expect(first).toMatch(/^[0-9a-f]{6}$/)
		expect(first).not.toBe(second)
	})

	it("caps a workflow name so the run id stays typeable, tagging the truncation", () => {
		const capped = sanitizeWorkflowName("a".repeat(80))
		expect(capped).toMatch(/^a{40}-[0-9a-f]{6}$/)
		expect(sanitizeWorkflowName("short")).toBe("short") // an in-cap name is left exactly as it is
	})

	/**
	 * The regression this cap exists for. A resumable step's session file carries NO run component — that
	 * is what lets the next run continue the last one — so a truncated workflow name is the ONLY thing
	 * separating two workflows' keyed sessions. Plain truncation collapsed these two onto one file, and
	 * one workflow's worker would have resumed holding the other's conversation.
	 */
	it("keeps two workflows apart when their names agree past the cap", () => {
		const alpha = "release-pipeline-for-the-primary-service-alpha"
		const beta = "release-pipeline-for-the-primary-service-beta"

		expect(sanitizeWorkflowName(alpha)).not.toBe(sanitizeWorkflowName(beta))
		expect(resumeSessionFile(alpha, "fixer")).not.toBe(resumeSessionFile(beta, "fixer"))
		expect(resumeSessionFile(alpha, "fixer")).toMatch(
			/^workflow-release-pipeline-for-the-primary-service-[0-9a-f]{6}-key-fixer\.jsonl$/,
		)
		// Stable across calls, or a "resumable" step would get a fresh file every run.
		expect(resumeSessionFile(alpha, "fixer")).toBe(resumeSessionFile(alpha, "fixer"))
	})

	it("transliterates node-path separators instead of flattening them (`/`→`.`, `#`/`@`→`-`)", () => {
		expect(sanitizeNodePath("until-valid#3/batch@7/review")).toBe("until-valid-3.batch-7.review")
	})

	// Deep foreach paths differ near the END, so plain truncation would hand two different items one
	// session file. The hash is of the FULL path, which is what keeps them apart.
	it("truncates an over-cap path AND tags it with a hash of the whole thing", () => {
		const shared = `${"deep/".repeat(30)}item`
		const a = sanitizeNodePath(`${shared}/alpha`)
		const b = sanitizeNodePath(`${shared}/beta`)

		expect(a.length).toBeGreaterThan(120)
		expect(a.slice(0, 120)).toBe(b.slice(0, 120)) // identical prefixes...
		expect(a).not.toBe(b) // ...but not identical names
		expect(a).toMatch(/-[0-9a-f]{6}$/)
	})
})

describe("minting a run id (spec §8.9)", () => {
	it("is a readable slug: workflow-<name>-<8 hex>", async () => {
		const runId = await mintRunId("Deploy To Prod", free)
		expect(runId).toMatch(/^workflow-deploy-to-prod-[0-9a-f]{8}$/)
		expect(runIdHash(runId)).toBe(runId.slice(-8))
	})

	// Unlike a UUID this is 32 random bits behind a name many runs share, so a collision is a matter of
	// time — and it would silently append one run's events onto another's.
	it("re-mints when the candidate id is already taken", async () => {
		const hexes = ["aaaaaaaa", "bbbbbbbb", "cccccccc"]
		let next = 0
		const taken = new Set(["workflow-deploy-aaaaaaaa", "workflow-deploy-bbbbbbbb"])

		const runId = await mintRunId(
			"deploy",
			async (candidate) => taken.has(candidate),
			() => hexes[next++] as string,
		)

		expect(runId).toBe("workflow-deploy-cccccccc")
		expect(next).toBe(3) // it really did ask about each earlier candidate
	})

	it("gives up rather than spinning when every candidate reads as taken", async () => {
		await expect(mintRunId("deploy", async () => true)).rejects.toThrow(/could not mint a free run id/)
	})
})

/**
 * The two session-file shapes (spec §2.2). They share one flat directory now — no `traces/` subdir —
 * so the `-key-`/`-run-` infix is what keeps the namespaces disjoint.
 */
describe("step session filenames", () => {
	it("names a resumable step's file with NO run component, so the next run continues it", () => {
		expect(resumeSessionFile("round", "worker")).toBe("workflow-round-key-worker.jsonl")
		// Same key, different run: the same file, which is the entire point of `resumable`.
		expect(resumeSessionFile("round", "orchestrator")).toBe("workflow-round-key-orchestrator.jsonl")
	})

	it("names a trace after run + node path + attempt, unique per execution", () => {
		expect(traceSessionFile("round", "workflow-round-1a2b3c4d", "items@7/verify", 2)).toBe(
			"workflow-round-run-1a2b3c4d-items-7.verify-a2.jsonl",
		)
	})

	it("keeps the two namespaces disjoint whatever a step is called", () => {
		// A key that tries to look like a trace still lands in the `-key-` namespace, and vice versa.
		const keyed = resumeSessionFile("wf", "run-1a2b3c4d-step-a1")
		const trace = traceSessionFile("wf", "workflow-wf-1a2b3c4d", "step", 1)
		expect(keyed).not.toBe(trace)
		expect(keyed.startsWith("workflow-wf-key-")).toBe(true)
		expect(trace.startsWith("workflow-wf-run-")).toBe(true)
	})

	it("labels a spawned session so it reads as something in a picker", () => {
		expect(stepSessionName("round", "items@7/verify", "workflow-round-1a2b3c4d")).toBe("round/items@7/verify #1a2b3c4d")
	})
})

/** What `/workflow resume|cancel|delete <arg>` accepts (spec §6.2/§6.4/§6.5). */
describe("resolving a run reference", () => {
	const known = ["workflow-deploy-1a2b3c4d", "workflow-deploy-1a2b9999", "workflow-audit-ffffffff"]

	it("takes the full id, the 8-hex tail, or any unique prefix", () => {
		expect(matchRunId(known, "workflow-deploy-1a2b3c4d")).toEqual({ kind: "ok", runId: "workflow-deploy-1a2b3c4d" })
		expect(matchRunId(known, "1a2b3c4d")).toEqual({ kind: "ok", runId: "workflow-deploy-1a2b3c4d" })
		expect(matchRunId(known, "workflow-au")).toEqual({ kind: "ok", runId: "workflow-audit-ffffffff" })
	})

	it("reports the candidates rather than picking one when a prefix matches several", () => {
		expect(matchRunId(known, "workflow-deploy")).toEqual({
			kind: "ambiguous",
			candidates: ["workflow-deploy-1a2b3c4d", "workflow-deploy-1a2b9999"],
		})
	})

	it("lets an exact id win outright, even when it is also a prefix of another", () => {
		expect(matchRunId(["workflow-a-1", "workflow-a-12"], "workflow-a-1")).toEqual({ kind: "ok", runId: "workflow-a-1" })
	})

	it("reports an unknown reference, and never resolves an empty one", () => {
		expect(matchRunId(known, "nope")).toEqual({ kind: "unknown" })
		expect(matchRunId(known, "")).toEqual({ kind: "unknown" })
	})
})
