import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { collectLocalChanges } from "./local-code-review.workflow.ts"

const execFileAsync = promisify(execFile)

it("collects committed, staged, unstaged, and untracked changes from the current branch", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "kimchi-local-review-"))
	const git = (...args: string[]) => execFileAsync("git", args, { cwd: root })
	try {
		await git("init", "-b", "master")
		await git("config", "user.name", "Kimchi Test")
		await git("config", "user.email", "test@example.com")
		await writeFile(path.join(root, "unstaged.txt"), "before\n")
		await git("add", ".")
		await git("commit", "-m", "base")
		await git("switch", "-c", "feature")
		await writeFile(path.join(root, "committed.txt"), "committed\n")
		await git("add", "committed.txt")
		await git("commit", "-m", "feature")
		await writeFile(path.join(root, "staged.txt"), "staged\n")
		await git("add", "staged.txt")
		await writeFile(path.join(root, "unstaged.txt"), "unstaged\n")
		await writeFile(path.join(root, "untracked.txt"), "untracked\n")

		const changes = await collectLocalChanges(root)
		expect(changes.branch).toBe("feature")
		expect(changes.baseRef).toBe("master")
		expect(changes.changedFiles).toBe(4)
		expect(changes.untrackedFiles).toBe(1)
		expect(changes.diff).toContain("+committed")
		expect(changes.diff).toContain("+staged")
		expect(changes.diff).toContain("+unstaged")
		expect(changes.diff).toContain("+untracked")
		expect(changes.truncated).toBe(false)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
