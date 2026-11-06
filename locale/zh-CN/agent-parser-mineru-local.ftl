# Local MinerU provider

agentparser-provider-mineru-local = 本地 MinerU

agentparser-mineru-local-confirm-library = 将有 { $count } 个 PDF 由本地 MinerU 逐个解析。Apple Silicon 上 standard 档约 1 分钟一篇（advanced 档更久），是否继续？

agentparser-pref-tier = 解析档位：
agentparser-tier-basic =
    .label = basic
agentparser-tier-standard =
    .label = standard（推荐）
agentparser-tier-advanced =
    .label = advanced
agentparser-tier-desc-basic = 只用小模型，不用 VLM。最快、内存占用最小，但公式和复杂版面的质量最低。
agentparser-tier-desc-standard = 小模型做版面分析，MinerU2.5 VLM 识别文本、公式和表格。M4 + MLX 上约 3.5 秒/页，普通论文 1 分钟以内。
agentparser-tier-desc-advanced = 版面也交给 VLM。表格多、版面复杂的文档质量更好，但比 standard 慢约 4 倍（M4 上约 13 秒/页）。
agentparser-pref-ocr-mode = OCR 模式：
agentparser-pref-managed =
    .label = 由 Agent Parser 安装并运行 MinerU（取消勾选可连接自己运行的服务）
agentparser-local-env = 环境：
agentparser-local-models = 模型：
agentparser-local-server = 服务：
agentparser-local-env-ok = MinerU { $version }（{ $engine }），位于 { $dir }
agentparser-local-env-missing = 未安装
agentparser-local-step-starting = 准备中…
agentparser-local-step-venv = 正在创建 Python 环境…（{ $minutes } 分钟）
agentparser-local-step-packages = 正在安装 MinerU 及依赖…（{ $minutes } 分钟）
agentparser-local-step-models = 正在下载模型…（{ $minutes } 分钟）
agentparser-local-unknown = —
agentparser-local-models-ok = { $tier } 档所需模型已就绪
agentparser-local-models-missing = 缺少 { $tier } 档所需模型，请点击「安装」
agentparser-local-server-running = 运行中（PID { $pid }，{ $url }）
agentparser-local-server-starting = 正在启动…
agentparser-local-server-stopped = 未运行（需要时自动启动）
agentparser-local-install =
    .label = 安装
agentparser-local-update =
    .label = 更新 / 修复
agentparser-local-cancel =
    .label = 取消
agentparser-local-start =
    .label = 启动服务
agentparser-local-stop =
    .label = 停止服务
agentparser-local-starting-hint = 正在启动本地 MinerU 服务（加载模型需要一点时间）…
agentparser-local-install-confirm = 将把 MinerU 安装到 { $dir } 并下载模型，共约 { $size } GB，需要一段时间。是否继续？
agentparser-pref-env-dir = 环境目录：
agentparser-pref-uv-path = uv 路径：
agentparser-pref-model-source = 模型来源：
agentparser-pref-port = 端口：
agentparser-pref-idle-stop = 空闲多久后停止服务（分钟，0 为不停止）：
agentparser-pref-external-desc = 自行运行 `mineru-kit api-server`（本机或其他电脑均可），在这里填写地址；若启动时设置了 --api-key，请一并填写。
agentparser-pref-api-key = API Key：

agentparser-mineru-local-setup-install = 需要设置：本地 MinerU 尚未安装
agentparser-mineru-local-setup-installing = 正在安装本地 MinerU，完成后开始解析
