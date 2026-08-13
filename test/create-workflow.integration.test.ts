import { mkdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parsePath, staticKeyOf } from "../src/engine/node-path.ts"
import { resumeWithAnswer, resumeWithInteraction } from "../src/engine/resume-workflow.ts"
import { runWorkflow } from "../src/engine/run-workflow.ts"
import type { RunResult } from "../src/engine/types.ts"
import type { Question, Questionnaire } from "../src/flow/questionnaire.ts"
import createWorkflowWorkflow from "../src/host/builtin/create.workflow.ts"
import { loadWorkflowFile } from "../src/host/load-workflow.ts"
import { workflowsDir } from "../src/host/project-dir.ts"
import { createTestHost } from "./helpers.ts"
import { createKimiAgentStarter, resolveKimiApiKey } from "./kimi-agent.ts"

/**
 * Live proof that `/workflow create` can turn a goal into a loadable workflow and an ordinary
 * project test. It is gated because it exercises the same model/tool boundary used in production.
 */
const apiKey = resolveKimiApiKey()
const MODELS = ["kimchi-dev/kimi-k2.7", "kimchi-dev/minimax-m3"] as const
const MAX_ROUNDS = 10

const APPROVES = /approv|accept|yes|proceed|looks good|ok\b/i

function goal(workflowName: string): string {
	return `Create the first useful version of a workflow called ${workflowName} that reviews the current git diff.
It gathers the diff from project context, reviews it for actionable problems, and shows the findings in the
conversation as soon as the review is ready. It runs without arguments and does not modify project files.`
}

function autoAnswer(questionnaire: Questionnaire): Record<string, unknown> {
	return Object.fromEntries(questionnaire.questions.map((question) => [question.key, answerOne(question)]))
}

function answerOne(question: Question): unknown {
	const options = question.options ?? []
	switch (question.kind) {
		case "single": {
			const approving = options.find((option) => APPROVES.test(option.label) || APPROVES.test(option.value))
			return (approving ?? options[0])?.value ?? ""
		}
		case "multi":
			return options.length > 0 ? [options[0]?.value ?? ""] : []
		case "text":
		case "chat":
			return "Use the simplest behavior consistent with the stated goal."
	}
}

async function createWorkflowE2E(
	model: string,
	workflowName: string,
	projectRoot: string,
	writtenFiles: Set<string>,
): Promise<{ result: RunResult; rounds: number }> {
	const target = path.join(workflowsDir(projectRoot), `${workflowName}.workflow.ts`)
	const { host, store } = createTestHost({
		startAgent: createKimiAgentStarter(apiKey ?? "", {
			fileToolsRoot: projectRoot,
			writtenFiles,
			overwriteFiles: new Set([target]),
		}),
	})
	const underTest = { ...createWorkflowWorkflow, defaultModel: model }

	let result = await runWorkflow(underTest, { projectRoot }, host)
	let rounds = 0
	while (result.status === "blocked" && rounds < MAX_ROUNDS) {
		rounds += 1
		if (result.interaction !== undefined) {
			result = await resumeWithInteraction(
				underTest,
				await store.loadEvents(result.runId),
				{ decision: "approve" },
				host,
				{ path: result.path },
			)
			continue
		}

		const questionnaire = result.questionnaire
		if (!questionnaire) throw new Error("blocked with no human input")
		const answers = result.path === "goal" ? { goal: goal(workflowName) } : autoAnswer(questionnaire)
		result = await resumeWithAnswer(underTest, await store.loadEvents(result.runId), answers, host)
	}

	for (const event of await store.loadEvents(result.runId)) {
		if (event.type !== "step-completed" || staticKeyOf(parsePath(event.path)) !== "until-ready/check") continue
		const output = event.output as { ok: boolean; error?: string; entryPath: string }
		if (!output.ok) {
			console.log(`[create-e2e ${model}] check rejected: ${output.error}`)
			try {
				console.log((await readFile(output.entryPath, "utf8")).slice(0, 1200))
			} catch {
				console.log(`[create-e2e ${model}] entry file could not be read: ${output.entryPath}`)
			}
		}
	}

	return { result, rounds }
}

describe.skipIf(!apiKey)("/workflow create E2E (open-weight models)", () => {
	for (const model of MODELS) {
		it(`creates a loadable, argument-free workflow and project test with ${model}`, async () => {
			if (!apiKey) throw new Error("unreachable: skipIf guards this")
			const projectRoot = path.resolve(import.meta.dirname, "..")
			const workflowName = `e2e-${model.split("/")[1]}`
			const target = path.join(workflowsDir(projectRoot), `${workflowName}.workflow.ts`)
			const writtenFiles = new Set<string>()
			await mkdir(workflowsDir(projectRoot), { recursive: true })
			await rm(target, { force: true })

			try {
				const { result, rounds } = await createWorkflowE2E(model, workflowName, projectRoot, writtenFiles)
				console.log(`[create-e2e ${model}] status=${result.status} rounds=${rounds}`, result.error ?? "")
				expect(result.status).toBe("completed")

				const output = result.output as {
					path: string
					testPath: string
					command: string
					verification: string
				}
				expect(output.path).toBe(target)
				expect(output.command).toBe(`/workflow run ${workflowName}`)
				expect((await stat(output.testPath)).isFile()).toBe(true)
				expect(output.verification.length).toBeGreaterThan(0)

				const loaded = await loadWorkflowFile(target)
				expect(loaded.name).toBe(workflowName)
				expect(loaded.inputSchema).toBeUndefined()
				expect(loaded.nodes.length).toBeGreaterThan(0)
			} finally {
				if (!process.env.KEEP_GENERATED) {
					await Promise.all([...writtenFiles, target].map((file) => rm(file, { force: true })))
				}
			}
		}, 600_000)
	}
})
