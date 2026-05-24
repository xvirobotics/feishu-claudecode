import type { Logger } from '../../utils/logger.js';

/**
 * ExitPlanMode's native checkPermissions always returns `{behavior: "ask",
 * message: "Exit plan mode?"}` outside sub-agent contexts — independent of
 * `permissionMode: 'bypassPermissions'` and unreachable from PreToolUse hooks
 * (the "ask" path goes via a can_use_tool control_request). Without a
 * canUseTool handler the bridge gets back an is_error tool_result, the agent
 * stays in plan mode, and the user sees a perpetual "Exit plan mode?" loop.
 *
 * We always allow — the bridge already ships the plan body to the user as a
 * separate card via StreamProcessor + sendPlanContent, so they still see what
 * was decided before implementation continues. Non-ExitPlanMode tool calls
 * normally never reach this callback under bypassPermissions; we allow them
 * too as a safety net so a stray "ask" can't deadlock the session.
 */
export function makeCanUseTool(logger: Logger) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string },
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> {
    if (toolName === 'ExitPlanMode') {
      logger.info({ toolUseId: opts.toolUseID }, 'canUseTool: auto-approving ExitPlanMode');
    } else {
      logger.warn({ toolName, toolUseId: opts.toolUseID }, 'canUseTool: unexpected ask under bypassPermissions — allowing');
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
