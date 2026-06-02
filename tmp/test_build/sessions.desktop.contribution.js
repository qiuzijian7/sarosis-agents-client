import { Action2, registerAction2 } from "../../platform/actions/common/actions.js";
import { registerWorkbenchContribution2, WorkbenchPhase } from "../../workbench/common/contributions.js";
import { OpenSessionInVSCodeAction, OpenInVSCodeWidgetContribution, OpenVSCodeWindowAction } from "./actions/vscodeActions.js";
import { IHostService } from "../../workbench/services/host/browser/host.js";
import { localize2 } from "../../nls.js";
import { Categories } from "../../platform/action/common/actionCommonCategories.js";
import { KeyCode, KeyMod } from "../../base/common/keyCodes.js";
import { KeybindingWeight } from "../../platform/keybinding/common/keybindingsRegistry.js";
class SessionsReloadWindowAction extends Action2 {
  static {
    this.ID = "sessions.action.reloadWindow";
  }
  constructor() {
    super({
      id: SessionsReloadWindowAction.ID,
      title: localize2("sessionsReloadWindow", "Reload Window"),
      category: Categories.Developer,
      f1: true,
      keybinding: {
        weight: KeybindingWeight.WorkbenchContrib + 51,
        primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR
      }
    });
  }
  async run(accessor) {
    const hostService = accessor.get(IHostService);
    return hostService.reload();
  }
}
(function registerActions() {
  registerAction2(OpenSessionInVSCodeAction);
  registerAction2(OpenVSCodeWindowAction);
  registerAction2(SessionsReloadWindowAction);
})();
(function registerWorkbenchContributions() {
  registerWorkbenchContribution2(OpenInVSCodeWidgetContribution.ID, OpenInVSCodeWidgetContribution, WorkbenchPhase.BlockRestore);
})();
