import {
	accessSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { KimchiRpcClient } from "./rpc-client.ts"

export interface RunEventRecord {
	readonly type: string
	readonly [key: string]: unknown
}

export interface KimchiE2eFixture {
	readonly homeDir: string
	readonly workDir: string
	readonly workflowPackageDir: string
	readonly runDir: string
	readonly modelRequests: readonly string[]
	addWorkflow(fileName: string): void
	addProjectFixture(source: string, destination: string): void
	startRpc(): Promise<KimchiRpcClient>
	stop(): Promise<void>
}

interface FakeModelServer {
	readonly baseUrl: string
	readonly requests: string[]
	stop(): Promise<void>
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))
const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url))
const DEFAULT_TIMEOUT_MS = 40_000
const INITIAL_SURVEY_ID = "019e87cc-5033-0000-d9bd-5e6501640b6e"

export async function createKimchiE2eFixture(): Promise<KimchiE2eFixture> {
	const runtime = resolveKimchiRuntime()
	const modelServer = await startFakeModelServer()
	const homeDir = mkdtempSync(path.join(tmpdir(), "kimchi-workflows-e2e-home-"))
	const workDir = mkdtempSync(path.join(tmpdir(), "kimchi-workflows-e2e-work-"))
	const workflowPackageDir = path.join(workDir, ".kimchi", "workflows")
	const runDir = path.join(workflowPackageDir, "runs")
	const clients = new Set<KimchiRpcClient>()

	try {
		seedKimchiHome(homeDir, modelServer.baseUrl)
	} catch (error) {
		await modelServer.stop()
		rmSync(homeDir, { recursive: true, force: true })
		rmSync(workDir, { recursive: true, force: true })
		throw error
	}

	return {
		homeDir,
		workDir,
		workflowPackageDir,
		runDir,
		modelRequests: modelServer.requests,
		addWorkflow(fileName) {
			copyFixture(fileName, path.join(workflowPackageDir, fileName))
		},
		addProjectFixture(source, destination) {
			copyFixture(source, path.join(workDir, destination))
		},
		async startRpc() {
			const client = await KimchiRpcClient.start({
				binaryPath: runtime.binaryPath,
				cwd: workDir,
				env: {
					...process.env,
					HOME: homeDir,
					PI_PACKAGE_DIR: runtime.packageDir,
					KIMCHI_DISABLE_BUILTIN_PROVIDERS: "1",
					PI_SKIP_VERSION_CHECK: "1",
					KIMCHI_PERMISSIONS: "yolo",
					KIMCHI_NO_UPDATE_CHECK: "1",
					KIMCHI_RTK_AUTO_INSTALL: "0",
					KIMCHI_TELEMETRY_ENABLED: "0",
					KIMCHI_WORKFLOWS_PACKAGE_DIR: repositoryRoot,
				},
			})
			clients.add(client)
			return client
		},
		async stop() {
			await Promise.all([...clients].map((client) => client.stop().catch(() => {})))
			await modelServer.stop()
			rmSync(homeDir, { recursive: true, force: true })
			rmSync(workDir, { recursive: true, force: true })
		},
	}
}

export function snapshotRuns(runDir: string, workflowName: string): Set<string> {
	return new Set(runFiles(runDir, workflowName))
}

export async function waitForNewRun(
	runDir: string,
	workflowName: string,
	before: ReadonlySet<string>,
): Promise<string> {
	return waitFor(() => {
		const candidates = runFiles(runDir, workflowName)
			.filter((file) => !before.has(file))
			.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
		return candidates[0]
	}, `a new ${workflowName} run`)
}

export function readRunEvents(filePath: string): RunEventRecord[] {
	if (!existsSync(filePath)) return []
	return readFileSync(filePath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RunEventRecord)
}

export async function waitForRunEvent(filePath: string, type: string): Promise<RunEventRecord> {
	return waitFor(
		() => readRunEvents(filePath).find((event) => event.type === type),
		`${type} in ${path.basename(filePath)}`,
	)
}

export function runIdFromFile(filePath: string): string {
	return path.basename(filePath, ".events.jsonl")
}

export async function waitFor<T>(
	check: () => T | undefined | false | Promise<T | undefined | false>,
	label: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		const value = await check()
		if (value !== undefined && value !== false) return value
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

function resolveKimchiRuntime(): { binaryPath: string; packageDir: string } {
	const kimchiRoot = path.resolve(repositoryRoot, "../kimchi")
	const binaryName = process.platform === "win32" ? "kimchi.exe" : "kimchi"
	const binaryPath = path.resolve(process.env.KIMCHI_E2E_BINARY ?? path.join(kimchiRoot, "dist", "bin", binaryName))
	const packageDir = path.resolve(
		process.env.KIMCHI_E2E_PACKAGE_DIR ?? path.join(kimchiRoot, "dist", "share", "kimchi"),
	)
	try {
		accessSync(binaryPath, process.platform === "win32" ? constants.F_OK : constants.X_OK)
	} catch {
		throw new Error(
			`compiled Kimchi binary is unavailable at ${binaryPath}. Build it with "pnpm --dir ../kimchi run build:binary", or set KIMCHI_E2E_BINARY.`,
		)
	}
	if (!existsSync(path.join(packageDir, "package.json"))) {
		throw new Error(
			`compiled Kimchi resources are unavailable at ${packageDir}. Build the binary resources, or set KIMCHI_E2E_PACKAGE_DIR.`,
		)
	}
	return { binaryPath, packageDir }
}

function copyFixture(source: string, destination: string): void {
	const sourcePath = path.join(fixturesRoot, source)
	if (!existsSync(sourcePath)) throw new Error(`missing Kimchi E2E fixture: ${sourcePath}`)
	mkdirSync(path.dirname(destination), { recursive: true })
	copyFileSync(sourcePath, destination)
}

function runFiles(runDir: string, workflowName: string): string[] {
	if (!existsSync(runDir)) return []
	const prefix = `workflow-${workflowName}-`
	return readdirSync(runDir)
		.filter((name) => name.startsWith(prefix) && name.endsWith(".events.jsonl"))
		.map((name) => path.join(runDir, name))
}

function seedKimchiHome(homeDir: string, baseUrl: string): void {
	const configDir = path.join(homeDir, ".config", "kimchi")
	const agentDir = path.join(configDir, "harness")
	mkdirSync(agentDir, { recursive: true })
	writePrivateJson(path.join(configDir, "config.json"), {
		apiKey: "fake",
		llmEndpoint: baseUrl,
		skillPaths: [],
		migrationState: "done",
		onboarding: { hideSessionModeDialog: true },
		surveys: { [INITIAL_SURVEY_ID]: { seenAt: "2026-01-01T00:00:00.000Z" } },
	})
	writePrivateJson(path.join(agentDir, "settings.json"), {
		statusLine: { pinned: [] },
		hideThinkingBlock: true,
		// This suite verifies the extension from the current kimchi-workflows checkout. Disable
		// Kimchi's bundled copy so duplicate command registration cannot make the E2E pass through a
		// different published version once the built-in resource is enabled by default.
		resources: { "extensions.workflows": false },
		packages: [repositoryRoot],
	})
	writePrivateJson(path.join(agentDir, "models.json"), {
		providers: {
			fake: {
				baseUrl: `${baseUrl}/openai/v1`,
				apiKey: "fake",
				api: "openai-completions",
				authHeader: true,
				headers: { "User-Agent": "kimchi-workflows/e2e" },
				models: [
					{
						id: "basic",
						name: "Fake Basic",
						reasoning: false,
						input: ["text"],
						contextWindow: 8192,
						maxTokens: 1024,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						provider: "openai",
					},
				],
			},
		},
	})
}

function writePrivateJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 })
}

async function startFakeModelServer(): Promise<FakeModelServer> {
	const requests: string[] = []
	const sockets = new Set<Socket>()
	const server = createServer((request, response) => {
		const route = `${request.method ?? "GET"} ${request.url ?? "/"}`
		requests.push(route)
		request.resume()
		if (request.method === "GET" && request.url?.startsWith("/v1/models/metadata")) {
			writeJson(response, 200, {
				models: [
					{
						slug: "basic",
						display_name: "Fake Basic",
						provider: "openai",
						reasoning: false,
						input_modalities: ["text"],
						is_serverless: true,
						limits: { context_window: 8192, max_output_tokens: 1024 },
						status: "active",
					},
				],
			})
			return
		}
		if (request.method === "GET" && request.url?.startsWith("/v1/credits")) {
			writeJson(response, 200, { serverless: false })
			return
		}
		writeJson(response, 500, { error: `unexpected model request: ${route}` })
	})
	server.on("connection", (socket) => {
		sockets.add(socket)
		socket.once("close", () => sockets.delete(socket))
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject)
			resolve()
		})
	})
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("fake model server did not bind to a TCP port")
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		stop: () => closeServer(server, sockets),
	}
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" })
	response.end(JSON.stringify(body))
}

async function closeServer(server: ReturnType<typeof createServer>, sockets: Set<Socket>): Promise<void> {
	for (const socket of sockets) socket.destroy()
	await new Promise<void>((resolve) => server.close(() => resolve()))
}
