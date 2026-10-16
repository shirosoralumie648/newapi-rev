# Playground 改进记录

> 这是一份持续维护的 Playground 产品与技术改进清单，用来固化历史讨论中的目标、边界、决策和验收标准，避免计划只存在于聊天记录中。

- **最后更新**：2026-10-15
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
- [x] 明确右侧 Inspector/Artifact 面板与全局导航侧栏的边界（Artifact 面板属于 Playground 工作区内部，由聊天头部按钮切换，不占用全局导航侧栏；移动端为右侧 Sheet）；
- [x] 完善桌面、移动、窄屏、暗色模式和嵌套滚动的真实浏览器验收（Playwright E2E：桌面与移动视口、暗色模式跨刷新持久化、会话列表嵌套滚动不带动页面）。

### Phase 2：服务端会话和消息同步 — 进行中

- [x] 建立 Playground session 的后端模型和管理接口基础；
- [x] 建立消息快照/同步接口基础；
- [x] 查询 key 包含用户和 canonical session；
- [x] 账号切换、会话切换和删除时屏蔽迟到请求；
- [x] 完成服务端与本地缓存的一致性策略；
- [x] 明确首次加载、离线编辑、网络失败、冲突和响应丢失的恢复行为；
- [x] 通过 SQLite、MySQL、PostgreSQL 的新库和升级库验证迁移幂等性；
- [x] 增加服务端所有者、跨用户、跨 session 和并发更新测试。

### Phase 3：Artifact 和安全预览 — 进行中

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

### Phase 4：附件和多模态消息 — 待实施

- [ ] 明确允许的文件类型、单文件大小、数量和总容量；
- [ ] 复用 `PromptInput` 的附件入口、拖放和粘贴能力；
- [ ] 建立服务端附件对象和用户/会话归属；
- [ ] 使用受控下载地址或访问接口，不能把任意 URL 当作永久附件；
- [ ] 让消息模型支持文本、图片和受支持的 content parts；
- [ ] 在 payload builder 中正确构造 OpenAI 多模态消息；
- [ ] 对不支持视觉或不支持指定附件的模型返回可理解的错误；
- [ ] 附件上传、读取、删除和过期清理都执行服务端权限校验；
- [ ] 覆盖类型、大小、数量、权限、过期、失败重试和跨账号访问测试。

### Phase 5：Infinite Canvas — 待实施

- [ ] 建立画布项目、节点、边和节点资源模型；
- [ ] 复用项目已有 `@xyflow/react` 和 `Canvas`/`Node`/`Edge` 能力；
- [ ] 支持缩放、平移、选区、小地图和节点详情；
- [ ] 支持撤销/重做；
- [ ] 支持导入/导出和版本化保存；
- [ ] 将聊天消息、Prompt、文件、Artifact、图片和任务结果映射为节点；
- [ ] 建立画布项目和用户的归属关系；
- [ ] 限制项目数量、节点数量和持久化大小；
- [ ] 明确画布数据与聊天 session 的引用关系，避免删除消息导致资源意外丢失。

### Phase 6：多媒体、Agent 和工作流 — 待实施

- [ ] 将图片、视频、音频生成任务映射到 `new-api` 现有 Relay、渠道和 task plugin；
- [ ] 复用现有任务状态、错误、权限和计费链路；
- [ ] 设计 Agent/工具调用状态，但不默认允许任意代码执行；
- [ ] 设计工作流节点、输入输出、失败重试和任务取消；
- [ ] 支持素材库、任务结果和 Artifact/Canvas 的安全关联；
- [ ] 为长任务设置并发、存储和生命周期限制；
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

- [ ] 新用户可以创建、切换、重命名、删除和清空会话；
- [ ] 账号 A 无法读取账号 B 的 session、消息、附件、Artifact 或画布；
- [ ] 切换或删除会话后，旧请求的迟到 chunk 不会写入新会话；
- [x] 浏览器刷新、重新登录和跨设备加载不会产生错误归属（E2E：重命名后刷新以及全新浏览器上下文重新登录都从服务端加载正确会话，且不出现同步错误提示）；
- [ ] 损坏、过大和旧版本数据可以安全迁移或降级。

### 聊天、附件和 Artifact

- [ ] 文本请求行为与现有 Playground 保持兼容；
- [ ] 编辑和重新生成不会丢失历史版本或分支；
- [ ] 附件类型、大小、数量、权限和生命周期均由服务端控制；
- [ ] Markdown 和 Code Artifact 可以创建、编辑、保存版本、恢复、复制、下载和删除；
- [ ] Artifact 不会执行原始 HTML、JavaScript 或代码；
- [ ] 网络失败、冲突和响应丢失时草稿不会被静默覆盖。

### 画布和资源限制

- [ ] 画布支持节点、边、缩放、平移、撤销/重做、导入/导出；
- [ ] 聊天消息、附件和 Artifact 可以安全引用画布节点；
- [ ] 达到用户或用户组配额时，服务端返回稳定、可翻译的错误；
- [ ] 删除、恢复、过期和并发写入不会绕过资源配额；
- [ ] 配额检查不会影响现有 token billing 的结算语义。

### 真实环境验证

- [x] Playground 相关 Vitest 通过（49/49，11 个文件）；
- [x] `bun run typecheck` 通过（本环境使用 `web/node_modules/.bin/tsgo -b`）；
- [x] 修改文件的 lint 和格式检查通过（oxlint + protected-header 格式检查）；
- [x] 前端生产构建通过（`rsbuild build`）；
- [x] 后端相关测试通过（`go test ./model/ -run TestPlayground`）；
- [x] SQLite、MySQL、PostgreSQL 新库和升级库迁移均通过（SQLite 3.50.4 / MySQL 8.0.46 / PostgreSQL 16.15，新库 ×2 + v1.0.0-rc.43 升级库 ×2；MySQL 5.7.44 最低版本验证通过）；
- [x] 真实浏览器覆盖桌面、移动端、暗色模式、键盘操作和失败路径（Playwright + Chromium 7 个用例：桌面/移动工作区、会话 Sheet 键盘操作与 Escape、暗色持久化、失败列表重试恢复、刷新/重登录同步；冷启动与复用实例两种运行方式均通过）；
- [x] 最终 diff 不包含无关生成文件、密钥、直接上游调用或许可证遗漏（`.claude-flow/`、`.swarm/`、`graphify-out/` 已加入 `.gitignore`；新增 Go/TS 文件无密钥、无直连上游调用、许可证头齐全，提交前复查）。

## 7. 当前待办优先级

### P0：继续前必须完成

1. ~~完成服务端 session/message 同步契约和冲突策略；~~ 已完成（同步层含迟到请求屏蔽与冲突恢复测试）；
2. ~~对当前新增的 Playground 后端模型和迁移执行三数据库验证；~~ 已完成（新库 ×2 + rc.43 升级库 ×2，三库全部通过，含 MySQL 5.7 最低版本）；
3. ~~完成 Artifact 的前端失败恢复、冲突和未保存草稿保护；~~ 已完成（失败重试复用 request_id、409 冲突保留草稿并可 reload、`beforeunload` 草稿保护）；
4. ~~清理或明确 `.claude-flow/`、`.swarm/`、`graphify-out/` 等生成目录是否进入提交范围；~~ 已完成（已加入 `.gitignore`）；
5. ~~补齐端到端的账号隔离、迟到请求和删除回退测试。~~ 已完成（`model/playground_test.go` 跨用户/并发/真实 router 鉴权 + 前端同步层测试）。

剩余待办：统一资源配额（P1 的附件与生命周期），Inspector/Canvas 面板边界。

### P1：聊天工作区稳定后实施

1. 附件对象存储和多模态 payload；
2. 独立的用户/用户组资源配额；
3. Artifact 和附件与 session 的统一资源生命周期；
4. 桌面/移动端 Inspector、Artifact 和 Canvas 面板。

### P2：产品能力扩展

1. Infinite Canvas；
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
