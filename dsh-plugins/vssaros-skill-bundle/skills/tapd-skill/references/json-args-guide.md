# JSON 参数跨平台写法

不同操作系统/Shell 下，`--args` 的 JSON 参数写法不同，使用不当会导致解析失败。

## macOS / Linux (bash/zsh)

```bash
mcporter-internal call tapd.proxy_execute_tool \
  --args "{\"workspace_id\": \"12345\", \"name\": \"新需求\"}"
```

- 外层用双引号，内部双引号用 `\"` 转义

## Windows PowerShell

```powershell
mcporter-internal call tapd.proxy_execute_tool `
  --args '{\"workspace_id\": \"12345\", \"name\": \"新需求\"}'
```

- **必须**用单引号包裹，内部双引号仍需 `\"` 转义
- **禁止**用双引号包裹 JSON（如 `--args "{"key":"value"}"`），PowerShell 会吞掉内部双引号，导致报错 `Unable to parse --args: Expected property name or '}' in JSON at position 1`

## Windows CMD

```cmd
mcporter-internal call tapd.proxy_execute_tool --args "{\"workspace_id\": \"12345\", \"name\": \"新需求\"}"
```

- 与 bash 写法相同
