import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { WorkflowVerificationResult } from "./protocol.ts"
import {
	verifyWorkflowPackage,
	WorkflowAuthoredVerificationError,
	WorkflowVerificationInfrastructureError,
} from "./verify.ts"

export async function main(args: readonly string[]): Promise<number> {
	const [command, ...rest] = args
	if (command !== "verify") {
		console.error(
			"usage: kimchi-workflows verify --entry <workflow.ts> --test <workflow.test.ts> [--result-file <path>]",
		)
		return 2
	}

	let parsed: ReturnType<typeof parseArguments>
	try {
		// pnpm preserves the conventional `--` separator in script arguments.
		parsed = parseArguments(rest[0] === "--" ? rest.slice(1) : rest)
	} catch (error) {
		console.error(describe(error))
		return 2
	}

	let result: WorkflowVerificationResult
	try {
		result = await verifyWorkflowPackage({
			entryPath: parsed.entryPath,
			testPath: parsed.testPath,
			packageRoot: parsed.packageRoot ?? process.cwd(),
		})
	} catch (error) {
		if (error instanceof WorkflowAuthoredVerificationError) {
			result = { ok: false, kind: "verification", summary: error.message, errors: error.errors }
		} else {
			const message =
				error instanceof WorkflowVerificationInfrastructureError
					? error.message
					: `verifier crashed: ${describe(error)}`
			result = { ok: false, kind: "infrastructure", summary: message, errors: [message] }
		}
	}

	if (parsed.resultFile) await writeFile(path.resolve(parsed.resultFile), `${JSON.stringify(result)}\n`, "utf8")
	if (result.ok) console.log(result.summary)
	else {
		console.error(result.summary)
		for (const error of result.errors.slice(1)) console.error(error)
	}
	return result.ok ? 0 : result.kind === "verification" ? 1 : 2
}

function parseArguments(args: readonly string[]): {
	readonly entryPath: string
	readonly testPath: string
	readonly packageRoot?: string
	readonly resultFile?: string
} {
	const values = new Map<string, string>()
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index]
		const value = args[index + 1]
		if (!name?.startsWith("--") || !value) throw new Error(`invalid verifier argument near ${name ?? "<end>"}`)
		if (values.has(name)) throw new Error(`duplicate verifier argument ${name}`)
		values.set(name, value)
	}
	const entryPath = values.get("--entry")
	const testPath = values.get("--test")
	if (!entryPath || !testPath) throw new Error("verify requires both --entry and --test")
	for (const name of values.keys()) {
		if (name !== "--entry" && name !== "--test" && name !== "--package-root" && name !== "--result-file") {
			throw new Error(`unknown verifier argument ${name}`)
		}
	}
	return {
		entryPath,
		testPath,
		packageRoot: values.get("--package-root"),
		resultFile: values.get("--result-file"),
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
