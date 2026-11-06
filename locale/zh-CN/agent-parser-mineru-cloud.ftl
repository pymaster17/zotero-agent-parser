# MinerU cloud provider

agentparser-provider-mineru-cloud = MinerU 云端
agentparser-mineru-cloud-warn-no-token = 请在下方填写 API Token，或改用其他解析服务。
agentparser-mineru-cloud-warn-no-token-single = 请在下方填写 API Token 后开始解析。

agentparser-mineru-cloud-confirm-library = 将有 { $count } 个 PDF 提交到云端解析，会消耗解析额度，是否继续？
agentparser-pref-cloud-desc = 在 mineru.net 的 API 管理页面申请 Token。单个文件不超过 200 MB / 200 页。
agentparser-pref-token = API Token：
agentparser-pref-model-version = 模型版本：
agentparser-pref-language = 文档语言：
agentparser-pref-url-hosts = URL 直传域名：
agentparser-pref-url-hosts-desc = 来自这些域名（逗号分隔，含子域名）的 PDF 会把下载地址交给 MinerU 直接下载，不再上传本地文件；地址不可用或文件与本地不一致时自动改为上传。
agentparser-pref-upload-acceleration = 上传加速：
agentparser-upload-acceleration-auto =
    .label = 自动
agentparser-upload-acceleration-always =
    .label = 始终
agentparser-upload-acceleration-off =
    .label = 关闭
agentparser-pref-upload-acceleration-desc = MinerU 的文件存储在上海。在中国大陆以外上传时，可以改走阿里云的传输加速节点，速度通常快很多。「自动」会先测一下直连速度，直连已经够快时就不使用加速；加速上传失败时，会自动改用原地址。
agentparser-pref-force-ocr =
    .label = 强制 OCR
agentparser-pref-formula =
    .label = 识别公式
agentparser-pref-table =
    .label = 识别表格
agentparser-mineru-cloud-setup-token = 需要设置：未填写云端 API Token
