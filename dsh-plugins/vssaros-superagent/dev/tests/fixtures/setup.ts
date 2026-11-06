// VsSaros addition (built-in packaging): load the DSH modules dsh-superagent reads synchronously, as `apply` does in the Host.
import { loadHostModules } from '../../src/infra/host.ts'

await loadHostModules()
