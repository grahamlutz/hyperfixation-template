import type { PlopTypes } from "@turbo/gen";

/**
 * `pnpm gen` — the scaffolds for the things an app adds after `hf new`.
 *
 * Each one writes a file and *registers it in `src/hyperfixation.ts`*, because a flow that is
 * defined and never registered is the failure mode that costs an afternoon: `runs.start()`
 * refuses it, `reconcile()` cannot re-enqueue it after a redeploy, and nothing about the file
 * looks wrong. The generator existing is the cheapest way to make the two-step nature of a
 * registration invisible.
 */
export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator("flow", {
    description: "A flow, its fixture, and its registration",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Flow name (camelCase; this is what hf_run.flow stores, forever):",
        validate: (input: string) =>
          /^[a-z][A-Za-z0-9]*$/.test(input) || "camelCase, starting with a lower-case letter",
      },
      {
        type: "list",
        name: "queue",
        message: "Queue:",
        choices: [
          { name: "llm — model calls (concurrency 4)", value: "llm" },
          { name: "actions — sends and other side effects (concurrency 2)", value: "actions" },
          { name: "resolve — collection and resolution (concurrency 1)", value: "resolve" },
        ],
      },
    ],
    actions: [
      {
        type: "add",
        path: "src/flows/{{kebabCase name}}.ts",
        templateFile: "templates/flow.ts.hbs",
      },
      {
        // Every flow needs one: `flow-restart.test.ts` runs every registered flow on its
        // fixture, and a flow without one fails that suite rather than being skipped by it.
        type: "add",
        path: "fixtures/{{name}}.json",
        templateFile: "templates/fixture.json.hbs",
      },
      {
        type: "append",
        path: "src/hyperfixation.ts",
        // The sentinel comment above the flow imports, rather than one of those imports: a
        // generated flow must not anchor on a demo the app is about to delete.
        pattern: /^\/\/ `pnpm gen` appends a new flow's import.*$/m,
        template: 'import { {{name}}Flow } from "./flows/{{kebabCase name}}";',
      },
      {
        type: "append",
        path: "src/hyperfixation.ts",
        pattern: /flows: \[/,
        template: "    {{name}}Flow,",
      },
    ],
  });

  plop.setGenerator("record", {
    description: "A record table, its Drizzle schema, and its registration",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Record type (camelCase; machinery rows store this string):",
        validate: (input: string) =>
          /^[a-z][A-Za-z0-9]*$/.test(input) || "camelCase, starting with a lower-case letter",
      },
    ],
    actions: [
      {
        type: "add",
        path: "src/db/schema/{{kebabCase name}}.ts",
        templateFile: "templates/record.ts.hbs",
      },
      {
        type: "append",
        path: "src/db/schema/index.ts",
        template: 'export { {{name}} } from "./{{kebabCase name}}";',
      },
      {
        type: "append",
        path: "src/hyperfixation.ts",
        pattern: /records: \[/,
        template: '    { table: "{{snakeCase name}}", recordType: "{{name}}" },',
      },
    ],
  });
}
