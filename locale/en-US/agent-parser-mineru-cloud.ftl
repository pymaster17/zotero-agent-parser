# MinerU cloud provider

agentparser-provider-mineru-cloud = MinerU Cloud
agentparser-mineru-cloud-warn-no-token = Enter an API token below, or use another parsing service.
agentparser-mineru-cloud-warn-no-token-single = Enter an API token below to start parsing.

agentparser-mineru-cloud-confirm-library = { $count } PDF(s) will be sent to the cloud service, which uses parsing quota. Continue?
agentparser-pref-cloud-desc = Create a token on the mineru.net API management page. Files are limited to 200 MB / 200 pages.
agentparser-pref-token = API token:
agentparser-pref-model-version = Model version:
agentparser-pref-language = Document language:
agentparser-pref-url-hosts = Submit by URL for:
agentparser-pref-url-hosts-desc = PDFs saved from these hosts (comma-separated, including subdomains) are submitted to MinerU by URL instead of being uploaded. If the URL doesn't work or serves a different file, the local file is uploaded instead.
agentparser-pref-upload-acceleration = Upload acceleration:
agentparser-upload-acceleration-auto =
    .label = Automatic
agentparser-upload-acceleration-always =
    .label = Always
agentparser-upload-acceleration-off =
    .label = Off
agentparser-pref-upload-acceleration-desc = MinerU stores uploaded files in Shanghai. Outside mainland China, uploading through Alibaba Cloud's transfer acceleration endpoint is usually much faster. Automatic checks the direct connection first and skips acceleration if it's already fast. If an accelerated upload fails, the file is uploaded to the original address instead.
agentparser-pref-force-ocr =
    .label = Force OCR
agentparser-pref-formula =
    .label = Recognize formulas
agentparser-pref-table =
    .label = Recognize tables
agentparser-mineru-cloud-setup-token = Setup needed: no cloud API token
