/**
 * The delegation workflow: the choices an orchestrator follows when it hands
 * work to workers (routing, briefs, tabs, when to close a worker), kept apart
 * from the skill's commands so a user can change them.
 *
 * Two layers, like the profiles. The global workflow is `<configDir>/workflow.md`,
 * or the built-in default until that file exists. A project adds rules in
 * `<project>/.herdr/workflow.md`; they come after the global ones and win where
 * the two conflict.
 */
import fs from "node:fs";
import path from "node:path";
import { globalWorkflowPath, projectWorkflowPath, sourceRoot } from "./paths.mjs";

export function defaultWorkflowText(root = sourceRoot()) {
  return fs.readFileSync(path.join(root, "src", "core", "default-workflow.md"), "utf8");
}

const PROJECT_TEMPLATE = `<!--
This project's delegation rules. \`herdr-loadout workflow\` shows them after the global
workflow, and where the two conflict these win. Write only what differs for this project.
-->
`;

/**
 * Both layers as they apply to `projectRoot`.
 * @returns {{global: {path: string, builtIn: boolean, text: string}, project: {path: string, exists: boolean, text: string | null}}}
 */
export function loadWorkflow({ projectRoot, env = process.env, fsImpl = fs } = {}) {
  const globalPath = globalWorkflowPath(env);
  const builtIn = !fsImpl.existsSync(globalPath);
  const project = projectWorkflowPath(projectRoot, fsImpl);
  return {
    global: { path: globalPath, builtIn, text: builtIn ? defaultWorkflowText() : fsImpl.readFileSync(globalPath, "utf8") },
    project: { ...project, text: project.exists ? fsImpl.readFileSync(project.path, "utf8") : null },
  };
}

/** The workflow an orchestrator reads: global first, then this project's rules. */
export function renderWorkflow(workflow) {
  const { global, project } = workflow;
  const lines = [
    `<!-- global workflow: ${global.builtIn ? `built-in default; \`herdr-loadout workflow init\` copies it to ${global.path} to edit` : global.path} -->`,
    "",
    global.text.trimEnd(),
    "",
  ];
  if (project.exists) {
    lines.push(
      `<!-- project workflow: ${project.path} -->`,
      "",
      "# This project's rules",
      "",
      "These add to the workflow above. Where the two conflict, follow these.",
      "",
      project.text.trimEnd(),
      "",
    );
  } else {
    lines.push(`<!-- no project workflow; ${project.path} would add one -->`, "");
  }
  return lines.join("\n");
}

/**
 * Create a workflow file to edit: the global one starts as a copy of the
 * built-in default, a project one as an empty template. An existing file is
 * left alone.
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function initWorkflow({ scope, projectRoot, env = process.env }) {
  const file = scope === "project" ? projectWorkflowPath(projectRoot).path : globalWorkflowPath(env);
  if (fs.existsSync(file)) return { ok: false, error: `${file} already exists; edit it` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, scope === "project" ? PROJECT_TEMPLATE : defaultWorkflowText());
  return { ok: true, path: file };
}
