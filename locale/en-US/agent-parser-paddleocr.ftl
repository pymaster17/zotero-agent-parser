# PaddleOCR provider

agentparser-provider-paddleocr = PaddleOCR (Baidu)
agentparser-paddleocr-warn-no-token = Enter an access token below, or use another parsing service.
agentparser-paddleocr-warn-no-token-single = Enter an access token below to start parsing.

agentparser-paddleocr-confirm-library = { $count } PDF(s) will be uploaded to Baidu PaddleOCR, which uses the daily page quota. Continue?
agentparser-paddleocr-desc = Get a token on the Access Token page of Baidu AI Studio (aistudio.baidu.com). Each model can parse 20,000 pages a day for free. Uploads are limited to 50 MB, and only the first 1000 pages of a file are parsed.
agentparser-paddleocr-region-notice = Recommended only in mainland China: the service runs in Beijing, and uploads from elsewhere usually crawl along at 10–20 KB/s, so a single paper can take minutes.
agentparser-paddleocr-token = Access token:
agentparser-paddleocr-model = Model:
agentparser-paddleocr-url-hosts = Submit by URL for:
agentparser-paddleocr-url-hosts-desc = PDFs saved from these hosts (comma-separated, including subdomains) are downloaded by Baidu's server instead of being uploaded. The server can usually only download from sites in mainland China -- arXiv and other sites elsewhere fail -- so this is empty by default. If downloading fails, the file is uploaded instead.
agentparser-paddleocr-chart =
    .label = Recognize charts (convert charts into tables)
agentparser-paddleocr-setup-token = Setup needed: no PaddleOCR access token
