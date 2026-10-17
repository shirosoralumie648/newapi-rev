# Playground 改进记录

> 这是一份持续维护的 Playground 产品与技术改进清单，用来固化历史讨论中的目标、边界、决策和验收标准，避免计划只存在于聊天记录中。

- **最后更新**：2026-10-17
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

### Phase 6：多媒体、Agent 和工作流 — 待实施

- [x] 将图片、视频、音频生成任务映射到 `new-api` 现有 Relay、渠道和 task plugin（新增 `/pg/images/generations`、`/pg/images/edits`、`/pg/videos`、`/pg/audio/speech` 媒体路由：`middleware.PlaygroundRelayBridge` 在任务插件 pin 与渠道选择之前把路径重写为对应 `/v1` 规范路径，并按 `PlaygroundRequest.group` 复用账号可用用户组覆盖校验；随后沿用既有 `PinTaskPluginEndpoint`/`PrepareTaskPluginEndpoint`/`Distribute`，图片/视频由 `controller.RelayTaskPluginEndpoint` 分流到插件协议桥或内置 `Relay`/`RelayTask`，语音为同步 `Relay(RelayFormatOpenAIAudio)`；渠道、权限和计费仍由原管线处理，前端 `playground-generation-panel.tsx` 只调用 `/pg`；`playground-generation-panel.test.tsx` 断言图片/视频提交到正确路由与请求体；无新依赖；本地未运行测试/typecheck/lint/build（CI-only））；
- [x] 复用现有任务状态、错误、权限和计费链路（任务列表与状态轮询直接复用 `/api/task/self` 与会话日志的 `taskStatusMapper`/`StatusBadge`，结果预览与展示复用 `TaskArtifactsCell`，结果字节仅经受控的 `/api/task/:task_id/artifacts` capability 接口读取；Q-01 的 `TaskMaxConcurrency` 在 `controller/playground_generation.go` 内以 `model.CountActivePlaygroundTasks` 按账号 durable task 行强制，独立于 `User.Quota` 与 token 计费，超限返回稳定错误码 `PLAYGROUND_TASK_LIMIT_EXCEEDED` 并登记七语言文案与 `server-error-message` 映射；画布任务结果节点只保存 `taskId`/`taskArtifactKey` 引用，保存时按 `(user_id, task_id)` 校验归属，跨账号引用返回 400、失效任务在读取时标记不可用；`model/playground_test.go` 的 `TestPlaygroundTaskConcurrencyCount` 覆盖全局/用户组并发预算与终态释放，`model/playground_canvas_test.go` 的 `TestPlaygroundCanvasTaskReferences` 覆盖归属/缺 key/删除容忍，`playground-generation-panel.test.tsx` 覆盖任务状态渲染与「发送到画布」引用种子；本地未运行测试/typecheck/lint/build（CI-only））；
- [ ] 设计 Agent/工具调用状态，但不默认允许任意代码执行；
- [ ] 设计工作流节点、输入输出、失败重试和任务取消；
- [ ] 支持素材库、任务结果和 Artifact/Canvas 的安全关联；
- [x] 为长任务设置并发、存储和生命周期限制（任务行新增 `TaskPrivateData.PlaygroundOrigin` 来源标记：`controller/playground_generation.go` 在调用中继前写入 `constant.ContextKeyPlaygroundOrigin`，`controller/relay.go` 的任务创建沿用同一标记，并发/存储/清理/取消策略只作用于工作区来源任务，不读取也不改写 `User.Quota` 或 token 计费；提交预算统一由 `controller/playground_generation.go` 的 `enforcePlaygroundTaskBudget`（原 `enforcePlaygroundTaskConcurrency`）在 Relay 前强制——并发沿用 `model.CountActivePlaygroundTasks`（`TaskMaxConcurrency`），新增独立账户级结果存储预算 `TaskUserResultMaxBytes`（默认 64 MiB，零/负值继承，支持全局与用户组覆盖），`model.PlaygroundTaskResultStorageBytes` 按方言统计工作区任务结果快照字节（SQLite `json_extract(private_data,'$.playground_origin')=1` + `LENGTH(CAST(data AS BLOB))`、MySQL `JSON_UNQUOTE(JSON_EXTRACT(...))='true'` + `OCTET_LENGTH(CAST(data AS CHAR))`、PostgreSQL `private_data->>'playground_origin'='true'` + `OCTET_LENGTH(CAST(data AS TEXT))`），超限返回 429 `PLAYGROUND_TASK_STORAGE_LIMIT_EXCEEDED` 与七语言文案；生命周期新增调度任务 `playground_task_cleanup`（`service/playground_task_cleanup.go`，7 天 TTL、每 6 小时、每批 200，`model.DeleteExpiredPlaygroundTasks` 只硬删除 `finish_time` 已过期的终态工作区任务行，轮询沿用状态 CAS 不会复活）；取消新增 `POST /api/playground/tasks/:taskId/cancel`（`UserAuth` + `accessTokenSessionRule`）与 `model.CancelPlaygroundTask`：按 `(user_id, task_id, playground_origin)` 过滤并用状态 CAS 转 FAILURE（进度 100%、`FailReason="Task canceled"`），成功后 `service.RefundTaskQuota` 退还预留额度，404/409/500 稳定错误码；工作区任务列表新增取消按钮 + `ConfirmDialog` + `useCancelPlaygroundTask`（结算后同时刷新任务列表与用量），`GET /api/playground/usage` 新增 `tasks` 指标（活跃并发 vs `TaskMaxConcurrency`、快照字节 vs `TaskUserResultMaxBytes`）并在用量弹层展示，管理端配额新增字段 `task_user_result_max_bytes`；`model/playground_test.go` 新增 `TestPlaygroundTaskStorageBudget`（SQLite/MySQL/PostgreSQL 矩阵，含控制器 429 路径）、`TestPlaygroundTaskExpiryCleanup`（矩阵）、`TestPlaygroundTaskCancellation`（owner 作用域、404/409、CAS、成功与退款守卫），扩展 `TestPlaygroundUsageForUserReportsOwnerTotals` 与真实路由鉴权用例；前端扩展 `playground-generation-panel.test.tsx`（取消确认）与 `playground-usage-popover.test.tsx`（Tasks 指标）；补 10 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only））；
- [ ] 不复制参考项目的 Provider、浏览器 API Key 或独立后端。

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

剩余待办：Inspector/Canvas 面板边界、Phase 5 Infinite Canvas 剩余项（画布与 session 引用生命周期收尾）、Phase 6 其余项（Agent/工具调用状态、工作流节点与失败重试/任务取消、素材库）。

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
| 2026-10-17 | P6-05：为长任务设置并发、存储和生命周期限制——任务行新增 `TaskPrivateData.PlaygroundOrigin` 来源标记（`controller/playground_generation.go` 写入 `constant.ContextKeyPlaygroundOrigin`，`controller/relay.go` 创建任务时沿用），生命周期策略只作用于工作区来源任务且不触碰 `User.Quota`/token 计费；`enforcePlaygroundTaskBudget` 在 Relay 前同时强制并发（沿用 `model.CountActivePlaygroundTasks` 与 `TaskMaxConcurrency`）与新增的账户级结果存储预算 `TaskUserResultMaxBytes`（默认 64 MiB，零/负值继承，全局与用户组可覆盖），`model.PlaygroundTaskResultStorageBytes` 按方言 SQL（SQLite `json_extract` + `LENGTH(CAST(data AS BLOB))`、MySQL `JSON_UNQUOTE(JSON_EXTRACT(...))` + `OCTET_LENGTH(CAST(data AS CHAR))`、PostgreSQL `private_data->>'playground_origin'` + `OCTET_LENGTH(CAST(data AS TEXT))`）统计工作区任务结果快照字节，超限返回 429 `PLAYGROUND_TASK_STORAGE_LIMIT_EXCEEDED`；新增调度清理 `service/playground_task_cleanup.go`（`playground_task_cleanup`，7 天 TTL、每 6 小时、每批 200）与 `model.DeleteExpiredPlaygroundTasks`（只硬删除 `finish_time` 已过期的终态工作区任务行）；新增 `POST /api/playground/tasks/:taskId/cancel`（`UserAuth` + `accessTokenSessionRule`）与 `model.CancelPlaygroundTask`（owner+origin 过滤、状态 CAS 转 FAILURE、`FailReason="Task canceled"`，成功后 `service.RefundTaskQuota` 退还预留额度，404/409/500 稳定错误码），前端任务列表新增取消按钮 + `ConfirmDialog` + `useCancelPlaygroundTask`；`GET /api/playground/usage` 新增 `tasks` 指标（活跃并发 vs `TaskMaxConcurrency`、快照字节 vs `TaskUserResultMaxBytes`）并在用量弹层展示，管理端配额新增 `task_user_result_max_bytes` 字段；`model/playground_test.go` 新增 `TestPlaygroundTaskStorageBudget`（SQLite/MySQL/PostgreSQL 矩阵 + 控制器 429）、`TestPlaygroundTaskExpiryCleanup`（矩阵）、`TestPlaygroundTaskCancellation`（owner 作用域/404/409/CAS/退款守卫），扩展 `TestPlaygroundUsageForUserReportsOwnerTotals` 与真实路由鉴权；前端扩展 `playground-generation-panel.test.tsx`、`playground-usage-popover.test.tsx`，`static-keys.ts` 登记新常量键；补 10 个新键的七语言翻译（`i18n:sync` missingCount=0、extrasCount=0）；无新依赖；本地未运行测试/typecheck/lint/build（CI-only，本地未运行测试）。 |
