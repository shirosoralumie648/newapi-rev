# Playground 改进记录

> 这是一份持续维护的 Playground 产品与技术改进清单，用来固化历史讨论中的目标、边界、决策和验收标准，避免计划只存在于聊天记录中。

- **最后更新**：2026-10-18
- **适用范围**：`web/src/features/playground/`、Playground 相关 Go controller/model/router/middleware，以及后续资源配额、附件和画布能力
- **当前原则**：保留 `new-api` 的认证、Relay、模型分组、计费和权限体系；Playground 只在此基础上扩展产品能力

## 1. 总体目标

将当前单栏 Playground 演进为可扩展的 AI 创作工作区，逐步提供：

- 多会话和会话管理；
- 类 LobeHub 的聊天工作区体验；
- 消息编辑、重新生成、版本和分支；
- 附件与多模态消息；
- Markdown、Code 和其他 Artifact 的安全预览；
- 服务端会话、消息和资源同步；
- Infinite Canvas 风格的节点画布；
- 图片、视频、音频等任务能力；
- Agent、工具和工作流能力；
- 面向用户/用户组的独立资源配额。

最终形态不是把两个参考项目直接拼接，而是：

```text
new-api Go/Gin/GORM/认证/Relay/Billing
                 +
new-api React/TanStack/Zustand 前端
                 +
LobeHub 风格聊天工作区
                 +
Infinite Canvas 风格画布交互
                 +
独立的 Playground 资源与存储配额
```

## 2. 已确定的架构边界

### 2.1 模型请求链路不变

所有 Playground 模型请求继续走现有链路：

```text
Playground
  → /pg/chat/completions
  → controller.Playground
  → Relay
  → Provider
```

不得在前端或新功能中直接调用 Provider，也不得绕过现有认证、模型分组、权限和计费逻辑。

### 2.2 前端技术栈不变

继续使用项目现有的：

- React 19；
- TypeScript；
- Rsbuild；
- TanStack Router / Query；
- Zustand；
- Tailwind CSS；
- `web/src/components/` 和 `web/src/components/ai-elements/` 中的共享组件；
- 项目现有的 i18n、测试和格式化工具。

新增 UI 优先复用现有 `Conversation`、`PromptInput`、`Branch`、`Artifact`、`CodeBlock`、`Canvas`、`Sheet`、`ConfirmDialog`、`CopyButton` 等组件，不重复实现已有的通用交互。

### 2.3 数据归属和存储边界

- 浏览器 `localStorage` 只作为受限的迁移兼容层或临时缓存，不能作为最终数据源；
- 会话、消息、附件、Artifact 和画布数据必须明确关联 `user_id`；
- session、attachment、artifact 和 canvas 之间必须有明确的归属关系；
- 服务端必须校验所有者、会话和资源权限，不能依赖前端隐藏或过滤；
- `MessageAttachment.url` 不能被当作永久文件所有权证明；
- `blob:` URL 不能作为跨刷新、跨设备的持久化附件引用。

### 2.4 资源配额独立于 Token Quota

文件空间、Artifact 空间、会话数、消息数、画布节点数和任务并发量等资源，不应直接写入 `User.Quota` 或 `UsedQuota`。

这些资源应使用独立的用户/用户组策略，至少支持：

- 会话数量上限；
- 消息数量或消息存储大小上限；
- 附件总字节数、单文件大小、文件数量上限；
- Artifact 数量、版本数量和正文大小上限；
- 画布项目数量、节点数量和持久化大小上限；
- 图片/视频/音频任务的并发或任务数量限制；
- 管理员或用户组级别的配置；
- 服务端事务内的原子检查和稳定错误码。

## 3. 分阶段改进路线

状态说明：`已完成`、`进行中`、`待实施`、`延期/另行设计`。

### Phase 0：状态和存储基础 — 已完成

- [x] 为 Playground session 建立版本化 storage envelope；
- [x] 使用 schema 校验配置、参数、消息和 session 数据；
- [x] 限制消息数量、字符数、字节数和整体存储大小；
- [x] 按认证用户隔离浏览器数据；
- [x] 用户切换时重新 hydrate，避免账号间数据泄漏；
- [x] 修复快速新建、切换、删除时的 active session 持久化问题；
- [x] 保留旧版数据的一次性迁移兼容；
- [x] 正常流程不再把旧的全局 config/parameter key 作为活跃状态源；
- [x] 对损坏、超限和不符合 schema 的本地数据安全降级。

### Phase 1：聊天工作区 MVP — 已完成/持续修正

- [x] 桌面端会话列表和主聊天区；
- [x] 移动端 Sheet/Drawer 形式的会话列表；
- [x] 新建、切换、搜索、重命名和删除会话；
- [x] 删除当前会话后的有效 fallback；
- [x] 键盘访问、active session 语义和无障碍名称；
- [x] 新增文案接入七种前端语言；
- [x] 保留现有流式消息、reasoning、编辑、删除和重新生成能力；
- [x] 明确右侧 Inspector/Artifact 面板与全局导航侧栏的边界（Artifact 面板属于 Playground 工作区内部，由聊天头部按钮切换，不占用全局导航侧栏；移动端为右侧 Sheet；UX-02 起 Playground 与画布编辑器共用右侧 Inspector 外壳，制品与画布预览在同一面板的两个视图间切换）；
- [x] 完善桌面、移动、窄屏、暗色模式和嵌套滚动的真实浏览器验收（Playwright E2E：桌面与移动视口、暗色模式跨刷新持久化、会话列表嵌套滚动不带动页面）。

### Phase 2：服务端会话和消息同步 — 已完成

- [x] 建立 Playground session 的后端模型和管理接口基础；
- [x] 建立消息快照/同步接口基础；
- [x] 查询 key 包含用户和 canonical session；
- [x] 账号切换、会话切换和删除时屏蔽迟到请求；
- [x] 完成服务端与本地缓存的一致性策略；
- [x] 明确首次加载、离线编辑、网络失败、冲突和响应丢失的恢复行为；
- [x] 通过 SQLite、MySQL、PostgreSQL 的新库和升级库验证迁移幂等性；
- [x] 增加服务端所有者、跨用户、跨 session 和并发更新测试。

### Phase 3：Artifact 和安全预览 — 已完成

- [x] 支持从完成的助手正文显式创建 Markdown Artifact；
- [x] 支持从选中的代码块显式创建 Code Artifact；
- [x] Artifact 保存独立快照和稳定版本 ID，不依赖原消息永久存在；
- [x] 支持标题、语言、正文编辑和不可变版本；
- [x] 支持浏览历史版本、恢复旧版、复制、下载和删除；
- [x] Markdown 使用现有安全渲染链路；
- [x] Code 只作为文本展示或导出，不执行代码、不使用不受信任 iframe；
- [x] 完成冲突、幂等、响应丢失和草稿恢复的前端行为；
- [x] 完成 Artifact 数量、版本数量、单版本大小和 session 总容量限制（事务内校验：32 个活跃 Artifact、256 条创建记录、单 Artifact 100 版本并 8 MiB、单版本 256 KiB、会话总计 32 MiB；`TestPlaygroundArtifactCapacity` 覆盖，超限返回 422 且保留既有快照）；
- [x] 完成桌面并排面板、移动端 Sheet、焦点和未保存离开保护（`ResizablePanelGroup` 桌面并排、移动端左右 Sheet、Base UI Sheet 焦点陷阱与恢复、`beforeunload` 与确认对话框保护草稿；`workspace-layout.test.tsx` 与 artifact panel 测试覆盖）。

### Phase 4：附件和多模态消息 — 已完成

- [x] 明确允许的文件类型、单文件大小、数量和总容量（PNG/JPEG/WebP/GIF；单文件 8 MiB、单条消息最多 8 个、每用户 64 MiB，服务端事务内校验并按所有者行锁保证并发准确）；
- [x] 复用 `PromptInput` 的附件入口、拖放和粘贴能力（选择/拖放/粘贴沿用现有组件，入口改为直接打开文件选择器，接线 `accept`/`maxFiles`/`maxFileSize` 与附件预览、移除）；
- [x] 建立服务端附件对象和用户/会话归属（`playground_attachments` 表：ID/UserID/SessionID/ClientKeyHash/MediaType/Filename/ByteSize/ContentHash/Data/ReferencedAt，client key 幂等重放；跨用户/跨会话一律 404）；
- [x] 使用受控下载地址或访问接口，不能把任意 URL 当作永久附件（`GET .../attachments/:id/content` 需会话鉴权，owner+session 过滤后按存储 media type 输出，附 nosniff/CSP/no-referrer；消息快照只存附件引用不存 URL）；
- [x] 让消息模型支持文本、图片和受支持的 content parts（消息版本引用附件并存储规范化元数据；仅用户消息允许引用；替换快照时同一事务重算引用状态，被引用附件禁止删除）；
- [x] 在 payload builder 中正确构造 OpenAI 多模态消息（`formatMessageForAPI` 由附件缓存构造 `[{type:'text'},{type:'image_url',image_url:{url:dataURL}}]`；发送前按需加载历史附件字节，缺失时保留文本降级）；
- [x] 对不支持视觉或不支持指定附件的模型返回可理解的错误（客户端不静默丢弃附件；上游拒绝时错误按现有链路原样呈现，消息进入错误态）；
- [x] 附件上传、读取、删除和过期清理都执行服务端权限校验（上传/列表/详情/内容/删除全走 `UserAuth` + owner/session 过滤；清理为 master 定时系统任务，删除超过 48 小时未被引用的附件）；
- [x] 覆盖类型、大小、数量、权限、过期、失败重试和跨账号访问测试（`model/playground_test.go` 附件矩阵：幂等重放/冲突、签名与类型校验、单文件与每用户预算边界、引用与解除引用、孤儿清理、会话级联、真实路由 401/PAT 403/内容读取；前端 `attachment-flow`、`playground-input-attachments`、`message-attachment-list`、`server-api` 与 E2E `playground-attachments.spec.ts`）。

### Phase 5：Infinite Canvas — 进行中

- [x] 建立画布项目、节点、边和节点资源模型（服务端 `PlaygroundCanvasProject` + 规范化 document 契约，前端 `types.ts` 的节点/边/文档类型与 `lib/canvas-document.ts` 的 Zod 校验）；
- [x] 复用项目已有 `@xyflow/react` 和 `Canvas`/`Node`/`Edge` 能力（`components/ai-elements/canvas`、`node`、`panel` 组合出 `features/canvas/components/canvas-editor.tsx` 与 `canvas-node.tsx`，未新增依赖）；
- [x] 支持缩放、平移、选区、小地图和节点详情（沿 `Canvas` 的缩放/平移/框选默认行为，`MiniMap` 小地图，右侧 Inspector 节点详情，移动端 Sheet，`canvas-node-inspector.tsx`）；
- [x] 支持撤销/重做（`hooks/use-canvas-editor.ts` + `lib/canvas-history.ts`，仅结构性变更入栈，工具栏按钮与 Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl/Cmd+Y 快捷键，可编辑元素内不拦截、编辑器禁用时不生效；`use-canvas-editor.test.ts` 覆盖快捷键矩阵、输入框透传与禁用态）；
- [x] 支持导入/导出和版本化保存（工具栏 JSON 导入/导出复用 `parseCanvasImport`/`serializeCanvasExport`，以 `version:1`+`app` 校验版本化文件，超限/损坏文件抛出可翻译的 `CANVAS_ERRORS` 键且不静默截断，保存走 `updateCanvasProject` 的 revision CAS，冲突态提示重新加载；`canvas-document.test.ts` 覆盖损坏文件、超大节点与超预算文档的拒绝路径）；
- [x] 将聊天消息、Prompt、文件、Artifact、图片和任务结果映射为节点（节点类型扩展为 `text/note/prompt/message/attachment/image/artifact/task/task-result`，`ref` 保存 `sessionId/messageKey/attachmentId/artifactId`；Playground 消息操作与 Artifact 面板新增「发送到画布」，经 `buildMessageCanvasSeeds`/`buildArtifactCanvasSeeds` 生成 prompt/message/attachment/artifact 节点并写入所选画布或新建画布，revision CAS 冲突重试一次；附件/图片节点经受控内容接口按 `sessionId`+`attachmentId` 预览；`canvas-send.test.ts`、`canvas-send-dialog.test.tsx`、`message-actions.test.tsx` 覆盖；本地未运行测试（CI-only））；
- [x] 建立画布项目和用户的归属关系（`playground_canvas` 表按 `user_id` 唯一与查询，列表/读取/更新/删除均带 `user_id = ?` 过滤，`model/playground_canvas_test.go` 覆盖跨用户 404）；
- [x] 限制项目数量、节点数量和持久化大小（每账号 20 个项目 / 16 MiB、单文档 1 MiB、200 节点、400 边、单节点数据 64 KiB；服务端事务内校验并返回稳定错误码，前端 `validateCanvasDocument` 先做本地反馈）；
- [x] 明确画布数据与 session/消息/附件/Artifact 的引用关系与生命周期，避免删除消息或会话导致画布资源意外丢失（服务端新增 `PlaygroundCanvasAsset` 画布-附件 pin 表：创建/更新画布时在同一事务内重建被引用附件的 pin，删除画布或保存不再引用该附件的文档时释放；`DeleteOrphanedPlaygroundAttachments` 跳过被 pin 的附件，被 pin 的附件禁止手动删除，删除会话级联时一并清理其附件 pin；`ValidatePlaygroundCanvasReferences` 改为「跨账号引用仍返回 400 `PLAYGROUND_CANVAS_REFERENCE_INVALID`，已删除资源容忍并保持画布可编辑」，读取画布时由 `PlaygroundCanvasReferenceAvailability` 计算 `unavailable_node_ids`；前端 `applyCanvasReferenceStatus` 将缺失来源的节点标记 `sourceDeleted`，`canvas-node.tsx` 显示「来源已删除」徽标与快照提示、`canvas-node-inspector.tsx` 同提示，节点保留 `text`/`snapshot`/`label` 内容快照；`model/playground_canvas_test.go` 的 `TestPlaygroundCanvasAttachmentPins`、`TestPlaygroundCanvasAttachmentDereference`、`TestPlaygroundCanvasSessionCascade`、`TestPlaygroundCanvasReferenceSourceDeleted` 与扩展的 `TestPlaygroundCanvasReferenceOwnership` 覆盖引用/解除引用、跨用户引用 400、会话级联与孤儿清理交互、来源删除标记；`canvas-node.test.tsx`、`canvas-document.test.ts` 覆盖渲染与状态应用；补 2 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试（CI-only））。
- [x] 统一桌面/移动端右侧 Inspector 并打通聊天与画布的双向跳转（新增共享 `components/workspace-inspector.tsx`：桌面 `ResizablePanelGroup` 并排、移动端右侧 Sheet，复用 Base UI 焦点陷阱与既有未保存草稿保护；Playground 头部「Artifacts」/「Canvases」切换同一 Inspector 的制品列表与只读画布预览（`playground-canvas-panel.tsx` 经 `listCanvasProjects`/`getCanvasProject` + `fromServerDocument` 预览节点并可「打开画布」跳转全量编辑器），画布编辑器节点详情复用同一外壳；路由新增 `validateSearch` 深链：`/playground?session&message&artifact` 切换到对应会话并打开制品、`/playground/canvas?project` 打开指定画布；画布节点详情新增「来源」区，经 `lib/canvas-navigation.ts` 生成跳转参数回到源会话/制品（`CanvasNodeInspector` 仅暴露 `onOpenSource` 回调，由 `CanvasWorkspace` 用 `useNavigate` 接线，保持组件不依赖路由、可测试）；扩展 `workspace-layout.test.tsx`（桌面并排/隐藏与视图切换、移动 Sheet 关闭、会话列表入口），新增 `playground-canvas-panel.test.tsx`、`canvas-navigation.test.ts`、`canvas-node-inspector.test.tsx`，并扩展 `canvas-send-dialog.test.tsx` 断言 `onSent(project)`；`i18n:sync` missingCount=0、extrasCount=0（补 5 个新键的七语言翻译）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only））。

### Phase 6：多媒体、Agent 和工作流 — 进行中

- [x] 将图片、视频、音频生成任务映射到 `new-api` 现有 Relay、渠道和 task plugin（新增 `/pg/images/generations`、`/pg/images/edits`、`/pg/videos`、`/pg/audio/speech` 媒体路由：`middleware.PlaygroundRelayBridge` 在任务插件 pin 与渠道选择之前把路径重写为对应 `/v1` 规范路径，并按 `PlaygroundRequest.group` 复用账号可用用户组覆盖校验；随后沿用既有 `PinTaskPluginEndpoint`/`PrepareTaskPluginEndpoint`/`Distribute`，图片/视频由 `controller.RelayTaskPluginEndpoint` 分流到插件协议桥或内置 `Relay`/`RelayTask`，语音为同步 `Relay(RelayFormatOpenAIAudio)`；渠道、权限和计费仍由原管线处理，前端 `playground-generation-panel.tsx` 只调用 `/pg`；`playground-generation-panel.test.tsx` 断言图片/视频提交到正确路由与请求体；无新依赖；本地未运行测试/typecheck/lint/build（CI-only））；
- [x] 复用现有任务状态、错误、权限和计费链路（任务列表与状态轮询直接复用 `/api/task/self` 与会话日志的 `taskStatusMapper`/`StatusBadge`，结果预览与展示复用 `TaskArtifactsCell`，结果字节仅经受控的 `/api/task/:task_id/artifacts` capability 接口读取；Q-01 的 `TaskMaxConcurrency` 在 `controller/playground_generation.go` 内以 `model.CountActivePlaygroundTasks` 按账号 durable task 行强制，独立于 `User.Quota` 与 token 计费，超限返回稳定错误码 `PLAYGROUND_TASK_LIMIT_EXCEEDED` 并登记七语言文案与 `server-error-message` 映射；画布任务结果节点只保存 `taskId`/`taskArtifactKey` 引用，保存时按 `(user_id, task_id)` 校验归属，跨账号引用返回 400、失效任务在读取时标记不可用；`model/playground_test.go` 的 `TestPlaygroundTaskConcurrencyCount` 覆盖全局/用户组并发预算与终态释放，`model/playground_canvas_test.go` 的 `TestPlaygroundCanvasTaskReferences` 覆盖归属/缺 key/删除容忍，`playground-generation-panel.test.tsx` 覆盖任务状态渲染与「发送到画布」引用种子；本地未运行测试/typecheck/lint/build（CI-only））；
- [x] 设计 Agent/工具调用状态，但不默认允许任意代码执行（消息版本新增 `toolCalls` 快照，每条调用记录 `id`/`name`/`arguments`/`status`（pending·completed·denied·error）/`result`/`errorMessage` 与时间戳：流式回复按 index 增量合并（`applyToolCallDelta` 丢弃乱序/跳号 index，保证已存数组稠密、绝不会保存稀疏快照），非流式回复整体写入（`applyResponseToolCalls`）；Playground 从不执行工具——`message-tool-calls.tsx` 复用 ai-elements `Tool`/`Confirmation` 展示四种状态，用户通过「提供结果」对话框粘贴外部获得的结果（`PLAYGROUND_TOOL_CALL_RESULT_MAX_CHARS` 本地上限）或「拒绝」，`pending` 调用存在时输入框禁用并提示，全部答复或拒绝后才显示「继续生成」；请求 payload 把助手消息展开为 `tool_calls` + 每条已答复调用一个 `tool` 消息（拒绝/失败使用固定协议文案），`pending` 调用不发送；服务端 `validatePlaygroundToolCalls` 严格要求仅助手消息、每版最多 16 条调用、`id`/`name` 非空且 `id` 唯一、参数 64 KiB/结果 256 KiB 上限、状态枚举，违规 400 且事务回滚保留既有快照；策略字段 `tool_call_max_count`/`tool_call_arguments_max_bytes`/`tool_call_result_max_bytes` 支持全局默认与按用户组覆盖（管理端「Tool calls」分组），`tool_calls` 仅按版本存取、`getMessageContentState` 按被渲染版本判断可见性以在分支视图正确显示；前端 `tool-call-state.test.ts`（增量合并与跳号丢弃、状态流转与响应内容、pending 门禁与继续生成、payload 展开与 pending 排除、存储往返、分支版本可见性）与 `message-tool-calls.test.tsx`（待办动作与拒绝、结果对话框提交、已拒绝/已提供展示、继续生成仅最后版本可见），后端 `TestPlaygroundToolCallSnapshots`（SQLite/MySQL/PostgreSQL 往返 + 非助手/超量/重复·空 id/超长参数·结果/未知状态拒绝且保留历史）；补 19 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only））；
- [x] 设计工作流节点、输入输出、失败重试和任务取消（画布新增 `model` 工作流节点，链路为 Prompt/消息/附件/图片/Artifact 产出 → `model`（模型调用）→ `task`（图片/视频生成提交）→ `task-result`（终态结果接收，只在 `ref` 保存 `taskId`/`taskArtifactKey` 引用）：服务端节点类型契约新增 `model`（`controller/playground_canvas.go`），`controller/playground_canvas_test.go` 覆盖工作流类型接受、未知类型拒绝与节点数据字节上限；前端 `lib/canvas-workflow.ts` 运行前校验（组、模型与输入齐备、无环）并拓扑排序，`hooks/use-canvas-workflow-runner.ts` 顺序执行——`model` 经 `sendChatCompletion`（`/pg/chat/completions`，非流式，输出有界、空输出视为失败），`task` 图片经 `submitImageGeneration`、视频经 `submitVideoGeneration` 后按 `CANVAS_WORKFLOW_TASK_POLL_INTERVAL_MS`（5s）轮询 `getUserTaskLogs` 的 durable 任务行，成功后仅为下游 `task-result` 节点抓取 `getTaskArtifacts` 写入引用；开始时已 `running` 的步骤改为轮询既有任务而非重复提交，页面加载时按 durable 行恢复 `running` 任务节点（SUCCESS 写产物、FAILURE 写失败原因）；失败重试从该步骤起重跑并复用已存输出；取消中止本地运行并对未完成任务调用 `cancelPlaygroundTask`，随后按 durable 行结算；执行全部经既有 `/pg` 路由与任务系统（认证、分组、渠道与计费沿用原管线），节点数据只存配置与 ID 引用、无代码与 Provider 地址，运行状态以 `record:false` 写入不污染撤销历史；节点/工具栏/Inspector 展示状态、错误与重试/取消；新增 `canvas-workflow.test.ts`、`use-canvas-workflow-runner.test.ts`、`canvas-toolbar.test.tsx`，扩展 `canvas-node.test.tsx`、`canvas-node-inspector.test.tsx`、`use-canvas-editor.test.ts`；补 19 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only））；
- [x] 支持素材库、任务结果和 Artifact/Canvas 的安全关联（新增只读 `GET /api/playground/assets`：`UserAuth` + owner 过滤，`kind=attachment|artifact` 必填，非法 kind、非法分页或超 100 字符的搜索返回 400 `PLAYGROUND_INVALID_REQUEST`，内部错误返回 `PLAYGROUND_STORAGE_ERROR`；`model/playground_assets.go` 的 `ListPlaygroundAssets` 附件按 `created_at DESC, id DESC`、Artifact 按 `updated_at DESC, id DESC` 排序，搜索为大小写不敏感的字面子串（转义 `%`/`_`/`!`，`LOWER(...) LIKE ? ESCAPE '!'` 跨 SQLite/MySQL/PostgreSQL），附件 `in_use` 取消息引用（`referenced_at > 0`）或画布 pin，Artifact 排除墓碑（`deleted_at = 0`），分页沿用 `playgroundStrictPage`（page_size ≤ 50）；任务结果不进入该接口，继续经 owner 隔离的 `/api/task/self` 与 `TaskArtifactsCell` 复用既有任务链路，Artifact/画布关联沿用 P5-04 的 pin 与归属校验；前端工作区 Inspector 新增「素材库」视图（`components/asset/playground-asset-library.tsx`、`playground-asset-card.tsx`、`playground-asset-preview-dialog.tsx`；`asset-api.ts` 做 snake→camel 映射，`use-playground-assets` 提供素材库/任务结果查询，`use-attachment-preview-url` 由画布节点与素材卡共用），素材卡复用 `ArtifactAction` 与 `ConfirmDialog`，`in_use` 的附件禁用删除并提示；「发送到聊天」把附件经受控内容接口取回为 `File` 注入输入框待发送列表、Artifact 正文追加到草稿（`playground-input.tsx` 的 `pendingFiles`/`pendingText` 只消费一次），「发送到画布」沿用 `buildAttachmentCanvasSeeds` 只保存引用；`model/playground_test.go` 的 `TestPlaygroundAssetLibraryListing` 覆盖 SQLite/MySQL/PostgreSQL 矩阵（in_use、墓碑排除、跨用户隔离、分页、搜索转义、非法查询 400），真实 router 鉴权用例新增 `/api/playground/assets?kind=attachment`，该路由同时声明于 `middleware/access_token_routes.go`（会话级访问令牌规则，与其余 Playground 路由一致）；前端新增 `playground-asset-library.test.tsx`（8 用例）并扩展 `canvas-send.test.ts`、`playground-input-attachments.test.tsx`；补 17 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only）；任务结果与 Artifact/Canvas 的引用关联已由 P6-01/P6-03 完成：`task-result` 节点只保存 `taskId`/`taskArtifactKey`，服务端按 `(user_id, task_id)` 校验归属、读取时对失效引用标记不可用）；
- [x] 为长任务设置并发、存储和生命周期限制（任务行新增 `TaskPrivateData.PlaygroundOrigin` 来源标记：`controller/playground_generation.go` 在调用中继前写入 `constant.ContextKeyPlaygroundOrigin`，`controller/relay.go` 的任务创建沿用同一标记，并发/存储/清理/取消策略只作用于工作区来源任务，不读取也不改写 `User.Quota` 或 token 计费；提交预算统一由 `controller/playground_generation.go` 的 `enforcePlaygroundTaskBudget`（原 `enforcePlaygroundTaskConcurrency`）在 Relay 前强制——并发沿用 `model.CountActivePlaygroundTasks`（`TaskMaxConcurrency`），新增独立账户级结果存储预算 `TaskUserResultMaxBytes`（默认 64 MiB，零/负值继承，支持全局与用户组覆盖），`model.PlaygroundTaskResultStorageBytes` 按方言统计工作区任务结果快照字节（SQLite `json_extract(private_data,'$.playground_origin')=1` + `LENGTH(CAST(data AS BLOB))`、MySQL `JSON_UNQUOTE(JSON_EXTRACT(...))='true'` + `OCTET_LENGTH(CAST(data AS CHAR))`、PostgreSQL `private_data->>'playground_origin'='true'` + `OCTET_LENGTH(CAST(data AS TEXT))`），超限返回 429 `PLAYGROUND_TASK_STORAGE_LIMIT_EXCEEDED` 与七语言文案；生命周期新增调度任务 `playground_task_cleanup`（`service/playground_task_cleanup.go`，7 天 TTL、每 6 小时、每批 200，`model.DeleteExpiredPlaygroundTasks` 只硬删除 `finish_time` 已过期的终态工作区任务行，轮询沿用状态 CAS 不会复活）；取消新增 `POST /api/playground/tasks/:taskId/cancel`（`UserAuth` + `accessTokenSessionRule`）与 `model.CancelPlaygroundTask`：按 `(user_id, task_id, playground_origin)` 过滤并用状态 CAS 转 FAILURE（进度 100%、`FailReason="Task canceled"`），成功后 `service.RefundTaskQuota` 退还预留额度，404/409/500 稳定错误码；工作区任务列表新增取消按钮 + `ConfirmDialog` + `useCancelPlaygroundTask`（结算后同时刷新任务列表与用量），`GET /api/playground/usage` 新增 `tasks` 指标（活跃并发 vs `TaskMaxConcurrency`、快照字节 vs `TaskUserResultMaxBytes`）并在用量弹层展示，管理端配额新增字段 `task_user_result_max_bytes`；`model/playground_test.go` 新增 `TestPlaygroundTaskStorageBudget`（SQLite/MySQL/PostgreSQL 矩阵，含控制器 429 路径）、`TestPlaygroundTaskExpiryCleanup`（矩阵）、`TestPlaygroundTaskCancellation`（owner 作用域、404/409、CAS、成功与退款守卫），扩展 `TestPlaygroundUsageForUserReportsOwnerTotals` 与真实路由鉴权用例；前端扩展 `playground-generation-panel.test.tsx`（取消确认）与 `playground-usage-popover.test.tsx`（Tasks 指标）；补 10 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only））；
- [x] 不复制参考项目的 Provider、浏览器 API Key 或独立后端（工作流运行全部复用既有 `/pg` 路由、Relay、渠道与任务系统：`model`/`task` 节点只保存模型名、生成类型与 ID 引用，不保存可执行代码或 Provider 地址；请求由服务端带用户身份发起，前端不接触上游凭据；无独立后端）。

### Phase 7：跨设备、协作和分享 — 延期/另行设计

- [ ] 跨设备恢复会话、附件、Artifact 和画布；
- [ ] 设计分享链接、只读权限、编辑权限和撤销机制；
- [ ] 设计协作冲突和版本合并；
- [ ] 设计资源导出、删除、保留期和隐私审计；
- [ ] 完成安全评审和三数据库验证后再实施。

## 4. 参考项目和许可证边界

### `basketikun/infinite-canvas`

用途：参考无限画布的交互、节点模型、撤销重做、项目导入导出和资源组织方式。

- 许可证：MIT；
- 如果迁移实质性代码，必须保留 copyright 和 license notice；
- 不迁移其 API Proxy、浏览器端 API Key 存储或 Provider 体系；
- 所有模型和任务请求改走 `new-api` 的认证、Relay 和 billing。

### `lobehub/lobehub`

用途：参考聊天工作区、会话列表、Topic、消息操作、附件、Artifact、编辑器和响应式布局。

- 根目录许可证为 LobeHub Community License，不能仅依据 `package.json` 中的 license 字段判断；
- 默认只参考产品交互、数据边界和设计思路，在 `new-api` 内独立实现；
- 如果确实需要复制源码，必须先确认授权范围、适用版本、分发方式和 attribution 要求；
- 不复制其品牌、完整应用、独立后端或无关依赖。

## 5. 必须保持的质量和安全要求

- 所有用户可见文案使用 i18n，并同步七种前端语言；
- 所有服务端资源操作校验用户、session 和资源归属；
- 不把前端权限检查当作服务端安全控制；
- 不执行 Artifact 中的任意 HTML、JavaScript 或用户代码；
- 不在日志中写入 token、私密附件地址或可用认证凭据；
- 数据库模型、迁移、索引、约束和事务必须兼容 SQLite、MySQL 和 PostgreSQL；
- 资源上限必须在服务端验证，不能依赖前端截断；
- 不静默删除、淘汰或截断用户数据；
- 所有异步写入在账号/会话切换和删除后屏蔽迟到响应；
- 新功能优先扩展现有测试文件或 feature-owned `__tests__/`，避免为同一小功能在多层重复造测试；
- 前端使用 Bun，至少运行受影响测试、typecheck、定向 lint、格式检查和构建检查；
- 涉及数据库的改动必须记录真实 SQLite、MySQL、PostgreSQL 版本、命令和结果；
- 未完成真实数据库矩阵、浏览器验收或安全检查时，不得声称 release-ready。

## 6. 验收清单

### 会话和状态

- [x] 新用户可以创建、切换、重命名、删除和清空会话（`use-playground-state.test.tsx` 会话 CRUD 与切换、E2E 桌面/移动端创建/重命名/删除、`playground-input-tools.test.tsx` 清空确认流程）；
- [x] 账号 A 无法读取账号 B 的 session、消息、附件、Artifact 或画布（session/消息/附件/Artifact 已有跨用户 404 测试；画布由 `model/playground_canvas_test.go` 的 `TestPlaygroundCanvasPersistenceMatrix` 与 `TestPlaygroundCanvasSessionCascade` 覆盖跨用户读取/删除 404，`TestPlaygroundCanvasReferenceOwnership` 覆盖跨账号引用在创建与更新时返回 400；本地未运行测试（CI-only））；
- [x] 切换或删除会话后，旧请求的迟到 chunk 不会写入新会话（`use-stream-request.test.ts` latest-wins 与旧 source 事件忽略；会话切换与账号切换的 generation/session 守卫由同步层测试覆盖；已有检查项记录见 Phase 2）；
- [x] 浏览器刷新、重新登录和跨设备加载不会产生错误归属（E2E：重命名后刷新以及全新浏览器上下文重新登录都从服务端加载正确会话，且不出现同步错误提示）；
- [x] 损坏、过大和旧版本数据可以安全迁移或降级（`storage.test.ts`/`session-storage.test.ts` 的 schema 校验、超限裁剪与旧版本迁移，Phase 0 检查项记录）。

### 聊天、附件和 Artifact

- [x] 文本请求行为与现有 Playground 保持兼容（纯文本提交路径与请求体形状不变，`playground-input-attachments` 与既有聊天/同步测试覆盖）；
- [x] 编辑和重新生成不会丢失历史版本或分支（消息新增 `activeVersionIndex` 字段与多版本 `versions` 历史：`appendMessageVersion` 追加版本并选中、`updateCurrentVersionContent` 只改活动版本、`setActiveMessageVersion` 忽略越界索引、`getCurrentVersion` 对缺失/越界索引回退首个版本以兼容旧数据；编辑与重新生成经 `applyMessageEdit`/`createRegeneratedMessages` 追加助手回复版本，并保持生成回复为最后一条以复用既有流式链路；`PlaygroundChat` 复用 ai-elements `Branch`/`BranchMessages`/`BranchSelector` 渲染可切换分支，生成中禁用切换；服务端 `playgroundMessagePayload` 持久化 `activeVersionIndex`，事务内复用 `PlaygroundMessageMaxVersions` 与 `PlaygroundMessageMaxCount` 校验越界索引、版本上限和消息数上限，超限回滚保留既有快照；`message-branching.test.ts`、`playground-chat-branches.test.tsx` 与 `model/playground_test.go` 的 `TestPlaygroundMessageVersionBranches`（SQLite/MySQL/PostgreSQL 矩阵）覆盖版本保留、活动索引回退与越界、上限回滚及跨用户 404；本地未运行测试（CI-only））；
- [x] 附件类型、大小、数量、权限和生命周期均由服务端控制（媒体类型白名单与签名校验、单文件/每用户预算、所有者与会话过滤、孤儿 TTL 清理均为服务端行为）；
- [x] Markdown 和 Code Artifact 可以创建、编辑、保存版本、恢复、复制、下载和删除（后端矩阵覆盖创建/保存/恢复/删除；复制与下载由 `playground-artifact-panel.test.tsx` 的 "copying an artifact puts its full content on the clipboard"、"downloading an artifact writes a sanitized filename and plain-text body"、"downloading a plaintext code artifact maps its extension to txt" 覆盖：剪贴板写入完整正文、下载文件名按标题清洗非法字符并追加扩展名、下载正文与 `text/plain;charset=utf-8` 类型一致；同时修复 Code Artifact 无语言或 `plaintext` 时下载扩展名为 `.txt`，对齐 `CodeBlock`；本地未运行测试（CI-only））；
- [x] Artifact 不会执行原始 HTML、JavaScript 或代码（`playground-artifact-panel.test.tsx` 专项安全用例：Markdown 预览中的 `<script>`、`onerror`/`onclick` 内联事件处理器和 `javascript:` 链接均由现有 `marked` + DOMPurify 链路清除，渲染后无 `script`/`iframe`/事件属性且哨兵变量未被置位；Code Artifact 的 `<script>` 与处理器标记只作为 CodeMirror 文本原样呈现，不生成活动节点；本地未运行测试（CI-only））；
- [x] 网络失败、冲突和响应丢失时草稿不会被静默覆盖（`server-sync.test.tsx` 冲突保留草稿与重试、取消写入重试；附件上传失败时输入保留文本与附件供重发）。

### 画布和资源限制

- [x] 画布支持节点、边、缩放、平移、撤销/重做、导入/导出（前端 `features/canvas` 画布编辑器：`Canvas` 缩放/平移/框选、`MiniMap`、工具栏增删节点、撤销/重做（工具栏按钮 + Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl/Cmd+Y，可编辑元素内不拦截）、版本化 JSON 导入/导出（超限/损坏文件给可翻译错误、不截断）；`use-canvas-editor.test.ts`、`canvas-document.test.ts` 与 `canvas-project-list.test.tsx` 覆盖；本地未运行测试（CI-only））；
- [x] 聊天消息、附件和 Artifact 可以安全引用画布节点（服务端在创建与更新画布时校验节点 `data.ref`：被引用的 session/message/attachment/artifact 必须属于同一账号且仍然存在，跨账号或缺失返回 400 `PLAYGROUND_CANVAS_REFERENCE_INVALID`（`model.ValidatePlaygroundCanvasReferences`），创建与更新两条路径均校验；前端只保存 ID 引用、不落 `blob:`/任意 URL，附件经受控内容接口按 owner 读取；`model/playground_canvas_test.go` 以归属矩阵覆盖四类引用、跨账号与前缀错误，`canvas-send.test.ts` 覆盖载荷只含 ID；本地未运行测试（CI-only））；
- [x] 达到用户或用户组配额时，服务端返回稳定、可翻译的错误（新增独立资源配额策略 `setting/playground_setting`：`PlaygroundQuotaPolicy` 全局默认等于既有服务端硬上限，`GroupOverrides` 按用户组逐字段覆盖，`GetPlaygroundQuotaPolicy(group)` 从内建默认→全局→用户组依次回退，零/负值不放开限制；会话数、消息数与快照字节、附件（单文件字节、每用户字节、每用户文件数）、Artifact（会话数量、记录数、版本、正文、单 Artifact 与会话容量）、画布（项目数、文档字节、节点、边、节点数据字节）均由策略解析，跨行容量在写入事务内 `lockForUpdate` 后重算；超限返回稳定错误码 `PLAYGROUND_SESSION_LIMIT_EXCEEDED`、`PLAYGROUND_MESSAGE_LIMIT_EXCEEDED`（附件/Artifact/画布沿用既有码）并登记七语言文案；`model/playground_test.go` 的 `TestPlaygroundQuotaPolicyResolutionAndSessionLimit`、`TestPlaygroundMessageQuotaLimit`、`TestPlaygroundAttachmentCountLimit` 与既有容量用例覆盖；任务并发字段已纳入策略，并在 P6-01 任务运行时接入后于控制层强制（新增 `PLAYGROUND_TASK_LIMIT_EXCEEDED` 与 `TestPlaygroundTaskConcurrencyCount`）；本地未运行测试（CI-only））；
- [x] 删除、恢复、过期和并发写入不会绕过资源配额（删除按剩余行重算账号预算，创建/更新在事务内 `lockForUpdate` + revision CAS，超限回滚；画布暂无恢复/过期语义，`model/playground_canvas_test.go` 覆盖并发与超限）；
- [x] 配额检查不会影响现有 token billing 的结算语义（画布配额为独立硬上限，未改动 `service/`、`relay/` 与计费表达式路径）。

### 真实环境验证

- [x] Playground 相关 Vitest 通过（49/49，11 个文件）；
- [x] `bun run typecheck` 通过（本环境使用 `web/node_modules/.bin/tsgo -b`）；
- [x] 修改文件的 lint 和格式检查通过（oxlint + protected-header 格式检查）；
- [x] 前端生产构建通过（`rsbuild build`）；
- [x] 后端相关测试通过（`go test ./model/ -run TestPlayground`）；
- [x] SQLite、MySQL、PostgreSQL 新库和升级库迁移均通过（SQLite 3.50.4 / MySQL 8.0.46 / PostgreSQL 16.15，新库 ×2 + v1.0.0-rc.43 升级库 ×2；MySQL 5.7.44 最低版本验证通过）；
- [x] 真实浏览器覆盖桌面、移动端、暗色模式、键盘操作和失败路径（Playwright + Chromium 7 个用例：桌面/移动工作区、会话 Sheet 键盘操作与 Escape、暗色持久化、失败列表重试恢复、刷新/重登录同步；冷启动与复用实例两种运行方式均通过）；
- [x] 真实浏览器覆盖附件与多模态链路（Playwright：选择图片→服务端上传→SSE 回复→请求体含 `image_url` data URL→刷新后消息与附件从服务端恢复并经内容接口加载）；
- [x] 最终 diff 不包含无关生成文件、密钥、直接上游调用或许可证遗漏（`.claude-flow/`、`.swarm/`、`graphify-out/` 已加入 `.gitignore`；新增 Go/TS 文件无密钥、无直连上游调用、许可证头齐全，提交前复查）；
- [x] 推送 main 与 PR 均触发 CI（`.github/workflows/ci.yml` 增加 `push: branches: [main]`，backend/frontend 两个 job 的 `if` 允许 push，checkout 以 `github.repository`/`github.sha` 兼容 push，concurrency 按 ref+sha 分组避免 main 连续推送互相取消）；本 Step 仅改 CI 配置，本地未运行测试（CI-only）。

## 7. 当前待办优先级

### P0：继续前必须完成

1. ~~完成服务端 session/message 同步契约和冲突策略；~~ 已完成（同步层含迟到请求屏蔽与冲突恢复测试）；
2. ~~对当前新增的 Playground 后端模型和迁移执行三数据库验证；~~ 已完成（新库 ×2 + rc.43 升级库 ×2，三库全部通过，含 MySQL 5.7 最低版本）；
3. ~~完成 Artifact 的前端失败恢复、冲突和未保存草稿保护；~~ 已完成（失败重试复用 request_id、409 冲突保留草稿并可 reload、`beforeunload` 草稿保护）；
4. ~~清理或明确 `.claude-flow/`、`.swarm/`、`graphify-out/` 等生成目录是否进入提交范围；~~ 已完成（已加入 `.gitignore`）；
5. ~~补齐端到端的账号隔离、迟到请求和删除回退测试。~~ 已完成（`model/playground_test.go` 跨用户/并发/真实 router 鉴权 + 前端同步层测试）。

剩余待办：Inspector/Canvas 面板边界、Phase 5 Infinite Canvas 剩余项（画布与 session 引用生命周期收尾）、Phase 6 其余项（Agent/工具调用状态、工作流节点与失败重试/任务取消）与 Phase 6 素材库（P6-04：素材库视图，以及素材库、任务结果、附件、Artifact 与画布的安全关联；任务结果/Artifact 到画布的引用关联已由 P6-01/P6-03 完成）均已由 UX-02、P5-04、P6-02、P6-03、P6-04 完成。

### P1：聊天工作区稳定后实施

1. ~~附件对象存储和多模态 payload；~~ 已完成（服务端附件表、受控内容接口、消息引用与多模态 payload 全链路，含 E2E 验收）；
2. ~~独立的用户/用户组资源配额~~ 已完成（新增 `setting/playground_setting` 独立策略：全局默认等于既有服务端硬上限，支持按用户组覆盖，覆盖会话数/消息数/附件单文件·每用户字节·文件数/Artifact 数量·版本·正文·容量/画布项目·节点·边·文档字节；`GetPlaygroundQuotaPolicy(group)` 在模型写入事务内解析并原子校验，超限返回稳定错误码与七语言文案；任务并发字段 `TaskMaxConcurrency` 已定义，Phase 6 任务运行时接入后生效；`model/playground_test.go` 新增 `TestPlaygroundQuotaPolicyResolutionAndSessionLimit`、`TestPlaygroundMessageQuotaLimit`、`TestPlaygroundAttachmentCountLimit`；本地未运行测试（CI-only））；
3. ~~Artifact 和附件与 session 的统一资源生命周期~~ 已完成（会话删除级联与附件孤儿 TTL 清理已实现；新增统一资源配额视图：后端只读 `GET /api/playground/usage` 按 owner 返回会话/附件/Artifact/画布的数量与字节 used/limit，`model/playground_usage.go` 的 `PlaygroundUsageForUser` 复用 `GetPlaygroundQuotaPolicy` 策略；管理端在「安全与限制」新增「Playground 资源配额」分组，支持全局默认 + 按用户组覆盖（`playground-quota-section.tsx`/`quota-fields.ts`，读写 `playground_setting.defaults`/`playground_setting.group_overrides`）；用户端工作区新增资源用量弹层（`playground-usage-popover.tsx`）；新增 `TestPlaygroundUsageForUserReportsOwnerTotals`、`TestPlaygroundArtifactAccountLimit` 与前端 `playground-quota-section.test.tsx`、`playground-usage-popover.test.tsx`；本地未运行测试（CI-only））；
4. ~~桌面/移动端 Inspector、Artifact 和 Canvas 面板。~~ 已完成（Playground 与画布编辑器共用 `components/workspace-inspector.tsx`：桌面 `ResizablePanelGroup` 并排、移动端右侧 Sheet，Playground 头部按钮在「Artifacts」与「Canvases」两个视图间切换同一 Inspector，画布节点详情复用该外壳并保留 Base UI 焦点陷阱与未保存草稿保护；`workspace-layout.test.tsx` 覆盖桌面并排/隐藏与视图切换、移动 Sheet 关闭、会话列表入口；本地未运行测试（CI-only））。

### P2：产品能力扩展

1. Infinite Canvas（桌面/移动画布编辑器已完成，见 Phase 5 剩余项）；
2. 图片、视频、音频任务；
3. Agent 和工作流；
4. 跨设备、分享和协作。

## 9. 第二阶段追加计划：存储、计费与参考项目功能补齐（2026-10-17 调研）

> 来源：2026-10-17 对 `newapi-rev` main @ `4870c3057`、`lobehub/lobehub` @ `78979e4d`（LobeHub Community License，只参考交互与数据边界，不复制代码）、`basketikun/infinite-canvas` @ `3a6b64b`（MIT）的源码调研。本节所列 27 个 Step 已经用户确认，全部排在当前 Phase 6（P6-02/P6-04/P6-05，画布相关 Step 另依赖 P6-03）之后执行；各 Step 仍遵守第 2 节边界与第 5 节要求，下文“已批准例外”除外。

### 9.1 参考项目调研结论

- 第 1 节的“类 LobeHub 聊天工作区”“Infinite Canvas 风格画布”在本计划中只有工程约束，没有展开产品功能。对照源码，以下刚需功能计划和代码都没有：系统提示词与助手预设（LobeHub `agents` 表）、上下文窗口管理与摘要压缩（LobeHub `message_groups.type='compression'`；本仓库 `payload-builder.ts` 每次发送全部历史，直接影响用户 token 花费）、每条消息用量与费用展示（LobeHub `messages.usage`；本仓库只显示耗时）、画布内直接生成并记录参数一键重试（infinite-canvas 核心玩法）、画布基础编辑（复制粘贴、Ctrl+G 分组、拖拽上传、视频/音频节点）、多模型并行对比（LobeHub `message_groups.type='parallel'`，与多模型网关定位契合）。
- 数据存储两个硬伤：附件以 base64 存在 `playground_attachments.Data LongText`（膨胀约 33%）；`ReplacePlaygroundMessages` 每次保存整会话删除重插（写放大与会话长度成正比）。另有 3 处写路径 `SELECT ... FOR UPDATE` 锁 `users` 行，与 relay 扣费争抢。
- `service/task_artifact_store.go` 已有 `TaskArtifactStore` 接口与 `TASK_ARTIFACT_STORE_MODE=s3` 配置骨架，但固定返回 disabled 实现，生成结果依赖会过期的上游 URL。

### 9.2 数据与多媒体存储决策

1. **字节与元数据分离**：新增可插拔 `ObjectStore`（`service/objectstore/`：Put/Get/Head/Delete/PresignPut/PresignGet/Backend），后端 `local`（默认，自托管零依赖）、`s3`（任何 S3 兼容端点：AWS S3、Cloudflare R2、MinIO、Backblaze B2、阿里云 OSS 兼容端点）、`db`（只读兼容旧附件）。附件、任务生成结果、大 Artifact 版本与画布快照都进 ObjectStore；数据库只存 backend/object_key/byte_size/content_hash/media_type 与归属。Key 布局 `pg/{user_id}/{kind}/{yyyy}/{mm}/{id}`，去重仅限同一用户内。
2. **下载**仍由 new-api 做归属校验：s3 返回 5–15 分钟预签名 GET 的 302，local 流式输出；消息和画布节点只存 ID，不存预签名 URL。大文件走预签名直传（事务内预占配额 → 直传 → complete 时 HEAD 校验大小 + magic bytes 嗅探）。
3. **云端推荐 R2**（出流量免费，$0.015/GB-月）；不推荐“Workers 代理 AWS S3”（S3 → Cloudflare 仍按 S3 出流量 $0.09/GB 计费）。R2 预签名 URL 不能用自定义域名/CDN，只有需要“鉴权 + 边缘缓存”时才在 R2 前加 Worker 校验 HMAC 令牌。中国大陆用户可选 OSS/COS + CDN。
4. **消息增量写**：保留会话 `MessageRevision` CAS，按 `(session_id, client_key)` upsert 变化行；同步协议发送增量，旧全量接口保留一个版本兼容。
5. **配额计数器**：新表 `playground_user_usage`，写事务锁该行，不再锁 `users`、不再 SUM，每日对账。
6. **拆库**仅在主库约 500 GB 以上或 Playground 写入明显影响扣费延迟时考虑，仿 `LOG_SQL_DSN` 增加可选 `PLAYGROUND_SQL_DSN`（DB-04 只出设计文档）。规模估算：1 万活跃用户时附件存 DB（base64）约 270 GB，而消息约 63 GB——最先压垮单库的是字节数据。

### 9.3 计费决策

- **生成类不另造计费**：聊天、摘要、多模型对比、图片/视频/音频生成与工作流节点调用全部走现有 Relay 预扣 + 结算（模型价格、表达式计费、`image_count`、task `u("seconds")`、groupRatio）。工作流编排本身免费，运行前估价、可设单次预算上限，取消时已完成节点照常计费、未开始的不扣。
- **存储第一档（默认）权益制**：用户组资源配额（Q-01/Q-02）+ 订阅套餐 `UpgradeGroup`/`DowngradeGroup` 售卖更大空间；超额拒绝新写入，旧数据可读。
- **存储第二档（可选开关）计量制**：每日按峰值字节计 GB-day，`common.QuotaFromDecimalChecked` 换算后从 `User.Quota` 扣费并写消费日志（ledger `(user_id,date)` 唯一、幂等）；余额不足进入只读宽限，**绝不静默删除用户数据**。资源配额仍独立于 `User.Quota`（第 2.4 节），只有管理员开启计量时才把存储占用换算成钱。
- **出流量**：R2/本地不计费只限速；S3/OSS 由管理员选择是否按 GB 计费。

### 9.4 已批准的例外（用户 2026-10-17 确认）

1. **ST-02** 允许新增 Go 依赖 `github.com/aws/aws-sdk-go-v2/service/s3` 及必需的 aws-sdk-go-v2 核心模块，允许修改 go.mod/go.sum（仅限该 Step）。
2. **SEC-02** 允许放宽第 5 节“不执行 Artifact HTML/JS”，但只能在严格沙箱内：独立 origin + `sandbox` iframe（绝不含 `allow-same-origin`）+ 严格 CSP + postMessage 白名单，默认关闭、管理员开关；主站页面仍绝不执行 Artifact 内容。
3. **BL-02** 涉及计费：必须先读 `.agents/rules/billing.md`；“真实数据库验证”改为编写/扩展由 CI 在真实数据库上运行的测试（必要时新增带 MySQL/PostgreSQL services 的 CI job），不在本地测试。
4. **DB-01** 改变同步协议：旧端点作为兼容垫片保留一个版本，标注 deprecated。

### 9.5 新增 Step 与依赖

执行顺序：第一批 ST-01、DB-01、CH-01、BL-04 → 第二批 ST-02、ST-03、CH-02、CV-01、CV-02 → 第三批 DB-02、ST-05、BL-01 → 其余按依赖。所有 Step 均在 P6-02、P6-04、P6-05 之后；CV-* 在 P6-03 工作流节点基础上细化，不重复实现。

| ID | 标题 | 依赖 | 优先级 |
| --- | --- | --- | --- |
| ST-01 | ObjectStore 抽象 + 本地磁盘后端（默认） | P6-05, P6-02, P6-04 | 刚需 |
| DB-01 | 消息增量持久化（替代整会话删除重插） | P6-02, P6-04, P6-05 | 刚需 |
| CH-01 | 系统提示词与助手预设 | UX-01, P6-02, P6-04, P6-05 | 刚需 |
| BL-04 | 每消息/会话用量与费用展示 | S00, P6-02, P6-04, P6-05 | 刚需 |
| ST-02 | S3 兼容后端（AWS S3/R2/MinIO/B2/OSS）并实现 TaskArtifactStore | ST-01 | 刚需 |
| ST-03 | Playground 附件迁出数据库 | ST-01, P6-04 | 刚需 |
| CH-02 | 上下文管理与摘要压缩 | CH-01 | 刚需 |
| CV-01 | 画布基础编辑能力 | P6-03, P6-04, P6-05 | 刚需 |
| CV-02 | 画布内生成：配置节点 + 元数据重试 + @引用 | P6-03, P6-04, P6-05 | 刚需 |
| DB-02 | playground_user_usage 计数器与锁行 | ST-03 | 刚需 |
| ST-05 | 生成结果持久化到 ObjectStore | ST-02, P6-05 | 刚需 |
| BL-01 | 存储权益与订阅套餐挂钩 | ST-03 | 刚需 |
| DB-03 | 大 JSON 压缩/外置 + 画布快照历史 | ST-01, P6-03 | 推荐 |
| CH-03 | 多模型并行对比 | CH-01 | 推荐 |
| CH-04 | 会话导出 + 回收站 | DB-01 | 推荐 |
| CH-07 | 推理参数、草稿与输入历史、提示词片段 | CH-01 | 推荐 |
| CH-06 | 聊天内 TTS 朗读与 STT 听写 | P6-01, P6-02, P6-04, P6-05 | 推荐 |
| SEC-02 | HTML/SVG/Mermaid Artifact 沙箱预览（需先决策） | SEC-01, P6-02, P6-04, P6-05 | 可选 |
| ST-04 | 大文件预签名直传 + 扩展类型（视频/音频/PDF） | ST-02, ST-03 | 推荐 |
| BL-03 | 工作流运行预算 | P6-03, CV-02 | 推荐 |
| CV-03 | 图片工具：裁剪/遮罩重绘/本地放大 | CV-02, ST-03 | 推荐 |
| CV-04 | 画布助手侧栏 | CV-02, CH-01 | 推荐 |
| CV-05 | 含资源导出与快照恢复 | DB-03 | 推荐 |
| ST-06 | 删除 outbox 与对象存储对账 | ST-03, DB-02 | 推荐 |
| DB-04 | 设计文档：PLAYGROUND_SQL_DSN 独立库/分区/归档 | DB-02 | 可选 |
| BL-02 | 存储计量计费（可选开关） | DB-02, ST-05 | 推荐 |
| CH-05 | 文档附件文本抽取 | ST-04 | 推荐 |

每个 Step 的详细范围与完成标准见编排器 `steps.json`（与调研报告 `proposed-steps.json` 一致，并嵌入了 9.4 的例外）。完成后在本节表格对应行后注明进展，并在第 8 节变更记录追加一行。

**ST-01 进展（2026-10-18，CI-only，本地未运行测试）**：新增 `service/objectstore` 对象存储抽象：`Store` 接口（`Put`/`Get`/`Head`/`Delete`/`PresignPut`/`PresignGet`/`Backend`）、`ObjectInfo`、`ValidateKey`（拒绝空段、点段、反斜杠、绝对路径、控制字符与超长键）与 `Serve` 响应辅助（调用方完成归属校验后流式输出，附 `nosniff`、`sandbox; default-src 'none'` CSP、转义后的 `Content-Disposition` 与 `no-referrer`，防止文件名头注入）；`Local` 后端可用 `OBJECT_STORE_LOCAL_DIR` 配置目录，基于 `os.Root` 把全部操作限制在根目录内（含符号链接逃逸拒绝），父目录按需创建，临时文件 + rename 原子提交，32 KiB 缓冲流式读写并响应 context 取消，`PresignPut`/`PresignGet` 对 local 返回 `ErrPresignUnsupported`（预签名留给 S3 后端）。配置在 `setting/system_setting/task_artifact_store.go` 中扩展：新增 `ObjectStoreConfig`/`ValidateObjectStoreConfig`/`LoadObjectStoreConfig` 与 `OBJECT_STORE_BACKEND`（默认 `local`）、`OBJECT_STORE_LOCAL_DIR`（默认 `data/objectstore`）、`OBJECT_STORE_PREFIX`、`OBJECT_STORE_PRESIGN_TTL`（上限沿用 7 天），S3 prefix 校验提取为共享 helper，`TASK_ARTIFACT_STORE_*` 配置与既有错误文案、行为保持不变。测试：`service/objectstore/local_test.go`（读写/覆盖/删除往返、4 MiB 大对象流式、前缀映射、穿越键与符号链接逃逸拒绝、context 取消、预签名不支持、`Serve` 安全头与文件名注入防护、`New` 后端选择）与扩展的 `setting/system_setting/task_artifact_store_test.go`（`TestValidateObjectStoreConfig`、`TestLoadObjectStoreConfigDefaultsAndFallback`）；无新依赖；无前端/i18n 变更。

**DB-01 进展（2026-10-18，CI-only，本地未运行测试）**：消息写入改为增量持久化，替代整会话删除重插——`model.PlaygroundMessage` 新增 `uk_playground_message_session_client`（`session_id` + `client_key`）唯一索引；`model.ApplyPlaygroundMessagesDelta` 在锁定会话行并校验 `MessageRevision` CAS 之后只写变化行：已存行保持主键与稀疏 `position`（步长 1024）不变，新增行按请求顺序追加到当前最大 position 之后，`deletes` 删除被删行（删除不存在的键为幂等空操作），事务末尾按最终快照重算附件引用；`MessageRevision` 仅在快照真正变化时 +1，未变化的请求既不重写任何行也不推进版本（同一 revision 的并发写入仍恰好一个成功，另一个返回 `ErrPlaygroundConflict`）。新增 `PATCH /api/playground/sessions/:id/messages`（`upserts` + `deletes` + `revision`，`UserAuth` + `access_token_routes` 会话级规则），返回 `{revision, upserted, deleted}`；旧的全量 `PUT /api/playground/sessions/:id/messages` 作为**兼容垫片保留一个版本**（`controller.ReplacePlaygroundMessages` 标注 Deprecated，内部转换为同一增量引擎：请求序列与已存序列一致时不重排 position，序列变化时才重新编号），**计划在下一个版本移除**，届时只剩增量协议；前端改用增量协议（`applyPlaygroundMessagesDelta` + `lib/server-sync.ts` 的 `playgroundSyncedSnapshot`/`playgroundMessageDelta` 以「上次确认写入的序列化消息」为基线，只发变化/新增消息与被删键，空增量直接跳过消息写入；`replacePlaygroundMessages` 保留并标注 `@deprecated`，仅服务旧客户端），`use-playground-server` 按账号持有同步基线并在水合、创建、保存、删除时维护。迁移：`model.migratePlaygroundMessageUniqueness` 在 AutoMigrate 之前清理旧库中重复的 `(session_id, client_key)` 行（保留最新一行，索引已存在时跳过检查），保证 SQLite/MySQL/PostgreSQL 升级可创建唯一索引且重复启动幂等。测试：`TestPlaygroundMessageDeltaWrites`（SQLite/MySQL/PostgreSQL：兼容端点仍可用并写入稀疏 position、未变化行不被重写（时间戳不变）、新增行追加、删除行、空增量不改版本、陈旧 revision 409、跨用户 404、非法增量 400、唯一索引存在且拒绝重复行、AutoMigrate 重复执行幂等）、`TestPlaygroundMessageDeltaConcurrentRevision`（三库并发 CAS）、`TestPlaygroundMessageDeltaLimitRollback`（超上限 422 `PLAYGROUND_MESSAGE_LIMIT_EXCEEDED` 并回滚保留旧快照，替换一条后成功）、`TestPlaygroundMessageUniquenessMigration`（三库：去重后建索引并再次拒绝重复）；前端 `server-sync-delta.test.ts`、扩展 `server-api.test.ts`（增量 PATCH 与旧 PUT 兼容契约）与 `server-sync.test.tsx`（只发变化消息与删除键、无消息变化时跳过消息写入）；`.github/workflows/ci.yml` 的 real-database job 纳入上述矩阵测试；E2E 等待条件改为增量 PATCH；无新依赖；无新增 i18n 文案；本地未运行测试（CI-only）。

## 10. 上游同步策略与上游借鉴 Step（2026-10-17）

> 来源：对上游 QuantumNous/new-api（本仓库的 fork 源）近 12 个月 issue / PR 与 fork 缺失提交的调研。fork 当时落后上游 54 个提交（merge base `42e694eb6`）；在临时克隆中试合并，冲突集中在 `.github/workflows/ci.yml`、7 个语言包、`web/src/i18n/static-keys.ts`，主要是两边都在追加 i18n key（随后 main 新增的 Playground 改动另带来 `playground/types.ts`、`message-streaming-utils.ts` 两处代码冲突）。

### 10.1 同步策略

1. **merge，不 rebase**：用 `git merge upstream/main` 把上游并入本仓库 main，保留 fork 历史；merge commit 以仓库维护者身份提交，正文列出同步的上游提交与行为变化，然后 fast-forward 推送 main。
2. **独占执行**：同步期间不并行任何 roadmap Step（每个 Step 都会改 i18n 文件，并行会反复冲突），编排器先等所有槽位空闲；CI 修复通道暂停，期间不推送。
3. **冲突处理约定**：语言包按 key 三方合并取并集（两边都改同一 key 时保留 fork 值）；`ci.yml` 冲突段保留 fork 的 push 触发与 checkout 写法，吸收上游的其余改动；`static-keys.ts` 两边新增的 key 都保留；其余代码冲突语义合并，同时保留 fork 功能与上游修复；本地不运行测试，交给 CI。
4. **频率**：首次同步（UP-00）在 P6-02/P6-03/P6-04/P6-05 完成后执行；之后**每 7 天**检查一次，上游有新提交就排一次独占同步（编排器 `KO_UPSTREAM_SYNC_DAYS`，0 为关闭）。
5. **行为变化须记录**：首次同步包含上游 `4013729f6`（#7814）“敏感词过滤默认关闭并清空默认词表”，已接受，在第 8 节变更记录中注明。
6. **借鉴上游未合并 PR**：只借鉴思路由本仓库自行实现，不 cherry-pick 代码；提交信息注明 `Inspired-by: QuantumNous/new-api#<编号>`。两边均为 AGPL-3.0。
7. **计费策略**：流式请求被客户端中断且零输出时，prompt 照常收费（保持现有 client_gone 结算），UP-01 不改变该策略。涉及计费/额度/订阅的 UP-01、UP-03、UP-05、UP-06、UP-07、UP-08 须先读 `.agents/rules/billing.md`，并沿用 9.4 节规则，用 CI 在真实数据库上测试。

### 10.2 上游借鉴 Step

所有 UP Step 以及第 9 节的 27 个 Step 都依赖 UP-00，在同步后的代码上实施。优先顺序：UP-01（断开即取消上游）、UP-09（`/mj/image/:id` 访问控制）、UP-08（管理员改额度竞态）与第 9 节第一批并列最先执行。

| ID | 标题 | 依赖 | 优先级 |
| --- | --- | --- | --- |
| UP-00 | 同步上游 main（54 个提交，merge base 42e694eb6 @ 2026-10-11） | P6-02, P6-03, P6-04, P6-05 | 必做 |
| UP-01 | 客户端断开时取消上游请求并停止重试 | UP-00 | 必做 |
| UP-02 | 流式首字（TTFB）超时 + 自动切换渠道 | UP-01, UP-00 | 推荐 |
| UP-03 | 渠道/令牌级 RPM、TPM 与并发准入限制 | UP-00 | 推荐 |
| UP-04 | /v1/messages/count_tokens 本地估算 | UP-00 | 推荐 |
| UP-05 | 兑换码兑换订阅套餐 | UP-00 | 推荐 |
| UP-06 | 订阅套餐的分组/模型限制与多窗口额度 | UP-05, UP-00 | 推荐 |
| UP-07 | 令牌周期额度（日/周/月自动重置） | UP-00 | 可选 |
| UP-08 | 管理员修改用户/令牌额度改为增量更新 | UP-00 | 推荐 |
| UP-09 | /mj/image/:id 访问控制 | UP-00 | 推荐 |
| UP-10 | 日志记录请求阶段耗时拆分 | UP-00 | 推荐 |
| UP-11 | Playground 切换模型时清理不兼容的历史内容 | UP-00, CH-02 | 推荐 |
| UP-12 | /v1/images/generations 异步任务模式（提交 + 查询） | UP-00, P6-01 | 推荐 |
| UP-13 | 稳定分组标识（改名不使令牌失效） | UP-00 | 可选 |
| UP-14 | Responses → ChatCompletions 协议降级 | UP-00 | 可选 |

Step 进度：

- [x] UP-01：客户端断开时取消上游请求并停止重试 —— `relay/channel/api_request.go` 的 `DoApiRequest`/`DoFormRequest` 改用 `http.NewRequestWithContext(c.Request.Context(), ...)`，客户端断开即取消上游请求，不再让上游继续生成；任务类提交沿用既有 `newTaskAPIRequest` 的上下文绑定与 `executeTaskSubmission`「提交前取消即退款、已持久化任务不回滚」守卫，语义不变；`service/relay_error.go` 的 `DecideRelayRetry` 在客户端请求上下文已取消时返回 `{stop, client_gone, client}`，覆盖常规重试与渠道错误重试；计费策略不变（零输出中断流照常收 prompt 费用，未改计费路径）；管理端请求策略展示补 `client_gone`/`client` 标签与七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；新增 `TestDoRequestCancelsUpstreamWhenClientDisconnects`（两个请求构造器表格）与 `TestDecideRelayRetryReasons` 断开用例；本地未运行测试（CI-only）。
- [x] UP-09：`/mj/image/:id` 访问控制 —— 路由改经新 `middleware.MjImageAccessControl`（`router/relay-router.go`，仍注册在 `TokenAuth` 之前，因为图片由浏览器与 MjProxy 客户端作为普通图片源加载、不带 `Authorization`）：默认 `auth` 模式要求仪表盘会话或 API 令牌，并由 `relay.RelayMidjourneyImage` 校验任务归属（管理员保留看板级视图；任务不存在与归属不符一律返回同一 404，避免枚举）；`setting.MjImageAccessMode` 新增 `auth`/`signed`/`legacy` 三种模式，`model.UpdateOption` 对未知值归一化回 `auth` 并修正 OptionMap（fail-closed），管理端「绘图」设置新增「图片链接访问方式」选择器（七语言文案）；`signed` 模式由 `service.SignMjImageLink`/`VerifyMjImageSignature`（HMAC-SHA256 over `v1\0taskID\0exp`，30 分钟 TTL，常量时间比较）签名 `/mj/image/:id?sig=&exp=` 短链，签名无效或过期时回退到认证规则，`service.BuildMjImageForwardURL` 统一生成前向链接（`controller/midjourney.go` 与 `relay/mjproxy_handler.go` 复用，状态非 SUCCESS 的 rand 参数改用 `&` 拼接）；`usage-logs` 图片预览对话框对同源 `/mj/image/` 链接改经 axios 客户端带凭据取 blob 再以 object URL 展示（失败显示错误而非破图），其他图片 URL 保持直连；`router/relay_router_test.go` 新增 `TestMidjourneyImageAccessControl`（匿名 401、所有者/管理员 200 取图、他人与未知任务同 404、签名绑定单任务/过期/篡改/模式回退、legacy 开放）与 `TestMjImageAccessModeOptionRoundTrip`（选项读写与非法值归一化），前端新增 `image-dialog.test.tsx`（受保护链接经认证客户端加载、普通 URL 直连、失败态）；补 7 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试（CI-only）。 2026-10-18 复核：首次实现漏传 `section-registry.tsx` 的 `MjImageAccessMode`（`DrawingFormValues` 必填字段缺失，typecheck 失败且管理端选择器无法保存），且 `image-dialog.test.tsx` 从 `../image-dialog` 导入组件导致 vitest 无法解析模块；两处已修复，`i18n:sync` 复跑 missingCount=0、extrasCount=0，其余范围静态核对无缺口；本地未运行测试（CI-only）。

- [x] UP-08（令牌侧）：`PUT /api/token` 改为差额原子更新并写管理日志 —— 用户侧额度 fork 已修（`AdjustUserQuota` 锁行 + 差额同步 + 审计），本 Step 只做令牌侧：旧 `model.Token.Update` 把请求开始时读到的 `remain_quota` 快照绝对写回（`status_only` 也会顺带覆盖并发扣费），现改为 `model.Token.UpdateWithQuotaTarget(quotaSnapshot)`——事务内 `lockForUpdate` 锁定令牌行（`id AND user_id`）、用共用的 `tokenConfigFields` 写元数据，再按 `remain_quota = remain_quota + (请求目标 - 快照)` 原子应用差额并返回提交后的 `TokenQuotaChange`（Before/After），快照之后落库的并发扣费只保留其差额而不再被旧快照擦除；`Token.Update` 的 Select 移除 `remain_quota`，`status_only` 不再触碰余额；`UpdateToken` 把已提交的 `from`/`to` 前后余额写进既有 `token.update` 审计参数（`changed_fields` 仍按请求意图判断；前端审计详情已能用既有 `Previous value`/`New value`/`Remaining quota` 文案渲染，无新增文案键）；新增模型矩阵测试 `TestTokenQuotaUpdatePreservesConcurrentDeductions`（SQLite/MySQL/PostgreSQL：快照后扣费 30，目标不变/上调/下调分别得 70/170/10 且 `used_quota` 保留、`change.Before/After` 为已提交值）与控制器回归 `TestUpdateTokenQuotaAdjustmentPreservesConcurrentDeductions`（GORM 查询回调在快照与写入之间注入扣费，校验响应余额、落库余额、`used_quota`、审计参数与状态 from/to），审计矩阵 `normalized update` 期望补 `from:100,to:200`；`.github/workflows/ci.yml` 复用既有真实数据库 job 的过滤清单加入新矩阵测试；本地未运行测试（CI-only）。

## 11. 钱包（2026-10-17 调研与决策）

> 来源：对 newapi-rev 钱包、计费与支付代码的只读调研（main @ `2cbfb4f`），对照 OpenRouter、LobeHub Cloud、one-api 的做法。用户已批准下列 8 项推荐方案。所有钱包 Step 都要先读 `.agents/rules/billing.md`，沿用 9.4 节规则：在 CI 的真实数据库（MySQL、PostgreSQL、SQLite）上测试，本地不跑测试。所有钱包 Step 都排在 UP-00 之后，正确性修复优先。

### 11.1 现状中的主要问题

- **没有账本**：余额是可变整数，变动只在 `logs` 留痕（可能在独立库或 ClickHouse，会被清理，写入失败不回滚），无法从流水重算余额或对账。
- **钱包预扣不持久**：预扣直接扣余额，状态只在内存；进程在结算/退款前崩溃会丢钱；退款是异步 goroutine 且不幂等。关机时也不 flush `BATCH_UPDATE_ENABLED` 的内存队列（上游 #7657）。
- **可无限透支**：信任旁路不预扣，结算补扣不检查余额（上游 #6609）。
- **订阅 bug**：退款改金额与改状态不在同一事务、可能重复退款（#5556，WL-03 已修复）；结算超出订阅剩余额度时只扣了预扣部分，`AllowWalletOverflow` 只在预扣阶段生效（#6911，WL-03 已修复：超额部分转扣钱包）。
- **quota 列类型**：struct tag 是 32 位 `int`，启动检查却要求 64 位且跑在 AutoMigrate 之前（上游未合并 PR #5136）。
- 另有：令牌额度绝对值写入覆盖并发扣费、支付侧无退款/拒付/发票且 `Money` 为 float64、币种口径混乱（#3206）、额度无来源与有效期、4 位 `aff_code` 碰撞（#6215）。

### 11.2 已批准的决策

1. **账本（Q1=B）**：新建 append-only `wallet_ledger`，放在**主库**，和余额变更在同一事务内写入；资金类事件（充值、兑换、调整、退款、订阅余额支付、签到、邀请转入、存储日结、拒付冲正）每笔一行，API 消费按用户每小时聚合一行（明细仍查 logs）。每日对账 `Σledger = 当前余额`，偏差告警，不自动改余额。
2. **计量单位（Q2=A）**：继续用整数 quota（1 USD = 500000），把列真正迁到 64 位并修启动检查顺序（参考 #5136，CI 真库验证）；支付金额改为精确十进制并带币种。
3. **额度分桶（Q3=B，账本之后）**：`credit_grants` 存放赠送、签到、邀请、兑换、促销额度，可设有效期；扣费顺序：订阅 → 赠送额度（先到期先用）→ 充值余额；充值余额永不过期。
4. **持久化预扣（Q4=B）**：`wallet_holds` 记录每笔钱包预扣，结算/退款时关闭且幂等，超时未关闭自动退款（修崩溃丢钱）；关机时 flush 批量队列（#7657）；BL-03 工作流预算挂在父 hold 上。可用余额仍等于 quota，不做真冻结。
5. **透支（Q5=B）**：按用户组配置透支上限，默认 0；信任旁路收紧；超限部分记欠款，用户只读直到充值（修 #6609）。同时修订阅退款事务（#5556）与超额转扣钱包（#6911）。
6. **存储费用（Q6=A）**：存储日结从同一钱包扣，写入统一账本；`playground_storage_ledger` 只保留日明细，不做第二本账。
7. **团队（Q7=C）**：现阶段用“一个账号 + 多令牌 + 令牌周期额度（UP-07）”做成员预算；账本和额度分桶落地后再做组织钱包。
8. **退款、拒付与支付渠道（Q8=B）**：处理各支付商退款/拒付 webhook，订单标 refunded/disputed，在账本冲正（最多扣到 0，余下记欠款），支持管理员退回未用余额；可选开启 Stripe 自动开发票（#3204）；可选支付宝/微信支付官方直连适配器（统一 `PaymentProvider` 接口）；订阅按套餐原币收款，不做汇率换算（#3206）。

另外：UP-08 缩小为令牌侧额度的增量更新（用户侧 fork 已修）；`aff_code` 加长并碰撞重试（#6215）。

### 11.3 与已有 Step 的协调

- UP-05：兑换写入账本；兑换额度在 WL-07 后进入 grant 桶。依赖 WL-05。
- UP-06：订阅扣费复用 WL-03、WL-07 的实现。依赖 WL-03。
- UP-07：令牌周期额度即“成员预算”，不写钱包账本。
- UP-03：限流可降低并发透支，透支控制归 WL-06。
- BL-02：存储日结写统一账本，只读宽限与 WL-06 欠款规则统一。依赖 WL-05、WL-06。
- BL-03：工作流预算挂在 WL-04 的父 hold 上。依赖 WL-04。
- DB-02：只是非货币资源计数器，不涉及钱包。

### 11.4 钱包 Step

执行优先级：UP-00 之后先做 UP-01，以及 WL-05（账本）、WL-01（64 位 quota）、WL-02（关机 flush），随后 UP-09、UP-08、WL-03（订阅 bug）、WL-04（持久化预扣）、WL-06（透支上限），再进入第 9 节第一批；WL-07、WL-08、WL-09 排在中后段。

| ID | 标题 | 依赖 | 优先级 |
| --- | --- | --- | --- |
| WL-05 | wallet_ledger 追加式钱包账本 + 每日对账 | UP-00 | 刚需 |
| WL-01 | quota 列迁移到真正的 64 位 + 启动检查顺序修复 | UP-00 | 刚需 |
| WL-02 | 关机时清空批量额度队列与在途退款 | UP-00 | 刚需 |
| WL-03 | 订阅退款改为单一事务 + 结算超额转扣钱包 | UP-00, WL-05 | 刚需 |
| WL-04 | wallet_holds 持久化钱包预扣 + 超时回收 + 幂等退款 | WL-05 | 刚需 |
| WL-06 | 按用户组透支上限 + 信任旁路收紧 + 欠款只读 | WL-04 | 刚需 |
| WL-07 | credit_grants 额度来源与有效期（分桶） | WL-04, WL-03 | 推荐 |
| WL-08 | 支付退款/拒付 webhook、订单状态扩展、金额精确十进制与支付渠道 | WL-06 | 推荐 |
| WL-09 | aff_code 加长 + 碰撞重试（可选按充值比例返利） | UP-00 | 推荐 |

**WL-05 进展（2026-10-17，已完成）**：主库 append-only `wallet_ledger` 与余额变更同事务入账——资金类事件（充值、兑换、管理员调整、退款、订阅余额支付、签到、邀请转入、系统赠送）逐笔一行，API 消费按用户每小时聚合一行（`BATCH_UPDATE_ENABLED` 走内存队列，flush 失败重新入队），启动时为无流水用户回填期初余额；`ApplyWalletLedgerDelta` 先锁用户行、以 `(ref_type, ref_id)` 唯一索引幂等去重，重放不重复改余额。每日 `wallet_reconcile` 系统任务先 flush 队列再核对 `Σledger = 当前余额`，偏差超阈值只告警（SysError、系统日志、通知管理员），不自动改余额。接口：用户自助与管理员分页查询、CSV 导出（UTF-8 BOM，10 万行上限，自助与管理员均可导出）、管理员对账单用户查询；前端新增钱包账本对话框（钱包页与用户管理行操作入口：分页、类型标签、金额着色、CSV 导出），补齐七语言文案（`i18n:sync` missingCount=0、extrasCount=0）。测试：`model/wallet_ledger_test.go` 在 SQLite/MySQL/PostgreSQL 矩阵覆盖事务回滚与幂等重放、按小时消费聚合、期初回填、对账偏差；CI 新增 `backend-real-db` job（MySQL 8.0 + PostgreSQL 16 服务容器，运行 `go test ./model/ -run 'TestWallet'`）。本地未运行测试（CI-only）。

钱包 Step 进度：

- [x] WL-04：wallet_holds 持久化钱包预扣 + 超时回收 + 幂等退款 —— 新增主库 `wallet_holds(request_id 唯一, user_id, amount, status[active/settled/refunded/expired], parent_id 可空, expires_at, created_at, updated_at)`（`model/wallet_hold.go`）：钱包预扣在**同一事务**内扣减 quota 并写入/扩写 hold，覆盖 Redis Lua 与条件 UPDATE 两条路径（`TryReserveUserQuota(id, quota, requestId)`，`requestId` 为空时保留旧缓存/批量路径；缓存路径命中 Lua 后同步落库 hold，失败补偿缓存；`ReserveUserQuotaWithDebt` 对应结算式补扣并同步缓存）；结算 `SettleWalletHold` 与退款 `RefundWalletHold` 在同一事务内关闭 hold 并按 `request_id` 幂等（退款金额取持久化 hold 金额而不是内存 `consumed`，账本引用 `request_refund` 二次防重；`BillingSession.Settle` 差额为 0 时也会提交资金来源以关闭 hold）；`ReverseWalletHoldReserve` 把中途补充预扣的回滚与 hold 收缩合并为同一事务；上游 #7738 的「durable financial intent + recovery」思路落地为 `service/wallet_hold_recovery.go` 的 `wallet_hold_recovery` 系统任务（每 10 分钟、每批 200）：对 `expires_at` 已过且仍 active 的根 hold 在事务内写 `wallet_ledger` 退款并标记 `expired`（失败计数 + SysError，保留待重试），修复进程崩溃/重启只扣不退；同一任务按 7 天保留期批量清理已关闭的 hold（`CleanupClosedWalletHolds` 先按 id 列表选取再删除，SQLite/MySQL/PostgreSQL 同一语句；active hold 永不清理，因为它们仍持有额度），结果记录 `scanned_count`/`expired_count`/`failed_count`/`refunded_quota`/`cleaned_count`；父 hold（`parent_id`）能力供 BL-03 工作流预算挂载：`CreateWalletBudgetHold` 一次运行一个父 hold（真实预扣），`MountWalletBudgetChild` 只记录步骤分配不再扣费，父 hold 结算/退款/过期时级联关闭子 hold；可用余额仍等于 `quota`（预扣已扣，不做 `quota − Σholds` 真冻结）；`expires_at` 默认 1 小时（`WALLET_HOLD_TTL_SECONDS`，最小 60s）；hold 金额与余额运算统一走 `common.MaxWalletQuota` 边界并在饱和时 `common.SysError` 审计；测试：`model/wallet_ledger_test.go` 新增 `TestWalletHoldReserveExtendsAndSettles`（SQLite/MySQL/PostgreSQL 矩阵：预扣写 hold、余额不足不留 hold、补充预扣扩写同一 hold、结算多退少补与重放、已关闭 hold 拒绝再预扣）、`TestWalletHoldRefundIsIdempotent`（重复退款只退一次且只有一条 `request_refund` 流水、退款后迟到结算按实际全额扣费、账本对账无偏差）、`TestWalletHoldExpiryRecoveryRefundsCrashedReservations`（未到期不退、崩溃后回收退款一次、重放与迟到退款幂等、已结算不被回收、正常退款与回收并发只退一次）、`TestWalletHoldBudgetParentMountsChildren`（父 hold 预扣一次、子 hold 不扣费可扩写、越权/缺失/已关闭父 hold 拒绝、父结算或回收级联子 hold）与 `TestWalletHoldRedisReserveWritesHold`（miniredis：Lua 预扣路径在批量模式下也同步落库 hold 并同步缓存）；CI 复用既有 `backend-real-db` job（MySQL 8.0 + PostgreSQL 16 服务容器执行 `go test ./model/ -run 'TestWallet'`，新测试同样匹配该过滤）与 `backend` job 的 `model` 包测试；无新依赖；本地未运行测试（CI-only，本地未运行测试）。

- [x] WL-02：关机时清空批量额度队列与在途退款 —— `model.InitBatchUpdater(ctx)` 改为可停止的周期写入器并返回退出 channel；新增 `model.FlushBatchUpdate(ctx)`：在 `batchFlushLock` 下快照并清空各增量队列，在同一事务内按 key 排序落库（降低多 master 行锁死锁），失败时把快照并回内存队列并按秒重试，超时用 `common.SysError` 记录未落库条数并返回 `context.Canceled`/`DeadlineExceeded`（不再静默丢弃）；`service.BillingSession.Refund` 的异步退款纳入 `billingRefundsRunning` WaitGroup，新增 `service.WaitBillingRefunds(ctx)`；系统任务运行器新增取消/退出信号与在途 handler WaitGroup（`service.StopSystemTaskRunner(ctx)`，handler ctx 随关机取消），保证任务结算/退款先完成；`main.go` 在 HTTP `srv.Shutdown` 与看板缓存落库后先 drain（停止系统任务运行器 + 等待在途退款，15s）再停止批量写入器并 flush（30s），成功记录 `accounting drain complete`、失败记录 `server exited with incomplete accounting drain`（容器 stop grace 需覆盖 HTTP 120s + 15s + 30s）；计费金额与 quota 换算未改动（重试只重放内存增量，成功即清空，不重复扣费）；上游 `BatchUpdateReceipt` 持久化幂等表与 hijacked-WebSocket 记账排空不在本 Step 范围；新增 `TestBatchUpdateShutdownFlushMatrix`（SQLite/MySQL/PostgreSQL 真库矩阵：flush 前增量只在内存、flush 后用户额度/用量/请求数/令牌/渠道增量全部落库、空 flush 不重放、后到增量继续落库）、`TestFlushBatchUpdateTimeoutLogsAndRetainsDeltas`（超时返回 `DeadlineExceeded` 且日志含保留提示，失败增量下次 flush 落库）、`TestWaitBillingRefundsWaitsForInFlightRefund`、`TestStopSystemTaskRunnerWaitsForInFlightHandler`；CI 新增真实数据库 job（MySQL 8.0 + PostgreSQL 16 service 容器，设置 `TEST_MYSQL_DSN`/`TEST_POSTGRES_DSN` 运行该矩阵）；本地未运行测试（CI-only，本地未运行测试）。
- [x] WL-03：订阅退款改为单一事务 + 结算超额转扣钱包 —— `RefundSubscriptionPreConsume` 改为在同一事务内完成「改订阅金额 + 改退款记录状态」：按与 `PreConsumeUserSubscription` 一致的顺序先锁定 `user_subscriptions` 行，再用条件更新 `status <> 'refunded'` 原子认领退款（并发或重试只有赢得认领的事务扣减），失败整体回滚、可安全重试，不再调用会自开事务的 `PostConsumeUserSubscriptionDelta`；新增 `model.SettleUserSubscriptionDelta`（`model/subscription.go`）：单一事务内结算，超出订阅剩余额度的部分在套餐 `AllowWalletOverflow`（`user_subscriptions.allow_wallet_overflow` 快照）为真时转扣钱包，同一事务写 `wallet_ledger`（WL-05）`consume_hourly` 行；WL-06 透支策略落地前按「最多扣到 0」执行，未覆盖部分以 `WalletUncovered` 返回并 `common.SysError` 告警，同时写入消费日志 `other.admin_info.subscription_overflow_uncovered`（仅管理员可见），HTTP 结算链路额外 `logger.LogWarn`；套餐不允许钱包溢出时订阅只扣到总额上限并同样记录告警，不再静默少扣；接入 HTTP 结算（`SubscriptionFunding.Settle`/`BillingSession.Settle`/`SettleBilling`）、任务差额结算（`RecalculateTaskQuota`/`RefundTaskQuota` 经 `taskAdjustFunding`）与按次计费回退路径（`postConsumeQuotaWithResult`），`relayInfo.SubscriptionPostDelta` 只记订阅承担部分，消费日志 `wallet_quota_deducted` 反映实际转扣金额；前端用量日志费用气泡把该转扣计入订阅账单总额（`log-cost-display.tsx`、`usage-logs/types.ts`、`cost-display.test.tsx` 新增用例）；测试：`model/subscription_settlement_test.go` 的 `TestSubscriptionPreConsumeRefundIsAtomicAndIdempotent`（注入订阅写失败证明金额与状态同事务回滚，随后成功退款 + 重复退款幂等）与 `TestSubscriptionSettlementOverflowChargesWallet`（SQLite/MySQL/PostgreSQL 矩阵：钱包足额/部分覆盖超额、负余额不扣、套餐禁止溢出、额度内结算、无限套餐、负数退还与零下限，并校验账本行与余额），`service/tiered_settle_test.go` 的 `TestBillingSessionSettleSubscriptionOverflowChargesWallet`（relayInfo 拆分字段与 `wallet_quota_deducted`/`admin_info` 日志字段），`service/task_billing_test.go` 的 `TestRecalculate_Subscription_OverflowChargesWallet`（任务差额结算转扣钱包 + 账本行）；`.github/workflows/ci.yml` 的 `backend-real-db` job（MySQL 8 + PostgreSQL 16）过滤清单加入新矩阵测试；本 Step 未新增 quota 浮点换算（订阅结算 delta 仍来自既有 `common/quota_math` `*Checked` 饱和路径，模型层只做带上限的整数增减）；未新增文案键（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；参考上游 #5556、#6911（只借鉴思路）；本地未运行测试/构建（CI-only）。

## 12. 邀请返利

> 来源：对 newapi-rev 邀请/返利代码（`repo-ro` main @ `1e8458b`）与上游 QuantumNous/new-api issue/PR 的只读调研，对照硅基流动、智谱 BigModel、Notion/Webflow 等同类做法与国内合规要求（详见 `/workspace/newapi-rev-research/referral.md`，2026-10-17）。用户已批准 referral.md 第 4 节全部推荐方案，并把 RF-02..RF-09 加入编排器；WL-09 收窄为纯正确性修复（即 RF-01，不另建 RF-01）。所有返利 Step 都要先读 `.agents/rules/billing.md`，沿用 9.4 节规则：在 CI 的真实数据库（MySQL、PostgreSQL、SQLite）上测试，本地不跑测试。RF-02..RF-09 排在 WL-05/WL-07/WL-08（WL-06 按需）之后，并通过它们间接依赖 UP-00。

### 12.1 现状中的主要问题

- **无充值返佣**：只有注册一次性固定奖（`QuotaForInviter`/`QuotaForInvitee`），充值/兑换成功路径没有任何 aff 逻辑（上游 #6906、#5358、#5829 等持续在要）。
- **注册即发、可刷**：奖励注册时直接入账，无付费门槛与退款窗口，小号自邀可套利（上游 #128 提议「消费后解锁」）。
- **无退款追回、未接账本**：`aff_quota`/`aff_history` 是 users 表可变整数，`TransferAffQuotaToQuota` 全量写且无流水，与 WL-05 账本目标冲突。
- **4 位 `aff_code` 无重试**：碰撞导致注册失败（上游 #6215）。
- **`aff_count` 统计 bug**：`QuotaForInviter=0` 时邀请人数不自增（上游 #6362/#6363）。
- **无明细面板、归因粗糙**：只有 3 个汇总数字；localStorage 无归因窗口、无消费门槛；上游 #4360、#5766 未合并。
- **合规只覆盖「开关」**：现有支付合规门控只决定允许/禁止，未处理单层 vs 多级、佣金提现的个税/支付牌照问题；上游 #6539 的多层级佣金结构不可采用。

### 12.2 已批准的决策

1. **奖励类型（D1=B）**：邀请人按被邀请人**实付充值**比例返佣；被邀请人保留固定新人礼（`QuotaForInvitee` 不变）。
2. **奖励形式（D2=A）**：以 WL-07 赠送额度（`credit_grants`，`source=referral`）发放，可设有效期、不可提现/转让/开票；现金结算为**默认关闭**的开关，复用现有 `IsPaymentComplianceConfirmed` 门控。
3. **返佣期限（D3=B）**：默认注册后 12 个月内每笔充值返；配置支持 0=仅首充、-1=永久。
4. **发放时点与防刷（D4=C）**：付费且过退款窗口后才发放；同 IP/设备/邮箱域限次、每日/每月封顶、禁止自邀、大额人工审核；重复实名不重复发（国内站可选实名后发放）。
5. **退款追回（D5=B）**：佣金 `pending → locked → settled`，锁定 14~30 天可配；窗口内退款直接撤销；已结算的通过 WL-05 账本冲正，最多扣到 0、余下记欠款（WL-06）。
6. **归因（D6=B）**：链接 + 邀请码双通道，注册时单次绑定，不引入 cookie/多触点追踪；不允许用户自行改绑；`aff_code` 加长 8~12 位并碰撞重试（修 #6215）。
7. **统计面板（D7=B）**：用户端邀请明细 + 管理端汇总与 CSV 导出（对应上游 #6364）。
8. **按用户组配置（D8=B）**：全局默认 + 用户组覆盖 + 单人覆盖，复用 fork 已有的 `GroupOverrides` 模式。
9. **渠道代理档位（D9=A+，可选）**：推荐官/代理档位可选且仅单层；明确不做多级/团队计酬（《禁止传销条例》红线，不采用 #6539 结构）。
10. **存量迁移**：`aff_quota`/`aff_history` 迁入账本 + referral grant，`TransferAffQuotaToQuota` 账本化。

### 12.3 与 WL-09 的合并/收窄

- 用户已批准把 **WL-09 收窄**为纯正确性修复：`aff_code` 加长 8~12 位 + 碰撞重试 + 回归测试（修上游 #6215），保留 id WL-09，不另建 RF-01；原「可选按充值比例返利」整体拆到 RF-02..RF-09。
- 这样 WL-09 与钱包解耦、可随 UP-00 后立即发布，不必等账本/退款链路；报告里 RF-01 作为依赖的地方一律改为 WL-09（如 RF-02 依赖 WL-09）。

### 12.4 邀请返利 Step

执行优先级：WL-09 随 UP-00 之后尽快做；RF-02 → RF-03（需 WL-05/WL-04）→ RF-04（WL-07）→ RF-05（WL-08/WL-06）；RF-06、RF-07 可与 RF-04 并行；RF-08 可选；RF-09 收尾。

| ID | 标题 | 依赖 | 优先级 |
| --- | --- | --- | --- |
| WL-09 | aff_code 加长（8~12 位）与碰撞重试，旧码兼容 | UP-00 | 刚需 |
| RF-02 | 邀请关系与归因记录模型 | WL-09 | 刚需 |
| RF-03 | 充值返佣引擎（事件、幂等、比例配置） | RF-02, WL-05, WL-04 | 推荐 |
| RF-04 | 佣金分桶、锁定与发放 | RF-03, WL-07 | 推荐 |
| RF-05 | 退款/拒付冲正与欠款 | RF-04, WL-08, WL-06 | 推荐 |
| RF-06 | 防刷与上限 | RF-02, RF-03 | 推荐 |
| RF-07 | 邀请统计面板（用户端 + 管理端） | RF-02, RF-03 | 推荐 |
| RF-08 | 按用户组比例与推荐官档位（可选） | RF-03 | 可选 |
| RF-09 | 存量 aff_quota 迁移与账本衔接 | WL-05, WL-07, RF-04 | 推荐 |

## 8. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-15 | 将历史聊天中的 Playground 目标、阶段路线、架构边界、资源配额和验收标准固化为本文件。 |
| 2026-10-16 | 完成 P0 全部五项：同步契约评估、三数据库迁移矩阵（含 rc.43 升级与 MySQL 5.7）、Artifact 失败恢复/冲突/草稿保护与测试、生成目录加入 `.gitignore`、账号隔离与迟到请求测试；Playground 测试 49/49、typecheck、lint、格式、生产构建通过。 |
| 2026-10-16 | 复核 Phase 3：Artifact 容量限制（数量/版本/单版本/会话容量）与桌面并排面板、移动 Sheet、草稿保护均已实现；补充 `workspace-layout.test.tsx`（桌面/移动布局与关闭回调，4 个用例），Playground 测试 53/53、lint 通过；完成 diff 安全扫描（无密钥、无直连上游、许可证头齐全）。 |
| 2026-10-16 | 引入 Playwright E2E 真实浏览器验收（`web/e2e/`：globalSetup 初始化实例、每用例 UI 登录规避一次性刷新令牌、后端 harness 关闭登录限频、桌面/移动双 project；`bun run test:e2e`，7 用例全通过，冷启动与复用实例各跑一遍）。E2E 暴露并修复两处同步缺陷：主动取消的读写不再污染同步错误态，并通过 settle 计数与取消过滤自动重试（`server-sync.test.tsx` 新增两个用例）；自行处理失败的 Playground 查询通过 `keepPageOnInternalServerError` meta 保留页面错误态，不再触发全局 500 跳转（`server-error-notifications.test.ts` 覆盖）。全量前端测试 2260/2260、typecheck、oxlint 通过。 |
| 2026-10-17 | 完成 Phase 4 附件与多模态消息：服务端 `playground_attachments` 表（base64 LongText 存储、媒体签名校验、单文件 8 MiB/每用户 64 MiB 预算、client key 幂等重放、会话级联删除、引用状态与孤儿 TTL 清理系统任务）；受控内容接口（`UserAuth` + owner/session 过滤、nosniff/沙箱 CSP、字节精确输出）；消息快照接受附件引用（仅用户消息、事务内重算引用、被引用禁止删除）；前端 `PromptInput` 附件入口/预览/限制、上传→消息→多模态 payload 全链路与消息附件预览；E2E 新增附件用例（上传→SSE→请求体 `image_url`→刷新恢复）。后端矩阵在 SQLite 3.50.4 / MySQL 8.0.46 / MySQL 5.7.44 / PostgreSQL 16.15 全部通过（期间清理了 PG 测试库中旧迁移遗留表导致的索引同名冲突）。 |
| 2026-10-17 | 更新验收清单：勾选会话创建/切换/重命名/删除/清空、迟到 chunk 隔离、损坏数据降级、文本请求兼容、附件服务端控制、网络失败草稿保护，以及附件多模态的真实浏览器验收项；补齐附件相关 11 个新键与既有缺失键的七语言翻译（`i18n:sync` missingCount=0）。 |
| 2026-10-17 | S00：让 GitHub CI 在推送 main 时运行——`.github/workflows/ci.yml` 增加 `push: branches: [main]`，checkout 以 `github.event.pull_request.base.repo.full_name \|\| github.repository` 与 push 时的 `github.sha` 修正，backend/frontend 两个 job 的 `if` 放开 push，concurrency 改为 ref+sha 分组避免 main 连续推送互相取消；仅改 CI 配置，本地未运行测试（CI-only）。 |
| 2026-10-17 | P5-01：完成 Infinite Canvas 前端画布编辑器——新增 `/_authenticated/playground/canvas` 路由与 Playground 侧边栏入口，画布项目列表（搜索/新建/重命名/删除确认），基于 `@xyflow/react` 与 ai-elements `Canvas`/`Node`/`Panel` 的编辑器（缩放/平移/框选/小地图/节点详情/撤销重做/JSON 导入导出/revision CAS 自动保存与冲突提示），复用既有 `features/canvas` 客户端与 `/api/playground/canvases` CRUD；新增 `use-canvas-editor` 与项目列表测试，补 44 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；仅前端改动，无新依赖；本地未运行测试（CI-only，未运行 typecheck/vitest/lint/build）。 |
| 2026-10-17 | SEC-01：为 Markdown/Code Artifact 补齐安全与复制/下载验收——`playground-artifact-panel.test.tsx` 新增 5 个用例：Markdown 预览不执行原始 HTML/`<script>`/内联事件处理器/`javascript:` 链接、Code Artifact 的标记仅作文本、复制写入完整正文、下载文件名清洗与正文内容/`text/plain;charset=utf-8` 类型、`plaintext`→`.txt` 扩展名；修复 `getArtifactFilename`：Code Artifact 无语言或 `plaintext` 时下载扩展名对齐 `CodeBlock` 输出 `.txt`；`i18n:sync` missingCount=0（未新增文案键，无 locale 变更）；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | UX-01：让 Playground 消息编辑与重新生成保留历史版本/分支——消息新增 `activeVersionIndex`，`versions` 保留每次编辑/重新生成的历史（`appendMessageVersion`/`setActiveMessageVersion`，`updateCurrentVersionContent` 仅改活动版本，`getCurrentVersion` 对缺失/越界索引回退首个版本）；编辑与重新生成改为追加助手回复版本，并保持生成回复为最后一条以兼容既有流式链路；`PlaygroundChat` 复用 ai-elements `Branch`/`BranchMessages`/`BranchSelector` 渲染可切换分支，生成中禁用切换；服务端 `playgroundMessagePayload` 持久化 `activeVersionIndex`，事务内校验索引越界、`PlaygroundMessageMaxVersions` 版本上限与消息数上限，超限回滚保留既有快照；新增 `message-branching.test.ts`、`playground-chat-branches.test.tsx` 与 `TestPlaygroundMessageVersionBranches`（SQLite/MySQL/PostgreSQL 矩阵）；未新增文案键，`i18n:sync` missingCount=0、extrasCount=0；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | P5-02：接入画布撤销/重做快捷键并加固版本化导入/导出——`useCanvasEditor` 新增 `shortcutsEnabled` 选项，绑定 Ctrl/Cmd+Z（撤销）、Ctrl/Cmd+Shift+Z 与 Ctrl/Cmd+Y（重做），输入框/文本域/选择框/contenteditable 内不拦截以保留原生撤销，编辑器禁用时不生效；沿用既有工具栏按钮与 `canvas-history`，导入/导出继续复用 `parseCanvasImport`/`serializeCanvasExport` 与 `version:1` 校验，超限/损坏文件抛可翻译的 `CANVAS_ERRORS` 且不截断，保存沿用 `updateCanvasProject` 的 revision CAS；`use-canvas-editor.test.ts` 补快捷键矩阵、可编辑元素透传与禁用态用例，`canvas-document.test.ts` 补超大节点与超预算文档拒绝用例；未新增文案键，`i18n:sync` missingCount=0、extrasCount=0；仅前端改动，无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | P5-03：把 Playground 消息/附件/Artifact 映射为画布节点并加固引用归属——消息操作与 Artifact 面板新增「发送到画布」（`canvas-send-dialog.tsx` 选择或新建项目，`lib/canvas-send.ts` 的 `buildMessageCanvasSeeds`/`buildArtifactCanvasSeeds` 生成 prompt/message/attachment/artifact 节点，revision CAS 冲突自动重载并重试一次，节点数据只保留 `sessionId/messageKey/attachmentId/artifactId` 引用），画布节点新增 `note/attachment/task-result` 类型并经 Playground 受控内容接口预览附件/图片；服务端 `ValidatePlaygroundCanvasReferences` 在创建与更新时校验被引用 session/message/attachment/artifact 属于同一用户且存在，跨账号或缺失返回 400 `PLAYGROUND_CANVAS_REFERENCE_INVALID`；新增 `canvas-send.test.ts`、`canvas-send-dialog.test.tsx`、`message-actions.test.tsx`，扩展 canvas `types`/`constants`/节点渲染与 Inspector、Artifact 面板测试及 `model/playground_canvas_test.go` 引用归属矩阵；补 9 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | P5-04：打通画布与聊天 session/消息/附件/Artifact 的引用生命周期——服务端新增 `PlaygroundCanvasAsset` pin 表：画布创建/更新在同一事务内重建被引用附件的 pin，删除画布或保存不再引用该附件的文档时释放；`DeleteOrphanedPlaygroundAttachments` 跳过被 pin 的附件，被 pin 的附件禁止手动删除（`ErrPlaygroundAttachmentInUse`），`DeletePlaygroundSession` 级联删除会话附件时同步清理其 pin；`ValidatePlaygroundCanvasReferences` 改为「跨账号引用仍返回 400，已删除或会话不匹配的资源容忍并保持画布可编辑」，`GetPlaygroundCanvasProject` 经 `PlaygroundCanvasReferenceAvailability` 返回 `unavailable_node_ids`；前端 `applyCanvasReferenceStatus` 在加载时标记 `sourceDeleted`，`canvas-node.tsx` 显示「来源已删除」徽标与快照提示、`canvas-node-inspector.tsx` 同提示，`canvas-editor.tsx` 补齐 `note/attachment/task-result` 节点类型映射；`model/playground_canvas_test.go` 新增 `TestPlaygroundCanvasAttachmentPins`（引用/解除引用 + 孤儿清理交互）、`TestPlaygroundCanvasAttachmentDereference`（保存不再引用的文档释放 pin）、`TestPlaygroundCanvasSessionCascade`（会话级联与孤儿清理 + 跨用户 404）、`TestPlaygroundCanvasReferenceSourceDeleted`（来源删除标记与可编辑性），并改写 `TestPlaygroundCanvasReferenceOwnership` 的缺失引用预期，`model/playground_test.go` 迁移表加入新表；前端新增 `canvas-node.test.tsx`、扩展 `canvas-document.test.ts`；补 2 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | Q-01：实现独立于 Token Quota 的用户/用户组 Playground 资源配额策略——新增 `setting/playground_setting`（`PlaygroundQuotaPolicy` + `GroupOverrides`，经 `config.GlobalConfig` 注册；全局默认等于既有服务端硬上限，用户组可逐字段覆盖，零/负值继承上级不放开限制），`model/playground_quota.go` 的 `PlaygroundQuotaPolicyForUser`/`playgroundPolicyForUser` 在写入事务内解析策略并原子校验：会话数、消息数与快照字节、附件单文件字节·每用户字节·每用户文件数、Artifact 会话数量·记录数·版本·正文·单 Artifact 与会话容量、画布项目数·文档字节·节点·边·节点数据字节；移除 `model.Playground*` 硬编码常量与变量，模型写入统一 `lockForUpdate` 后重算并返回稳定错误码，新增 `PLAYGROUND_SESSION_LIMIT_EXCEEDED`、`PLAYGROUND_MESSAGE_LIMIT_EXCEEDED`（附件/Artifact/画布沿用既有码）并登记七语言文案（`i18n:sync` missingCount=0、extrasCount=0）；`model/playground_test.go`/`model/playground_canvas_test.go` 改用策略覆盖并新增 `TestPlaygroundQuotaPolicyResolutionAndSessionLimit`（全局+用户组解析、会话上限、删除释放配额）、`TestPlaygroundMessageQuotaLimit`、`TestPlaygroundAttachmentCountLimit`；任务并发字段 `TaskMaxConcurrency` 已纳入策略，Phase 6 任务运行时接入后强制；未改动 `service/`、`relay/` 与计费表达式路径（不影响 token billing 结算语义）；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | Q-02：让 Playground 资源配额可管理并暴露统一用量视图——管理端「安全与限制」新增「Playground 资源配额」分组（全局默认 + 按用户组覆盖，`playground-quota-section.tsx`/`quota-fields.ts` 读写 `playground_setting.defaults`/`playground_setting.group_overrides`，基线差分保存、正整数校验）；策略新增账户级 Artifact 上限 `ArtifactUserMaxCount`/`ArtifactUserMaxBytes`，`checkPlaygroundArtifactCapacity` 在创建时校验账户活跃数量、始终校验账户字节（默认取既有会话级上限的理论上界，不拒绝此前已接受的写入）；新增只读 `GET /api/playground/usage`（`UserAuth` + owner 过滤，`model/playground_usage.go` 的 `PlaygroundUsageForUser` 复用 `GetPlaygroundQuotaPolicy`，返回会话/附件/Artifact/画布的 used/limit 与字节）；用户端工作区新增资源用量弹层（`playground-usage-popover.tsx`，仅打开时挂载查询）；补 41 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；新增 `TestPlaygroundUsageForUserReportsOwnerTotals`、`TestPlaygroundArtifactAccountLimit` 与前端 `playground-quota-section.test.tsx`、`playground-usage-popover.test.tsx`；无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | UX-02：统一 Playground 右侧 Inspector 并打通聊天↔画布双向跳转——新增共享 `components/workspace-inspector.tsx`（桌面 `ResizablePanelGroup` 并排、移动端右侧 Sheet，复用 Base UI 焦点陷阱与既有未保存草稿保护），Playground 头部按钮在「Artifacts」与「Canvases」两个视图间切换同一面板（`playground-canvas-panel.tsx` 用 `listCanvasProjects`/`getCanvasProject` + `fromServerDocument` 只读预览节点并可「打开画布」，`canvas-editor.tsx` 的节点详情复用同一外壳）；路由新增 `validateSearch` 深链：`/playground?session&message&artifact` 切换到对应会话并打开制品（等待 `sync.isLoading` 结束、按 `session.server.id` 匹配、切换后 `selectArtifact`），`/playground/canvas?project` 打开指定画布；画布节点详情新增「来源」区，经 `lib/canvas-navigation.ts` 生成跳转参数回到源会话/制品（`CanvasNodeInspector` 只暴露 `onOpenSource` 回调，由 `CanvasWorkspace` 用 `useNavigate` 接线，组件不依赖路由、可测试；`canvas-send-dialog.tsx` 的 `onSent` 改为回传 `CanvasServerProject`，发送后打开对应画布预览）；扩展 `workspace-layout.test.tsx`（桌面并排/隐藏与视图切换、移动 Sheet 关闭、会话列表入口），新增 `playground-canvas-panel.test.tsx`、`canvas-navigation.test.ts`、`canvas-node-inspector.test.tsx`，扩展 `canvas-send-dialog.test.tsx` 断言 `onSent(project)`；补 5 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；仅前端改动，无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | P6-01：将 Playground 图片/视频/音频生成映射到现有 Relay、渠道与 task plugin 并复用任务状态/错误/权限/计费链路——新增 `/pg/images/generations`、`/pg/images/edits`、`/pg/videos`、`/pg/audio/speech` 路由（`middleware.PlaygroundRelayBridge` 在任务插件 pin 与渠道选择前将路径重写为 `/v1` 规范路径并校验用户组覆盖，`PinTaskPluginEndpoint`/`PrepareTaskPluginEndpoint`/`Distribute` 与 `controller.PlaygroundImageGeneration`/`PlaygroundImageEdit`/`PlaygroundVideoTask`/`PlaygroundAudioSpeech` 复用 `RelayTaskPluginEndpoint`/`Relay`/`RelayTask`）；Q-01 的 `TaskMaxConcurrency` 在控制层经 `model.CountActivePlaygroundTasks`（按账号 durable task 行，独立于 `User.Quota`/token 计费）强制，超限返回 `PLAYGROUND_TASK_LIMIT_EXCEEDED`（七语言文案 + `server-error-message` 映射）；任务列表/轮询复用 `/api/task/self`、`taskStatusMapper`/`StatusBadge` 与 `TaskArtifactsCell`；画布任务结果节点只保存 `taskId`/`taskArtifactKey` 引用，保存时按 `(user_id, task_id)` 校验归属（`TestPlaygroundCanvasTaskReferences`）；新增 `TestPlaygroundTaskConcurrencyCount`、`playground-generation-panel.test.tsx`，扩展 `canvas-send.test.ts`；补 20 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | P6-02：设计 Agent/工具调用状态但绝不执行工具——消息版本新增 `toolCalls` 快照（流式增量合并 `applyToolCallDelta` 丢弃乱序/跳号 index 保证数组稠密、`applyResponseToolCalls` 整体写入、`setToolCallStatus` 用户手动提供结果或拒绝、`getToolCallResponseContent` 生成 `tool` 消息内容）；`message-tool-calls.tsx` 复用 ai-elements `Tool`/`Confirmation` 展示 pending/completed/denied/error，提供「提供结果」对话框、「拒绝」与「继续生成」（仅最后版本、待办全部答复后），待办期间禁用输入并提示；请求 payload 把助手消息展开为 `tool_calls` + 每条已答复调用一个 `tool` 消息，`pending` 调用不发送；服务端新增 `playgroundMessageToolCall` + `validatePlaygroundToolCalls`（仅助手消息、每版最多 16 条、`id`/`name` 非空且 `id` 唯一、参数 64 KiB/结果 256 KiB、状态枚举，违规 400 且事务回滚保留既有快照）与策略字段 `tool_call_max_count`/`tool_call_arguments_max_bytes`/`tool_call_result_max_bytes`（管理端「Tool calls」分组可按用户组覆盖）；`getMessageContentState` 改为按被渲染版本判断可见性，分支视图正确显示各版本工具调用；新增 `tool-call-state.test.ts`、`message-tool-calls.test.tsx`、`TestPlaygroundToolCallSnapshots`（SQLite/MySQL/PostgreSQL 矩阵），扩展 `use-stream-request.test.ts`（流式片段分发）与 `model/playground_test.go`；补 19 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | P6-04：实现用户素材库与任务结果/Artifact/Canvas 的安全关联——新增只读 `GET /api/playground/assets`（`kind=attachment|artifact` 必填，owner 过滤；附件按 `created_at DESC`、Artifact 按 `updated_at DESC`，搜索为大小写不敏感字面子串并转义 `%`/`_`/`!`、≤100 字符，附件 `in_use` 取消息引用或画布 pin，Artifact 排除墓碑；非法查询 400 `PLAYGROUND_INVALID_REQUEST`、内部错误 `PLAYGROUND_STORAGE_ERROR`）；任务结果继续经 owner 隔离的 `/api/task/self` 与 `TaskArtifactsCell` 复用，Artifact/画布关联沿用 P5-04 的 pin 与归属校验；前端 Inspector 新增素材库视图（`asset-api.ts`、`use-playground-assets`、`use-attachment-preview-url` 由画布节点与素材卡共用；卡片复用 `ArtifactAction` + `ConfirmDialog`，`in_use` 附件禁删；发送到聊天把附件经受控内容接口注入待发送 `File`、Artifact 正文追加草稿，`playground-input.tsx` 的 `pendingFiles`/`pendingText` 只消费一次）；新增 `TestPlaygroundAssetLibraryListing`（SQLite/MySQL/PostgreSQL 矩阵：in_use、墓碑排除、跨用户隔离、分页、搜索转义、非法查询）并扩展真实 router 鉴权用例，前端新增 `playground-asset-library.test.tsx`（8 用例）、扩展 `canvas-send.test.ts` 与 `playground-input-attachments.test.tsx`；`middleware/access_token_routes.go` 声明 `GET /api/playground/assets` 的会话级访问令牌规则（通过路由覆盖检查）；补 17 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | P6-05：为长任务设置并发、存储和生命周期限制——任务行新增 `TaskPrivateData.PlaygroundOrigin` 来源标记（`controller/playground_generation.go` 写入 `constant.ContextKeyPlaygroundOrigin`，`controller/relay.go` 创建任务时沿用），生命周期策略只作用于工作区来源任务且不触碰 `User.Quota`/token 计费；`enforcePlaygroundTaskBudget` 在 Relay 前同时强制并发（沿用 `model.CountActivePlaygroundTasks` 与 `TaskMaxConcurrency`）与新增的账户级结果存储预算 `TaskUserResultMaxBytes`（默认 64 MiB，零/负值继承，全局与用户组可覆盖），`model.PlaygroundTaskResultStorageBytes` 按方言 SQL（SQLite `json_extract` + `LENGTH(CAST(data AS BLOB))`、MySQL `JSON_UNQUOTE(JSON_EXTRACT(...))` + `OCTET_LENGTH(CAST(data AS CHAR))`、PostgreSQL `private_data->>'playground_origin'` + `OCTET_LENGTH(CAST(data AS TEXT))`）统计工作区任务结果快照字节，超限返回 429 `PLAYGROUND_TASK_STORAGE_LIMIT_EXCEEDED`；新增调度清理 `service/playground_task_cleanup.go`（`playground_task_cleanup`，7 天 TTL、每 6 小时、每批 200）与 `model.DeleteExpiredPlaygroundTasks`（只硬删除 `finish_time` 已过期的终态工作区任务行）；新增 `POST /api/playground/tasks/:taskId/cancel`（`UserAuth` + `accessTokenSessionRule`）与 `model.CancelPlaygroundTask`（owner+origin 过滤、状态 CAS 转 FAILURE、`FailReason="Task canceled"`，成功后 `service.RefundTaskQuota` 退还预留额度，404/409/500 稳定错误码），前端任务列表新增取消按钮 + `ConfirmDialog` + `useCancelPlaygroundTask`；`GET /api/playground/usage` 新增 `tasks` 指标（活跃并发 vs `TaskMaxConcurrency`、快照字节 vs `TaskUserResultMaxBytes`）并在用量弹层展示，管理端配额新增 `task_user_result_max_bytes` 字段；`model/playground_test.go` 新增 `TestPlaygroundTaskStorageBudget`（SQLite/MySQL/PostgreSQL 矩阵 + 控制器 429）、`TestPlaygroundTaskExpiryCleanup`（矩阵）、`TestPlaygroundTaskCancellation`（owner 作用域/404/409/CAS/退款守卫），扩展 `TestPlaygroundUsageForUserReportsOwnerTotals` 与真实路由鉴权；前端扩展 `playground-generation-panel.test.tsx`、`playground-usage-popover.test.tsx`，`static-keys.ts` 登记新常量键；补 10 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only，本地未运行测试）。 |
| 2026-10-17 | 计划：新增第 9 节“第二阶段追加计划”——根据对 lobehub/lobehub 与 basketikun/infinite-canvas 的源码调研，追加 27 个 Step（ST-01..06 对象存储、DB-01..04 数据存储、CH-01..07 聊天工作区、CV-01..05 画布、BL-01..04 计费、SEC-02 沙箱预览），记录存储（ObjectStore + R2 推荐）、计费（权益制默认 + 可选 GB-月计量）决策与 4 项用户批准的例外；全部排在 P6-02/P6-04/P6-05 之后。 |
| 2026-10-17 | 计划：新增第 10 节“上游同步策略与上游借鉴 Step”——确定以 merge 方式独占同步上游 QuantumNous/new-api（UP-00，P6 完成后执行，之后每 7 天一次），追加 UP-01..UP-14（断开取消上游、首字超时换渠道、RPM/TPM 准入、count_tokens、兑换码兑换订阅、套餐分组限制与多窗口额度、令牌周期额度、管理员额度增量更新、/mj/image 访问控制、请求阶段耗时、切换模型清理历史、生图异步模式、稳定分组标识、Responses→Chat 降级）；第 9 节 27 个 Step 改为依赖 UP-00；接受上游敏感词默认关闭；零输出中断流照常收 prompt 费用。 |
| 2026-10-17 | P6-03：在画布中增加 `model` 工作流节点与运行/失败重试/任务取消——工作流链为产出节点 → `model`（经 `/pg/chat/completions` 非流式调用）→ `task`（`submitImageGeneration`/`submitVideoGeneration` 提交）→ `task-result`（只在 `ref` 保存 `taskId`/`taskArtifactKey` 引用）；服务端节点类型契约新增 `model`（`controller/playground_canvas_test.go` 覆盖类型接受、未知类型拒绝与节点数据字节上限）；前端 `canvas-workflow.ts` 做无环与输入校验并拓扑排序，`use-canvas-workflow-runner.ts` 顺序执行并对 `running` 步骤轮询 `getUserTaskLogs` durable 行而非重复提交、加载时按 durable 行恢复 `running` 任务节点、失败步骤起重试并复用已存输出、取消本地运行并对未完成任务调用 `cancelPlaygroundTask` 后按 durable 行结算；成功后仅为下游 `task-result` 抓取 `getTaskArtifacts`；运行状态以 `record:false` 写入不入撤销历史，节点/工具栏/Inspector 显示状态、错误、重试与取消；新增 `canvas-workflow.test.ts`、`use-canvas-workflow-runner.test.ts`、`canvas-toolbar.test.tsx`，扩展 `canvas-node.test.tsx`、`canvas-node-inspector.test.tsx`、`use-canvas-editor.test.ts`；补 19 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-17 | 计划：新增第 11 节“钱包”——批准 8 项钱包方案（主库 append-only 账本 + 每日对账、64 位 quota、额度分桶与有效期、持久化钱包预扣 + 关机 flush、按组透支上限与欠款只读、存储日结入统一账本、团队预算暂用令牌周期额度、退款/拒付 webhook 冲正与原币收款），追加 WL-01..WL-09，正确性修复排在 UP-00 之后最先执行；UP-08 缩小为令牌侧，UP-05/UP-06/BL-02/BL-03 改为复用钱包账本与预扣。 |
| 2026-10-17 | 上游同步：merge QuantumNous/new-api main @ `5e9595190`（54 个上游提交，merge 方式，不改写 fork 历史）；冲突按策略解决（语言包取 key 并集，ci.yml 保留 fork 的 checkout 写法，static-keys.ts 两边都保留，代码冲突语义合并）；**行为变化**：4013729f6 fix: disable sensitive word filtering by default and clear the default word list (#7814)；本地未运行测试（CI-only）。 |
| 2026-10-17 | WL-05：新增主库 append-only 钱包账本与每日对账——`model/wallet_ledger.go` 同事务入账（`AppendWalletLedgerTx`/`ApplyWalletLedgerDelta(DB)`/`GrantWalletQuota`/`RefundWalletQuota`：先锁用户行、以 `(ref_type, ref_id)` 唯一索引幂等去重，重放不改余额，事务回滚时余额与账本一并回滚），接入充值、兑换、管理员调整、退款、订阅余额支付、签到、邀请转入、系统赠送；API 消费按用户每小时聚合一行（内存批量或直接累加，`FlushBatchUpdates` 与失败重队），启动回填期初余额（`EnsureWalletLedgerOpeningBalances`）；`service/wallet_reconcile.go` 每日系统任务先 flush 再对账（`ReconcileWalletLedgers`），偏差超阈值只告警（SysError + 系统日志 + `NotifyRootUser`）不改余额；`controller/wallet_ledger.go` 提供用户自助/管理员分页查询、CSV 导出（UTF-8 BOM、10 万行上限）与管理员对账查询，`router` 与 `access_token_routes` 登记自助导出为 `wallet:read`；前端钱包账本对话框（分页、类型标签、金额着色、CSV 导出；钱包页与用户管理行操作入口）与七语言文案（`i18n:sync` missingCount=0、extrasCount=0）；测试：`model/wallet_ledger_test.go`（SQLite/MySQL/PostgreSQL 矩阵：事务回滚与幂等重放、按小时消费聚合、期初回填、对账偏差）与 CI `backend-real-db` job（MySQL 8.0 + PostgreSQL 16）；全部验证交由 CI（CI-only，本地未运行测试）。 |
| 2026-10-17 | WL-01：把 quota 列迁移到真正的 64 位并修复启动检查顺序——`migrateDB` 改为在 AutoMigrate 之前用 `migrateQuotaColumns` 就地把旧 32 位列拓宽为 bigint、AutoMigrate 之后再用 `ensureQuotaColumns` 校验（全新安装同一次启动即完成建表与校验，旧库第二次启动不再因 32 位列失败），非 master 节点只校验、不迁移，`migrateLOGDB` 对独立 MySQL/PG 日志库同样先拓宽再 `AutoMigrate(&Log{})`；`userQuotaColumns`/`ensureUserQuotaColumns` 替换为 `quotaColumnGroups`（User 的 `quota`/`used_quota`/`request_count`/`aff_quota`/`aff_history`、Token 的 `remain_quota`/`used_quota`，以及 Redemption/QuotaData/Task/Midjourney/Log 的 `quota`）与 `migrateQuotaColumns`/`ensureQuotaColumns`/`syncQuotaColumns`，`is64BitIntegerType` 归一化 MySQL 显示宽度并接受 `bigint`/`int8`；上述 quota 列的 gorm 标签显式声明 `type:bigint`（SQLite 整数本身最多 64 位，不做迁移）；`SKIP_64BIT_QUOTA_SCHEMA_CHECK=true` 同时跳过迁移与校验且只在启动时记录一次，`.env.example` 注释与后端日志文案同步更新；新增 `model/quota_bigint_migration_test.go`（唯一表前缀隔离：全新安装两次启动无 DDL、旧 32 位 schema 先被校验拒绝再被就地拓宽且旧行数值保留、写入 `common.MaxWalletQuota` 与 3e9~5e9 超 int32 值往返、升级后再启动无 DDL；SQLite 内存库 + `TEST_MYSQL_DSN`/`TEST_POSTGRES_DSN` 真库子测试，并静态断言所有 quota 列标签为 bigint）；`.github/workflows/ci.yml` 新增 `backend-databases` job（MySQL 8、MySQL 5.7、PostgreSQL 16 service 容器 + DSN，运行 `go test ./model/ -run 'TestQuotaBigint'`，5.7 经 3307 单独再跑一次）承担真库验证；额度换算继续使用 `common/quota_math` 的 `*Checked` 族与饱和审计，无新依赖；参考上游未合并 PR #5136（issue #5137）思路；本地未运行测试/构建（CI-only）。 |
| 2026-10-17 | 计划：新增第 12 节“邀请返利”——批准单层按被邀请人实付充值比例返佣（被邀请人保留固定新人礼；佣金以 WL-07 赠送额度发放、可设有效期、不可提现，现金结算默认关闭并复用 `IsPaymentComplianceConfirmed` 门控）；默认注册后 12 个月内每笔充值返（0=仅首充、-1=永久）；防刷（付费后才发、同 IP/设备/邮箱域限次、禁止自邀、日/月封顶、大额人工审核）；佣金 pending→locked→settled、锁定 14~30 天可配、窗口内退款撤销、已结算走 WL-05 冲正并扣到 0 记欠款（WL-06）；链接+邀请码注册时单次绑定、不可自行改绑；用户端明细+管理端汇总与 CSV 导出；全局默认+用户组+单人覆盖（GroupOverrides）与可选单层推荐官档位（禁止多级）；WL-09 收窄为 aff_code 加长 8~12 位与碰撞重试（#6215）并去掉可选按充值比例返利，追加 RF-02..RF-09 且排在 WL-05/WL-07/WL-08（WL-06 按需）之后。 |
| 2026-10-17 | UP-01：客户端断开时取消上游请求并停止重试——`relay/channel/api_request.go` 的 `DoApiRequest`/`DoFormRequest` 改用 `http.NewRequestWithContext(c.Request.Context(), ...)`（任务类路径沿用既有 `newTaskAPIRequest` 的上下文绑定，取消发生在提交前即经 `executeTaskSubmission` 退款、已持久化任务不回滚）；`service/relay_error.go` 的 `DecideRelayRetry` 在客户端请求上下文已取消时返回 `stop/client_gone/client`，覆盖常规重试与渠道错误重试，客户端断开后不再切换渠道重试；计费策略不变（零输出中断流照常收 prompt 费用，未改计费路径）；`policy-label.ts` 与七语言新增 `client_gone`/`client` 展示文案（`i18n:sync` missingCount=0、extrasCount=0）；新增 `TestDoRequestCancelsUpstreamWhenClientDisconnects` 与 `TestDecideRelayRetryReasons` 断开用例（CI-only，本地未运行测试）。 |
| 2026-10-17 | WL-02：关机时清空批量额度队列与在途退款——`model.InitBatchUpdater(ctx)` 改为可停止的周期写入器（返回退出 channel），新增 `model.FlushBatchUpdate(ctx)`：`batchFlushLock` 下快照并清空全部增量队列、同一事务内按 key 排序落库，失败时把快照并回内存队列并按秒重试，超时用 `common.SysError` 记录未落库条数并返回 `context.Canceled`/`DeadlineExceeded`（不再静默丢弃）；`model.batchUpdate` 的周期写入复用同一事务路径，失败同样保留增量；`service.BillingSession.Refund` 的异步退款纳入 `billingRefundsRunning` WaitGroup 并新增 `service.WaitBillingRefunds(ctx)`；系统任务运行器新增取消/退出信号（`runnerCtx` 贯通 claim pass 与 handler）与在途 handler WaitGroup + `service.StopSystemTaskRunner(ctx)`；`main.go` 在 HTTP `srv.Shutdown` 与看板缓存落库后先 drain（系统任务 + 在途退款，15s）再停止批量写入器并 flush（30s），成功记录 `accounting drain complete`、失败记录 `server exited with incomplete accounting drain`；计费金额与 quota 换算未改动；新增 `TestBatchUpdateShutdownFlushMatrix`（SQLite/MySQL/PostgreSQL 真库矩阵）、`TestFlushBatchUpdateTimeoutLogsAndRetainsDeltas`、`TestWaitBillingRefundsWaitsForInFlightRefund`、`TestStopSystemTaskRunnerWaitsForInFlightHandler`；`.github/workflows/ci.yml` 新增真实数据库 job（MySQL 8.0 + PostgreSQL 16 service 容器，`TEST_MYSQL_DSN`/`TEST_POSTGRES_DSN` 运行该矩阵）；上游 `BatchUpdateReceipt` 持久化幂等表与 hijacked-WebSocket 记账排空不在本 Step 范围；本地未运行测试（CI-only，本地未运行测试）。 |
| 2026-10-17 | UP-08（令牌侧，用户侧 fork 已修）：`PUT /api/token` 改为差额原子更新并写管理日志——`model.Token.Update` 的 Select 移除 `remain_quota`（配置字段提为共用 `tokenConfigFields`），新增 `model.Token.UpdateWithQuotaTarget(snapshot)`：事务内 `lockForUpdate` 锁定令牌行后用 `remain_quota = remain_quota + (请求目标 - 快照)` 应用差额并返回已提交的 `TokenQuotaChange`，快照之后落库的并发扣费不再被擦除；`UpdateToken` 记录已提交的 `from`/`to`（复用既有 `Previous value`/`New value`/`Remaining quota` 文案，无新增 i18n 键），状态单独更新不触碰余额；新增 `TestTokenQuotaUpdatePreservesConcurrentDeductions`（SQLite/MySQL/PostgreSQL 矩阵）与控制器并发扣费回归，审计矩阵补 `from/to` 期望，`.github/workflows/ci.yml` 复用既有真实数据库 job 运行新矩阵；参考上游 issue #2748（只借鉴思路）；本地未运行测试（CI-only）。 |
| 2026-10-17 | UP-09：`/mj/image/:id` 访问控制（借鉴 QuantumNous/new-api#6610）——默认要求仪表盘会话或 API 令牌并校验任务归属，为已下发链接提供 HMAC+过期时间的签名短链模式与保留旧行为的管理员开关；`middleware.MjImageAccessControl` 按 `setting.MjImageAccessMode`（`auth`/`signed`/`legacy`，未知值归一化为 `auth`）放行（`router/relay-router.go` 仍注册在 `TokenAuth` 之前，供不带 Authorization 的图片加载），`relay.RelayMidjourneyImage` 对非所有者（管理员除外）与未知任务统一返回 404 `midjourney_task_not_found` 避免枚举；`service.SignMjImageLink`/`VerifyMjImageSignature` 以 HMAC-SHA256（`v1\0taskID\0exp`，30 分钟 TTL，常量时间比较）签名，`service.BuildMjImageForwardURL` 统一生成前向链接并在非 SUCCESS 状态用 `&` 追加 `rand`（`controller/midjourney.go`、`relay/mjproxy_handler.go` 复用）；`model.UpdateOption("MjImageAccessMode", ...)` 归一化并写回 OptionMap；管理端「绘图」设置新增访问方式选择器（七语言文案）；前端 `usage-logs` 图片预览对同源 `/mj/image/` 链接改为经 axios 客户端带凭据取 blob 后以 object URL 展示（失败显示错误态），其余 URL 直连；测试：`router/relay_router_test.go` 新增 `TestMidjourneyImageAccessControl` 与 `TestMjImageAccessModeOptionRoundTrip`，前端新增 `image-dialog.test.tsx`；无新依赖；本地未运行测试（CI-only，本地未运行测试）。 |
| 2026-10-18 | WL-03：订阅退款改为单一事务 + 结算超额转扣钱包（CI-only，本地未运行测试）——`RefundSubscriptionPreConsume` 在同一事务内先锁定 `user_subscriptions` 行（与 `PreConsumeUserSubscription` 同锁序），再用 `status <> 'refunded'` 条件更新原子认领退款记录，改金额与改状态一起提交或回滚，并发/重试只退一次，不再调用会自开事务的 `PostConsumeUserSubscriptionDelta`；新增 `model.SettleUserSubscriptionDelta`：结算 delta 超出订阅剩余额度时订阅只扣到总额上限，套餐 `AllowWalletOverflow` 为真则在同一事务内从钱包扣除超额并写 `wallet_ledger` 消费行（WL-06 前最多扣到 0；未覆盖部分 `common.SysError` 告警 + 消费日志 `other.admin_info.subscription_overflow_uncovered`，HTTP 结算链路另记 `logger.LogWarn`），套餐禁止溢出时按现有规则记录并告警，不再静默少扣；接入 HTTP 结算（`SubscriptionFunding.Settle`/`BillingSession.Settle`/`SettleBilling`）、任务差额结算（`taskAdjustFunding`）与按次计费回退路径，`relayInfo.SubscriptionPostDelta` 只记订阅部分、`wallet_quota_deducted` 记转扣金额；前端费用气泡计入该金额；测试：`model/subscription_settlement_test.go`（退款原子性与幂等、SQLite/MySQL/PostgreSQL 溢出结算矩阵与账本断言）、`service/tiered_settle_test.go`、`service/task_billing_test.go` 新用例，`.github/workflows/ci.yml` 真实数据库 job 过滤清单扩展；本 Step 未新增 quota 浮点换算（沿用既有 `common/quota_math` `*Checked` 饱和路径）；未新增文案键（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；参考上游 #5556、#6911。 |
| 2026-10-18 | UP-09 复核（CI-only，本地未运行测试）：修复首次实现的 CI 失败——`web/src/features/system-settings/content/section-registry.tsx` 未把 `MjImageAccessMode` 传给 `DrawingSettingsSection`，而 `DrawingFormValues` 把它列为必填，导致 `bun run typecheck` 报缺字段、管理端「绘图」选择器无法保存，现补传 `MjImageAccessMode: settings.MjImageAccessMode`；`web/src/features/usage-logs/components/__tests__/image-dialog.test.tsx` 的组件导入由 `'../image-dialog'` 修正为 `'../dialogs/image-dialog'`（与 `export-dialog.test.tsx` 一致），原路径让 vitest 无法解析模块、测试文件直接失败；其余 UP-09 范围（`middleware.MjImageAccessControl` 三模式放行、`relay.RelayMidjourneyImage` 归属校验与统一 404、`setting.MjImageAccessMode` 归一化与 OptionMap 回写、HMAC 签名短链、管理端开关与七语言文案、`usage-logs` 受保护链接的凭据加载）经静态核对已在 main 完整；`i18n:sync` 复跑 missingCount=0、extrasCount=0；无新依赖；本地未运行测试/typecheck/lint/build（CI-only）。 |
| 2026-10-18 | WL-04：wallet_holds 持久化钱包预扣 + 超时回收 + 幂等退款（借鉴 QuantumNous/new-api#7738，只借鉴思路自行实现）——新增主库 `wallet_holds`（`request_id` 唯一、`user_id`、`amount`、`status`[active/settled/refunded/expired]、`parent_id` 可空、`expires_at`、`created_at`/`updated_at`）并在**同一事务**内随钱包预扣写入/扩写 hold：`TryReserveUserQuota(id, quota, requestId)` 同时覆盖 Redis Lua 与条件 UPDATE 两条路径（空 `requestId` 保留旧缓存/批量路径），缓存命中 Lua 后同步落库 hold、落库失败补偿缓存，`ReserveUserQuotaWithDebt` 对应结算式补扣并同步缓存；结算 `SettleWalletHold` 与退款 `RefundWalletHold` 在同一事务内关闭 hold 并按 `request_id` 幂等（退款以持久化 hold 金额为准、账本 `request_refund` 二次防重；`BillingSession.Settle` 差额为 0 时也提交资金来源以关闭 hold，避免回收任务误退已完成请求），`ReverseWalletHoldReserve` 把中途补充预扣的回滚与 hold 收缩合并为同一事务；`service/wallet_hold_recovery.go` 新增 `wallet_hold_recovery` 系统任务（每 10 分钟、每批 200），对超时未关闭的根 hold 在事务内写 `wallet_ledger` 退款并标记 `expired`（失败计数 + `common.SysError` 保留重试），修复进程崩溃/重启只扣不退，并按 7 天保留期以 `CleanupClosedWalletHolds`（按 id 列表删除，三库同一语句，active hold 不清理）批量清理已关闭 hold；父 hold 能力供 BL-03 工作流预算挂载（`CreateWalletBudgetHold` 一次运行一个父 hold 真实预扣，`MountWalletBudgetChild` 只记录步骤分配不再扣费，父 hold 终态级联关闭子 hold）；可用余额仍等于 `quota`（预扣已扣，不做 `quota − Σholds` 真冻结），`expires_at` 默认 1 小时（`WALLET_HOLD_TTL_SECONDS`，最小 60s），金额运算统一 `common.MaxWalletQuota` 边界并在饱和时 `common.SysError` 审计；测试扩展 `model/wallet_ledger_test.go`：`TestWalletHoldReserveExtendsAndSettles`、`TestWalletHoldRefundIsIdempotent`、`TestWalletHoldExpiryRecoveryRefundsCrashedReservations`（含正常退款与回收并发只退一次）与 `TestWalletHoldBudgetParentMountsChildren` 运行 SQLite/MySQL/PostgreSQL 矩阵并断言账本对账无偏差，`TestWalletHoldRedisReserveWritesHold` 覆盖 miniredis 的 Lua 预扣路径；CI 复用既有 `backend-real-db` job（MySQL 8.0 + PostgreSQL 16，`go test ./model/ -run 'TestWallet'`）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only，本地未运行测试）。 |
| 2026-10-18 | UP-08（复核收尾，令牌侧）：`PUT /api/token` 的额度差额原子更新与审计已在 main 落地，本日复核完整范围——`model.Token.Update` 的 Select 移除 `remain_quota`（配置字段提为共用 `tokenConfigFields`），`model.Token.UpdateWithQuotaTarget(snapshot)` 在事务内 `lockForUpdate` 锁定令牌行（`id AND user_id`）后按 `remain_quota = remain_quota + (请求目标 - 快照)` 应用差额并返回已提交的 `TokenQuotaChange`（Before/After），快照之后落库的并发扣费不再被擦除；`status_only` 更新不再触碰余额；`UpdateToken` 把已提交的前后余额写入 `token.update` 审计参数（`from`/`to`，前端复用既有 `Previous value`/`New value`/`Remaining quota` 文案，无新增 i18n 键）。用户侧由 fork 的 `AdjustUserQuota`（锁行 + 差额同步）与 WL-05 账本负责，本 Step 未重复。回归覆盖：`model/quota_reserve_test.go` 的 `TestTokenQuotaUpdatePreservesConcurrentDeductions`（SQLite/MySQL/PostgreSQL 真库矩阵：快照后扣费 30，目标不变/上调/下调分别得 70/170/10，`used_quota` 保留、`change.Before/After` 为已提交值）与 `controller/token_test.go` 的 `TestUpdateTokenQuotaAdjustmentPreservesConcurrentDeductions`（查询回调在快照与写入之间注入扣费，校验响应余额、落库余额、`used_quota`、审计参数与状态 from/to），审计矩阵 `normalized update` 期望补 `from:100,to:200`；`.github/workflows/ci.yml` 的 `database` job（MySQL 8.0 + PostgreSQL 16 service 容器）运行新矩阵测试。本地未运行测试（CI-only）。 |
| 2026-10-18 | ST-01：新增 ObjectStore 抽象与本地磁盘后端（默认）——`service/objectstore` 提供 `Store`（`Put`/`Get`/`Head`/`Delete`/`PresignPut`/`PresignGet`/`Backend`）、`ObjectInfo`、`ValidateKey` 与 `Serve`（调用方校验归属后流式输出，附 `nosniff`/sandbox CSP/转义 `Content-Disposition`/`no-referrer`）；`Local` 后端基于 `os.Root` 做目录隔离与符号链接逃逸拒绝，临时文件 + rename 原子提交，32 KiB 缓冲流式读写，local 不提供预签名（`ErrPresignUnsupported`）；`setting/system_setting/task_artifact_store.go` 新增 `ObjectStoreConfig`/`ValidateObjectStoreConfig`/`LoadObjectStoreConfig` 与 `OBJECT_STORE_BACKEND`（默认 local）、`OBJECT_STORE_LOCAL_DIR`（默认 `data/objectstore`）、`OBJECT_STORE_PREFIX`、`OBJECT_STORE_PRESIGN_TTL`，S3 prefix 校验提取为共享 helper，既有任务结果配置与错误文案不变；测试为 `service/objectstore/local_test.go` 与扩展的 `setting/system_setting/task_artifact_store_test.go`（`TestValidateObjectStoreConfig`、`TestLoadObjectStoreConfigDefaultsAndFallback`）；无新依赖；无前端/i18n 变更；本地未运行测试（CI-only）。 |
| 2026-10-18 | DB-01：消息增量持久化（替代整会话删除重插，CI-only，本地未运行测试）——`model.PlaygroundMessage` 增加 `uk_playground_message_session_client`（`session_id` + `client_key`）唯一索引；新增 `model.ApplyPlaygroundMessagesDelta`：锁定会话行并校验 `MessageRevision` CAS 后只写变化行（已存行保持主键与稀疏 `position`（步长 1024）不变、新增行按请求顺序追加到最大 position 之后、`deletes` 删除被删行且删除不存在的键为幂等空操作、事务末尾按最终快照重算附件引用且只改引用状态真正变化的附件行），`MessageRevision` 仅在快照变化时 +1；新增 `PATCH /api/playground/sessions/:id/messages`（`upserts`/`deletes`/`revision`，`UserAuth` + `access_token_routes` 会话级规则，返回 `{revision, upserted, deleted}`）；旧的全量 `PUT /api/playground/sessions/:id/messages` 保留为**一个版本的兼容垫片**（`controller.ReplacePlaygroundMessages` 标注 Deprecated，内部走同一增量引擎，序列未变时不重排 position），**计划下一个版本移除**；迁移 `model.migratePlaygroundMessageUniqueness` 在 AutoMigrate 前清理旧库重复 `(session_id, client_key)` 行（保留最新一行，索引存在后跳过），三库升级与重复启动幂等；前端改用增量协议（`applyPlaygroundMessagesDelta`、`lib/server-sync.ts` 的 `playgroundSyncedSnapshot`/`playgroundMessageDelta`、`use-playground-server` 按账号维护同步基线，空增量跳过消息写入；`replacePlaygroundMessages` 标注 `@deprecated` 仅供旧客户端）；测试 `TestPlaygroundMessageDeltaWrites`、`TestPlaygroundMessageDeltaConcurrentRevision`、`TestPlaygroundMessageDeltaLimitRollback`、`TestPlaygroundMessageUniquenessMigration`（SQLite/MySQL/PostgreSQL 矩阵，覆盖并发 CAS、跨用户 404、上限回滚、唯一索引与迁移幂等）与前端 `server-sync-delta.test.ts`、扩展 `server-api.test.ts`/`server-sync.test.tsx`；`.github/workflows/ci.yml` real-database job 纳入新矩阵，E2E 等待条件改为增量 PATCH；无新依赖；无新增 i18n 文案。 |
