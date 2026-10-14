// Use QAmcp from your own code: run a test and get the report.
export { runTest } from './runTest.js';
export { toHtml } from './htmlReport.js';
export { compareReports, evaluateGates, toJUnit, toMarkdown, toolFingerprints, toolboxHash } from './ci.js';
export { checkLoginSetup } from './oauthSetup.js';
export { checkResourcesAndPrompts } from './resourcesPrompts.js';
export type { CheckResult, ExtraCheck, Finding, ProgressEvent, Report, Status, TestOptions, ToolCallRecord } from './types.js';
