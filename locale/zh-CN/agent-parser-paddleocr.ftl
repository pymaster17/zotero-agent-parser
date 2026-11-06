# PaddleOCR provider

agentparser-provider-paddleocr = PaddleOCR（百度）
agentparser-paddleocr-warn-no-token = 请在下方填写访问令牌，或改用其他解析服务。
agentparser-paddleocr-warn-no-token-single = 请在下方填写访问令牌后开始解析。

agentparser-paddleocr-confirm-library = 将有 { $count } 个 PDF 上传到百度 PaddleOCR 解析，会消耗每日页数额度，是否继续？
agentparser-paddleocr-desc = 在飞桨星河社区（aistudio.baidu.com）的「访问令牌」页面获取令牌。每个模型每天可免费解析 20000 页；上传文件不超过 50 MB，每个文件只解析前 1000 页。
agentparser-paddleocr-region-notice = 仅建议中国大陆用户使用：服务器位于北京，从境外上传通常只有每秒十几 KB，一篇论文可能要几分钟。
agentparser-paddleocr-token = 访问令牌：
agentparser-paddleocr-model = 模型：
agentparser-paddleocr-url-hosts = URL 直传域名：
agentparser-paddleocr-url-hosts-desc = 来自这些域名（逗号分隔，含子域名）的 PDF 会把下载地址交给百度服务器直接下载，不再上传本地文件。百度服务器通常只能从中国大陆的网站下载，arXiv 等境外网站会失败，所以默认留空；下载失败时自动改为上传。
agentparser-paddleocr-chart =
    .label = 识别图表（把图表转成表格）
agentparser-paddleocr-setup-token = 需要设置：未填写 PaddleOCR 访问令牌
