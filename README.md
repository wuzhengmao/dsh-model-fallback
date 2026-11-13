# dsh-model-fallback

DSH 模型自动降级插件：首选模型**超时无响应**、**连接失败**或**低速率**时自动切换到备用模型，运行一段时间后再自动切回首选模型。

## 安装

### 方式一：DSH 插件面板（推荐）

DSH 的插件安装器（`installBundle`）原生支持 git 仓库地址直装。在 DeepSeek Harness 中打开左侧「全局面板」→「插件」，在插件安装入口填入本仓库地址：

```
https://github.com/wuzhengmao/dsh-model-fallback.git
```

### 方式二：本地目录安装（最通用可靠）

如果插件面板没有「从地址安装」的输入框，先把仓库克隆到本地，再让 DSH 安装这个本地目录：

```bash
git clone https://github.com/wuzhengmao/dsh-model-fallback.git
```

然后在 DSH 插件面板选择「本地文件 / 从本地目录安装」，指向克隆出来的 `dsh-model-fallback` 目录。

### 方式三：CLI（非桌面版 profile）

```bash
dsh plugin --profile <你的 profile 名> add https://github.com/wuzhengmao/dsh-model-fallback.git
```

> 桌面版默认 profile（`desktop`）由 Electron 应用独占管理，CLI 无法操作；此方式适用于 TUI 等其他 profile。

### 依赖说明

本插件把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/schemastery` 都声明为 `peerDependencies`，由 DeepSeek Harness 运行时提供，安装后无需额外处理依赖。

## 工作原理

插件以 `llm/stream` 瀑布流监听器（`{ global: true, prepend: true }`）挂载到所有 LLM 请求上，按**会话**维护状态机：

- `primary`（首选）：正常放行，同时监控流健康度。
- `fallback`（备用）：把请求改写为备用模型后，递归走完整 `llm/stream` 瀑布流（保留官方鉴权/重试中间件）。

**降级触发条件**（任一满足，仅 primary 模式下监控）：

1. **首 token 超时**：`timeoutMs`（默认 10000ms = 10 秒）内无任何流式响应。
2. **请求失败**：连接被拒、DNS 失败、鉴权失败等「零输出即失败」的情况。
3. **低速率**：请求开始满 `windowMs`（默认 30000ms）后，估算 token 速率低于 `minTokensPerSecond`（默认 30）。

**切回**：进入 fallback 满 `switchBackAfterMs`（默认 600000ms = 10 分钟）后由定时器自动切回首选模型，不依赖新请求触发。

**与对话框模型同步**：降级/切回时插件会调用 `agent.model.select()` 真正改写会话模型，因此输入框上显示的模型名会跟着变化，后续 step 也直接用新模型。拿不到 live agent 时退化为「仅在路由层改写」，对话框显示不变。

**尊重手动选择**：如果降级期间你自己在对话框里改选了别的模型，到期时插件发现当前模型已不是备用目标，就放弃切回。

## 默认配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后所有请求原样放行 |
| `primaryProvider` | `""`（空，必填） | 首选 provider |
| `primaryModels` | `[]`（空，必填） | 监控降级的首选模型列表（拦截这些模型的请求，其余原样放行） |
| `fallbackProvider` | `""`（空，必填） | 备用 provider（官方 DeepSeek 通道的运行时 id 为 deepseek-official） |
| `fallbackModel` | `""`（空，必填） | 备用模型（官方 DeepSeek 通道为 deepseek-flash） |
| `timeoutMs` | `10000`（设置页显示 10 秒） | 首 token 超时，0 关闭 |
| `windowMs` | `30000`（设置页显示 30 秒） | 低速率统计窗口 |
| `minTokensPerSecond` | `30` | 低速率阈值 token/s |
| `switchBackAfterMs` | `600000`（设置页显示 600 秒） | 降级持续多久后切回，0 表示不自动切回 |
| `asciiTokenPerChar` | `0.3` | 速率估算系数 |
| `cjkTokenPerChar` | `0.6` | 速率估算系数 |
| `logFile` | `""` | 日志文件绝对路径；留空只写宿主日志与控制台 |

> 设置页里三个时间字段按**秒**填写；配置文件里 `timeoutMs` / `windowMs` / `switchBackAfterMs` 仍以**毫秒**存储（历史字段名，保证已有配置不失效）。

> **配置不完整视为未启用**：`primaryProvider` / `primaryModels` / `fallbackProvider` / `fallbackModel` 任一为空（或列表为空）时，插件等同于未启用，所有请求原样放行。补全配置后**自动开始工作，无需重启 DSH、也无需重新安装插件**——插件在执行链路里实时读取配置，配置补全后的第一个请求就会开始接管。

## 配置方式

### 方式一：设置页（推荐）

DeepSeek Harness → 左下角账号菜单 →「设置」→ 左侧「模型自动降级」。

**保存后立即生效**：配置通过 `settings.mutate` 写入 profile，插件每次用到配置项时都实时读取，所以保存后立刻生效——不需要重启 DSH，也不需要手动重启插件，且不会清空当前的降级计时（正在进行的降级按旧时长走完）。

### 方式二：profile patch

在 profile 的 `cordis.patch.yml` 中按 entry id 覆盖，例如：

```yaml
- id: dsh-model-fallback
  name: dsh-model-fallback
  config:
    primaryModels:
      - primary-model
      - primary-model-mini
    fallbackProvider: deepseek-official
    fallbackModel: deepseek-flash
    timeoutMs: 10000
    minTokensPerSecond: 30
    switchBackAfterMs: 600000
```

## 语义说明

- **首 token 超时 / 请求失败降级**：首选流尚未输出任何内容，切换后由备用模型完整重发，输出干净无重复。
- **低速率降级**：首选流已输出部分内容，当前请求**不中断**（中断会造成 partial 与重发内容拼接），只标记降级，下一个请求起使用备用模型。降级日志会注明「下个请求生效」。
- **状态按会话隔离**：一个会话降级不影响其他会话。
- **估算 vs 官方 usage**：速率用双密度估算（ASCII 0.3 / 非 ASCII 0.6 token/字符）近似，仅用于阈值判断。

## 排查

- 日志默认写宿主日志流与控制台（桌面版 Host stdout 不落盘，正常运行时看不到）。
- 需要事后排查时把 `logFile` 设为绝对路径，例如 `D:\logs\dsh-model-fallback.log`。
- 每次配置生效、降级、切回、放弃切回都会写入一行日志，前缀 `[dsh-model-fallback]`。

## License

MIT
