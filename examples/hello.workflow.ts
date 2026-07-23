/**
 * Phase 1 tracer-bullet example: a single function step with a TypeBox output schema.
 *
 * Run it: `/workflow run examples/hello.workflow.ts` (from the PI host), or drive it
 * directly through the engine with a fake HostPort (see test/hello.test.ts).
 */
import { Type } from "typebox";
import { createStep, createWorkflow } from "../src/flow/index.ts";

export const helloOutputSchema = Type.Object({
  message: Type.String(),
});

const sayHello = createStep({
  name: "say-hello",
  output: helloOutputSchema,
  run: () => ({ message: "Hello, PI workflows!" }),
});

const helloWorkflow = createWorkflow({ name: "hello", description: "Say hello (Phase 1 tracer bullet)" }).then(sayHello).commit();

export default helloWorkflow;
