agentparser-name = Agent Parser

agentparser-menu-parse =
    .label = 解析 PDF 为 Agent 可读格式
agentparser-menu-reparse =
    .label = 强制重新解析 PDF
agentparser-menu-reveal =
    .label = 显示解析结果
agentparser-menu-parse-library =
    .label = 解析当前库中所有未解析的 PDF…

agentparser-notify-success = PDF 解析完成
agentparser-notify-failure = PDF 解析失败
agentparser-notify-batch = 批量解析完成
agentparser-notify-batch-result = 成功 { $done } 篇，失败 { $failed } 篇（失败原因见「帮助 → 调试输出日志」或错误控制台）
agentparser-notify-queued = 已加入解析队列：{ $count } 个 PDF
agentparser-alert-not-parsed = 所选条目还没有解析结果。
agentparser-alert-library-done = 当前库中的 PDF 都已解析。
agentparser-pref-mode = 解析方式
agentparser-pref-url = 服务地址：
agentparser-pref-concurrency = 并发任务数：
agentparser-pref-test =
    .label = 测试连接

agentparser-pref-general = 常规
agentparser-pref-auto-parse =
    .label = 添加新条目时自动解析 PDF
agentparser-pref-skip-synced =
    .label = 跳过从同步下载的条目（由添加它的电脑负责解析）
agentparser-pref-include-linked =
    .label = 同时解析链接文件（结果写在 PDF 旁的文件夹中，不经 Zotero 同步）
agentparser-pref-notifications =
    .label = 解析完成或失败时显示通知
agentparser-pref-timeout = 解析超时（分钟，从服务端开始处理时算起）：
agentparser-pref-wait-file = 等待 PDF 下载完成（分钟）：

agentparser-pref-output = 解析产物
agentparser-pref-output-desc = 产物保存在 PDF 所在的附件目录（storage/<附件键>/<文件夹名>/）中，只有 full.md 和 images/ 两项。full.md 开头的 YAML 记录了标题、作者、DOI、Zotero 链接和源 PDF 的哈希。WebDAV 同步会把整个附件目录一起上传；Zotero 自带存储只上传 PDF 本身。
agentparser-pref-dir-name = 产物文件夹名：
agentparser-pref-success-tag = 解析成功后添加标签：
agentparser-pref-mark-sync =
    .label = 解析完成后标记附件待上传，使 WebDAV 把产物同步到其他电脑

agentparser-pref-queue-status = 排队 { $queued } 个，进行中 { $running } 个{ $details }
agentparser-pref-clear-queue =
    .label = 清空队列

## Status UI

agentparser-section-header =
    .label = Agent 解析
agentparser-section-sidenav =
    .tooltiptext = Agent 解析

agentparser-state-done = 已解析
agentparser-state-failed = 解析失败
agentparser-state-running = 正在解析
agentparser-state-queued = 排队中
agentparser-state-setup = 等待设置
agentparser-state-none = 未解析
agentparser-state-none-desc = 新添加的 PDF 会自动解析；已有的 PDF 可以点击「解析」。
agentparser-state-none-desc-paused = 自动解析已关闭。

agentparser-status-setup = 完成设置后开始
agentparser-status-queued = 等待空闲的解析任务
agentparser-status-deferred = 服务繁忙，稍后自动重试
agentparser-status-waiting-file = 等待 PDF 下载完成
agentparser-status-preparing = 准备中
agentparser-status-pending = 在服务端排队
agentparser-status-uploading = 正在上传
agentparser-status-parsing = 正在解析
agentparser-status-saving = 正在保存结果
agentparser-action-open-settings = 打开设置
agentparser-action-retry = 重试
agentparser-action-parse = 解析
agentparser-action-open = 打开 Markdown
agentparser-action-reveal = 在文件夹中显示
agentparser-action-reparse = 重新解析

agentparser-menu-more = 还有 { $count } 项…
agentparser-menu-failures = 解析失败（{ $count }）
agentparser-notify-setup = Agent Parser 需要完成设置
agentparser-notify-setup-hint = 新的 PDF 已加入队列，完成设置后自动开始解析。点击工具栏中的 Agent Parser 图标或打开设置。
agentparser-notify-failure-hint = 可在条目右侧的「Agent 解析」栏中重试。
agentparser-error-no-file = PDF 文件不存在或未能下载完成
agentparser-error-too-many-pages = PDF 共 { $pages } 页，超过服务上限（{ $max } 页）

agentparser-pref-status = 状态
agentparser-pref-status-ok = 设置完成，新添加的 PDF 会自动解析
agentparser-pref-status-paused = 设置完成，但自动解析已关闭
agentparser-pref-failures = 失败 { $count } 个
agentparser-pref-retry-failed =
    .label = 重试失败项
agentparser-pref-clear-failures =
    .label = 清除失败记录
agentparser-pref-columns-hint = 提示：在条目列表的列标题上右键，勾选「Agent Parser」即可显示每个条目的解析状态图标。
agentparser-pref-finish-setup =
    .label = 完成设置

agentparser-state-limit = 超出服务限制
agentparser-error-too-large = PDF 大小为 { $size } MB，超过服务上限（{ $max } MB）
agentparser-light-busy-button =
    .tooltiptext = Agent Parser — 正在解析 { $running } 个，排队 { $queued } 个
agentparser-light-error-button =
    .tooltiptext = Agent Parser — { $failed } 个 PDF 解析失败，点击查看
agentparser-light-ok-button =
    .tooltiptext = Agent Parser — 无解析任务
agentparser-light-ok-paused-button =
    .tooltiptext = Agent Parser — 无解析任务（自动解析已关闭）
agentparser-light-ok = 新添加的 PDF 会自动解析。
agentparser-light-ok-paused = 自动解析已关闭，可在设置中开启。
agentparser-panel-ok = 无解析任务
agentparser-panel-busy = 正在解析
agentparser-panel-error = 解析出现异常
agentparser-panel-open-settings = 打开设置
agentparser-panel-counts = 进行中 { $running } · 排队 { $queued }{ $deferred ->
        [0] {""}
       *[other] （{ $deferred } 个稍后重试）
    }{ $blocked ->
        [0] {""}
       *[other] （{ $blocked } 个等待设置）
    }
agentparser-panel-failure-hint = 点击文件可定位到条目，在右侧「Agent 解析」栏重试。失败记录也可以在设置中清除。

## Parsing services

agentparser-pref-mode-desc = 新条目使用这里选择的服务解析。也可以在条目右键菜单中指定用某个服务重新解析。
agentparser-pref-single-provider-desc = 当前版本只包含一种解析服务。如需在本机用 MinerU 解析，请改装完整版，现有设置会保留。
agentparser-pref-bulk-provider = 大批量请求（整库解析、多选条目）使用：
agentparser-pref-bulk-provider-default =
    .label = 默认解析服务
agentparser-pref-bulk-not-ready = { $provider } 还没有设置好，大批量请求暂时也使用默认解析服务。
agentparser-confirm-library = 将有 { $count } 个 PDF 加入解析队列，是否继续？
agentparser-menu-parse-with =
    .label = 用 { $provider } 重新解析 PDF
agentparser-action-retry-with = 改用 { $provider } 重试
agentparser-action-parse-with = 用 { $provider } 解析
agentparser-limit-desc = 这个服务不接受该文件，重试也会失败。可以改用其他解析服务，或拆分 PDF 后再添加。
agentparser-limit-desc-single = 服务不接受这个文件，重试也会失败。请拆分 PDF 后再添加。
agentparser-notify-limit-hint = 重试也会失败。可在条目的「Agent 解析」栏改用其他解析服务，或拆分 PDF。
agentparser-notify-limit-hint-single = 重试也会失败。请拆分 PDF 后再添加。
agentparser-setup-unavailable = 需要设置：所选的解析服务在当前版本中不可用
agentparser-light-setup-button =
    .tooltiptext = Agent Parser — { $issue }
