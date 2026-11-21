// The WSL/Zsh/Bash shell as a subclass of the official bash executor. This module has no host
// dependency, so the class is testable against a stand-in base; executor.mjs mounts it.
import { assertExecutionPolicy, shellArgv } from './model.mjs';

function argvOf(environment, spec, distribution, executable) {
  return shellArgv(environment, spec, distribution, process.platform, executable);
}

/** The executor surface this module extends; an installation without it keeps the official shell rows. */
export function extensible(Base) {
  return typeof Base === 'function' && typeof Base.decorateResult === 'function'
    && typeof Base.prototype?.executeArgv === 'function';
}

// Extend the official bash executor: its process handles, output retention, cancellation, jobs,
// sandbox and Config stay official; only the argv that starts the shell changes. The class adds no
// method the official executor lacks, so the host sees the surface it expects.
export function mappedExecutor(Base, environment, distribution = '', executable = '') {
  return class MappedShellExecutor extends Base {
    // The single entry point of the official executor. Full access starts the chosen shell directly
    // and stamps the result as the official executor would; a confined call takes the official path,
    // which reaches confine() below.
    async execute(spec) {
      assertExecutionPolicy(environment, spec.sandboxPolicy);
      if (spec.sandboxPolicy.mode !== 'danger-full-access') return super.execute(spec);
      const handle = await super.executeArgv(spec, argvOf(environment, spec, distribution, executable));
      return Base.decorateResult(handle, result => ({
        ...result, sandbox: { mode: spec.sandboxPolicy.mode, denied: false },
      }));
    }

    // The chosen shell stays inside the official sandbox.
    confine(command, policy, signal) {
      assertExecutionPolicy(environment, policy);
      return this.ctx.sandbox.confine(argvOf(environment,
        { command, workdir: policy.workspaceRoot }, distribution, executable), policy, signal);
    }
  };
}
