import { resolveWorkflowPackageManager } from "../../src/host/workflow-package-manager.ts"

process.stdout.write(JSON.stringify(await resolveWorkflowPackageManager()))
